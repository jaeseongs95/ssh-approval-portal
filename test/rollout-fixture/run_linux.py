"""First-transition entry point, subject to host-specific review and audit.

No automatic retry or rollback. The task directory and all files are root-owned;
the independent recovery channel and every command are verified before use.
"""
import importlib.util
import json
import os
from pathlib import Path
import pwd
import stat
import sys

# Isolated Python (-I) omits the script directory; add only this pinned private
# task directory before loading the bundled controller modules.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from controller import Identity, rollout
from linux_adapter import LinuxAdapter, checked, verify_release_tree


def regular_private(path):
    info = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
        raise RuntimeError('root private regular file required')


def protected_scope():
    home = Path(pwd.getpwnam('mcpops').pw_dir)
    if not home.is_absolute() or home.resolve() != home:
        raise RuntimeError('noncanonical operations account home')
    return [Path('/etc/ssh-mcp-approval-bridge.env'), Path('/etc/systemd/system/ssh-approval-bridge.service'),
            Path('/usr/local/libexec/ssh-approval-file-helper'), Path('/etc/sudoers'), Path('/etc/sudoers.d'),
            Path('/opt/ssh-approval/node/bin/node'), Path('/opt/ssh-approval/node/bin/npm'),
            Path('/etc/systemd/system/ssh-approval-bridge.service.d'),
            Path('/run/systemd/system/ssh-approval-bridge.service.d'),
            Path('/usr/lib/systemd/system/ssh-approval-bridge.service.d'),
            Path('/usr/local/libexec/ssh-approval-environment-helper'),
            Path('/etc/systemd/system/ssh-approval-env.socket'), Path('/etc/systemd/system/ssh-approval-env@.service'),
            Path('/var/lib/ssh-approval-env'), Path('/var/lib/ssh-mcp/.config/ssh-mcp'),
            Path('/var/lib/ssh-mcp/.ssh'), Path('/var/lib/ssh-mcp/.local/share/ssh-mcp/secrets'),
            home / '.ssh', home / '.codex', home / '.claude', home / '.local/share/ssh-approval-cli']


def main(root):
    root = Path(root)
    info = root.lstat()
    if os.geteuid() != 0 or root.resolve() != root or root.is_symlink() or not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError('root private task directory required')
    os.umask(0o077)
    modules = ('run_linux.py', 'controller.py', 'linux_adapter.py', 'scope_guard.py', 'protected_state.py',
               'staging_guard.py', 'offline-baseline.mjs', 'maintenance-request.mjs')
    for name in ('intent.json', *modules):
        regular_private(root / name)
    intent = json.loads((root / 'intent.json').read_text(encoding='utf-8'))
    required = {'job', 'hostname', 'oldManifest', 'candidateManifest', 'configFingerprint', 'candidateVersion',
                'oldRelease', 'newRelease', 'independentRecoveryChannel', 'controllerDigests'}
    if set(intent) != required or intent['independentRecoveryChannel'] is not True:
        raise RuntimeError('exact target intent required')
    if not isinstance(intent['controllerDigests'], dict) or set(intent['controllerDigests']) != set(modules):
        raise RuntimeError('controller file pin set required')
    from linux_adapter import digest_file
    if any(digest_file(root / name) != intent['controllerDigests'][name] for name in modules):
        raise RuntimeError('controller pin mismatch')
    identity = Identity(intent['job'], intent['hostname'], intent['oldManifest'], intent['candidateManifest'], intent['configFingerprint'])
    source, node = root / 'source', Path('/opt/ssh-approval/node/bin/node')
    old, new = Path(intent['oldRelease']), Path(intent['newRelease'])
    releases = Path('/var/lib/ssh-mcp/app/releases')
    if any(path.parent != releases or path.is_symlink() for path in (old, new)):
        raise RuntimeError('exact release paths required')
    verify_release_tree(source, identity.candidate_manifest, strict=True)
    checked([str(node), str(source / 'scripts/verify.mjs'), str(source)])
    contract_path = source / 'scripts/settings_contract.py'
    spec = importlib.util.spec_from_file_location('settings_contract', contract_path)
    contract = importlib.util.module_from_spec(spec); spec.loader.exec_module(contract)
    env = contract.read_env('/etc/ssh-mcp-approval-bridge.env')
    transfer = Path(env.get('BRIDGE_TRANSFER_ROOT', '/var/lib/ssh-mcp/transfers'))
    audit = Path(env.get('BRIDGE_AUDIT_PATH', '/var/lib/ssh-mcp/.local/share/ssh-mcp/approval-bridge-audit.jsonl'))
    if transfer != Path('/var/lib/ssh-mcp/transfers') or not audit.is_absolute() or audit.resolve() != audit:
        raise RuntimeError('non-default transfer or noncanonical audit path')
    if env.get('BRIDGE_SECRET_STORE_DIR', '/var/lib/ssh-mcp/.local/share/ssh-mcp/secrets') != '/var/lib/ssh-mcp/.local/share/ssh-mcp/secrets':
        raise RuntimeError('custom secret store requires explicit scope')
    ports = contract.validated_ports('/etc/ssh-mcp-approval-bridge.env')
    adapter = LinuxAdapter(root, source, old, new, node, transfer, protected_scope(), audit,
                           command_enabled=env.get('BRIDGE_COMMAND_AUTOMATION', 'false') == 'true', cli_enabled=True,
                           independent_channel=True, mcp_port=ports['mcp'], candidate_version=intent['candidateVersion'],
                           task_pins=intent['controllerDigests'])
    # Reuse the installer's shared flock throughout reservation, activation and release.
    with adapter._update().installer_lock(Path('/var/lib/ssh-mcp/.portal-install.lock')):
        return 0 if rollout(identity, adapter) else 1


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise RuntimeError('task directory required')
        sys.exit(main(sys.argv[1]))
    except Exception as error:
        # RuntimeError messages here are fixed reason strings; other errors may embed paths.
        reason = ': ' + str(error) if type(error) is RuntimeError else ''
        print('rollout refused: ' + type(error).__name__ + reason, file=sys.stderr)
        sys.exit(1)
