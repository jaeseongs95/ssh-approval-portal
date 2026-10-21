#!/usr/bin/env python3
"""Plan connections and inspect conflicts; writes require the explicit provisioning path."""
import argparse
import getpass
import ipaddress
import json
import os
from pathlib import Path
import re
import sys
import warnings
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, HTTPRedirectHandler, build_opener

API = 'https://api.cloudflare.com/client/v4'
if __name__ == '__main__':
    sys.modules['cloudflare_setup'] = sys.modules[__name__]
MAX_RESPONSE = 4 * 1024 * 1024
FIELDS = {'accountId', 'zoneId', 'zoneName', 'name', 'adminHostname', 'originHostname',
          'portalHostname', 'ownerEmails', 'redirectUris', 'adminPort', 'mcpPort'}


def hostname(value):
    if (not isinstance(value, str) or len(value) > 253 or '.' not in value
            or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', x)
                   for x in value.split('.')) or not re.fullmatch(r'[a-z]{2,63}', value.rsplit('.', 1)[1])):
        raise ValueError('호스트는 소문자 ASCII DNS 이름이어야 합니다.')
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return value
    raise ValueError('공개 DNS 이름을 지정하세요.')


def validate(config):
    if not isinstance(config, dict) or set(config) != FIELDS:
        raise ValueError('연결 설정의 필수 항목과 허용 항목을 확인하세요.')
    for key in ['accountId', 'zoneId']:
        if not isinstance(config[key], str) or not re.fullmatch(r'[a-f0-9]{32}', config[key]):
            raise ValueError('계정과 zone ID는 32자리 소문자 16진수여야 합니다.')
    if not isinstance(config['name'], str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', config['name']):
        raise ValueError('연결 이름은 영문 소문자로 시작하는 1~32자리 영문·숫자·하이픈이어야 합니다.')
    zone = hostname(config['zoneName'])
    hosts = [hostname(config[key]) for key in ['adminHostname', 'originHostname', 'portalHostname']]
    if len(set(hosts)) != 3 or any(not host.endswith('.' + zone) for host in hosts):
        raise ValueError('서로 다른 세 개의 zone 하위 호스트를 지정하세요.')
    for key in ['adminPort', 'mcpPort']:
        if type(config[key]) is not int or not 1 <= config[key] <= 65535:
            raise ValueError('포트는 1~65535 정수여야 합니다.')
    if config['adminPort'] == config['mcpPort']:
        raise ValueError('관리자와 MCP 포트는 달라야 합니다.')
    owners = config['ownerEmails']
    if (not isinstance(owners, list) or not 1 <= len(owners) <= 20
            or any(not isinstance(x, str) or len(x) > 254
                   or not re.fullmatch(r'[^\s,@*]+@[a-z0-9.-]+\.[a-z]{2,63}', x) for x in owners)
            or len({x.lower() for x in owners}) != len(owners)):
        raise ValueError('중복·와일드카드 없는 정확한 소유자 이메일 1~20개를 지정하세요.')
    uris = config['redirectUris']
    if (not isinstance(uris, list) or not 1 <= len(uris) <= 20
            or any(not isinstance(x, str) for x in uris) or len(set(uris)) != len(uris)):
        raise ValueError('중복 없는 OAuth HTTPS redirect URI 1~20개를 지정하세요.')
    for uri in uris:
        if not isinstance(uri, str) or len(uri) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in uri):
            raise ValueError('OAuth redirect URI를 확인하세요.')
        parsed = urlsplit(uri)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                or parsed.port not in [None, 443] or parsed.query or parsed.fragment or '\\' in uri
                or ('*' in uri and not (uri.endswith('/*') and uri.count('*') == 1))):
            raise ValueError('OAuth redirect URI는 자격정보·query·fragment 없는 HTTPS 주소여야 합니다.')
        hostname(parsed.hostname)
    return config


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('중복 JSON 키는 허용하지 않습니다.')
        result[key] = value
    return result


def load_config(path):
    # A connection file contains public setup inputs only; tokens have no accepted key.
    with Path(path).open('rb') as stream:
        data = stream.read(65537)
    if len(data) > 65536:
        raise ValueError('연결 설정이 너무 큽니다.')
    return validate(json.loads(data.decode('utf-8'), object_pairs_hook=unique_object))


