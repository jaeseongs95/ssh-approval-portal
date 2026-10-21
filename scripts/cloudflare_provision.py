"""Explicit new-resource creation and cleanup; connector and login are separate steps."""
import copy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys

from cloudflare_setup import ApiFailure, access_public_patterns, connection_plan, preflight, unique_object, validate


class ProvisionFailure(Exception):
    pass


class Journal:
    """Linux operator-owned state: atomic snapshots and a lock held across remote writes."""
    def __init__(self, directory, config=None):
        if not sys.platform.startswith('linux'):
            raise ProvisionFailure('LINUX_STATE_REQUIRED')
        import fcntl
        self.fd = self.lock = None
        path = Path(directory)
        if config is not None:
            # Persist the run directory's own name before any intent can authorize a remote write.
            parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.mkdir(path.name, mode=0o700, dir_fd=parent)
                self.fd = os.open(path.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                os.fsync(parent)
            except BaseException:
                self.close()
                raise
            finally:
                os.close(parent)
        else:
            self.fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            self._private(os.fstat(self.fd), 0o700, directory=True)
            self.directory = Path(os.readlink('/proc/self/fd/' + str(self.fd)))
            self.lock = os.open('lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
            self._private(os.fstat(self.lock), 0o600)
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if config is not None:
                self.state = {'version': 2, 'config': copy.deepcopy(validate(config)), 'status': 'NEW',
                              'resources': [], 'intent': None, 'uncertain': False, 'portalDeleted': False}
                self.save()
            else:
                self.state = self.read_record('state.json')
                self._validate_state()
        except BaseException:
            self.close()
            raise

    @staticmethod
    def _private(info, mode, directory=False):
        correct_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
        if (not correct_type or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != mode
                or (not directory and info.st_nlink != 1)):
            raise ProvisionFailure('PRIVATE_STATE_REQUIRED')

    def _validate_state(self):
        s = self.state
        if (not isinstance(s, dict) or set(s) != {'version', 'config', 'status', 'resources', 'intent', 'uncertain', 'portalDeleted'}
                or type(s['version']) is not int or s['version'] != 2
                or type(s['uncertain']) is not bool or type(s['portalDeleted']) is not bool
                or not isinstance(s['resources'], list) or len(s['resources']) > 12
                or s['status'] not in ['NEW', 'CREATING', 'RESOURCES_CREATED_CONNECTION_REQUIRED', 'FAILED', 'CLEANING', 'CLEANED']):
            raise ProvisionFailure('INVALID_STATE')
        validate(s['config'])
        identities = set()
        for resource in s['resources']:
            if not isinstance(resource, dict) or set(resource) != {'kind', 'id', 'expected', 'guard', 'tunnelConfig'}:
                raise ProvisionFailure('INVALID_RESOURCE_STATE')
            identity = resource_path(s['config'], resource)
            if (identity in identities or not isinstance(resource['expected'], dict) or not resource['expected']
                    or not isinstance(resource['guard'], dict) or resource['guard'].get('id') != resource['id']
                    or not matches(resource['guard'], resource['expected'])
                    or public_snapshot(resource['kind'], resource['guard']) != resource['guard']):
                raise ProvisionFailure('INVALID_RESOURCE_STATE')
            validate_record(s['config'], s['resources'], resource)
            identities.add(identity)
        if s['portalDeleted'] and any(x['kind'] == 'mcp-portal' for x in s['resources']):
            raise ProvisionFailure('INVALID_DELETE_HISTORY')
        if s['intent'] is not None:
            if not isinstance(s['intent'], dict) or set(s['intent']) != {'kind', 'method'}:
                raise ProvisionFailure('INVALID_INTENT')
            # Any crash with an outstanding write needs reconciliation; never replay it.
            s['uncertain'] = True

    def save(self):
        self.write_record('state.json', self.state)

    def read_record(self, name):
        if name not in ['state.json', 'connector.json', 'environment.json']:
            raise ProvisionFailure('INVALID_RECORD_NAME')
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        try:
            self._private(os.fstat(fd), 0o600)
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                raw = stream.read(1024 * 1024 + 1)
        finally:
            os.close(fd)
        if len(raw) > 1024 * 1024:
            raise ProvisionFailure('STATE_TOO_LARGE')
        return json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object)

    def write_record(self, record_name, value):
        if record_name not in ['state.json', 'connector.json', 'environment.json']:
            raise ProvisionFailure('INVALID_RECORD_NAME')
        name = secrets.token_hex(16) + '.tmp'
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8', newline='\n', closefd=False) as stream:
                json.dump(value, stream, ensure_ascii=False, allow_nan=False)
                stream.write('\n')
                stream.flush()
                os.fsync(fd)
            os.replace(name, record_name, src_dir_fd=self.fd, dst_dir_fd=self.fd)
            os.fsync(self.fd)
        finally:
            os.close(fd)

    def close(self):
        if self.lock is not None:
            os.close(self.lock)
            self.lock = None
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def resource_path(config, resource):
    account = '/accounts/' + config['accountId']
    kind, identifier = resource['kind'], resource['id']
    if (not isinstance(kind, str) or not isinstance(identifier, str)
            or not re.fullmatch(r'[a-zA-Z0-9-]{1,64}', identifier)):
        raise ProvisionFailure('INVALID_RESOURCE_ID')
    bases = {'tunnel': account + '/cfd_tunnel', 'dns': '/zones/' + config['zoneId'] + '/dns_records',
             'admin-access': account + '/access/apps', 'server-access': account + '/access/apps',
             'portal-access': account + '/access/apps',
             'mcp-server': account + '/access/ai-controls/mcp/servers',
             'mcp-portal': account + '/access/ai-controls/mcp/portals'}
    if kind not in bases or (kind.startswith('mcp-') and identifier != config['name']):
        raise ProvisionFailure('INVALID_RESOURCE_KIND')
    return bases[kind] + '/' + identifier


def matches(actual, expected):
    """Compare requested fields; Cloudflare adds IDs/timestamps and expanded server data."""
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(k in actual and matches(actual[k], v) for k, v in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) and all(matches(a, e) for a, e in zip(actual, expected))
    return type(actual) is type(expected) and actual == expected


def public_snapshot(kind, value, private_values=()):
    """Keep every readable configuration field, including unknown ones; discard only known metadata."""
    if not isinstance(value, dict):
        raise ProvisionFailure('INVALID_RESOURCE_SNAPSHOT')
    metadata = {'created_at', 'created_on', 'updated_at', 'modified_at', 'modified_on'}
    if kind == 'mcp-server':
        # A server revision can also signal a write-only bearer credential update.
        metadata.discard('modified_at')
    if kind in ['mcp-server', 'mcp-portal']:
        metadata |= {'status', 'error', 'error_details', 'authentication_status', 'last_synced',
                     'last_successful_sync', 'registered_at', 'modified_by', 'tools', 'prompts'}
    if kind == 'tunnel':
        # POST may return these documented credentials; never persist or hash them.
        credentials = value.get('credentials_file')
        if credentials is None:
            credentials = {}
        token = value.get('token')
        if (not isinstance(credentials, dict) or set(credentials) - {'AccountTag', 'TunnelID', 'TunnelName', 'TunnelSecret'}
                or token is not None and not isinstance(token, str)
                or credentials.get('TunnelSecret') is not None and not isinstance(credentials['TunnelSecret'], str)):
            raise ProvisionFailure('INVALID_TUNNEL_CREDENTIAL_RESPONSE')
        if (credentials.get('TunnelID', value.get('id')) != value.get('id')
                or credentials.get('AccountTag', value.get('account_tag')) != value.get('account_tag')):
            raise ProvisionFailure('TUNNEL_CREDENTIAL_IDENTITY_MISMATCH')
        private_values = (*private_values, token, credentials.get('TunnelSecret'))
        metadata |= {'status', 'conns_active_at', 'conns_inactive_at', 'token', 'credentials_file', 'remote_config'}
    result = {k: copy.deepcopy(v) for k, v in value.items() if k not in metadata}
    if kind == 'tunnel':
        source, remote = value.get('config_src'), value.get('remote_config')
        if source is not None and source not in ['cloudflare', 'local']:
            raise ProvisionFailure('INVALID_TUNNEL_CONFIG_SOURCE')
        if remote is not None:
            if type(remote) is not bool or source is not None and source != ('cloudflare' if remote else 'local'):
                raise ProvisionFailure('CONFLICTING_TUNNEL_CONFIG_SOURCE')
            source = 'cloudflare' if remote else 'local'
        if source is None:
            raise ProvisionFailure('MISSING_TUNNEL_CONFIG_SOURCE')
        result['config_src'] = source
    if kind in ['admin-access', 'server-access', 'portal-access'] and isinstance(result.get('policies'), list):
        result['policies'] = [{k: copy.deepcopy(v) for k, v in policy.items()
                               if k not in {'created_at', 'updated_at', 'modified_at'}}
                              if isinstance(policy, dict) else policy for policy in result['policies']]
    if kind == 'mcp-portal' and isinstance(result.get('servers'), list):
        result['servers'] = [public_snapshot('mcp-server', x, private_values) for x in result['servers']]
    forbidden = {'authcredentials', 'clientsecret', 'apikey', 'privatekey', 'password', 'accesstoken',
                 'refreshtoken', 'tunneltoken', 'tunnelsecret', 'token'}
    def check(item):
        if isinstance(item, dict):
            for key, child in item.items():
                if re.sub('[^a-z]', '', key.lower()) in forbidden and child not in [None, '']:
                    raise ProvisionFailure('PRIVATE_RESPONSE_FIELD')
                check(child)
        elif isinstance(item, list):
            for child in item:
                check(child)
        elif isinstance(item, str) and any(secret and secret in item for secret in private_values):
            raise ProvisionFailure('PRIVATE_RESPONSE_VALUE')
    check(result)
    return result


def validate_record(config, resources, resource):
    """Reject incomplete or mismatched private records; these files are trusted, not imported receipts."""
    templates = connection_plan(config)['plannedResources']
    kind, expected = resource['kind'], resource['expected']
    if kind == 'portal-access':
        base = {'type': 'mcp_portal', 'domain': config['portalHostname'], 'policies': []}
        changes = next(x['changes'] for x in templates if x['kind'] == 'portal-access-oauth')
        valid = expected in [base, {**base, **changes}]
    elif kind == 'dns':
        tunnel = next((x['id'] for x in resources if x['kind'] == 'tunnel'), None)
        choices = [copy.deepcopy(x['body']) for x in templates if x['kind'] in ['dns', 'portal-dns']]
        for choice in choices:
            choice['content'] = choice['content'].replace('{new-tunnel-id}', tunnel or '')
        valid = expected in choices
    else:
        template = next((x['body'] for x in templates if x['kind'] == kind), None)
        valid = expected == template
    if not valid:
        raise ProvisionFailure('RESOURCE_PLAN_MISMATCH')
    if resource['tunnelConfig'] is not None:
        body = next(x['body'] for x in templates if x['kind'] == 'tunnel-config')
        if kind != 'tunnel' or not matches(resource['tunnelConfig'], body):
            raise ProvisionFailure('INVALID_TUNNEL_CONFIG')


def result_identity(result, kind, expected, private_values=()):
    guard = public_snapshot(kind, result, private_values)
    if not matches(guard, expected):
        raise ProvisionFailure('CREATED_RESOURCE_MISMATCH')
    resource = {'kind': kind, 'id': result.get('id'), 'expected': expected,
                'guard': guard, 'tunnelConfig': None}
    return resource


def write_step(api, journal, kind, method, path, body=None):
    journal.state['intent'] = {'kind': kind, 'method': method}
    journal.save()
    try:
        return api.change(method, path, body)['result']
    except ApiFailure as error:
        journal.state['uncertain'] = error.uncertain
        if not error.uncertain:
            journal.state['intent'] = None
        journal.state['status'] = 'FAILED'
        journal.save()
        raise ProvisionFailure('REMOTE_WRITE_FAILED') from None


def portal_app(config, api, baseline_ids, private_values=()):
    apps = '/accounts/' + config['accountId'] + '/access/apps'
    candidates = [x for x in api.listing(apps) if any(
        pattern.fullmatch(config['portalHostname']) for pattern in access_public_patterns(x))]
    if not candidates:
        return None
    if len(candidates) != 1:
        raise ProvisionFailure('NEW_PORTAL_APP_NOT_UNIQUE')
    if (candidates[0].get('id') in baseline_ids or candidates[0].get('type') != 'mcp_portal'
            or candidates[0].get('domain') != config['portalHostname']):
        raise ProvisionFailure('NEW_PORTAL_APP_NOT_UNIQUE')
    resource = {'kind': 'portal-access', 'id': candidates[0].get('id'),
                'expected': {'type': 'mcp_portal', 'domain': config['portalHostname'], 'policies': []},
                'guard': None, 'tunnelConfig': None}
    current = api.get(resource_path(config, resource))['result']
    if not matches(current, resource['expected']):
        raise ProvisionFailure('NEW_PORTAL_APP_CHANGED')
    resource['guard'] = public_snapshot('portal-access', current, private_values)
    return resource


def provision(config, api, journal, mcp_token):
    c = validate(config)
    private_values = [mcp_token, getattr(api, '_token', None)]
    if (journal.state['status'] != 'NEW' or journal.state['config'] != c
            or not isinstance(mcp_token, str) or not 24 <= len(mcp_token) <= 4096
            or not re.fullmatch(r'[A-Za-z0-9._~+/-]+=*', mcp_token)):
        raise ProvisionFailure('FRESH_RUN_AND_MCP_TOKEN_REQUIRED')
    if preflight(c, api)['status'] != 'READY_FOR_PROVISIONING':
        raise ProvisionFailure('RESOURCE_CONFLICT')
    account_apps = '/accounts/' + c['accountId'] + '/access/apps'
    baseline_ids = {x.get('id') for x in api.listing(account_apps)}
    if any(not isinstance(x, str) or not re.fullmatch(r'[a-fA-F0-9-]{32,36}', x) for x in baseline_ids):
        raise ProvisionFailure('INVALID_ACCESS_INVENTORY')
    journal.state['status'] = 'CREATING'
    journal.save()
    tunnel_id = None
    for step in connection_plan(c)['plannedResources']:
        kind = step['kind']
        path = step['path'].replace('{new-tunnel-id}', tunnel_id or '')
        if kind == 'portal-access':
            resource = portal_app(c, api, baseline_ids, private_values)
            if resource is None:
                body = copy.deepcopy(step['body'])
                result = write_step(api, journal, kind, 'POST', path, body)
                resource = result_identity(result, kind, body, private_values)
                resource_path(c, resource)
            # Keep the portal after its app so reverse cleanup deletes the portal first.
            journal.state['resources'].insert(-1, resource)
        elif kind == 'portal-access-oauth':
            app_resource = next(x for x in journal.state['resources'] if x['kind'] == 'portal-access')
            path = resource_path(c, app_resource)
            current = api.get(path)['result']
            if public_snapshot('portal-access', current, private_values) != app_resource['guard']:
                raise ProvisionFailure('NEW_PORTAL_APP_CHANGED')
            body = {**copy.deepcopy(current), **copy.deepcopy(step['changes'])}
            result = write_step(api, journal, kind, 'PUT', path, body)
            app_resource['expected'].update(copy.deepcopy(step['changes']))
            if not matches(result, app_resource['expected']):
                raise ProvisionFailure('PORTAL_UPDATE_MISMATCH')
            app_resource['guard'] = public_snapshot('portal-access', result, private_values)
        else:
            body = copy.deepcopy(step['body'])
            if kind == 'dns':
                body['content'] = body['content'].replace('{new-tunnel-id}', tunnel_id or '')
            if kind == 'mcp-server':
                body['auth_credentials'] = mcp_token
            if kind == 'server-access' and any(
                    any(d.get('type') == 'via_mcp_server_portal' and d.get('mcp_server_id') == c['name']
                        for d in (x.get('destinations') or [])) for x in api.listing(account_apps)):
                raise ProvisionFailure('SERVER_ACCESS_ALREADY_EXISTS')
            result = write_step(api, journal, kind, step['method'], path, body)
            if kind == 'tunnel-config':
                tunnel = next(x for x in journal.state['resources'] if x['kind'] == 'tunnel')
                if not matches(result, body):
                    raise ProvisionFailure('TUNNEL_UPDATE_MISMATCH')
                tunnel['tunnelConfig'] = public_snapshot('tunnel-config', result, private_values)
            else:
                expected = {k: v for k, v in body.items() if k != 'auth_credentials'}
                resource = result_identity(result, 'dns' if kind == 'portal-dns' else kind, expected, private_values)
                resource_path(c, resource)
                journal.state['resources'].append(resource)
                if kind == 'tunnel':
                    tunnel_id = resource['id']
        journal.state['intent'] = None
        journal.save()
    journal.state['status'] = 'RESOURCES_CREATED_CONNECTION_REQUIRED'
    journal.save()
    return {'status': journal.state['status'], 'loginVerified': False, 'connectorInstalled': False}


def tunnel_clients(config, api, resource):
    """Only complete dedicated connection responses establish use or absence.

    The documented endpoint may return an unpaginated result without result_info.
    When metadata is present, require complete consistent pages. Tunnel GET's
    deprecated embedded connections is deliberately not consulted.
    """
    if resource['kind'] != 'tunnel':
        raise ProvisionFailure('TUNNEL_RESOURCE_REQUIRED')
    path = resource_path(config, resource) + '/connections'
    clients, seen, expected = [], set(), None
    for page in range(1, 1001):
        data = api.get(path, None if page == 1 else {'page': page, 'per_page': expected[0]})
        if not isinstance(data, dict):
            raise ProvisionFailure('TUNNEL_CONNECTIONS_INCOMPLETE')
        rows, info = data.get('result'), data.get('result_info')
        unpaginated = page == 1 and 'result_info' not in data
        if (not isinstance(rows, list) or len(rows) > 100000 or not unpaginated and (not isinstance(info, dict)
                or any(type(info.get(k)) is not int for k in ['page', 'per_page', 'total_count'])
                or ('count' in info and (type(info['count']) is not int or info['count'] != len(rows)))
                or info['page'] != page or not 1 <= info['per_page'] <= 1000
                or not 0 <= info['total_count'] <= 100000 or len(rows) > info['per_page'])):
            raise ProvisionFailure('TUNNEL_CONNECTIONS_INCOMPLETE')
        identity = None if unpaginated else (info['per_page'], info['total_count'])
        if expected is not None and identity != expected:
            raise ProvisionFailure('TUNNEL_CONNECTIONS_CHANGED_DURING_READ')
        expected = identity
        for client in rows:
            if (not isinstance(client, dict) or not isinstance(client.get('id'), str)
                    or not re.fullmatch(r'[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}', client['id']) or client['id'] in seen
                    or not isinstance(client.get('conns'), list)
                    or any(not isinstance(conn, dict) or not isinstance(conn.get('id'), str)
                           or not re.fullmatch(r'[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}', conn['id']) for conn in client['conns'])):
                raise ProvisionFailure('INVALID_TUNNEL_CONNECTIONS')
            seen.add(client['id'])
            clients.append(client)
        if unpaginated:
            return clients
        if len(clients) > info['total_count']:
            raise ProvisionFailure('TUNNEL_CONNECTIONS_INCOMPLETE')
        if len(clients) == info['total_count']:
            return clients
        if not rows:
            raise ProvisionFailure('TUNNEL_CONNECTIONS_INCOMPLETE')
    raise ProvisionFailure('TUNNEL_CONNECTIONS_PAGE_LIMIT')


def verify_resource(config, api, resource, allow_missing=False):
    path = resource_path(config, resource)
    try:
        current = api.get(path)['result']
    except ApiFailure as error:
        # Only a derived app may disappear through the portal's delete cascade.
        if allow_missing and resource['kind'] == 'portal-access' and str(error) == 'Cloudflare 요청 실패: HTTP 404.':
            return False
        raise
    actual, guard = public_snapshot(resource['kind'], current), copy.deepcopy(resource['guard'])
    if resource['kind'] == 'tunnel':
        # Preserve old journal shapes while excluding ephemeral connection observations.
        actual.pop('connections', None)
        guard.pop('connections', None)
    if actual != guard:
        raise ProvisionFailure('RESOURCE_CHANGED_REVIEW_REQUIRED')
    if resource['kind'] == 'tunnel':
        if tunnel_clients(config, api, resource):
            raise ProvisionFailure('TUNNEL_IN_USE')
        if resource['tunnelConfig'] is not None and public_snapshot('tunnel-config',
                api.get(path + '/configurations')['result']) != resource['tunnelConfig']:
            raise ProvisionFailure('TUNNEL_CONFIG_CHANGED')
    return True


def verify_portal_access_inventory(config, api, resources):
    owned = {x['id'] for x in resources if x['kind'] == 'portal-access'}
    for app in api.listing('/accounts/' + config['accountId'] + '/access/apps'):
        if app.get('id') not in owned and any(
                pattern.fullmatch(config['portalHostname']) for pattern in access_public_patterns(app)):
            raise ProvisionFailure('PORTAL_ACCESS_CONFLICT_REVIEW_REQUIRED')


def deletion_confirmed(config, api, resource):
    """Resolve one lost acknowledgement by authoritative reads, never by another DELETE."""
    path = resource_path(config, resource)
    try:
        current = api.get(path)['result']
    except ApiFailure as error:
        if str(error) != 'Cloudflare 요청 실패: HTTP 404.':
            raise
    else:
        if (resource['kind'] != 'tunnel' or not isinstance(current, dict)
                or current.get('id') != resource['id'] or current.get('status') not in ['down', 'inactive']
                or not isinstance(current.get('deleted_at'), str)
                or not current['deleted_at'] or tunnel_clients(config, api, resource)):
            return False
        try:
            deleted = datetime.fromisoformat(current['deleted_at'].replace('Z', '+00:00'))
        except ValueError:
            return False
        if deleted.tzinfo is None or deleted > datetime.now(timezone.utc):
            return False
    query = {'is_deleted': 'false'} if resource['kind'] == 'tunnel' else None
    rows = api.listing(path.rsplit('/', 1)[0], query)
    if (not isinstance(rows, list) or any(not isinstance(x, dict) or not isinstance(x.get('id'), str) for x in rows)
            or len({x['id'] for x in rows}) != len(rows)):
        return False
    return all(x['id'] != resource['id'] for x in rows)


def cleanup(api, journal):
    from cloudflare_connector import ensure_removed
    ensure_removed(journal)
    s = journal.state
    if s['uncertain'] or s['intent'] is not None:
        raise ProvisionFailure('MANUAL_RECONCILIATION_REQUIRED')
    verify_portal_access_inventory(s['config'], api, s['resources'])
    for resource in s['resources']:
        verify_resource(s['config'], api, resource, allow_missing=s['portalDeleted'])
    s['status'] = 'CLEANING'
    journal.save()
    while s['resources']:
        verify_portal_access_inventory(s['config'], api, s['resources'])
        resource = s['resources'][-1]
        path = resource_path(s['config'], resource)
        if verify_resource(s['config'], api, resource, allow_missing=s['portalDeleted']):
            try:
                write_step(api, journal, resource['kind'], 'DELETE', path)
            except ProvisionFailure:
                if not s['uncertain']:
                    raise
                try:
                    confirmed = deletion_confirmed(s['config'], api, resource)
                except (ApiFailure, ProvisionFailure, KeyError, TypeError):
                    confirmed = False
                if not confirmed:
                    # Keep the original unknown DELETE and its durable intent, even when GET is a known rejection.
                    raise
                s['uncertain'] = False
                s['status'] = 'CLEANING'
            if resource['kind'] == 'mcp-portal':
                s['portalDeleted'] = True
        s['resources'].pop()
        s['intent'] = None
        journal.save()
    s['status'] = 'CLEANED'
    journal.save()
    return {'status': 'CLEANED', 'loginVerified': False}
