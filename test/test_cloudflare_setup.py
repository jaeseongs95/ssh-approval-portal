import contextlib
import copy
import importlib.util
import io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('cloudflare_setup', ROOT / 'scripts/cloudflare_setup.py')
cf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cf)


def config():
    return {'accountId': 'a' * 32, 'zoneId': 'b' * 32, 'zoneName': 'example.test', 'name': 'isolated-test',
            'adminHostname': 'approve.example.test', 'originHostname': 'origin.example.test',
            'portalHostname': 'mcp.example.test', 'ownerEmails': ['owner@example.test'],
            'redirectUris': ['https://client.example.test/oauth/callback'], 'adminPort': 39125, 'mcpPort': 39124}


class Response(io.BytesIO):
    status = 200
    def __init__(self, url, body):
        super().__init__(body)
        self.url = url
    def geturl(self):
        return self.url


class Opener:
    def __init__(self, result=None, error=None, body=None, redirected=False):
        self.result = result
        self.error = error
        self.body = body
        self.redirected = redirected
        self.requests = []
    def open(self, request, timeout):
        self.requests.append((request, timeout))
        if self.error:
            raise self.error
        body = self.body if self.body is not None else json.dumps({'success': True, 'result': self.result}).encode()
        return Response('https://other.invalid/' if self.redirected else request.full_url, body)


class Account:
    """Cloud API boundary fixture; no real account or provisioned resource is implied."""
    def __init__(self, records=None):
        self.records = records or {}
        self.calls = []
    def get(self, path):
        self.calls.append(('GET', path))
        if path.startswith('/zones/'):
            return {'result': {'name': 'example.test', 'status': 'active', 'account': {'id': 'a' * 32}}}
        return {'result': {'auth_domain': 'fixture.cloudflareaccess.com'}}
    def listing(self, path, query=None):
        self.calls.append(('LIST', path, query))
        return self.records.get((path.rsplit('/', 1)[1], (query or {}).get('name')), [])


