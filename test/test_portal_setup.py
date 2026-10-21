import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('portal', SOURCE / 'scripts/portal.py')
portal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portal)


class PortalWorkflow(unittest.TestCase):
    def test_real_cli_dry_run_needs_no_root_or_installed_runtime(self):
        result = subprocess.run([sys.executable, str(SOURCE / 'scripts/portal.py'),
                                 'install', '--admin-origin', 'https://example.test', '--dry-run'],
                                capture_output=True, text=True, encoding='utf-8', check=True)
        work = json.loads(result.stdout)
        self.assertEqual(work['status'], 'DRY_RUN')
        self.assertEqual(work['steps'][0]['argv'][-2:], ['--admin-origin', 'https://example.test'])
        self.assertFalse(work['sudoGrantRequested'])

    def test_all_plans_do_not_execute_or_require_linux_root(self):
        cases = [['install'], ['update'], ['verify'], ['status'], ['connect', 'access'], ['connect', 'oidc'],
                 ['connect', 'upload-sources'], ['connect', 'env-editor'],
                 ['policy', '--admin-origin', 'https://example.test'],
                 ['rollback', '/var/lib/ssh-mcp/app/backups/prior']]
        for args in cases:
            with self.subTest(args=args), patch.object(portal, 'execute') as execute, \
                    patch.object(portal.sys, 'platform', 'win32'), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(portal.main([*args, '--dry-run']), 0)
                execute.assert_not_called()

    def test_oidc_reuses_owner_transaction_and_rejects_cloudflare_only_options(self):
        work = portal.plan(portal.arguments(['connect', 'oidc']))
        self.assertEqual(work['steps'][0]['argv'][-2:], [str(SOURCE/'scripts/configure-admin-access.sh'), '--oidc'])
        self.assertTrue(work['interactive'])
        self.assertEqual([step['name'] for step in work['steps']], ['oidc', 'package', 'health'])
        self.assertEqual(portal.plan(portal.arguments(['connect', 'access']))['steps'][0]['argv'], ['bash', str(SOURCE/'scripts/configure-admin-access.sh')])
        for option in ['--apply', '--connector', '--restore-environment', '--install-cloudflared', '--sync-server']:
            with self.subTest(option=option), self.assertRaises(ValueError):
                portal.plan(portal.arguments(['connect', 'oidc', option]))

    def test_update_never_forwards_install_only_authority_or_origin(self):
        work = portal.plan(portal.arguments(['update']))
        self.assertEqual(len(work['steps'][0]['argv']), 2)
        self.assertTrue(work['settingsPreserved'])
        for option in ['--grant-sudo-all', '--admin-origin']:
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                portal.arguments(['update', option])

    def test_sudo_is_explicit_and_passed_once(self):
        work = portal.plan(portal.arguments(['install', '--grant-sudo-all']))
        self.assertTrue(work['sudoGrantRequested'])
        self.assertEqual(work['steps'][0]['argv'].count('--grant-sudo-all'), 1)

    def test_origin_shapes_reject_credential_path_port_and_control_input(self):
        for origin in ['', 'http://example.test', 'https://user:secret@example.test',
                       'https://example.test/path', 'https://example.test?token=secret',
                       'https://example.test#fragment', 'https://example.test:no',
                       'https://example.test:70000', 'https://example.test\n']:
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                portal.plan(portal.arguments(['install', '--admin-origin', origin]))

    def test_failure_stops_before_later_steps_and_never_retries(self):
        calls = []
        def fail(argv, check):
            calls.append(argv)
            raise subprocess.CalledProcessError(23, argv)
        result = portal.execute(portal.plan(portal.arguments(['update'])), fail)
        self.assertEqual(result, {'status': 'FAILED', 'step': 'update', 'exitCode': 23})
        self.assertEqual(len(calls), 1)

    def test_verification_failure_does_not_repeat_successful_mutation(self):
        calls = []
        def fail_second(argv, check):
            calls.append(argv)
            if len(calls) == 2:
                raise subprocess.CalledProcessError(1, argv)
        result = portal.execute(portal.plan(portal.arguments(['install'])), fail_second)
        self.assertEqual(result['step'], 'package')
        self.assertEqual(len(calls), 2)

    def test_rollback_uses_existing_restore_and_verifies_restored_health(self):
        backup = '/var/lib/ssh-mcp/app/backups/prior'
        work = portal.plan(portal.arguments(['rollback', backup]))
        self.assertEqual(work['steps'][0]['argv'][-1], backup)
        self.assertTrue(work['steps'][0]['argv'][1].endswith('rollback.sh'))
        self.assertEqual([s['name'] for s in work['steps']], ['rollback', 'health'])
        for bad in ['/tmp/backup', '/var/lib/ssh-mcp/app/backups',
                    '/var/lib/ssh-mcp/app/backups/../outside',
                    '/var/lib/ssh-mcp/app/backups/a/nested', 'relative']:
            with self.subTest(path=bad), self.assertRaises(ValueError):
                portal.plan(portal.arguments(['rollback', bad]))

    def test_policy_reports_owner_action_instead_of_claiming_saved_or_enabling(self):
        with patch.object(portal, 'execute') as execute, contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(portal.main(['policy', '--admin-origin', 'https://example.test']), 3)
            execute.assert_not_called()
        result = json.loads(out.getvalue())
        self.assertEqual(result['status'], 'ACTION_REQUIRED')
        self.assertEqual(result['url'], 'https://example.test/settings')

    def test_mutation_rejects_unsupported_environment_before_execution(self):
        with patch.object(portal.sys, 'platform', 'win32'), patch.object(portal, 'execute') as execute:
            with self.assertRaises(ValueError):
                portal.main(['install'])
            execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
