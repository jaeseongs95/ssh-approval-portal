"""Link the owned administrator Access app through the existing native ENV transaction."""
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess

import cloudflare_connector as cc
from cloudflare_provision import ProvisionFailure, verify_resource

ACTIVE = Path('/var/lib/ssh-mcp/app/approval-bridge')
NODE = '/opt/ssh-approval/node/bin/node'
ORIGINAL = 'environment-before.env'
APPLIED = 'environment-applied.env'
STATES = ['PREPARING', 'ORIGINAL_READY', 'APPLIED_READY', 'APPLY_REQUESTED', 'LINKED', 'RESTORE_REQUESTED', 'RESTORED']


def load_state(journal):
    try:
        state = journal.read_record('environment.json')
    except FileNotFoundError:
        return None
    if (not isinstance(state, dict) or set(state) != {'version', 'host', 'status', 'originalIdentity', 'appliedIdentity'}
            or type(state['version']) is not int or state['version'] != 1
            or state['host'] != socket.gethostname() or state['status'] not in STATES):
        raise ProvisionFailure('INVALID_ENVIRONMENT_RECORD')
    for key in ['originalIdentity', 'appliedIdentity']:
        value = state[key]
        if value is not None and (not isinstance(value, dict) or set(value) != {'device', 'inode', 'mode', 'mtimeNs'}
                or any(type(x) is not int or x < 0 for x in value.values()) or value['mode'] != 0o600):
            raise ProvisionFailure('INVALID_ENVIRONMENT_RECORD')
    if ((state['status'] != 'PREPARING' and state['originalIdentity'] is None)
            or (state['status'] in ['APPLIED_READY', 'APPLY_REQUESTED', 'LINKED', 'RESTORE_REQUESTED']
                and state['appliedIdentity'] is None)):
        raise ProvisionFailure('INVALID_ENVIRONMENT_RECORD')
    return state


def ensure_restored(journal):
    state = load_state(journal)
    if state is not None and state['status'] != 'RESTORED':
        raise ProvisionFailure('RESTORE_ENVIRONMENT_FIRST')


def read_snapshot(journal, state, name, identity_key):
    data, identity = cc.read_file(journal.directory/name, 0o600, 65536)
    if identity != state[identity_key]:
        raise ProvisionFailure('ENVIRONMENT_SNAPSHOT_CHANGED')
    return data


def run_access(values, restore=False, stage=None):
    active = cc.trusted_path(ACTIVE.resolve(strict=True), directory=True)
    cc.binary_file(NODE)
    helper = active/'scripts/configure-admin-access.sh'
    cc.trusted_path(helper)
    info = helper.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o022:
        raise ProvisionFailure('TRUSTED_ENVIRONMENT_HELPER_REQUIRED')
    args = ['/usr/bin/bash', str(helper), '--restore-owned-access' if restore else '--link-owned-access']
    if stage is not None:
        cc.checked([NODE, str(active/'scripts/verify.mjs'), str(active)])
        args = [NODE, str(active/'scripts/admin-access-config.mjs'), str(cc.ENV), str(stage), '--link-owned-access']
    # The helper owns package verification, global lock, maintenance, backup, atomic replacement and recovery.
    try:
        result = subprocess.run(args,
                                input=json.dumps(values).encode('utf-8'), stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'},
                                timeout=180, check=False)
    except (OSError, subprocess.SubprocessError):
        raise ProvisionFailure('ENVIRONMENT_ACTION_UNCERTAIN') from None
    if result.returncode:
        raise ProvisionFailure('ENVIRONMENT_ACTION_FAILED_REVIEW_REQUIRED')


def active_connector(journal):
    state = cc.load_state(journal)
    if state is None or state['status'] != 'ACTIVE':
        raise ProvisionFailure('ACTIVE_OWN_CONNECTOR_REQUIRED')
    data, identity = cc.read_file(cc.UNITS/state['unit'], 0o644)
    token, token_identity = cc.read_file(journal.directory/cc.TOKEN_FILE, 0o600, 16384)
    binary = cc.binary_file(state['binary'])
    tunnel = next((x for x in journal.state['resources'] if x['kind'] == 'tunnel'), None)
    if tunnel is None:
        raise ProvisionFailure('COMPLETED_PROVISIONING_REQUIRED')
    cc.token_binding(token.decode('ascii'), journal.state['config'], tunnel['id'])
    if (identity != state['unitIdentity'] or cc.digest(data) != state['unitSha256']
            or token_identity != state['tokenIdentity'] or cc.digest(binary.read_bytes()) != state['binarySha256']
            or cc.system_value(state['unit'], 'DropInPaths')
            or cc.system_value(state['unit'], 'FragmentPath') != str(cc.UNITS/state['unit'])
            or cc.system_value(state['unit'], 'ActiveState') != 'active'
            or cc.system_value(state['unit'], 'MainPID') in ['', '0']):
        raise ProvisionFailure('ACTIVE_OWN_CONNECTOR_REQUIRED')