def interactive_config():
    if not sys.stdin.isatty():
        raise ValueError('공개 연결 설정 JSON을 --config로 지정하거나 대화형 터미널을 사용하세요.')
    values = {key: input(label + ': ').strip() for key, label in [
        ('accountId', 'Cloudflare account ID'), ('zoneId', 'Cloudflare zone ID'),
        ('zoneName', 'Zone DNS name'), ('name', 'New connection name'),
        ('adminHostname', 'New administrator hostname'), ('originHostname', 'New MCP origin hostname'),
        ('portalHostname', 'New MCP portal hostname')]}
    values['ownerEmails'] = [x.strip() for x in input('Exact owner emails (comma separated): ').split(',')]
    values['redirectUris'] = [x.strip() for x in input('OAuth HTTPS redirect URIs (comma separated): ').split(',')]
    for key, label, default in [('adminPort', 'Local administrator port', 39125), ('mcpPort', 'Local MCP port', 39124)]:
        values[key] = int(input(f'{label} [{default}]: ').strip() or default)
    return validate(values)


def connection_plan(config):
    c = validate(config)
    account = '/accounts/' + c['accountId']
    mcp = account + '/access/ai-controls/mcp'
    policy = {'name': c['name'] + '-owner-only', 'decision': 'allow',
              'include': [{'email': {'email': x}} for x in c['ownerEmails']]}
    return {'status': 'PLAN_READY', 'mutatesResources': False,
            'requiredPermissions': ['Cloudflare Tunnel Write', 'Zone Read', 'DNS Write',
                                    'Access: Organizations, Identity Providers, and Groups Read',
                                    'Access: Apps and Policies Write', 'MCP Portals Write'],
            'plannedResources': [
                {'kind': 'admin-access', 'method': 'POST', 'path': account + '/access/apps',
                 'body': {'name': c['name'] + '-admin', 'type': 'self_hosted', 'domain': c['adminHostname'],
                          'session_duration': '24h', 'policies': [policy]}},
                {'kind': 'tunnel', 'method': 'POST', 'path': account + '/cfd_tunnel',
                 'body': {'name': c['name'], 'config_src': 'cloudflare'}},
                {'kind': 'tunnel-config', 'method': 'PUT', 'path': account + '/cfd_tunnel/{new-tunnel-id}/configurations',
                 'body': {'config': {'ingress': [
                     {'hostname': c['adminHostname'], 'service': f'http://127.0.0.1:{c["adminPort"]}'},
                     {'hostname': c['originHostname'], 'service': f'http://127.0.0.1:{c["mcpPort"]}'},
                     {'service': 'http_status:404'}]}}},
                *[{'kind': 'dns', 'method': 'POST', 'path': '/zones/' + c['zoneId'] + '/dns_records',
                   'body': {'type': 'CNAME', 'name': host, 'content': '{new-tunnel-id}.cfargotunnel.com', 'proxied': True, 'ttl': 1}}
                  for host in [c['adminHostname'], c['originHostname']]],
                {'kind': 'mcp-server', 'method': 'POST', 'path': mcp + '/servers',
                 'body': {'id': c['name'], 'name': c['name'], 'hostname': 'https://' + c['originHostname'] + '/mcp',
                          'auth_type': 'bearer'}, 'secretInput': 'existing MCP token; hidden input; never included in plan'},
                {'kind': 'server-access', 'method': 'POST', 'path': account + '/access/apps',
                 'requiresAbsentDestination': {'type': 'via_mcp_server_portal', 'mcp_server_id': c['name']},
                 'body': {'name': c['name'] + '-server', 'type': 'mcp',
                          'destinations': [{'type': 'via_mcp_server_portal', 'mcp_server_id': c['name']}],
                          'session_duration': '24h', 'policies': [policy]}},
                {'kind': 'mcp-portal', 'method': 'POST', 'path': mcp + '/portals',
                 'body': {'id': c['name'], 'name': c['name'], 'hostname': c['portalHostname'], 'code_mode': 'off',
                          'servers': [{'server_id': c['name'], 'default_disabled': False, 'on_behalf': False}]}},
                {'kind': 'portal-access', 'method': 'POST', 'path': account + '/access/apps',
                 'createIfNoDerivedApp': True,
                 'body': {'type': 'mcp_portal', 'domain': c['portalHostname'], 'policies': []}},
                {'kind': 'portal-dns', 'method': 'POST', 'path': '/zones/' + c['zoneId'] + '/dns_records',
                 'body': {'type': 'CNAME', 'name': c['portalHostname'], 'content': 'gateway.agents.cloudflare.com',
                          'proxied': True, 'ttl': 1}},
                {'kind': 'portal-access-oauth', 'method': 'PUT', 'path': account + '/access/apps/{new-portal-access-app-id}',
                 'preserveExistingFields': True, 'changes': {'policies': [policy], 'oauth_configuration': {
                     'enabled': True, 'dynamic_client_registration': {'enabled': True, 'allow_any_on_localhost': False,
                         'allow_any_on_loopback': False, 'allowed_uris': c['redirectUris']}}}}
            ], 'remainingSteps': ['provision-new-resources', 'install-local-connector',
                                  'configure-native-access-with-backup', 'verify-public-dns-tls-and-oauth-login'],
            'adminUrl': 'https://' + c['adminHostname'], 'mcpUrl': 'https://' + c['portalHostname'] + '/mcp'}