class CloudflareSetup(unittest.TestCase):
    def test_plan_is_new_resources_only_and_retains_owner_and_oauth_boundaries(self):
        c = config()
        plan = cf.connection_plan(c)
        self.assertFalse(plan['mutatesResources'])
        resources = {x['kind']: x for x in plan['plannedResources'] if x['kind'] != 'dns'}
        self.assertEqual(resources['tunnel-config']['body']['config']['ingress'][-1], {'service': 'http_status:404'})
        self.assertEqual(resources['mcp-server']['body']['hostname'], 'https://origin.example.test/mcp')
        self.assertNotIn('auth_credentials', resources['mcp-server']['body'])
        policy = resources['admin-access']['body']['policies'][0]
        self.assertEqual(policy['include'], [{'email': {'email': 'owner@example.test'}}])
        oauth = resources['portal-access-oauth']['changes']['oauth_configuration']
        self.assertEqual(oauth['dynamic_client_registration']['allowed_uris'], c['redirectUris'])
        self.assertFalse(oauth['dynamic_client_registration']['allow_any_on_loopback'])
        self.assertTrue(resources['portal-access-oauth']['preserveExistingFields'])
        self.assertIn('verify-public-dns-tls-and-oauth-login', plan['remainingSteps'])

    def test_config_rejects_extra_secret_duplicate_json_and_large_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'public.json'
            for raw in [json.dumps({**config(), 'apiToken': 'DO_NOT_PRINT'}),
                        '{"accountId":"a","accountId":"b"}', ' ' * 65537]:
                path.write_text(raw, encoding='utf-8')
                with self.subTest(length=len(raw)), self.assertRaises(ValueError):
                    cf.load_config(path)

    def test_portal_dns_is_planned_separately_from_tunnel(self):
        c = config()
        resources = cf.connection_plan(c)['plannedResources']
        records = [x for x in resources if x.get('path') == '/zones/' + c['zoneId'] + '/dns_records'
                   and x.get('body', {}).get('name') == c['portalHostname']]
        self.assertEqual(len(records), 1, 'Portal DNS must be created explicitly by API provisioning')
        self.assertEqual(records[0]['body'], {'type': 'CNAME', 'name': 'mcp.example.test',
                         'content': 'gateway.agents.cloudflare.com', 'proxied': True, 'ttl': 1})
        self.assertLess(resources.index(next(x for x in resources if x['kind'] == 'mcp-portal')),
                        resources.index(records[0]))

    def test_server_requires_its_own_owner_policy_before_portal_mapping(self):
        c = config()
        resources = cf.connection_plan(c)['plannedResources']
        server = next(x for x in resources if x['kind'] == 'mcp-server')
        access = next(x for x in resources if x['kind'] == 'server-access')
        portal = next(x for x in resources if x['kind'] == 'mcp-portal')
        destination = {'type': 'via_mcp_server_portal', 'mcp_server_id': server['body']['id']}
        self.assertEqual(access['method'], 'POST', 'Existing Access applications must not be overwritten')
        self.assertEqual(access['path'], '/accounts/' + c['accountId'] + '/access/apps')
        self.assertEqual(access['body']['type'], 'mcp')
        self.assertEqual(access['body']['destinations'], [destination], 'Server policy must bind to the new server')
        self.assertEqual(access['requiresAbsentDestination'], destination)
        self.assertEqual(access['body']['policies'], [{'name': 'isolated-test-owner-only', 'decision': 'allow',
                         'include': [{'email': {'email': 'owner@example.test'}}]}])
        self.assertEqual(portal['body']['servers'][0]['server_id'], destination['mcp_server_id'])
        self.assertLess(resources.index(server), resources.index(access))
        self.assertLess(resources.index(access), resources.index(portal))

    def test_orphan_server_access_destination_is_a_conflict_even_without_server(self):
        existing = {'type': 'mcp', 'destinations': [{'type': 'via_mcp_server_portal',
                    'mcp_server_id': 'isolated-test'}]}
        records = {('apps', None): [existing]}
        before = copy.deepcopy(records)
        result = cf.preflight(config(), Account(records))
        self.assertEqual(result['status'], 'CONFLICT')
        self.assertEqual(result['conflicts'], ['access-server'])
        self.assertEqual(records, before)

    def test_bad_fields_cannot_inject_api_paths_dns_policies_or_redirects(self):
        vectors = {'accountId': ['../x', 'A' * 32, 42], 'zoneId': ['x' * 32],
                   'name': ['../zone', '-bad', 'name/other', 'x' * 33],
                   'zoneName': ['https://example.test', 'example.test\n'],
                   'adminHostname': ['*.example.test', 'admin.other.test', 'EXAMPLE.test', 'admin.example.test/'],
                   'originHostname': ['approve.example.test'], 'portalHostname': ['127.0.0.1', 'a.example.test.evil'],
                   'adminPort': [True, 0, 65536, '39125', 39124],
                   'ownerEmails': [[], ['*@example.test'], ['one@example.test', 'ONE@example.test'], ['a@b'], [42]],
                   'redirectUris': [[], [{}], [42], ['http://client.test/cb'], ['https://user:password@client.test/cb'],
                                    ['https://client.test/cb#token'], ['https://client.test/cb?key=x'],
                                    ['https://*.client.test/cb'], ['https://client.test/*/cb'],
                                    ['https://client.test/cb\n'], ['https://client.test:444/cb']]}
        for field, values in vectors.items():
            for value in values:
                c = config()
                c[field] = value
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    cf.validate(c)

    def test_cli_dry_run_does_not_prompt_tokens_access_network_or_write_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'public.json'
            path.write_text(json.dumps(config()), encoding='utf-8')
            before = path.read_bytes()
            with patch.object(cf.getpass, 'getpass') as secret, patch.object(cf, 'CloudflareApi') as api, \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(cf.main(['--config', str(path), '--dry-run']), 0)
            secret.assert_not_called()
            api.assert_not_called()
            self.assertEqual(json.loads(out.getvalue())['status'], 'PLAN_READY')
            self.assertEqual(list(Path(tmp).iterdir()), [path])
            self.assertEqual(path.read_bytes(), before)
            candidate = Path(tmp) / 'candidate/scripts'
            candidate.mkdir(parents=True)
            for name in ['portal.py', 'cloudflare_setup.py']:
                (candidate / name).write_bytes((ROOT / 'scripts' / name).read_bytes())
            tree_before = {str(x.relative_to(tmp)): x.read_bytes() for x in Path(tmp).rglob('*') if x.is_file()}
            env = {k: v for k, v in os.environ.items() if k not in ['PYTHONDONTWRITEBYTECODE', 'PYTHONPYCACHEPREFIX']}
            real = subprocess.run([sys.executable, str(candidate / 'portal.py'), 'connect', 'cloudflare',
                                   '--config', str(path), '--dry-run'], capture_output=True, text=True,
                                  encoding='utf-8', check=True, env=env)
            self.assertEqual(json.loads(real.stdout)['status'], 'PLAN_READY')
            self.assertEqual({str(x.relative_to(tmp)): x.read_bytes() for x in Path(tmp).rglob('*') if x.is_file()},
                             tree_before, 'Dry run must not create Python bytecode caches or change the source tree')

    def test_noninteractive_checks_never_fall_back_to_echoing_getpass(self):
        with patch.object(cf, 'load_config', return_value=config()), patch.object(cf.sys.stdin, 'isatty', return_value=False), \
                patch.object(cf.getpass, 'getpass') as secret, contextlib.redirect_stderr(io.StringIO()) as out:
            self.assertEqual(cf.main(['--config', 'unused']), 1)
        secret.assert_not_called()
        self.assertNotIn('Traceback', out.getvalue())

    def test_public_interactive_setup_accepts_defaults_but_never_asks_for_token(self):
        c = config()
        answers = [c[x] for x in ['accountId', 'zoneId', 'zoneName', 'name', 'adminHostname', 'originHostname', 'portalHostname']]
        with patch.object(cf.sys.stdin, 'isatty', return_value=True), \
                patch('builtins.input', side_effect=answers + ['owner@example.test', c['redirectUris'][0], '', '']):
            self.assertEqual(cf.interactive_config(), c)

    def test_getpass_echo_fallback_is_rejected_and_no_api_request_occurs(self):
        with patch.object(cf, 'load_config', return_value=config()), \
                patch.object(cf.sys.stdin, 'isatty', return_value=True), \
                patch.object(cf.sys.stderr, 'isatty', return_value=True), \
                patch.object(cf.getpass, 'getpass', side_effect=cf.getpass.GetPassWarning('fixture')), \
                patch.object(cf, 'CloudflareApi') as api, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cf.main(['--config', 'unused']), 1)
        api.assert_not_called()

    def test_api_is_fixed_https_get_only_and_token_is_header_only(self):
        opener = Opener(result=[])
        self.assertEqual(cf.CloudflareApi('PRIVATE_FIXTURE', opener).get('/zones/' + 'b' * 32)['result'], [])
        request, timeout = opener.requests[0]
        self.assertTrue(request.full_url.startswith('https://api.cloudflare.com/client/v4/zones/'))
        self.assertEqual(request.get_method(), 'GET')
        self.assertIsNone(request.data)
        self.assertNotIn('PRIVATE_FIXTURE', request.full_url)
        self.assertEqual(request.headers['Authorization'], 'Bearer PRIVATE_FIXTURE')
        self.assertEqual(timeout, 15)
        for path in ['https://other.test', '//other.test', '/../private', '/a?secret=x']:
            with self.assertRaises(ValueError):
                cf.CloudflareApi('PRIVATE_FIXTURE', opener).get(path)

    def test_errors_and_redirects_never_echo_private_remote_content(self):
        private = 'PRIVATE_FIXTURE'
        cases = [Opener(error=HTTPError('https://secret.invalid/' + private, 403, private, {}, io.BytesIO(private.encode()))),
                 Opener(error=URLError(private)), Opener(body=private.encode()),
                 Opener(body=json.dumps({'success': False, 'errors': [private]}).encode()),
                 Opener(body=b'{}'), Opener(body=b'[]'), Opener(body=b'\xff'),
                 Opener(body=b'x' * (cf.MAX_RESPONSE + 1)), Opener(result=[], redirected=True)]
        for opener in cases:
            with self.subTest(opener=opener), self.assertRaises(cf.ApiFailure) as caught:
                cf.CloudflareApi(private, opener).get('/accounts/test')
            self.assertNotIn(private, str(caught.exception))
        self.assertIsNone(cf.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.invalid'))

    def test_real_http_redirect_does_not_forward_fixture_authorization(self):
        seen = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.path)
                self.send_response(302)
                self.send_header('Location', '/credential-target')
                self.end_headers()
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            request = Request(f'http://127.0.0.1:{server.server_port}/start', headers={'Authorization': 'Bearer FIXTURE_ONLY'})
            with self.assertRaises(HTTPError) as caught:
                build_opener(cf.NoRedirect()).open(request, timeout=2)
            caught.exception.close()
            self.assertEqual(caught.exception.code, 302)
            self.assertEqual(seen, ['/start'])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_pagination_inspects_all_pages_not_just_first_page(self):
        api = cf.CloudflareApi('PRIVATE_FIXTURE')
        with patch.object(api, 'get', side_effect=[{'result': [{'id': 'first'}], 'result_info': {'total_pages': 2}},
                                                   {'result': [{'id': 'last'}], 'result_info': {'total_pages': 2}}]) as get:
            self.assertEqual(api.listing('/accounts/test/access/apps'), [{'id': 'first'}, {'id': 'last'}])
            self.assertEqual(get.call_args_list[1].args[1]['page'], 2)
        with patch.object(api, 'get', return_value={'result': 'not-an-array'}), self.assertRaises(cf.ApiFailure):
            api.listing('/accounts/test/access/apps')

    def test_preflight_checks_scope_and_never_claims_provisioned_or_logged_in(self):
        account = Account()
        result = cf.preflight(config(), account)
        self.assertEqual(result['status'], 'READY_FOR_PROVISIONING')
        self.assertFalse(result['provisioned'])
        self.assertFalse(result['loginVerified'])
        self.assertEqual(len(account.calls), 9)
        self.assertTrue(all(x[0] in ['GET', 'LIST'] for x in account.calls))
        for bad in [{'name': 'other.test', 'status': 'active', 'account': {'id': 'a' * 32}},
                    {'name': 'example.test', 'status': 'pending', 'account': {'id': 'a' * 32}},
                    {'name': 'example.test', 'status': 'active', 'account': {'id': 'c' * 32}}]:
            with patch.object(account, 'get', return_value={'result': bad}), self.assertRaises(cf.ApiFailure):
                cf.preflight(config(), account)

    def test_conflicts_are_explicit_and_existing_resources_remain_untouched(self):
        records = {('cfd_tunnel', None): [{'name': 'isolated-test'}],
                   ('dns_records', 'origin.example.test'): [{'id': 'dns-existing'}],
                   ('apps', None): [{'domain': '*.example.test/private'}],
                   ('servers', None): [{'id': 'another-name', 'hostname': 'https://origin.example.test/mcp'}],
                   ('portals', None): [{'id': 'isolated-test', 'hostname': 'other.example.test'}]}
        original = copy.deepcopy(records)
        result = cf.preflight(config(), Account(records))
        self.assertEqual(result['status'], 'CONFLICT')
        self.assertEqual(result['conflicts'], ['access-domain', 'dns-originHostname', 'mcp-portals', 'mcp-servers', 'tunnel-name'])
        self.assertEqual(records, original)
        self.assertNotIn('dns-existing', json.dumps(result))

    def test_additional_access_hosts_and_public_destinations_cannot_be_missed(self):
        apps = [
            {'domain': 'unrelated.example.test', 'self_hosted_domains': ['unrelated.example.test', 'approve.example.test']},
            {'domain': 'unrelated.example.test', 'destinations': [{'type': 'public', 'uri': 'origin.example.test/mcp'}]},
            {'destinations': [{'type': 'public', 'uri': '*.example.test/private/*'}]},
            {'destinations': [{'uri': 'https://approve.example.test/admin'}]},
            {'self_hosted_domains': ['approve.example.test:443/admin']},
        ]
        for app in apps:
            with self.subTest(app=app):
                result = cf.preflight(config(), Account({('apps', None): [app]}))
                self.assertEqual(result['status'], 'CONFLICT')
                self.assertIn('access-domain', result['conflicts'])
        unrelated = {'domain': 'unrelated.example.test', 'self_hosted_domains': ['approve.example.test'],
                     'destinations': [{'type': 'public', 'uri': 'different.example.test/mcp'},
                                      {'type': 'private', 'hostname': 'approve.example.test'}]}
        self.assertEqual(cf.preflight(config(), Account({('apps', None): [unrelated]}))['status'], 'READY_FOR_PROVISIONING')

    def test_unsupported_or_malformed_access_host_shapes_do_not_report_ready(self):
        for app in [{'self_hosted_domains': 'approve.example.test'}, {'self_hosted_domains': [None]},
                    {'destinations': {}}, {'destinations': [None]},
                    {'destinations': [{'type': 'public'}]},
                    {'destinations': [{'type': 'unknown', 'uri': 'approve.example.test'}]},
                    {'destinations': [{'type': 'public', 'uri': 'https://owner:secret@approve.example.test'}]}]:
            with self.subTest(app=app), self.assertRaises(cf.ApiFailure):
                cf.preflight(config(), Account({('apps', None): [app]}))


if __name__ == '__main__':
    unittest.main()
