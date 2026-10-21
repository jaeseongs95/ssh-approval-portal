import contextlib
import hashlib
import io
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.request import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
import cloudflare_binary as cb
import cloudflare_connector as cc
import cloudflare_provision as cp
import cloudflare_setup as cf
import portal

SECRET = 'SYNTHETIC_API_CREDENTIAL_NEVER_FORWARD'
URL = 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.1/cloudflared-linux-amd64'
NATIVE = sys.platform.startswith('linux') and os.geteuid() == 0 and os.environ.get('CLOUDFLARED_BINARY_FIXTURE') == '1'


class Portable(unittest.TestCase):
    def test_explicit_cli_forwarding_choice_and_nonmutating_dry_run(self):
        args = ['--connector', '--state-dir', '/root/new', '--install-cloudflared']
        with patch.object(cf, 'main', return_value=0) as child:
            self.assertEqual(portal.main(['connect', 'cloudflare', *args]), 0)
            self.assertEqual(child.call_args.args[0], args)
        with patch.object(cp, 'Journal') as state, patch.object(cf.getpass, 'getpass') as getpass, \
                patch.object(cb, 'ensure_installed') as install, contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cf.main([*args, '--dry-run']), 0)
            self.assertIn('"binaryInstallRequested": true', output.getvalue())
            state.assert_not_called(); getpass.assert_not_called(); install.assert_not_called()
        for args in [['--install-cloudflared'], ['--remove-connector', '--state-dir', '/root/new', '--install-cloudflared']]:
            with patch.object(cf.getpass, 'getpass') as getpass, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(cf.main(args), 1); getpass.assert_not_called()
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            cf.main(['--connector', '--state-dir', '/root/new', '--install-cloudflared', '--cloudflared', '/usr/bin/cloudflared'])
        with self.assertRaises(ValueError):
            portal.plan(portal.arguments(['connect', 'access', '--install-cloudflared']))

    def test_platform_root_tty_rejected_before_any_install_or_secret(self):
        for kind, uid in [('win32', 0), ('linux', 1000)]:
            with patch.object(cb.sys, 'platform', kind), patch.object(cb.os, 'geteuid', return_value=uid, create=True), \
                    patch.object(cb, 'public_directory') as directory:
                with self.assertRaises(cp.ProvisionFailure): cb.ensure_installed()
                directory.assert_not_called()
        with patch.object(cb.sys, 'platform', 'linux'), patch.object(cb.os, 'geteuid', return_value=0, create=True), \
                patch.object(cb.platform, 'machine', return_value='unsupported-cpu'), patch.object(cb, 'public_directory') as directory:
            with self.assertRaisesRegex(cp.ProvisionFailure, 'CPU_UNSUPPORTED'): cb.ensure_installed()
            directory.assert_not_called()
        with patch.object(cf.sys.stdin, 'isatty', return_value=False), patch.object(cf.getpass, 'getpass') as getpass, \
                patch.object(cb, 'ensure_installed') as install, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cf.main(['--connector', '--state-dir', '/root/new', '--install-cloudflared']), 1)
            getpass.assert_not_called(); install.assert_not_called()

    def test_https_redirect_allowlist_rejects_credentials_other_hosts_and_versions(self):
        self.assertTrue(cb.allowed_url(URL))
        cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/fixture?signature=public'
        self.assertTrue(cb.allowed_url(cdn))
        for url in [URL.replace('https:', 'http:'), URL.replace('github.com', 'evil.invalid'), URL+'?token='+SECRET,
                    URL.replace('2026.10.1', '2020.1.0'), URL.replace('https://', 'https://owner:password@'),
                    URL.replace('github.com', 'github.com:bad'), URL+'#fragment', URL.replace('/cloudflare', '/\ncloudflare'),
                    'https://release-assets.githubusercontent.com.evil.invalid/a']:
            self.assertFalse(cb.allowed_url(url))
            with self.assertRaises(ValueError): cb.ReleaseRedirect().redirect_request(Request(URL), None, 302, '', {}, url)
        redirected = cb.ReleaseRedirect().redirect_request(Request(URL), None, 302, '', {}, cdn)
        self.assertNotIn('Authorization', redirected.headers)

    def test_download_size_deadline_and_secret_free_request_and_errors(self):
        data = b'fixture-response'
        class Response(io.BytesIO):
            status = 200
            headers = {}
        def perform(body, *, status=200, headers=None, times=None):
            response = Response(body); response.status = status; response.headers = headers or {}
            def opened(request, timeout):
                self.assertEqual(request.full_url, URL); self.assertEqual(timeout, 15)
                self.assertNotIn('Authorization', request.headers)
                self.assertNotIn(SECRET, repr(request.headers))
                return response
            with patch.object(cb, 'build_opener', return_value=SimpleNamespace(open=opened)) as build, \
                    patch.dict(os.environ, {'CLOUDFLARE_API_TOKEN': SECRET, 'HTTPS_PROXY': 'http://'+SECRET}), \
                    contextlib.ExitStack() as stack:
                if times is not None: stack.enter_context(patch.object(cb.time, 'monotonic', side_effect=times))
                output = io.BytesIO(); cb.download(URL, output, len(data))
                self.assertEqual(build.call_args.args[0].proxies, {})
                return output.getvalue()
        self.assertEqual(perform(data), data)
        for body, kwargs in [(data[:-1], {}), (data+b'x', {}), (data, {'status': 403}),
                             (data, {'headers': {'Content-Length': '999'}}), (data, {'times': [0, 61]})]:
            with self.assertRaisesRegex(cp.ProvisionFailure, '^CLOUDFLARED_DOWNLOAD_FAILED$'): perform(body, **kwargs)
        with patch.object(cb, 'build_opener', side_effect=OSError(SECRET)):
            with self.assertRaisesRegex(cp.ProvisionFailure, '^CLOUDFLARED_DOWNLOAD_FAILED$'): cb.download(URL, io.BytesIO(), 5)


