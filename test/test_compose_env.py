import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


HELPER = Path(__file__).resolve().parents[1] / 'scripts/compose-env.py'
DEFAULT_IMAGE = 'ssh-approval-portal:' + json.loads((HELPER.parents[1] / 'package.json').read_text(encoding='utf-8'))['version']


class ComposeEnvironment(unittest.TestCase):
    def run_helper(self, path):
        return subprocess.run([sys.executable, str(HELPER), str(path), '10001', '10002'],
                              capture_output=True, text=True, timeout=10)

    def assert_prepared(self, before, expected):
        with tempfile.TemporaryDirectory(prefix='compose-env-test-') as directory:
            path = Path(directory) / 'compose.env'
            path.write_bytes(before.encode('utf-8'))
            path.chmod(0o600)
            result = self.run_helper(path)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(path.read_bytes(), expected.encode('utf-8'))
            again = self.run_helper(path)
            self.assertEqual(again.returncode, 0, again.stderr)
            self.assertEqual(path.read_bytes(), expected.encode('utf-8'), 'Preparation must be idempotent')

    def test_supported_assignment_styles_preserve_image_comments_and_options(self):
        for separator in ['=', ' = ', ': ']:
            for newline in ['\n', '\r\n']:
                with self.subTest(separator=separator, newline=repr(newline)):
                    suffix = newline.join(['# administrator note',
                                          'BRIDGE_IMAGE' + separator + 'registry.example/portal@sha256:' + 'a' * 64,
                                          'COMPOSE_PROFILES=preserved', 'EXTRA="unchanged # text"', ''])
                    self.assert_prepared('BRIDGE_UID' + separator + '11 # uid note' + newline +
                                         'BRIDGE_GID' + separator + '12' + newline + suffix,
                                         'BRIDGE_UID' + separator + '10001 # uid note' + newline +
                                         'BRIDGE_GID' + separator + '10002' + newline + suffix)

    def test_export_quoted_and_duplicate_ids_only_replace_values(self):
        suffix = 'export BRIDGE_IMAGE = "registry.example/portal:pinned" # image note\n'
        self.assert_prepared(" export BRIDGE_UID = '11' # uid\nBRIDGE_UID: 11\n\tBRIDGE_GID = \"12\"\n" + suffix,
                             ' export BRIDGE_UID = 10001 # uid\nBRIDGE_UID: 10001\n\tBRIDGE_GID = 10002\n' + suffix)

    def test_multiline_options_are_not_interpreted_as_settings(self):
        for quote in ["'", '"']:
            with self.subTest(quote=quote):
                extra = 'EXTRA=' + quote + 'first\\' + quote + '\nBRIDGE_UID=77\nBRIDGE_IMAGE=not-an-image\nlast' + quote + '\n'
                self.assert_prepared(extra + 'BRIDGE_UID=11\nBRIDGE_GID=12',
                                     extra + f'BRIDGE_UID=10001\nBRIDGE_GID=10002\nBRIDGE_IMAGE={DEFAULT_IMAGE}\n')

    def test_missing_keys_append_without_joining_the_last_line(self):
        self.assert_prepared('EXTRA=kept', f'EXTRA=kept\nBRIDGE_UID=10001\nBRIDGE_GID=10002\nBRIDGE_IMAGE={DEFAULT_IMAGE}\n')
        self.assert_prepared('BRIDGE_UID=11\nBRIDGE_GID=12',
                             f'BRIDGE_UID=10001\nBRIDGE_GID=10002\nBRIDGE_IMAGE={DEFAULT_IMAGE}\n')

    def test_image_update_replaces_only_values_in_all_supported_assignments(self):
        for declaration in ['BRIDGE_IMAGE=', 'BRIDGE_IMAGE = ', 'BRIDGE_IMAGE: ', 'export BRIDGE_IMAGE = ']:
            with self.subTest(declaration=declaration), tempfile.TemporaryDirectory(prefix='compose-image-test-') as directory:
                path = Path(directory) / 'compose.env'
                original = '# preserve\r\n' + declaration + '"registry.example/old:pinned" # image\r\nEXTRA=unchanged\r\n'
                path.write_bytes(original.encode('utf-8'))
                result = subprocess.run([sys.executable, str(HELPER), 'image', str(path), 'sha256:' + 'a' * 64],
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(path.read_bytes(), original.replace('"registry.example/old:pinned"', 'sha256:' + 'a' * 64).encode('utf-8'))
                before = path.read_bytes()
                invalid = subprocess.run([sys.executable, str(HELPER), 'image', str(path), 'bad\nEXTRA=changed'],
                                         capture_output=True, text=True, timeout=10)
                self.assertNotEqual(invalid.returncode, 0)
                self.assertEqual(path.read_bytes(), before)

    @unittest.skipIf(os.name == 'nt', 'Unix ownership and mode require Linux')
    def test_existing_owner_and_private_mode_are_preserved(self):
        with tempfile.TemporaryDirectory(prefix='compose-owner-test-') as directory:
            path = Path(directory) / 'compose.env'
            path.write_text('BRIDGE_IMAGE=registry.example/portal:pinned\n', encoding='utf-8')
            if os.geteuid() == 0:
                os.chown(path, 12345, 12346)
            before = path.stat()
            result = self.run_helper(path)
            self.assertEqual(result.returncode, 0, result.stderr)
            after = path.stat()
            self.assertEqual((after.st_uid, after.st_gid), (before.st_uid, before.st_gid))
            self.assertEqual(after.st_mode & 0o777, 0o600)
            self.assertEqual(list(Path(directory).iterdir()), [path])


if __name__ == '__main__':
    unittest.main()
