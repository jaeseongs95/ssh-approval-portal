"""Own one new Linux connector; existing services and the bridge ENV are read-only."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import uuid
from urllib.error import HTTPError
from urllib.request import ProxyHandler, build_opener

from cloudflare_setup import ApiFailure, NoRedirect, unique_object
from cloudflare_provision import ProvisionFailure, resource_path, verify_resource, tunnel_clients
from settings_contract import defaults, parse_env, validate_port

ENV = Path('/etc/ssh-mcp-approval-bridge.env')
UNITS = Path('/etc/systemd/system')
SYSTEMCTL = '/usr/bin/systemctl'
TOKEN_FILE = 'connector.token'
STATES = ['PREPARING', 'TOKEN_READY', 'UNIT_READY', 'START_REQUESTED', 'ACTIVE',
          'STOP_REQUESTED', 'STOPPED', 'UNIT_REMOVE_REQUESTED', 'UNIT_REMOVED',
          'TOKEN_REMOVE_REQUESTED', 'REMOVED']


def digest(data):
    return hashlib.sha256(data).hexdigest()


def command(args, capture=False):
    try:
        result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'},
                                timeout=45, check=False)
        if capture and len(result.stdout) > 65536:
            raise ProvisionFailure('COMMAND_OUTPUT_LIMIT')
        return result
    except (OSError, subprocess.SubprocessError):
        raise ProvisionFailure('SERVICE_COMMAND_FAILED') from None


def checked(args):
    if command(args).returncode:
        raise ProvisionFailure('SERVICE_COMMAND_FAILED')


def system_value(unit, property_name):
    result = command([SYSTEMCTL, 'show', unit, '-p', property_name, '--value'], capture=True)
    text = result.stdout.decode('ascii').strip()
    if result.returncode not in [0, 4]:
        raise ProvisionFailure('SERVICE_STATE_UNAVAILABLE')
    return text


def trusted_path(path, directory=False):
    path = Path(path)
    if not path.is_absolute() or not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(path)) or '..' in path.parts:
        raise ProvisionFailure('SAFE_ABSOLUTE_PATH_REQUIRED')
    for parent in [*reversed(path.parents), path] if directory else reversed(path.parents):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ProvisionFailure('ROOT_OWNED_PATH_REQUIRED')
    return path


def read_file(path, mode, limit=1024*1024):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != mode or info.st_size > limit):
            raise ProvisionFailure('UNSAFE_CONNECTOR_FILE')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(limit+1)
        if len(data) > limit:
            raise ProvisionFailure('CONNECTOR_FILE_LIMIT')
        return data, identity(info)
    finally:
        os.close(fd)


def identity(info):
    mode = stat.S_IMODE(info.st_mode)
    return {'device': info.st_dev, 'inode': info.st_ino, 'mode': mode,
            **({'mtimeNs': info.st_mtime_ns} if mode == 0o600 else {})}


def sync_parent(path):
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def create_file(path, data, mode):
    trusted_path(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
        observed = identity(os.fstat(fd))
        sync_parent(path)
        return observed
    finally:
        os.close(fd)


def unit_text(binary, token_path):
    return (f'[Unit]\nDescription=SSH Portal dedicated Cloudflare connector\nAfter=network-online.target\n'
            f'Wants=network-online.target\n\n[Service]\nType=simple\nDynamicUser=yes\n'
            f'LoadCredential=tunnel-token:{token_path}\n'
            f'ExecStart={binary} tunnel --no-autoupdate run --token-file ${{CREDENTIALS_DIRECTORY}}/tunnel-token\n'
            'Restart=on-failure\nRestartSec=5\nUMask=0077\nNoNewPrivileges=true\n'
            'PrivateTmp=true\nProtectHome=true\nProtectSystem=strict\n'
            'StandardOutput=null\nStandardError=null\n\n[Install]\nWantedBy=multi-user.target\n').encode()


def binary_file(path):
    binary = trusted_path(path)
    info = binary.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o022
            or info.st_mode & 0o005 != 0o005 or info.st_size > 128*1024*1024 or not os.access(binary, os.X_OK)
            or any(not (parent.stat().st_mode & 0o001) for parent in binary.parents)
            or binary.parts[1] in ['home', 'root'] or binary.is_relative_to('/run/user')):
        raise ProvisionFailure('TRUSTED_CLOUDFLARED_REQUIRED')
    return binary


def token_binding(token, config, tunnel_id):
    try:
        if not isinstance(token, str) or not 24 <= len(token) <= 16384:
            raise ValueError()
        value = json.loads(base64.b64decode(token, validate=True), object_pairs_hook=unique_object)
        if (not isinstance(value, dict) or set(value) - {'a', 't', 's', 'e'}
                or value.get('a') != config['accountId'] or uuid.UUID(value.get('t')) != uuid.UUID(tunnel_id)
                or value.get('e') not in [None, ''] or not isinstance(value.get('s'), str)
                or not 32 <= len(base64.b64decode(value['s'], validate=True)) <= 4096):
            raise ValueError()
    except (ValueError, TypeError, KeyError, AttributeError, UnicodeError):
        raise ProvisionFailure('TUNNEL_TOKEN_BINDING_FAILED') from None


def local_ready(config):
    data, _ = read_file(ENV, 0o600, 65536)
    values = {**defaults, **parse_env(data.decode('utf-8'))}
    if (validate_port(values['BRIDGE_MCP_PORT']) != config['mcpPort']
            or validate_port(values['BRIDGE_ADMIN_PORT']) != config['adminPort']
            or values.get('BRIDGE_ADMIN_ORIGIN') != 'https://' + config['adminHostname']):
        raise ProvisionFailure('LOCAL_CONFIGURATION_MISMATCH')
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        with opener.open('http://127.0.0.1:' + str(config['mcpPort']) + '/health', timeout=3) as response:
            healthy = json.loads(response.read(4097))
            if response.status != 200 or healthy.get('healthy') is not True:
                raise ValueError()
        try:
            with opener.open('http://127.0.0.1:' + str(config['adminPort']) + '/api/requests', timeout=3):
                raise ValueError()
        except HTTPError as error:
            error.close()
            if error.code != 401:
                raise ValueError()
    except Exception:
        raise ProvisionFailure('LOCAL_HEALTH_OR_AUTH_FAILED') from None


def load_state(journal):
    try:
        state = journal.read_record('connector.json')
    except FileNotFoundError:
        return None
    keys = {'version', 'status', 'host', 'unit', 'binary', 'binarySha256', 'unitSha256',
            'unitIdentity', 'tokenIdentity', 'edgeConnected'}
    config = journal.state['config']
    if (not isinstance(state, dict) or set(state) != keys or type(state['version']) is not int or state['version'] != 1
            or state['status'] not in STATES or state['host'] != socket.gethostname()
            or not isinstance(state['unit'], str)
            or not re.fullmatch('ssh-portal-tunnel-' + re.escape(config['name']) + r'-[a-f0-9]{12}\.service', state['unit'])
            or not isinstance(state['binary'], str) or not re.fullmatch(r'/[A-Za-z0-9_./-]+', state['binary'])
            or not isinstance(state['binarySha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', state['binarySha256'])
            or type(state['edgeConnected']) is not bool
            or state['unitSha256'] != digest(unit_text(state['binary'], journal.directory/TOKEN_FILE))):
        raise ProvisionFailure('INVALID_CONNECTOR_RECORD')
    for name, mode in [('unitIdentity', 0o644), ('tokenIdentity', 0o600)]:
        value = state[name]
        expected_keys = {'device', 'inode', 'mode'} | ({'mtimeNs'} if mode == 0o600 else set())
        if value is not None and (not isinstance(value, dict) or set(value) != expected_keys
                or any(type(x) is not int or x < 0 for x in value.values()) or value['mode'] != mode):
            raise ProvisionFailure('INVALID_CONNECTOR_RECORD')
    return state


def root_required(journal):
    if not sys.platform.startswith('linux') or os.geteuid() != 0:
        raise ProvisionFailure('LINUX_ROOT_REQUIRED')
    trusted_path(journal.directory, directory=True)
    trusted_path(UNITS, directory=True)


def ensure_removed(journal):
    from cloudflare_environment import ensure_restored
    ensure_restored(journal)
    state = load_state(journal)
    if state is not None and (state['status'] != 'REMOVED'
                              or os.path.lexists(UNITS/state['unit']) or os.path.lexists(journal.directory/TOKEN_FILE)):
        raise ProvisionFailure('REMOVE_LOCAL_CONNECTOR_FIRST')


def install_connector(api, journal, binary=None, install_binary=False):
    root_required(journal)
    ensure_removed(journal)
    config = journal.state['config']
    if (journal.state['status'] != 'RESOURCES_CREATED_CONNECTION_REQUIRED'
            or journal.state['intent'] is not None or journal.state['uncertain']):
        raise ProvisionFailure('COMPLETED_PROVISIONING_REQUIRED')
    if install_binary and binary is not None:
        raise ProvisionFailure('CLOUDFLARED_SOURCE_CHOICE_REQUIRED')
    local_ready(config)
    for resource in journal.state['resources']:
        verify_resource(config, api, resource)
    if install_binary:
        from cloudflare_binary import ensure_installed
        binary = ensure_installed()
    binary = binary_file(binary or shutil.which('cloudflared') or '/usr/bin/cloudflared')
    result = command([str(binary), '--version'], capture=True)
    version = re.search(rb'cloudflared version (\d+)\.(\d+)\.(\d+)(?:\s|$)', result.stdout)
    if result.returncode or not version or tuple(map(int, version.groups())) < (2025, 4, 0):
        raise ProvisionFailure('CLOUDFLARED_TOKEN_FILE_VERSION_REQUIRED')
    binary_sha = digest(binary.read_bytes())
    tunnel = next(x for x in journal.state['resources'] if x['kind'] == 'tunnel')
    token = api.get(resource_path(config, tunnel) + '/token')['result']
    token_binding(token, config, tunnel['id'])
    unit = 'ssh-portal-tunnel-' + config['name'] + '-' + secrets.token_hex(6) + '.service'
    unit_path = UNITS/unit
    token_path = journal.directory/TOKEN_FILE
    if os.path.lexists(unit_path) or os.path.lexists(token_path) or system_value(unit, 'LoadState') != 'not-found':
        raise ProvisionFailure('CONNECTOR_PATH_ALREADY_EXISTS')
    state = {'version': 1, 'status': 'PREPARING', 'host': socket.gethostname(), 'unit': unit,
             'binary': str(binary), 'binarySha256': binary_sha, 'unitSha256': digest(unit_text(binary, token_path)),
             'unitIdentity': None, 'tokenIdentity': None, 'edgeConnected': False}
    def record(status):
        state['status'] = status
        journal.write_record('connector.json', state)
    record('PREPARING')
    state['tokenIdentity'] = create_file(token_path, token.encode('ascii'), 0o600)
    record('TOKEN_READY')
    state['unitIdentity'] = create_file(unit_path, unit_text(binary, token_path), 0o644)
    record('UNIT_READY')
    record('START_REQUESTED')
    checked([SYSTEMCTL, 'daemon-reload'])
    if system_value(unit, 'DropInPaths') or system_value(unit, 'FragmentPath') != str(unit_path):
        raise ProvisionFailure('CONNECTOR_UNIT_OVERRIDDEN')
    checked([SYSTEMCTL, 'enable', '--now', unit])
    if system_value(unit, 'ActiveState') != 'active':
        raise ProvisionFailure('CONNECTOR_NOT_ACTIVE')
    record('ACTIVE')
    try:
        current = api.get(resource_path(config, tunnel))['result']
        clients = tunnel_clients(config, api, tunnel)
        state['edgeConnected'] = any(client['conns'] for client in clients) and current.get('status') in ['healthy', 'degraded']
    except (ApiFailure, ProvisionFailure, ValueError, TypeError, KeyError, AttributeError):
        # A local service start does not prove edge connectivity; never restart it to resolve a read error.
        pass
    record('ACTIVE')
    return {'status': 'CONNECTOR_ACTIVE', 'edgeConnected': state['edgeConnected'],
            'environmentLinked': False, 'loginVerified': False}


def remove_connector(journal):
    root_required(journal)
    from cloudflare_environment import ensure_restored
    ensure_restored(journal)
    state = load_state(journal)
    if state is None:
        raise ProvisionFailure('CONNECTOR_RECORD_REQUIRED')
    if state['status'] == 'REMOVED':
        ensure_removed(journal)
        return {'status': 'CONNECTOR_REMOVED', 'environmentChanged': False}
    unit_path, token_path = UNITS/state['unit'], journal.directory/TOKEN_FILE
    unit_exists, token_exists = os.path.lexists(unit_path), os.path.lexists(token_path)
    if unit_exists:
        data, ident = read_file(unit_path, 0o644)
        if state['unitIdentity'] != ident or digest(data) != state['unitSha256']:
            raise ProvisionFailure('CONNECTOR_UNIT_CHANGED')
        binary = binary_file(state['binary'])
        if digest(binary.read_bytes()) != state['binarySha256']:
            raise ProvisionFailure('CONNECTOR_BINARY_CHANGED')
        fragment = system_value(state['unit'], 'FragmentPath')
        if (system_value(state['unit'], 'DropInPaths') or fragment != str(unit_path)
                and not (fragment == '' and system_value(state['unit'], 'LoadState') == 'not-found')):
            raise ProvisionFailure('CONNECTOR_UNIT_OVERRIDDEN')
    elif state['unitIdentity'] is not None and state['status'] not in ['UNIT_REMOVE_REQUESTED', 'UNIT_REMOVED', 'TOKEN_REMOVE_REQUESTED']:
        raise ProvisionFailure('CONNECTOR_UNIT_MISSING')
    if token_exists:
        token, ident = read_file(token_path, 0o600, 16384)
        if state['tokenIdentity'] != ident:
            raise ProvisionFailure('CONNECTOR_TOKEN_CHANGED')
        tunnel = next(x for x in journal.state['resources'] if x['kind'] == 'tunnel')
        token_binding(token.decode('ascii'), journal.state['config'], tunnel['id'])
    elif state['tokenIdentity'] is not None and state['status'] != 'TOKEN_REMOVE_REQUESTED':
        raise ProvisionFailure('CONNECTOR_TOKEN_MISSING')
    def record(status):
        state['status'] = status
        journal.write_record('connector.json', state)
    if unit_exists:
        record('STOP_REQUESTED')
        checked([SYSTEMCTL, 'stop', state['unit']])
        if system_value(state['unit'], 'MainPID') != '0' or system_value(state['unit'], 'ActiveState') not in ['inactive', 'failed']:
            raise ProvisionFailure('CONNECTOR_STILL_RUNNING')
        record('STOPPED')
        checked([SYSTEMCTL, 'disable', state['unit']])
        record('UNIT_REMOVE_REQUESTED')
        current, ident = read_file(unit_path, 0o644)
        if ident != state['unitIdentity'] or digest(current) != state['unitSha256']:
            raise ProvisionFailure('CONNECTOR_UNIT_CHANGED')
        unit_path.unlink()
        sync_parent(unit_path)
        record('UNIT_REMOVED')
        checked([SYSTEMCTL, 'daemon-reload'])
    elif state['unitIdentity'] is not None:
        # A crash/failure after our unlink still needs a successful manager reload.
        checked([SYSTEMCTL, 'daemon-reload'])
    if token_exists:
        record('TOKEN_REMOVE_REQUESTED')
        current, ident = read_file(token_path, 0o600, 16384)
        if ident != state['tokenIdentity'] or current != token:
            raise ProvisionFailure('CONNECTOR_TOKEN_CHANGED')
        token_path.unlink()
        sync_parent(token_path)
    record('REMOVED')
    return {'status': 'CONNECTOR_REMOVED', 'environmentChanged': False}
