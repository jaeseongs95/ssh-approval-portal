"""Fresh-host acceptance cases. Execute on CI/TEST, never the local product host.

Requirement -> oracle: stopped/broken installations are rejected without changing
their bytes; empty hosts and existing keys are accepted; first deployment requests
fresh_install=True and preserves the executor's asynchronous result. Host account,
APT, SSH, systemd, key authorization and runtime provisioning require TEST coverage.
"""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('deployment_bootstrap', SOURCE / 'scripts/deployment-bootstrap.py')
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


class FreshBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.base = self.root / 'host'
        self.base.mkdir()
        self.environment = self.root / 'bridge.env'
        self.unit = self.root / 'bridge.service'
        # Other host markers are absent in an isolated CI fixture, irrespective of
        # whether the runner itself happens to have a system service installed.
        actual = bootstrap.exists
        self.paths = patch.object(bootstrap, 'exists', side_effect=lambda path: actual(path) if self.root in Path(path).parents or Path(path) == self.root else False)
        self.paths.start()
        self.addCleanup(self.paths.stop)

    def check(self):
        bootstrap.require_fresh_installation(self.base, self.environment, self.unit)

    def test_empty_host_and_preexisting_private_key_are_accepted_unchanged(self):
        self.check()
        keys = self.base / '.ssh'
        keys.mkdir()
        private = keys / 'id_ed25519'
        private.write_bytes(b'existing-private-key')
        self.check()
        self.assertEqual(private.read_bytes(), b'existing-private-key')

    def test_every_managed_marker_refuses_before_mutation(self):
        for relative in ['app', 'deployments', 'data', 'transfers', '.config/ssh-mcp/config.toml', '.local/share/ssh-mcp']:
            with self.subTest(marker=relative):
                marker = self.base / relative
                marker.parent.mkdir(parents=True, exist_ok=True)
                marker.write_bytes(b'preserved')
                with self.assertRaisesRegex(ValueError, 'deploy plan/apply/status/resume'):
                    self.check()
                self.assertEqual(marker.read_bytes(), b'preserved')
                marker.unlink()
        for marker in [self.environment, self.unit]:
            marker.write_bytes(b'secret-or-custom-unit')
            with self.assertRaisesRegex(ValueError, 'Existing installation'):
                self.check()
            self.assertEqual(marker.read_bytes(), b'secret-or-custom-unit')
            marker.unlink()

    @unittest.skipUnless(os.name == 'posix', 'Linux provisioning path policy')
    def test_dangling_existing_installation_link_is_rejected(self):
        (self.base / 'app').symlink_to(self.base / 'missing', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'Existing installation'):
            self.check()
        self.assertTrue((self.base / 'app').is_symlink())

    @unittest.skipUnless(os.name == 'posix', 'Linux provisioning path policy')
    def test_ssh_destination_link_and_hardlinked_key_are_rejected(self):
        keys = self.base / '.ssh'
        outside = self.root / 'outside'
        outside.mkdir()
        keys.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'Unsafe provisioning'):
            self.check()
        keys.unlink()
        keys.mkdir()
        original = outside / 'key'
        original.write_bytes(b'preserved')
        os.link(original, keys / 'id_ed25519')
        with self.assertRaisesRegex(ValueError, 'Unsafe provisioning'):
            self.check()
        self.assertEqual(original.read_bytes(), b'preserved')

    def test_orphan_public_key_is_not_overwritten(self):
        keys = self.base / '.ssh'
        keys.mkdir()
        (keys / 'id_ed25519.pub').write_bytes(b'old-public-key')
        with self.assertRaisesRegex(ValueError, 'without its private key'):
            self.check()

    def test_first_deployment_is_explicitly_fresh_and_not_reported_complete(self):
        entry = Mock()
        engine = entry.install_executor.return_value
        engine.create_plan.return_value = {'jobId': 'deploy-job'}
        engine.apply_plan.return_value = {'jobId': 'deploy-job', 'state': 'QUEUED'}
        with patch.object(bootstrap, 'entry_module', return_value=entry):
            result = bootstrap.start(SOURCE, 'a' * 64)
        entry.install_executor.assert_called_once_with(SOURCE, 'a' * 64)
        engine.create_plan.assert_called_once_with(SOURCE, manifest_sha256='a' * 64, fresh_install=True)
        engine.apply_plan.assert_called_once_with({'jobId': 'deploy-job'})
        self.assertEqual(result, {'jobId': 'deploy-job', 'state': 'QUEUED'})

    def test_executor_failure_never_enqueues_a_job(self):
        entry = Mock()
        entry.install_executor.side_effect = ValueError('MANIFEST_PIN_MISMATCH')
        with patch.object(bootstrap, 'entry_module', return_value=entry):
            with self.assertRaisesRegex(ValueError, 'MANIFEST_PIN_MISMATCH'):
                bootstrap.start(SOURCE, 'a' * 64)
        entry.install_executor.return_value.create_plan.assert_not_called()

    def test_existing_installation_never_loads_or_executes_the_deployment_entry(self):
        with patch.object(bootstrap, 'require_fresh_installation', side_effect=ValueError('Existing installation')), patch.object(bootstrap.os, 'geteuid', return_value=0, create=True), patch.object(bootstrap, 'entry_module') as entry:
            with self.assertRaisesRegex(ValueError, 'Existing installation'):
                bootstrap.main(['preflight', '--source', str(SOURCE), '--manifest-sha256', 'a' * 64])
        entry.assert_not_called()


if __name__ == '__main__':
    unittest.main()
