import importlib.util
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import re
import tarfile
import tempfile
import unittest
import zipfile

SOURCE = Path(__file__).resolve().parents[1]
OIDC_EXAMPLES = ['deploy/oidc/Caddyfile', 'deploy/oidc/oauth2-proxy.cfg']
spec = importlib.util.spec_from_file_location('delivery_package', SOURCE / 'scripts/package.py')
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class PackageContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='ssh-package-fixture-')
        self.root = Path(self.temporary.name) / 'candidate'
        for folder in packager.SOURCE_TYPES:
            (self.root / folder).mkdir(parents=True, exist_ok=True)
        names = packager.ROOT_FILES + packager.UI_FILES + ['config/' + name for name in packager.CONFIG_FILES] + OIDC_EXAMPLES
        for name in names:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('synthetic fixture\n', encoding='utf-8')
        self.write('package.json', json.dumps({'version': '0.3.0', 'type': 'module'}))
        self.write('package-lock.json', '{}')
        self.write('src/domain/value.mjs', 'export const value = 42;')
        self.write('src/application/example.mjs', "import { value } from '../domain/value.mjs'; export const createApplication = () => value;")
        self.write('src/adapters/example.mjs', 'export const adapter = true;')
        self.write('app.mjs', "export { createApplication } from './src/application/example.mjs';")
        self.write('bridge.mjs', "import { createApplication } from './app.mjs'; createApplication();")
        self.write('ui/src/nested/source.js', 'export const ui = true;')
        self.write('web/src/nested/source.js', 'export const web = true;')
        self.write('web/dist/app.js', 'console.log("synthetic web bundle");')
        for name in ['verify.mjs', 'check-package-imports.mjs']:
            shutil.copyfile(SOURCE / 'scripts' / name, self.root / 'scripts' / name)

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')

    def test_secret_store_records_are_rejected_without_exposing_the_value(self):
        marker = 'synthetic-package-secret-must-not-ship'
        self.write('src/private-store/key.json', json.dumps({'kind': 'secret-record', 'schema': 1, 'value': marker}))
        with self.assertRaisesRegex(ValueError, 'Secret store record') as caught:
            packager.package(self.root)
        self.assertNotIn(marker, str(caught.exception))
        self.assertFalse((self.root / 'release-manifest.json').exists())

    def run_node(self, script, *arguments):
        node = shutil.which('node')
        self.assertIsNotNone(node, 'Package import contract requires the configured Node runtime')
        return subprocess.run([node, str(script), *map(str, arguments)], capture_output=True, text=True, timeout=20)

    def test_manifest_and_archive_paths_use_case_sensitive_portable_order(self):
        self.write('scripts/Z-capital.sh', '#!/bin/sh\n')
        self.write('scripts/a-lower.sh', '#!/bin/sh\n')
        archives, _ = packager.package(self.root)
        entries = json.loads((self.root / 'release-manifest.json').read_text(encoding='utf-8'))['files']
        paths = [entry['path'] for entry in entries]
        self.assertEqual(paths, sorted(paths))
        self.assertLess(paths.index('LICENSE'), paths.index('app.mjs'))
        self.assertLess(paths.index('scripts/Z-capital.sh'), paths.index('scripts/a-lower.sh'))
        expected = sorted([*paths, 'release-manifest.json'])
        prefix = 'ssh-approval-portal-0.3.0/'
        with tarfile.open(archives[0], 'r:gz') as archive:
            self.assertEqual([name.removeprefix(prefix) for name in archive.getnames()], expected)
        with zipfile.ZipFile(archives[1]) as archive:
            self.assertEqual([name.removeprefix(prefix) for name in archive.namelist()], expected)

    def test_layered_sources_and_bundles_resolve_from_extracted_package(self):
        self.write('src/.env', 'not-for-package=synthetic')
        self.write('web/operator.key', 'not-for-package')
        self.write('test/stale-results.json', '{"result":"outdated synthetic evidence"}')
        self.write('test/fixtures/config.json', '{"synthetic":true}')
        archives, _ = packager.package(self.root)
        extracted = Path(self.temporary.name) / 'extracted'
        with zipfile.ZipFile(archives[1]) as archive:
            names = set(archive.namelist())
            prefix = 'ssh-approval-portal-0.3.0/'
            for name in ['src/domain/value.mjs', 'src/application/example.mjs', 'src/adapters/example.mjs',
                         'ui/src/nested/source.js', 'ui/dist/card.html', 'web/src/nested/source.js', 'web/dist/app.js']:
                self.assertIn(prefix + name, names)
            self.assertNotIn(prefix + 'src/.env', names)
            self.assertNotIn(prefix + 'web/operator.key', names)
            self.assertNotIn(prefix + 'test/stale-results.json', names)
            self.assertIn(prefix + 'test/fixtures/config.json', names)
            archive.extractall(extracted)
        root = extracted / 'ssh-approval-portal-0.3.0'
        result = self.run_node(root / 'scripts/check-package-imports.mjs')
        self.assertEqual(result.returncode, 0, result.stderr)
        (root / 'src/domain/value.mjs').unlink()
        result = self.run_node(root / 'scripts/check-package-imports.mjs')
        self.assertNotEqual(result.returncode, 0, 'Import smoke check accepted a missing transitive module')

    def test_manifest_rejects_unlisted_runtime_source(self):
        packager.package(self.root)
        script = self.root / 'scripts/verify.mjs'
        result = self.run_node(script, self.root)
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = self.root / 'release-manifest.json'
        data = json.loads(manifest.read_text(encoding='utf-8'))
        data['files'] = [entry for entry in data['files'] if entry['path'] != 'src/domain/value.mjs']
        manifest.write_text(json.dumps(data), encoding='utf-8')
        result = self.run_node(script, self.root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Source missing from manifest', result.stderr)

    def test_oidc_proxy_examples_are_in_both_archives_and_manifest_with_working_doc_links(self):
        for name in OIDC_EXAMPLES:
            shutil.copyfile(SOURCE/name, self.root/name)
        shutil.copyfile(SOURCE/'docs/oidc-https.ko.md', self.root/'docs/oidc-https.ko.md')
        for name in ['deploy/oidc/client-secret', 'deploy/oidc/operator.cfg', 'deploy/private.json']:
            self.write(name, 'synthetic-operator-private-do-not-package')
        archives, _ = packager.package(self.root)
        manifest = json.loads((self.root/'release-manifest.json').read_text(encoding='utf-8'))
        entries = {entry['path']:entry for entry in manifest['files']}
        self.assertEqual({name for name in entries if name.startswith('deploy/')}, set(OIDC_EXAMPLES))
        links = re.findall(r'\]\((\.\./deploy/oidc/[^)]+)\)', (self.root/'docs/oidc-https.ko.md').read_text(encoding='utf-8'))
        self.assertEqual({name.removeprefix('../') for name in links}, set(OIDC_EXAMPLES))
        for archive_path in archives:
            with self.subTest(archive=archive_path.suffix):
                prefix = 'ssh-approval-portal-0.3.0/'
                if archive_path.suffix == '.zip':
                    with zipfile.ZipFile(archive_path) as archive:
                        data = {name:archive.read(name) for name in archive.namelist() if name.startswith(prefix+'deploy/')}
                else:
                    with tarfile.open(archive_path, 'r:gz') as archive:
                        members = [entry for entry in archive.getmembers() if entry.name.startswith(prefix+'deploy/')]
                        self.assertTrue(all(entry.isfile() and entry.uid == entry.gid == 0 and entry.mode == 0o644 for entry in members))
                        data = {entry.name:archive.extractfile(entry).read() for entry in members}
                self.assertEqual(set(data), {prefix+name for name in OIDC_EXAMPLES})
                for name in OIDC_EXAMPLES:
                    raw = (self.root/name).read_bytes()
                    self.assertEqual(data[prefix+name], raw)
                    self.assertEqual(entries[name]['size'], len(raw))
                    self.assertEqual(entries[name]['sha256'], hashlib.sha256(raw).hexdigest())

    def test_oidc_example_leaf_and_parent_symlinks_are_rejected(self):
        outside = Path(self.temporary.name)/'outside'
        outside.mkdir()
        for name in ['Caddyfile', 'oauth2-proxy.cfg']:
            (outside/name).write_text('synthetic outside template\n', encoding='utf-8')
        leaf = self.root/OIDC_EXAMPLES[0]
        leaf.unlink()
        try:
            leaf.symlink_to(outside/'Caddyfile')
        except OSError:
            self.skipTest('OS symlink permission is unavailable; Linux fixture must exercise this case')
        with self.assertRaisesRegex(ValueError, 'unsafe'):
            packager.package(self.root)
        self.assertFalse((self.root/'release-manifest.json').exists())
        leaf.unlink()
        (self.root/OIDC_EXAMPLES[1]).unlink()
        parent = leaf.parent
        self.assertEqual(parent, self.root/'deploy/oidc')
        parent.rmdir()
        parent.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'unsafe'):
            packager.package(self.root)
        self.assertFalse((self.root/'release-manifest.json').exists())
        self.assertEqual((outside/'Caddyfile').read_text(encoding='utf-8'), 'synthetic outside template\n')

    def test_oidc_template_private_key_is_rejected_before_manifest(self):
        marker = 'synthetic-not-a-real-key'
        self.write(OIDC_EXAMPLES[1], '-----BEGIN RSA PRIVATE KEY-----\n'+marker+'\n')
        with self.assertRaisesRegex(ValueError, 'Private key') as caught:
            packager.package(self.root)
        self.assertNotIn(marker, str(caught.exception))
        self.assertFalse((self.root/'release-manifest.json').exists())

    @unittest.skipUnless(sys.platform == 'win32', 'Windows junction filesystem contract')
    def test_oidc_example_parent_junction_is_rejected_without_reading_target(self):
        import _winapi
        outside = Path(self.temporary.name)/'junction-target'
        outside.mkdir()
        for name in ['Caddyfile', 'oauth2-proxy.cfg']:
            (outside/name).write_text('synthetic outside template\n', encoding='utf-8')
        for name in OIDC_EXAMPLES:
            (self.root/name).unlink()
        parent = self.root/'deploy/oidc'
        parent.rmdir()
        _winapi.CreateJunction(str(outside), str(parent))
        try:
            with self.assertRaisesRegex(ValueError, 'unsafe'):
                packager.package(self.root)
            self.assertFalse((self.root/'release-manifest.json').exists())
            self.assertEqual((outside/'Caddyfile').read_text(encoding='utf-8'), 'synthetic outside template\n')
        finally:
            # Remove only this fixture's junction; never recurse through its target.
            parent.rmdir()

    def test_manifest_requires_oidc_proxy_examples_and_rejects_template_tampering(self):
        packager.package(self.root)
        manifest = self.root/'release-manifest.json'
        original = manifest.read_bytes()
        for name in OIDC_EXAMPLES:
            with self.subTest(path=name):
                data = json.loads(original)
                data['files'] = [entry for entry in data['files'] if entry['path'] != name]
                manifest.write_text(json.dumps(data), encoding='utf-8')
                result = self.run_node(self.root/'scripts/verify.mjs', self.root)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Required package entry missing', result.stderr)
        manifest.write_bytes(original)
        self.write(OIDC_EXAMPLES[1], 'changed template\n')
        result = self.run_node(self.root/'scripts/verify.mjs', self.root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Release digest mismatch', result.stderr)

    def test_source_release_can_prepare_default_docker_archive(self):
        dockerfile = (SOURCE / 'docker/Dockerfile').read_text(encoding='utf-8')
        archive_name = next(line.split('=', 1)[1] for line in dockerfile.splitlines()
                            if line.startswith('ARG PACKAGE_ARCHIVE='))
        # The default build must admit its archive, rather than only test overrides.
        rules = (SOURCE / '.dockerignore').read_text(encoding='utf-8').splitlines()
        self.assertIn('!' + archive_name, rules, 'Default Docker archive is excluded from build context')
        command = 'python3 scripts/package.py --release'
        for readme in ('README.md', 'README.ko.md'):
            self.assertIn(command, (SOURCE / readme).read_text(encoding='utf-8'),
                          'Extracted source Docker instructions omit archive preparation')
        source = Path(self.temporary.name) / 'release-source'
        for path in packager.collect_files(SOURCE):
            target = source / path.relative_to(SOURCE)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
        archives, _ = packager.package(source, release=True)
        extracted = Path(self.temporary.name) / 'clean-extracted'
        with zipfile.ZipFile(archives[1]) as archive:
            archive.extractall(extracted)
        version = json.loads((source / 'package.json').read_text(encoding='utf-8'))['version']
        root = extracted / ('ssh-approval-portal-' + version)
        self.assertFalse((root / archive_name).exists(), 'Release must not recursively embed its distribution')
        result = subprocess.run([sys.executable, str(root / 'scripts/package.py'), '--release'],
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((root / archive_name).is_file(), 'Documented preparation did not supply Docker COPY input')
        self.assertEqual((root / 'release-manifest.json').read_bytes(),
                         (source / 'release-manifest.json').read_bytes())


if __name__ == '__main__':
    unittest.main()
