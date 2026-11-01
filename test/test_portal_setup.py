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
PIN = 'a' * 64
spec = importlib.util.spec_from_file_location('portal', SOURCE / 'scripts/portal.py')
portal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portal)


class PortalWorkflow(unittest.TestCase):
    def test_real_cli_dry_run_needs_no_root_or_installed_runtime(self):
        result = subprocess.run([sys.executable, str(SOURCE / 'scripts/portal.py'),
                                 'install', '--manifest-sha256', PIN,
                                 '--admin-origin', 'https://example.test', '--dry-run'],
                                capture_output=True, text=True, encoding='utf-8', check=True, timeout=10)
        work = json.loads(result.stdout)
        self.assertEqual(work['status'], 'DRY_RUN')
        self.assertEqual(work['steps'][0]['argv'][-2:], ['--admin-origin', 'https://example.test'])
        self.assertFalse(work['sudoGrantRequested'])
        self.assertEqual(len(work['steps']), 1)
        self.assertIn('--manifest-sha256', work['steps'][0]['argv'])

    def test_all_plans_do_not_execute_or_require_linux_root(self):
        cases = [['install', '--manifest-sha256', PIN], ['verify'], ['status'], ['connect', 'access'], ['connect', 'oidc'],
                 ['connect', 'upload-sources'], ['connect', 'env-editor'],
                 ['policy', '--admin-origin', 'https://example.test']]
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

    def test_removed_update_and_rollback_are_rejected_by_real_cli(self):
        for args in [['update', '--dry-run'], ['rollback', '/var/lib/ssh-mcp/app/backups/prior', '--dry-run']]:
            with self.subTest(args=args):
                result = subprocess.run([sys.executable, '-B', str(SOURCE / 'scripts/portal.py'), *args],
                                        capture_output=True, text=True, encoding='utf-8', timeout=10)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, '')
                self.assertNotIn('Traceback', result.stderr)

    def test_install_pin_and_deploy_subcommand_inputs_are_mandatory(self):
        for args in [['install'], ['deploy'], ['deploy', 'plan'], ['deploy', 'plan', '--source', '/root/source'],
                     ['deploy', 'apply'], ['deploy', 'status'], ['deploy', 'resume'],
                     ['deploy', 'status', '--job-id', 'deploy-' + 'a' * 32, '--dry-run']]:
            with self.subTest(args=args), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                portal.arguments(args)
            self.assertEqual(error.exception.code, 2)

    def test_invalid_manifest_pins_do_not_create_install_work(self):
        for pin in ['', 'A' * 64, 'a' * 63, '../source', 'g' * 64]:
            with self.subTest(pin=pin), self.assertRaises(ValueError):
                portal.plan(portal.arguments(['install', '--manifest-sha256', pin]))

    def test_deploy_arguments_preserve_literal_source_pin_plan_and_job(self):
        source = '/root/source with spaces;$(false)'
        options = portal.arguments(['deploy', 'plan', '--source', source, '--manifest-sha256', PIN, '--import-legacy'])
        self.assertEqual((options.action, options.deployment_action, options.source, options.manifest_sha256,
                          options.import_legacy), ('deploy', 'plan', source, PIN, True))
        self.assertFalse(portal.arguments(['deploy', 'plan', '--source', source,
                                          '--manifest-sha256', PIN]).import_legacy)
        plan = '/var/lib/ssh-mcp/deployments/plans/deploy-' + 'a' * 32 + '.json'
        self.assertEqual(portal.arguments(['deploy', 'apply', '--plan', plan]).plan, plan)
        for action in ['status', 'resume']:
            options = portal.arguments(['deploy', action, '--job-id', 'deploy-' + 'a' * 32])
            self.assertEqual((options.deployment_action, options.job_id), (action, 'deploy-' + 'a' * 32))

    def test_sudo_is_explicit_and_passed_once(self):
        work = portal.plan(portal.arguments(['install', '--manifest-sha256', PIN, '--grant-sudo-all']))
        self.assertTrue(work['sudoGrantRequested'])
        self.assertEqual(work['steps'][0]['argv'].count('--grant-sudo-all'), 1)

    def test_origin_shapes_reject_credential_path_port_and_control_input(self):
        for origin in ['', 'http://example.test', 'https://user:secret@example.test',
                       'https://example.test/path', 'https://example.test?token=secret',
                       'https://example.test#fragment', 'https://example.test:no',
                       'https://example.test:70000', 'https://example.test\n']:
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                portal.plan(portal.arguments(['install', '--manifest-sha256', PIN, '--admin-origin', origin]))

    def test_failure_stops_before_later_steps_and_never_retries(self):
        calls = []
        def fail(argv, check):
            calls.append(argv)
            raise subprocess.CalledProcessError(23, argv)
        result = portal.execute(portal.plan(portal.arguments(['install', '--manifest-sha256', PIN])), fail)
        self.assertEqual(result, {'status': 'FAILED', 'step': 'install', 'exitCode': 23})
        self.assertEqual(len(calls), 1)

    def test_successful_install_is_only_accepted_and_does_not_race_worker_health(self):
        calls = []
        def accept(argv, check):
            calls.append(argv)
        result = portal.execute(portal.plan(portal.arguments(['install', '--manifest-sha256', PIN])), accept)
        self.assertEqual(result, {'status': 'ACCEPTED', 'action': 'install'})
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0][1].endswith('install.sh'))

    def test_deploy_refusal_is_structured_and_does_not_claim_completion(self):
        for args in [['deploy', 'plan', '--source', '/root/source', '--manifest-sha256', PIN],
                     ['deploy', 'apply', '--plan', '/tmp/plan.json'],
                     ['deploy', 'status', '--job-id', 'deploy-' + 'a' * 32],
                     ['deploy', 'resume', '--job-id', 'deploy-' + 'a' * 32]]:
            with self.subTest(args=args), patch.object(portal.sys, 'platform', 'win32'), \
                    patch.object(portal, 'execute') as execute, contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(portal.main(args), 1)
                execute.assert_not_called()
                self.assertEqual(json.loads(output.getvalue())['state'], 'REFUSED')

    def test_deploy_needs_review_and_failed_are_unsuccessful_without_retry(self):
        for state, expected in [('NEEDS_REVIEW', 1), ('FAILED', 1), ('PLANNED', 0), ('ACCEPTED', 0), ('PASS', 0)]:
            with self.subTest(state=state), patch.object(portal, 'deployment_command', return_value={'state': state}) as command, \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(portal.main(['deploy', 'status', '--job-id', 'deploy-' + 'a' * 32]), expected)
                self.assertEqual(json.loads(output.getvalue()), {'state': state})
                command.assert_called_once()

    @unittest.skipUnless(sys.platform == 'linux', '실제 Linux root 진입점 검사')
    def test_root_deploy_import_rejects_outside_plan_and_invalid_job_without_mutation(self):
        import os
        if os.geteuid() != 0:
            self.skipTest('격리 Linux root 작업에서 실제 진입점 실행')
        cases = [['deploy', 'apply', '--plan', '/tmp/plan.json'],
                 ['deploy', 'apply', '--plan', 'relative.json'],
                 ['deploy', 'apply', '--plan', '/var/lib/ssh-mcp/deployments/plans/nested/plan.json'],
                 ['deploy', 'status', '--job-id', '../outside'],
                 ['deploy', 'resume', '--job-id', 'deploy-' + 'A' * 32]]
        for args in cases:
            with self.subTest(args=args):
                result = subprocess.run([sys.executable, '-I', '-B', str(SOURCE / 'scripts/portal.py'), *args],
                                        capture_output=True, text=True, encoding='utf-8', timeout=10)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(json.loads(result.stdout)['state'], 'REFUSED')
                self.assertNotIn('Traceback', result.stderr)

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
                portal.main(['install', '--manifest-sha256', PIN])
            execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
