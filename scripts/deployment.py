"""Pinned native deployment jobs. No shell, database rollback, or automatic replay.

The root-owned worker and journal survive bridge restarts. Locks always follow
installer -> environment helper -> job. An interrupted effect is reconciled
against its own durable evidence; an unknown result requires operator review.
"""
import argparse
from contextlib import contextmanager, ExitStack
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import secrets
import shlex
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys
import time
from urllib.request import urlopen

STATE_ROOT = Path('/var/lib/ssh-mcp/deployments')
BASE = Path('/var/lib/ssh-mcp')
RELEASES = BASE / 'app/releases'
DATA = BASE / 'data/generations'
LEGACY_LINK = BASE / 'app/approval-bridge'
ENVIRONMENT = Path('/etc/ssh-mcp-approval-bridge.env')
RUNTIME = Path('/opt/ssh-approval/node')
NODE = RUNTIME / 'bin/node'
SERVICE = 'ssh-approval-bridge.service'
EXECUTORS = Path('/usr/local/libexec/ssh-approval-deployments')
LAUNCHER = Path('/usr/local/libexec/ssh-approval-launcher')
UNIT = Path('/etc/systemd/system') / SERVICE
ENV_HELPER = Path('/usr/local/libexec/ssh-approval-environment-helper')
ENV_LOCK = Path('/var/lib/ssh-approval-env/lock')
CLEAN = {'PATH': '/opt/ssh-approval/node/bin:/usr/sbin:/usr/bin:/sbin:/bin',
         'HOME': '/root', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'}
STAGES = ('prepare', 'reserve', 'stop', 'migrate', 'baseline', 'launcher', 'helper', 'bootstrap', 'reload', 'promote',
          'start', 'compare', 'release', 'final')
JOB_PATTERN = re.compile(r'deploy-[a-f0-9]{32}')
HEX = re.compile(r'[a-f0-9]{64}')


class DeploymentError(RuntimeError):
    """Only stable, non-secret codes cross the CLI boundary."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def need(condition, code):
    if not condition:
        raise DeploymentError(code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def trusted_directory(path):
    path = Path(path)
    need(path.is_absolute() and '..' not in path.parts, 'PATH_NOT_ABSOLUTE')
    for item in [*reversed(path.parents), path]:
        info = item.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
             'UNTRUSTED_DIRECTORY')


def trusted_file(path, limit=16 * 1024 * 1024):
    path = Path(path)
    trusted_directory(path.parent)
    before = path.lstat()
    need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == 0
         and not before.st_mode & 0o022 and before.st_size <= limit, 'UNTRUSTED_FILE')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        need(file_identity(before) == file_identity(os.fstat(stream.fileno())), 'FILE_CHANGED')
        raw = stream.read(limit + 1)
        need(len(raw) == before.st_size and file_identity(before) == file_identity(os.fstat(stream.fileno())) == file_identity(path.lstat()),
             'FILE_CHANGED')
        return raw


def optional_file_digest(path):
    if not os.path.lexists(path):
        return None
    return digest(trusted_file(path))


def boot_id():
    value = Path('/proc/sys/kernel/random/boot_id').read_text(encoding='ascii').strip()
    need(re.fullmatch('[a-f0-9-]{36}', value), 'BOOT_ID_INVALID')
    return value


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def atomic_json(path, value, *, mode=0o600, gid=None):
    path = Path(path)
    temporary = path.parent / ('.deploy-' + secrets.token_hex(16))
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(descriptor, mode)
        if gid is not None:
            os.fchown(descriptor, 0, gid)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(canonical(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _command_evidence(directory, argv, stdout, stderr, exit_code):
    if directory is None:
        return
    prefix = Path(directory) / ('command-' + secrets.token_hex(16))
    descriptor = os.open(str(prefix) + '.private.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(stdout or b'')
        stream.write(b'\n--- stderr ---\n')
        stream.write(stderr or b'')
        stream.flush()
        os.fsync(stream.fileno())
    atomic_json(str(prefix) + '.json', {'argv': [str(item) for item in argv], 'exitCode': exit_code})


def run(argv, *, stdin=None, env=None, timeout=180, log_directory=None, accepted_codes=(0,)):
    try:
        result = subprocess.run([str(x) for x in argv], input=stdin, capture_output=True,
                                env=env or CLEAN, timeout=timeout, shell=False)
    except subprocess.TimeoutExpired as error:
        _command_evidence(log_directory, argv, error.stdout, error.stderr, None)
        raise DeploymentError('COMMAND_OUTCOME_UNKNOWN') from None
    _command_evidence(log_directory, argv, result.stdout, result.stderr, result.returncode)
    need(result.returncode in accepted_codes, 'COMMAND_FAILED')
    need(len(result.stdout) <= 8 * 1024 * 1024, 'COMMAND_OUTPUT_LIMIT')
    return result.stdout


def service_state():
    result = run(['/usr/bin/systemctl', 'show', SERVICE, '-p', 'ActiveState', '-p',
                  'SubState', '-p', 'MainPID', '-p', 'InvocationID', '-p', 'LoadState'],
                 timeout=15, accepted_codes=(0, 1))
    value = dict(line.split('=', 1) for line in result.decode().splitlines() if '=' in line)
    need(set(value) == {'ActiveState', 'SubState', 'MainPID', 'InvocationID', 'LoadState'}, 'SERVICE_FIELDS')
    loaded = value.pop('LoadState')
    need(loaded == 'loaded' or loaded == 'not-found' and not os.path.lexists(UNIT)
         and stopped(value), 'SERVICE_LOAD_STATE_UNSUPPORTED')
    return value


def stopped(value):
    return value['ActiveState'] == 'inactive' and value['SubState'] == 'dead' and value['MainPID'] == '0'


def running(value):
    return (value['ActiveState'] == 'active' and value['SubState'] == 'running'
            and value['MainPID'].isdecimal() and int(value['MainPID']) > 0
            and re.fullmatch('[a-f0-9]{32}', value['InvocationID']) is not None)


def managed_tree(path, key):
    """HMAC avoids publishing reusable hashes of low-entropy secrets."""
    path = Path(path)
    if not os.path.lexists(path):
        return {'exists': False}
    summary = []
    paths = [path]
    if path.is_dir() and not path.is_symlink():
        paths += sorted(path.rglob('*'))
    need(len(paths) <= 100000, 'PROTECTED_INVENTORY_LIMIT')
    for entry in paths:
        info = entry.lstat()
        need(not stat.S_ISLNK(info.st_mode) and (stat.S_ISDIR(info.st_mode)
             or stat.S_ISREG(info.st_mode) and info.st_nlink == 1), 'PROTECTED_PATH_UNSAFE')
        item = [str(entry.relative_to(path)), info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)]
        if stat.S_ISREG(info.st_mode):
            need(info.st_size <= 64 * 1024 * 1024, 'PROTECTED_FILE_LIMIT')
            with os.fdopen(os.open(entry, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
                need(file_identity(info) == file_identity(os.fstat(stream.fileno())), 'PROTECTED_FILE_CHANGED')
                item += [hmac.new(key, stream.read(), hashlib.sha256).hexdigest()]
                need(file_identity(info) == file_identity(os.fstat(stream.fileno())) == file_identity(entry.lstat()), 'PROTECTED_FILE_CHANGED')
        summary.append(item)
    return {'exists': True, 'fingerprint': hmac.new(key, canonical(summary), hashlib.sha256).hexdigest()}


def protected_inventory(key):
    paths = [ENVIRONMENT, BASE / '.ssh', BASE / '.config', BASE / '.local/share/ssh-mcp',
             Path('/etc/ssh/ssh_host_ed25519_key'), Path('/etc/ssh/ssh_host_ed25519_key.pub')]
    metadata = {}
    for account_name in ('mcpbridge', 'mcpops'):
        try:
            home = Path(pwd.getpwnam(account_name).pw_dir)
        except KeyError:
            continue
        paths.append(home / '.ssh')
        for relative in ('.codex/auth.json', '.codex/config.toml', '.claude/settings.json',
                         '.claude/.credentials.json', '.claude.json', '.gemini/settings.json',
                         '.gemini/oauth_creds.json', '.gemini/google_accounts.json'):
            paths.append(home / relative)
        for relative in ('.', '.codex', '.claude', '.gemini'):
            directory = home / relative
            if os.path.lexists(directory):
                info = directory.lstat()
                need(stat.S_ISDIR(info.st_mode), 'CLI_HOME_UNSAFE')
                metadata[str(directory)] = {'exists': True, 'uid': info.st_uid,
                    'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}
            else:
                metadata[str(directory)] = {'exists': False}
        settings = home / '.claude/settings.json'
        if settings.exists():
            need(settings.lstat().st_size <= 65536 and not settings.is_symlink(), 'CLI_SETTINGS_UNSAFE')
            try:
                value = json.loads(settings.read_text(encoding='utf-8'))
                helper = value.get('apiKeyHelper') if isinstance(value, dict) else None
                if helper is not None:
                    need(isinstance(helper, str) and len(helper) <= 65536, 'CLI_HELPER_INVALID')
                    # Inspect literal references only. Never evaluate a helper,
                    # shell expression, environment expansion, or configuration.
                    arguments = shlex.split(helper)
                    candidates = [Path(item) for item in arguments if item.startswith('/')]
                    candidates += [Path(item) for item in re.findall(r'(?<![:A-Za-z0-9])(/[A-Za-z0-9_.+@/-]+)', helper)]
                    for candidate in set(candidates):
                        if candidate.is_absolute() and '..' not in candidate.parts and str(candidate).startswith(('/etc/', '/root/', '/usr/local/bin/', '/usr/local/libexec/')):
                            paths.append(candidate)
                            if candidate.is_file() and str(candidate).startswith(('/usr/local/bin/', '/usr/local/libexec/')):
                                script = trusted_file(candidate, 65536).decode('utf-8', errors='strict')
                                for reference in re.findall(r'(?<![:A-Za-z0-9])(/(?:etc|root)/[A-Za-z0-9_.+@/-]+)', script):
                                    target = Path(reference)
                                    need('..' not in target.parts, 'CLI_HELPER_REFERENCE_INVALID')
                                    paths.append(target)
            except (ValueError, UnicodeError):
                raise DeploymentError('CLI_CONFIGURATION_INVALID') from None
    return {str(path): managed_tree(path, key) for path in set(paths)} | {'directoryMetadata': metadata}


def verify_manifest(source, manifest_sha256, *, deployment_package=True):
    source = Path(source)
    trusted_directory(source)
    raw = trusted_file(source / 'release-manifest.json', 4 * 1024 * 1024)
    need(digest(raw) == manifest_sha256, 'MANIFEST_PIN_MISMATCH')
    value = json.loads(raw)
    need(isinstance(value.get('files'), list) and 0 < len(value['files']) <= 20000,
         'MANIFEST_INVALID')
    seen = set()
    for item in value['files']:
        name = item['path']
        relative = PurePosixPath(name)
        need(not relative.is_absolute() and str(relative) == name and '\\' not in name
             and '..' not in relative.parts and name not in seen, 'MANIFEST_MEMBER_INVALID')
        seen.add(name)
        data = trusted_file(source.joinpath(*relative.parts), 64 * 1024 * 1024)
        need(len(data) == item['size'] and digest(data) == item['sha256'], 'SOURCE_CHANGED')
    required = {'bridge.mjs', 'app.mjs', 'package.json', 'package-lock.json', 'scripts/deployment.py',
                'scripts/verify.mjs', 'scripts/deployment-preservation.mjs',
                'scripts/deployment_migration.py', 'scripts/migrate-state.mjs',
                'scripts/deployment-launcher.py', 'config/ssh-approval-bridge.service',
                'helper/environment-helper.py'}
    need(not deployment_package or required <= seen, 'DEPLOYMENT_PACKAGE_INCOMPLETE')
    need(json.loads(trusted_file(source / 'package.json'))['version'] == value['version'],
         'VERSION_MISMATCH')
    return value


def source_layout_preflight(root, uid):
    """Inspect names/modes without bypassing live SQLite exclusive locks."""
    root = Path(root)
    names = {'command-automation.sqlite', 'agent-cli.sqlite', 'maintenance.sqlite',
             'command-outputs/manifest.sqlite'}
    for directory in (root, root / 'command-outputs'):
        if not os.path.lexists(directory):
            continue
        info = directory.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == uid
             and not info.st_mode & 0o077, 'SOURCE_DIRECTORY_UNSAFE')
        for path in directory.iterdir():
            name = path.relative_to(root).as_posix()
            if name == 'command-outputs':
                continue
            allowed = name in names or any(name == item + '-journal' for item in names)
            payload = re.fullmatch(r'(?:[a-f0-9]{48}\.part|command-outputs/[a-f0-9]{48}\.(?:part|out))', name)
            need(allowed or payload, 'SOURCE_LAYOUT_UNSUPPORTED')
            info = path.lstat()
            need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == uid
                 and not info.st_mode & 0o077, 'SOURCE_FILE_UNSAFE')
            if name.endswith('-journal'):
                with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
                    header = stream.read(28)
                need(not header or len(header) == 28 and not any(header), 'SOURCE_JOURNAL_BUSY')


def source_fingerprint(source):
    return digest(trusted_file(Path(source) / 'release-manifest.json'))


def _ensure_state(state_root):
    state_root = Path(state_root)
    need(state_root == STATE_ROOT, 'STATE_ROOT_FIXED')
    trusted_directory(state_root.parent)
    if not state_root.exists():
        state_root.mkdir(mode=0o750)
        state_root.chmod(0o750)
        os.chown(state_root, 0, pwd.getpwnam('mcpbridge').pw_gid)
        sync_directory(state_root.parent)
    trusted_directory(state_root)
    jobs = state_root / 'jobs'
    if not jobs.exists():
        jobs.mkdir(mode=0o700)
        sync_directory(state_root)
    trusted_directory(jobs)
    key_file = state_root / 'fingerprint.key'
    if not key_file.exists():
        descriptor = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(secrets.token_bytes(32))
            stream.flush()
            os.fsync(stream.fileno())
        sync_directory(state_root)
    key = trusted_file(key_file, 32)
    need(len(key) == 32, 'FINGERPRINT_KEY_INVALID')
    return key


@contextmanager
def deployment_locks(job=None):
    import fcntl
    paths = [BASE / '.portal-install.lock']
    environment_lock = ENV_LOCK
    if environment_lock.parent.exists():
        trusted_directory(environment_lock.parent)
        paths.append(environment_lock)
    if job is not None:
        paths.append(Path(job) / 'lock')
    with ExitStack() as stack:
        for path in paths:
            trusted_directory(path.parent)
            descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
            stack.callback(os.close, descriptor)
            info = os.fstat(descriptor)
            need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                 and not info.st_mode & 0o022, 'LOCK_UNTRUSTED')
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise DeploymentError('DEPLOYMENT_BUSY') from None
        yield


def active_state(state_root=STATE_ROOT):
    path = Path(state_root) / 'active.json'
    if not path.exists() and not path.is_symlink():
        return None
    value = json.loads(trusted_file(path, 65536))
    need(value.get('schemaVersion') == 1, 'ACTIVE_SCHEMA_INVALID')
    return value


def _legacy_state():
    need(LEGACY_LINK.is_symlink(), 'LEGACY_IMPORT_REQUIRES_RELEASE_LINK')
    release = Path(os.readlink(LEGACY_LINK))
    need(release.is_absolute() and release.parent == RELEASES, 'LEGACY_RELEASE_INVALID')
    trusted_directory(release)
    # Parse with the existing strict contract, never source ENV as shell code.
    settings = load_module(release / 'scripts/settings_contract.py', 'deployment_settings')
    env = settings.read_env(str(ENVIRONMENT))
    root = Path(env.get('BRIDGE_TRANSFER_ROOT', str(BASE / 'transfers')))
    need(root.is_absolute() and '..' not in root.parts and root == BASE / 'transfers',
         'LEGACY_DATA_PATH_REQUIRES_EXPLICIT_IMPORT')
    manifest = json.loads(trusted_file(release / 'release-manifest.json'))
    need(manifest['version'] == '1.7.0', 'UNSUPPORTED_LEGACY_RELEASE')
    return {'schemaVersion': 0, 'generation': 'legacy-1.7.0', 'release': str(release),
            'dataRoot': str(root), 'environmentFile': str(ENVIRONMENT),
            'manifestSha256': source_fingerprint(release)}


def executor_path(manifest_sha256):
    need(isinstance(manifest_sha256, str) and HEX.fullmatch(manifest_sha256), 'MANIFEST_PIN_REQUIRED')
    return EXECUTORS / manifest_sha256 / 'deployment.py'


def executor_fingerprint(executor):
    directory = Path(executor).parent
    return {name: digest(trusted_file(directory / name)) for name in
            ('deployment.py', 'deployment_migration.py')}


def create_plan(source, *, manifest_sha256, state_root=STATE_ROOT, import_legacy=False, fresh_install=False):
    """Plan a local, externally pinned package; no service or data mutation."""
    need(os.geteuid() == 0, 'ROOT_REQUIRED')
    need(isinstance(manifest_sha256, str) and HEX.fullmatch(manifest_sha256), 'MANIFEST_PIN_REQUIRED')
    source = Path(source).absolute()
    with deployment_locks():
        key = _ensure_state(state_root)
        manifest = verify_manifest(source, manifest_sha256)
        current = active_state(state_root)
        if fresh_install:
            need(not import_legacy and current is None and not os.path.lexists(LEGACY_LINK)
                 and not os.path.lexists(UNIT), 'FRESH_INSTALL_ALREADY_INITIALIZED')
            fresh_root = BASE / 'transfers'
            need(fresh_root.is_dir() and not fresh_root.is_symlink() and not any(fresh_root.iterdir()),
                 'FRESH_DATA_NOT_EMPTY')
            current = {'schemaVersion': 'fresh', 'generation': 'fresh-bootstrap', 'release': None,
                       'dataRoot': str(fresh_root), 'environmentFile': str(ENVIRONMENT),
                       'manifestSha256': None}
        elif current is None:
            need(import_legacy, 'EXPLICIT_LEGACY_IMPORT_REQUIRED')
            current = _legacy_state()
        else:
            need(not import_legacy, 'LEGACY_IMPORT_ALREADY_COMPLETED')
        account = pwd.getpwnam('mcpbridge')
        service = service_state()
        need(running(service) or stopped(service), 'SERVICE_STATE_UNCONFIRMED')
        need(not fresh_install or stopped(service), 'FRESH_SERVICE_ALREADY_RUNNING')
        trusted_directory(RELEASES)
        trusted_file(LAUNCHER)
        unit_sha = optional_file_digest(UNIT)
        target_unit = trusted_file(source / 'config/ssh-approval-bridge.service', 65536)
        need(b'ExecStart=/usr/bin/python3 -I -B /usr/local/libexec/ssh-approval-launcher' in target_unit,
             'TARGET_LAUNCHER_UNIT_REQUIRED')
        executor = executor_path(manifest_sha256)
        fingerprints = executor_fingerprint(executor)
        need(fingerprints == {name: digest(trusted_file(source / 'scripts' / name))
                              for name in fingerprints}, 'INSTALLED_EXECUTOR_MISMATCH')
        checker = load_module(source / 'scripts/node-runtime.py', 'deployment_runtime')
        readiness = []
        try:
            checker.check(RUNTIME)
        except (ValueError, OSError, RuntimeError):
            readiness.append('MANAGED_RUNTIME_REINSTALL_REQUIRED')
        root = Path(current['dataRoot'])
        info = root.lstat()
        need(stat.S_ISDIR(info.st_mode) and not root.is_symlink() and info.st_uid == account.pw_uid
             and info.st_gid == account.pw_gid
             and stat.S_IMODE(info.st_mode) == 0o700, 'SOURCE_DATA_UNSAFE')
        source_layout_preflight(root, account.pw_uid)
        if current['release'] is not None:
            verify_manifest(Path(current['release']), current['manifestSha256'], deployment_package=False)
        schema = {'validation': 'after-clean-stop-before-mutation', 'predecessorManifest': current['manifestSha256']}
        if stopped(service):
            migration = load_module(source / 'scripts/deployment_migration.py', 'deployment_migration_preflight')
            schema = {'validation': 'offline-verified', 'inspection': migration.inspect_state(root, uid=account.pw_uid)}
        job_id = 'deploy-' + secrets.token_hex(16)
        target = RELEASES / ('deployment-' + job_id)
        destination = DATA / job_id / 'transfers'
        need(not os.path.lexists(target) and not os.path.lexists(destination.parent), 'DESTINATION_EXISTS')
        for managed_parent in (DATA.parent, DATA):
            if managed_parent.exists() or managed_parent.is_symlink():
                trusted_directory(managed_parent)
            else:
                ancestor = managed_parent.parent
                while not ancestor.exists():
                    ancestor = ancestor.parent
                trusted_directory(ancestor)
        disk = sum(item.stat().st_size for item in root.rglob('*') if item.is_file() and not item.is_symlink())
        required = max(1024 ** 3, disk * 3)
        need(shutil.disk_usage(BASE).free >= required, 'INSUFFICIENT_DISK')
        plan = {'schemaVersion': 1, 'jobId': job_id, 'host': socket.gethostname(),
                'machineId': digest(trusted_file(Path('/etc/machine-id'), 65536)),
                'source': str(source), 'manifestSha256': manifest_sha256,
                'targetVersion': manifest['version'], 'expectedActive': current,
                'legacyImport': current['schemaVersion'] == 0, 'service': SERVICE,
                'freshInstall': fresh_install,
                'runtime': str(NODE), 'serviceUid': account.pw_uid, 'serviceGid': account.pw_gid,
                'serviceBefore': service, 'executor': str(executor), 'executorFingerprint': fingerprints,
                'launcherFingerprint': digest(trusted_file(LAUNCHER)),
                'targetLauncherFingerprint': digest(trusted_file(source / 'scripts/deployment-launcher.py')),
                'unitFingerprint': unit_sha, 'targetUnitFingerprint': digest(target_unit),
                'helperFingerprint': optional_file_digest(ENV_HELPER),
                'targetHelperFingerprint': digest(trusted_file(source / 'helper/environment-helper.py')),
                'protectedInventory': protected_inventory(key),
                'schema': schema, 'minimumFreeBytes': required, 'readinessErrors': readiness,
                'targetRelease': str(target), 'targetDataRoot': str(destination),
                'allowedNewPaths': [str(target), str(destination.parent)],
                'databaseRollback': 'forbidden', 'createdAt': int(time.time())}
        plan['planSha256'] = digest(canonical(plan))
        return plan


def validate_plan(plan):
    need(isinstance(plan, dict) and plan.get('schemaVersion') == 1, 'PLAN_SCHEMA_INVALID')
    copy = dict(plan)
    expected = copy.pop('planSha256', None)
    need(expected == digest(canonical(copy)), 'PLAN_CHANGED')
    job_id = plan['jobId']
    need(isinstance(job_id, str) and JOB_PATTERN.fullmatch(job_id), 'JOB_ID_INVALID')
    need(plan['targetRelease'] == str(RELEASES / ('deployment-' + job_id))
         and plan['targetDataRoot'] == str(DATA / job_id / 'transfers')
         and plan['allowedNewPaths'] == [plan['targetRelease'], str(DATA / job_id)]
         and plan['service'] == SERVICE and plan['runtime'] == str(NODE)
         and plan['databaseRollback'] == 'forbidden', 'PLAN_BOUNDARY_INVALID')
    need(plan['host'] == socket.gethostname()
         and plan['machineId'] == digest(trusted_file(Path('/etc/machine-id'), 65536)), 'WRONG_HOST')
    need(plan['executor'] == str(executor_path(plan['manifestSha256']))
         and plan['executorFingerprint'] == executor_fingerprint(plan['executor']), 'EXECUTOR_CHANGED')
    need(not plan['readinessErrors'], 'PLAN_NOT_READY')
    account = pwd.getpwnam('mcpbridge')
    need((account.pw_uid, account.pw_gid) == (plan['serviceUid'], plan['serviceGid']),
         'SERVICE_ACCOUNT_CHANGED')
    previous = plan['expectedActive']
    previous_data = Path(previous['dataRoot'])
    if plan.get('freshInstall'):
        need(previous['schemaVersion'] == 'fresh' and previous['release'] is None
             and previous['manifestSha256'] is None and previous_data == BASE / 'transfers'
             and not plan['legacyImport'], 'FRESH_BOUNDARY_INVALID')
    else:
        previous_release = Path(previous['release'])
        need(previous_release.parent == RELEASES and previous_release.is_absolute()
             and '..' not in previous_release.parts, 'PREDECESSOR_BOUNDARY_INVALID')
    need(previous_data.is_absolute()
         and '..' not in previous_data.parts
         and (previous_data == BASE / 'transfers' if plan['legacyImport'] or plan.get('freshInstall')
              else previous_data.parent.parent == DATA)
         and previous['environmentFile'] == str(ENVIRONMENT), 'PREDECESSOR_BOUNDARY_INVALID')


def _job_path(job_id, state_root):
    need(isinstance(job_id, str) and JOB_PATTERN.fullmatch(job_id), 'JOB_ID_INVALID')
    need(Path(state_root) == STATE_ROOT, 'STATE_ROOT_FIXED')
    return Path(state_root) / 'jobs' / job_id


def _launch(plan):
    job_id = plan['jobId']
    executor = Path(plan['executor'])
    trusted_file(executor)
    run(['/usr/bin/systemd-run', '--quiet', '--collect', '--unit=ssh-approval-' + job_id,
         '--property=Type=exec', '--property=Restart=no', '--property=UMask=0077',
         '/usr/bin/python3', '-I', '-B', executor, 'run-worker', job_id], timeout=30)


def apply_plan(plan, *, state_root=STATE_ROOT):
    need(os.geteuid() == 0, 'ROOT_REQUIRED')
    with deployment_locks():
        _ensure_state(state_root)
        validate_plan(plan)
        job = _job_path(plan['jobId'], state_root)
        need(not job.exists() and not job.is_symlink(), 'JOB_ALREADY_EXISTS_USE_RESUME')
        job.mkdir(mode=0o700)
        sync_directory(job.parent)
        atomic_json(job / 'plan.json', plan)
        atomic_json(job / 'journal.json', {'schemaVersion': 1, 'jobId': plan['jobId'],
                    'planSha256': plan['planSha256'], 'state': 'QUEUED', 'stages': {},
                    'databaseRestored': False, 'automaticReplay': False})
        descriptor = os.open(job / 'owner', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(secrets.token_hex(32).encode())
            stream.flush()
            os.fsync(stream.fileno())
        sync_directory(job)
    # A launch acknowledgement is QUEUED, never deployment completion.
    _launch(plan)
    return status(plan['jobId'], state_root=state_root)


def status(job_id, *, state_root=STATE_ROOT):
    need(os.geteuid() == 0, 'ROOT_REQUIRED')
    job = _job_path(job_id, state_root)
    return json.loads(trusted_file(job / 'journal.json', 8 * 1024 * 1024))


def resume(job_id, *, state_root=STATE_ROOT):
    need(os.geteuid() == 0, 'ROOT_REQUIRED')
    job = _job_path(job_id, state_root)
    with deployment_locks(job):
        plan = json.loads(trusted_file(job / 'plan.json', 8 * 1024 * 1024))
        validate_plan(plan)
        current = status(job_id, state_root=state_root)
        if current['state'] == 'PASS':
            return current
    _launch(plan)
    return status(job_id, state_root=state_root)


class SystemBackend:
    """The only host adapter; tests replace it without running a product locally."""
    def __init__(self, plan, job):
        self.plan, self.job = plan, Path(job)
        self.key = trusted_file(STATE_ROOT / 'fingerprint.key', 32)
        self.owner = trusted_file(self.job / 'owner', 64)
        need(re.fullmatch(b'[a-f0-9]{64}', self.owner), 'OWNER_INVALID')
        self.target = Path(plan['targetRelease'])
        self.data = Path(plan['targetDataRoot'])

    def command(self, argv, **options):
        return run(argv, log_directory=self.job, **options)

    def active(self):
        return active_state()

    def protected(self):
        need(protected_inventory(self.key) == self.plan['protectedInventory'], 'PROTECTED_FILES_CHANGED')
        # Unit publication is a separate, journalled effect, not part of the
        # atomic code+data record. Both known unit states are accepted here.
        need(optional_file_digest(UNIT) in (self.plan['unitFingerprint'], self.plan['targetUnitFingerprint'])
             and digest(trusted_file(LAUNCHER)) in
             (self.plan['launcherFingerprint'], self.plan['targetLauncherFingerprint']), 'BOOTSTRAP_CHANGED')
        need(optional_file_digest(ENV_HELPER) in (self.plan['helperFingerprint'], self.plan['targetHelperFingerprint']),
             'ENVIRONMENT_HELPER_CHANGED')

    def predecessor(self):
        current = self.active()
        if self.plan.get('freshInstall'):
            need(current is None and not os.path.lexists(LEGACY_LINK), 'PREDECESSOR_CHANGED')
        elif self.plan['legacyImport'] and current is None:
            need(_legacy_state() == self.plan['expectedActive'], 'PREDECESSOR_CHANGED')
        else:
            need(current == self.plan['expectedActive'], 'PREDECESSOR_CHANGED')

    def maintenance(self, action):
        return self.command([NODE, self.target / 'scripts/maintenance.mjs', action], stdin=self.owner,
                   env=CLEAN | {'BRIDGE_SECRET_ENV_FILE': str(ENVIRONMENT)}, timeout=120)

    def health(self):
        settings = load_module(self.target / 'scripts/settings_contract.py', 'deployment_health_settings')
        port = settings.validated_ports(str(ENVIRONMENT))['mcp']
        with urlopen('http://127.0.0.1:' + str(port) + '/health', timeout=5) as response:
            need(response.status == 200, 'HEALTH_HTTP')
            raw = response.read(65537)
            need(len(raw) <= 65536, 'HEALTH_LIMIT')
            value = json.loads(raw)
        return {key: value.get(key) for key in ('healthy', 'version', 'maintenance', 'busy')}

    def instance(self, maintenance, expected=None):
        service = service_state()
        need(running(service), 'SERVICE_NOT_RUNNING')
        invocation = service['InvocationID']
        need(invocation != self.plan['serviceBefore']['InvocationID'], 'OLD_INSTANCE_RUNNING')
        if expected is not None:
            need(invocation == expected, 'INSTANCE_CHANGED')
        health = self.health()
        need(health['healthy'] is True and health['version'] == self.plan['targetVersion']
             and health['maintenance'] is maintenance, 'HEALTH_NOT_CONFIRMED')
        need(service == service_state(), 'INSTANCE_CHANGED_DURING_OBSERVATION')
        self.protected()
        need(self.active() == self.desired_active(), 'ACTIVE_CHANGED')
        return {'invocation': invocation, 'health': health}

    def desired_active(self):
        return {'schemaVersion': 1, 'generation': self.plan['jobId'], 'release': str(self.target),
                'dataRoot': str(self.data), 'environmentFile': str(ENVIRONMENT),
                'manifestSha256': self.plan['manifestSha256'],
                'configRef': str(ENVIRONMENT),
                'configFingerprint': self.plan['protectedInventory'][str(ENVIRONMENT)]['fingerprint']}

    def migration(self):
        os.environ['SSH_PORTAL_MIGRATION_NODE'] = str(NODE)
        return load_module(self.target / 'scripts/deployment_migration.py', 'deployment_job_migration')

    def baseline_status(self):
        path = self.data / 'maintenance.sqlite'
        if not path.exists():
            return 'absent'
        connection = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=1)
        try:
            row = connection.execute('SELECT owner_hash,baseline FROM reservation WHERE id=1').fetchone()
            if row is None:
                return 'absent'
            need(row[0] == digest(self.owner), 'MAINTENANCE_OWNER_CHANGED')
            return 'prepared' if row[1] is not None else 'reserved'
        finally:
            connection.close()

    def execute(self, stage, journal):
        if stage == 'prepare':
            self.predecessor()
            self.protected()
            source = Path(self.plan['source'])
            verify_manifest(source, self.plan['manifestSha256'])
            source_layout_preflight(Path(self.plan['expectedActive']['dataRoot']), self.plan['serviceUid'])
            checker = load_module(source / 'scripts/node-runtime.py', 'deployment_runtime_worker')
            try:
                checker.check(RUNTIME)
            except (OSError, ValueError, RuntimeError):
                raise DeploymentError('MANAGED_RUNTIME_REINSTALL_REQUIRED') from None
            need(shutil.disk_usage(BASE).free >= self.plan['minimumFreeBytes'], 'INSUFFICIENT_DISK')
            need(not os.path.lexists(self.target), 'TARGET_RELEASE_ALREADY_EXISTS')
            source_stage = self.job / 'source'
            need(not os.path.lexists(source_stage), 'PREPARE_SOURCE_ALREADY_EXISTS')
            shutil.copytree(source, source_stage, symlinks=False)
            for name in ('npm-user.conf', 'npm-global.conf'):
                (self.job / name).write_bytes(b'')
            npm = RUNTIME / 'lib/node_modules/npm/bin/npm-cli.js'
            self.command([NODE, npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
                 '--prefix', source_stage], timeout=600, env=CLEAN | {
                    'npm_config_userconfig': str(self.job / 'npm-user.conf'),
                    'npm_config_globalconfig': str(self.job / 'npm-global.conf'),
                    'npm_config_cache': str(self.job / 'npm-cache')})
            updater = load_module(source / 'scripts/update_release.py', 'deployment_publisher')
            def verify(path):
                verify_manifest(path, self.plan['manifestSha256'])
                self.command([NODE, path / 'scripts/verify.mjs', path])
                self.command(['/usr/bin/sudo', '-n', '-u', 'mcpbridge', '--', NODE,
                     path / 'scripts/check-package-imports.mjs'])
            updater.publish_release(source_stage, self.target, self.plan['serviceGid'], verify)
            for path in [self.target, *self.target.rglob('*')]:
                if path.is_symlink():
                    continue
                descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            sync_directory(self.target.parent)
            return {'manifestSha256': self.plan['manifestSha256']}
        if stage == 'reserve':
            self.predecessor()
            self.protected()
            current = service_state()
            need(current == self.plan['serviceBefore'], 'PREDECESSOR_INSTANCE_CHANGED')
            if stopped(current):
                return {'offline': True}
            self.maintenance('reserve')
            for _ in range(60):
                health = self.health()
                need(health['maintenance'] is True, 'RESERVATION_NOT_OBSERVED')
                if health['busy'] is False:
                    return {'offline': False}
                time.sleep(1)
            raise DeploymentError('WRITER_DRAIN_TIMEOUT')
        if stage == 'stop':
            self.predecessor()
            self.protected()
            self.command(['/usr/bin/systemctl', 'stop', SERVICE], timeout=90)
            need(stopped(service_state()), 'CLEAN_STOP_UNCONFIRMED')
            # A separate uncooperative process is detected by DB locks during inspect/migrate.
            return {'stopped': True, 'stoppedAtMs': int(time.time() * 1000)}
        if stage == 'migrate':
            need(stopped(service_state()), 'WRITER_NOT_STOPPED')
            self.predecessor()
            self.protected()
            migration = self.migration()
            source = Path(self.plan['expectedActive']['dataRoot'])
            inspection = migration.inspect_state(source, uid=self.plan['serviceUid'])
            if self.plan['schema']['validation'] == 'offline-verified':
                need(inspection == self.plan['schema']['inspection'], 'OFFLINE_SCHEMA_CHANGED')
            for directory in (DATA.parent, DATA):
                if not directory.exists():
                    trusted_directory(directory.parent)
                    directory.mkdir(mode=0o755)
                    directory.chmod(0o755)
                    sync_directory(directory.parent)
                trusted_directory(directory)
            generation = self.data.parent
            need(not os.path.lexists(generation), 'TARGET_DATA_ALREADY_EXISTS')
            generation.mkdir(mode=0o750)
            os.chown(generation, 0, self.plan['serviceGid'])
            generation.chmod(0o750)
            sync_directory(generation.parent)
            receipt = migration.migrate_state(source, self.data, uid=self.plan['serviceUid'],
                gid=self.plan['serviceGid'], now_ms=journal['stages']['stop']['result']['stoppedAtMs'])
            migration.verify_migration(source, self.data, receipt)
            atomic_json(self.job / 'migration.json', receipt)
            return {'receiptSha256': digest(canonical(receipt))}
        if stage == 'baseline':
            need(stopped(service_state()), 'WRITER_NOT_STOPPED')
            self.protected()
            result = self.command([NODE, self.target / 'scripts/deployment-preservation.mjs',
                          self.job / 'owner', self.data, self.plan['serviceUid'], self.plan['serviceGid'],
                          journal['stages']['stop']['result']['stoppedAtMs']], timeout=120,
                         env=CLEAN | {'BRIDGE_SECRET_ENV_FILE': str(ENVIRONMENT)})
            value = json.loads(result)
            need(value['status'] == 'PREPARED', 'BASELINE_UNCONFIRMED')
            return {'prepared': True}
        if stage == 'promote':
            need(stopped(service_state()), 'WRITER_NOT_STOPPED')
            self.predecessor()
            self.protected()
            verify_manifest(self.target, self.plan['manifestSha256'])
            need(self.baseline_status() == 'prepared', 'BASELINE_NOT_PREPARED')
            verification = json.loads(self.command([NODE,
                self.target / 'scripts/deployment-preservation.mjs', self.job / 'owner', self.data,
                self.plan['serviceUid'], self.plan['serviceGid'],
                journal['stages']['stop']['result']['stoppedAtMs'], 'verify'], timeout=120,
                env=CLEAN | {'BRIDGE_SECRET_ENV_FILE': str(ENVIRONMENT)}))
            need(verification['status'] == 'VERIFIED', 'OFFLINE_BASELINE_NOT_PRESERVED')
            need(digest(trusted_file(UNIT)) == self.plan['targetUnitFingerprint'], 'TARGET_UNIT_NOT_PUBLISHED')
            need(digest(trusted_file(ENV_HELPER)) == self.plan['targetHelperFingerprint'], 'TARGET_HELPER_NOT_PUBLISHED')
            need(digest(trusted_file(LAUNCHER)) == self.plan['targetLauncherFingerprint'], 'TARGET_LAUNCHER_NOT_PUBLISHED')
            atomic_json(STATE_ROOT / 'active.json', self.desired_active(), mode=0o640,
                        gid=self.plan['serviceGid'])
            sync_directory(STATE_ROOT)
            return {'generation': self.plan['jobId']}
        if stage == 'bootstrap':
            need(stopped(service_state()), 'WRITER_NOT_STOPPED')
            self.predecessor()
            self.protected()
            unit = trusted_file(self.target / 'config/ssh-approval-bridge.service', 65536)
            need(digest(unit) == self.plan['targetUnitFingerprint'], 'TARGET_UNIT_CHANGED')
            need(optional_file_digest(UNIT) == self.plan['unitFingerprint'], 'PREDECESSOR_UNIT_CHANGED')
            if self.plan['unitFingerprint'] is not None:
                original = trusted_file(UNIT)
                descriptor = os.open(self.job / 'previous-unit', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(descriptor, 'wb') as stream:
                    stream.write(original)
                    stream.flush()
                    os.fsync(stream.fileno())
                sync_directory(self.job)
            temporary = UNIT.parent / ('.deploy-unit-' + self.plan['jobId'])
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
            with os.fdopen(descriptor, 'wb') as stream:
                os.fchmod(stream.fileno(), 0o644)
                stream.write(unit)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, UNIT)
            sync_directory(UNIT.parent)
            return {'unitSha256': self.plan['targetUnitFingerprint']}
        if stage in ('launcher', 'helper'):
            need(stopped(service_state()), 'WRITER_NOT_STOPPED')
            self.predecessor()
            self.protected()
            destination = LAUNCHER if stage == 'launcher' else ENV_HELPER
            relative = 'scripts/deployment-launcher.py' if stage == 'launcher' else 'helper/environment-helper.py'
            previous = self.plan['launcherFingerprint' if stage == 'launcher' else 'helperFingerprint']
            target = self.plan['targetLauncherFingerprint' if stage == 'launcher' else 'targetHelperFingerprint']
            raw = trusted_file(self.target / relative)
            need(digest(raw) == target, 'TARGET_ASSET_CHANGED')
            need(optional_file_digest(destination) == previous, 'PREDECESSOR_ASSET_CHANGED')
            if previous is not None:
                original = trusted_file(destination)
                backup = self.job / ('previous-' + stage)
                descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(descriptor, 'wb') as stream:
                    stream.write(original)
                    stream.flush()
                    os.fsync(stream.fileno())
                sync_directory(self.job)
            temporary = destination.parent / ('.deploy-' + stage + '-' + self.plan['jobId'])
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755)
            with os.fdopen(descriptor, 'wb') as stream:
                os.fchmod(stream.fileno(), 0o755)
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
            sync_directory(destination.parent)
            return {'assetSha256': target, 'previousAssetSha256': previous}
        if stage == 'reload':
            need(stopped(service_state()), 'WRITER_NOT_STOPPED')
            need(digest(trusted_file(UNIT)) == self.plan['targetUnitFingerprint'], 'TARGET_UNIT_CHANGED')
            self.command(['/usr/bin/systemctl', 'daemon-reload'], timeout=30)
            return {'reloaded': True}
        if stage == 'start':
            need(self.active() == self.desired_active(), 'START_PRECONDITION_CHANGED')
            if running(service_state()):
                # Reboot may have started the enabled unit after promotion.
                return self.instance(True)
            need(stopped(service_state()), 'START_PRECONDITION_CHANGED')
            self.command(['/usr/bin/systemctl', 'start', SERVICE], timeout=90)
            for _ in range(45):
                try:
                    return self.instance(True)
                except (DeploymentError, OSError, ValueError):
                    time.sleep(1)
            raise DeploymentError('NEW_INSTANCE_UNCONFIRMED')
        instance = journal['stages']['start']['result']['invocation']
        if stage == 'compare':
            self.instance(True, instance)
            output = self.maintenance('compare-baseline').decode().splitlines()
            need(len(output) == 2, 'COMPARISON_RESPONSE_INVALID')
            comparison = json.loads(output[0])
            need(comparison.get('baselinePreserved') is True and comparison.get('outputsAdded') == 0
                 and comparison.get('expiredOutputsRemoved') == 0
                 and comparison.get('status') in ('PASS', 'PARTIAL'), 'PRESERVATION_FAILED')
            self.instance(True, instance)
            return comparison
        if stage == 'release':
            self.instance(True, instance)
            self.maintenance('release-baseline-verified')
            return {'released': True, 'invocation': instance}
        if stage == 'final':
            final = self.instance(False, instance)
            need(self.maintenance('status').decode().strip() == 'released', 'RELEASE_NOT_CONFIRMED')
            return self.instance(False, final['invocation'])
        raise DeploymentError('UNKNOWN_STAGE')

    def reconcile(self, stage, journal, *, completed):
        """Return evidence only for provably performed effects. None means unknown."""
        record = journal['stages'][stage]
        if stage == 'prepare':
            if self.target.exists():
                verify_manifest(self.target, self.plan['manifestSha256'])
                # Revalidation and fsync are safe observations of the published
                # immutable tree; npm and publication are never replayed.
                self.command([NODE, self.target / 'scripts/verify.mjs', self.target])
                self.command(['/usr/bin/sudo', '-n', '-u', 'mcpbridge', '--', NODE,
                              self.target / 'scripts/check-package-imports.mjs'])
                for path in [self.target, *self.target.rglob('*')]:
                    if path.is_symlink():
                        continue
                    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                    try:
                        os.fsync(descriptor)
                    finally:
                        os.close(descriptor)
                sync_directory(self.target.parent)
                return {'manifestSha256': self.plan['manifestSha256']}
        elif stage == 'stop':
            if stopped(service_state()):
                return {'stopped': True, 'stoppedAtMs': int(time.time() * 1000)}
        elif stage == 'migrate':
            receipt_path = self.job / 'migration.json'
            if receipt_path.exists():
                receipt = json.loads(trusted_file(receipt_path, 8 * 1024 * 1024))
                need(stopped(service_state()), 'WRITER_NOT_STOPPED')
                self.migration().verify_migration(Path(self.plan['expectedActive']['dataRoot']), self.data, receipt)
                return {'receiptSha256': digest(canonical(receipt))}
        elif stage == 'baseline':
            if stopped(service_state()) and self.baseline_status() == 'prepared':
                return {'prepared': True}
        elif stage == 'promote':
            if self.active() == self.desired_active():
                return {'generation': self.plan['jobId']}
        elif stage == 'bootstrap':
            if optional_file_digest(UNIT) == self.plan['targetUnitFingerprint']:
                return {'unitSha256': self.plan['targetUnitFingerprint']}
        elif stage in ('launcher', 'helper'):
            destination = LAUNCHER if stage == 'launcher' else ENV_HELPER
            target = self.plan['targetLauncherFingerprint' if stage == 'launcher' else 'targetHelperFingerprint']
            previous = self.plan['launcherFingerprint' if stage == 'launcher' else 'helperFingerprint']
            if optional_file_digest(destination) == target:
                return {'assetSha256': target, 'previousAssetSha256': previous}
        elif stage == 'reload':
            loaded = self.command(['/usr/bin/systemctl', 'show', SERVICE, '-p', 'NeedDaemonReload',
                          '-p', 'FragmentPath'], timeout=15).decode()
            fields = dict(line.split('=', 1) for line in loaded.splitlines() if '=' in line)
            if (optional_file_digest(UNIT) == self.plan['targetUnitFingerprint']
                    and fields.get('NeedDaemonReload') == 'no' and fields.get('FragmentPath') == str(UNIT)):
                return {'reloaded': True}
        elif stage == 'reserve':
            if stopped(self.plan['serviceBefore']) and stopped(service_state()):
                return {'offline': True}
            if self.maintenance('status').decode().strip() == 'reserved' and self.health()['busy'] is False:
                return {'offline': False}
        elif stage == 'start':
            expected = record.get('result', {}).get('invocation')
            return self.instance(True, expected)
        elif stage == 'compare':
            # The comparison is a bounded verification of the same baseline,
            # not a command, migration, start, or release effect.
            return self.execute('compare', journal)
        elif stage == 'release':
            invocation = journal['stages']['start']['result']['invocation']
            self.instance(False, invocation)
            if self.maintenance('status').decode().strip() == 'released':
                return {'released': True, 'invocation': invocation}
        elif stage == 'final':
            return self.instance(False, journal['stages']['start']['result']['invocation'])
        return None

    def validate_resume(self, journal):
        self.protected()
        promoted = self.active() == self.desired_active()
        if not promoted:
            self.predecessor()
        # Completed prefix is checked against current invariants, not transient
        # historical conditions (a stopped service may legitimately be started).
        completed = journal['stages']
        if 'prepare' in completed and completed['prepare']['state'] == 'done':
            verify_manifest(self.target, self.plan['manifestSha256'])
        if 'promote' in completed and completed['promote']['state'] == 'done':
            need(promoted, 'ACTIVE_CHANGED')
        if 'start' in completed and completed['start']['state'] == 'done':
            released = 'release' in completed and completed['release']['state'] == 'done'
            # Release response can have been lost; reconcile it before imposing maintenance.
            if completed.get('release', {}).get('state') == 'running':
                return
            self.instance(not released, completed['start']['result']['invocation'])


def execute_job(plan, journal, backend, save):
    """Finite state machine; injected backend is only a Python test boundary."""
    need(journal['planSha256'] == plan['planSha256'], 'JOURNAL_PLAN_MISMATCH')
    need(set(journal['stages']) <= set(STAGES), 'JOURNAL_STAGE_INVALID')
    prefix = list(journal['stages'])
    need(set(prefix) == set(STAGES[:len(prefix)]), 'JOURNAL_PREFIX_INVALID')
    for offset, stage in enumerate(STAGES[:len(prefix)]):
        need(journal['stages'][stage]['state'] in ('done', 'running'), 'JOURNAL_EFFECT_INVALID')
        if journal['stages'][stage]['state'] == 'running':
            need(offset == len(prefix) - 1, 'JOURNAL_PREFIX_INVALID')
    if journal['state'] == 'PASS':
        return journal
    try:
        backend.validate_resume(journal)
        for stage in STAGES:
            record = journal['stages'].get(stage)
            if record is not None and record['state'] == 'done':
                continue
            journal['phase'] = stage
            journal['state'] = 'RUNNING'
            if record is not None:
                need(record['state'] == 'running', 'JOURNAL_EFFECT_INVALID')
                result = backend.reconcile(stage, journal, completed=False)
                need(result is not None, 'EFFECT_OUTCOME_UNKNOWN_' + stage.upper())
            else:
                journal['stages'][stage] = {'state': 'running'}
                save(journal)
                result = backend.execute(stage, journal)
            journal['stages'][stage] = {'state': 'done', 'result': result}
            save(journal)
        journal['state'] = 'PASS'
        journal['phase'] = 'done'
        journal.pop('errorCode', None)
        save(journal)
        return journal
    except BaseException as error:
        journal['state'] = 'NEEDS_REVIEW'
        journal['errorCode'] = error.code if isinstance(error, DeploymentError) else type(error).__name__
        journal['databaseRestored'] = False
        journal['automaticReplay'] = False
        save(journal)
        raise


def run_worker(job_id):
    need(os.geteuid() == 0, 'ROOT_REQUIRED')
    job = _job_path(job_id, STATE_ROOT)
    with deployment_locks(job):
        plan = json.loads(trusted_file(job / 'plan.json', 8 * 1024 * 1024))
        validate_plan(plan)
        need(Path(__file__).absolute() == Path(plan['executor']), 'WRONG_EXECUTOR_ENTRYPOINT')
        journal = status(job_id)
        if 'bootId' not in journal:
            journal['bootId'] = boot_id()
            atomic_json(job / 'journal.json', journal)
        backend = SystemBackend(plan, job)
        return execute_job(plan, journal, backend, lambda value: atomic_json(job / 'journal.json', value))


def main():
    parser = argparse.ArgumentParser(description='Root-owned pinned deployment worker')
    parser.add_argument('command', choices=['run-worker'])
    parser.add_argument('job_id')
    args = parser.parse_args()
    try:
        result = run_worker(args.job_id)
        print(json.dumps({'jobId': args.job_id, 'state': result['state']}))
    except BaseException as error:
        print(json.dumps({'jobId': args.job_id, 'state': 'NEEDS_REVIEW',
                          'errorCode': error.code if isinstance(error, DeploymentError) else type(error).__name__,
                          'databaseRestored': False, 'automaticReplay': False}))
        return 1
    return 0


if __name__ == '__main__':
    os.umask(0o077)
    raise SystemExit(main())
