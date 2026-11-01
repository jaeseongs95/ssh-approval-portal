"""Run in CI/TEST: python3 -m unittest discover -s test -p test_deployment_engine.py.

These tests exercise the durable state machine and real process flock boundary;
systemd/bridge integration remains a separate isolated Linux acceptance test.
"""
import copy
import importlib.util
import json
import multiprocessing
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch, Mock

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/deployment.py'
spec = importlib.util.spec_from_file_location('deployment_engine_test', SCRIPT)
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class Crash(BaseException):
    pass


class FakeHost:
    def __init__(self):
        self.effects = []
        self.durable = {}
        self.generation = 'old'
        self.running = False
        self.maintenance = False
        self.writes = []
        self.fail = None
        self.unknown = set()

    def validate_resume(self, journal):
        deployment.need(self.generation in ('old', 'job'), 'PREDECESSOR_CHANGED')
        if self.generation == 'job' and self.running and not self.maintenance:
            deployment.need('release' in journal['stages'], 'UNVERIFIED_WRITES')

    def execute(self, stage, journal):
        self.effects.append(stage)
        if stage == 'stop':
            self.running = False
        elif stage == 'baseline':
            self.maintenance = True
        elif stage == 'promote':
            deployment.need('migrate' in self.durable and 'baseline' in self.durable,
                            'UNVERIFIED_GENERATION')
            self.generation = 'job'
        elif stage == 'start':
            self.running = True
        elif stage == 'release':
            self.maintenance = False
            self.writes.append('new-live-write')
        elif stage == 'final':
            deployment.need(self.running and not self.maintenance, 'NOT_COMPLETE')
        result = {'stage': stage, 'invocation': 'new-instance'}
        self.durable[stage] = result
        if self.fail == stage:
            self.fail = None
            raise Crash()
        return result

    def reconcile(self, stage, journal, *, completed):
        if stage in self.unknown:
            return None
        return self.durable.get(stage)


def fresh():
    plan = {'planSha256': 'pinned-plan'}
    journal = {'planSha256': 'pinned-plan', 'state': 'QUEUED', 'stages': {},
               'databaseRestored': False, 'automaticReplay': False}
    return plan, journal


def hold_lock(base, ready, release):
    deployment.BASE = Path(base)
    with patch.object(deployment, 'trusted_directory'), patch.object(deployment.os, 'fstat', side_effect=owned_stat()), patch.object(deployment, 'ENV_LOCK', Path(base) / 'missing/lock'):
        with deployment.deployment_locks():
            ready.set()
            release.wait(10)


def owned_stat():
    original = deployment.os.fstat
    def owned(descriptor):
        info = original(descriptor)
        class Metadata:
            st_mode, st_nlink, st_uid = info.st_mode, info.st_nlink, 0
        return Metadata()
    return owned


def package_fixture(root, *, version='1.8.0', settings_source=None):
    names = ('bridge.mjs', 'app.mjs', 'package.json', 'package-lock.json',
             'scripts/deployment.py', 'scripts/verify.mjs', 'scripts/deployment-preservation.mjs',
             'scripts/deployment_migration.py', 'scripts/migrate-state.mjs',
             'scripts/deployment-launcher.py', 'config/ssh-approval-bridge.service',
             'helper/environment-helper.py', 'scripts/settings_contract.py',
             'config/settings-contract.json')
    root.mkdir(mode=0o700)
    entries = []
    for name in names:
        path = root / name
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        raw = b'listed-package-member\n'
        if name == 'package.json':
            raw = json.dumps({'version': version}).encode()
        elif name == 'scripts/settings_contract.py' and settings_source is not None:
            raw = settings_source.encode()
        path.write_bytes(raw)
        path.chmod(0o600)
        entries.append({'path': name, 'size': len(raw), 'sha256': deployment.digest(raw)})
    raw = deployment.canonical({'version': version, 'files': entries})
    (root / 'release-manifest.json').write_bytes(raw)
    (root / 'release-manifest.json').chmod(0o600)
    return deployment.digest(raw), {entry['path'] for entry in entries} | {'release-manifest.json'}


