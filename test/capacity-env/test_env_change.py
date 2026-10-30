"""격리 임시파일만 쓰는 배포 ENV 회귀 시험. 외부 명령·네트워크 호출 없음."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import tempfile
import types
import unittest

HERE = Path(__file__).resolve().parent


def load(directory):
    scope = dict(pathlib=__import__('pathlib'), os=os, stat=stat, secrets=secrets, json=json)
    exec(compile((HERE / 'env-change.py.inc').read_text(encoding='utf-8'), 'env-change.py.inc', 'exec'), scope)
    scope.update(ENV=directory / 'bridge.env', ROOT=directory / 'job')
    scope['ROOT'].mkdir()
    def snapshot():
        path = scope['ENV']
        info = path.lstat()
        return {str(path): (hashlib.sha256(path.read_bytes()).hexdigest(), info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))}
    scope['snap_managed'] = snapshot
    return scope


class EnvBytes(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.scope = load(Path(self.temp.name))
        self.change = self.scope['capacity_bytes']

    def test_lf_keeps_every_unrelated_byte(self):
        before = '# 한글 주석\nA="x = y"\nBRIDGE_REQUEST_CAPACITY=100\nZ=last\n'.encode()
        expected = '# 한글 주석\nA="x = y"\nBRIDGE_REQUEST_CAPACITY=1000\nZ=last\n'.encode()
        self.assertEqual(self.change(before), expected)

    def test_crlf_keeps_every_unrelated_byte(self):
        self.assertEqual(self.change(b'#c\r\nA=x\r\nBRIDGE_REQUEST_CAPACITY="100"\r\nZ=z\r\n'), b'#c\r\nA=x\r\nBRIDGE_REQUEST_CAPACITY=1000\r\nZ=z\r\n')

    def test_missing_key_uses_existing_newline(self):
        for before, expected in [(b'A=x\n', b'A=x\nBRIDGE_REQUEST_CAPACITY=1000\n'), (b'A=x\r\n', b'A=x\r\nBRIDGE_REQUEST_CAPACITY=1000\r\n'), (b'A=x', b'A=x\nBRIDGE_REQUEST_CAPACITY=1000\n'), (b'', b'BRIDGE_REQUEST_CAPACITY=1000\n')]:
            with self.subTest(before=before):
                self.assertEqual(self.change(before), expected)

    def test_existing_final_key_keeps_absent_final_newline(self):
        self.assertEqual(self.change(b'A=x\nBRIDGE_REQUEST_CAPACITY=100'), b'A=x\nBRIDGE_REQUEST_CAPACITY=1000')

    def test_existing_target_is_idempotent(self):
        before = b'BRIDGE_REQUEST_CAPACITY=1000\n'
        self.assertEqual(self.change(before), before)

    def test_duplicate_capacity_keys_are_rejected(self):
        with self.assertRaises(RuntimeError):
            self.change(b'BRIDGE_REQUEST_CAPACITY=100\nBRIDGE_REQUEST_CAPACITY=200\n')

    def test_malformed_env_is_rejected_without_repair(self):
        for before in (b'BAD LINE\n', b'export A=x\n', b' A=x\n', b'a=x\n', b'A=\x00\n', b'A=x\rB=y', b'#\xff\n'):
            with self.subTest(before=before), self.assertRaises(RuntimeError):
                self.change(before)


class EnvFiles(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.scope = load(self.directory)
        self.path = self.scope['ENV']
        self.before = b'#keep\r\nA="x"\r\nBRIDGE_REQUEST_CAPACITY=100\r\n'
        self.after = b'#keep\r\nA="x"\r\nBRIDGE_REQUEST_CAPACITY=1000\r\n'
        self.path.write_bytes(self.before)
        self.calls = []
        self.descriptor_paths = {}
        self.directory_fds = set()
        # Windows에서는 실제 파일 I/O는 유지하며 POSIX 전용 경계만 대체한다.
        if os.name == 'nt':
            proxy = types.SimpleNamespace(**{name: getattr(os, name) for name in dir(os)})
            proxy.O_NOFOLLOW = 0
            proxy.O_DIRECTORY = 0
            def open_file(path, flags, mode=0o777):
                if Path(path) == self.directory:
                    self.directory_fds.add(-101)
                    return -101
                fd = os.open(path, flags, mode)
                self.descriptor_paths[fd] = Path(path)
                return fd
            def change_owner(fd, uid, gid):
                self.calls.append(('fchown', uid, gid))
            def change_mode(fd, mode):
                self.calls.append(('fchmod', mode))
                os.chmod(self.descriptor_paths[fd], mode)
            proxy.open = open_file
            proxy.fchown = change_owner
            proxy.fchmod = change_mode
            proxy.fsync = lambda fd: None if fd in self.directory_fds else os.fsync(fd)
            proxy.close = lambda fd: None if fd in self.directory_fds else os.close(fd)
            self.scope['os'] = proxy
        self.proxy = self.scope['os']

    def metadata(self):
        return self.scope['snap_managed']()[str(self.path)]

    def temporary_files(self):
        return list(self.directory.glob('.ssh-mcp-capacity-*'))

    def test_atomic_replace_preserves_bytes_and_intended_metadata(self):
        before_meta = self.metadata()
        original_replace = self.proxy.replace
        observed = []
        def replace(source, destination):
            observed.append((Path(destination).read_bytes(), Path(source).read_bytes()))
            return os.replace(source, destination)
        if self.proxy is os:
            self.scope['os'] = types.SimpleNamespace(**{name: getattr(os, name) for name in dir(os)})
        self.scope['os'].replace = replace
        self.scope['replace_env'](self.before, self.after, before_meta)
        self.assertEqual(observed, [(self.before, self.after)])
        self.assertEqual(self.path.read_bytes(), self.after)
        self.assertEqual(self.metadata()[1:], before_meta[1:])
        self.assertEqual(self.temporary_files(), [])
        if os.name == 'nt':
            self.assertEqual(self.calls, [('fchown', before_meta[1], before_meta[2]), ('fchmod', before_meta[3])])

    def test_drift_before_copy_is_rejected_and_foreign_bytes_retained(self):
        meta = self.metadata()
        self.path.write_bytes(b'A=foreign\n')
        with self.assertRaisesRegex(RuntimeError, 'ENV changed'):
            self.scope['replace_env'](self.before, self.after, meta)
        self.assertEqual(self.path.read_bytes(), b'A=foreign\n')
        self.assertEqual(self.temporary_files(), [])

    def test_drift_during_copy_is_rejected_before_replace(self):
        meta = self.metadata()
        read = self.scope['read_env']
        count = 0
        def read_with_drift():
            nonlocal count
            count += 1
            if count == 2:
                self.path.write_bytes(b'A=concurrent\n')
            return read()
        self.scope['read_env'] = read_with_drift
        with self.assertRaisesRegex(RuntimeError, 'ENV drifted'):
            self.scope['replace_env'](self.before, self.after, meta)
        self.assertEqual(self.path.read_bytes(), b'A=concurrent\n')
        self.assertEqual(self.temporary_files(), [])

    def test_metadata_drift_is_rejected(self):
        meta = self.metadata()
        bad_meta = (*meta[:3], meta[3] ^ 0o200)
        with self.assertRaisesRegex(RuntimeError, 'ENV changed'):
            self.scope['replace_env'](self.before, self.after, bad_meta)
        self.assertEqual(self.path.read_bytes(), self.before)

    def test_private_backup_and_reverse_replacement_restore_exact_bytes(self):
        original_meta = self.metadata()
        self.scope['private_backup'](self.before)
        self.scope['replace_env'](self.before, self.after, original_meta)
        backup = (self.scope['ROOT'] / 'env.before').read_bytes()
        self.assertEqual(backup, self.before)
        self.scope['replace_env'](self.after, backup, self.metadata())
        self.assertEqual(self.path.read_bytes(), self.before)
        self.assertEqual(self.metadata(), original_meta)
        with self.assertRaises(FileExistsError):
            self.scope['private_backup'](b'overwrite')
        self.assertEqual((self.scope['ROOT'] / 'env.before').read_bytes(), self.before)

    def test_replace_failure_leaves_original_and_removes_own_temp(self):
        def refuse(*args):
            raise OSError('시험용 교체 거절')
        if self.proxy is os:
            self.scope['os'] = types.SimpleNamespace(**{name: getattr(os, name) for name in dir(os)})
        self.scope['os'].replace = refuse
        with self.assertRaisesRegex(OSError, '시험용'):
            self.scope['replace_env'](self.before, self.after, self.metadata())
        self.assertEqual(self.path.read_bytes(), self.before)
        self.assertEqual(self.temporary_files(), [])

    def test_hardlink_env_is_rejected(self):
        alias = self.directory / 'alias'
        os.link(self.path, alias)
        with self.assertRaisesRegex(RuntimeError, 'unsafe ENV'):
            self.scope['read_env']()

    @unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'Linux root의 실제 uid/gid/mode/O_NOFOLLOW 검증 필요')
    def test_native_posix_ownership_mode_backup_and_symlink_guards(self):
        os.chown(self.path, 0, 12345)
        os.chmod(self.path, 0o640)
        meta = self.metadata()
        self.scope['private_backup'](self.before)
        self.scope['replace_env'](self.before, self.after, meta)
        info = self.path.stat()
        self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), (0, 12345, 0o640))
        for name in ('env.before', 'managed.before.json'):
            info = (self.scope['ROOT'] / name).stat()
            self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), (0, 0, 0o600))
        self.scope['replace_env'](self.after, self.before, self.metadata())
        self.assertEqual(self.path.read_bytes(), self.before)
        self.path.unlink()
        self.path.symlink_to(self.scope['ROOT'] / 'env.before')
        with self.assertRaises(OSError):
            self.scope['read_env']()

    @unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'Linux root의 실제 비root 소유 ENV 거절 검증 필요')
    def test_native_posix_nonroot_owner_is_rejected(self):
        os.chown(self.path, 65534, 65534)
        with self.assertRaisesRegex(RuntimeError, 'unsafe ENV'):
            self.scope['read_env']()


if __name__ == '__main__':
    unittest.main(verbosity=2)