class ApiFailure(Exception):
    """Only fixed messages and HTTP status escape the credential-bearing transport."""
    def __init__(self, message, uncertain=False):
        super().__init__(message)
        self.uncertain = uncertain


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class CloudflareApi:
    def __init__(self, token, opener=None):
        if not isinstance(token, str) or not 1 <= len(token) <= 4096 or any(ord(c) < 33 or ord(c) > 126 for c in token):
            raise ValueError('Cloudflare API 토큰 형식을 확인하세요.')
        self._token = token
        self._opener = opener or build_opener(NoRedirect())

    def get(self, path, query=None):
        return self._request('GET', path, query=query)

    def change(self, method, path, body=None):
        if method not in ['POST', 'PUT', 'DELETE']:
            raise ValueError('지원하지 않는 변경 방식입니다.')
        return self._request(method, path, body=body)

    def _request(self, method, path, query=None, body=None):
        if not re.fullmatch(r'/[a-zA-Z0-9_/-]+', path) or '..' in path:
            raise ValueError('허용된 API 경로가 아닙니다.')
        url = API + path + ('?' + urlencode(query) if query else '')
        headers = {'Authorization': 'Bearer ' + self._token, 'Accept': 'application/json'}
        payload = None
        if body is not None:
            payload = json.dumps(body, separators=(',', ':'), allow_nan=False).encode('utf-8')
            if len(payload) > 65536:
                raise ValueError('Cloudflare 요청 크기 제한을 초과했습니다.')
            headers['Content-Type'] = 'application/json'
        request = Request(url, data=payload, headers=headers, method=method)
        uncertain = method != 'GET'
        try:
            with self._opener.open(request, timeout=15) as response:
                if response.status not in ([200] if method == 'GET' else [200, 201]) or response.geturl() != url:
                    raise ApiFailure('Cloudflare 응답 경로 또는 상태가 올바르지 않습니다.', uncertain)
                body = response.read(MAX_RESPONSE + 1)
            if len(body) > MAX_RESPONSE:
                raise ApiFailure('Cloudflare 응답 크기 제한을 초과했습니다.', uncertain)
            data = json.loads(body.decode('utf-8'), object_pairs_hook=unique_object)
            if not isinstance(data, dict) or data.get('success') is not True or 'result' not in data:
                raise ApiFailure('Cloudflare API가 요청을 거절했습니다.', uncertain)
            return data
        except HTTPError as error:
            error.close()
            raise ApiFailure(f'Cloudflare 요청 실패: HTTP {error.code}.',
                             uncertain and error.code not in [400, 401, 403, 404, 409, 422]) from None
        except (URLError, OSError, ValueError, UnicodeError):
            raise ApiFailure('Cloudflare 연결 또는 응답 해석에 실패했습니다.', uncertain) from None

    def listing(self, path, query=None):
        values, seen, expected = [], set(), None
        per_page = 100
        for page in range(1, 1001):
            data = self.get(path, {**(query or {}), 'page': page, 'per_page': per_page})
            result = data['result']
            if (not isinstance(result, list) or any(not isinstance(x, dict)
                    or not isinstance(x.get('id'), str) or not x['id'] for x in result)):
                raise ApiFailure('Cloudflare 목록 응답 형식이 올바르지 않습니다.')
            ids = [x['id'] for x in result]
            if len(set(ids)) != len(ids) or seen.intersection(ids):
                raise ApiFailure('Cloudflare 목록 항목이 중복되었습니다.')
            seen.update(ids)
            values.extend(result)
            info = data.get('result_info')
            if info is None:
                info = {}
            if not isinstance(info, dict):
                raise ApiFailure('Cloudflare 페이지 정보가 올바르지 않습니다.')
            for key in ['page', 'per_page', 'count', 'total_count', 'total_pages']:
                if key in info and (type(info[key]) is not int or info[key] < 0):
                    raise ApiFailure('Cloudflare 페이지 정보가 올바르지 않습니다.')
            size, count, pages = (info.get(k) for k in ['per_page', 'total_count', 'total_pages'])
            identity = (size, count, pages)
            if (info.get('page', page) != page or info.get('count', len(result)) != len(result)
                    or size is not None and (not 1 <= size <= 1000 or len(result) > size)
                    or pages is not None and (pages > 1000 or page > max(1, pages) or pages == 0 and values)
                    or count is not None and (count > 100000 or len(values) > count)
                    or len(values) > 100000 or expected is not None and identity != expected):
                raise ApiFailure('Cloudflare 페이지 정보가 응답과 일치하지 않습니다.')
            if size is not None and count is not None and pages is not None:
                calculated = (count + size - 1) // size
                if pages not in ([0, 1] if count == 0 else [calculated]):
                    raise ApiFailure('Cloudflare 전체 페이지 수가 일치하지 않습니다.')
            expected = identity
            if size is not None:
                per_page = size
            last = pages is not None and page >= max(1, pages)
            if last or not result:
                if count is not None and len(values) != count or not result and pages is not None and not last:
                    raise ApiFailure('Cloudflare 전체 목록을 확인하지 못했습니다.')
                return values
            if count is not None and len(values) == count and pages is None:
                return values
            # A short page may reflect a server-side page-size cap. Without totals, read through an empty page.
        raise ApiFailure('Cloudflare 목록 페이지 제한을 초과했습니다.')


