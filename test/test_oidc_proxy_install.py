import contextlib
import importlib.util
import hashlib
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
sys.path.insert(0,str(SOURCE/'scripts'))
spec = importlib.util.spec_from_file_location('oidc_install',SOURCE/'scripts/install-oidc-proxy.py')
install = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install)


def config():
    return {'name':'synthetic-install','adminHostname':'approve.example.com','mcpHostname':'mcp.example.com',
            'issuer':'https://accounts.google.com','clientId':'synthetic.apps.googleusercontent.com','owners':['owner@example.com']}


class PublicInstallation(unittest.TestCase):
    def test_default_cli_is_only_a_plan_and_rejects_secret_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)/'public.json'
            path.write_text(json.dumps(config()),encoding='utf-8')
            args = [sys.executable,'-B',str(SOURCE/'scripts/install-oidc-proxy.py'),'--config',str(path)]
            result = subprocess.run(args,capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            plan = json.loads(result.stdout)
            self.assertEqual(plan['status'],'INSTALLATION_PLAN')
            self.assertEqual(plan['servicesWillUsePublicPorts'],[80,443])
            self.assertFalse(plan['servicesInstalled'] or plan['servicesStarted'])
            path.write_text(json.dumps({**config(),'clientSecret':'synthetic-do-not-print'}),encoding='utf-8')
            denied = subprocess.run(args,capture_output=True,text=True,timeout=10)
            self.assertEqual(denied.returncode,1)
            self.assertNotIn('synthetic-do-not-print',denied.stdout+denied.stderr)


@unittest.skipUnless(sys.platform.startswith('linux') and os.geteuid()==0,'Linux root file lifecycle')
class NativeInstallation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='oidc-install-fixture-')
        self.root = Path(self.tmp.name)
        self.units = self.root/'units'
        self.units.mkdir(mode=0o755)
        self.base = self.root/'prepared'
        self.stack = contextlib.ExitStack()
        self.stack.enter_context(patch.object(install.prepare,'BASE',self.base))
        self.stack.enter_context(patch.object(install,'UNITS',self.units))
        self.stack.enter_context(patch.object(install.platform,'machine',return_value='x86_64'))
        install.prepare.prepare(config(),secret_reader=lambda prompt:'synthetic-client-secret-not-real')
        self.directory = self.base/config()['name']
        self.active = set()
        self.commands = []
        self.fail_start = None
        self.overrides = set()
        self.stack.enter_context(patch.object(install.files,'system_value',side_effect=self.value))
        self.stack.enter_context(patch.object(install.files,'checked',side_effect=self.command))
        self.binary_mock = self.stack.enter_context(patch.object(install,'binary'))
        # General temp root is private; this fixture creates only its own wants directory.
        self.stack.enter_context(patch.object(install,'public_binary_directory',side_effect=self.public_directory))

    def tearDown(self):
        self.stack.close()
        self.tmp.cleanup()

    def public_directory(self,path):
        if not path.exists():
            path.mkdir(mode=0o755)

    def value(self,unit,prop):
        exists = (self.units/unit).exists()
        return {'LoadState':'loaded' if exists else 'not-found',
                'FragmentPath':str(self.units/unit) if exists else '',
                'DropInPaths':'/synthetic/foreign.conf' if unit in self.overrides else '',
                'ActiveState':'active' if unit in self.active else 'inactive',
                'MainPID':'123' if unit in self.active else '0'}[prop]

    def command(self,args):
        self.commands.append(args[1:])
        if args[1] == 'start':
            if args[2] == self.fail_start:
                raise install.ProvisionFailure('SYNTHETIC_START_FAILURE')
            self.active.add(args[2])
        if args[1] == 'stop':
            self.active.discard(args[2])

    def state(self):
        return json.loads((self.directory/'installation.json').read_text())

    def test_install_remove_and_duplicate_preserve_private_files_and_existing_units(self):
        before = {name:(self.directory/name).read_bytes() for name in ['client-secret','cookie-secret','owners','bundle.json']}
        other = self.units/'unrelated.service'
        other.write_bytes(b'operator owned')
        result = install.install(config())
        self.assertEqual(result['status'],'SERVICES_ACTIVE_LOGIN_UNVERIFIED')
        self.assertFalse(result['bridgeEnvironmentChanged'] or result['loginVerified'] or result['publicCertificateVerified'])
        self.assertEqual(len(self.active),2)
        self.assertEqual(self.state()['status'],'ACTIVE')
        self.assertEqual(len(self.state()['created']),4)
        for unit in result['units']:
            self.assertTrue(install.wanted(unit).is_symlink())
            self.assertEqual(os.readlink(install.wanted(unit)),str(self.units/unit))
        with self.assertRaisesRegex(ValueError,'RECORD_ALREADY_EXISTS'):
            install.install(config())
        removed = install.remove(config())
        self.assertEqual(removed['status'],'SERVICES_REMOVED')
        self.assertTrue(removed['privateDataAndCertificatesPreserved'] and removed['versionCachePreserved'])
        self.assertFalse(self.active)
        self.assertEqual(other.read_bytes(),b'operator owned')
        self.assertEqual(before,{name:(self.directory/name).read_bytes() for name in before})
        self.assertEqual(install.remove(config())['status'],'SERVICES_REMOVED')
        stops = [command[1] for command in self.commands if command[0]=='stop']
        self.assertTrue(stops[0].endswith('-caddy.service'))

    def test_reconstructed_files_and_receipt_reject_forgery_before_install(self):
        path = self.directory/'proxy.cfg'
        path.write_bytes(path.read_bytes()+b'\nrequest_logging=true\n')
        receipt_path = self.directory/'bundle.json'
        receipt = json.loads(receipt_path.read_text())
        receipt['files']['proxy.cfg'] = install.files.digest(path.read_bytes())
        receipt_path.write_text(json.dumps(receipt))
        with self.assertRaisesRegex(ValueError,'CONFIGURATION_CHANGED'):
            install.install(config())
        self.assertFalse(self.commands)
        self.binary_mock.assert_not_called()
        self.assertFalse((self.directory/'installation.json').exists())

    def test_missing_invalid_or_linked_credentials_fail_before_service_writes(self):
        cookie = self.directory/'cookie-secret'
        cookie.write_bytes(b'x'*31)
        with self.assertRaisesRegex(ValueError,'CREDENTIAL_FORMAT_CHANGED'):
            install.install(config())
        cookie.unlink()
        cookie.symlink_to(self.directory/'client-secret')
        with self.assertRaises(OSError):
            install.install(config())
        self.assertFalse(self.commands)

    def test_existing_service_and_dropin_are_not_overwritten_or_stopped(self):
        unit = 'ssh-portal-oidc-synthetic-install-proxy.service'
        path = self.units/unit
        path.write_bytes(b'existing')
        with self.assertRaisesRegex(ValueError,'SERVICE_ALREADY_EXISTS'):
            install.install(config())
        self.assertEqual(path.read_bytes(),b'existing')
        path.unlink()
        self.overrides.add(unit)
        with self.assertRaisesRegex(ValueError,'SERVICE_ALREADY_EXISTS'):
            install.install(config())
        self.assertFalse(self.commands)

    def test_second_start_failure_stops_owned_services_and_removes_only_owned_units(self):
        self.fail_start = 'ssh-portal-oidc-synthetic-install-caddy.service'
        with self.assertRaisesRegex(install.ProvisionFailure,'SYNTHETIC_START_FAILURE'):
            install.install(config())
        self.assertFalse(self.active)
        self.assertEqual(self.state()['status'],'REMOVED')
        self.assertFalse(list(self.units.glob('*.service')))
        self.assertTrue((self.directory/'client-secret').exists())

    def test_changed_owned_unit_or_start_link_or_dropin_stops_removal(self):
        install.install(config())
        unit = 'ssh-portal-oidc-synthetic-install-proxy.service'
        path = self.units/unit
        original = path.read_bytes()
        path.write_bytes(b'foreign replacement')
        commands = len(self.commands)
        with self.assertRaisesRegex(ValueError,'OWNED_SERVICE_UNIT_CHANGED'):
            install.remove(config())
        self.assertEqual(len(self.commands),commands)
        path.write_bytes(original)
        link = install.wanted(unit)
        link.unlink()
        link.symlink_to('/synthetic/foreign.service')
        with self.assertRaisesRegex(ValueError,'OWNED_START_LINK_CHANGED'):
            install.remove(config())
        self.assertEqual(len(self.commands),commands)

    def test_global_lock_blocks_parallel_install(self):
        with install.locked():
            with self.assertRaises(BlockingIOError):
                install.install(config())
        self.assertFalse(self.commands)

    def test_dropin_added_after_install_prevents_any_stop(self):
        install.install(config())
        self.overrides.add('ssh-portal-oidc-synthetic-install-proxy.service')
        commands = len(self.commands)
        with self.assertRaisesRegex(ValueError,'SERVICE_UNIT_OVERRIDDEN'):
            install.remove(config())
        self.assertEqual(len(self.commands),commands)
        self.assertEqual(len(self.active),2)

    def test_new_lock_keeps_private_mode_under_restrictive_umask(self):
        previous=os.umask(0o777)
        try:
            with install.locked():
                self.assertEqual(stat.S_IMODE((self.base/'installation.lock').stat().st_mode),0o600)
        finally:
            os.umask(previous)

    def test_unrecorded_partial_unit_is_retained_for_manual_review(self):
        create = install.files.create_file
        failed = 'ssh-portal-oidc-synthetic-install-caddy.service'
        def failure(path,data,mode):
            result = create(path,data,mode)
            if path == self.units/failed:
                raise OSError('synthetic close error after publication')
            return result
        with patch.object(install.files,'create_file',side_effect=failure):
            with self.assertRaises(OSError):
                install.install(config())
        self.assertEqual(self.state()['status'],'FAILED_REVIEW_REQUIRED')
        self.assertTrue((self.units/failed).exists())
        self.assertFalse(self.active)

    def test_unsupported_architecture_never_installs(self):
        with patch.object(install.platform,'machine',return_value='aarch64'):
            with self.assertRaisesRegex(ValueError,'PINNED_LINUX_AMD64_REQUIRED'):
                install.install(config())
        self.assertFalse(self.commands)
        self.binary_mock.assert_not_called()

    def test_binary_pins_publish_exclusively_and_reject_changed_or_linked_bytes(self):
        self.binary_mock.side_effect = None
        # Restore the production function saved on the mock by the context below.
        self.stack.close()
        self.stack = contextlib.ExitStack()
        self.root.chmod(0o755)
        target_dir = self.root/'binary-cache'
        target_dir.mkdir(mode=0o755)
        target = target_dir/'synthetic'
        source = self.root/'synthetic-source'
        data = b'synthetic pinned binary bytes; never executed'
        source.write_bytes(data)
        source.chmod(0o755)
        pin = (len(data),hashlib.sha256(data).hexdigest())
        with patch.object(install,'BINARIES',{str(target):pin}):
            source.write_bytes(b'wrong public artifact')
            with self.assertRaisesRegex(ValueError,'OFFICIAL_BINARY_MISMATCH'):
                install.binary(target,source)
            self.assertFalse(target.exists())
            source.write_bytes(data)
            install.binary(target,source)
            self.assertEqual(target.read_bytes(),data)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode),0o755)
            inode = target.stat().st_ino
            install.binary(target)
            self.assertEqual(target.stat().st_ino,inode)
            target.write_bytes(b'existing changed bytes')
            with self.assertRaisesRegex(ValueError,'OFFICIAL_BINARY_MISMATCH'):
                install.binary(target,source)
            self.assertEqual(target.read_bytes(),b'existing changed bytes')
            target.unlink()
            target.symlink_to(source)
            with self.assertRaises(install.ProvisionFailure):
                install.binary(target,source)
            self.assertTrue(target.is_symlink())


if __name__ == '__main__':
    unittest.main()
