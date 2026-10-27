"""Root-only isolated CI fixture. Never use on TEST or production hosts."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from controller import Identity
from linux_adapter import LinuxAdapter
import scope_guard


class RealLinuxFixture(unittest.TestCase):
    def setUp(self):
        if os.geteuid() != 0:
            self.skipTest('root-only isolated Linux fixture')
        self.temp = tempfile.TemporaryDirectory(prefix='ssh-portal-rollout-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        unit = os.environ.get('SSH_ROLLOUT_FIXTURE_UNIT', '')
        if not unit.startswith('ssh-rollout-fixture-') or not unit.endswith('.service'):
            self.skipTest('dedicated fixture unit not supplied')
        self.a = LinuxAdapter(self.root, self.root / 'source', self.root / 'old', self.root / 'new',
                              Path('/usr/bin/node'), self.root / 'state', [], self.root / 'audit',
                              command_enabled=True, cli_enabled=True, independent_channel=True,
                              mcp_port=39124, candidate_version='fixture', unit_name=unit)
        self.i = Identity('fixture', 'fixture-host', 'a' * 64, 'b' * 64, 'c' * 64)

    def test_systemd_invocation_changes_after_restart_and_stop_is_observed(self):
        old = self.a._instance()
        subprocess.run(['/usr/bin/systemctl', 'restart', self.a.unit_name], check=True, timeout=30)
        new = self.a._instance()
        self.assertNotEqual(old, new)
        self.a.stop_and_prove(self.i, new)
        with self.assertRaises(RuntimeError):
            self.a._instance()

    def test_helper_replace_and_verified_restore_on_real_linux_files(self):
        self.a.helper = self.root / 'environment-helper'
        self.a.helper.write_bytes(b'old helper')
        self.a.helper.chmod(0o755)
        for release, contents in ((self.a.old, b'old helper'), (self.a.new, b'new helper')):
            (release / 'helper').mkdir(parents=True)
            (release / 'helper/environment-helper.py').write_bytes(contents)
        self.a.protected_files = [self.a.helper]
        self.a.baseline = {'paths': scope_guard.snapshot(self.a.protected_files)}
        backup, old_digest, new_digest = self.a._replace_helper()
        self.assertEqual(b'old helper', backup.read_bytes())
        self.assertEqual(b'new helper', self.a.helper.read_bytes())
        self.assertEqual(0o755, self.a.helper.stat().st_mode & 0o777)
        self.a._install_helper(backup, old_digest, new_digest)
        self.assertEqual(b'old helper', self.a.helper.read_bytes())

if __name__ == '__main__':
    unittest.main()