class DeploymentStateMachineTests(unittest.TestCase):
    def root_fixture(self):
        if not hasattr(deployment.os, 'geteuid') or deployment.os.geteuid() != 0:
            self.skipTest('Run this isolated Linux security fixture as root in CI/TEST')
        return tempfile.TemporaryDirectory(prefix='portal-deployment-security-', dir='/var/lib')

    def test_unlisted_external_symlink_and_git_are_never_copied_or_published(self):
        with self.root_fixture() as directory:
            root = Path(directory)
            source, stage, releases = root / 'package', root / 'stage', root / 'releases'
            pin, expected = package_fixture(source)
            marker = b'outside-package-confidential-marker-20261101'
            outside = root / 'private-source'
            outside.write_bytes(marker)
            outside.chmod(0o600)
            (source / 'unexpected-link').symlink_to(outside)
            (source / 'operator-notes.txt').write_bytes(marker)
            (source / '.git').mkdir(mode=0o700)
            (source / '.git/config').write_bytes(marker)
            deployment.copy_manifest_source(source, stage, pin)
            releases.mkdir(mode=0o700)
            updater = deployment.load_module(SCRIPT.with_name('update_release.py'), 'deployment_security_publisher')
            target = releases / 'verified'
            updater.publish_release(stage, target, 65534,
                                    lambda tree: deployment.verify_manifest(tree, pin))
            for tree in (stage, target):
                self.assertEqual({path.relative_to(tree).as_posix() for path in tree.rglob('*') if path.is_file()}, expected)
                self.assertFalse((tree / 'unexpected-link').exists())
                self.assertFalse((tree / '.git').exists())
                self.assertTrue(all(marker not in path.read_bytes() for path in tree.rglob('*') if path.is_file()))
            self.assertEqual(outside.read_bytes(), marker)

    def test_legacy_rejects_mutable_or_linked_scripts_before_root_import(self):
        for attack in ('writable-directory', 'linked-directory'):
            with self.subTest(attack=attack), self.root_fixture() as directory:
                root = Path(directory)
                releases = root / 'releases'
                releases.mkdir(mode=0o700)
                source, marker = releases / 'old', root / 'import-side-effect'
                malicious = 'from pathlib import Path\nPath(' + repr(str(marker)) + ').write_text("executed")\ndef read_env(_): return {}\n'
                package_fixture(source, version='1.7.0', settings_source=malicious)
                link = root / 'active'
                link.symlink_to(source)
                if attack == 'writable-directory':
                    (source / 'scripts').chmod(0o777)
                else:
                    external_scripts = root / 'outside-scripts'
                    (source / 'scripts').rename(external_scripts)
                    (source / 'scripts').symlink_to(external_scripts, target_is_directory=True)
                with patch.object(deployment, 'LEGACY_LINK', link), patch.object(deployment, 'RELEASES', releases):
                    with self.assertRaisesRegex(deployment.DeploymentError, 'UNTRUSTED_DIRECTORY'):
                        deployment._legacy_state()
                self.assertFalse(marker.exists(), 'unverified settings module ran as root')

    def test_service_uid_reads_active_and_launcher_under_private_umask(self):
        with self.root_fixture() as directory:
            root = Path(directory)
            root.chmod(0o755)
            account = SimpleNamespace(pw_uid=65534, pw_gid=65534)
            state = root / 'deployments'
            previous = deployment.os.umask(0o077)
            try:
                with patch.object(deployment, 'STATE_ROOT', state), patch.object(deployment.pwd, 'getpwnam', return_value=account):
                    deployment._ensure_state(state)
                releases, generations = root / 'releases', root / 'generations'
                for path in (releases, generations):
                    path.mkdir(mode=0o755)
                    path.chmod(0o755)
                job_id = 'deploy-' + 'a' * 32
                release, generation = releases / 'code', generations / job_id
                for path in (release, generation):
                    path.mkdir(mode=0o750)
                    deployment.os.chown(path, 0, account.pw_gid)
                    path.chmod(0o750)
                data = generation / 'transfers'
                data.mkdir(mode=0o700)
                deployment.os.chown(data, account.pw_uid, account.pw_gid)
                bridge = b'export const trusted = true;\n'
                (release / 'bridge.mjs').write_bytes(bridge)
                manifest = deployment.canonical({'files': [{'path': 'bridge.mjs', 'size': len(bridge), 'sha256': deployment.digest(bridge)}]})
                (release / 'release-manifest.json').write_bytes(manifest)
                for path in (release / 'bridge.mjs', release / 'release-manifest.json'):
                    deployment.os.chown(path, 0, account.pw_gid)
                    path.chmod(0o640)
                environment, node = root / 'environment', root / 'node'
                environment.write_bytes(b'BRIDGE_MCP_TOKEN=private\n')
                environment.chmod(0o600)
                node.write_bytes(b'#!/bin/false\n')
                node.chmod(0o755)
                launcher = root / 'launcher.py'
                launcher.write_bytes(SCRIPT.with_name('deployment-launcher.py').read_bytes())
                launcher.chmod(0o644)
                active = {'schemaVersion': 1, 'generation': job_id, 'release': str(release),
                          'dataRoot': str(data), 'environmentFile': str(environment),
                          'manifestSha256': deployment.digest(manifest)}
                deployment.atomic_json(state / 'active.json', active, mode=0o640, gid=account.pw_gid)
            finally:
                deployment.os.umask(previous)
            program = ('import importlib.util, pathlib, sys; '
                       'spec=importlib.util.spec_from_file_location("launcher_fixture",sys.argv[1]); '
                       'module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); '
                       'paths=[pathlib.Path(p) for p in sys.argv[2:]]; '
                       'result=module.select_generation(active=paths[0],releases=paths[1],generations=paths[2],environment=paths[3],node=paths[4]); '
                       'print(result["generation"])')
            result = deployment.subprocess.run(['/usr/bin/python3', '-I', '-B', '-c', program,
                str(launcher), str(state / 'active.json'), str(releases), str(generations), str(environment), str(node)],
                user=account.pw_uid, group=account.pw_gid, extra_groups=[], capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
            self.assertEqual(result.stdout.decode().strip(), job_id)
            self.assertEqual(state.stat().st_mode & 0o777, 0o750)
            self.assertEqual((state / 'active.json').stat().st_mode & 0o777, 0o640)

    def test_audit_prefix_allows_append_and_rejects_replacement(self):
        if not hasattr(deployment.os, 'O_NOFOLLOW'):
            self.skipTest('Linux audit preservation test')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'audit.jsonl'
            path.write_bytes(b'old-entry\n')
            path.chmod(0o600)
            key = b'x' * 32
            with patch.object(deployment, 'environment_path', return_value=path):
                baseline = deployment.audit_baseline(key)
            with path.open('ab') as stream:
                stream.write(b'new-maintenance-entry\n')
            deployment.verify_audit_prefix(baseline, key, deployment.os.geteuid(), deployment.os.getegid())
            path.write_bytes(b'replacement-with-longer-length\n')
            with self.assertRaisesRegex(deployment.DeploymentError, 'AUDIT_PREFIX_CHANGED'):
                deployment.verify_audit_prefix(baseline, key, deployment.os.geteuid(), deployment.os.getegid())

    def test_fresh_stop_does_not_stop_a_missing_unit(self):
        backend = deployment.SystemBackend.__new__(deployment.SystemBackend)
        backend.predecessor = Mock()
        backend.protected = Mock()
        backend.command = Mock(side_effect=AssertionError('stop missing unit'))
        state = {'ActiveState': 'inactive', 'SubState': 'dead', 'MainPID': '0', 'InvocationID': ''}
        with patch.object(deployment, 'service_state', return_value=state):
            self.assertTrue(backend.execute('stop', {})['stopped'])
        backend.command.assert_not_called()

    def test_atomic_public_record_mode_survives_private_umask(self):
        if not hasattr(deployment.os, 'O_NOFOLLOW'):
            self.skipTest('Linux atomic file test')
        with tempfile.TemporaryDirectory() as directory:
            previous = deployment.os.umask(0o077)
            try:
                path = Path(directory) / 'active.json'
                deployment.atomic_json(path, {'generation': 'verified'}, mode=0o640)
            finally:
                deployment.os.umask(previous)
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)
            self.assertEqual(json.loads(path.read_text())['generation'], 'verified')

    def test_stop_response_loss_is_reconciled_without_second_stop(self):
        backend = deployment.SystemBackend.__new__(deployment.SystemBackend)
        backend.command = Mock(side_effect=AssertionError('duplicate stop'))
        state = {'ActiveState': 'inactive', 'SubState': 'dead', 'MainPID': '0', 'InvocationID': ''}
        with patch.object(deployment, 'service_state', return_value=state), patch.object(deployment.time, 'time', return_value=123):
            result = backend.reconcile('stop', {'stages': {'stop': {'state': 'running'}}}, completed=False)
        self.assertEqual(result, {'stopped': True, 'stoppedAtMs': 123000})
        backend.command.assert_not_called()

    def test_reboot_started_generation_is_adopted_without_second_start(self):
        backend = deployment.SystemBackend.__new__(deployment.SystemBackend)
        backend.active = Mock(return_value={'generation': 'job'})
        backend.desired_active = Mock(return_value={'generation': 'job'})
        backend.instance = Mock(return_value={'invocation': 'boot-instance'})
        backend.command = Mock(side_effect=AssertionError('duplicate start'))
        state = {'ActiveState': 'active', 'SubState': 'running', 'MainPID': '5', 'InvocationID': 'a' * 32}
        with patch.object(deployment, 'service_state', return_value=state):
            self.assertEqual(backend.execute('start', {}), {'invocation': 'boot-instance'})
        backend.command.assert_not_called()
        backend.instance.assert_called_once_with(True)

    def test_completion_requires_final_observation(self):
        plan, journal = fresh()
        snapshots = []
        host = FakeHost()
        result = deployment.execute_job(plan, journal, host, lambda value: snapshots.append(copy.deepcopy(value)))
        self.assertEqual(result['state'], 'PASS')
        self.assertEqual(host.effects, list(deployment.STAGES))
        self.assertTrue(all(value['state'] != 'PASS' for value in snapshots[:-1]))
        self.assertEqual(snapshots[-2]['stages']['final']['state'], 'done')

    def test_every_effect_boundary_resumes_without_duplicate(self):
        for boundary in deployment.STAGES:
            with self.subTest(boundary=boundary):
                plan, journal = fresh()
                host = FakeHost()
                host.fail = boundary
                with self.assertRaises(Crash):
                    deployment.execute_job(plan, journal, host, lambda value: None)
                self.assertEqual(journal['state'], 'NEEDS_REVIEW')
                result = deployment.execute_job(plan, journal, host, lambda value: None)
                self.assertEqual(result['state'], 'PASS')
                self.assertEqual(host.effects.count(boundary), 1)
                self.assertEqual(host.writes, ['new-live-write'])

    def test_unknown_response_never_repeats_effect(self):
        for boundary in ('reserve', 'migrate', 'start', 'release'):
            with self.subTest(boundary=boundary):
                plan, journal = fresh()
                host = FakeHost()
                host.fail = boundary
                with self.assertRaises(Crash):
                    deployment.execute_job(plan, journal, host, lambda value: None)
                host.unknown.add(boundary)
                with self.assertRaisesRegex(deployment.DeploymentError, 'EFFECT_OUTCOME_UNKNOWN'):
                    deployment.execute_job(plan, journal, host, lambda value: None)
                self.assertEqual(host.effects.count(boundary), 1)
                self.assertFalse(journal['databaseRestored'])
                self.assertNotEqual(journal['state'], 'PASS')

    def test_reboot_preserves_journal_and_new_writes(self):
        plan, journal = fresh()
        host = FakeHost()
        host.fail = 'release'
        with self.assertRaises(Crash):
            deployment.execute_job(plan, journal, host, lambda value: None)
        journal = json.loads(json.dumps(journal))
        host.running = True
        deployment.execute_job(plan, journal, host, lambda value: None)
        self.assertEqual(host.writes, ['new-live-write'])
        self.assertEqual(host.generation, 'job')
        self.assertEqual(host.effects.count('start'), 1)

    def test_stale_plan_is_fenced_before_any_effect(self):
        plan, journal = fresh()
        host = FakeHost()
        host.generation = 'newer-job'
        with self.assertRaisesRegex(deployment.DeploymentError, 'PREDECESSOR_CHANGED'):
            deployment.execute_job(plan, journal, host, lambda value: None)
        self.assertEqual(host.effects, [])

    def test_journal_cannot_skip_migration(self):
        plan, journal = fresh()
        journal['stages']['promote'] = {'state': 'done', 'result': {}}
        with self.assertRaisesRegex(deployment.DeploymentError, 'JOURNAL_PREFIX_INVALID'):
            deployment.execute_job(plan, journal, FakeHost(), lambda value: None)

    def test_flock_serializes_independent_jobs(self):
        if not hasattr(deployment.os, 'O_NOFOLLOW'):
            self.skipTest('Linux process-lock test')
        with tempfile.TemporaryDirectory() as directory:
            ready, release = multiprocessing.Event(), multiprocessing.Event()
            process = multiprocessing.Process(target=hold_lock, args=(directory, ready, release))
            process.start()
            try:
                self.assertTrue(ready.wait(5))
                with patch.object(deployment, 'BASE', Path(directory)), patch.object(deployment, 'trusted_directory'), patch.object(deployment, 'ENV_LOCK', Path(directory) / 'missing/lock'):
                    # CI runs unprivileged; retain all file safety checks except uid.
                    with patch.object(deployment.os, 'fstat', side_effect=owned_stat()):
                        with self.assertRaisesRegex(deployment.DeploymentError, 'DEPLOYMENT_BUSY'):
                            with deployment.deployment_locks():
                                self.fail('second promotion lock acquired')
            finally:
                release.set()
                process.join(10)
                if process.is_alive():
                    process.terminate()
                    process.join(5)
            self.assertEqual(process.exitcode, 0)


if __name__ == '__main__':
    unittest.main()
