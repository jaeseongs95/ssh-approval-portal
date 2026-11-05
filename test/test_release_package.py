"""Execute only in the configured TEST environment: real combined release assets."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

from test_package import SOURCE, packager


class ReleasePackageContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='portal-release-package-')
        self.addCleanup(self.temporary.cleanup)
        self.work = Path(self.temporary.name)
        self.root = self.work / 'source'
        # Reuse the existing public-source fixture input boundary. Expectations
        # below come from decoded assets, independent hashes and actual runtimes.
        for source in packager.collect_files(SOURCE):
            target = self.root / source.relative_to(SOURCE)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        self.version = json.loads((self.root / 'package.json').read_text(encoding='utf-8'))['version']
        self.output = self.work / 'release'
        self.node = shutil.which('node')
        self.assertIsNotNone(self.node, 'The configured TEST Node runtime is required')

    def build(self):
        return subprocess.run(
            [sys.executable, str(self.root / 'scripts/package-release.py'), '--release', '--output', str(self.output)],
            cwd=self.root, capture_output=True, text=True, encoding='utf-8', timeout=120)

    def read_archive(self, path, prefix):
        if path.suffix == '.zip':
            with zipfile.ZipFile(path) as archive:
                names = archive.namelist()
                self.assertTrue(all(not member.is_dir() for member in archive.infolist()))
                payload = {name: archive.read(name) for name in names}
        else:
            with tarfile.open(path, 'r:gz') as archive:
                members = archive.getmembers()
                self.assertTrue(all(member.isfile() for member in members))
                names = [member.name for member in members]
                payload = {member.name: archive.extractfile(member).read() for member in members}
        self.assertEqual(len(names), len(payload), 'Archive names must not be duplicated')
        self.assertTrue(all(name.startswith(prefix + '/') for name in names))
        relative = {name[len(prefix) + 1:]: body for name, body in payload.items()}
        for name in relative:
            self.assertFalse(PurePosixPath(name).is_absolute())
            self.assertNotIn('..', PurePosixPath(name).parts)
            self.assertNotIn('\\', name)
        return relative

    def verify_manifest(self, payload, name):
        manifest = json.loads(payload[name])
        self.assertEqual(manifest['version'], self.version)
        entries = manifest['files']
        paths = [entry['path'] for entry in entries]
        self.assertEqual(len(paths), len(set(paths)))
        self.assertEqual(set(payload), {*paths, name}, 'Manifest must account for every packaged file')
        for entry in entries:
            with self.subTest(manifest=name, file=entry['path']):
                body = payload[entry['path']]
                self.assertEqual(entry['size'], len(body))
                self.assertEqual(entry['sha256'], hashlib.sha256(body).hexdigest())
        return manifest

    def extract_verified(self, payload, prefix, suffix):
        root = self.work / (prefix + '-' + suffix)
        for name, body in payload.items():
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
        return root

    def run_node(self, root, script, *args, env=None):
        return subprocess.run([self.node, str(root / script), *map(str, args)], cwd=root,
                              env=env, capture_output=True, text=True, encoding='utf-8', timeout=30)

    def test_four_real_assets_have_matching_versions_manifests_checksums_and_working_entrypoints(self):
        built = self.build()
        self.assertEqual(built.returncode, 0, built.stdout + built.stderr)
        result = json.loads(built.stdout)
        self.assertEqual(result['version'], self.version)
        server = 'ssh-approval-portal-' + self.version
        client = 'ssh-approval-portal-client-' + self.version
        expected = {prefix + suffix for prefix in (server, client) for suffix in ('.tar.gz', '.zip')}
        actual = {path.name for path in self.output.iterdir() if path.name.endswith(('.tar.gz', '.zip'))}
        self.assertEqual(actual, expected)
        self.assertEqual(len(result['archives']), 4)
        self.assertEqual(set(result['archives']), expected)
        lines = (self.output / 'SHA256SUMS').read_text(encoding='utf-8').splitlines()
        self.assertEqual(len(lines), 4)
        advertised = {}
        for line in lines:
            match = re.fullmatch(r'([a-f0-9]{64})  ([^/\\]+)', line)
            self.assertIsNotNone(match, 'Checksums must identify a single archive filename')
            digest, name = match.groups()
            self.assertNotIn(name, advertised)
            advertised[name] = digest
        self.assertEqual(set(advertised), expected)
        self.assertEqual(result['checksums'], (self.output / 'SHA256SUMS').read_text(encoding='utf-8'))
        npm = shutil.which('npm')
        self.assertIsNotNone(npm, 'Server import smoke requires the configured TEST npm')
        environment = dict(os.environ)
        environment['PATH'] = str(Path(self.node).parent) + os.pathsep + environment.get('PATH', '')
        empty_bin = self.work / 'no-external-executables'
        empty_bin.mkdir()
        equivalents = {}
        for name in sorted(expected):
            with self.subTest(archive=name):
                archive = self.output / name
                self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), advertised[name])
                is_client = name.startswith(client + '.')
                prefix = client if is_client else server
                suffix = 'zip' if archive.suffix == '.zip' else 'tar'
                payload = self.read_archive(archive, prefix)
                manifest = self.verify_manifest(payload, 'client-manifest.json' if is_client else 'release-manifest.json')
                metadata = json.loads(payload['package.json'])
                self.assertEqual(metadata['version'], self.version)
                if prefix in equivalents:
                    self.assertEqual(payload, equivalents[prefix], 'tar and zip must ship identical file bytes')
                else:
                    equivalents[prefix] = payload
                extracted = self.extract_verified(payload, prefix, suffix)
                if is_client:
                    self.assertEqual(metadata['dependencies'], {})
                    self.assertEqual(manifest['entrypoint'], 'scripts/portal-files.mjs')
                    self.assertFalse(any('node_modules' in PurePosixPath(path).parts for path in payload))
                    client_env = dict(environment, PATH=str(empty_bin))
                    client_env.pop('NODE_PATH', None)
                    client_env.pop('NODE_OPTIONS', None)
                    help_result = self.run_node(extracted, manifest['entrypoint'], '--help', env=client_env)
                    self.assertEqual(help_result.returncode, 0, help_result.stdout + help_result.stderr)
                    self.assertIn('file client' + self.version, help_result.stdout)
                    self.assertIn('upload --file', help_result.stdout)
                    self.assertFalse((extracted / 'node_modules').exists(), 'Help must not install dependencies')
                else:
                    self.assertEqual(manifest['status'], 'release')
                    verified = self.run_node(extracted, 'scripts/verify.mjs', extracted, env=environment)
                    self.assertEqual(verified.returncode, 0, verified.stdout + verified.stderr)
                    installed = subprocess.run(
                        [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
                         '--cache', str(self.work / 'npm-cache')],
                        cwd=extracted, env=environment, capture_output=True, text=True, encoding='utf-8', timeout=180)
                    self.assertEqual(installed.returncode, 0, installed.stdout + installed.stderr)
                    imported = self.run_node(extracted, 'scripts/check-package-imports.mjs', env=environment)
                    self.assertEqual(imported.returncode, 0, imported.stdout + imported.stderr)
                    self.assertIn('Packaged application imports resolved', imported.stdout)

    def test_reusing_output_refuses_without_changing_any_existing_asset(self):
        built = self.build()
        self.assertEqual(built.returncode, 0, built.stdout + built.stderr)
        before = {path.name: (path.read_bytes(), path.stat().st_mtime_ns) for path in self.output.iterdir()}
        source_manifest = (self.root / 'release-manifest.json').read_bytes()
        repeated = self.build()
        self.assertNotEqual(repeated.returncode, 0, 'An existing release output must be refused')
        self.assertEqual(set(before), {path.name for path in self.output.iterdir()})
        for name, (body, modified) in before.items():
            self.assertEqual((self.output / name).read_bytes(), body, name)
            self.assertEqual((self.output / name).stat().st_mtime_ns, modified, name)
        self.assertEqual((self.root / 'release-manifest.json').read_bytes(), source_manifest)

    def test_server_client_version_mismatch_creates_no_output_or_server_manifest(self):
        metadata = json.loads((self.root / 'package.json').read_text(encoding='utf-8'))
        metadata['version'] = '999.0.0'
        (self.root / 'package.json').write_text(json.dumps(metadata), encoding='utf-8')
        refused = self.build()
        self.assertNotEqual(refused.returncode, 0, 'Mismatched versions must not publish a partial release')
        self.assertIn('Server and client versions must match', refused.stderr)
        self.assertFalse(self.output.exists())
        self.assertFalse((self.root / 'release-manifest.json').exists())


if __name__ == '__main__':
    unittest.main()
