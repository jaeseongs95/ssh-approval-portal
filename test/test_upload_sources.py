import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('upload_sources', Path(__file__).resolve().parents[1] / 'scripts/configure-upload-sources.py')
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


class UploadSourceConfiguration(unittest.TestCase):
    def test_preserves_other_lines_and_crlf_and_replaces_only_source_setting(self):
        text = 'BRIDGE_ADMIN_TOKEN=synthetic-secret\r\n# comment\r\nBRIDGE_UI_ENABLED=true\r\nBRIDGE_UPLOAD_SOURCE_HOSTS=old.test\r\nBRIDGE_ACCESS_OWNER_EMAILS=owner@example.test\r\n'
        updated = config.update_source_hosts(text, 'Files.Example.test,files.example.test,other.test')
        self.assertEqual(updated, text.replace('BRIDGE_UPLOAD_SOURCE_HOSTS=old.test\r\n', '') + 'BRIDGE_UPLOAD_SOURCE_HOSTS=files.example.test,other.test\r\n')
        self.assertEqual(config.update_source_hosts(updated, '').splitlines()[-1], 'BRIDGE_UPLOAD_SOURCE_HOSTS=')

    def test_invalid_hosts_and_credential_or_url_inputs_are_rejected(self):
        for value in ['https://files.test/a', '*.files.test', 'files.test.', 'owner@files.test', 'files.test:443', '127.0.0.1', '::1', '127.1', '2130706433', '0x7f000001', '0177.0.0.1', 'files.test,,other.test', 'files.test\nBRIDGE_UI_ENABLED=false']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                config.update_source_hosts('BRIDGE_ADMIN_TOKEN=unchanged\n', value)

    @unittest.skipIf(os.name == 'nt', 'Unix configuration permissions and symlink semantics')
    def test_private_regular_file_boundary(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'config.env'
            path.write_bytes(b'BRIDGE_UI_ENABLED=true\r\n')
            path.chmod(0o600)
            self.assertEqual(config.read_private_config(path), 'BRIDGE_UI_ENABLED=true\r\n')
            link = Path(folder) / 'link'
            link.symlink_to(path)
            with self.assertRaises((ValueError, OSError)):
                config.read_private_config(link)
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                config.read_private_config(path)


if __name__ == '__main__':
    unittest.main()
