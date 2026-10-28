import tempfile
import unittest
from unittest import mock
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

    def test_internal_hardlinks_are_accepted_and_external_hardlinks_rejected(self):
        import os
        with tempfile.TemporaryDirectory() as root:
            protected = Path(root) / 'protected'
            protected.mkdir()
            first = protected / 'claude.exe'
            second = protected / 'claude'
            first.write_bytes(b'binary-payload')
            os.link(first, second)
            before = snapshot([protected])
            verify([protected], before)
            outside = Path(root) / 'outside-link'
            os.link(first, outside)
            with self.assertRaisesRegex(RuntimeError, 'unsupported protected path'):
                snapshot([protected])

    def test_external_hardlink_added_after_baseline_fails_verify(self):
        import os
        with tempfile.TemporaryDirectory() as root:
            protected = Path(root) / 'protected'
            protected.mkdir()
            first = protected / 'a'
            first.write_bytes(b'payload')
            os.link(first, protected / 'b')
            before = snapshot([protected])
            os.link(first, Path(root) / 'outside-link')
            with self.assertRaises(RuntimeError):
                verify([protected], before)

    def test_hardlinked_bytes_count_once_against_budget(self):
        import os
        import scope_guard
        with tempfile.TemporaryDirectory() as root:
            protected = Path(root) / 'protected'
            protected.mkdir()
            (protected / 'a').write_bytes(b'x' * 6)
            os.link(protected / 'a', protected / 'b')
            with mock.patch.object(scope_guard, 'MAX_BYTES', 10):
                snapshot([protected])  # 6 bytes once, not 12
                (protected / 'c').write_bytes(b'y' * 5)
                with self.assertRaisesRegex(RuntimeError, 'protected data budget exceeded'):
                    snapshot([protected])

    def test_budget_boundary_is_inclusive(self):
        import scope_guard
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / 'file'
            target.write_bytes(b'z' * 8)
            with mock.patch.object(scope_guard, 'MAX_BYTES', 8):
                snapshot([target])
            with mock.patch.object(scope_guard, 'MAX_BYTES', 7):
                with self.assertRaisesRegex(RuntimeError, 'protected data budget exceeded'):
                    snapshot([target])

    def test_hardlink_changed_between_links_is_rejected(self):
        import os
        with tempfile.TemporaryDirectory() as root:
            protected = Path(root) / 'protected'
            protected.mkdir()
            first, second = protected / 'a', protected / 'b'
            first.write_bytes(b'payload')
            os.link(first, second)
            original, seen = Path.lstat, set()

            def lstat(path):
                # Grow the shared inode just before the second link is examined.
                other = {'a': 'b', 'b': 'a'}.get(path.name)
                if other in seen and path.name not in seen:
                    with open(first, 'ab') as handle:
                        handle.write(b'more')
                seen.add(path.name)
                return original(path)

            with mock.patch.object(Path, 'lstat', lstat):
                with self.assertRaisesRegex(RuntimeError, 'hardlink'):
                    snapshot([protected])

if __name__ == '__main__':
    unittest.main()
