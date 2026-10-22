import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('cli_login', Path(__file__).parents[1] / 'scripts/check-agent-cli-login.py')
login = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(login)


@unittest.skipIf(os.geteuid() == 0, 'SSH helper requires a non-root account')
class LoginStatusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cli-login-test-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)

    def binary(self, provider, body):
        binary = self.home / '.local/bin' / provider
        binary.parent.mkdir(parents=True, exist_ok=True)
        binary.write_text('#!/usr/bin/python3\n' + body, encoding='utf-8')
        binary.chmod(0o700)
        return binary

    def test_fixed_arguments_actual_home_and_secret_free_environment(self):
        for provider, args in login.PROVIDERS.items():
            self.binary(provider, "import os,sys,json\nassert sys.argv[1:]==" + repr(args) +
                        "\nassert os.environ['HOME']==" + repr(str(self.home)) +
                        "\nassert os.environ['PATH'].startswith('/opt/ssh-approval/node/bin:')\n" +
                        "assert 'OPENAI_API_KEY' not in os.environ\nassert 'CODEX_HOME' not in os.environ\n" +
                        ("print('Logged in using ChatGPT',file=sys.stderr)\n" if provider == 'codex'
                         else "print(json.dumps({'loggedIn':True,'email':'SYNTHETIC_PRIVATE'}))\n"))
            with patch.dict(os.environ, {'OPENAI_API_KEY': 'SYNTHETIC_PRIVATE', 'CODEX_HOME': '/wrong'}):
                self.assertEqual(login.check(self.home, provider), 'signed_in')

    def test_signed_out_is_distinct_from_vendor_error(self):
        self.binary('codex', "import sys\nprint('Not logged in',file=sys.stderr)\nsys.exit(1)\n")
        self.assertEqual(login.check(self.home, 'codex'), 'signed_out')
        self.binary('codex', "import sys\nprint('SYNTHETIC_PRIVATE error',file=sys.stderr)\nsys.exit(1)\n")
        self.assertEqual(login.check(self.home, 'codex'), 'unavailable')
        self.binary('claude', "import sys\nprint('{\"loggedIn\":false}')\nsys.exit(1)\n")
        self.assertEqual(login.check(self.home, 'claude'), 'signed_out')
        self.binary('claude', "print('{\"loggedIn\":false}')\n")
        self.assertEqual(login.check(self.home, 'claude'), 'unavailable')

    def test_missing_and_unsafe_executables(self):
        with patch.object(login.Path, 'exists', return_value=False), patch.object(login.Path, 'is_symlink', return_value=False):
            self.assertEqual(login.check(self.home, 'codex'), 'not_installed')
        binary = self.binary('codex', "print('ok')\n")
        binary.chmod(0o777)
        with self.assertRaises(ValueError):
            login.check(self.home, 'codex')

    def test_managed_installation_metadata_and_hash(self):
        root = self.home / '.local/share/ssh-approval-cli/codex'
        integrity = 'sha512-test-fixture'
        target = 'versions/1.2.3-' + hashlib.sha256(integrity.encode()).hexdigest()[:16]
        prefix = root / target
        (prefix / 'bin').mkdir(parents=True)
        for directory in (root, root / 'versions', prefix):
            directory.chmod(0o700)
        binary = prefix / 'bin/codex'
        binary.write_text('#!/usr/bin/python3\nprint("ok")\n', encoding='utf-8')
        binary.chmod(0o700)
        metadata = prefix / '.installed.json'
        metadata.write_text(json.dumps({'provider': 'codex', 'version': '1.2.3', 'integrity': integrity,
                                        'executableSha256': hashlib.sha256(binary.read_bytes()).hexdigest()}), encoding='utf-8')
        metadata.chmod(0o600)
        (root / 'current').symlink_to(target)
        self.assertEqual(login.check(self.home, 'codex'), 'signed_in')
        binary.write_text('#!/usr/bin/python3\nprint("modified")\n', encoding='utf-8')
        with self.assertRaises(ValueError):
            login.check(self.home, 'codex')

    def test_output_limit_and_timeout_are_bounded_and_reaped(self):
        self.binary('codex', "print('x'*9000)\n")
        with self.assertRaises(ValueError):
            login.check(self.home, 'codex')
        self.binary('codex', "import time\ntime.sleep(30)\n")
        with patch.object(login, 'TIMEOUT', 0.2), self.assertRaises(ValueError):
            login.check(self.home, 'codex')

    def test_main_never_emits_vendor_error_or_account_fields(self):
        from io import StringIO
        output = StringIO()
        with patch.object(login.sys, 'argv', ['helper', 'claude']), patch.object(login, 'check', side_effect=RuntimeError('SYNTHETIC_PRIVATE')), patch('sys.stdout', output):
            login.main()
        self.assertEqual(json.loads(output.getvalue()), {'provider': 'claude', 'state': 'unavailable'})
        self.assertNotIn('SYNTHETIC_PRIVATE', output.getvalue())


if __name__ == '__main__':
    unittest.main()
