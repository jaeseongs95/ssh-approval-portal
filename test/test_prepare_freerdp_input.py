"""Private runtime preparation at the actual archive/filesystem boundary; no GUI execution."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prepare_freerdp', SOURCE / 'scripts/prepare-freerdp-input.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
sha = lambda data: hashlib.sha256(data).hexdigest()


class UnsupportedPlatform(unittest.TestCase):
    def test_unsupported_host_skips_without_reading_or_creating_a_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'absent'
            for system, machine in [('win32', 'AMD64'), ('linux', 'aarch64'), ('darwin', 'x86_64')]:
                receipt = installer.prepare(root, system=system, machine=machine)
                self.assertEqual((receipt['status'], receipt['reason']), ('skipped', 'UNSUPPORTED_NATIVE_PLATFORM'))
                self.assertFalse(root.exists())


@unittest.skipUnless(sys.platform == 'linux', 'actual Linux private-directory and renameat2 contract')
class PrivateRuntime(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='portal-freerdp-package-')
        self.root = Path(self.temporary.name)
        self.root.chmod(0o755)
        (self.root / 'vendor').mkdir(mode=0o755)
        self.archive = self.root / 'vendor/fixture-native.tgz'
        self.files = {'bin/xfreerdp3': b'#!/bin/sh\nexit 93 # must never run during preparation\n',
                      'lib/libfixture.so.3': b'synthetic public library\n',
                      'licenses/FreeRDP-LICENSE': b'synthetic license\n'}
        self.path_pin = patch.object(installer, 'BUNDLE_PATH', 'vendor/fixture-native.tgz')
        self.path_pin.start()
        self.addCleanup(self.path_pin.stop)
        self.hash_pin = patch.object(installer, 'BUNDLE_SHA256', None)
        self.hash_pin.start()
        self.addCleanup(self.hash_pin.stop)
        self.addCleanup(self.temporary.cleanup)

    def bundle(self, edit=None, extra=()):
        manifest = {'format': 'portal.freerdp-native.v1', 'upstreamVersion': '3.32.1',
                    'upstreamCommit': installer.UPSTREAM, 'patchSha256': 'a' * 64, 'executable': 'bin/xfreerdp3',
                    'files': [{'path': name, 'size': len(data), 'sha256': sha(data),
                               'mode': 0o755 if name.startswith('bin/') else 0o644} for name, data in self.files.items()]}
        if edit:
            edit(manifest)
        members = [('runtime/' + name, data, 0o755 if name.startswith('bin/') else 0o644) for name, data in self.files.items()]
        members += [('runtime/manifest.json', json.dumps(manifest).encode(), 0o644),
                    ('source/upstream.tar.gz', b'preserved source, never extracted', 0o644)]
        with tarfile.open(self.archive, 'w:gz') as archive:
            for name, data, mode in members:
                member = tarfile.TarInfo(name); member.size = len(data); member.mode = mode
                archive.addfile(member, io.BytesIO(data))
            for member, content in extra:
                archive.addfile(member, io.BytesIO(content) if content is not None else None)
        digest = sha(self.archive.read_bytes())
        installer.BUNDLE_SHA256 = digest
        (self.root / 'release-manifest.json').write_text(json.dumps({'files': [
            {'path': installer.BUNDLE_PATH, 'size': self.archive.stat().st_size, 'sha256': digest}]}))
        return manifest

    @property
    def runtime(self):
        return self.root / installer.RUNTIME

    def prepare(self):
        return installer.prepare(self.root, system='linux', machine='x86_64')

    def test_prepares_only_verified_runtime_without_executing_the_binary_and_reuses_exact_inode(self):
        self.bundle()
        receipt = self.prepare()
        self.assertEqual((receipt['status'], receipt['files']), ('prepared', 3))
        inode = self.runtime.stat().st_ino
        for name, data in self.files.items():
            file = self.runtime / name
            self.assertEqual(file.read_bytes(), data)
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o755 if name.startswith('bin/') else 0o644)
        self.assertFalse((self.root / 'source').exists(), 'reproducible build source is retained inside the pinned archive only')
        self.assertEqual(self.prepare()['status'], 'reused')
        self.assertEqual(self.runtime.stat().st_ino, inode)
        self.assertEqual(list(self.runtime.parent.glob('.runtime-*')), [])

    def test_cli_isolates_umask077_and_preserves_executable_and_library_modes(self):
        self.bundle()
        scripts = self.root / 'scripts'; scripts.mkdir()
        text = (SOURCE / 'scripts/prepare-freerdp-input.py').read_text()
        text = re.sub(r'^BUNDLE_PATH = .*$', "BUNDLE_PATH = 'vendor/fixture-native.tgz'", text, flags=re.M)
        text = re.sub(r'^BUNDLE_SHA256 = .*$', 'BUNDLE_SHA256 = ' + repr(installer.BUNDLE_SHA256), text, flags=re.M)
        script = scripts / 'prepare-freerdp-input.py'; script.write_text(text)
        observed_umask = lambda: next(line for line in Path('/proc/self/status').read_text().splitlines() if line.startswith('Umask:'))
        before = observed_umask()
        result = subprocess.run([sys.executable, '-I', '-B', str(script)], capture_output=True, text=True,
                                timeout=20, preexec_fn=lambda: os.umask(0o077))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'], 'prepared')
        self.assertEqual(observed_umask(), before)
        for directory in [self.runtime, self.runtime / 'bin', self.runtime / 'lib', self.runtime / 'licenses']:
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((self.runtime / 'bin/xfreerdp3').stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((self.runtime / 'lib/libfixture.so.3').stat().st_mode), 0o644)

    def test_archive_pin_catches_a_valid_gzip_header_mutation_before_publication(self):
        self.bundle()
        data = bytearray(self.archive.read_bytes()); data[4] ^= 1; self.archive.write_bytes(data)
        with self.assertRaisesRegex(ValueError, 'FREERDP_BUNDLE_HASH_MISMATCH'):
            self.prepare()
        self.assertFalse(self.runtime.exists())

    def test_release_manifest_must_pin_the_exact_fixed_archive(self):
        self.bundle()
        (self.root / 'release-manifest.json').write_text('{"files":[]}')
        with self.assertRaisesRegex(ValueError, 'FREERDP_RELEASE_PIN_REQUIRED'):
            self.prepare()
        self.assertFalse(self.runtime.exists())

    def test_manifest_rejects_wrong_upstream_hash_size_mode_duplicates_and_traversal(self):
        mutations = [lambda m: m.update(upstreamCommit='0' * 40),
                     lambda m: m['files'][0].update(sha256='0' * 64),
                     lambda m: m['files'][0].update(size=1),
                     lambda m: m['files'][0].update(mode=0o777),
                     lambda m: m['files'].append(dict(m['files'][0])),
                     lambda m: m['files'][0].update(path='../escape')]
        for edit in mutations:
            with self.subTest(edit=mutations.index(edit)):
                self.bundle(edit)
                with self.assertRaises(ValueError): self.prepare()
                self.assertFalse(self.runtime.exists())

    def test_tar_rejects_duplicate_traversal_unlisted_files_and_link_device_members(self):
        members = []
        for name in ['runtime/bin/xfreerdp3', '../escape', '/absolute', 'runtime/lib/unlisted.so', 'runtime//bad']:
            member = tarfile.TarInfo(name); member.size = 1; member.mode = 0o644
            members.append((member, b'x'))
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.FIFOTYPE]:
            member = tarfile.TarInfo('source/unsafe'); member.type = kind; member.linkname = '../outside'; member.mode = 0o644
            members.append((member, None))
        for member, data in members:
            with self.subTest(name=member.name, type=member.type):
                self.bundle(extra=[(member, data)])
                with self.assertRaises(ValueError): self.prepare()
                self.assertFalse(self.runtime.exists())

    def test_archive_entry_and_expansion_limits_are_enforced_before_publication(self):
        self.bundle()
        for name, value, code in [('ENTRY_LIMIT', 4, 'FREERDP_ENTRY_LIMIT'), ('EXPANDED_LIMIT', 1024, 'FREERDP_EXPANDED_LIMIT')]:
            with self.subTest(limit=name), patch.object(installer, name, value):
                with self.assertRaisesRegex(ValueError, code): self.prepare()
        self.assertFalse(self.runtime.exists())

    def test_existing_different_runtime_is_unchanged_and_never_replaced(self):
        self.bundle(); self.prepare()
        target = self.runtime / 'lib/libfixture.so.3'; target.write_bytes(b'preserve differing runtime')
        before = target.read_bytes(), target.stat().st_ino
        with self.assertRaisesRegex(ValueError, 'FREERDP_EXISTING_RUNTIME_MISMATCH'):
            self.prepare()
        self.assertEqual((target.read_bytes(), target.stat().st_ino), before)

    def test_empty_runtime_collision_and_symlink_parent_do_not_get_overwritten(self):
        self.bundle(); self.runtime.mkdir(parents=True)
        inode = self.runtime.stat().st_ino
        with self.assertRaises((ValueError, OSError)): self.prepare()
        self.assertEqual(self.runtime.stat().st_ino, inode)
        self.assertEqual(list(self.runtime.iterdir()), [])
        self.runtime.rmdir(); self.runtime.parent.rmdir(); self.runtime.parent.parent.rmdir()
        outside = self.root / 'outside'; outside.mkdir()
        (self.root / 'native').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'FREERDP_UNSAFE_DIRECTORY'): self.prepare()
        self.assertEqual(list(outside.iterdir()), [])

    def test_failed_atomic_publication_removes_only_its_own_temporary_directory(self):
        self.bundle()
        with patch.object(installer, 'publish', side_effect=OSError('fixture failure')):
            with self.assertRaises(OSError): self.prepare()
        self.assertFalse(self.runtime.exists())
        self.assertEqual(list(self.runtime.parent.glob('.runtime-*')), [])
        self.assertTrue(self.archive.exists())


if __name__ == '__main__':
    unittest.main()
