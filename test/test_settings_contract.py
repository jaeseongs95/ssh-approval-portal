import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess

spec = importlib.util.spec_from_file_location('settings_contract', Path(__file__).resolve().parents[1] / 'scripts/settings_contract.py')
settings = importlib.util.module_from_spec(spec)
spec.loader.exec_module(settings)


class SettingsContract(unittest.TestCase):
    def test_shared_upload_host_vectors(self):
        for vector in settings.contract['uploadHostVectors']:
            with self.subTest(value=vector['value']):
                if vector.get('valid') is False:
                    with self.assertRaises(ValueError):
                        settings.validate_upload_hosts(vector['value'])
                else:
                    self.assertEqual(settings.validate_upload_hosts(vector['value']), vector['expected'])
        for invalid in [None, 'x' * 65537]:
            with self.assertRaises(ValueError):
                settings.validate_upload_hosts(invalid)

    def test_shared_origin_and_port_vectors(self):
        for kind, validator in [('origin', settings.validate_origin), ('port', settings.validate_port)]:
            for vector in settings.contract[kind + 'Vectors']:
                with self.subTest(kind=kind, value=vector['value']):
                    if vector['valid']:
                        self.assertEqual(validator(vector['value']), vector['value'] if kind == 'origin' else int(vector['value']))
                    else:
                        with self.assertRaises((ValueError, OSError)):
                            validator(vector['value'])

    def test_origin_adapter_uses_stdin_and_checks_exact_bounded_output(self):
        value = 'https://xn--fa-hia.example'
        good = subprocess.CompletedProcess([], 0, stdout=value.encode('utf-8'))
        with patch.object(settings.Path, 'is_file', return_value=False), patch.object(settings.shutil, 'which', return_value='/trusted/node'), patch.object(settings.subprocess, 'run', return_value=good) as run:
            self.assertEqual(settings.validate_origin(value), value)
            args, options = run.call_args
            self.assertEqual(args[0], ['/trusted/node', str(Path(settings.__file__).with_name('validate-origin.mjs'))])
            self.assertEqual(options['input'], value.encode('utf-8'))
            self.assertIs(options['shell'], False)
            self.assertEqual(options['timeout'], 5)
            self.assertNotIn('NODE_OPTIONS', options['env'])
            self.assertNotIn('NODE_PATH', options['env'])
        with patch.object(settings.Path, 'is_file', return_value=True), patch.object(settings.subprocess, 'run', return_value=good) as run:
            self.assertEqual(settings.validate_origin(value), value)
            self.assertEqual(run.call_args.args[0][0], str(Path('/opt/ssh-approval/node/bin/node')))
        for response in [subprocess.CompletedProcess([], 1, stdout=b''), subprocess.CompletedProcess([], 0, stdout=b'https://different.example'), subprocess.CompletedProcess([], 0, stdout=value.encode('utf-8') + b'\n'), subprocess.CompletedProcess([], 0, stdout=b'x' * (settings.contract['originMaxBytes'] + 1))]:
            with self.subTest(returncode=response.returncode, size=len(response.stdout)), patch.object(settings.subprocess, 'run', return_value=response):
                with self.assertRaisesRegex(ValueError, '^Configure one canonical HTTPS administrator origin$'):
                    settings.validate_origin(value)
        with patch.object(settings.subprocess, 'run', side_effect=subprocess.TimeoutExpired('node', 5)):
            with self.assertRaisesRegex(ValueError, '^Configure one canonical HTTPS administrator origin$'):
                settings.validate_origin(value)
        with patch.object(settings.subprocess, 'run') as run:
            with self.assertRaises(ValueError):
                settings.validate_origin('x' * (settings.contract['originMaxBytes'] + 1))
            run.assert_not_called()

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
