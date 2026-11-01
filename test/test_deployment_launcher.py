"""OB-GENERATION: 실제 root 파일·심볼릭 링크·exec 환경의 격리 시험.

실행: sudo python3 -B -m unittest discover -s test -p test_deployment_launcher.py -v
선택 검사는 실제 메타데이터를 사용하고, 프로세스 시험만 경로 상수를 격리한다.
"""
import hashlib
import json
import os
import subprocess
import sys
import unittest

from deployment_entry_fixture import ROOT_LINUX, ROOT_REASON, SOURCE, load_script, put, root_directory

launcher = load_script('deployment_launcher_test', 'deployment-launcher.py')


@unittest.skipUnless(ROOT_LINUX, ROOT_REASON)
class DeploymentLauncherTests(unittest.TestCase):
    def fixture(self):
        root = root_directory(self)
        releases = root / 'releases'
        release = releases / '1.8.0-pinned'
        generations = root / 'generations'
        generation = 'deploy-' + 'a' * 32
        data = generations / generation / 'transfers'
        data.mkdir(parents=True, mode=0o700)
        data.chmod(0o700)
        bridge = put(release / 'bridge.mjs', b'// selected bridge\n')
        raw = json.dumps({'files': [{'path': 'bridge.mjs', 'size': bridge.stat().st_size,
                                    'sha256': hashlib.sha256(bridge.read_bytes()).hexdigest()}]}).encode()
        put(release / 'release-manifest.json', raw)
        environment = put(root / 'configuration/environment', b'SECRET=fixture\n', 0o600)
        # 실 Node 대신 환경·argv를 관측하는 실행 파일로 execve 자체를 통과한다.
        node = put(root / 'runtime/node', ('#!' + sys.executable + '\n'
                   'import json,os,sys\n'
                   'print(json.dumps({"argv":sys.argv,"cwd":os.getcwd(),"environment":{k:os.environ.get(k) '
                   'for k in ["NODE_OPTIONS","NODE_PATH","BRIDGE_TRANSFER_ROOT","BRIDGE_SECRET_ENV_FILE"]}}))\n').encode(), 0o755)
        value = {'schemaVersion': 1, 'generation': generation, 'release': str(release),
                 'dataRoot': str(data), 'environmentFile': str(environment),
                 'manifestSha256': hashlib.sha256(raw).hexdigest()}
        active = put(root / 'deployments/active.json', json.dumps(value).encode(), 0o600)
        return {'root': root, 'releases': releases, 'generations': generations, 'release': release,
                'data': data, 'environment': environment, 'node': node, 'value': value, 'active': active}

    def select(self, fixture):
        return launcher.select_generation(fixture['active'], fixture['releases'], fixture['generations'],
                                          fixture['environment'], fixture['node'], uid=0)

    def save_active(self, fixture):
        put(fixture['active'], json.dumps(fixture['value']).encode(), 0o600)

    def test_exact_generation_is_selected_and_exec_environment_is_sanitized(self):
        fixture = self.fixture()
        self.assertEqual(self.select(fixture), fixture['value'])
        script = SOURCE / 'scripts/deployment-launcher.py'
        bootstrap = (
            'import importlib.util,pathlib,sys\n'
            'p=pathlib.Path\n'
            f's=importlib.util.spec_from_file_location("launcher",{str(script)!r})\n'
            'm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n'
            'select=m.select_generation\n'
            f'm.select_generation=lambda:select(p({str(fixture["active"])!r}),p({str(fixture["releases"])!r}),'
            f'p({str(fixture["generations"])!r}),p({str(fixture["environment"])!r}),p({str(fixture["node"])!r}),uid=0)\n'
            f'm.NODE=p({str(fixture["node"])!r})\n'
            'm.main()\n')
        environment = {**os.environ, 'NODE_OPTIONS': '--require=/does-not-exist', 'NODE_PATH': '/attacker',
                       'BRIDGE_TRANSFER_ROOT': '/wrong-data', 'BRIDGE_SECRET_ENV_FILE': '/wrong-secret'}
        result = subprocess.run([sys.executable, '-I', '-B', '-c', bootstrap], capture_output=True,
                                text=True, encoding='utf-8', env=environment, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        observed = json.loads(result.stdout)
        self.assertEqual(observed['argv'], [str(fixture['node']), str(fixture['release'] / 'bridge.mjs')])
        self.assertEqual(observed['cwd'], str(fixture['release']))
        self.assertEqual(observed['environment'], {'NODE_OPTIONS': None, 'NODE_PATH': None,
                         'BRIDGE_TRANSFER_ROOT': str(fixture['data']),
                         'BRIDGE_SECRET_ENV_FILE': None})

    def test_invalid_generation_and_external_data_or_release_never_fall_back(self):
        cases = [('generation', 'deploy-' + 'A' * 32, 'ACTIVE_GENERATION'),
                 ('generation', '../old', 'ACTIVE_GENERATION'),
                 ('schemaVersion', 2, 'ACTIVE_SCHEMA'),
                 ('manifestSha256', 'A' * 64, 'ACTIVE_MANIFEST')]
        for key, value, code in cases:
            with self.subTest(key=key, value=value):
                fixture = self.fixture()
                fixture['value'][key] = value
                self.save_active(fixture)
                with self.assertRaisesRegex(launcher.LaunchRefused, code):
                    self.select(fixture)
        for key, path, code in [('dataRoot', 'outside/transfers', 'ACTIVE_DATA'),
                                ('release', 'outside/release', 'ACTIVE_RELEASE'),
                                ('environmentFile', 'outside/environment', 'ACTIVE_ENVIRONMENT')]:
            with self.subTest(key=key):
                fixture = self.fixture()
                fixture['value'][key] = str(fixture['root'] / path)
                self.save_active(fixture)
                with self.assertRaisesRegex(launcher.LaunchRefused, code):
                    self.select(fixture)

    def test_manifest_bytes_and_entry_bytes_are_both_bound(self):
        for target, code in [('release-manifest.json', 'MANIFEST_CHANGED'), ('bridge.mjs', 'ENTRY_CHANGED')]:
            with self.subTest(target=target):
                fixture = self.fixture()
                path = fixture['release'] / target
                put(path, path.read_bytes() + b' ')
                with self.assertRaisesRegex(launcher.LaunchRefused, code):
                    self.select(fixture)

    def test_correctly_pinned_malformed_manifest_cannot_launch(self):
        for value in ([], {'files': []}, {'files': 'bad'}, {'files': [{'path': 'bridge.mjs'}, {'path': 'bridge.mjs'}]}):
            with self.subTest(manifest=value):
                fixture = self.fixture()
                raw = json.dumps(value).encode()
                put(fixture['release'] / 'release-manifest.json', raw)
                fixture['value']['manifestSha256'] = hashlib.sha256(raw).hexdigest()
                self.save_active(fixture)
                with self.assertRaises(launcher.LaunchRefused):
                    self.select(fixture)
        fixture = self.fixture()
        raw = b'{not-json'
        put(fixture['release'] / 'release-manifest.json', raw)
        fixture['value']['manifestSha256'] = hashlib.sha256(raw).hexdigest()
        self.save_active(fixture)
        with self.assertRaises(ValueError):
            self.select(fixture)

    def test_untrusted_ownership_permissions_and_links_cannot_launch(self):
        cases = ('active-owner', 'active-mode', 'active-symlink', 'active-hardlink',
                 'parent-owner', 'parent-mode', 'parent-symlink', 'data-owner', 'data-mode',
                 'data-symlink', 'environment-owner', 'environment-mode', 'environment-symlink',
                 'runtime-owner', 'runtime-mode', 'runtime-symlink', 'runtime-not-executable')
        for case in cases:
            with self.subTest(case=case):
                fixture = self.fixture()
                key = 'node' if case.startswith('runtime-') else case.split('-')[0]
                target = fixture['active'].parent if key == 'parent' else fixture[key]
                action = case.split('-', 1)[1]
                if action == 'owner':
                    os.chown(target, 10001, -1)
                elif action == 'mode':
                    target.chmod(0o777)
                elif action == 'not-executable':
                    target.chmod(0o644)
                elif action in ('symlink', 'hardlink'):
                    saved = target.with_name(target.name + '-saved')
                    target.rename(saved)
                    if action == 'symlink':
                        target.symlink_to(saved, target_is_directory=saved.is_dir())
                    else:
                        os.link(saved, target)
                with self.assertRaises((launcher.LaunchRefused, OSError)):
                    self.select(fixture)

    def test_cli_rejects_path_override_before_any_fixture_is_consulted(self):
        result = subprocess.run([sys.executable, '-I', '-B', str(SOURCE / 'scripts/deployment-launcher.py'),
                                 '--active', '/tmp/forged-active.json'], capture_output=True,
                                text=True, encoding='utf-8', timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertNotIn('Traceback', result.stderr)


if __name__ == '__main__':
    unittest.main()
