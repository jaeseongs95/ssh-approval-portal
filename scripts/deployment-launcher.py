#!/usr/bin/env python3
"""Start exactly one committed code/data generation; no legacy-path fallback."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

ACTIVE = Path('/var/lib/ssh-mcp/deployments/active.json')
RELEASES = Path('/var/lib/ssh-mcp/app/releases')
GENERATIONS = Path('/var/lib/ssh-mcp/data/generations')
ENVIRONMENT = Path('/etc/ssh-mcp-approval-bridge.env')
NODE = Path('/opt/ssh-approval/node/bin/node')
JOB = re.compile(r'deploy-[a-f0-9]{32}')
SHA = re.compile(r'[a-f0-9]{64}')


class LaunchRefused(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise LaunchRefused(code)


def trusted_parents(path):
    require(path.is_absolute() and '..' not in path.parts, 'INVALID_PATH')
    for parent in reversed(path.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                and not info.st_mode & 0o022, 'UNTRUSTED_PARENT')


def read_root_file(path, limit):
    trusted_parents(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0
                and before.st_nlink == 1 and not before.st_mode & 0o022
                and before.st_size <= limit, 'UNTRUSTED_FILE')
        raw = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
        identity = lambda info: (info.st_dev, info.st_ino, info.st_mode, info.st_uid,
                                 info.st_gid, info.st_nlink, info.st_size,
                                 info.st_mtime_ns, info.st_ctime_ns)
        require(identity(before) == identity(after) and len(raw) == before.st_size
                and identity(path.lstat()) == identity(after), 'FILE_CHANGED')
        return raw


def select_generation(active=ACTIVE, releases=RELEASES, generations=GENERATIONS,
                      environment=ENVIRONMENT, node=NODE, uid=None):
    """Parameters allow isolated Linux fixtures; the executable accepts no paths."""
    value = json.loads(read_root_file(active, 65536))
    require(isinstance(value, dict) and value.get('schemaVersion') == 1, 'ACTIVE_SCHEMA')
    generation = value.get('generation')
    require(isinstance(generation, str) and JOB.fullmatch(generation), 'ACTIVE_GENERATION')
    for key in ('release', 'dataRoot', 'environmentFile', 'manifestSha256'):
        require(isinstance(value.get(key), str), 'ACTIVE_FIELDS')
    release = Path(value['release'])
    data = Path(value['dataRoot'])
    require(release.is_absolute() and release.parent == releases and '..' not in release.parts,
            'ACTIVE_RELEASE')
    require(data == generations / generation / 'transfers', 'ACTIVE_DATA')
    require(value['environmentFile'] == str(environment), 'ACTIVE_ENVIRONMENT')
    require(SHA.fullmatch(value['manifestSha256']), 'ACTIVE_MANIFEST')
    raw = read_root_file(release / 'release-manifest.json', 4 * 1024 * 1024)
    require(hashlib.sha256(raw).hexdigest() == value['manifestSha256'], 'MANIFEST_CHANGED')
    manifest = json.loads(raw)
    require(isinstance(manifest, dict) and isinstance(manifest.get('files'), list), 'MANIFEST_SCHEMA')
    entries = [entry for entry in manifest['files']
               if isinstance(entry, dict) and entry.get('path') == 'bridge.mjs']
    require(len(entries) == 1, 'ENTRY_NOT_PINNED')
    entry = read_root_file(release / 'bridge.mjs', 16 * 1024 * 1024)
    require(len(entry) == entries[0].get('size')
            and hashlib.sha256(entry).hexdigest() == entries[0].get('sha256'), 'ENTRY_CHANGED')
    trusted_parents(data)
    info = data.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == (os.geteuid() if uid is None else uid)
            and stat.S_IMODE(info.st_mode) == 0o700, 'UNTRUSTED_DATA')
    trusted_parents(environment)
    info = environment.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
            and not info.st_mode & 0o077, 'UNTRUSTED_ENVIRONMENT')
    # The full runtime is verified before promotion. Startup also rejects mutable
    # or linked entrypoints rather than falling back to PATH or a previous release.
    trusted_parents(node)
    info = node.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
            and not info.st_mode & 0o022, 'UNTRUSTED_RUNTIME')
    require(os.access(node, os.X_OK), 'RUNTIME_NOT_EXECUTABLE')
    return value


def main():
    require(len(sys.argv) == 1 and sys.platform == 'linux', 'FIXED_LINUX_ENTRYPOINT')
    value = select_generation()
    environment = dict(os.environ)
    environment.pop('NODE_OPTIONS', None)
    environment.pop('NODE_PATH', None)
    # PID 1 already read the fixed, root-only EnvironmentFile. Re-reading it as
    # mcpbridge would fail and would let its old transfer path override selection.
    environment.pop('BRIDGE_SECRET_ENV_FILE', None)
    environment['BRIDGE_TRANSFER_ROOT'] = value['dataRoot']
    os.chdir(value['release'])
    os.execve(NODE, [str(NODE), str(Path(value['release']) / 'bridge.mjs')], environment)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError):
        print('선택된 배포 세대의 신뢰·경로·파일 검증에 실패해 기동을 중단합니다.', file=sys.stderr)
        raise SystemExit(1)
