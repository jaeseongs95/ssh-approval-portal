"""Disposable GitHub Linux runner only; provisions exact fixture-owned host paths."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import unittest
from urllib.request import urlopen
import time


def run(*args, **kw):
    result = subprocess.run(list(map(str, args)), capture_output=True, text=True, timeout=300, **kw)
    if result.returncode:
        raise RuntimeError(f'fixture command failed: {result.stderr[-4000:]}')
    return result


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def port():
    with socket.socket() as value:
        value.bind(('127.0.0.1', 0))
        return value.getsockname()[1]


class FullController(unittest.TestCase):
    def test_controller_legacy_bootstrap_with_nonempty_state(self):
        if os.geteuid() != 0:
            self.skipTest('isolated root runner required')
        root = Path('/var/lib/ssh-mcp')
        runtime = Path('/opt/ssh-approval')
        envfile = Path('/etc/ssh-mcp-approval-bridge.env')
        unit = Path('/etc/systemd/system/ssh-approval-bridge.service')
        helper = Path('/usr/local/libexec/ssh-approval-environment-helper')
        task = Path('/var/lib/ssh-rollout-ci-fixture')
        ops_home = Path('/var/lib/ssh-rollout-ci-ops')
        for target in (root, runtime, envfile, unit, helper, task, ops_home):
            self.assertFalse(target.exists() or target.is_symlink(), f'fixture path already exists: {target}')
        for account in ('mcpbridge', 'mcpops'):
            result = subprocess.run(['/usr/bin/getent', 'passwd', account], capture_output=True)
            self.assertNotEqual(0, result.returncode, 'fixture account already exists')
        old_source = Path(os.environ['SSH_E2E_OLD'])
        workspace = Path(os.environ['SSH_E2E_NEW'])
        node = Path(os.environ['SSH_E2E_NODE'])
        npm = Path(os.environ['SSH_E2E_NPM'])
        package = Path(os.environ['SSH_E2E_PACKAGE'])
        fixture = Path(__file__).parent
        created_users = []
        try:
            run('/usr/sbin/useradd', '--system', '--home-dir', str(root), '--shell', '/usr/sbin/nologin', 'mcpbridge')
            created_users.append('mcpbridge')
            run('/usr/sbin/useradd', '--system', '--home-dir', str(ops_home), '--shell', '/usr/sbin/nologin', 'mcpops')
            created_users.append('mcpops')
            root.mkdir(mode=0o755); ops_home.mkdir(mode=0o700)
            run('/usr/bin/chown', 'mcpops:mcpops', ops_home)
            fixture_scripts = root / 'fixture-scripts'; fixture_scripts.mkdir(mode=0o755)
            for name in ('e2e-seed.mjs', 'e2e-service.mjs'):
                shutil.copyfile(fixture / name, fixture_scripts / name)
                (fixture_scripts / name).chmod(0o644)
            (root / 'app/releases').mkdir(parents=True, mode=0o755)
            old = root / 'app/releases/fixture-old'
            shutil.copytree(old_source, old, symlinks=True)
            old.chmod(0o755)
            for path in old.rglob('*'):
                if not path.is_symlink():
                    path.chmod((path.stat().st_mode & 0o777) | (0o555 if path.is_dir() else 0o444))
            (root / 'app/approval-bridge').symlink_to(old)
            state = root / 'transfers'; state.mkdir(mode=0o700)
            run('/usr/bin/chown', 'mcpbridge:mcpbridge', state)
            auditdir = root / '.local/share/ssh-mcp'; auditdir.mkdir(parents=True)
            audit = auditdir / 'approval-bridge-audit.jsonl'; audit.write_bytes(b'fixture-audit\n')
            audit.chmod(0o600); run('/usr/bin/chown', 'mcpbridge:mcpbridge', audit)
            runtime.joinpath('node/bin').mkdir(parents=True)
            runtime.joinpath('node/bin/node').symlink_to(node)
            runtime.joinpath('node/bin/npm').symlink_to(npm)
            task.mkdir(mode=0o700); source = task / 'source'; source.mkdir(mode=0o700)
            run('/usr/bin/tar', '-xzf', package, '--strip-components=1', '-C', source)
            for path in source.rglob('*'):
                if path.is_dir(): path.chmod(0o700)
                elif path.is_file(): path.chmod(0o600)
                else: self.fail('unexpected package entry')
            # Synthetic package only: reproduce the exact isolated npm settings
            # separately so CI failures reveal a safe, non-secret stderr.
            diagnostic = task / 'npm-diagnostic-source'
            shutil.copytree(source, diagnostic)
            npm_env = {'PATH':'/opt/ssh-approval/node/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG':'C.UTF-8',
                       'HOME':str(task), 'npm_config_cache':str(task/'npm-cache'),
                       'npm_config_userconfig':str(task/'npm-probe-user'), 'npm_config_globalconfig':str(task/'npm-probe-global')}
            probe = subprocess.run([str(runtime/'node/bin/npm'),'ci','--omit=dev','--ignore-scripts',
                                    '--no-audit','--no-fund','--prefix',str(diagnostic)],
                                   env=npm_env,capture_output=True,text=True,timeout=300)
            shutil.rmtree(diagnostic)
            self.assertEqual(0, probe.returncode, 'synthetic npm diagnostic: ' + probe.stderr[-4000:])
            helper.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(old / 'helper/environment-helper.py', helper); helper.chmod(0o755)
            admin, mcp = port(), port(); self.assertNotEqual(admin, mcp)
            envfile.write_text('\n'.join(['BRIDGE_MCP_TOKEN=fixture-mcp', 'BRIDGE_ADMIN_TOKEN=fixture-admin',
                'BRIDGE_ADMIN_ORIGIN=https://example.test', 'BRIDGE_UI_TICKET_KEY=' + 'b' * 64,
                'BRIDGE_UI_ENABLED=true', 'BRIDGE_COMMAND_AUTOMATION=true', f'BRIDGE_MCP_PORT={mcp}',
                f'BRIDGE_ADMIN_PORT={admin}', '']), encoding='utf-8'); envfile.chmod(0o600)
            run('/usr/bin/sudo', '-n', '-u', 'mcpbridge', '--', node, fixture_scripts / 'e2e-seed.mjs', old, state)
            unit.write_text('[Unit]\nDescription=isolated fixture\n[Service]\nType=simple\nUser=mcpbridge\nGroup=mcpbridge\n'
                + f'ExecStart={node} {fixture_scripts / "e2e-service.mjs"} {root / "app/approval-bridge"} {state} {admin} {mcp} full\n', encoding='utf-8')
            unit.chmod(0o644)
            run('/usr/bin/systemctl', 'daemon-reload')
            run('/usr/bin/systemctl', 'start', 'ssh-approval-bridge.service')
            for _ in range(100):
                try:
                    with urlopen(f'http://127.0.0.1:{mcp}/health', timeout=2) as response:
                        if json.load(response).get('healthy') is True: break
                except OSError: time.sleep(.1)
            else: self.fail('legacy fixture did not start')
            names = ('bootstrap.py','run_linux.py','controller.py','linux_adapter.py','scope_guard.py','protected_state.py',
                     'staging_guard.py','offline-baseline.mjs','maintenance-request.mjs')
            for name in names:
                shutil.copyfile(fixture / name, task / name); (task / name).chmod(0o600)
            pins = {name: sha(task / name) for name in names if name != 'bootstrap.py'}
            new = root / 'app/releases/fixture-new'
            candidate_manifest = source / 'release-manifest.json'
            version = json.loads(candidate_manifest.read_text())['version']
            intent = {'job':'fixture-rollout','hostname':socket.gethostname(),'oldManifest':sha(old/'release-manifest.json'),
                      'candidateManifest':sha(candidate_manifest),'configFingerprint':sha(envfile),'candidateVersion':version,
                      'oldRelease':str(old),'newRelease':str(new),'independentRecoveryChannel':True,'controllerDigests':pins}
            intentfile = task / 'intent.json'; intentfile.write_text(json.dumps(intent), encoding='utf-8'); intentfile.chmod(0o600)
            launcher = ('import hashlib,os,stat,sys; root=os.path.realpath(sys.argv[1]); assert root==sys.argv[1] and os.geteuid()==0; '
                'd=os.lstat(root); assert stat.S_ISDIR(d.st_mode) and d.st_uid==0 and stat.S_IMODE(d.st_mode)==0o700; '
                'p=os.path.join(root,"bootstrap.py"); fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW); s=os.fstat(fd); '
                'assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600 and s.st_size<1048576; '
                'f=os.fdopen(fd,"rb"); data=f.read(); f.close(); assert hashlib.sha256(data).hexdigest()==sys.argv[3]; '
                'sys.argv=[p,root,sys.argv[2]]; exec(compile(data,p,"exec"),{"__name__":"__main__","__file__":p})')
            completed = subprocess.run(['/usr/bin/python3','-I','-B','-c',launcher,str(task),sha(intentfile),sha(task/'bootstrap.py')],
                                       capture_output=True,text=True,timeout=300)
            receipt = json.loads((task/'receipt.json').read_text()) if (task/'receipt.json').exists() else {}
            self.assertEqual(0, completed.returncode, f'stderr={completed.stderr}; receipt={receipt}')
            self.assertEqual('PASS', receipt['status'])
            self.assertEqual(1, receipt['comparison']['commandRequestsChecked'])
            self.assertEqual(1, receipt['comparison']['cliRequestsChecked'])
            self.assertEqual(1, receipt['comparison']['outputPayloadsVerified'])
            self.assertEqual(str(new), os.readlink(root/'app/approval-bridge'))
            self.assertEqual(sha(new/'helper/environment-helper.py'), sha(helper))
            with urlopen(f'http://127.0.0.1:{mcp}/health', timeout=3) as response:
                self.assertFalse(json.load(response)['maintenance'])
        finally:
            subprocess.run(['/usr/bin/systemctl','stop','ssh-approval-bridge.service'],check=False,capture_output=True)
            if unit.exists(): unit.unlink()
            subprocess.run(['/usr/bin/systemctl','daemon-reload'],check=False,capture_output=True)
            for path in (root, runtime, task, ops_home):
                if path.is_dir() and not path.is_symlink(): shutil.rmtree(path)
            for path in (envfile, helper):
                if path.is_file() and not path.is_symlink(): path.unlink()
            for account in reversed(created_users):
                subprocess.run(['/usr/sbin/userdel', account],check=False,capture_output=True)

if __name__ == '__main__':
    unittest.main()