def access_public_patterns(app):
    """Read both legacy and current Access destination forms without printing their values."""
    values = []
    if app.get('domain') is not None:
        values.append(app['domain'])
    if app.get('destinations') is not None:
        destinations = app['destinations']
        if not isinstance(destinations, list):
            raise ApiFailure('Cloudflare 앱 대상 응답 형식이 올바르지 않습니다.')
        for item in destinations:
            if not isinstance(item, dict):
                raise ApiFailure('Cloudflare 앱 대상 응답 형식이 올바르지 않습니다.')
            kind = item.get('type', 'public')
            if kind == 'public':
                values.append(item.get('uri'))
            elif kind not in ['private', 'via_mcp_server_portal', 'worker', 'preview_worker',
                              'all_workers', 'all_preview_workers']:
                raise ApiFailure('Cloudflare 앱 대상 유형을 지원하지 않습니다.')
    else:
        # destinations supersedes self_hosted_domains in the Cloudflare API contract.
        legacy = app.get('self_hosted_domains', [])
        if not isinstance(legacy, list):
            raise ApiFailure('Cloudflare 앱 대상 응답 형식이 올바르지 않습니다.')
        values.extend(legacy)
    patterns = []
    for value in values:
        if not isinstance(value, str) or not value or any(ord(c) < 33 or ord(c) > 126 for c in value):
            raise ApiFailure('Cloudflare 앱 공개 주소 형식이 올바르지 않습니다.')
        if '://' in value:
            parsed = urlsplit(value)
            if parsed.scheme not in ['https', 'http'] or parsed.username or parsed.password:
                raise ApiFailure('Cloudflare 앱 공개 주소 형식이 올바르지 않습니다.')
            domain = parsed.netloc
        else:
            domain = value.split('/', 1)[0]
        domain = domain.lower().split(':', 1)[0].rstrip('.')
        if not re.fullmatch(r'[a-z0-9*.-]+', domain):
            raise ApiFailure('Cloudflare 앱 공개 주소 형식을 지원하지 않습니다.')
        # Wildcard matching is deliberately conservative; a path may protect any proposed host route.
        patterns.append(re.compile('^' + re.escape(domain).replace(r'\*', '.*') + '$'))
    return patterns


