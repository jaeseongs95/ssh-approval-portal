import contextlib
import copy
import hashlib
import io
import json
import os
import stat
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.error import HTTPError, URLError
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import cloudflare_setup as cf
import cloudflare_provision as cp
import portal
from test_cloudflare_setup import Opener


def config():
    return {'accountId': 'a' * 32, 'zoneId': 'b' * 32, 'zoneName': 'example.test', 'name': 'new-install',
            'adminHostname': 'approve.example.test', 'originHostname': 'origin.example.test',
            'portalHostname': 'mcp.example.test', 'ownerEmails': ['owner@example.test'],
            'redirectUris': ['https://client.example.test/callback'], 'adminPort': 39125, 'mcpPort': 39124}


SECRET = 'SYNTHETIC_PRIVATE_BEARER_123456789'
TUNNEL_TOKEN = 'SYNTHETIC_TUNNEL_TOKEN_987654321'
TUNNEL_SECRET = 'SYNTHETIC_TUNNEL_SECRET_987654321'
API_TOKEN = 'SYNTHETIC_API_TOKEN_123456789'


class MemoryJournal:
    def __init__(self):
        self.state = {'version': 2, 'config': config(), 'status': 'NEW', 'resources': [],
                      'intent': None, 'uncertain': False, 'portalDeleted': False}
        self.snapshots = []
    def save(self):
        self.snapshots.append(copy.deepcopy(self.state))
    def read_record(self, name):
        raise FileNotFoundError(name)


class Account:
    """Contract boundary fixture, not an observed Cloudflare deployment."""
    def __init__(self, journal, fail_at=None, uncertain=False, cascade=True):
        self.journal, self.fail_at, self.uncertain, self.cascade = journal, fail_at, uncertain, cascade
        self.remote, self.writes, self.counter = {}, [], 0
        self.app_base = '/accounts/' + 'a' * 32 + '/access/apps'
        self.auto_app = None
        self.clients = []
    def listing(self, path, query=None):
        return [copy.deepcopy(value) for key, value in self.remote.items()
                if key.rsplit('/', 1)[0] == path and (not query or all(
                    k == 'is_deleted' or value.get(k) == v for k, v in query.items()))]
    def get(self, path, query=None):
        if path.endswith('/connections') and path.rsplit('/', 1)[0] in self.remote:
            return {'result': copy.deepcopy(self.clients), 'result_info': {'page': 1, 'per_page': 100, 'total_count': len(self.clients)}}
        if path == '/zones/' + 'b' * 32:
            return {'result': {'name': 'example.test', 'status': 'active', 'account': {'id': 'a' * 32}}}
        if path.endswith('/access/organizations'):
            return {'result': {'auth_domain': 'fixture.cloudflareaccess.com'}}
        if path not in self.remote:
            raise cf.ApiFailure('Cloudflare 요청 실패: HTTP 404.')
        return {'result': copy.deepcopy(self.remote[path])}
    def change(self, method, path, body=None):
        if self.journal.state['intent'] is None:
            raise AssertionError('Durable intent must precede every remote write')
        self.writes.append((method, path, copy.deepcopy(body)))
        if len(self.writes) == self.fail_at and not self.uncertain:
            raise cf.ApiFailure('synthetic rejected request', uncertain=False)
        if method == 'POST':
            self.counter += 1
            identifier = body.get('id') or f'{self.counter:032x}'
            result = {**copy.deepcopy(body), 'id': identifier}
            result.pop('auth_credentials', None)
            self.remote[path + '/' + identifier] = result
            if path.endswith('/mcp/portals'):
                self.counter += 1
                self.auto_app = self.app_base + '/' + f'{self.counter:032x}'
                self.remote[self.auto_app] = {'id': f'{self.counter:032x}', 'type': 'mcp_portal',
                    'domain': body['hostname'], 'policies': [], 'http_only_cookie_attribute': True}
        elif method == 'PUT':
            self.remote[path] = copy.deepcopy(body)
            result = self.remote[path]
        elif method == 'DELETE':
            self.remote.pop(path)
            if path.endswith('/mcp/portals/new-install') and self.cascade:
                self.remote.pop(self.auto_app, None)
            result = None
        else:
            raise AssertionError('Unsupported write')
        if len(self.writes) == self.fail_at:
            raise cf.ApiFailure('synthetic unknown write', uncertain=True)
        return {'result': copy.deepcopy(result)}