def link_environment(api, journal):
    cc.root_required(journal)
    if load_state(journal) is not None:
        raise ProvisionFailure('ENVIRONMENT_LINK_ALREADY_RECORDED')
    if (journal.state['status'] != 'RESOURCES_CREATED_CONNECTION_REQUIRED'
            or journal.state['intent'] is not None or journal.state['uncertain']):
        raise ProvisionFailure('COMPLETED_PROVISIONING_REQUIRED')
    active_connector(journal)
    config = journal.state['config']
    cc.local_ready(config)
    admin = next((x for x in journal.state['resources'] if x['kind'] == 'admin-access'), None)
    if admin is None:
        raise ProvisionFailure('COMPLETED_PROVISIONING_REQUIRED')
    verify_resource(config, api, admin)
    audience = admin['guard'].get('aud')
    org = api.get('/accounts/' + config['accountId'] + '/access/organizations')['result']
    if (not isinstance(org, dict) or not isinstance(org.get('auth_domain'), str)
            or not re.fullmatch(r'[a-z0-9-]+\.cloudflareaccess\.com', org['auth_domain'])
            or not isinstance(audience, str) or not re.fullmatch(r'[a-fA-F0-9]{64}', audience)):
        raise ProvisionFailure('OWNED_ACCESS_CONFIGURATION_REQUIRED')
    values = {'BRIDGE_ACCESS_TEAM_DOMAIN': 'https://' + org['auth_domain'], 'BRIDGE_ACCESS_AUD': audience,
              'BRIDGE_ACCESS_OWNER_EMAILS': ','.join(config['ownerEmails'])}
    original, _ = cc.read_file(cc.ENV, 0o600, 65536)
    state = {'version': 1, 'host': socket.gethostname(), 'status': 'PREPARING',
             'originalIdentity': None, 'appliedIdentity': None}
    journal.write_record('environment.json', state)
    state['originalIdentity'] = cc.create_file(journal.directory/ORIGINAL, original, 0o600)
    state['status'] = 'ORIGINAL_READY'
    journal.write_record('environment.json', state)
    current, _ = cc.read_file(cc.ENV, 0o600, 65536)
    if current != original:
        raise ProvisionFailure('ENVIRONMENT_CHANGED_DURING_SETUP')
    payload = {'expected': original.decode('utf-8'), 'values': values}
    run_access(payload, stage=journal.directory/APPLIED)
    applied, state['appliedIdentity'] = cc.read_file(journal.directory/APPLIED, 0o600, 65536)
    state['status'] = 'APPLIED_READY'
    journal.write_record('environment.json', state)
    state['status'] = 'APPLY_REQUESTED'
    journal.write_record('environment.json', state)
    run_access(payload)
    current, _ = cc.read_file(cc.ENV, 0o600, 65536)
    if current != applied:
        raise ProvisionFailure('ENVIRONMENT_APPLY_NOT_CONFIRMED')
    cc.local_ready(config)
    state['status'] = 'LINKED'
    journal.write_record('environment.json', state)
    return {'status': 'ENVIRONMENT_LINKED', 'environmentLinked': True, 'loginVerified': False}


def restore_environment(journal):
    cc.root_required(journal)
    state = load_state(journal)
    if state is None or state['originalIdentity'] is None:
        raise ProvisionFailure('ENVIRONMENT_RECONCILIATION_REQUIRED')
    if state['status'] in ['APPLY_REQUESTED', 'RESTORE_REQUESTED']:
        # A timed-out/crashed helper may have an unknown outcome; never race a second transaction.
        raise ProvisionFailure('ENVIRONMENT_RECONCILIATION_REQUIRED')
    original = read_snapshot(journal, state, ORIGINAL, 'originalIdentity')
    current, _ = cc.read_file(cc.ENV, 0o600, 65536)
    if state['status'] != 'RESTORED' and current != original:
        if state['status'] != 'LINKED' or state['appliedIdentity'] is None:
            raise ProvisionFailure('ENVIRONMENT_RECONCILIATION_REQUIRED')
        applied = read_snapshot(journal, state, APPLIED, 'appliedIdentity')
        if current != applied:
            raise ProvisionFailure('ENVIRONMENT_CHANGED_AFTER_SETUP')
        state['status'] = 'RESTORE_REQUESTED'
        journal.write_record('environment.json', state)
        run_access({'expected': applied.decode('utf-8'), 'original': original.decode('utf-8')}, restore=True)
        current, _ = cc.read_file(cc.ENV, 0o600, 65536)
    if current != original:
        raise ProvisionFailure('ENVIRONMENT_RESTORE_NOT_CONFIRMED')
    cc.local_ready(journal.state['config'])
    state['status'] = 'RESTORED'
    journal.write_record('environment.json', state)
    return {'status': 'ENVIRONMENT_RESTORED', 'environmentLinked': False, 'loginVerified': False}