def preflight(config, api):
    """Refuse conflicting names before a future provisioning step can create anything."""
    c = validate(config)
    account = '/accounts/' + c['accountId']
    zone = api.get('/zones/' + c['zoneId'])['result']
    if (not isinstance(zone, dict) or zone.get('name') != c['zoneName'] or zone.get('status') != 'active'
            or not isinstance(zone.get('account'), dict) or zone['account'].get('id') != c['accountId']):
        raise ApiFailure('Zone 이름·계정·활성 상태가 연결 설정과 일치하지 않습니다.')
    org = api.get(account + '/access/organizations')['result']
    if (not isinstance(org, dict) or not isinstance(org.get('auth_domain'), str)
            or not re.fullmatch(r'[a-z0-9-]+\.cloudflareaccess\.com', org['auth_domain'])):
        raise ApiFailure('Cloudflare Access 조직을 먼저 구성하세요.')
    conflicts = []
    if any(x.get('name') == c['name'] for x in api.listing(account + '/cfd_tunnel', {'is_deleted': 'false'})):
        conflicts.append('tunnel-name')
    for key in ['adminHostname', 'originHostname', 'portalHostname']:
        if api.listing('/zones/' + c['zoneId'] + '/dns_records', {'name': c[key]}):
            conflicts.append('dns-' + key)
    hosts = [c[key] for key in ['adminHostname', 'originHostname', 'portalHostname']]
    for app in api.listing(account + '/access/apps'):
        if any(pattern.fullmatch(host) for pattern in access_public_patterns(app) for host in hosts):
            conflicts.append('access-domain')
        if any(x.get('type') == 'via_mcp_server_portal' and x.get('mcp_server_id') == c['name']
               for x in (app.get('destinations') or [])):
            conflicts.append('access-server')
    for kind in ['servers', 'portals']:
        for item in api.listing(account + '/access/ai-controls/mcp/' + kind):
            domain = item.get('hostname', '')
            if not isinstance(domain, str):
                raise ApiFailure('Cloudflare MCP 응답 형식이 올바르지 않습니다.')
            if '://' in domain:
                domain = urlsplit(domain).hostname
            if item.get('id') == c['name'] or domain in hosts:
                conflicts.append('mcp-' + kind)
    return {'status': 'CONFLICT' if conflicts else 'READY_FOR_PROVISIONING',
            'mutatesResources': False, 'conflicts': sorted(set(conflicts)),
            'loginVerified': False, 'provisioned': False}


def main(argv=None):
    parser = argparse.ArgumentParser(description='Cloudflare 신규 연결 계획·읽기 전용 충돌 검사')
    parser.add_argument('--config', help='비밀 없는 공개 연결 설정 JSON')
    parser.add_argument('--dry-run', action='store_true', help='계정 조회 없이 연결 계획만 표시')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--apply', action='store_true', help='계획한 신규 자원만 생성 (Linux)')
    mode.add_argument('--cleanup', action='store_true', help='실행 기록의 신규 자원만 정리 (Linux)')
    mode.add_argument('--connector', action='store_true', help='새 전용 connector 서비스 설치·시작 (Linux root)')
    mode.add_argument('--remove-connector', action='store_true', help='이번 connector 서비스만 중지·제거 (Linux root)')
    mode.add_argument('--link-environment', action='store_true', help='이번 관리자 Access 앱을 ENV에 연결 (Linux root)')
    mode.add_argument('--restore-environment', action='store_true', help='이번 ENV 연결 전 인증 설정 복원 (Linux root)')
    mode.add_argument('--sync-server', action='store_true', help='연결된 이번 MCP 서버의 기능 목록을 한 번 동기화 (Linux root)')
    parser.add_argument('--state-dir', help='소유자 전용 실행 기록 폴더; apply는 새 경로 필수')
    binary = parser.add_mutually_exclusive_group()
    binary.add_argument('--cloudflared', help='connector에 사용할 설치된 root 소유 cloudflared 절대 경로')
    binary.add_argument('--install-cloudflared', action='store_true', help='고정 공식 cloudflared를 전용 경로에 검증·설치')
    options = parser.parse_args(argv)
    try:
        native = options.connector or options.remove_connector or options.link_environment or options.restore_environment or options.sync_server
        mutating = options.apply or options.cleanup or native
        if ((mutating and not options.state_dir) or (options.state_dir and not mutating)
                or ((options.cleanup or native) and options.config)
                or (options.cleanup and options.dry_run) or ((options.cloudflared or options.install_cloudflared) and not options.connector)):
            raise ValueError('변경 방식과 실행 기록 폴더를 확인하세요.')
        if native and options.dry_run:
            operation = next(name for name in ['connector', 'remove_connector', 'link_environment', 'restore_environment', 'sync_server'] if getattr(options, name))
            print(json.dumps({'status': 'DRY_RUN', 'operation': operation.replace('_', '-'),
                              'environmentChanged': False, 'externalMutation': False,
                              'stateDirectory': options.state_dir, 'loginVerified': False,
                              'binaryInstallRequested': options.install_cloudflared}))
            return 0
        if options.cleanup or native:
            return mutation_main(options)
        config = load_config(options.config) if options.config else interactive_config()
        work = connection_plan(config)
        if options.dry_run:
            print(json.dumps(work, ensure_ascii=False, indent=2))
            return 0
        if options.apply:
            return mutation_main(options, config)
        if not sys.stdin.isatty() or not sys.stderr.isatty():
            raise ValueError('API 토큰은 대화형 터미널에서만 숨김 입력할 수 있습니다.')
        with warnings.catch_warnings():
            # A nominal TTY can still lack echo control; never accept getpass's echo fallback.
            warnings.simplefilter('error', getpass.GetPassWarning)
            token = getpass.getpass('Cloudflare API token (hidden, read-only checks): ')
        result = preflight(config, CloudflareApi(token))
        print(json.dumps(result, ensure_ascii=False))
        return 3 if result['status'] == 'CONFLICT' else 0
    except (ValueError, OSError, UnicodeError, ApiFailure, EOFError, getpass.GetPassWarning):
        # Input/remote exceptions may contain credential-bearing text; never echo them.
        print('연결 검사를 완료하지 못했습니다. 설정·토큰 권한·네트워크를 확인하세요. 외부 자원은 변경하지 않았습니다.', file=sys.stderr)
        return 1


