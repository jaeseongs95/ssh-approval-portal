import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
import cloudflare_connector as cc
import cloudflare_discovery as cd
import cloudflare_environment as ce
import cloudflare_provision as cp
import cloudflare_setup as cf
import portal
import test_cloudflare_connector as fixtures
from test_cloudflare_provision import SECRET


class Portable(unittest.TestCase):
    def test_cli_forwarding_dry_run_and_root_before_secret(self):
        args = ['--sync-server', '--state-dir', '/root/new']
        with patch.object(cf, 'main', return_value=0) as child:
            self.assertEqual(portal.main(['connect', 'cloudflare', *args]), 0)
            self.assertEqual(child.call_args.args[0], args)
        work = portal.plan(portal.arguments(['connect', 'cloudflare', *args]))
        self.assertTrue(work['externalMutation'])
        self.assertIn('--sync-server', work['steps'][0]['argv'])
        with patch.object(cf.getpass, 'getpass') as secret, patch.object(cp, 'Journal') as journal, \
                contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(portal.main(['connect', 'cloudflare', *args, '--dry-run']), 0)
            self.assertEqual(json.loads(out.getvalue())['operation'], 'sync-server')
            secret.assert_not_called()
            journal.assert_not_called()
        for uid, tty in [(1000, True), (0, False)]:
            with patch.object(cf.sys, 'platform', 'linux'), patch.object(cf.os, 'geteuid', return_value=uid, create=True), \
                    patch.object(cf.sys.stdin, 'isatty', return_value=tty), patch.object(cf.sys.stderr, 'isatty', return_value=tty), \
                    patch.object(cf.getpass, 'getpass') as secret, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(cf.main(args), 1)
                secret.assert_not_called()

    def test_invalid_combinations_never_read_state(self):
        with self.assertRaises(ValueError):
            portal.plan(portal.arguments(['connect', 'access', '--sync-server']))
        for args in [['--sync-server'], ['--sync-server', '--state-dir', '/root/new', '--config', 'unused'],
                     ['--sync-server', '--state-dir', '/root/new', '--install-cloudflared']]:
            with patch.object(cp, 'Journal') as journal, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(cf.main(args), 1)
                journal.assert_not_called()

    def test_cli_dispatch_prints_only_sanitized_result(self):
        expected = {'status': 'SERVER_SYNC_PENDING', 'toolCount': 0, 'loginVerified': False}
        with patch.object(cf.sys, 'platform', 'linux'), patch.object(cf.os, 'geteuid', return_value=0, create=True), \
                patch.object(cf.sys.stdin, 'isatty', return_value=True), patch.object(cf.sys.stderr, 'isatty', return_value=True), \
                patch.object(cf.getpass, 'getpass', return_value=SECRET), patch.object(cp, 'Journal') as journal, \
                patch.object(cf, 'CloudflareApi') as api, patch.object(cd, 'sync_server', return_value=expected) as sync, \
                contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(cf.main(['--sync-server', '--state-dir', '/root/new']), 0)
            sync.assert_called_once_with(api.return_value, journal.return_value.__enter__.return_value)
            self.assertEqual(json.loads(out.getvalue()), expected)
            self.assertNotIn(SECRET, out.getvalue())


class SyncApi:
    def __init__(self, owner, original):
        self.owner, self.original = owner, original
        self.server = next(x for x in original.journal.state['resources'] if x['kind'] == 'mcp-server')
        self.path = cp.resource_path(original.journal.state['config'], self.server)
        self.calls, self.mode, self.status, self.tools = [], None, 'ready', [{'name': 'synthetic-read'}]

    def listing(self, *args):
        return self.original.listing(*args)

    def get(self, path, query=None):
        if path == self.path and self.calls:
            if self.mode == 'read-failure':
                raise cf.ApiFailure(SECRET)
            value = self.original.get(path, query)
            value['result'].update(status=self.status, tools=self.tools)
            if self.mode == 'changed':
                value['result']['modified_at'] = 'later-credential-revision'
            return value
        return self.original.get(path, query)

    def change(self, method, path, body=None):
        self.owner.assertEqual((method, path, body), ('POST', self.path+'/sync', None))
        journal = self.original.journal
        self.owner.assertEqual(json.loads((journal.directory/'state.json').read_text())['intent'],
                               {'kind': 'mcp-server', 'method': 'POST'})
        cd.read_record(journal, cd.CLAIM, self.server['id'])
        self.calls.append((method, path))
        if self.mode in ['unknown', 'rejected']:
            raise cf.ApiFailure(SECRET, uncertain=self.mode == 'unknown')
        return {'result': {'status': 'unexpected' if self.mode == 'malformed' else self.status,
                           'error': SECRET, 'error_details': {'cause': SECRET}}}


@unittest.skipUnless(sys.platform.startswith('linux') and hasattr(os, 'geteuid') and os.geteuid() == 0,
                     'isolated Linux root fixture required')