class DocumentedTunnelAccount(Account):
    """POST credentials are not echoed by GET; the two documented config forms are equivalent."""
    def __init__(self, journal, source='config_src', **kwargs):
        super().__init__(journal, **kwargs)
        self.source, self._token = source, API_TOKEN

    def change(self, method, path, body=None):
        result = super().change(method, path, body)
        if method == 'POST' and path.endswith('/cfd_tunnel'):
            created = result['result']
            created.update(account_tag='a' * 32, connections=[], metadata={}, deleted_at=None,
                           created_at='2026-10-19T00:00:00Z', tun_type='cfd_tunnel')
            if self.source == 'remote_config':
                created.pop('config_src')
                created['remote_config'] = True
            current = copy.deepcopy(created)
            if self.source == 'config_src':
                current.pop('config_src')
                current['remote_config'] = True
            else:
                current.pop('remote_config')
                current['config_src'] = 'cloudflare'
            self.remote[path + '/' + created['id']] = current
            created['token'] = TUNNEL_TOKEN
            created['credentials_file'] = {'AccountTag': 'a' * 32, 'TunnelID': created['id'],
                                           'TunnelName': body['name'], 'TunnelSecret': TUNNEL_SECRET}
        return result


class Provisioning(unittest.TestCase):
    def test_documented_tunnel_response_preserves_public_identity_and_cleanup(self):
        for source in ['config_src', 'remote_config']:
            with self.subTest(source=source):
                journal = MemoryJournal()
                api = DocumentedTunnelAccount(journal, source)
                result = cp.provision(config(), api, journal, SECRET)
                self.assertEqual(result['status'], 'RESOURCES_CREATED_CONNECTION_REQUIRED')
                tunnel = next(x for x in journal.state['resources'] if x['kind'] == 'tunnel')
                self.assertEqual(tunnel['guard']['config_src'], 'cloudflare')
                self.assertNotIn('remote_config', tunnel['guard'])
                self.assertEqual(cp.cleanup(api, journal)['status'], 'CLEANED')
                saved = json.dumps(journal.snapshots)
                for secret in [SECRET, API_TOKEN, TUNNEL_TOKEN, TUNNEL_SECRET]:
                    self.assertNotIn(secret, saved)
                    self.assertNotIn(hashlib.sha256(secret.encode()).hexdigest(), saved)

    def test_tunnel_response_conflicts_and_unknown_secrets_stop_before_next_write(self):
        invalid = [{'config_src': 'local', 'remote_config': True}, {'config_src': None},
                   {'name': 'other-existing-tunnel'}, {'id': '../foreign'},
                   {'client_secret': TUNNEL_SECRET}, {'unexpected': TUNNEL_TOKEN},
                   {'credentials_file': {'TunnelID': 'f' * 32, 'TunnelSecret': TUNNEL_SECRET}},
                   {'credentials_file': []}]
        for changes in invalid:
            with self.subTest(fields=sorted(changes)):
                journal = MemoryJournal()
                api = DocumentedTunnelAccount(journal)
                original = api.change
                def changed_response(method, path, body=None):
                    result = original(method, path, body)
                    if method == 'POST' and path.endswith('/cfd_tunnel'):
                        result['result'].update(changes)
                    return result
                api.change = changed_response
                with self.assertRaises(cp.ProvisionFailure):
                    cp.provision(config(), api, journal, SECRET)
                self.assertEqual(len(api.writes), 2)
                for secret in [SECRET, API_TOKEN, TUNNEL_TOKEN, TUNNEL_SECRET]:
                    self.assertNotIn(secret, json.dumps(journal.snapshots))

    def test_platform_guard_rejects_other_posix_systems_before_secrets_or_files(self):
        for platform in ['darwin', 'freebsd14', 'win32']:
            with self.subTest(platform=platform), patch.object(cf.sys, 'platform', platform), \
                    patch.object(cf.getpass, 'getpass') as secret, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(cf.main(['--cleanup', '--state-dir', 'unused']), 1)
                secret.assert_not_called()
                with self.assertRaisesRegex(cp.ProvisionFailure, 'LINUX_STATE_REQUIRED'):
                    cp.Journal('unused')

    def test_added_configuration_is_not_mistaken_for_server_metadata(self):
        changes = [
            ('admin-access', 'destinations', [{'type': 'public', 'uri': 'other.example.test'}]),
            ('mcp-server', 'updated_tools', [{'name': 'read', 'enabled': False}]),
            ('admin-access', 'future_security_setting', {'enabled': True}),
        ]
        for kind, key, value in changes:
            with self.subTest(kind=kind, key=key):
                journal = MemoryJournal()
                api = Account(journal)
                cp.provision(config(), api, journal, SECRET)
                resource = next(x for x in journal.state['resources'] if x['kind'] == kind)
                api.remote[cp.resource_path(config(), resource)][key] = value
                before, state = copy.deepcopy(api.writes), copy.deepcopy(journal.state)
                with self.assertRaisesRegex(cp.ProvisionFailure, 'RESOURCE_CHANGED'):
                    cp.cleanup(api, journal)
                self.assertEqual(api.writes, before)
                self.assertEqual(journal.state, state)

    def test_known_readonly_metadata_does_not_block_cleanup(self):
        journal = MemoryJournal()
        api = Account(journal)
        cp.provision(config(), api, journal, SECRET)
        for resource in journal.state['resources']:
            remote = api.remote[cp.resource_path(config(), resource)]
            remote['created_at'] = '2026-10-19T00:00:00Z'
            for policy in remote.get('policies', []):
                policy['updated_at'] = '2026-10-19T01:00:00Z'
        self.assertEqual(cp.cleanup(api, journal)['status'], 'CLEANED')

    def test_resource_id_is_never_ignored_as_metadata(self):
        journal = MemoryJournal()
        api = Account(journal)
        cp.provision(config(), api, journal, SECRET)
        resource = next(x for x in journal.state['resources'] if x['kind'] == 'admin-access')
        api.remote[cp.resource_path(config(), resource)]['id'] = 'f' * 32
        before = copy.deepcopy(api.writes)
        with self.assertRaises(cp.ProvisionFailure):
            cp.cleanup(api, journal)
        self.assertEqual(api.writes, before)

    def test_derived_app_missing_before_our_portal_delete_stops_all_writes(self):
        journal = MemoryJournal()
        api = Account(journal)
        cp.provision(config(), api, journal, SECRET)
        api.remote.pop(api.auto_app)
        before, state = copy.deepcopy(api.writes), copy.deepcopy(journal.state)
        with self.assertRaises(cf.ApiFailure):
            cp.cleanup(api, journal)
        self.assertEqual(api.writes, before)
        self.assertEqual(journal.state, state)

    def test_cleanup_resumes_only_after_durable_known_portal_delete(self):
        journal = MemoryJournal()
        api = Account(journal)
        cp.provision(config(), api, journal, SECRET)
        # DNS DELETE, portal DELETE, then the noncascaded derived app DELETE is rejected.
        api.cascade = False
        api.fail_at = len(api.writes) + 3
        with self.assertRaises(cp.ProvisionFailure):
            cp.cleanup(api, journal)
        self.assertTrue(journal.state['portalDeleted'])
        self.assertFalse(any(x['kind'] == 'mcp-portal' for x in journal.state['resources']))
        self.assertFalse(journal.state['uncertain'])
        # Simulate its disappearance after the confirmed portal deletion; retry must not DELETE it.
        api.remote.pop(api.auto_app)
        api.fail_at = None
        self.assertEqual(cp.cleanup(api, journal)['status'], 'CLEANED')

    def test_private_response_fields_or_reflected_bearers_cannot_enter_journal(self):
        for response in [{'id': 'synthetic', 'client_secret': SECRET},
                         {'id': 'synthetic', 'unexpected': SECRET}]:
            with self.subTest(response=response), self.assertRaises(cp.ProvisionFailure):
                cp.public_snapshot('admin-access', response, [SECRET])
    def test_portal_forwards_explicit_cloudflare_authority_only_to_cloudflare(self):
        with patch.object(cf, 'main', return_value=0) as entry:
            self.assertEqual(portal.main(['connect', 'cloudflare', '--config', 'public.json', '--apply',
                                         '--state-dir', '/private/run']), 0)
            self.assertEqual(entry.call_args.args[0], ['--config', 'public.json', '--apply', '--state-dir', '/private/run'])
        for flag in ['--apply', '--cleanup']:
            with self.subTest(flag=flag), self.assertRaises(ValueError):
                portal.plan(portal.arguments(['connect', 'access', flag]))

    def test_http_write_method_body_and_uncertain_failures_are_distinguished(self):
        for method in ['POST', 'PUT', 'DELETE']:
            opener = Opener(result={'id': 'synthetic'})
            body = {'auth_credentials': SECRET} if method != 'DELETE' else None
            cf.CloudflareApi(SECRET, opener).change(method, '/accounts/fixture/resource', body)
            request = opener.requests[0][0]
            self.assertEqual(request.get_method(), method)
            self.assertNotIn(SECRET, request.full_url)
            self.assertEqual(request.headers['Authorization'], 'Bearer ' + SECRET)
            self.assertEqual(json.loads(request.data)['auth_credentials'], SECRET) if body else self.assertIsNone(request.data)
        for status, uncertain in [(400, False), (403, False), (409, False), (500, True), (502, True), (302, True)]:
            opener = Opener(error=HTTPError('https://private.invalid/' + SECRET, status, SECRET, {}, io.BytesIO(SECRET.encode())))
            with self.subTest(status=status), self.assertRaises(cf.ApiFailure) as caught:
                cf.CloudflareApi(SECRET, opener).change('POST', '/accounts/fixture/resource', {})
            self.assertEqual(caught.exception.uncertain, uncertain)
            self.assertNotIn(SECRET, str(caught.exception))
        for opener in [Opener(error=URLError(SECRET)), Opener(body=SECRET.encode()), Opener(result={}, redirected=True)]:
            with self.assertRaises(cf.ApiFailure) as caught:
                cf.CloudflareApi(SECRET, opener).change('PUT', '/accounts/fixture/resource', {})
            self.assertTrue(caught.exception.uncertain)
            self.assertNotIn(SECRET, str(caught.exception))

    def test_portal_policy_update_never_selects_a_baseline_or_ambiguous_app(self):
        journal = MemoryJournal()
        api = Account(journal)
        existing = {'id': 'e' * 32, 'type': 'mcp_portal', 'domain': config()['portalHostname'], 'policies': []}
        api.remote[api.app_base + '/' + existing['id']] = existing
        self.assertRaises(cp.ProvisionFailure, cp.portal_app, config(), api, {'e' * 32})
        api.remote[api.app_base + '/' + 'd' * 32] = {**existing, 'id': 'd' * 32}
        self.assertRaises(cp.ProvisionFailure, cp.portal_app, config(), api, set())
        self.assertEqual(api.writes, [])

    def test_create_then_explicit_cleanup_preserves_foreign_resources_and_secrets(self):
        for cascade in [True, False]:
            with self.subTest(cascade=cascade):
                journal = MemoryJournal()
                api = Account(journal, cascade=cascade)
                foreign_path = api.app_base + '/' + 'f' * 32
                foreign = {'id': 'f' * 32, 'name': 'existing', 'type': 'self_hosted', 'domain': 'other.test', 'policies': []}
                api.remote[foreign_path] = copy.deepcopy(foreign)
                result = cp.provision(config(), api, journal, SECRET)
                self.assertEqual(result['status'], 'RESOURCES_CREATED_CONNECTION_REQUIRED')
                self.assertFalse(result['loginVerified'])
                self.assertNotIn(SECRET, json.dumps(journal.snapshots))
                self.assertTrue(api.remote[api.auto_app]['http_only_cookie_attribute'])
                self.assertEqual(api.remote[api.auto_app]['oauth_configuration']['dynamic_client_registration']['allowed_uris'], config()['redirectUris'])
                self.assertEqual(api.writes[0][2]['type'], 'self_hosted', 'Admin policy must exist before DNS is exposed')
                self.assertEqual(cp.cleanup(api, journal)['status'], 'CLEANED')
                self.assertEqual({k: v for k, v in api.remote.items() if not k.endswith('/configurations')}, {foreign_path: foreign})

    def test_definite_failure_at_every_write_can_cleanup_known_prefix(self):
        count = len(cf.connection_plan(config())['plannedResources']) - 1  # Fixture auto-creates portal Access.
        for point, cascade in [(i, c) for i in range(1, count + 1) for c in [True, False]]:
            with self.subTest(point=point, cascade=cascade):
                journal = MemoryJournal()
                api = Account(journal, fail_at=point, cascade=cascade)
                with self.assertRaises(cp.ProvisionFailure):
                    cp.provision(config(), api, journal, SECRET)
                self.assertFalse(journal.state['uncertain'])
                self.assertIsNone(journal.state['intent'])
                api.fail_at = None
                cp.cleanup(api, journal)
                self.assertEqual(journal.state['status'], 'CLEANED')
                self.assertEqual([k for k in api.remote if not k.endswith('/configurations')], [])

    def test_unknown_response_never_replays_or_automatically_deletes(self):
        for point in range(1, len(cf.connection_plan(config())['plannedResources'])):
            with self.subTest(point=point):
                journal = MemoryJournal()
                api = Account(journal, fail_at=point, uncertain=True)
                with self.assertRaises(cp.ProvisionFailure):
                    cp.provision(config(), api, journal, SECRET)
                before = copy.deepcopy(api.writes)
                with self.assertRaisesRegex(cp.ProvisionFailure, 'MANUAL_RECONCILIATION_REQUIRED'):
                    cp.cleanup(api, journal)
                with self.assertRaises(cp.ProvisionFailure):
                    cp.provision(config(), api, journal, SECRET)
                self.assertEqual(api.writes, before)

    def test_remote_identity_or_tunnel_use_change_stops_cleanup(self):
        journal = MemoryJournal()
        api = Account(journal)
        cp.provision(config(), api, journal, SECRET)
        resource = journal.state['resources'][-1]
        path = cp.resource_path(config(), resource)
        api.remote[path]['name'] = 'changed.example.test'
        before = len(api.writes)
        with self.assertRaisesRegex(cp.ProvisionFailure, 'RESOURCE_CHANGED'):
            cp.cleanup(api, journal)
        self.assertEqual(len(api.writes), before)

    def test_cleanup_checks_all_resources_before_deleting_anything(self):
        for change in ['connections', 'config']:
            with self.subTest(change=change):
                journal = MemoryJournal()
                api = Account(journal)
                cp.provision(config(), api, journal, SECRET)
                tunnel = next(x for x in journal.state['resources'] if x['kind'] == 'tunnel')
                path = cp.resource_path(config(), tunnel)
                if change == 'connections':
                    api.remote[path]['connections'] = []  # Deprecated field can remain empty while connected.
                    api.clients = [{'id': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'conns': [{'id': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'}]}]
                else:
                    api.remote[path + '/configurations']['config']['ingress'].append({'service': 'another'})
                before = copy.deepcopy(api.writes)
                with self.assertRaises(cp.ProvisionFailure):
                    cp.cleanup(api, journal)
                self.assertEqual(api.writes, before)

    def test_conflict_or_bad_bearer_never_writes(self):
        journal = MemoryJournal()
        api = Account(journal)
        for token in ['', 'short', 'contains whitespace' * 3, '{"headers":{"Authorization":"other"}}']:
            with self.subTest(token=token), self.assertRaises(cp.ProvisionFailure):
                cp.provision(config(), api, journal, token)
        with patch.object(cp, 'preflight', return_value={'status': 'CONFLICT'}), self.assertRaises(cp.ProvisionFailure):
            cp.provision(config(), api, journal, SECRET)
        self.assertEqual(api.writes, [])

    def test_arbitrary_ids_and_kinds_cannot_escape_fixed_endpoints(self):
        for kind, identifier in [('dns', '../other'), ('dns', 'x?auth=y'), ('foreign', 'abc'), ('mcp-server', 'existing')]:
            with self.subTest(kind=kind), self.assertRaises(cp.ProvisionFailure):
                cp.resource_path(config(), {'kind': kind, 'id': identifier})

    def test_default_dryrun_apply_still_does_not_prompt_or_create_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            public = Path(tmp) / 'config.json'
            public.write_text(json.dumps(config()), encoding='utf-8')
            with patch.object(cf.getpass, 'getpass') as secret, contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(cf.main(['--config', str(public), '--apply', '--state-dir', str(Path(tmp)/'run'), '--dry-run']), 0)
            secret.assert_not_called()
            self.assertFalse(json.loads(out.getvalue())['mutatesResources'])
            self.assertEqual(list(Path(tmp).iterdir()), [public])

    def test_mutating_cli_invalid_combinations_and_non_tty_do_not_write(self):
        for args in [['--apply'], ['--cleanup'], ['--state-dir', 'x'], ['--cleanup', '--state-dir', 'x', '--dry-run']]:
            with self.subTest(args=args), contextlib.redirect_stderr(io.StringIO()), patch.object(cf.getpass, 'getpass') as secret:
                self.assertEqual(cf.main(args), 1)
                secret.assert_not_called()
        with patch.object(cf.sys.stdin, 'isatty', return_value=False), patch.object(cf.getpass, 'getpass') as secret, \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cf.main(['--cleanup', '--state-dir', 'unused']), 1)
            secret.assert_not_called()


@unittest.skipUnless(sys.platform.startswith('linux'), 'Linux filesystem and flock contract')
class PrivateJournal(unittest.TestCase):
    def test_documented_tunnel_credentials_are_never_durable_and_prefix_can_resume(self):
        for source in ['config_src', 'remote_config']:
            for fail_at in [None, 3]:
                with self.subTest(source=source, fail_at=fail_at), tempfile.TemporaryDirectory() as tmp:
                    directory = Path(tmp)/'run'
                    snapshots, stdout, stderr = [], io.StringIO(), io.StringIO()
                    save = cp.Journal.save
                    def observe_save(journal):
                        save(journal)
                        snapshots.append((directory/'state.json').read_bytes())
                    with patch.object(cp.Journal, 'save', observe_save), contextlib.redirect_stdout(stdout), \
                            contextlib.redirect_stderr(stderr):
                        with cp.Journal(directory, config()) as journal:
                            api = DocumentedTunnelAccount(journal, source, fail_at=fail_at)
                            foreign_path = api.app_base + '/' + 'f' * 32
                            foreign = {'id': 'f' * 32, 'type': 'self_hosted', 'domain': 'existing.test'}
                            api.remote[foreign_path] = copy.deepcopy(foreign)
                            if fail_at:
                                with self.assertRaisesRegex(cp.ProvisionFailure, 'REMOTE_WRITE_FAILED'):
                                    cp.provision(config(), api, journal, SECRET)
                            else:
                                cp.provision(config(), api, journal, SECRET)
                            tunnel_id = next(x['id'] for x in journal.state['resources'] if x['kind'] == 'tunnel')
                        with cp.Journal(directory) as journal:
                            self.assertEqual(next(x['id'] for x in journal.state['resources'] if x['kind'] == 'tunnel'), tunnel_id)
                            self.assertEqual(journal.state['status'], 'FAILED' if fail_at else 'RESOURCES_CREATED_CONNECTION_REQUIRED')
                            api.journal, api.fail_at = journal, None
                            self.assertEqual(cp.cleanup(api, journal)['status'], 'CLEANED')
                            self.assertEqual(api.remote[foreign_path], foreign)
                    observed = b'\n'.join(snapshots) + (stdout.getvalue()+stderr.getvalue()).encode()
                    for secret in [SECRET, API_TOKEN, TUNNEL_TOKEN, TUNNEL_SECRET]:
                        self.assertNotIn(secret.encode(), observed)
                        self.assertNotIn(hashlib.sha256(secret.encode()).hexdigest().encode(), observed)

    def test_run_parent_file_and_directory_are_durable_before_first_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp)
            seen = []
            real_fsync = os.fsync
            def observe(fd):
                seen.append((os.fstat(fd).st_ino, os.fstat(fd).st_mode))
                real_fsync(fd)
            with patch.object(cp.os, 'fsync', side_effect=observe):
                with cp.Journal(parent/'run', config()) as journal:
                    api = Account(journal, fail_at=1)
                    original = api.change
                    def first_write(*args):
                        self.assertIn(parent.stat().st_ino, [inode for inode, mode in seen],
                                      'Parent directory must be synced before the first remote write')
                        self.assertIn(os.fstat(journal.fd).st_ino, [inode for inode, mode in seen])
                        self.assertTrue(any(stat.S_ISREG(mode) for inode, mode in seen))
                        self.assertEqual(json.loads((parent/'run/state.json').read_text())['intent'],
                                         journal.state['intent'])
                        return original(*args)
                    with patch.object(api, 'change', side_effect=first_write), self.assertRaises(cp.ProvisionFailure):
                        cp.provision(config(), api, journal, SECRET)
                    self.assertEqual(len(api.writes), 1)
            self.assertEqual(seen[0][0], parent.stat().st_ino)

    def test_parent_fsync_failure_is_before_any_remote_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = MemoryJournal()
            api = Account(journal)
            parent_inode = Path(tmp).stat().st_ino
            real_fsync = os.fsync
            def fail_parent(fd):
                if os.fstat(fd).st_ino == parent_inode:
                    raise OSError('synthetic parent fsync failure')
                real_fsync(fd)
            with patch.object(cp.os, 'fsync', side_effect=fail_parent), self.assertRaises(OSError):
                with cp.Journal(Path(tmp)/'run', config()) as actual:
                    api.journal = actual
                    cp.provision(config(), api, actual, SECRET)
            self.assertEqual(api.writes, [])

    def test_saved_plan_and_full_guard_are_validated_on_reopen(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)/'run'
            with cp.Journal(directory, config()) as journal:
                api = Account(journal)
                cp.provision(config(), api, journal, SECRET)
                self.assertNotIn(SECRET.encode(), (directory/'state.json').read_bytes())
            with cp.Journal(directory) as journal:
                api.journal = journal
                self.assertEqual(cp.cleanup(api, journal)['status'], 'CLEANED')
            for invalid in ['empty', 'wrong-plan', 'wrong-config', 'wrong-id']:
                path = Path(tmp)/invalid
                with cp.Journal(path, config()) as journal:
                    api = Account(journal)
                    cp.provision(config(), api, journal, SECRET)
                    resource = next(x for x in journal.state['resources'] if x['kind'] == 'tunnel')
                    if invalid == 'empty':
                        resource['expected'] = {}
                    elif invalid == 'wrong-plan':
                        resource['expected']['name'] = 'other-existing-tunnel'
                        resource['guard']['name'] = 'other-existing-tunnel'
                    elif invalid == 'wrong-config':
                        resource['tunnelConfig'] = {}
                    else:
                        resource['id'] = 'f' * 32
                    journal.save()
                before = copy.deepcopy(api.writes)
                with self.assertRaises(cp.ProvisionFailure):
                    cp.Journal(path)
                self.assertEqual(api.writes, before)

    def test_durable_portal_delete_marker_survives_actual_journal_reopen(self):
        for cascade in [True, False]:
            with self.subTest(cascade=cascade), tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp)/'run'
                with cp.Journal(directory, config()) as journal:
                    api = Account(journal, cascade=cascade)
                    cp.provision(config(), api, journal, SECRET)
                    api.fail_at = len(api.writes) + 3
                    with self.assertRaises(cp.ProvisionFailure):
                        cp.cleanup(api, journal)
                    self.assertTrue(journal.state['portalDeleted'])
                with cp.Journal(directory) as journal:
                    api.journal = journal
                    self.assertTrue(journal.state['portalDeleted'])
                    api.remote.pop(api.auto_app, None)
                    api.fail_at = None
                    self.assertEqual(cp.cleanup(api, journal)['status'], 'CLEANED')
    def test_private_atomic_state_lock_and_crash_intent(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / 'run'
            with cp.Journal(directory, config()) as journal:
                self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
                self.assertEqual((directory/'state.json').stat().st_mode & 0o777, 0o600)
                with self.assertRaises(BlockingIOError):
                    cp.Journal(directory)
                journal.state['intent'] = {'kind': 'tunnel', 'method': 'POST'}
                journal.save()
            with cp.Journal(directory) as journal:
                self.assertTrue(journal.state['uncertain'])
                with self.assertRaises(cp.ProvisionFailure):
                    cp.cleanup(Account(journal), journal)
            with self.assertRaises(FileExistsError):
                cp.Journal(directory, config())

    def test_symlink_hardlink_permissions_and_duplicate_json_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / 'run'
            with cp.Journal(directory, config()):
                pass
            link = Path(tmp) / 'link'
            link.symlink_to(directory, target_is_directory=True)
            with self.assertRaises(OSError):
                cp.Journal(link)
            state = directory/'state.json'
            os.link(state, directory/'hardlink')
            with self.assertRaises(cp.ProvisionFailure):
                cp.Journal(directory)
            (directory/'hardlink').unlink()
            state.chmod(0o644)
            with self.assertRaises(cp.ProvisionFailure):
                cp.Journal(directory)
            state.chmod(0o600)
            state.write_text('{"version":1,"version":1}', encoding='utf-8')
            with self.assertRaises(ValueError):
                cp.Journal(directory)


if __name__ == '__main__':
    unittest.main()
