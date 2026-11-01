"""OB-RESUME·OB-GENERATION: 실제 파일 신뢰 경계와 작업별 실행기 선택.

실행: sudo python3 -B -m unittest discover -s test -p test_deployment_entry.py -v
root가 아닌 일반 Linux/Windows 회귀에서는 명시적으로 건너뛴다.
"""
import hashlib
import json
import os
import subprocess
import sys
import unittest
from unittest.mock import patch

from deployment_entry_fixture import ROOT_LINUX, ROOT_REASON, SOURCE, load_script, put, root_directory

entry = load_script('deployment_entry_test', 'deployment_entry.py')


@unittest.skipUnless(ROOT_LINUX, ROOT_REASON)
class DeploymentEntryTests(unittest.TestCase):
    def setUp(self):
        self.root = root_directory(self)
        self.executors = self.root / 'libexec/executors'
        self.launcher = self.root / 'libexec/launcher'
        self.launcher.parent.mkdir()
        self.jobs = self.root / 'jobs'
        for name, value in [('EXECUTORS', self.executors), ('LAUNCHER', self.launcher), ('JOBS', self.jobs)]:
            change = patch.object(entry, name, value)
            change.start()
            self.addCleanup(change.stop)
        self.source = self.root / 'source'
        self.manifest, self.pin = self.package(self.source, 'old')

    def package(self, path, token):
        files = {
            'scripts/deployment.py': ("TOKEN = %r\ndef validate_plan(plan):\n"
                                      "    if plan.get('proof') != TOKEN:\n"
                                      "        raise ValueError('FIXTURE_PLAN_INVALID')\n" % token).encode(),
            'scripts/deployment_migration.py': b'MARKER = "migration"\n',
            'scripts/deployment-launcher.py': b'#!/usr/bin/python3\n# fixed launcher\n',
            'config/ssh-approval-bridge.service': b'[Service]\n',
            'helper/environment-helper.py': b'# fixture helper\n',
            'scripts/deployment-preservation.mjs': b'export {};\n',
            'scripts/migrate-state.mjs': b'export {};\n',
            'bridge.mjs': b'export {};\n',
            'app.mjs': b'export {};\n',
            'package.json': b'{"version":"1.8.0"}\n',
        }
        for name, raw in files.items():
            put(path / name, raw)
        manifest = {'version': '1.8.0', 'files': [
            {'path': name, 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
            for name, raw in files.items()]}
        return manifest, self.save_manifest(path, manifest)

    def save_manifest(self, source, value):
        raw = json.dumps(value).encode()
        put(source / 'release-manifest.json', raw)
        return hashlib.sha256(raw).hexdigest()

    def save_job(self, pin, token, **changes):
        job = 'deploy-' + 'a' * 32
        plan = {'manifestSha256': pin, 'executor': str(self.executors / pin / 'deployment.py'), 'proof': token}
        plan.update(changes)
        put(self.jobs / job / 'plan.json', json.dumps(plan).encode(), 0o600)
        return job

    def test_new_source_never_rebinds_existing_job_or_replaces_launcher(self):
        old = entry.install_executor(self.source, self.pin)
        job = self.save_job(self.pin, 'old')
        launcher_bytes = self.launcher.read_bytes()
        old_bytes = (self.executors / self.pin / 'deployment.py').read_bytes()
        newer = self.root / 'new-source'
        _, newer_pin = self.package(newer, 'new')
        self.assertNotEqual(newer_pin, self.pin)
        self.assertEqual(entry.install_executor(newer, newer_pin).TOKEN, 'new')
        self.assertEqual(entry.executor_for_job(job).TOKEN, 'old')
        self.assertEqual(entry.install_executor(self.source, self.pin).TOKEN, old.TOKEN)
        self.assertEqual((self.executors / self.pin / 'deployment.py').read_bytes(), old_bytes)
        self.assertEqual(self.launcher.read_bytes(), launcher_bytes)
        self.assertEqual(self.launcher.stat().st_nlink, 1)

    def test_other_executor_is_rejected_before_import(self):
        entry.install_executor(self.source, self.pin)
        marker = self.root / 'unexpected-import'
        other = put(self.root / 'other.py', ('from pathlib import Path\nPath(%r).touch()\n' % str(marker)).encode())
        job = self.save_job(self.pin, 'old', executor=str(other))
        with self.assertRaisesRegex(ValueError, 'EXECUTOR_BOUNDARY_INVALID'):
            entry.executor_for_job(job)
        self.assertFalse(marker.exists())

    def test_job_plan_is_validated_by_its_selected_executor(self):
        entry.install_executor(self.source, self.pin)
        job = self.save_job(self.pin, 'different-plan')
        with self.assertRaisesRegex(ValueError, 'FIXTURE_PLAN_INVALID'):
            entry.executor_for_job(job)

    def test_changed_or_extra_installed_module_is_not_reused(self):
        entry.install_executor(self.source, self.pin)
        destination = self.executors / self.pin
        module = destination / 'deployment.py'
        original = module.read_bytes()
        put(module, original + b'# changed\n')
        with self.assertRaisesRegex(ValueError, 'EXECUTOR_CHANGED'):
            entry.install_executor(self.source, self.pin)
        put(module, original)
        put(destination / 'unexpected.py', b'# extra\n')
        with self.assertRaisesRegex(ValueError, 'EXECUTOR_DIRECTORY_CHANGED'):
            entry.install_executor(self.source, self.pin)

    def test_manifest_pin_is_required_and_binds_exact_bytes(self):
        for pin in ['', 'a' * 63, 'A' * 64, '0' * 64, None]:
            with self.subTest(pin=pin), self.assertRaisesRegex(ValueError, 'MANIFEST_PIN_'):
                entry.install_executor(self.source, pin)
        self.assertFalse(self.executors.exists())
        put(self.source / 'bridge.mjs', b'tampered\n')
        with self.assertRaisesRegex(ValueError, 'SOURCE_CHANGED'):
            entry.install_executor(self.source, self.pin)
        self.assertFalse(self.executors.exists())

    def test_invalid_manifest_paths_schema_duplicates_and_version_fail_closed(self):
        # 각각 별도 입력: 파일을 열기 전 경로 정규성·중복 여부를 거부해야 한다.
        bad_manifests = [[], {'files': []}, {'files': 'files'}] + [
            {'files': [{'path': name}]} for name in ('../outside', '/absolute', 'scripts\\deployment.py', './bridge.mjs')]
        bad_manifests += [{'files': [self.manifest['files'][0], self.manifest['files'][0]]},
                          {**self.manifest, 'version': '9.9.9'}]
        for value in bad_manifests:
            with self.subTest(manifest=value):
                pin = self.save_manifest(self.source, value)
                with self.assertRaises(ValueError):
                    entry.install_executor(self.source, pin)
                self.assertFalse(self.executors.exists())

    def test_actual_ownership_parent_links_and_file_links_are_rejected(self):
        bridge = self.source / 'bridge.mjs'
        original = bridge.read_bytes()
        cases = ('file-owner', 'file-mode', 'parent-owner', 'parent-mode', 'parent-symlink', 'symlink', 'hardlink')
        for case in cases:
            with self.subTest(case=case):
                if case == 'file-owner':
                    os.chown(bridge, 10001, -1)
                elif case == 'file-mode':
                    bridge.chmod(0o666)
                elif case == 'parent-owner':
                    os.chown(self.source / 'scripts', 10001, -1)
                elif case == 'parent-mode':
                    (self.source / 'scripts').chmod(0o777)
                elif case == 'parent-symlink':
                    (self.source / 'scripts').rename(self.source / 'real-scripts')
                    (self.source / 'scripts').symlink_to(self.source / 'real-scripts', target_is_directory=True)
                else:
                    bridge.unlink()
                    target = put(self.root / 'other-bridge', original)
                    bridge.symlink_to(target) if case == 'symlink' else os.link(target, bridge)
                with self.assertRaises((ValueError, OSError)):
                    entry.install_executor(self.source, self.pin)
                self.assertFalse(self.executors.exists())
                if case == 'parent-symlink':
                    (self.source / 'scripts').unlink()
                    (self.source / 'real-scripts').rename(self.source / 'scripts')
                os.chown(self.source / 'scripts', 0, -1)
                (self.source / 'scripts').chmod(0o755)
                if bridge.is_symlink() or case == 'hardlink':
                    bridge.unlink()
                    (self.root / 'other-bridge').unlink()
                put(bridge, original)
                os.chown(bridge, 0, -1)

    def test_invalid_job_ids_never_select_an_executor(self):
        for job in ('../escape', 'deploy-' + 'A' * 32, 'deploy-' + 'a' * 31, '', None):
            with self.subTest(job=job), self.assertRaisesRegex(ValueError, 'JOB_ID_INVALID'):
                entry.executor_for_job(job)

    def test_non_root_process_cannot_install_an_executor(self):
        script = SOURCE / 'scripts/deployment_entry.py'
        bootstrap = (
            'import importlib.util,os,pathlib\n'
            f's=importlib.util.spec_from_file_location("entry",{str(script)!r})\n'
            'm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n'
            'os.setuid(10001)\n'
            'try:\n'
            f'    m.install_executor(pathlib.Path({str(self.source)!r}),{self.pin!r})\n'
            'except ValueError as error:\n'
            '    print(str(error))\n'
            'else:\n'
            '    raise SystemExit("unexpected installation")\n')
        result = subprocess.run([sys.executable, '-I', '-B', '-c', bootstrap], capture_output=True,
                                text=True, encoding='utf-8', timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'ROOT_REQUIRED')
        self.assertFalse(self.executors.exists())

    def test_correctly_pinned_invalid_json_is_rejected_without_installation(self):
        raw = b'{not-json'
        put(self.source / 'release-manifest.json', raw)
        with self.assertRaises(ValueError):
            entry.install_executor(self.source, hashlib.sha256(raw).hexdigest())
        self.assertFalse(self.executors.exists())


if __name__ == '__main__':
    unittest.main()
