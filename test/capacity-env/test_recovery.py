"""복구 실행기의 실제 임시 ENV I/O와 대체된 systemd/HTTP 경계 시험."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import types
import unittest
import test_env_change as env_fixture

HERE = Path(__file__).resolve().parent


class Recovery(unittest.TestCase):
    def fixture(self, *, state='failed', job='failed', owner=True, unknown=False, restart_failure=False):
        files = env_fixture.EnvFiles('test_private_backup_and_reverse_replacement_restore_exact_bytes')
        files.setUp()
        self.addCleanup(files.doCleanups)
        directory, root = files.directory, files.scope['ROOT']
        old, new = directory / 'old', directory / 'new'
        old.mkdir()
        new.mkdir()
        for path in (old, new):
            (path / 'release-manifest.json').write_bytes(path.name.encode())
        cfg = {'old_manifest': hashlib.sha256(b'old').hexdigest(), 'new_manifest': hashlib.sha256(b'new').hexdigest(), 'env_sha': hashlib.sha256(files.before).hexdigest(), 'old_version': '1.6.4'}
        config = json.dumps(cfg).encode()
        activation = b'# fixture activation boundary\n'
        (root / 'config.json').write_bytes(config)
        (root / 'activate.py').write_bytes(activation)
        (root / 'owner').write_bytes(b'a' * 64)
        (root / 'receipt.json').write_text(json.dumps({'status': 'NEEDS_REVIEW', 'phase': 'restart'}), encoding='utf-8')
        files.scope['private_backup'](files.before)
        files.scope['replace_env'](files.before, files.after, files.metadata())
        actual = {'link': str(new), 'state': state, 'instance': 'a' * 32, 'released': False}
        calls = []
        def run(argv, **kwargs):
            if argv[0] == '/usr/bin/systemctl':
                if argv[1] == 'restart':
                    calls.append('restart')
                    if restart_failure:
                        raise RuntimeError('fixture restart failed')
                    actual.update(state='active', instance='b' * 32)
                    return ''
                if unknown:
                    raise RuntimeError('fixture systemctl query failed')
                is_job = argv[2] == 'test-request-capacity-20261030-r1.service'
                current = job if is_job else actual['state']
                sub = {'active': 'running', 'failed': 'failed', 'inactive': 'dead'}.get(current, 'unknown')
                pid = '123' if current == 'active' else '0'
                return f'LoadState=loaded\nActiveState={current}\nSubState={sub}\nMainPID={pid}\nInvocationID={actual["instance"]}\n'
            action = argv[-1]
            if action == 'status':
                calls.append('status')
                return 'reserved\n' if owner else 'unknown\n'
            if action == 'compare':
                calls.append('compare')
                return json.dumps({'outputsUnavailable': 0, 'expiredOutputsRemoved': 0}) + '\nMaintenance compare confirmed\n'
            if action == 'release-verified':
                calls.append('release-verified')
                actual['released'] = True
            return ''
        def instance_id():
            calls.append('instance-id')
            if actual['state'] != 'active':
                raise RuntimeError('bridge not active')
            return actual['instance']
        def health(maintenance, version):
            self.assertEqual((actual['state'], actual['released']), ('active', not maintenance))
            calls.append('health')
        class Active:
            def is_symlink(self): return True
        active = Active()
        def activate(active_arg, expected, target, verify):
            verify()
            if actual['link'] != str(expected):
                raise RuntimeError('fixture link changed')
            actual['link'] = str(target)
            calls.append('restore-code')
        updater = types.SimpleNamespace(installer_lock=lambda _: contextlib.nullcontext(), activate_release=activate)
        util = types.SimpleNamespace(spec_from_file_location=lambda *args: types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda _: None)), module_from_spec=lambda _: updater)
        proxy = types.SimpleNamespace(**{key: getattr(os, key) for key in dir(os)})
        proxy.O_NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)
        proxy.geteuid = lambda: 0
        proxy.readlink = lambda _: actual['link']
        class PrivateRoot(type(root)):
            def lstat(self):
                if str(self) == str(root):
                    return types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0, st_gid=0)
                return super().lstat()
        source = (HERE / 'recover.py.in').read_text(encoding='utf-8').replace('<CONFIG_SHA>', hashlib.sha256(config).hexdigest()).replace('<ACTIVATE_SHA>', hashlib.sha256(activation).hexdigest())
        scope = {'__name__': 'recovery_fixture'}
        exec(compile(source, 'recover.py.in', 'exec'), scope)
        scope.update(ROOT=PrivateRoot(root), os=proxy, socket=types.SimpleNamespace(gethostname=lambda: 'ip-172-26-6-103'), importlib=types.SimpleNamespace(util=util), time=types.SimpleNamespace(sleep=lambda _: None))
        scope['private'] = lambda path: Path(path).read_bytes()  # root-private 메타데이터는 별도 POSIX 시험 담당
        activation_scope = {**files.scope, 'SRC': directory / 'source', 'OLD': old, 'NEW': new, 'ACTIVE': active, 'NODE': 'node', 'run': run, 'instance_id': instance_id, 'health': health, 'sha256': lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()}
        scope['exec'] = lambda code, destination: destination.update(activation_scope)
        def offline(scope_arg, owner_arg):
            calls.append('offline-owner')
            if not owner:
                raise RuntimeError('offline maintenance ownership or baseline mismatch')
        scope['offline_reserved'] = offline
        return scope, files, root, old, new, actual, calls

    def test_failed_and_inactive_restore_then_restart_and_verify(self):
        for state in ('failed', 'inactive'):
            with self.subTest(state=state):
                scope, files, root, old, _, actual, calls = self.fixture(state=state)
                scope['main']()
                self.assertEqual(files.path.read_bytes(), files.before)
                self.assertEqual(actual['link'], str(old))
                self.assertLess(calls.index('restore-code'), calls.index('restart'))
                self.assertLess(calls.index('restart'), calls.index('instance-id'))
                self.assertLess(calls.index('compare'), calls.index('release-verified'))
                self.assertEqual(json.loads((root / 'recovery-receipt.json').read_text())['status'], 'ROLLED_BACK_VERIFIED')

    def test_active_service_preserves_existing_recovery_path(self):
        scope, files, root, old, _, actual, calls = self.fixture(state='active')
        scope['main']()
        self.assertIn('status', calls)
        self.assertNotIn('offline-owner', calls)
        self.assertEqual((actual['link'], files.path.read_bytes()), (str(old), files.before))

    def test_unknown_service_or_query_failure_refuses_before_write(self):
        for kwargs in ({'state': 'activating'}, {'unknown': True}):
            with self.subTest(kwargs=kwargs):
                scope, files, root, _, new, actual, calls = self.fixture(**kwargs)
                with self.assertRaises(RuntimeError):
                    scope['main']()
                self.assertEqual((actual['link'], files.path.read_bytes()), (str(new), files.after))
                self.assertNotIn('restart', calls)
                self.assertFalse((root / 'recovery.claim').exists())

    def test_original_job_active_owner_mismatch_or_foreign_env_refuses(self):
        for defect in ('active-job', 'unknown-job', 'owner', 'foreign-env'):
            with self.subTest(defect=defect):
                scope, files, root, _, new, actual, calls = self.fixture(job='active' if defect == 'active-job' else 'unknown' if defect == 'unknown-job' else 'failed', owner=defect != 'owner')
                expected = files.after
                if defect == 'foreign-env':
                    expected = b'A=foreign\n'
                    files.path.write_bytes(expected)
                with self.assertRaises(RuntimeError):
                    scope['main']()
                self.assertEqual((actual['link'], files.path.read_bytes()), (str(new), expected))
                self.assertNotIn('restart', calls)
                self.assertFalse((root / 'recovery.claim').exists())

    def test_claim_after_failure_forbids_resubmission(self):
        scope, _, root, _, _, _, calls = self.fixture(restart_failure=True)
        with self.assertRaisesRegex(RuntimeError, 'fixture restart failed'):
            scope['main']()
        self.assertTrue((root / 'recovery.claim').exists())
        with self.assertRaises(FileExistsError):
            scope['main']()
        self.assertEqual(calls.count('restart'), 1)


class OfflineReservation(unittest.TestCase):
    def test_readonly_database_owner_and_baseline_checks(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / 'maintenance.sqlite'
            owner = 'a' * 64
            connection = sqlite3.connect(database)
            connection.execute('CREATE TABLE reservation (id INTEGER PRIMARY KEY,owner_hash TEXT,baseline TEXT)')
            connection.execute('INSERT INTO reservation VALUES (1,?,?)', (hashlib.sha256(owner.encode()).hexdigest(), json.dumps({'snapshot': {'version': 1}})))
            connection.commit()
            connection.close()
            os.chmod(database, 0o600)
            # Windows 경계만 보정하며 SQLite connect/query는 실제 읽기전용 URI다.
            class TestPath(type(root)):
                def lstat(self):
                    info = super().lstat()
                    if os.name == 'nt' and self.name == 'maintenance.sqlite':
                        return types.SimpleNamespace(**{name: getattr(info, name) for name in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_uid', 'st_gid', 'st_nlink')}, st_mode=stat.S_IFREG | 0o600)
                    return info
            settings = types.SimpleNamespace(read_env=lambda _: {'BRIDGE_TRANSFER_ROOT': str(root)})
            util = types.SimpleNamespace(spec_from_file_location=lambda *args: types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda _: None)), module_from_spec=lambda _: settings)
            scope = {'__name__': 'offline_fixture'}
            exec(compile((HERE / 'recover.py.in').read_text(encoding='utf-8'), 'recover.py.in', 'exec'), scope)
            scope.update(Path=TestPath, importlib=types.SimpleNamespace(util=util))
            activation = {'NEW': root, 'ENV': root / 'bridge.env'}
            original = database.read_bytes()
            scope['offline_reserved'](activation, owner)
            self.assertEqual(database.read_bytes(), original)
            self.assertEqual(sorted(path.name for path in root.iterdir()), ['maintenance.sqlite'])
            with self.assertRaisesRegex(RuntimeError, 'ownership or baseline mismatch'):
                scope['offline_reserved'](activation, 'b' * 64)
            self.assertEqual(database.read_bytes(), original)
            connection = sqlite3.connect(database)
            connection.execute('UPDATE reservation SET baseline=NULL')
            connection.commit()
            connection.close()
            before_reject = database.read_bytes()
            with self.assertRaisesRegex(RuntimeError, 'ownership or baseline mismatch'):
                scope['offline_reserved'](activation, owner)
            self.assertEqual(database.read_bytes(), before_reject)


if __name__ == '__main__':
    unittest.main(verbosity=2)
