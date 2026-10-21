"""One guarded post-connection capability sync; subsequent calls only inspect state."""
import copy
import json
import os

import cloudflare_connector as cc
import cloudflare_environment as ce
from cloudflare_provision import ProvisionFailure, public_snapshot, resource_path, tunnel_clients, verify_resource, verify_portal_access_inventory, write_step
from cloudflare_setup import unique_object

CLAIM = 'discovery-sync-claim.json'
RESULT = 'discovery-sync-result.json'
STATUSES = ['waiting', 'ready', 'stale', 'error']


def verify_live_resources(api, journal):
    config = journal.state['config']
    verify_portal_access_inventory(config, api, journal.state['resources'])
    for resource in journal.state['resources']:
        if resource['kind'] != 'tunnel':
            verify_resource(config, api, resource)
            continue
        path = resource_path(config, resource)
        actual, guard = public_snapshot('tunnel', api.get(path)['result']), copy.deepcopy(resource['guard'])
        actual.pop('connections', None)
        guard.pop('connections', None)
        if actual != guard:
            raise ProvisionFailure('RESOURCE_CHANGED_REVIEW_REQUIRED')
        if not any(client['conns'] for client in tunnel_clients(config, api, resource)):
            raise ProvisionFailure('CONNECTED_OWN_TUNNEL_REQUIRED')
        if resource['tunnelConfig'] is not None and public_snapshot('tunnel-config',
                api.get(path+'/configurations')['result']) != resource['tunnelConfig']:
            raise ProvisionFailure('TUNNEL_CONFIG_CHANGED')


def read_record(journal, name, server_id):
    raw, _ = cc.read_file(journal.directory/name, 0o600, 8192)
    value = json.loads(raw, object_pairs_hook=unique_object)
    expected = {'version', 'serverId', 'operation'} | ({'responseStatus'} if name == RESULT else set())
    if (not isinstance(value, dict) or set(value) != expected or type(value['version']) is not int or value['version'] != 1
            or value['serverId'] != server_id or value['operation'] != 'POST /sync'
            or name == RESULT and value['responseStatus'] not in STATUSES):
        raise ProvisionFailure('INVALID_DISCOVERY_SYNC_RECORD')
    return value


def report(api, journal, server, requested):
    current = api.get(resource_path(journal.state['config'], server))['result']
    if public_snapshot('mcp-server', current) != server['guard']:
        raise ProvisionFailure('RESOURCE_CHANGED_REVIEW_REQUIRED')
    tools, status = current.get('tools'), current.get('status')
    if status not in STATUSES or not isinstance(tools, list) or not all(isinstance(item, dict) for item in tools):
        raise ProvisionFailure('INVALID_DISCOVERY_STATUS')
    return {'status': 'SERVER_SYNCED' if status == 'ready' and tools else 'SERVER_SYNC_PENDING',
            'mcpStatus': status, 'toolCount': len(tools), 'syncRequested': requested,
            'loginVerified': False, 'environmentChanged': False, 'configurationChanged': False}


def sync_server(api, journal):
    cc.root_required(journal)
    state = journal.state
    if state['status'] != 'RESOURCES_CREATED_CONNECTION_REQUIRED' or state['intent'] is not None or state['uncertain']:
        raise ProvisionFailure('COMPLETED_PROVISIONING_REQUIRED')
    ce.active_connector(journal)
    environment = ce.load_state(journal)
    if environment is not None:
        if environment['status'] not in ['LINKED', 'RESTORED']:
            raise ProvisionFailure('ENVIRONMENT_REVIEW_REQUIRED')
        name, identity = (ce.APPLIED, 'appliedIdentity') if environment['status'] == 'LINKED' else (ce.ORIGINAL, 'originalIdentity')
        if cc.read_file(cc.ENV, 0o600, 65536)[0] != ce.read_snapshot(journal, environment, name, identity):
            raise ProvisionFailure('ENVIRONMENT_CHANGED_REVIEW_REQUIRED')
    cc.local_ready(state['config'])
    verify_live_resources(api, journal)
    servers = [resource for resource in state['resources'] if resource['kind'] == 'mcp-server']
    if len(servers) != 1:
        raise ProvisionFailure('OWN_MCP_SERVER_REQUIRED')
    server = servers[0]
    if os.path.lexists(journal.directory/CLAIM):
        read_record(journal, CLAIM, server['id'])
        try:
            read_record(journal, RESULT, server['id'])
        except FileNotFoundError:
            raise ProvisionFailure('DISCOVERY_SYNC_OUTCOME_REVIEW_REQUIRED') from None
        return report(api, journal, server, False)
    if os.path.lexists(journal.directory/RESULT):
        raise ProvisionFailure('INVALID_DISCOVERY_SYNC_RECORD')
    record = {'version': 1, 'serverId': server['id'], 'operation': 'POST /sync'}
    cc.create_file(journal.directory/CLAIM, json.dumps(record).encode(), 0o600)
    result = write_step(api, journal, 'mcp-server', 'POST', resource_path(state['config'], server)+'/sync')
    if not isinstance(result, dict) or result.get('status') not in STATUSES:
        raise ProvisionFailure('DISCOVERY_SYNC_OUTCOME_REVIEW_REQUIRED')
    outcome = report(api, journal, server, True)
    state['intent'] = None
    journal.save()
    cc.create_file(journal.directory/RESULT, json.dumps({**record, 'responseStatus': result['status']}).encode(), 0o600)
    return outcome
