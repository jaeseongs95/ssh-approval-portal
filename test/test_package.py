import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile

SOURCE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('delivery_package', SOURCE / 'scripts/package.py')
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class PackageContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='ssh-package-fixture-')
        self.root = Path(self.temporary.name) / 'candidate'
        for folder in packager.SOURCE_TYPES:
            (self.root / folder).mkdir(parents=True, exist_ok=True)
        names = packager.ROOT_FILES + packager.UI_FILES + ['config/' + name for name in packager.CONFIG_FILES]
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

    def run_node(self, script, *arguments):
        node = shutil.which('node')
        self.assertIsNotNone(node, 'Package import contract requires the configured Node runtime')
        return subprocess.run([node, str(script), *map(str, arguments)], capture_output=True, text=True, timeout=20)

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


if __name__ == '__main__':
    unittest.main()
