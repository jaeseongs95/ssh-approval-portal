"""No real host paths: code-only update boundaries on temporary Linux files."""
import importlib.util
import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest


if os.name == 'posix':
    spec = importlib.util.spec_from_file_location('release_update', Path(__file__).resolve().parents[1] / 'scripts/update_release.py')
    update = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(update)


def competing_lock(path, sender):
    try:
        with update.installer_lock(path):
            sender.send('acquired')
    except BlockingIOError:
        sender.send('locked')
    finally:
        sender.close()


@unittest.skipUnless(os.name == 'posix', 'Linux release and flock primitives')
class CodeOnlyUpdate(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='code-update-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        (self.source / 'code.mjs').write_bytes(b'export const value = 1;\n')
        self.old = self.root / 'old'
        self.old.mkdir()
        self.active = self.root / 'active'
        self.active.symlink_to(self.old)
        self.new = self.root / 'new'
        self.managed = [self.root / name for name in ['env', 'unit', 'helper', 'key', 'policy', 'database']]
        for path in self.managed:
            path.write_bytes(('original:' + path.name).encode())
            path.chmod(0o600)
        self.before = self.snapshot()

    def snapshot(self):
        return {p.name: (p.read_bytes(), p.stat().st_uid, p.stat().st_gid, p.stat().st_mode) for p in self.managed}

    def unchanged(self):
        if self.snapshot() != self.before:
            raise RuntimeError('external protected change')

    def publish(self):
        update.publish_release(self.source, self.new, os.getegid(), lambda stage: self.assertEqual((stage / 'code.mjs').read_bytes(), (self.source / 'code.mjs').read_bytes()))

    def test_success_and_recovery_touch_only_exact_release_link(self):
        with update.installer_lock(self.root / 'install.lock'):
            self.publish()
            update.activate_release(self.active, self.old, self.new, self.unchanged)
            self.assertEqual(os.readlink(self.active), str(self.new))
            self.assertEqual(self.new.stat().st_mode & 0o777, 0o750)
            self.assertEqual((self.new / 'code.mjs').stat().st_mode & 0o777, 0o640)
            update.activate_release(self.active, self.new, self.old, self.unchanged)
        self.assertEqual(self.snapshot(), self.before)
        self.assertEqual(os.readlink(self.active), str(self.old))

    def test_each_external_file_change_blocks_activation_and_recovery(self):
        self.publish()
        for path in self.managed:
            for recovery in [False, True]:
                with self.subTest(file=path.name, recovery=recovery):
                    self.active.unlink()
                    self.active.symlink_to(self.new if recovery else self.old)
                    expected, target = (self.new, self.old) if recovery else (self.old, self.new)
                    path.write_bytes(b'user-new-setting')
                    with self.assertRaises(RuntimeError):
                        update.activate_release(self.active, expected, target, self.unchanged)
                    self.assertEqual(path.read_bytes(), b'user-new-setting')
                    self.assertEqual(os.readlink(self.active), str(expected))
                    path.write_bytes(self.before[path.name][0])

    def test_drift_between_checks_is_detected_before_replace(self):
        self.publish()
        calls = 0
        def verify():
            nonlocal calls
            calls += 1
            if calls == 2:
                self.managed[0].write_bytes(b'new-env')
            self.unchanged()
        with self.assertRaises(RuntimeError):
            update.activate_release(self.active, self.old, self.new, verify)
        self.assertEqual(os.readlink(self.active), str(self.old))
        self.assertFalse(list(self.root.glob('.portal-link-*')))

    def test_third_release_or_regular_active_is_never_overwritten(self):
        self.publish()
        third = self.root / 'third'
        third.mkdir()
        for regular in [False, True]:
            self.active.unlink()
            if regular:
                self.active.write_bytes(b'user-active-file')
            else:
                self.active.symlink_to(third)
            with self.assertRaises(RuntimeError):
                update.activate_release(self.active, self.old, self.new, self.unchanged)
            if regular:
                self.assertEqual(self.active.read_bytes(), b'user-active-file')
            else:
                self.assertEqual(os.readlink(self.active), str(third))

    def test_existing_new_directory_or_symlink_is_not_reused(self):
        for symlink in [False, True]:
            if symlink:
                self.new.symlink_to(self.old)
            else:
                self.new.mkdir()
            with self.assertRaises(FileExistsError):
                self.publish()
            self.new.unlink() if symlink else self.new.rmdir()

    def test_destination_created_during_verification_is_not_replaced(self):
        def verify(stage):
            self.new.mkdir()
        with self.assertRaises(FileExistsError):
            update.publish_release(self.source, self.new, os.getegid(), verify)
        self.assertEqual(list(self.new.iterdir()), [])
        self.assertFalse(list(self.root.glob('.portal-code-*')))

    def test_invalid_candidate_and_external_symlink_are_not_published(self):
        def fail(stage):
            raise RuntimeError('manifest/import check failed')
        with self.assertRaises(RuntimeError):
            update.publish_release(self.source, self.new, os.getegid(), fail)
        self.assertFalse(self.new.exists())
        (self.source / 'external').symlink_to(self.managed[0])
        with self.assertRaises(ValueError):
            self.publish()
        self.assertFalse(self.new.exists())
        self.assertEqual(self.snapshot(), self.before)

    def test_shared_lock_excludes_another_installer_until_recovery_finishes(self):
        context = multiprocessing.get_context('fork')
        path = self.root / 'install.lock'
        with update.installer_lock(path):
            self.publish()
            update.activate_release(self.active, self.old, self.new, self.unchanged)
            parent, child = context.Pipe(duplex=False)
            process = context.Process(target=competing_lock, args=(path, child))
            process.start()
            self.assertTrue(parent.poll(5))
            self.assertEqual(parent.recv(), 'locked')
            process.join(5)
            self.assertEqual(process.exitcode, 0)
            parent.close()
            update.activate_release(self.active, self.new, self.old, self.unchanged)
        with update.installer_lock(path):
            self.assertEqual(os.readlink(self.active), str(self.old))


if __name__ == '__main__':
    unittest.main()
