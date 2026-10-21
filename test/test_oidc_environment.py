"""Real shell/Node ENV transactions; synthetic systemd and loopback HTTP only."""
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_cloudflare_environment as fixture


class OidcNative(fixture.NativeHelper):
    def setUp(self):
        super().setUp()
        self.values = {'BRIDGE_OIDC_ISSUER': 'https://accounts.google.com',
            'BRIDGE_OIDC_JWKS_URL': 'https://www.googleapis.com/oauth2/v3/certs',
            'BRIDGE_OIDC_CLIENT_ID': 'synthetic.apps.googleusercontent.com',
            'BRIDGE_OIDC_OWNER_EMAILS': 'owner@example.test'}

        def run(values, restore=False, stage=None):
            mode = '--restore-owned-oidc' if restore else '--link-owned-oidc'
            args = ([fixture.ce.NODE, str(fixture.ce.ACTIVE/'scripts/admin-access-config.mjs'),
                     str(fixture.cc.ENV), str(stage), mode] if stage is not None else
                    ['/usr/bin/bash', str(fixture.ce.ACTIVE/'scripts/configure-admin-access.sh'), mode])
            result = subprocess.run(args, input=json.dumps(values).encode(), stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, timeout=60)
            if result.returncode:
                raise fixture.cp.ProvisionFailure('ENVIRONMENT_ACTION_FAILED_REVIEW_REQUIRED')
        binding = patch.object(fixture.ce, 'run_access', side_effect=run)
        binding.start()
        self.addCleanup(binding.stop)

    def test_public_oidc_session_is_rejected_and_original_env_restored(self):
        self.stage()
        (self.flags/'bad-oidc-session').touch()
        with self.assertRaisesRegex(fixture.cp.ProvisionFailure, 'ACTION_FAILED'):
            fixture.ce.run_access(self.payload)
        self.assertEqual(fixture.cc.ENV.read_bytes(), self.original)
        self.assertEqual(self.restart_calls(), 2)
        self.assertEqual(self.events, [('reserve', 200), ('release', 200)])

    def test_public_oidc_requests_are_rejected_and_original_env_restored(self):
        self.stage()
        (self.flags/'bad-oidc-requests').touch()
        with self.assertRaisesRegex(fixture.cp.ProvisionFailure, 'ACTION_FAILED'):
            fixture.ce.run_access(self.payload)
        self.assertEqual(fixture.cc.ENV.read_bytes(), self.original)
        self.assertEqual(self.restart_calls(), 2)
        self.assertEqual(self.events, [('reserve', 200), ('release', 200)])


def load_tests(loader, tests, pattern):
    # Reuse the five protocol-neutral transaction cases. The Access-specific
    # session and TERM scenarios remain in their original suite.
    names = ['test_real_shell_link_restore_backups_and_private_files_preserve_exact_original',
        'test_reservation_denial_is_before_live_write_backup_or_restart',
        'test_restart_failure_restores_backup_and_releases_reservation',
        'test_owner_edit_during_reservation_is_preserved_before_any_live_replace',
        'test_owner_edit_during_failed_restart_is_not_overwritten_by_recovery',
        'test_public_oidc_session_is_rejected_and_original_env_restored',
        'test_public_oidc_requests_are_rejected_and_original_env_restored']
    return unittest.TestSuite(OidcNative(name) for name in names)


if __name__ == '__main__':
    unittest.main()