@unittest.skipUnless(NATIVE, 'Explicit isolated Linux root Docker fixture required')
class Filesystem(unittest.TestCase):
    def setUp(self):
        assert Path('/.dockerenv').exists()
        assert any(line.split()[4] == '/fixture' and ' - tmpfs ' in line for line in Path('/proc/self/mountinfo').read_text().splitlines())
        self.tmp = tempfile.TemporaryDirectory(dir='/fixture'); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.root.chmod(0o755)
        self.cache = self.root/'cache'
        self.data = b'#!/bin/sh\nprintf "cloudflared version 2026.10.1 (fixture)\\n"\n' + b'#'+b' '*200+b'\n'
        self.spec = dict(cb.ARTIFACTS)
        self.patch = patch.object(cb, 'ARTIFACTS', {platform.machine(): ('amd64', len(self.data), hashlib.sha256(self.data).hexdigest())})
        self.patch.start(); self.addCleanup(self.patch.stop)
        patcher = patch.object(cb, 'CACHE', self.cache); patcher.start(); self.addCleanup(patcher.stop)
        patcher = patch.object(cb, 'download', side_effect=lambda url, stream, size: stream.write(self.data))
        self.downloader = patcher.start(); self.addCleanup(patcher.stop)
        self.target = self.cache/'cloudflared-2026.10.1-linux-amd64'

    def assert_clean_stage(self):
        self.assertEqual(list(self.cache.glob('.download-*')), [])

    def test_install_and_verified_reuse_without_touching_foreign_files(self):
        foreign = self.root/'existing-service'; foreign.write_bytes(b'unchanged')
        self.assertEqual(cb.ensure_installed(), self.target)
        self.assertEqual(cb.ensure_installed(), self.target)
        self.assertEqual(self.downloader.call_count, 1)
        self.assertEqual(self.target.read_bytes(), self.data)
        info = self.target.lstat()
        self.assertEqual((info.st_uid, info.st_nlink, stat.S_IMODE(info.st_mode)), (0, 1, 0o755))
        self.assertEqual(foreign.read_bytes(), b'unchanged'); self.assert_clean_stage()

    def test_corrupt_same_size_artifact_is_not_executed_or_published(self):
        marker = self.root/'executed'
        bad = ('#!/bin/sh\ntouch '+str(marker)+'\n').encode().ljust(len(self.data), b' ')
        self.assertEqual(len(bad), len(self.data))
        self.downloader.side_effect = lambda url, stream, size: stream.write(bad)
        with self.assertRaises(cp.ProvisionFailure): cb.ensure_installed()
        self.assertFalse(marker.exists(), 'Corrupt artifact was executed')
        self.assertFalse(self.target.exists(), 'Corrupt artifact was published'); self.assert_clean_stage()

    def test_partial_download_and_wrong_version_leave_no_public_file(self):
        def broken(url, stream, size): stream.write(b'partial'); raise OSError(SECRET)
        self.downloader.side_effect = broken
        with self.assertRaisesRegex(cp.ProvisionFailure, '^CLOUDFLARED_INSTALL_FAILED$'): cb.ensure_installed()
        self.assertFalse(self.target.exists()); self.assert_clean_stage()
        self.downloader.side_effect = lambda url, stream, size: stream.write(self.data)
        with patch.object(cc, 'command', return_value=SimpleNamespace(returncode=0, stdout=b'cloudflared version 2025.3.0\n')):
            with self.assertRaisesRegex(cp.ProvisionFailure, 'VERSION_MISMATCH'): cb.ensure_installed()
        self.assertFalse(self.target.exists()); self.assert_clean_stage()

    def test_changed_cached_binary_is_not_replaced_or_executed(self):
        cb.ensure_installed(); changed = b'owner-changed'; self.target.write_bytes(changed)
        self.downloader.reset_mock()
        with patch.object(cc, 'command') as command:
            with self.assertRaisesRegex(cp.ProvisionFailure, 'BINARY_CHANGED'): cb.ensure_installed()
            command.assert_not_called()
        self.downloader.assert_not_called(); self.assertEqual(self.target.read_bytes(), changed)

    def test_foreign_path_links_and_parent_modes_are_refused(self):
        foreign = self.root/'foreign'; foreign.mkdir(); (foreign/'kept').write_bytes(b'kept')
        self.cache.symlink_to(foreign)
        with self.assertRaises(cp.ProvisionFailure): cb.ensure_installed()
        self.cache.unlink(); self.downloader.assert_not_called()
        for mode in [0o777, 0o700]:
            self.root.chmod(mode)
            with self.assertRaises(cp.ProvisionFailure): cb.ensure_installed()
            self.downloader.assert_not_called()
        self.root.chmod(0o755); self.cache.mkdir()
        self.target.symlink_to(foreign/'kept')
        with self.assertRaises(cp.ProvisionFailure): cb.ensure_installed()
        self.assertEqual((foreign/'kept').read_bytes(), b'kept'); self.downloader.assert_not_called()
        self.target.unlink()
        for kind in ['writable', 'nonroot', 'hardlink', 'fifo']:
            with self.subTest(kind=kind):
                if kind == 'fifo': os.mkfifo(self.target)
                else:
                    self.target.write_bytes(self.data); self.target.chmod(0o755)
                    if kind == 'writable': self.target.chmod(0o777)
                    elif kind == 'nonroot': os.chown(self.target, 1001, 1001)
                    else: os.link(self.target, self.root/'other-link')
                with patch.object(cc, 'command') as command:
                    with self.assertRaises(cp.ProvisionFailure): cb.ensure_installed()
                    command.assert_not_called()
                self.target.unlink()
                if kind == 'hardlink': (self.root/'other-link').unlink()
                self.downloader.assert_not_called()

    def test_exclusive_publication_preserves_a_concurrent_existing_file(self):
        command = cc.command
        def concurrent_file(args, capture=False):
            result = command(args, capture=capture)
            self.target.write_bytes(b'concurrent-owner-file'); self.target.chmod(0o755)
            return result
        with patch.object(cc, 'command', side_effect=concurrent_file):
            with self.assertRaises(cp.ProvisionFailure): cb.ensure_installed()
        self.assertEqual(self.target.read_bytes(), b'concurrent-owner-file', 'Concurrent file was overwritten')
        self.assert_clean_stage()

    def test_connector_handoff_and_failed_preconditions_before_binary_install(self):
        import test_cloudflare_connector as fixture
        f = fixture.Filesystem(); f.setUp(); self.addCleanup(f.doCleanups)
        with patch.object(cb, 'ensure_installed', return_value=f.binary) as install:
            result = cc.install_connector(f.api, f.journal, install_binary=True)
            self.assertEqual(result['status'], 'CONNECTOR_ACTIVE'); install.assert_called_once_with()
            self.assertEqual(cc.load_state(f.journal)['binary'], str(f.binary))
            cc.remove_connector(f.journal)
        # A fresh fixture owns a separate journal and simulated service.
        g = fixture.Filesystem(); g.setUp(); self.addCleanup(g.doCleanups)
        g.api.remote[g.api.tunnel_path]['name'] = 'owner-changed'
        with patch.object(cb, 'ensure_installed') as install:
            with self.assertRaises(cp.ProvisionFailure): cc.install_connector(g.api, g.journal, install_binary=True)
            install.assert_not_called()

    @unittest.skipUnless(os.environ.get('CLOUDFLARED_OFFICIAL_ARTIFACTS'), 'Official artifact is a separate explicit fixture')
    def test_official_pinned_binary_installs_executes_and_reuses(self):
        arch = self.spec[platform.machine()][0]
        official = Path(os.environ['CLOUDFLARED_OFFICIAL_ARTIFACTS'])/('cloudflared-linux-'+arch)
        def copy(url, stream, size):
            with official.open('rb') as source: shutil.copyfileobj(source, stream)
        self.downloader.side_effect = copy
        default = Path('/opt/ssh-approval/cloudflared')
        self.assertTrue(any(line.split()[4] == str(default) and ' - tmpfs ' in line for line in Path('/proc/self/mountinfo').read_text().splitlines()))
        self.assertEqual(list(default.iterdir()), [], 'Never adopt an existing default cache')
        with patch.object(cb, 'ARTIFACTS', self.spec), patch.object(cb, 'CACHE', default):
            target = cb.ensure_installed()
            self.addCleanup(target.unlink)
            self.assertEqual(cb.ensure_installed(), target)
            result = subprocess.run([str(target), '--version'], stdin=subprocess.DEVNULL, capture_output=True,
                                    timeout=10, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
            self.assertEqual(result.returncode, 0)
            self.assertIn(b'cloudflared version 2026.10.1 ', result.stdout)
            self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), self.spec[platform.machine()][2])
        self.assertEqual(self.downloader.call_count, 1)
        self.assertEqual(list(default.glob('.download-*')), [])


if __name__ == '__main__':
    unittest.main()
