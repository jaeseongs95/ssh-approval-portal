"""Linux rollout adapter. Requires a separately reviewed, root-owned task directory.

This draft deliberately does not provide a command-line entry point. The caller
must establish an independent recovery channel and hold the installer flock.
Non-cooperating root writers and old releases are not fenced by the API.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import re
import socket
import stat
import subprocess
import time
import uuid
from urllib.request import urlopen

from protected_state import capture, compare
import staging_guard
import scope_guard


def digest_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_release_tree(root, expected):
    root = Path(root)
    if root.is_symlink() or not root.is_dir() or root.resolve() != root:
        raise RuntimeError('unsafe release root')
    manifest = root / 'release-manifest.json'
    if manifest.is_symlink() or not manifest.is_file() or digest_file(manifest) != expected:
        raise RuntimeError('release manifest mismatch')
    value = json.loads(manifest.read_text(encoding='utf-8'))
    rows = value.get('files')
    if not isinstance(rows, list) or not rows or len(rows) > 10000:
        raise RuntimeError('invalid release file list')
    names = set()
    for row in rows:
        name = row.get('path')
        if not isinstance(name, str) or '\\' in name or name.startswith('/') or any(part in ('', '.', '..') for part in name.split('/')) or name in names:
            raise RuntimeError('invalid release entry')
        names.add(name)
        path = root / name
        for parent in (path, *path.parents):
            if parent == root:
                break
            if parent.is_symlink():
                raise RuntimeError('symlink in release entry')
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != row.get('size') or digest_file(path) != row.get('sha256'):
            raise RuntimeError('release entry mismatch')
    for required in ('scripts/verify.mjs', 'scripts/update_release.py', 'scripts/settings_contract.py'):
        if required not in names:
            raise RuntimeError('release verifier missing')


def checked(argv, *, owner=None, user=None):
    command = list(argv) if user is None else ['/usr/bin/sudo', '-n', '-u', user, '--', *argv]
    result = subprocess.run(command, input=owner, text=True, capture_output=True, timeout=180,
                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
    if result.returncode != 0:
        raise RuntimeError('host operation failed')
    return result.stdout


class LinuxAdapter:
    def __init__(self, task_root, source, old_release, new_release, node, state_root,
                 protected_files, audit_path, *, command_enabled, cli_enabled,
                 independent_channel, mcp_port, candidate_version, unit_name='ssh-approval-bridge.service'):
        self.root, self.source = Path(task_root), Path(source)
        self.old, self.new, self.node, self.state_root = map(Path, (old_release, new_release, node, state_root))
        self.active = Path('/var/lib/ssh-mcp/app/approval-bridge')
        self.protected_files, self.audit = protected_files, audit_path
        self.command_enabled, self.cli_enabled = command_enabled, cli_enabled
        self.independent_channel = independent_channel
        if type(mcp_port) is not int or not 1 <= mcp_port <= 65535 or not candidate_version:
            raise ValueError('explicit health contract required')
        self.mcp_port, self.candidate_version = mcp_port, candidate_version
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}\.service', unit_name):
            raise ValueError('invalid unit name')
        self.unit_name = unit_name
        self.owner_path = self.root / 'owner'
        self.helper = Path('/usr/local/libexec/ssh-approval-environment-helper')
        self.baseline = None

    def _private_root(self):
        s = self.root.lstat()
        if self.root.is_symlink() or not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or stat.S_IMODE(s.st_mode) != 0o700:
            raise RuntimeError('unsafe task directory')
        if os.geteuid() != 0 or self.root.resolve() != self.root:
            raise RuntimeError('root-owned canonical task directory required')

    def _instance(self):
        result = checked(['/usr/bin/systemctl', 'show', self.unit_name,
                          '-p', 'InvocationID', '-p', 'MainPID', '-p', 'ActiveState'])
        values = dict(line.split('=', 1) for line in result.splitlines() if '=' in line)
        if values.get('ActiveState') != 'active' or int(values.get('MainPID', '0')) <= 0:
            raise RuntimeError('bridge not active')
        invocation = values.get('InvocationID', '')
        if len(invocation) != 32 or any(c not in '0123456789abcdef' for c in invocation):
            raise RuntimeError('unknown bridge instance')
        return invocation

    def _active(self, release):
        if not self.active.is_symlink() or os.readlink(self.active) != str(release):
            raise RuntimeError('active release changed')

    def _candidate_health(self, instance, maintenance=True):
        with urlopen('http://127.0.0.1:' + str(self.mcp_port) + '/health', timeout=5) as response:
            body = json.load(response)
        if body.get('healthy') is not True or body.get('maintenance') is not maintenance or body.get('version') != self.candidate_version:
            raise RuntimeError('candidate health or reservation mismatch')
        if self._instance() != instance:
            raise RuntimeError('instance changed during health check')

    def inspect(self, identity):
        self._private_root()
        self._active(self.old)
        if self.new.exists() or self.new.is_symlink():
            raise RuntimeError('candidate destination exists')
        if socket.gethostname() != identity.hostname:
            raise RuntimeError('host mismatch')
        old_manifest = digest_file(self.old / 'release-manifest.json')
        new_manifest = digest_file(self.source / 'release-manifest.json')
        verify_release_tree(self.source, identity.candidate_manifest)
        verify_release_tree(self.old, identity.old_manifest)
        checked([str(self.node), str(self.source / 'scripts/verify.mjs'), str(self.source)])
        checked([str(self.node), str(self.source / 'scripts/verify.mjs'), str(self.old)])
        return {'hostname': socket.gethostname(), 'manifest': old_manifest, 'candidate': new_manifest,
                'candidate_verified': True, 'config': digest_file('/etc/ssh-mcp-approval-bridge.env'),
                'old_instance': self._instance(), 'independent_channel': self.independent_channel,
                'durable': False}

    def claim_once(self, identity):
        fd = os.open(self.root / 'run.claim', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as output:
            output.write(identity.job + '\n'); output.flush(); os.fsync(output.fileno())
        return True

    def make_owner(self, identity):
        fd = os.open(self.owner_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        token = secrets.token_hex(32)
        with os.fdopen(fd, 'w') as output:
            output.write(token); output.flush(); os.fsync(output.fileno())
        return token

    def reserve_legacy(self, identity, instance):
        self._active(self.old)
        if self._instance() != instance:
            raise RuntimeError('old instance changed')
        # The exact, separately reviewed legacy helper owns the token loading.
        checked([str(self.node), str(self.root / 'maintenance-request.mjs'), 'reserve'])
        if self._instance() != instance:
            raise RuntimeError('old instance changed after reserve')

    def reserve_and_capture(self, identity, owner, instance):
        raise RuntimeError('durable predecessor not supported by this first-transition adapter')

    def backup_staging(self, identity, instance):
        if self._instance() != instance:
            raise RuntimeError('old instance changed before staging backup')
        self._active(self.old)
        entries = {}
        for path in self.state_root.iterdir():
            if staging_guard.PART.fullmatch(path.name):
                entries[str(path)] = staging_guard.state(path)
        staging_guard.backup(self.state_root, entries, self.root / 'staging-cache')
        if self._instance() != instance:
            raise RuntimeError('old instance changed during staging backup')

    def stop_and_prove(self, identity, instance):
        if self._instance() != instance:
            raise RuntimeError('old instance changed before stop')
        checked(['/usr/bin/systemctl', 'stop', self.unit_name])
        value = checked(['/usr/bin/systemctl', 'show', self.unit_name,
                         '-p', 'ActiveState', '-p', 'MainPID'])
        fields = dict(line.split('=', 1) for line in value.splitlines() if '=' in line)
        if fields.get('ActiveState') not in ('inactive', 'failed') or fields.get('MainPID') != '0':
            raise RuntimeError('service stop not proven')

    def _update(self):
        spec = importlib.util.spec_from_file_location('release_update', self.source / 'scripts/update_release.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def _stage(self, identity):
        import grp
        self._active(self.old)
        module = self._update()
        def verify(stage):
            if digest_file(stage / 'release-manifest.json') != identity.candidate_manifest:
                raise RuntimeError('candidate manifest mismatch')
            checked([str(self.node), str(stage / 'scripts/verify.mjs'), str(stage)])
            checked([str(self.node), str(stage / 'scripts/check-package-imports.mjs')])
        module.publish_release(self.source, self.new, grp.getgrnam('mcpbridge').gr_gid, verify)

    def prepare_offline_baseline(self, identity, owner):
        self._stage(identity)
        # Pass fixed JavaScript, not its root-only task pathname, to the bridge account.
        # Owner is supplied on stdin and never included in argv.
        helper = (self.root / 'offline-baseline.mjs').read_text(encoding='utf-8')
        checked([str(self.node), '--input-type=module', '-e', helper, str(self.new),
                 str(self.state_root), str(self.command_enabled).lower(), str(self.cli_enabled).lower()],
                owner=owner, user='mcpbridge')

    def capture_protected(self, identity):
        if not self.protected_files:
            raise RuntimeError('explicit protected path scope required')
        self.baseline = {'audit': capture([], self.audit), 'paths': scope_guard.snapshot(self.protected_files)}
        return self.baseline

    def _install_helper(self, source, expected_digest, expected_target_digest):
        data = source.read_bytes()
        if hashlib.sha256(data).hexdigest() != expected_digest:
            raise RuntimeError('helper source mismatch')
        target_info = self.helper.lstat()
        if self.helper.is_symlink() or not stat.S_ISREG(target_info.st_mode) or target_info.st_uid != 0 or target_info.st_gid != 0 or stat.S_IMODE(target_info.st_mode) != 0o755 or target_info.st_nlink != 1 or digest_file(self.helper) != expected_target_digest:
            raise RuntimeError('installed helper mismatch')
        temp = self.helper.parent / ('.ssh-approval-helper-' + uuid.uuid4().hex)
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755)
        try:
            with os.fdopen(fd, 'wb') as output:
                output.write(data); output.flush(); os.fchmod(output.fileno(), 0o755); os.fsync(output.fileno())
            current = self.helper.lstat()
            if (current.st_dev, current.st_ino) != (target_info.st_dev, target_info.st_ino) or digest_file(self.helper) != expected_target_digest:
                raise RuntimeError('installed helper changed before replacement')
            os.replace(temp, self.helper)
            directory = os.open(self.helper.parent, os.O_RDONLY | os.O_DIRECTORY)
            try: os.fsync(directory)
            finally: os.close(directory)
        finally:
            if temp.exists(): temp.unlink()

    def _replace_helper(self):
        before = self.baseline['paths'].get(str(self.helper))
        if before is None:
            raise RuntimeError('environment helper not in protected scope')
        if before.get('missing'):
            return None
        old_source, new_source = self.old / 'helper/environment-helper.py', self.new / 'helper/environment-helper.py'
        old_digest, new_digest = digest_file(old_source), digest_file(new_source)
        if before.get('sha256') != old_digest:
            raise RuntimeError('installed helper does not match previous release')
        backup = self.root / 'environment-helper.before'
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as output:
            output.write(self.helper.read_bytes()); output.flush(); os.fsync(output.fileno())
        if digest_file(backup) != old_digest:
            raise RuntimeError('helper backup mismatch')
        self._install_helper(new_source, new_digest, old_digest)
        try:
            updated = scope_guard.snapshot(self.protected_files)
            previous = dict(self.baseline['paths']); previous.pop(str(self.helper))
            candidate = dict(updated); candidate.pop(str(self.helper))
            if previous != candidate or updated[str(self.helper)].get('sha256') != new_digest:
                raise RuntimeError('unexpected protected change while updating helper')
        except Exception:
            if self.active.is_symlink() and os.readlink(self.active) == str(self.old):
                self._install_helper(backup, old_digest, new_digest)
            raise
        self.baseline['paths'] = updated
        return (backup, old_digest, new_digest)

    def activate_exact(self, identity):
        if self.baseline is None:
            raise RuntimeError('protected baseline unavailable')
        module = self._update()
        def verify():
            compare(self.baseline['audit'])
            scope_guard.verify(self.protected_files, self.baseline['paths'])
            if digest_file(self.new / 'release-manifest.json') != identity.candidate_manifest:
                raise RuntimeError('candidate changed')
            checked([str(self.node), str(self.new / 'scripts/verify.mjs'), str(self.new)])
        verify()
        helper_change = self._replace_helper()
        try:
            module.activate_release(self.active, self.old, self.new, verify)
        except Exception:
            # Restore only if the old release still owns the link and the helper
            # remains exactly our candidate. Any ambiguous outcome requires review.
            if helper_change and self.active.is_symlink() and os.readlink(self.active) == str(self.old):
                backup, old_digest, new_digest = helper_change
                self._install_helper(backup, old_digest, new_digest)
            raise

    def start_and_identify(self, identity):
        self._active(self.new)
        staging_guard.before_start(self.state_root, self.root / 'staging-cache')
        checked(['/usr/bin/systemctl', 'start', self.unit_name])
        for _ in range(30):
            try:
                return self._instance()
            except RuntimeError:
                time.sleep(1)
        raise RuntimeError('new instance not active')

    def compare(self, identity, owner, instance):
        if self._instance() != instance:
            raise RuntimeError('new instance changed')
        output = checked([str(self.node), str(self.new / 'scripts/maintenance.mjs'), 'compare'], owner=owner)
        lines = output.splitlines()
        if len(lines) != 2 or lines[1] != 'Maintenance compare confirmed':
            raise RuntimeError('unexpected comparison output')
        result = json.loads(lines[0]); result['status'] = 'PASS'
        return result

    def verify_protected(self, identity, protected, instance):
        if self._instance() != instance:
            raise RuntimeError('new instance changed')
        self._active(self.new)
        if digest_file(self.new / 'release-manifest.json') != identity.candidate_manifest:
            raise RuntimeError('new manifest changed')
        checked([str(self.node), str(self.new / 'scripts/verify.mjs'), str(self.new)])
        compare(protected['audit'])
        scope_guard.verify(self.protected_files, protected['paths'])
        entries = staging_guard.verified(self.root / 'staging-cache')
        for name, saved in entries.items():
            if staging_guard.state(self.state_root / name) != saved['original']:
                raise RuntimeError('staging file changed after restart')
        self._candidate_health(instance)

    def release(self, identity, owner, instance):
        if self._instance() != instance:
            raise RuntimeError('new instance changed before release')
        self._active(self.new)
        checked([str(self.node), str(self.new / 'scripts/maintenance.mjs'), 'release'], owner=owner)
        self._candidate_health(instance, maintenance=False)

    def write_receipt(self, identity, value):
        path = self.root / 'receipt.json'
        # No private baseline, tokens, stdout, or exception text in the receipt.
        temporary = self.root / 'receipt.tmp'
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as output:
            json.dump({'job': identity.job, **value}, output); output.write('\n'); output.flush(); os.fsync(output.fileno())
        os.replace(temporary, path)
