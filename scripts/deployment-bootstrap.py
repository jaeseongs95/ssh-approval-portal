#!/usr/bin/env python3
"""Fresh-host guard and the small handoff to the pinned deployment executor."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys

BASE = Path('/var/lib/ssh-mcp')
ENVIRONMENT = Path('/etc/ssh-mcp-approval-bridge.env')
UNIT = Path('/etc/systemd/system/ssh-approval-bridge.service')
EXISTING_MESSAGE = ('Existing installation or interrupted provisioning: use '
                    'portal.py deploy plan/apply/status/resume.')


def exists(path):
    return os.path.lexists(path)


def require_fresh_installation(base=BASE, environment=ENVIRONMENT, unit=UNIT):
    """An offline or broken installation is still an installation, not a fresh host."""
    markers = [base / 'app', base / 'deployments', base / 'data', base / 'transfers',
               base / '.config/ssh-mcp/config.toml', base / '.local/share/ssh-mcp',
               environment, unit,
               Path('/lib/systemd/system/ssh-approval-bridge.service'),
               Path('/usr/lib/systemd/system/ssh-approval-bridge.service'),
               Path('/etc/ssh-approval-portal/docker-secrets.env'),
               Path('/usr/local/libexec/ssh-approval-file-helper')]
    if any(exists(path) for path in markers):
        raise ValueError(EXISTING_MESSAGE)
    # Do not follow a link in a root provisioning destination, including dangling links.
    for path in [base, base / '.ssh', base / '.config', base / '.config/ssh-mcp',
                 base / '.local', base / '.local/share', Path('/var/lib/ssh-approval-transfer'),
                 Path('/var/lib/ssh-approval-transfer/incoming'), Path('/usr/local/libexec')]:
        check_path(path, directory=True)
    for path in [base / '.ssh/id_ed25519', base / '.ssh/id_ed25519.pub',
                 Path('/etc/sudoers.d/90-mcpops-approval-bridge')]:
        check_path(path, directory=False)
    if exists(base / '.ssh/id_ed25519.pub') and not exists(base / '.ssh/id_ed25519'):
        raise ValueError('Public SSH key exists without its private key; refusing replacement.')


def check_path(path, *, directory):
    path = Path(path)
    for parent in reversed(path.parents):
        if exists(parent) and (parent.is_symlink() or not parent.is_dir()):
            raise ValueError('Unsafe provisioning parent: ' + str(parent))
    if exists(path):
        info = path.lstat()
        valid = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1
        if not valid:
            raise ValueError('Unsafe provisioning destination: ' + str(path))


def check_home(home):
    home = Path(home)
    if not home.is_absolute() or '..' in home.parts or home == Path('/'):
        raise ValueError('Unsafe account home')
    check_path(home, directory=True)
    check_path(home / '.ssh', directory=True)
    check_path(home / '.ssh/authorized_keys', directory=False)


def entry_module(source):
    path = Path(source) / 'scripts/deployment_entry.py'
    spec = importlib.util.spec_from_file_location('deployment_entry', path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def start(source, manifest_sha256):
    entry = entry_module(source)
    engine = entry.install_executor(source, manifest_sha256)
    plan = engine.create_plan(source, manifest_sha256=manifest_sha256, fresh_install=True)
    return engine.apply_plan(plan)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Fresh provisioning and pinned first deployment')
    parser.add_argument('command', choices=['preflight', 'start', 'check-home'])
    parser.add_argument('home', nargs='?')
    parser.add_argument('--source', type=Path)
    parser.add_argument('--manifest-sha256')
    options = parser.parse_args(argv)
    if os.geteuid() != 0:
        raise ValueError('ROOT_REQUIRED')
    if options.command == 'check-home':
        check_home(options.home or '')
        return 0
    if options.source is None or options.manifest_sha256 is None:
        parser.error('--source and --manifest-sha256 are required')
    if options.command == 'preflight':
        require_fresh_installation()
        entry_module(options.source).verify_source(options.source, options.manifest_sha256)
        return 0
    result = start(options.source, options.manifest_sha256)
    print(json.dumps(result, ensure_ascii=False))
    print('Provisioning prepared; deployment completion requires portal.py deploy status JOB_ID.', file=sys.stderr)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
