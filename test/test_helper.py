import importlib.util
import hashlib
import os
import pathlib
import pwd
import tempfile
import unittest
import errno
import io
import json
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

path = pathlib.Path(__file__).resolve().parents[1] / 'helper/file-helper.py'
spec = importlib.util.spec_from_file_location('helper', path)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

class Files(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ssh-helper-')
        self.root = pathlib.Path(self.temp.name)
        self.stage = self.root / 'stage'
        self.stage.mkdir(mode=0o700)
        helper.STAGE_ROOT = str(self.stage)
        self.account = patch.object(helper.pwd, 'getpwnam', return_value=pwd.getpwuid(os.getuid()))
        self.account.start()
        self.ident = 'a' * 48
    def tearDown(self):
        self.account.stop()
        self.temp.cleanup()
    def upload(self, data=b'\x00\xffabc', **options):
        (self.stage / (self.ident + '.part')).write_bytes(data)
        return {'id': self.ident, 'action': 'publish', 'remotePath': str(self.root / '한글.bin'), 'overwrite': False, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(), **options}
    def test_binary_empty_hash_overwrite_mode_and_snapshot(self):
        request = self.upload()
        self.assertTrue(helper.handle(request)['published'])
        target = pathlib.Path(request['remotePath'])
        self.assertEqual(target.read_bytes(), b'\x00\xffabc')
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(helper.FileOperationError) as refused: helper.handle(request)
        self.assertEqual(refused.exception.code, 'DESTINATION_EXISTS')
        target.chmod(0o640)
        request = self.upload(b'', overwrite=True)
        helper.handle(request)
        self.assertEqual(target.read_bytes(), b'')
        self.assertEqual(target.stat().st_mode & 0o777, 0o640)
        helper.handle({'id': self.ident, 'action': 'cleanup'})
        snap = helper.handle({'id': self.ident, 'action': 'snapshot', 'remotePath': str(target)})
        self.assertEqual(snap['sha256'], hashlib.sha256(b'').hexdigest())
    def test_hash_failure_does_not_replace_and_symlinks_are_refused(self):
        request = self.upload()
        target = pathlib.Path(request['remotePath'])
        target.write_bytes(b'old')
        request.update(overwrite=True, sha256='0' * 64)
        with self.assertRaises(ValueError): helper.handle(request)
        self.assertEqual(target.read_bytes(), b'old')
        link = self.root / 'link'
        link.symlink_to(target)
        parent, leaf = helper.parent_fd(str(link))
        try:
            with self.assertRaises(OSError) as source_error:
                os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            self.assertEqual(source_error.exception.errno, errno.ELOOP)
        finally:
            os.close(parent)
        with self.assertRaises(helper.FileOperationError) as refused:
            helper.handle({'id': self.ident, 'action': 'snapshot', 'remotePath': str(link)})
        self.assertEqual(refused.exception.code, 'UNSAFE_PATH')
        self.assertTrue(link.is_symlink())
        self.assertEqual(target.read_bytes(), b'old')
        with self.assertRaises(ValueError): helper.handle({**request, 'remotePath': str(self.root / '..' / 'escape')})

    def failure(self, request, code):
        output = io.StringIO()
        with patch.object(helper.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(json.dumps(request).encode()))), redirect_stdout(output):
            self.assertEqual(helper.main(), 1)
        result = json.loads(output.getvalue())
        self.assertEqual(result, {'error': 'File operation refused or failed; verify paths, permissions and approved metadata.', 'errorCode': code})
        self.assertNotIn(str(self.root), output.getvalue())
        return result

    def test_missing_parent_is_distinct_and_never_created(self):
        request = self.upload(remotePath=str(self.root / 'missing' / 'x'))
        self.failure(request, 'PARENT_NOT_FOUND')
        self.assertFalse((self.root / 'missing').exists())
        self.assertEqual(list(self.root.iterdir()), [self.stage])
        self.assertTrue(helper.handle({'id': self.ident, 'action': 'cleanup'})['cleaned'])
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_missing_source_and_staging_are_not_missing_parent(self):
        self.failure({'id': self.ident, 'action': 'snapshot', 'remotePath': str(self.root / 'absent')}, 'FILE_NOT_FOUND')
        request = self.upload()
        (self.stage / (self.ident + '.part')).unlink()
        self.failure(request, 'STAGING_UNAVAILABLE')
        self.stage.rmdir()
        self.failure(request, 'STAGING_UNAVAILABLE')

    def test_permissions_are_classified_by_errno_without_arbitrary_text(self):
        request = self.upload(remotePath=str(self.root / 'denied' / 'x'))
        original = os.open
        def denied(path, *args, **kwargs):
            if path == 'denied':
                raise PermissionError(errno.EACCES, '/private/credential=do-not-expose')
            return original(path, *args, **kwargs)
        with patch.object(helper.os, 'open', side_effect=denied):
            self.failure(request, 'PERMISSION_DENIED')
        self.assertFalse((self.root / 'denied').exists())

    def test_existing_destination_and_links_are_preserved_with_safe_errors(self):
        request = self.upload()
        target = pathlib.Path(request['remotePath'])
        target.write_bytes(b'original')
        self.failure(request, 'DESTINATION_EXISTS')
        self.assertEqual(target.read_bytes(), b'original')
        link = self.root / 'link'
        link.symlink_to(target)
        self.failure({**request, 'remotePath': str(link), 'overwrite': True}, 'UNSAFE_PATH')
        parent_link = self.root / 'parent-link'
        parent_link.symlink_to(self.root, target_is_directory=True)
        self.failure({**request, 'remotePath': str(parent_link / 'child')}, 'UNSAFE_PATH')
        self.failure({**request, 'remotePath': str(self.root / '..' / 'child')}, 'UNSAFE_PATH')
        self.assertEqual(target.read_bytes(), b'original')
        self.assertFalse((self.root / 'child').exists())

    def test_failure_releases_descriptors_and_removes_publish_temporary(self):
        request = self.upload()
        target = pathlib.Path(request['remotePath'])
        target.write_bytes(b'original')
        before = len(os.listdir('/proc/self/fd'))
        self.failure({**request, 'overwrite': True, 'sha256': '0' * 64}, 'FILE_CHANGED')
        self.assertEqual(target.read_bytes(), b'original')
        self.assertEqual(list(self.root.glob('.ssh-approval-*.part')), [])
        self.assertEqual(len(os.listdir('/proc/self/fd')), before)
        self.failure({**request, 'remotePath': str(self.stage), 'overwrite': True}, 'UNSAFE_PATH')
        self.assertEqual(len(os.listdir('/proc/self/fd')), before)
        self.failure({**request, 'remotePath': str(self.root / 'missing' / 'x')}, 'PARENT_NOT_FOUND')
        self.assertEqual(len(os.listdir('/proc/self/fd')), before)
        with patch.object(helper.pwd, 'getpwnam', side_effect=RuntimeError('private account failure')):
            self.failure(request, 'OPERATION_FAILED')
        self.assertEqual(len(os.listdir('/proc/self/fd')), before)

    def test_unknown_failure_is_generic_and_invalid_request_and_limit_are_safe(self):
        request = self.upload()
        with patch.object(helper, 'handle', side_effect=OSError(errno.ENOSPC, '/private/credential=do-not-expose')):
            self.failure(request, 'OPERATION_FAILED')
        self.failure([], 'INVALID_REQUEST')
        self.failure({**request, 'action': 'snapshot', 'remotePath': str(self.stage / (self.ident + '.part')), 'maxBytes': 1}, 'FILE_TOO_LARGE')

    def test_post_publication_failure_is_unknown_even_when_errno_is_permission(self):
        request = self.upload()
        target = pathlib.Path(request['remotePath'])
        original = os.fsync
        def fail_directory_sync(fd):
            if os.fstat(fd).st_ino == self.root.stat().st_ino:
                raise PermissionError(errno.EACCES, '/private/credential=do-not-expose')
            return original(fd)
        with patch.object(helper.os, 'fsync', side_effect=fail_directory_sync):
            self.failure(request, 'OPERATION_FAILED')
        self.assertEqual(target.read_bytes(), b'\x00\xffabc')
        self.assertEqual(list(self.root.glob('.ssh-approval-*.part')), [])
    def test_directory_fifo_and_size_limit_refused(self):
        with self.assertRaises(ValueError): helper.handle({'id': self.ident, 'action': 'snapshot', 'remotePath': str(self.stage)})
        fifo = self.root / 'fifo'
        os.mkfifo(fifo)
        with self.assertRaises(ValueError): helper.handle({'id': self.ident, 'action': 'snapshot', 'remotePath': str(fifo)})
        request = self.upload(b'1234', maxBytes=3)
        with self.assertRaises(ValueError): helper.handle(request)

if __name__ == '__main__': unittest.main()
