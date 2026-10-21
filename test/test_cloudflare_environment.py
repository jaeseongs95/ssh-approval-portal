import contextlib
import copy
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
import cloudflare_connector as cc
import cloudflare_environment as ce
import cloudflare_provision as cp
import cloudflare_setup as cf
import portal
import test_cloudflare_connector as connector_tests
from test_cloudflare_connector import TokenAccount
from test_cloudflare_provision import config, SECRET
from settings_contract import parse_env


class Portable(unittest.TestCase):
    def test_explicit_flags_dry_run_and_nonroot_never_open_state_or_prompt(self):
        for flag in ['--link-environment', '--restore-environment']:
            with patch.object(cf, 'main', return_value=0) as child:
                self.assertEqual(portal.main(['connect', 'cloudflare', flag, '--state-dir', '/root/new']), 0)
                self.assertEqual(child.call_args.args[0], [flag, '--state-dir', '/root/new'])
            with patch.object(cf.getpass, 'getpass') as secret, patch.object(cp, 'Journal') as journal, \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(cf.main([flag, '--state-dir', '/root/new', '--dry-run']), 0)
                self.assertEqual(json.loads(out.getvalue())['operation'], flag[2:])
                secret.assert_not_called()
                journal.assert_not_called()
            with patch.object(cf.sys, 'platform', 'linux'), patch.object(cf.sys.stdin, 'isatty', return_value=True), \
                    patch.object(cf.sys.stderr, 'isatty', return_value=True), patch.object(cf.os, 'geteuid', return_value=1000, create=True), \
                    patch.object(cf.getpass, 'getpass') as secret, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(cf.main([flag, '--state-dir', '/root/new']), 1)
                secret.assert_not_called()

    def test_restore_cli_requires_no_cloudflare_api_token_or_remote_client(self):
        with patch.object(cf.sys, 'platform', 'linux'), patch.object(cf.sys.stdin, 'isatty', return_value=True), \
                patch.object(cf.sys.stderr, 'isatty', return_value=True), patch.object(cf.os, 'geteuid', return_value=0, create=True), \
                patch.object(cf.getpass, 'getpass') as secret, patch.object(cf, 'CloudflareApi') as api, \
                patch.object(cp, 'Journal'), patch.object(ce, 'restore_environment', return_value={'status': 'ENVIRONMENT_RESTORED'}) as restore, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cf.main(['--restore-environment', '--state-dir', '/root/owned']), 0)
            secret.assert_not_called()
            api.assert_not_called()
            restore.assert_called_once()


class AudienceAccount(TokenAccount):
    def change(self, method, path, body=None):
        result = super().change(method, path, body)
        if method == 'POST' and path.endswith('/access/apps'):
            result['result']['aud'] = 'c'*64
            self.remote[path+'/'+result['result']['id']]['aud'] = 'c'*64
        return result


@unittest.skipUnless(sys.platform.startswith('linux') and hasattr(os, 'geteuid') and os.geteuid() == 0,
                     'isolated Linux root filesystem fixture required')
