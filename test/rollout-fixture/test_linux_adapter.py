import tempfile
import os
import hashlib
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from controller import Identity
from linux_adapter import LinuxAdapter, verify_release_tree


class LinuxAdapterContract(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.a = LinuxAdapter(self.root, self.root / 'source', self.root / 'old', self.root / 'new',
                              self.root / 'node', self.root / 'state', [], self.root / 'audit',
                              command_enabled=True, cli_enabled=False, independent_channel=True,
                              mcp_port=39124, candidate_version='fixture')
        self.i = Identity('test-job', 'test-host', 'a' * 64, 'b' * 64, 'c' * 64)

    def test_release_rejects_changed_instance_without_request(self):
        with patch.object(self.a, '_instance', return_value='different'), patch('linux_adapter.checked') as run:
            with self.assertRaises(RuntimeError):
                self.a.release(self.i, 'd' * 64, 'expected')
            run.assert_not_called()

    def test_release_checks_same_instance_and_unreserved_health(self):
        with patch.object(self.a, '_instance', return_value='instance'), \
             patch.object(self.a, '_active') as active, patch('linux_adapter.checked') as run, \
             patch.object(self.a, '_candidate_health') as health:
            self.a.release(self.i, 'd' * 64, 'instance')
            active.assert_called_once_with(self.a.new)
            self.assertEqual('d' * 64, run.call_args.kwargs['owner'])
            health.assert_called_once_with('instance', maintenance=False)

    def test_compare_rejects_invalid_output(self):
        with patch.object(self.a, '_instance', return_value='instance'), patch('linux_adapter.checked', return_value='unexpected'):
            with self.assertRaises(RuntimeError):
                self.a.compare(self.i, 'd' * 64, 'instance')

    def test_activation_requires_baseline(self):
        with self.assertRaises(RuntimeError):
            self.a.activate_exact(self.i)

    def test_offline_seed_uses_stdin_for_owner_and_published_source(self):
        (self.root / 'offline-baseline.mjs').write_text('fixed helper', encoding='utf-8')
        with patch.object(self.a, '_stage') as stage, patch('linux_adapter.checked') as run:
            self.a.prepare_offline_baseline(self.i, 'd' * 64)
            stage.assert_called_once_with(self.i)
            argv = run.call_args.args[0]
            self.assertIn(str(self.a.new), argv)
            self.assertNotIn('d' * 64, argv)
            self.assertEqual('d' * 64, run.call_args.kwargs['owner'])
            self.assertEqual('mcpbridge', run.call_args.kwargs['user'])

    def test_release_pin_rejects_changed_executable_before_execution(self):
        root = self.root / 'release'
        scripts = root / 'scripts'
        scripts.mkdir(parents=True)
        entries = []
        for name in ('verify.mjs', 'update_release.py', 'settings_contract.py'):
            path = scripts / name
            path.write_bytes(b'fixture')
            entries.append({'path': 'scripts/' + name, 'size': 7, 'sha256': hashlib.sha256(b'fixture').hexdigest()})
        manifest = root / 'release-manifest.json'
        manifest.write_text(json.dumps({'files': entries}), encoding='utf-8')
        pin = hashlib.sha256(manifest.read_bytes()).hexdigest()
        verify_release_tree(root, pin)
        (scripts / 'verify.mjs').write_bytes(b'tamper!')
        with self.assertRaises(RuntimeError):
            verify_release_tree(root, pin)

    def test_helper_mismatch_fails_before_replacement(self):
        self.a.helper = self.root / 'helper'
        self.a.helper.write_bytes(b'installed')
        self.a.old.joinpath('helper').mkdir(parents=True)
        self.a.new.joinpath('helper').mkdir(parents=True)
        self.a.old.joinpath('helper/environment-helper.py').write_bytes(b'old')
        self.a.new.joinpath('helper/environment-helper.py').write_bytes(b'new')
        self.a.baseline = {'paths': {str(self.a.helper): {'sha256': hashlib.sha256(b'installed').hexdigest()}}}
        with patch.object(self.a, '_install_helper') as install:
            with self.assertRaises(RuntimeError):
                self.a._replace_helper()
            install.assert_not_called()
        self.assertEqual(b'installed', self.a.helper.read_bytes())

    def test_helper_backup_and_new_digest_are_bound(self):
        self.a.helper = self.root / 'helper'
        self.a.helper.write_bytes(b'old')
        self.a.old.joinpath('helper').mkdir(parents=True)
        self.a.new.joinpath('helper').mkdir(parents=True)
        self.a.old.joinpath('helper/environment-helper.py').write_bytes(b'old')
        self.a.new.joinpath('helper/environment-helper.py').write_bytes(b'new')
        old_hash, new_hash = (hashlib.sha256(value).hexdigest() for value in (b'old', b'new'))
        self.a.protected_files = [self.a.helper]
        self.a.baseline = {'paths': {str(self.a.helper): {'sha256': old_hash}}}
        with patch.object(os, 'O_NOFOLLOW', getattr(os, 'O_NOFOLLOW', 0), create=True), \
             patch.object(self.a, '_install_helper') as install, \
             patch('linux_adapter.scope_guard.snapshot', return_value={str(self.a.helper): {'sha256': new_hash}}):
            backup, found_old, found_new = self.a._replace_helper()
            self.assertEqual(b'old', backup.read_bytes())
            self.assertEqual((old_hash, new_hash), (found_old, found_new))
            install.assert_called_once_with(self.a.new / 'helper/environment-helper.py', new_hash, old_hash)

    def test_owner_is_private_and_one_use(self):
        with patch.object(os, 'O_NOFOLLOW', getattr(os, 'O_NOFOLLOW', 0), create=True):
            owner = self.a.make_owner(self.i)
            self.assertEqual(64, len(owner))
            self.assertEqual(owner, self.a.owner_path.read_text())
            with self.assertRaises(FileExistsError):
                self.a.make_owner(self.i)

if __name__ == '__main__':
    unittest.main()
