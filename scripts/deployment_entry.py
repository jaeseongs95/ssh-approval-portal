"""Install and select a pinned executor without changing the running service."""
import hashlib
import errno
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import secrets
import stat
import sys

EXECUTORS = Path('/usr/local/libexec/ssh-approval-deployments')
LAUNCHER = Path('/usr/local/libexec/ssh-approval-launcher')
MODULES = ('deployment.py', 'deployment_migration.py')
JOBS = Path('/var/lib/ssh-mcp/deployments/jobs')


def require(condition, code):
    if not condition:
        raise ValueError(code)


def trusted_directory(path):
    require(path.is_absolute() and '..' not in path.parts, 'INVALID_DIRECTORY')
    for entry in [*reversed(path.parents), path]:
        info = entry.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                and not info.st_mode & 0o022, 'UNTRUSTED_DIRECTORY')


def read_file(path, limit=64 * 1024 * 1024):
    trusted_directory(path.parent)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0
                and before.st_nlink == 1 and not before.st_mode & 0o022
                and before.st_size <= limit, 'UNTRUSTED_FILE')
        data = stream.read(limit + 1)
        identity = lambda value: (value.st_dev, value.st_ino, value.st_uid, value.st_gid,
                                  value.st_mode, value.st_nlink, value.st_size,
                                  value.st_mtime_ns, value.st_ctime_ns)
        require(len(data) == before.st_size
                and identity(before) == identity(os.fstat(stream.fileno()))
                == identity(path.lstat()), 'FILE_CHANGED')
        return data


def verify_source(source, manifest_sha256):
    source = Path(source).absolute()
    trusted_directory(source)
    require(isinstance(manifest_sha256, str) and len(manifest_sha256) == 64
            and all(c in '0123456789abcdef' for c in manifest_sha256), 'MANIFEST_PIN_REQUIRED')
    raw = read_file(source / 'release-manifest.json', 4 * 1024 * 1024)
    require(hashlib.sha256(raw).hexdigest() == manifest_sha256, 'MANIFEST_PIN_MISMATCH')
    manifest = json.loads(raw)
    require(isinstance(manifest, dict) and isinstance(manifest.get('files'), list)
            and 0 < len(manifest['files']) <= 20000, 'MANIFEST_INVALID')
    seen = set()
    for entry in manifest['files']:
        require(isinstance(entry, dict) and isinstance(entry.get('path'), str), 'MANIFEST_MEMBER_INVALID')
        name = entry['path']
        relative = PurePosixPath(name)
        require(not relative.is_absolute() and str(relative) == name and name not in ('', '.')
                and '..' not in relative.parts and '\\' not in name and name not in seen,
                'MANIFEST_MEMBER_INVALID')
        seen.add(name)
        data = read_file(source.joinpath(*relative.parts))
        require(len(data) == entry.get('size')
                and hashlib.sha256(data).hexdigest() == entry.get('sha256'), 'SOURCE_CHANGED')
    required = {'scripts/' + name for name in MODULES} | {
        'scripts/deployment-launcher.py', 'config/ssh-approval-bridge.service',
        'helper/environment-helper.py', 'scripts/deployment-preservation.mjs',
        'scripts/migrate-state.mjs', 'bridge.mjs', 'app.mjs', 'package.json',
        'scripts/install.sh', 'scripts/deployment-bootstrap.py', 'helper/file-helper.py',
        'config/config.example.toml', 'scripts/ensure-node-runtime.sh', 'scripts/generate-secrets.mjs'}
    require(required <= seen, 'DEPLOYMENT_PACKAGE_INCOMPLETE')
    require(json.loads(read_file(source / 'package.json'))['version'] == manifest.get('version'),
            'VERSION_MISMATCH')
    return manifest


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def create_file(path, data, mode):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(descriptor, 'wb') as stream:
        os.fchmod(stream.fileno(), mode)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def load_executor(path):
    read_file(path)
    sys.dont_write_bytecode = True
    name = 'ssh_portal_deployment_executor'
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def install_executor(source, manifest_sha256):
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    source = Path(source).absolute()
    verify_source(source, manifest_sha256)
    trusted_directory(EXECUTORS.parent)
    if not EXECUTORS.exists():
        EXECUTORS.mkdir(mode=0o755)
        sync_directory(EXECUTORS.parent)
    trusted_directory(EXECUTORS)
    destination = EXECUTORS / manifest_sha256
    wanted = {name: read_file(source / 'scripts' / name) for name in MODULES}
    if not destination.exists():
        temporary = EXECUTORS / ('.prepare-' + secrets.token_hex(16))
        temporary.mkdir(mode=0o700)
        for name, raw in wanted.items():
            create_file(temporary / name, raw, 0o644)
        os.chmod(temporary, 0o755)
        sync_directory(temporary)
        try:
            os.rename(temporary, destination)
            sync_directory(EXECUTORS)
        except OSError as error:
            if error.errno not in (errno.EEXIST, errno.ENOTEMPTY):
                raise
            # An independently prepared identical executor is acceptable; verify
            # below. Our root-only temporary copy is retained for inspection.
            pass
    trusted_directory(destination)
    require(set(item.name for item in destination.iterdir()) == set(MODULES), 'EXECUTOR_DIRECTORY_CHANGED')
    for name, raw in wanted.items():
        require(read_file(destination / name) == raw, 'EXECUTOR_CHANGED')
    if not os.path.lexists(LAUNCHER):
        temporary = LAUNCHER.parent / ('.launcher-' + secrets.token_hex(16))
        create_file(temporary, read_file(source / 'scripts/deployment-launcher.py'), 0o755)
        try:
            # No replacement: changing an existing launcher is a journalled
            # worker effect after the old service has stopped.
            os.link(temporary, LAUNCHER, follow_symlinks=False)
        finally:
            temporary.unlink()
        sync_directory(LAUNCHER.parent)
    read_file(LAUNCHER)
    return load_executor(destination / 'deployment.py')


def executor_for_job(job_id):
    import re
    require(isinstance(job_id, str) and re.fullmatch(r'deploy-[a-f0-9]{32}', job_id), 'JOB_ID_INVALID')
    plan = json.loads(read_file(JOBS / job_id / 'plan.json', 8 * 1024 * 1024))
    return executor_for_plan(plan)


def executor_for_plan(plan):
    import re
    pin = plan.get('manifestSha256')
    require(isinstance(pin, str) and re.fullmatch(r'[a-f0-9]{64}', pin), 'MANIFEST_PIN_REQUIRED')
    path = EXECUTORS / pin / 'deployment.py'
    require(plan.get('executor') == str(path), 'EXECUTOR_BOUNDARY_INVALID')
    expected = plan.get('executorFingerprint')
    require(isinstance(expected, dict) and set(expected) == set(MODULES), 'EXECUTOR_FINGERPRINT_INVALID')
    for name in MODULES:
        require(hashlib.sha256(read_file(path.parent / name)).hexdigest() == expected[name], 'EXECUTOR_CHANGED')
    module = load_executor(path)
    module.validate_plan(plan)
    return module
