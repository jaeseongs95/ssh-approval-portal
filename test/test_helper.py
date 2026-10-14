import importlib.util
import hashlib
import os
import pathlib
import pwd
import tempfile
import unittest
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
        with self.assertRaises(FileExistsError): helper.handle(request)
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
        with self.assertRaises(OSError): helper.handle({'id': self.ident, 'action': 'snapshot', 'remotePath': str(link)})
        with self.assertRaises(ValueError): helper.handle({**request, 'remotePath': str(self.root / '..' / 'escape')})
    def test_directory_fifo_and_size_limit_refused(self):
        with self.assertRaises(ValueError): helper.handle({'id': self.ident, 'action': 'snapshot', 'remotePath': str(self.stage)})
        fifo = self.root / 'fifo'
        os.mkfifo(fifo)
        with self.assertRaises(ValueError): helper.handle({'id': self.ident, 'action': 'snapshot', 'remotePath': str(fifo)})
        request = self.upload(b'1234', maxBytes=3)
        with self.assertRaises(ValueError): helper.handle(request)

if __name__ == '__main__': unittest.main()
