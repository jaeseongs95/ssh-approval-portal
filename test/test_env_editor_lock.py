"""Run only in the isolated root Linux fixture after ENV editor setup."""
import fcntl
import hashlib
import os
from pathlib import Path
import subprocess
import unittest


class EnvironmentEditorLock(unittest.TestCase):
    def test_shared_install_lock_rejects_without_mutation(self):
        self.assertEqual(os.geteuid(), 0)
        paths = [Path('/var/lib/ssh-approval-env'),
                 Path('/usr/local/libexec/ssh-approval-environment-helper'),
                 Path('/etc/systemd/system/ssh-approval-env.socket'),
                 Path('/etc/systemd/system/ssh-approval-env@.service')]

        def snapshot():
            return [(str(path), path.stat().st_mtime_ns, path.stat().st_mode,
                     hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None)
                    for path in paths]

        before = snapshot()
        with open('/var/lib/ssh-mcp/.portal-install.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = subprocess.run(['python3', '/source/scripts/portal.py', 'connect', 'env-editor'],
                                    capture_output=True, text=True, timeout=20)
            self.assertNotEqual(result.returncode, 0, 'ENV setup bypassed the shared installation lock')
        self.assertEqual(snapshot(), before, 'ENV setup mutated helper/unit files while locked')
        self.assertNotIn('ENV editor enabled', result.stdout)


if __name__ == '__main__':
    unittest.main()
