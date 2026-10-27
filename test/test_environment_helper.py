"""Synthetic files only. Never uses /etc, systemctl or live credentials."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import socket
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('environment_helper', Path(__file__).resolve().parents[1] / 'helper/environment-helper.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


@unittest.skipUnless(os.name == 'posix', 'Linux file/socket permission contract')
class EditorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='env-helper-')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.env = self.path / 'bridge.env'
        self.original = b'# retain\r\nBRIDGE_ADMIN_TOKEN=synthetic-private\r\nBRIDGE_UI_ENABLED=false\r\n'
        self.env.write_bytes(self.original)
        self.env.chmod(0o600)
        self.scheduled = []
        self.released = []
        self.captured = []
        self.compared = []
        self.editor = helper.Editor(self.env, self.path / 'state', lambda _: None, self.scheduled.append, self.released.append, self.captured.append, self.compared.append)

    def read(self):
        return self.editor.dispatch({'action': 'read'})

    def save(self, changes, revision=None):
        return self.editor.dispatch({'action': 'save', 'expectedRevision': revision or self.read()['revision'], 'changes': changes, 'acknowledged': True})

    def restart(self):
        return self.editor.dispatch({'action': 'restart', 'expectedRevision': self.read()['revision'], 'acknowledged': True, 'maintenanceOwner': 'a' * 64})['restart']['id']

    def test_snapshot_write_only_and_opaque_revision(self):
        value = self.read()
        self.assertNotIn('synthetic-private', json.dumps(value))
        self.assertIn('BRIDGE_ADMIN_TOKEN', value['readOnlyKeys'])
        self.assertEqual(len(value['revision']), 64)
        self.assertEqual(value['revision'], self.read()['revision'])
        key = next(v for v in value['fields'] if v['key'] == 'JEV_API_KEY')
        self.assertNotIn('value', key)

    def test_patch_preserves_backup_unknowns_crlf_and_mode(self):
        result = self.save({'BRIDGE_UI_ENABLED': 'true', 'JEV_API_KEY': 'synthetic-key'})
        self.assertTrue(result['pendingRestart'])
        self.assertNotIn('synthetic-key', json.dumps(result))
        self.assertIn(b'# retain\r\nBRIDGE_ADMIN_TOKEN=synthetic-private\r\n', self.env.read_bytes())
        self.assertEqual((self.path / 'state' / result['backupId']).read_bytes(), self.original)
        self.assertEqual(stat.S_IMODE(self.env.stat().st_mode), 0o600)
        self.save({'BRIDGE_JEV_ENABLED': 'true'})
        self.assertEqual((self.path / 'state/pending.env').read_bytes(), self.original)

    def test_stale_revision_and_manual_change_do_not_overwrite(self):
        old = self.read()['revision']
        self.save({'BRIDGE_UI_ENABLED': 'true'})
        with self.assertRaisesRegex(helper.Refused, 'conflict'):
            self.save({'BRIDGE_UI_ENABLED': 'false'}, old)
        self.env.write_bytes(self.env.read_bytes() + b'# external administrator\r\n')
        with self.assertRaisesRegex(helper.Refused, 'conflict'):
            self.save({'BRIDGE_UI_ENABLED': 'false'})
        with self.assertRaisesRegex(helper.Refused, 'conflict'):
            self.restart()

    def test_path_shell_newline_and_secret_controls_refused(self):
        for changes in [{'NODE_OPTIONS': '--require=evil'}, {'BRIDGE_CONFIG_PATH': '/tmp/evil'}, {'JEV_API_KEY': 'x\nINJECT=true'}, {'BRIDGE_UI_ENABLED': 'yes'}, {'JEV_API_KEY': 'x\\n'}, {'BRIDGE_DISPLAY_NAME': ' leading'}, {'BRIDGE_UI_ENABLED': True}, []]:
            with self.subTest(changes=changes), self.assertRaises(helper.Refused):
                self.save(changes)
        self.assertEqual(self.env.read_bytes(), self.original)

    def test_unicode_line_breaks_and_controls_cannot_poison_saved_env(self):
        for character in ('\u0085', '\u2028', '\u2029', '\u200b', '\x7f'):
            with self.subTest(character=repr(character)), self.assertRaisesRegex(helper.Refused, 'invalid-value'):
                self.save({'JEV_API_KEY': 'synthetic' + character + 'key'})
            self.assertEqual(self.env.read_bytes(), self.original)
            self.assertTrue(self.read()['available'])

    def test_existing_non_lf_separator_is_preserved_or_replaced_as_one_entry(self):
        # Legacy operator-written data still follows the JS loader's LF grammar.
        self.env.write_bytes(self.original + 'JEV_API_KEY=synthetic\u0085key\r\n'.encode())
        self.assertTrue(self.read()['available'])
        self.save({'BRIDGE_UI_ENABLED': 'true'})
        self.assertIn('JEV_API_KEY=synthetic\u0085key\r\n'.encode(), self.env.read_bytes())
        self.save({'JEV_API_KEY': 'synthetic-replaced'})
        self.assertNotIn('\u0085'.encode(), self.env.read_bytes())
        self.assertEqual(helper.entries(self.env.read_bytes())['JEV_API_KEY'], 'synthetic-replaced')

    def test_validation_failure_never_changes_env(self):
        def fail(_):
            raise helper.Refused('validation-failed')
        self.editor.validate = fail
        with self.assertRaises(helper.Refused):
            self.save({'BRIDGE_UI_ENABLED': 'true'})
        self.assertEqual(self.env.read_bytes(), self.original)
        self.assertFalse((self.path / 'state/pending.env').exists())

    def test_external_edit_during_validation_is_preserved(self):
        changed = self.original + b'# external during validation\r\n'
        self.editor.validate = lambda _: self.env.write_bytes(changed)
        with self.assertRaisesRegex(helper.Refused, 'conflict'):
            self.save({'BRIDGE_UI_ENABLED': 'true'})
        self.assertEqual(self.env.read_bytes(), changed)
        self.assertFalse((self.path / 'state/pending.env').exists())

    def test_null_removes_key_and_secret_is_not_returned(self):
        self.save({'JEV_API_KEY': 'synthetic-key'})
        result = self.save({'JEV_API_KEY': None})
        self.assertNotIn(b'JEV_API_KEY=', self.env.read_bytes())
        self.assertFalse(next(v for v in result['fields'] if v['key'] == 'JEV_API_KEY')['configured'])

    def test_symlink_hardlink_fifo_and_public_files_refused(self):
        self.env.chmod(0o644)
        with self.assertRaises(helper.Refused):
            self.read()
        self.env.chmod(0o600)
        os.link(self.env, self.path / 'hardlink')
        with self.assertRaises(helper.Refused):
            self.read()
        os.unlink(self.path / 'hardlink')
        self.env.rename(self.path / 'original')
        self.env.symlink_to(self.path / 'original')
        with self.assertRaises(OSError):
            self.read()
        self.env.unlink()
        os.mkfifo(self.env, 0o600)
        with self.assertRaises(helper.Refused):
            self.read()

    def test_acknowledgement_and_scheduled_job_exclusion(self):
        with self.assertRaises(helper.Refused):
            self.editor.dispatch({'action': 'restart', 'expectedRevision': self.read()['revision']})
        job = self.restart()
        self.assertEqual(self.scheduled, [job])
        with self.assertRaisesRegex(helper.Refused, 'restart-in-progress'):
            self.restart()
        with self.assertRaisesRegex(helper.Refused, 'restart-in-progress'):
            self.save({'BRIDGE_UI_ENABLED': 'true'})

    def test_successful_restart_and_duplicate_job_never_replays(self):
        self.save({'BRIDGE_UI_ENABLED': 'true'})
        job = self.restart()
        calls = []
        self.editor.restart(job, lambda: calls.append(1), lambda _: True)
        self.assertEqual(calls, [1])
        self.assertEqual(self.released, [b'a' * 64])
        self.assertEqual(self.captured, [b'a' * 64])
        self.assertEqual(self.compared, [b'a' * 64])
        self.assertFalse((self.path / 'state' / ('owner-' + job)).exists())
        self.assertEqual(self.read()['restart']['state'], 'healthy')
        self.assertFalse(self.read()['pendingRestart'])
        with self.assertRaises(helper.Refused):
            self.editor.restart(job, lambda: calls.append(2), lambda _: True)
        self.assertEqual(calls, [1])

    def test_failed_start_rolls_back_earliest_env(self):
        self.save({'BRIDGE_UI_ENABLED': 'true'})
        self.save({'JEV_API_KEY': 'synthetic-key'})
        job = self.restart()
        observations = []
        def healthy(data):
            observations.append(data)
            return data == self.original
        calls = []
        self.editor.restart(job, lambda: calls.append(1), healthy)
        self.assertEqual(calls, [1, 1])
        self.assertEqual(self.env.read_bytes(), self.original)
        self.assertEqual(self.read()['restart']['state'], 'rolled-back')
        self.assertFalse(self.read()['pendingRestart'])

    def test_external_edit_after_scheduling_stops_restart(self):
        job = self.restart()
        changed = self.original + b'# external\r\n'
        self.env.write_bytes(changed)
        calls = []
        self.editor.restart(job, lambda: calls.append(1), lambda _: True)
        self.assertFalse(calls)
        self.assertEqual(self.env.read_bytes(), changed)
        self.assertEqual(self.read()['restart']['state'], 'conflict')

    def test_failed_recovery_is_reported_and_backup_preserved(self):
        self.save({'BRIDGE_UI_ENABLED': 'true'})
        job = self.restart()
        self.editor.restart(job, lambda: None, lambda _: False)
        self.assertEqual(self.read()['restart']['state'], 'recovery-failed')
        self.assertTrue(self.read()['pendingRestart'])
        self.assertEqual(self.released, [])
        self.assertTrue((self.path / 'state' / ('owner-' + job)).exists())

    def test_unconfirmed_release_keeps_owner_and_pending_backup(self):
        self.save({'BRIDGE_UI_ENABLED': 'true'})
        job = self.restart()
        def fail(_):
            raise RuntimeError('synthetic response lost')
        self.editor.release = fail
        self.editor.restart(job, lambda: None, lambda _: True)
        self.assertEqual(self.read()['restart']['state'], 'maintenance-release-unconfirmed')
        self.assertTrue((self.path / 'state' / ('owner-' + job)).exists())
        self.assertTrue(self.read()['pendingRestart'])

    def test_unconfirmed_comparison_keeps_owner_and_pending_backup(self):
        self.save({'BRIDGE_UI_ENABLED': 'true'})
        job = self.restart()
        def fail(_):
            raise RuntimeError('synthetic comparison failure')
        self.editor.compare = fail
        self.editor.restart(job, lambda: None, lambda _: True)
        self.assertEqual(self.read()['restart']['state'], 'preservation-compare-unconfirmed')
        self.assertEqual(self.released, [])
        self.assertTrue((self.path / 'state' / ('owner-' + job)).exists())
        self.assertTrue(self.read()['pendingRestart'])

    def test_unconfirmed_capture_never_restarts_or_releases(self):
        job = self.restart()
        calls = []
        def fail(_):
            raise RuntimeError('synthetic capture failure')
        self.editor.capture = fail
        self.editor.restart(job, lambda: calls.append(1), lambda _: True)
        self.assertEqual(self.read()['restart']['state'], 'preservation-capture-unconfirmed')
        self.assertEqual(calls, [])
        self.assertEqual(self.released, [])
        self.assertTrue((self.path / 'state' / ('owner-' + job)).exists())

    def test_plain_restart_failure_does_not_claim_env_recovery(self):
        job = self.restart()
        self.editor.restart(job, lambda: None, lambda _: False)
        self.assertEqual(self.read()['restart']['state'], 'failed')
        self.assertEqual(self.env.read_bytes(), self.original)

    def test_scheduler_failure_does_not_claim_restart(self):
        def fail(_):
            raise RuntimeError('synthetic-private error')
        self.editor.scheduler = fail
        with self.assertRaisesRegex(helper.Refused, 'schedule-failed'):
            self.restart()
        self.assertEqual(self.read()['restart']['state'], 'schedule-failed')
        self.assertEqual(self.env.read_bytes(), self.original)

    def test_status_read_does_not_wait_for_restart_mutation_lock(self):
        import fcntl
        self.read()
        with open(self.path / 'state/lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            self.assertTrue(self.read()['available'])


@unittest.skipUnless(os.getenv('SSH_ENV_NATIVE_FIXTURE') == '1' and Path('/.dockerenv').exists(), 'isolated root container only')
class NativeSocketTests(unittest.TestCase):
    """Production main, actual peer credentials, fixed paths in disposable container."""
    def test_root_broker_and_peer_boundary(self):
        import pwd
        import shutil
        source = Path(__file__).resolve().parents[1]
        try:
            account = pwd.getpwnam('mcpbridge')
        except KeyError:
            subprocess.run(['useradd', '--system', 'mcpbridge'], check=True)
            account = pwd.getpwnam('mcpbridge')
        helper.ROOT.mkdir(mode=0o700, exist_ok=True)
        helper.ROOT.chmod(0o700)
        helper.ENV.write_text('BRIDGE_MCP_TOKEN=synthetic-mcp\nBRIDGE_ADMIN_TOKEN=synthetic-admin\nBRIDGE_UI_TICKET_KEY=' + 'a' * 64 + '\nBRIDGE_ADMIN_ORIGIN=https://owner.test\nJEV_API_KEY=synthetic-old-key\n')
        helper.ENV.chmod(0o600)
        active = Path('/var/lib/ssh-mcp/app/approval-bridge')
        active.parent.mkdir(parents=True, exist_ok=True)
        if active.is_symlink():
            active.unlink()
        if not active.exists():
            active.symlink_to(source, target_is_directory=True)
        Path(helper.HELPER).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / 'helper/environment-helper.py', helper.HELPER)
        os.chmod(helper.HELPER, 0o755)
        units = Path('/etc/systemd/system')
        for name in ('ssh-approval-env.socket', 'ssh-approval-env@.service'):
            shutil.copyfile(source / 'config' / name, units / name)
            (units / name).chmod(0o644)
        subprocess.run(['systemd-analyze', 'verify', str(units / 'ssh-approval-env.socket'), str(units / 'ssh-approval-env@.service')], check=True, stdout=subprocess.DEVNULL)
        with tempfile.TemporaryDirectory(prefix='env-native-') as directory:
            os.chmod(directory, 0o755)
            name = str(Path(directory) / 'broker.sock')
            listener = socket.socket(socket.AF_UNIX)
            self.addCleanup(listener.close)
            listener.bind(name)
            os.chown(name, account.pw_uid, account.pw_gid)
            os.chmod(name, 0o600)
            listener.listen(2)
            listener.settimeout(10)

            def invoke(request, uid=account.pw_uid):
                # Synthetic payload via stdin, never process arguments.
                client = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--broker-client', name], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, preexec_fn=lambda: os.setuid(uid))
                client.stdin.write(json.dumps(request).encode())
                client.stdin.close()
                peer, _ = listener.accept()
                try:
                    worker = subprocess.Popen(['/usr/bin/python3', '-I', helper.HELPER], stdin=peer, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    worker.wait(timeout=15)
                finally:
                    peer.close()
                output = client.stdout.read()
                client.wait(timeout=10)
                client.stdout.close()
                client.stderr.close()
                return worker.returncode, output

            code, raw = invoke({'action': 'read'})
            self.assertEqual(code, 0)
            self.assertNotIn(b'synthetic-old-key', raw)
            before = json.loads(raw)
            code, raw = invoke({'action': 'save', 'expectedRevision': before['revision'], 'acknowledged': True, 'changes': {'JEV_API_KEY': 'synthetic-new-key', 'BRIDGE_UI_ENABLED': 'true'}})
            self.assertEqual(code, 0)
            result = json.loads(raw)
            self.assertTrue(result['saved'])
            self.assertNotIn(b'synthetic-new-key', raw)
            self.assertIn(b'JEV_API_KEY=synthetic-new-key', helper.ENV.read_bytes())
            # Runtime validator really rejects malformed upload hosts before writing.
            code, raw = invoke({'action': 'save', 'expectedRevision': result['revision'], 'acknowledged': True, 'changes': {'BRIDGE_UPLOAD_SOURCE_HOSTS': '*'}})
            self.assertEqual(json.loads(raw), {'error': 'validation-failed'})
            saved = helper.ENV.read_bytes()
            for character in ('\u0085', '\u2028', '\u2029'):
                code, raw = invoke({'action': 'save', 'expectedRevision': result['revision'], 'acknowledged': True, 'changes': {'JEV_API_KEY': 'synthetic' + character + 'key'}})
                self.assertEqual(json.loads(raw), {'error': 'invalid-value'})
                self.assertEqual(helper.ENV.read_bytes(), saved)
            code, raw = invoke({'action': 'read'}, uid=0)
            self.assertNotEqual(code, 0)
            self.assertFalse(raw)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--broker-client':
        client = socket.socket(socket.AF_UNIX)
        client.settimeout(15)
        client.connect(sys.argv[2])
        client.sendall(sys.stdin.buffer.read() + b'\n')
        try:
            reply = bytearray()
            while b'\n' not in reply:
                part = client.recv(4096)
                if not part:
                    break
                reply.extend(part)
            sys.stdout.buffer.write(reply)
        except ConnectionResetError:
            pass
        finally:
            client.close()
    else:
        unittest.main()