class Filesystem(unittest.TestCase):
    def setUp(self):
        with patch.object(connector_tests, 'TokenAccount', AudienceAccount):
            connector_tests.Filesystem.setUp(self)
        cc.install_connector(self.api, self.journal, str(self.binary))
        self.env = self.root/'bridge.env'
        self.original = (f'# original\nBRIDGE_ADMIN_TOKEN={SECRET}\nBRIDGE_UI_ENABLED=true\n'
                         'BRIDGE_ADMIN_AUTH_MODE=token\n').encode()
        self.env.write_bytes(self.original)
        self.env.chmod(0o600)
        self.applied = (f'# original\nBRIDGE_ADMIN_TOKEN={SECRET}\nBRIDGE_UI_ENABLED=true\n\n'
                        'BRIDGE_ADMIN_AUTH_MODE=access\nBRIDGE_ACCESS_TEAM_DOMAIN=https://fixture.cloudflareaccess.com\n'
                        'BRIDGE_ACCESS_AUD='+'c'*64+'\nBRIDGE_ACCESS_OWNER_EMAILS=owner@example.test\n').encode()
        self.calls = []
        self.failure = self.race = None
        for item in [patch.object(cc, 'ENV', self.env), patch.object(ce, 'run_access', side_effect=self.helper)]:
            item.start()
            self.addCleanup(item.stop)

    def helper(self, values, restore=False, stage=None):
        self.calls.append({'restore': restore, 'stage': stage is not None})
        state = ce.load_state(self.journal)
        if stage is not None:
            self.assertEqual(state['status'], 'ORIGINAL_READY')
            self.assertEqual(values, {'expected': self.original.decode(), 'values': {
                'BRIDGE_ACCESS_TEAM_DOMAIN': 'https://fixture.cloudflareaccess.com', 'BRIDGE_ACCESS_AUD': 'c'*64,
                'BRIDGE_ACCESS_OWNER_EMAILS': 'owner@example.test'}})
            cc.create_file(stage, self.applied, 0o600)
            return
        self.assertEqual(state['status'], 'RESTORE_REQUESTED' if restore else 'APPLY_REQUESTED')
        if self.failure:
            raise cp.ProvisionFailure(self.failure)
        if self.race:
            self.env.write_bytes(self.race)
        expected = values['expected'].encode()
        if self.env.read_bytes() != expected:
            raise cp.ProvisionFailure('ENVIRONMENT_CHANGED_DURING_SETUP')
        self.env.write_bytes(values['original'].encode() if restore else self.applied)

    def test_link_restore_actual_private_files_preserve_bytes_and_block_connector_cleanup(self):
        writes = copy.deepcopy(self.api.writes)
        result = ce.link_environment(self.api, self.journal)
        self.assertEqual(result, {'status': 'ENVIRONMENT_LINKED', 'environmentLinked': True, 'loginVerified': False})
        self.assertEqual(self.env.read_bytes(), self.applied)
        for name in [ce.ORIGINAL, ce.APPLIED]:
            self.assertEqual((self.journal.directory/name).stat().st_mode & 0o777, 0o600)
        self.assertNotIn(SECRET, (self.journal.directory/'environment.json').read_text())
        before = len(self.systemd.calls)
        for operation in [lambda: cc.remove_connector(self.journal), lambda: cp.cleanup(self.api, self.journal)]:
            with self.assertRaisesRegex(cp.ProvisionFailure, 'RESTORE_ENVIRONMENT_FIRST'):
                operation()
        self.assertEqual(len(self.systemd.calls), before)
        self.assertEqual(ce.restore_environment(self.journal)['status'], 'ENVIRONMENT_RESTORED')
        self.assertEqual(self.env.read_bytes(), self.original)
        self.assertEqual(len(self.calls), 3)
        ce.restore_environment(self.journal)
        self.assertEqual(len(self.calls), 3, 'confirmed restoration does not restart again')
        self.assertEqual(self.api.writes, writes, 'ENV link/restoration never writes Cloudflare resources')
        cc.remove_connector(self.journal)
        cp.cleanup(self.api, self.journal)

    def test_later_admin_change_and_replaced_snapshot_are_never_overwritten(self):
        ce.link_environment(self.api, self.journal)
        changed = self.applied+b'# later administrator change\n'
        self.env.write_bytes(changed)
        with self.assertRaisesRegex(cp.ProvisionFailure, 'CHANGED_AFTER_SETUP'):
            ce.restore_environment(self.journal)
        self.assertEqual(self.env.read_bytes(), changed)
        self.assertEqual(len(self.calls), 2)
        self.env.write_bytes(self.applied)
        (self.journal.directory/ce.ORIGINAL).write_bytes(b'changed private snapshot')
        with self.assertRaisesRegex(cp.ProvisionFailure, 'SNAPSHOT_CHANGED'):
            ce.restore_environment(self.journal)
        self.assertEqual(self.env.read_bytes(), self.applied)

    def test_failed_or_unknown_apply_cannot_be_replayed_or_automatically_restored(self):
        self.failure = 'ENVIRONMENT_ACTION_UNCERTAIN'
        with self.assertRaisesRegex(cp.ProvisionFailure, 'UNCERTAIN'):
            ce.link_environment(self.api, self.journal)
        self.assertEqual(ce.load_state(self.journal)['status'], 'APPLY_REQUESTED')
        with self.assertRaisesRegex(cp.ProvisionFailure, 'ALREADY_RECORDED'):
            ce.link_environment(self.api, self.journal)
        with self.assertRaisesRegex(cp.ProvisionFailure, 'RECONCILIATION_REQUIRED'):
            ce.restore_environment(self.journal)
        self.assertEqual(self.env.read_bytes(), self.original)
        self.assertEqual(len(self.calls), 2)

    def test_compare_guard_rejects_setup_race_without_overwriting_latest_env(self):
        self.race = self.original+b'# concurrent change\n'
        with self.assertRaisesRegex(cp.ProvisionFailure, 'CHANGED_DURING_SETUP'):
            ce.link_environment(self.api, self.journal)
        self.assertEqual(self.env.read_bytes(), self.race)
        self.assertEqual(ce.load_state(self.journal)['status'], 'APPLY_REQUESTED')

    def test_failed_restore_is_not_replayed_and_does_not_unlock_connector_cleanup(self):
        ce.link_environment(self.api, self.journal)
        self.failure = 'ENVIRONMENT_ACTION_FAILED_REVIEW_REQUIRED'
        with self.assertRaisesRegex(cp.ProvisionFailure, 'ACTION_FAILED'):
            ce.restore_environment(self.journal)
        self.assertEqual(ce.load_state(self.journal)['status'], 'RESTORE_REQUESTED')
        self.assertEqual(self.env.read_bytes(), self.applied)
        count = len(self.calls)
        with self.assertRaisesRegex(cp.ProvisionFailure, 'RECONCILIATION_REQUIRED'):
            ce.restore_environment(self.journal)
        with self.assertRaisesRegex(cp.ProvisionFailure, 'RESTORE_ENVIRONMENT_FIRST'):
            cc.remove_connector(self.journal)
        self.assertEqual(len(self.calls), count)

    def test_zero_exit_without_expected_env_is_not_linked(self):
        def no_write(values, restore=False, stage=None):
            if stage is not None:
                return self.helper(values, restore, stage)
        with patch.object(ce, 'run_access', side_effect=no_write), self.assertRaisesRegex(cp.ProvisionFailure, 'APPLY_NOT_CONFIRMED'):
            ce.link_environment(self.api, self.journal)
        self.assertEqual(ce.load_state(self.journal)['status'], 'APPLY_REQUESTED')
        self.assertEqual(self.env.read_bytes(), self.original)

    def test_changed_access_policy_or_missing_audience_never_starts_environment_transaction(self):
        admin = next(x for x in self.journal.state['resources'] if x['kind'] == 'admin-access')
        self.api.remote[cp.resource_path(config(), admin)]['policies'] = []
        with self.assertRaisesRegex(cp.ProvisionFailure, 'RESOURCE_CHANGED'):
            ce.link_environment(self.api, self.journal)
        self.assertFalse(self.calls)
        self.assertIsNone(ce.load_state(self.journal))
        self.api.remote[cp.resource_path(config(), admin)] = copy.deepcopy(admin['guard'])
        del admin['guard']['aud']
        del self.api.remote[cp.resource_path(config(), admin)]['aud']
        with self.assertRaisesRegex(cp.ProvisionFailure, 'ACCESS_CONFIGURATION_REQUIRED'):
            ce.link_environment(self.api, self.journal)
        self.assertEqual(self.env.read_bytes(), self.original)

    def test_changed_active_unit_is_rejected_before_any_environment_record(self):
        state = cc.load_state(self.journal)
        unit = self.units/state['unit']
        unit.write_bytes(unit.read_bytes()+b'# unrelated replacement\n')
        with self.assertRaisesRegex(cp.ProvisionFailure, 'ACTIVE_OWN_CONNECTOR_REQUIRED'):
            ce.link_environment(self.api, self.journal)
        self.assertIsNone(ce.load_state(self.journal))
        self.assertFalse(self.calls)
        self.assertEqual(self.env.read_bytes(), self.original)