class Filesystem(unittest.TestCase):
    def setUp(self):
        fixtures.Filesystem.setUp(self)
        cc.install_connector(self.api, self.journal, str(self.binary))
        self.remote = self.api
        self.api = SyncApi(self, self.remote)

    def test_sync_once_persists_private_result_then_reads_only_even_after_reopen(self):
        baseline = copy.deepcopy(self.journal.state)
        writes = copy.deepcopy(self.remote.writes)
        result = cd.sync_server(self.api, self.journal)
        self.assertEqual(result, {'status': 'SERVER_SYNCED', 'mcpStatus': 'ready', 'toolCount': 1,
                                 'syncRequested': True, 'loginVerified': False,
                                 'environmentChanged': False, 'configurationChanged': False})
        self.assertEqual(self.journal.state, baseline)
        self.assertEqual(self.remote.writes, writes)
        directory = self.journal.directory
        for name in [cd.CLAIM, cd.RESULT]:
            self.assertEqual((directory/name).stat().st_mode & 0o777, 0o600)
            self.assertNotIn(SECRET, (directory/name).read_text())
        self.journal.close()
        with cp.Journal(directory) as reopened:
            self.assertFalse(cd.sync_server(self.api, reopened)['syncRequested'])
        self.assertEqual(len(self.api.calls), 1)

    def test_waiting_error_and_empty_capabilities_are_not_successful_login(self):
        for status, tools in [('waiting', []), ('error', []), ('ready', [])]:
            self.api.status, self.api.tools = status, tools
            result = cd.sync_server(self.api, self.journal)
            self.assertEqual(result['status'], 'SERVER_SYNC_PENDING')
            self.assertFalse(result['loginVerified'])
        self.assertEqual(len(self.api.calls), 1)

    def test_ambiguous_write_or_post_read_and_changed_guard_preserve_intent_without_replay(self):
        # Each failure starts with its own real private journal and connector.
        for mode in ['unknown', 'malformed', 'read-failure', 'changed']:
            with self.subTest(mode=mode):
                self.api.mode = mode
                with self.assertRaises((cp.ProvisionFailure, cf.ApiFailure)):
                    cd.sync_server(self.api, self.journal)
                self.assertIsNotNone(self.journal.state['intent'])
                self.assertFalse((self.journal.directory/cd.RESULT).exists())
                with self.assertRaises(cp.ProvisionFailure):
                    cd.sync_server(self.api, self.journal)
                self.assertEqual(len(self.api.calls), 1)
            # New fixture, never erase/rewrite an uncertain run to retry it.
            if mode != 'changed':
                self.setUp()

    def test_definite_rejection_is_recorded_and_cannot_replay(self):
        self.api.mode = 'rejected'
        with self.assertRaisesRegex(cp.ProvisionFailure, 'REMOTE_WRITE_FAILED'):
            cd.sync_server(self.api, self.journal)
        self.assertFalse(self.journal.state['uncertain'])
        self.assertIsNone(self.journal.state['intent'])
        self.assertEqual(self.journal.state['status'], 'FAILED')
        with self.assertRaises(cp.ProvisionFailure):
            cd.sync_server(self.api, self.journal)
        self.assertEqual(len(self.api.calls), 1)

    def test_existing_claim_invalid_result_or_symlink_never_sends_sync(self):
        claim = {'version': 1, 'serverId': self.api.server['id'], 'operation': 'POST /sync'}
        cc.create_file(self.journal.directory/cd.CLAIM, json.dumps(claim).encode(), 0o600)
        with self.assertRaisesRegex(cp.ProvisionFailure, 'OUTCOME_REVIEW_REQUIRED'):
            cd.sync_server(self.api, self.journal)
        result = self.journal.directory/cd.RESULT
        result.symlink_to(self.journal.directory/cd.CLAIM)
        with self.assertRaises((cp.ProvisionFailure, OSError)):
            cd.sync_server(self.api, self.journal)
        result.unlink()
        cc.create_file(result, json.dumps({**claim, 'responseStatus': 'foreign'}).encode(), 0o600)
        with self.assertRaisesRegex(cp.ProvisionFailure, 'INVALID_DISCOVERY_SYNC_RECORD'):
            cd.sync_server(self.api, self.journal)
        self.assertEqual(self.api.calls, [])

    def test_remote_config_drift_and_disconnected_edge_block_before_claim(self):
        self.remote.remote[self.api.path]['modified_at'] = 'later-credential-revision'
        with self.assertRaises(cp.ProvisionFailure):
            cd.sync_server(self.api, self.journal)
        self.remote.remote[self.api.path].pop('modified_at')
        self.remote.clients = []
        with self.assertRaisesRegex(cp.ProvisionFailure, 'CONNECTED_OWN_TUNNEL_REQUIRED'):
            cd.sync_server(self.api, self.journal)
        self.assertFalse((self.journal.directory/cd.CLAIM).exists())
        self.assertEqual(self.api.calls, [])

    def test_foreign_portal_env_change_local_auth_and_connector_change_block_before_claim(self):
        foreign = self.remote.app_base+'/foreign'
        self.remote.remote[foreign] = {'id': 'foreign', 'type': 'mcp_portal',
            'domain': self.journal.state['config']['portalHostname'], 'policies': []}
        with self.assertRaises(cp.ProvisionFailure):
            cd.sync_server(self.api, self.journal)
        self.remote.remote.pop(foreign)
        env = self.root/'bridge.env'
        env.write_bytes(b'changed environment')
        env.chmod(0o600)
        with patch.object(ce, 'load_state', return_value={'status': 'LINKED'}), \
                patch.object(ce, 'read_snapshot', return_value=b'expected environment'), patch.object(cc, 'ENV', env):
            with self.assertRaisesRegex(cp.ProvisionFailure, 'ENVIRONMENT_CHANGED_REVIEW_REQUIRED'):
                cd.sync_server(self.api, self.journal)
        with patch.object(cc, 'local_ready', side_effect=cp.ProvisionFailure('LOCAL_HEALTH_OR_AUTH_FAILED')):
            with self.assertRaisesRegex(cp.ProvisionFailure, 'LOCAL_HEALTH_OR_AUTH_FAILED'):
                cd.sync_server(self.api, self.journal)
        self.binary.write_bytes(self.binary_bytes+b'changed')
        with self.assertRaises(cp.ProvisionFailure):
            cd.sync_server(self.api, self.journal)
        self.assertFalse((self.journal.directory/cd.CLAIM).exists())
        self.assertEqual(self.api.calls, [])


if __name__ == '__main__':
    unittest.main()
