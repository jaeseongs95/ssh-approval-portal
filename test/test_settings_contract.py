import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('settings_contract', Path(__file__).resolve().parents[1] / 'scripts/settings_contract.py')
settings = importlib.util.module_from_spec(spec)
spec.loader.exec_module(settings)


class SettingsContract(unittest.TestCase):
    def test_shared_origin_and_port_vectors(self):
        for kind, validator in [('origin', settings.validate_origin), ('port', settings.validate_port)]:
            for vector in settings.contract[kind + 'Vectors']:
                with self.subTest(kind=kind, value=vector['value']):
                    if vector['valid']:
                        self.assertEqual(validator(vector['value']), vector['value'] if kind == 'origin' else int(vector['value']))
                    else:
                        with self.assertRaises((ValueError, OSError)):
                            validator(vector['value'])

    def test_ports_parse_private_settings_without_evaluation(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'private.env'
            self.assertEqual(settings.validated_ports(path), {'mcp': 39124, 'admin': 39125})
            path.write_text('BRIDGE_MCP_PORT=40001\nBRIDGE_ADMIN_PORT="40002"\nSSH_MCP_FIXTURE2_KEY=private\n', encoding='utf-8')
            path.chmod(0o600)
            self.assertEqual(settings.validated_ports(path), {'mcp': 40001, 'admin': 40002})
            path.write_text('BRIDGE_MCP_PORT=$(false)\n', encoding='utf-8')
            with self.assertRaises(ValueError):
                settings.validated_ports(path)
            path.write_text('NODE_OPTIONS=--inspect\n', encoding='utf-8')
            with self.assertRaises(ValueError):
                settings.read_env(path)

    @unittest.skipIf(os.name == 'nt', 'Unix ownership and symlink semantics')
    def test_private_config_boundary(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'private.env'
            path.write_text('BRIDGE_UI_ENABLED=true\n', encoding='utf-8')
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                settings.read_env(path)
            path.chmod(0o600)
            link = Path(root) / 'symlink.env'
            link.symlink_to(path)
            with self.assertRaises((ValueError, OSError)):
                settings.read_env(link)


if __name__ == '__main__':
    unittest.main()
