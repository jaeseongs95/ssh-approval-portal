import importlib.util
import hashlib
import contextlib
import getpass
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('oidc_prepare', SOURCE/'scripts/prepare-oidc-proxy.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


def configuration():
    return {'name':'synthetic-test', 'adminHostname':'approve.example.com', 'mcpHostname':'mcp.example.com',
            'issuer':'https://accounts.google.com', 'clientId':'synthetic-client.apps.googleusercontent.com',
            'owners':['owner@example.com']}


class PublicBundle(unittest.TestCase):
    def test_exact_callback_loopback_ports_and_shared_security_template(self):
        config, files, plan = setup.render(configuration())
        self.assertEqual(plan['callback'], 'https://approve.example.com/oauth2/callback')
        self.assertEqual(plan['ownerCount'], 1)
        self.assertFalse(plan['servicesInstalled'] or plan['servicesStarted'] or plan['networkUsed'] or plan['bridgeEnvironmentChanged'])
        self.assertEqual(set(files), {'Caddyfile','proxy.cfg','ssh-portal-oidc-synthetic-test-proxy.service','ssh-portal-oidc-synthetic-test-caddy.service'})
        proxy = files['proxy.cfg'].decode()
        for line in ['oidc_issuer_url = "https://accounts.google.com"', 'code_challenge_method = "S256"',
                     'insecure_oidc_skip_nonce = false', 'insecure_oidc_skip_issuer_verification = false',
                     'insecure_oidc_allow_unverified_email = false', 'cookie_secure = true',
                     'cookie_httponly = true', 'request_logging = false', 'auth_logging = false', 'standard_logging = false']:
            self.assertIn(line, proxy)
        self.assertIn('client_secret_file = "/run/credentials/ssh-portal-oidc-synthetic-test-proxy.service/client-secret"', proxy)
        self.assertIn('upstreams = ["http://127.0.0.1:39125/"]', proxy)
        caddy = files['Caddyfile'].decode()
        self.assertIn('admin off', caddy)
        self.assertIn('protocols h1 h2', caddy)
        self.assertIn('reverse_proxy 127.0.0.1:4180', caddy)
        self.assertIn('reverse_proxy 127.0.0.1:39124', caddy)

    def test_input_injection_and_conflicts_are_rejected(self):
        for key, values in {'name':['../escape','x\nExecStart=/tmp/attack','x'*25], 'adminHostname':['x', 'a.example\n}', '127.0.0.1', '*.example.com','a.localhost','a.example:443'],
                            'issuer':['http://accounts.google.com','https://accounts.google.com@evil.example','https://accounts.google.com/?secret=x','https://accounts.google.com/#fragment','https://accounts.google.com\nfoo'],
                            'clientId':['x"\nfoo=true','x y'], 'owners':[['*'],['*@example.com'],['a@example.com\n*'],[],['A@example.com','a@example.com']],
                            'proxyPort':[True,80,65536,39125]}.items():
            for value in values:
                with self.subTest(key=key), self.assertRaises(ValueError):
                    setup.render({**configuration(),key:value})
        with self.assertRaises(ValueError):
            setup.render({**configuration(),'mcpHostname':'approve.example.com'})
        with self.assertRaises(ValueError):
            setup.render({**configuration(),'clientSecret':'must-not-accept-in-public-config'})

    def test_systemd_credential_paths_and_service_restrictions(self):
        _, files, _ = setup.render(configuration())
        for name, content in files.items():
            if not name.endswith('.service'):
                continue
            unit = content.decode()
            for setting in ['DynamicUser=yes','NoNewPrivileges=yes','ProtectSystem=strict','ProtectHome=yes','StandardOutput=null','StandardError=null']:
                self.assertIn(setting, unit)
            self.assertIn('LoadCredential=', unit)
            self.assertNotIn('client-secret=', unit)
            self.assertNotIn('Environment=OAUTH', unit)
        caddy = files['ssh-portal-oidc-synthetic-test-caddy.service'].decode()
        self.assertIn('StateDirectory=ssh-portal-oidc-synthetic-test-caddy', caddy)
        self.assertIn('StateDirectoryMode=0700', caddy)
        self.assertIn('CapabilityBoundingSet=CAP_NET_BIND_SERVICE', caddy)
        proxy = files['ssh-portal-oidc-synthetic-test-proxy.service'].decode()
        self.assertIn('LoadCredential=config:/var/lib/ssh-portal-oidc/synthetic-test/proxy.cfg', proxy)
        self.assertNotIn('AmbientCapabilities=', proxy)
        self.assertNotIn('ExecStartPre=', proxy)

    def test_template_placeholders_inside_input_are_not_rewritten(self):
        _, files, _ = setup.render({**configuration(),'issuer':'https://accounts.example.com/portal-client',
                                    'clientId':'127.0.0.1:4180'})
        proxy = files['proxy.cfg'].decode()
        self.assertIn('oidc_issuer_url = "https://accounts.example.com/portal-client"', proxy)
        self.assertIn('client_id = "127.0.0.1:4180"', proxy)

    def test_cli_dry_run_is_secret_free_and_prepare_rejects_non_tty(self):
        with tempfile.TemporaryDirectory(prefix='oidc-public-fixture-') as temporary:
            path = Path(temporary)/'public.json'
            path.write_text(json.dumps(configuration()), encoding='utf-8')
            args = [sys.executable,'-B',str(SOURCE/'scripts/prepare-oidc-proxy.py'),'--config',str(path)]
            result = subprocess.run(args, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            plan = json.loads(result.stdout)
            self.assertEqual(plan['status'],'PREPARATION_PLAN')
            self.assertNotIn('owner@example.com', result.stdout)
            self.assertNotIn('client-secret', result.stdout)
            blocked = subprocess.run([*args,'--prepare'], input='synthetic-must-not-read-stdin', capture_output=True, text=True, timeout=10)
            self.assertEqual(blocked.returncode,1)
            self.assertEqual(blocked.stdout,'')
            self.assertNotIn('synthetic-must-not-read-stdin',blocked.stderr)
            path.write_text(json.dumps({**configuration(),'clientSecret':'synthetic-must-not-echo'}),encoding='utf-8')
            rejected = subprocess.run(args,capture_output=True,text=True,timeout=10)
            self.assertEqual(rejected.returncode,1)
            self.assertNotIn('synthetic-must-not-echo', rejected.stdout+rejected.stderr)


@unittest.skipUnless(sys.platform.startswith('linux') and os.geteuid()==0, 'Linux root filesystem contract')
class PrivatePreparation(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='oidc-private-fixture-')
        self.base = Path(self.temporary.name)/'owned'
        self.change = patch.object(setup,'BASE',self.base)
        self.change.start()

    def tearDown(self):
        self.change.stop()
        self.temporary.cleanup()

    def prepare(self, value=None):
        return setup.prepare(value or configuration(), secret_reader=lambda prompt:'synthetic-client-secret-not-real')

    def test_private_files_cookie_and_no_secret_in_receipt(self):
        receipt = self.prepare()
        directory = self.base/'synthetic-test'
        self.assertEqual(receipt['status'],'PREPARED_NOT_INSTALLED')
        self.assertEqual(stat.S_IMODE(self.base.stat().st_mode),0o700)
        self.assertEqual(stat.S_IMODE(directory.stat().st_mode),0o700)
        self.assertEqual((directory/'client-secret').read_text(),'synthetic-client-secret-not-real')
        self.assertEqual(len((directory/'cookie-secret').read_bytes()),32)
        self.assertEqual((directory/'owners').read_text(),'owner@example.com\n')
        for path in directory.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o600)
        self.assertEqual(set(receipt['files']), {'Caddyfile','proxy.cfg',*receipt['units']})
        self.assertNotIn('synthetic-client-secret-not-real',json.dumps(receipt))
        self.assertNotIn(hashlib.sha256(b'synthetic-client-secret-not-real').hexdigest(),json.dumps(receipt))
        self.assertNotIn(hashlib.sha256((directory/'cookie-secret').read_bytes()).hexdigest(),json.dumps(receipt))
        self.assertNotIn('owner@example.com',json.dumps(receipt))
        with self.assertRaisesRegex(ValueError,'ALREADY_EXISTS'):
            self.prepare()

    def test_parent_symlink_and_writable_directory_are_rejected(self):
        outside = Path(self.temporary.name)/'outside'
        outside.mkdir()
        self.base.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'ROOT_OWNED'):
            self.prepare()
        self.base.unlink()
        self.base.mkdir(mode=0o777)
        self.base.chmod(0o777)
        with self.assertRaisesRegex(ValueError,'ROOT_OWNED'):
            self.prepare()
        self.assertEqual(list(outside.iterdir()),[])

    def test_secret_confirmation_failure_writes_nothing(self):
        values = iter(['synthetic-secret-a','synthetic-secret-b'])
        with self.assertRaisesRegex(ValueError,'MISMATCHED'):
            setup.prepare(configuration(),secret_reader=lambda prompt:next(values))
        self.assertFalse(self.base.exists())

    def test_writable_parent_is_rejected_before_secret_input(self):
        parent = self.base.parent
        parent.chmod(0o777)
        try:
            with self.assertRaisesRegex(ValueError,'ROOT_OWNED'):
                self.prepare()
        finally:
            parent.chmod(0o700)
        self.assertFalse(self.base.exists())

    def test_getpass_fallback_stops_before_first_or_confirmation_input(self):
        import pty
        import termios
        original_open, original_getattr, original_fallback = os.open, termios.tcgetattr, getpass.fallback_getpass
        for fail_on in [1,2]:
            with self.subTest(fail_on=fail_on):
                value = {**configuration(),'name':'synthetic-fallback-'+str(fail_on)}
                master, slave = pty.openpty()
                counts = {'termios':0,'normal':0,'fallback':0,'insideFallback':False}
                def open_file(path,*args,**kwargs):
                    if str(path) == '/dev/tty':
                        raise OSError('synthetic-no-controlling-tty')
                    return original_open(path,*args,**kwargs)
                def terminal_attributes(fd):
                    counts['termios'] += 1
                    if counts['termios'] == fail_on:
                        raise termios.error('synthetic-echo-control-failure')
                    return original_getattr(fd)
                def fallback(*args,**kwargs):
                    counts['insideFallback'] = True
                    try:
                        return original_fallback(*args,**kwargs)
                    finally:
                        counts['insideFallback'] = False
                def raw_input(*args,**kwargs):
                    counts['fallback' if counts['insideFallback'] else 'normal'] += 1
                    return 'synthetic-fallback-secret-not-real'
                output, errors = io.StringIO(), io.StringIO()
                try:
                    with os.fdopen(os.dup(slave),'r') as terminal, patch.object(getpass.sys,'stdin',terminal), patch.object(getpass.os,'open',open_file), patch.object(termios,'tcgetattr',terminal_attributes), patch.object(getpass,'fallback_getpass',fallback), patch.object(getpass,'_raw_input',raw_input), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                        failure = None
                        try:
                            setup.prepare(value)
                        except ValueError as error:
                            failure = error
                    self.assertEqual(counts['fallback'],0)
                    self.assertEqual(counts['normal'],fail_on-1)
                    self.assertIsNotNone(failure)
                    self.assertEqual(str(failure),'ECHO_FREE_INPUT_REQUIRED')
                    self.assertFalse((self.base/value['name']).exists())
                    self.assertNotIn('synthetic-fallback-secret-not-real', output.getvalue()+errors.getvalue())
                    self.assertNotIn('Traceback',errors.getvalue())
                finally:
                    os.close(master)
                    os.close(slave)

    def test_final_file_and_directory_sync_failures_leave_no_ready_receipt(self):
        original_fsync = os.fsync
        for stage in ['file','directory']:
            with self.subTest(stage=stage):
                value = {**configuration(),'name':'synthetic-'+stage}
                def failing_sync(fd):
                    info = os.fstat(fd)
                    pathname = os.readlink('/proc/self/fd/'+str(fd))
                    if (stage == 'directory' and stat.S_ISDIR(info.st_mode)) or (stage == 'file' and pathname.endswith('/bundle.json')):
                        raise OSError('synthetic-final-sync-failure')
                    return original_fsync(fd)
                with patch.object(setup.os,'fsync',failing_sync), self.assertRaisesRegex(ValueError,'INCOMPLETE'):
                    self.prepare(value)
                destination = self.base/value['name']
                self.assertTrue(destination.is_dir())
                self.assertEqual(stat.S_IMODE(destination.stat().st_mode),0o700)
                self.assertFalse((destination/'bundle.json').exists())
                self.assertEqual((destination/'client-secret').read_text(),'synthetic-client-secret-not-real')

    def test_restrictive_umask_does_not_break_private_directory_modes(self):
        old = os.umask(0o777)
        try:
            self.prepare()
        finally:
            os.umask(old)
        self.assertEqual(stat.S_IMODE(self.base.stat().st_mode),0o700)
        self.assertEqual(stat.S_IMODE((self.base/'synthetic-test').stat().st_mode),0o700)

    def test_partial_write_does_not_create_ready_receipt_or_remove_existing_files(self):
        original = setup.write_new
        def fail(path,data):
            if path.name == 'cookie-secret':
                raise OSError('synthetic write failure')
            original(path,data)
        with patch.object(setup,'write_new',fail), self.assertRaisesRegex(ValueError,'INCOMPLETE'):
            self.prepare()
        directory = self.base/'synthetic-test'
        self.assertTrue(directory.is_dir())
        self.assertFalse((directory/'bundle.json').exists())
        with self.assertRaisesRegex(ValueError,'ALREADY_EXISTS'):
            self.prepare()


if __name__ == '__main__':
    unittest.main()