@unittest.skipUnless(os.environ.get('CLOUDFLARE_ENV_NATIVE_FIXTURE') == '1' and sys.platform.startswith('linux'),
                     'explicit disposable native ENV transaction fixture required')
class NativeHelper(unittest.TestCase):
    """Real shell/Node/files; simulated service manager and loopback bridge endpoints."""
    @classmethod
    def setUpClass(cls):
        assert os.geteuid() == 0 and Path('/.dockerenv').is_file()
        mounts = Path('/proc/self/mountinfo').read_text().splitlines()
        for directory in ['/etc', '/run', '/var/lib/ssh-mcp']:
            assert any(line.split()[4] == directory and ' - tmpfs ' in line for line in mounts)
        cls.base = Path('/var/lib/ssh-mcp/app')
        assert not cls.base.exists(), 'never adopt an existing native installation'
        cls.release = cls.base/'releases/env-fixture'
        shutil.copytree('/package-source', cls.release)
        if not (cls.release/'node_modules/jose').exists():
            shutil.copytree('/work/node_modules/jose', cls.release/'node_modules/jose')
        for path in [cls.release, *cls.release.rglob('*')]:
            assert not path.is_symlink()
            path.chmod(0o750 if path.is_dir() else 0o640)
        ce.ACTIVE.symlink_to(cls.release)

    @classmethod
    def tearDownClass(cls):
        assert ce.ACTIVE.is_symlink() and ce.ACTIVE.resolve() == cls.release
        ce.ACTIVE.unlink()
        assert cls.base.resolve() == Path('/var/lib/ssh-mcp/app') and not cls.base.is_symlink()
        shutil.rmtree(cls.base)

    def setUp(self):
        self.flags = Path('/fixture/env-native-flags')
        self.flags.mkdir(mode=0o700)
        self.addCleanup(shutil.rmtree, self.flags)
        self.temp = tempfile.TemporaryDirectory(prefix='env-native-', dir='/fixture')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.events = []
        self.command_results = []
        real_run = subprocess.run
        def capture(args, **kwargs):
            result = real_run(args, **{**kwargs, 'stdout': subprocess.PIPE, 'stderr': subprocess.PIPE})
            self.assertNotIn(SECRET.encode(), result.stdout+result.stderr)
            self.command_results.append({'code': result.returncode, 'stdout': result.stdout.decode(), 'stderr': result.stderr.decode()})
            return result
        runner_patch = patch.object(ce.subprocess, 'run', side_effect=capture)
        runner_patch.start()
        self.addCleanup(runner_patch.stop)
        self.addCleanup(lambda: print(json.dumps({'case': self._testMethodName, 'commands': self.command_results})))
        parent = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def reply(self, code, value):
                self.send_response(code)
                self.end_headers()
                self.wfile.write(json.dumps(value).encode())
            def do_GET(self):
                values = parse_env(cc.ENV.read_text())
                mode = values.get('BRIDGE_ADMIN_AUTH_MODE') or 'token'
                if self.server.role == 'mcp' and self.path == '/health':
                    return self.reply(200, {'healthy': True, 'adminAuthMode': mode})
                if self.server.role == 'admin' and self.path == '/api/session':
                    bad = (parent.flags/('bad-'+mode+'-session')).exists()
                    return self.reply(200 if mode == 'token' or bad else 401, {'mode': mode})
                if self.server.role == 'admin' and self.path == '/api/requests':
                    bad = (parent.flags/('bad-'+mode+'-requests')).exists()
                    return self.reply(200 if bad else 401, {})
                self.reply(404, {})
            def do_POST(self):
                values = parse_env(cc.ENV.read_text())
                if (self.server.role != 'admin' or self.headers.get('Authorization') != 'Bearer '+values['BRIDGE_ADMIN_TOKEN']
                        or self.headers.get('Origin') != values['BRIDGE_ADMIN_ORIGIN']):
                    return self.reply(403, {})
                action = self.path.rsplit('/', 1)[-1]
                if self.path not in ['/api/maintenance/reserve', '/api/maintenance/release']:
                    return self.reply(404, {})
                denied = action == 'reserve' and (parent.flags/'deny-reserve').exists()
                if action == 'reserve' and (parent.flags/'edit-on-reserve').exists():
                    (parent.flags/'edit-on-reserve').unlink()
                    cc.ENV.write_bytes(cc.ENV.read_bytes()+b'# independent reserve edit\n')
                parent.events.append((action, 409 if denied else 200))
                self.reply(409 if denied else 200, {'reserved' if action == 'reserve' else 'released': not denied})
        servers = [ThreadingHTTPServer(('127.0.0.1', 0), Handler) for _ in range(2)]
        for server, role in zip(servers, ['mcp', 'admin']):
            server.role = role
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(thread.join, 3)
            self.addCleanup(server.shutdown)
        self.original = (f'# 한글 원본\nBRIDGE_MCP_TOKEN=synthetic-native-mcp\nBRIDGE_ADMIN_TOKEN={SECRET}\n'
                         'BRIDGE_ADMIN_ORIGIN=https://approve.example.test\nBRIDGE_UI_ENABLED=true\n'
                         f'BRIDGE_MCP_PORT={servers[0].server_port}\nBRIDGE_ADMIN_PORT={servers[1].server_port}\n'
                         'BRIDGE_ACCESS_OWNER_EMAILS=\n').encode()
        self.assertEqual(cc.ENV, Path('/etc/ssh-mcp-approval-bridge.env'))
        self.assertFalse(cc.ENV.exists())
        cc.create_file(cc.ENV, self.original, 0o600)
        self.backups_before = set(Path('/etc').glob('ssh-mcp-approval-bridge.env.before-access.*'))
        self.addCleanup(self.clean_env)
        self.values = {'BRIDGE_ACCESS_TEAM_DOMAIN': 'https://fixture.cloudflareaccess.com',
                       'BRIDGE_ACCESS_AUD': 'c'*64, 'BRIDGE_ACCESS_OWNER_EMAILS': 'owner@example.test'}

    def clean_env(self):
        if cc.ENV.exists():
            self.assertFalse(cc.ENV.is_symlink())
            cc.ENV.unlink()
        for path in set(Path('/etc').glob('ssh-mcp-approval-bridge.env.before-access.*')) - self.backups_before:
            self.assertFalse(path.is_symlink())
            path.unlink()

    def stage(self):
        self.payload = {'expected': self.original.decode(), 'values': self.values}
        ce.run_access(self.payload, stage=self.root/'applied.env')
        return (self.root/'applied.env').read_bytes()

    def restart_calls(self):
        file = self.flags/'service-events.jsonl'
        return [json.loads(line)[0] for line in file.read_text().splitlines()].count('restart') if file.exists() else 0

    def test_real_shell_link_restore_backups_and_private_files_preserve_exact_original(self):
        applied = self.stage()
        ce.run_access(self.payload)
        self.assertEqual(cc.ENV.read_bytes(), applied)
        self.assertEqual(cc.ENV.stat().st_mode & 0o777, 0o600)
        ce.run_access({'expected': applied.decode(), 'original': self.original.decode()}, restore=True)
        self.assertEqual(cc.ENV.read_bytes(), self.original)
        self.assertEqual(self.restart_calls(), 2)
        self.assertEqual(self.events, [('reserve', 200), ('release', 200)]*2)
        backups = set(Path('/etc').glob('ssh-mcp-approval-bridge.env.before-access.*')) - self.backups_before
        self.assertEqual(sorted(path.read_bytes() for path in backups), sorted([self.original, applied]))
        self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in backups))

    def test_reservation_denial_is_before_live_write_backup_or_restart(self):
        self.stage()
        (self.flags/'deny-reserve').touch()
        with self.assertRaisesRegex(cp.ProvisionFailure, 'ACTION_FAILED'):
            ce.run_access(self.payload)
        self.assertEqual(cc.ENV.read_bytes(), self.original)
        self.assertEqual(self.restart_calls(), 0)
        self.assertEqual(self.events, [('reserve', 409)])
        self.assertEqual(set(Path('/etc').glob('ssh-mcp-approval-bridge.env.before-access.*')), self.backups_before)

    def test_restart_failure_restores_backup_and_releases_reservation(self):
        self.stage()
        (self.flags/'fail-next-restart').touch()
        with self.assertRaisesRegex(cp.ProvisionFailure, 'ACTION_FAILED'):
            ce.run_access(self.payload)
        self.assertEqual(cc.ENV.read_bytes(), self.original)
        self.assertEqual(self.restart_calls(), 2, 'failed restart followed by recovery restart')
        self.assertEqual(self.events, [('reserve', 200), ('release', 200)])

    def test_owner_edit_during_reservation_is_preserved_before_any_live_replace(self):
        self.stage()
        (self.flags/'edit-on-reserve').touch()
        with self.assertRaisesRegex(cp.ProvisionFailure, 'ACTION_FAILED'):
            ce.run_access(self.payload)
        self.assertEqual(cc.ENV.read_bytes(), self.original+b'# independent reserve edit\n')
        self.assertEqual(self.restart_calls(), 0)
        self.assertEqual(self.events, [('reserve', 200), ('release', 200)])

    def test_owner_edit_during_failed_restart_is_not_overwritten_by_recovery(self):
        applied = self.stage()
        (self.flags/'edit-on-restart').touch()
        (self.flags/'fail-next-restart').touch()
        with self.assertRaisesRegex(cp.ProvisionFailure, 'ACTION_FAILED'):
            ce.run_access(self.payload)
        self.assertEqual(cc.ENV.read_bytes(), applied+b'# independent restart edit\n')
        self.assertEqual(self.restart_calls(), 1, 'independently edited ENV requires manual recovery')
        self.assertEqual(self.events, [('reserve', 200), ('release', 200)])

    def test_auth_smoke_failure_restores_original_settings(self):
        self.stage()
        (self.flags/'bad-access-session').touch()
        with self.assertRaisesRegex(cp.ProvisionFailure, 'ACTION_FAILED'):
            ce.run_access(self.payload)
        self.assertEqual(cc.ENV.read_bytes(), self.original)
        self.assertEqual(self.restart_calls(), 2)
        self.assertEqual(self.events, [('reserve', 200), ('release', 200)])

    def test_term_during_restart_recovers_original_and_releases_reservation(self):
        self.stage()
        (self.flags/'block-next-restart').touch()
        child = subprocess.Popen(['/usr/bin/bash', str(ce.ACTIVE/'scripts/configure-admin-access.sh'), '--link-owned-access'],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, start_new_session=True)
        try:
            child.stdin.write(json.dumps(self.payload).encode())
            child.stdin.close()
            for _ in range(200):
                if (self.flags/'restart-blocked').exists() or child.poll() is not None:
                    break
                time.sleep(0.05)
            self.assertTrue((self.flags/'restart-blocked').exists(), 'owned helper must reach the changed/restart boundary')
            self.assertEqual(cc.ENV.read_bytes(), (self.root/'applied.env').read_bytes())
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=20)
            stdout, stderr = child.stdout.read(), child.stderr.read()
            self.assertEqual(child.returncode, 130)
            self.assertNotIn(SECRET.encode(), stdout+stderr)
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)
            child.stdout.close()
            child.stderr.close()
        self.assertEqual(cc.ENV.read_bytes(), self.original)
        self.assertEqual(self.restart_calls(), 2)
        self.assertEqual(self.events, [('reserve', 200), ('release', 200)])


if __name__ == '__main__':
    unittest.main()