def mutation_main(options, config=None):
    # Imports are delayed so planning and the existing read-only path need no journal or lock.
    from cloudflare_provision import Journal, ProvisionFailure, cleanup, provision
    try:
        if not sys.platform.startswith('linux') or not sys.stdin.isatty() or not sys.stderr.isatty():
            raise ProvisionFailure('LINUX_INTERACTIVE_TERMINAL_REQUIRED')
        if (options.connector or options.remove_connector or options.link_environment or options.restore_environment or getattr(options, 'sync_server', False)) and os.geteuid() != 0:
            raise ProvisionFailure('LINUX_ROOT_REQUIRED')
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            token = getpass.getpass('Cloudflare API token (hidden, requested action permissions): ') if not (options.remove_connector or options.restore_environment) else None
            mcp_token = getpass.getpass('Existing MCP bearer token (hidden): ') if options.apply else None
        if config is not None and any(secret and secret in json.dumps(config) for secret in [token, mcp_token]):
            raise ProvisionFailure('SECRET_IN_PUBLIC_CONFIG')
        with Journal(options.state_dir, config if options.apply else None) as journal:
            if getattr(options, 'sync_server', False):
                from cloudflare_discovery import sync_server
                result = sync_server(CloudflareApi(token), journal)
            elif options.link_environment or options.restore_environment:
                from cloudflare_environment import link_environment, restore_environment
                result = link_environment(CloudflareApi(token), journal) if options.link_environment else restore_environment(journal)
            elif options.connector or options.remove_connector:
                from cloudflare_connector import install_connector, remove_connector
                result = (install_connector(CloudflareApi(token), journal, options.cloudflared, options.install_cloudflared) if options.connector
                          else remove_connector(journal))
            else:
                api = CloudflareApi(token)
                result = provision(config, api, journal, mcp_token) if options.apply else cleanup(api, journal)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except ProvisionFailure as error:
        code = str(error)
        print(json.dumps({'status': 'ACTION_REQUIRED',
                          'code': code if re.fullmatch(r'[A-Z_]{1,64}', code) else 'PROVISIONING_FAILED',
                          'resourcesMayRemain': True, 'doNotReplayCreation': True}), file=sys.stderr)
        return 1
    except (ValueError, TypeError, KeyError, OSError, UnicodeError, ApiFailure, EOFError, getpass.GetPassWarning):
        print('Cloudflare 변경을 완료하지 못했습니다. 실행 기록을 확인하세요. '
              '일부 신규 자원이 남아 있을 수 있으며 같은 생성 요청을 반복하지 마세요.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
