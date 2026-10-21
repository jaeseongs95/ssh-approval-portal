"""Actual shell/tar/runtime checks in an explicitly owned Docker tmpfs only."""
import io
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1]
ROOT = Path('/opt/ssh-approval')
NATIVE = sys.platform == 'linux' and os.geteuid() == 0 and os.environ.get('NODE_RUNTIME_NATIVE_FIXTURE') == '1'


@unittest.skipUnless(NATIVE, 'Explicit Linux root Docker tmpfs fixture required')
class NativeRuntime(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        mounts = Path('/proc/self/mountinfo').read_text().splitlines()
        assert Path('/.dockerenv').exists()
        assert any(line.split()[4] == str(ROOT) and ' - tmpfs ' in line for line in mounts)
        assert not list(ROOT.iterdir()), 'Never adopt an existing runtime'

    def setUp(self):
        self.before = set(ROOT.iterdir())
        self.work = Path(tempfile.mkdtemp(prefix='fixture.', dir=ROOT))
        self.bin = self.work/'bin'
        self.bin.mkdir()
        self.runtime = ROOT/'node'
        self.old_marker = self.work/'untrusted-was-executed'
        self.download_marker = self.work/'downloaded'
        self.archive = self.work/'node-v24.21.0-linux-x64.tar.xz'
        self.make_archive()
        (self.bin/'curl').write_text('''#!/usr/bin/python3
import hashlib,os,shutil,sys
from pathlib import Path
a=Path(os.environ['NODE_FIXTURE_ARCHIVE']); args=sys.argv[1:]; out=Path(args[args.index('-o')+1])
Path(os.environ['NODE_FIXTURE_DOWNLOAD']).touch()
url=args[args.index('--proto')+2]
if url=='https://nodejs.org/dist/v24.21.0/SHASUMS256.txt':
    d='0'*64 if os.environ.get('NODE_FIXTURE_BAD_SUM') else hashlib.sha256(a.read_bytes()).hexdigest()
    out.write_text(d+'  '+a.name+'\\n')
elif url=='https://nodejs.org/dist/v24.21.0/'+a.name: shutil.copyfile(a,out)
else: sys.exit(93)
''')
        (self.bin/'curl').chmod(0o755)
        self.env = {**os.environ, 'PATH': str(self.bin)+':/usr/bin:/bin', 'NODE_FIXTURE_ARCHIVE': str(self.archive),
                    'NODE_FIXTURE_DOWNLOAD': str(self.download_marker)}
        self.addCleanup(self.cleanup)

    def cleanup(self):
        ROOT.chmod(0o755)
        for path in set(ROOT.iterdir()) - self.before:
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                path.unlink()

    def make_archive(self, major=24):
        prefix = 'node-v24.21.0-linux-x64'
        with tarfile.open(self.archive, 'w:xz') as archive:
            for name in [prefix, prefix+'/bin', prefix+'/lib']:
                entry = tarfile.TarInfo(name); entry.type = tarfile.DIRTYPE; entry.mode = 0o755
                entry.uid = entry.gid = 1001; archive.addfile(entry)
            for name, data, mode in [('bin/node', f'#!/bin/sh\nprintf "{major}\\n"\n'.encode(), 0o755), ('lib/npm.js', b'fixture', 0o644)]:
                entry = tarfile.TarInfo(prefix+'/'+name); entry.mode = mode; entry.size = len(data)
                entry.uid = entry.gid = 1001; archive.addfile(entry, io.BytesIO(data))
            entry = tarfile.TarInfo(prefix+'/bin/npm'); entry.type = tarfile.SYMTYPE
            entry.linkname = '../lib/npm.js'; entry.uid = entry.gid = 1001; archive.addfile(entry)

    def existing(self, uid=1001):
        (self.runtime/'bin').mkdir(parents=True)
        node = self.runtime/'bin/node'
        data = f'#!/bin/sh\ntouch "{self.old_marker}"\nprintf "24\\n"\n'.encode()
        node.write_bytes(data); node.chmod(0o755); os.chown(node, uid, uid)
        return data

    def run_helper(self):
        return subprocess.run(['/bin/bash', str(SOURCE/'scripts/ensure-node-runtime.sh')], env=self.env,
                              stdin=subprocess.DEVNULL, capture_output=True, timeout=30)

    def test_fresh_archive_ignores_vendor_uid_and_supports_internal_npm_link(self):
        result = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        for path in [self.runtime, *self.runtime.rglob('*')]:
            self.assertEqual(path.lstat().st_uid, 0)
        self.assertTrue((self.runtime/'bin/npm').is_symlink())
        self.assertFalse(list(ROOT.glob('.node-stage.*')))

    def test_untrusted_existing_is_never_executed_and_is_preserved_privately(self):
        old = self.existing()
        result = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertFalse(self.old_marker.exists(), 'Untrusted runtime was executed')
        backups = list(ROOT.glob('.node-previous.*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(stat.S_IMODE(backups[0].stat().st_mode), 0o700)
        self.assertEqual((backups[0]/'node/bin/node').read_bytes(), old)
        self.assertEqual((backups[0]/'node/bin/node').stat().st_uid, 1001)
        self.assertEqual((self.runtime/'bin/node').stat().st_uid, 0)

    def test_trusted_existing_reused_without_download(self):
        self.existing(uid=0)
        result = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertTrue(self.old_marker.exists())
        self.assertFalse(self.download_marker.exists())
        self.assertFalse(list(ROOT.glob('.node-previous.*')))

    def test_checksum_failure_preserves_existing_bytes_owner_and_no_execution(self):
        old = self.existing(); self.env['NODE_FIXTURE_BAD_SUM'] = '1'
        result = self.run_helper()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.runtime/'bin/node').read_bytes(), old)
        self.assertEqual((self.runtime/'bin/node').stat().st_uid, 1001)
        self.assertFalse(self.old_marker.exists())
        self.assertFalse(list(ROOT.glob('.node-previous.*')))
        self.assertFalse(list(ROOT.glob('.node-stage.*')))

    def test_wrong_new_major_preserves_existing(self):
        old = self.existing(); self.make_archive(major=25)
        result = self.run_helper()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.runtime/'bin/node').read_bytes(), old)
        self.assertFalse(self.old_marker.exists())
        self.assertFalse(list(ROOT.glob('.node-previous.*')))

    def test_top_level_symlink_is_not_followed_or_replaced(self):
        target = self.work/'external'; target.mkdir(); self.runtime.symlink_to(target)
        result = self.run_helper()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.runtime.is_symlink())
        self.assertEqual(list(target.iterdir()), [])
        self.assertFalse(self.download_marker.exists())

    def test_escaping_or_writable_runtime_is_not_executed(self):
        for kind in ['escaping-link', 'writable-file', 'writable-directory', 'private-directory', 'hardlink']:
            with self.subTest(kind=kind):
                old = self.existing(uid=0)
                if kind == 'escaping-link': (self.runtime/'escape').symlink_to('/etc/passwd')
                elif kind == 'writable-file': (self.runtime/'bin/node').chmod(0o777)
                elif kind == 'writable-directory': (self.runtime/'bin').chmod(0o777)
                elif kind == 'private-directory': self.runtime.chmod(0o700)
                else: os.link(self.runtime/'bin/node', self.runtime/'duplicate')
                result = self.run_helper()
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertFalse(self.old_marker.exists(), 'Unsafe tree was executed')
                self.assertEqual(len(list(ROOT.glob('.node-previous.*'))), 1)
                for path in [self.runtime, *ROOT.glob('.node-previous.*')]:
                    shutil.rmtree(path)

    def test_untrusted_parent_rejected_before_download(self):
        self.existing(uid=0); ROOT.chmod(0o777)
        result = self.run_helper()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.old_marker.exists())
        self.assertFalse(self.download_marker.exists())

    def test_failed_final_rename_restores_old_runtime(self):
        old = self.existing()
        (self.bin/'mv').write_text('''#!/bin/sh
case "$2" in /opt/ssh-approval/.node-stage.*/node-v24.21.0-linux-x64) exit 28;; esac
exec /usr/bin/mv "$@"
'''); (self.bin/'mv').chmod(0o755)
        result = self.run_helper()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.runtime/'bin/node').read_bytes(), old)
        self.assertEqual((self.runtime/'bin/node').stat().st_uid, 1001)
        self.assertFalse(self.old_marker.exists())

    def test_term_between_renames_restores_old_runtime(self):
        import signal
        import time
        old = self.existing()
        paused = self.work/'rename-paused'
        (self.bin/'mv').write_text('''#!/bin/sh
case "$2" in /opt/ssh-approval/.node-stage.*/node-v24.21.0-linux-x64) touch "$NODE_FIXTURE_PAUSED"; sleep 30;; esac
exec /usr/bin/mv "$@"
'''); (self.bin/'mv').chmod(0o755)
        self.env['NODE_FIXTURE_PAUSED'] = str(paused)
        process = subprocess.Popen(['/bin/bash', str(SOURCE/'scripts/ensure-node-runtime.sh')], env=self.env,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   start_new_session=True)
        try:
            until = time.monotonic()+10
            while not paused.exists() and process.poll() is None and time.monotonic() < until:
                time.sleep(0.02)
            self.assertTrue(paused.exists())
            os.killpg(process.pid, signal.SIGTERM)
            process.communicate(timeout=10)
            self.assertNotEqual(process.returncode, 0)
            self.assertEqual((self.runtime/'bin/node').read_bytes(), old)
            self.assertFalse(self.old_marker.exists())
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate(timeout=5)

    def test_existing_lock_prevents_parallel_install(self):
        import fcntl
        lock = ROOT/'.node-runtime.lock'
        with lock.open('x') as handle:
            lock.chmod(0o600); fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_helper()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.runtime.exists())
        self.assertFalse(self.download_marker.exists())

    @unittest.skipUnless(os.environ.get('NODE_RUNTIME_OFFICIAL_ARCHIVE'), 'Verified public archive is a separate fixture')
    def test_verified_official_archive_installs_and_executes_as_root_owned(self):
        import hashlib
        official = Path(os.environ['NODE_RUNTIME_OFFICIAL_ARCHIVE'])
        self.assertEqual(hashlib.sha256(official.read_bytes()).hexdigest(),
                         'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6')
        shutil.copyfile(official, self.archive)
        result = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        result = subprocess.run([str(self.runtime/'bin/node'), '--version'], env={'PATH': '/usr/bin:/bin'},
                                stdin=subprocess.DEVNULL, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), b'v24.21.0')
        self.assertEqual((self.runtime/'bin/node').stat().st_uid, 0)


if __name__ == '__main__':
    unittest.main()
