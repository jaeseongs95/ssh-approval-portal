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


class DeploymentStateMachineTests(unittest.TestCase):
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
