#!/usr/bin/env python3
"""TEST-only artifact packaging regression; never compiles or installs FreeRDP."""
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('builder', ROOT/'scripts/build-freerdp-input.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BundleModes(unittest.TestCase):
    def test_source_umask_cannot_create_group_writable_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            runtime, source = base/'runtime', base/'source'
            (runtime/'bin').mkdir(parents=True)
            (source/'overlay').mkdir(parents=True)
            (source/'overlay').chmod(0o775)
            (source/'overlay/input.c').write_text('public fixture')
            (source/'overlay/input.c').chmod(0o777)
            (runtime/'bin/xfreerdp3').write_bytes(b'public fixture')
            (runtime/'bin/xfreerdp3').chmod(0o640)
            (runtime/'manifest.json').write_text(json.dumps({'files':[{'path':'bin/xfreerdp3','mode':0o755}]}))
            bundle = base/'bundle.tgz'
            builder.write_bundle(bundle, runtime, source)
            with tarfile.open(bundle) as archive:
                entries = {item.name:item for item in archive}
            self.assertEqual(entries['source/overlay'].mode, 0o755)
            self.assertEqual(entries['source/overlay/input.c'].mode, 0o644)
            self.assertEqual(entries['runtime/bin/xfreerdp3'].mode, 0o755)
            self.assertEqual(entries['runtime/manifest.json'].mode, 0o644)
            self.assertTrue(all(not item.mode & 0o022 for item in entries.values()))
            self.assertEqual((source/'overlay').stat().st_mode & 0o777, 0o775)

    def test_symlink_is_rejected_instead_of_followed(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            runtime, source = base/'runtime', base/'source'
            runtime.mkdir(); source.mkdir()
            (runtime/'manifest.json').write_text('{"files":[]}')
            (source/'target').write_text('public fixture')
            (source/'link').symlink_to('target')
            with self.assertRaisesRegex(RuntimeError, 'non-regular entry'):
                builder.write_bundle(base/'bundle.tgz', runtime, source)


if __name__ == '__main__':
    unittest.main()
