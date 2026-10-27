import tempfile
import unittest
from pathlib import Path

from scope_guard import snapshot, verify


class ProtectedScope(unittest.TestCase):
    def test_existing_files_and_directory_members_are_checked(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / 'settings'
            directory.mkdir()
            member = directory / 'credential'
            member.write_text('fixture', encoding='utf-8')
            before = snapshot([directory])
            verify([directory], before)
            member.write_text('changed', encoding='utf-8')
            with self.assertRaises(RuntimeError):
                verify([directory], before)
            member.write_text('fixture', encoding='utf-8')
            (directory / 'new').touch()
            with self.assertRaises(RuntimeError):
                verify([directory], before)

    def test_missing_entry_appearing_is_not_accepted(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / 'missing'
            before = snapshot([target])
            target.write_text('new', encoding='utf-8')
            with self.assertRaises(RuntimeError):
                verify([target], before)

if __name__ == '__main__':
    unittest.main()
