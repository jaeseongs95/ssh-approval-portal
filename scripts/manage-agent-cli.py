import base64
import contextlib
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request

PROVIDERS = {
    'codex': ('@openai/codex', 'codex'),
    'claude': ('@anthropic-ai/claude-code', 'claude'),
}
VERSION = r'(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})'
MAX_PACKAGE = 32 * 1024 * 1024
SYSTEM_BINS = [Path('/usr/local/bin'), Path('/usr/bin'), Path('/bin')]


class Refused(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(ok, code):
    if not ok:
        raise Refused(code)


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def regular(path):
    s = path.lstat()
    require(
        stat.S_ISREG(s.st_mode)
        and s.st_uid == os.geteuid()
        and s.st_nlink == 1
        and stat.S_IMODE(s.st_mode) == 0o600,
        'UNSAFE_FILE',
    )
    return s


def private_dir(path, create=False):
    if create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
    s = path.lstat()
    require(
        stat.S_ISDIR(s.st_mode)
        and s.st_uid == os.geteuid()
        and stat.S_IMODE(s.st_mode) == 0o700,
        'UNSAFE_DIRECTORY',
    )


def remove_entry(path):
    failures = 0

    def on_error(func, _target, exc_info):
        nonlocal failures
        exc = exc_info[1]
        if (
            func is os.rmdir
            and isinstance(exc, OSError)
            and exc.errno == errno.ENOTEMPTY
            and failures > 0
        ):
            return
        failures += 1

    try:
        info = path.lstat()
    except FileNotFoundError:
        return 0
    except OSError:
        return 1
    if stat.S_ISDIR(info.st_mode):
        try:
            shutil.rmtree(path, ignore_errors=False, onerror=on_error)
        except OSError:
            failures += 1
        return failures
    try:
        path.unlink()
        return 0
    except FileNotFoundError:
        return 0
    except OSError:
        return 1


def tidy(directory, *keep):
    if not directory.exists() and not directory.is_symlink():
        return 0
    try:
        entries = list(directory.iterdir())
    except OSError:
        return 1
    failures = 0
    for entry in entries:
        if entry.name not in keep:
            failures += remove_entry(entry)
    return failures


def read_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as f:
        s = os.fstat(f.fileno())
        require(
            stat.S_ISREG(s.st_mode)
            and s.st_uid == os.geteuid()
            and s.st_nlink == 1
            and stat.S_IMODE(s.st_mode) == 0o600,
            'UNSAFE_FILE',
        )
        data = f.read(16385)
    require(len(data) <= 16384, 'OVERSIZED_STATE')
    try:
        value = json.loads(data)
    except Exception:
        raise Refused('INVALID_STATE') from None
    require(isinstance(value, dict), 'INVALID_STATE')
    return value


def atomic_json(path, value):
    if path.exists() or path.is_symlink():
        regular(path)
    temporary = path.with_name('.' + path.name + '.' + os.urandom(12).hex())
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(encoded(value))
        f.flush()
        os.fsync(f.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def clean_env(home, node_dir='/opt/ssh-approval/node/bin'):
    return {
        'LANG': 'C.UTF-8',
        'LC_ALL': 'C.UTF-8',
        'PATH': node_dir + ':/usr/bin:/bin',
        'HOME': str(home),
        'CODEX_HOME': str(home / 'codex'),
        'CLAUDE_CONFIG_DIR': str(home / 'claude'),
        'DISABLE_UPDATES': '1',
    }


def executable(prefix, command):
    path = prefix / 'bin' / command
    try:
        resolved = path.resolve(strict=True)
        s = resolved.stat()
    except Exception:
        raise Refused('MISSING_EXECUTABLE') from None
    require(
        resolved.is_relative_to(prefix.resolve())
        and stat.S_ISREG(s.st_mode)
        and s.st_uid == os.geteuid()
        and not s.st_mode & 0o022
        and os.access(resolved, os.X_OK),
        'UNSAFE_EXECUTABLE',
    )
    return path


def trusted(path, h):
    r = path.resolve(strict=True)
    for p in [path, *path.parents, r, *r.parents]:
        if p in h.parents:
            continue
        s = p.lstat()
        require(
            s.st_uid in [0, os.geteuid()]
            and (stat.S_ISLNK(s.st_mode) or not s.st_mode & 0o022),
            'UNSAFE_EXECUTABLE',
        )


def version_of(path, provider):
    with (
        tempfile.TemporaryDirectory(prefix='ssh-cli-version-') as tmp,
        tempfile.TemporaryFile() as output,
    ):
        try:
            r = subprocess.run(
                [str(path), '--version'],
                cwd=tmp,
                env=clean_env(Path(tmp)),
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.DEVNULL,
                timeout=15,
                check=False,
            )
        except Exception:
            raise Refused('VERSION_UNAVAILABLE') from None
        output.seek(0)
        text = output.read(257)
    require(r.returncode == 0 and len(text) <= 256, 'VERSION_UNAVAILABLE')
    try:
        text = text.decode('utf-8').strip()
    except Exception:
        raise Refused('VERSION_UNAVAILABLE') from None
    pattern = (
        r'codex-cli (' + VERSION + ')'
        if provider == 'codex'
        else '(' + VERSION + r') \(Claude Code\)'
    )
    match = re.fullmatch(pattern, text)
    require(match is not None, 'VERSION_UNAVAILABLE')
    return match.group(1)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Refused('DOWNLOAD_REDIRECT')


def download(url, destination):
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(url, timeout=30) as response, destination.open('xb') as out:
            require(response.status == 200, 'DOWNLOAD_FAILED')
            total = 0
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                total += len(chunk)
                require(total <= MAX_PACKAGE, 'PACKAGE_TOO_LARGE')
                out.write(chunk)
    except Refused:
        raise
    except Exception:
        raise Refused('DOWNLOAD_FAILED') from None


def npm_install(package, prefix, work):
    choices = [
        (
            Path('/opt/ssh-approval/node/bin/node'),
            Path('/opt/ssh-approval/node/lib/node_modules/npm/bin/npm-cli.js'),
        ),
        (
            Path('/usr/bin/node'),
            Path('/usr/share/nodejs/npm/bin/npm-cli.js'),
        ),
    ]
    node, npm = next(
        ((n, p) for n, p in choices if n.is_file() and p.is_file()),
        (None, None),
    )
    require(node is not None, 'NODE_NPM_REQUIRED')
    try:
        r = subprocess.run(
            [str(node), '--version'],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=clean_env(work / 'home', str(node.parent)),
            timeout=10,
            check=False,
        )
    except Exception:
        raise Refused('NODE_NPM_REQUIRED') from None
    require(
        r.returncode == 0
        and re.fullmatch(rb'v(?:2[2-9]|[3-9][0-9])\.[0-9]+\.[0-9]+\s*', r.stdout)
        is not None,
        'NODE22_REQUIRED',
    )
    (work / 'home').mkdir(mode=0o700, exist_ok=True)
    for name in ['user.npmrc', 'global.npmrc']:
        os.close(
            os.open(
                work / name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
            )
        )
    args = [
        str(node),
        str(npm),
        'install',
        '--global',
        '--prefix',
        str(prefix),
        '--registry',
        'https://registry.npmjs.org',
        '--cache',
        str(work / 'cache'),
        '--userconfig',
        str(work / 'user.npmrc'),
        '--globalconfig',
        str(work / 'global.npmrc'),
        '--no-audit',
        '--no-fund',
        '--silent',
        str(package),
    ]
    process = subprocess.Popen(
        args,
        cwd=work,
        env=clean_env(work / 'home', str(node.parent)),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        try:
            code = process.wait(timeout=900)
        except subprocess.TimeoutExpired:
            raise Refused('INSTALL_TIMEOUT') from None
    finally:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
    require(code == 0, 'NPM_FAILED')


@contextlib.contextmanager
def install_budget(seconds):
    require(seconds > 0, 'PLAN_EXPIRED')
    require(signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0), 'RUNTIME_TIMER_BUSY')
    previous = signal.getsignal(signal.SIGALRM)

    def expired(*_):
        raise Refused('INSTALL_TIMEOUT')

    signal.signal(signal.SIGALRM, expired)
    try:
        signal.setitimer(signal.ITIMER_REAL, min(seconds, 900))
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


class Installer:
    def __init__(
        self,
        home,
        provider,
        downloader=download,
        runner=npm_install,
        now=lambda: int(time.time() * 1000),
    ):
        require(os.geteuid() != 0, 'NON_ROOT_REQUIRED')
        require(provider in PROVIDERS, 'UNSUPPORTED_PROVIDER')
        self.home = Path(home)
        self.provider = provider
        self.package, self.command = PROVIDERS[provider]
        s = self.home.lstat()
        require(
            stat.S_ISDIR(s.st_mode)
            and s.st_uid == os.geteuid()
            and not s.st_mode & 0o022,
            'UNSAFE_HOME',
        )
        self.root = self.home / '.local/share/ssh-approval-cli' / provider
        self.downloader, self.runner, self.now = downloader, runner, now

    def initialize(self):
        path = self.home
        for part in ['.local', 'share']:
            path = path / part
            try:
                path.mkdir(mode=0o700)
            except FileExistsError:
                pass
            s = path.lstat()
            require(
                stat.S_ISDIR(s.st_mode)
                and s.st_uid == os.geteuid()
                and not s.st_mode & 0o022,
                'UNSAFE_DIRECTORY',
            )
        for path in [
            path / 'ssh-approval-cli',
            self.root,
            self.root / 'versions',
            self.root / 'operations',
        ]:
            private_dir(path, True)

    @contextlib.contextmanager
    def claim(self, operation):
        path = self.root / '.lock'
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            s = os.fstat(fd)
            require(
                stat.S_ISREG(s.st_mode)
                and s.st_uid == os.geteuid()
                and s.st_nlink == 1
                and stat.S_IMODE(s.st_mode) == 0o600,
                'UNSAFE_LOCK',
            )
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Refused('BUSY') from None
            os.ftruncate(fd, 0)
            os.write(fd, operation.encode())
            os.fsync(fd)
            yield
        finally:
            os.close(fd)

    def inspect(self):
        parent = self.home
        for part in ['.local', 'share', 'ssh-approval-cli', self.provider]:
            parent = parent / part
            if not parent.exists() and not parent.is_symlink():
                break
            s = parent.lstat()
            require(
                stat.S_ISDIR(s.st_mode)
                and s.st_uid == os.geteuid()
                and not s.st_mode & 0o022,
                'UNSAFE_DIRECTORY',
            )
        current = self.root / 'current'
        state = {
            'provider': self.provider,
            'managed': False,
            'installed': False,
            'version': None,
            'active': None,
            'login': 'not_checked',
        }
        if self.root.exists() or self.root.is_symlink():
            private_dir(self.root)
        if current.exists() or current.is_symlink():
            private_dir(self.root / 'versions')
            require(current.is_symlink(), 'UNSAFE_CURRENT')
            target = os.readlink(current)
            require(
                re.fullmatch('versions/(' + VERSION + ')-[a-f0-9]{16}', target)
                is not None,
                'UNSAFE_CURRENT',
            )
            prefix = self.root / target
            private_dir(prefix)
            info = read_json(prefix / '.installed.json')
            require(
                set(info)
                == {'provider', 'version', 'integrity', 'executableSha256'}
                and info['provider'] == self.provider
                and re.fullmatch(VERSION, info['version']) is not None,
                'INVALID_STATE',
            )
            binary = executable(prefix, self.command)
            actual = hashlib.sha256(binary.resolve().read_bytes()).hexdigest()
            expected_target = (
                'versions/'
                + info['version']
                + '-'
                + hashlib.sha256(info['integrity'].encode()).hexdigest()[:16]
            )
            require(
                actual == info['executableSha256'] and target == expected_target,
                'INSTALLED_FILE_CHANGED',
            )
            state.update(
                managed=True,
                installed=True,
                version=info['version'],
                active=target,
            )
        else:
            for base in [self.home / '.local/bin', *SYSTEM_BINS]:
                candidate = base / self.command
                if candidate.is_file() and os.access(candidate, os.X_OK):
                    trusted(candidate, self.home)
                    try:
                        version = version_of(candidate, self.provider)
                    except Refused:
                        version = None
                    s = candidate.stat()
                    state.update(
                        installed=True,
                        version=version,
                        active=str(candidate),
                        externalIdentity={
                            'inode': s.st_ino,
                            'size': s.st_size,
                            'mtimeNs': s.st_mtime_ns,
                        },
                    )
                    break
        state['installationRevision'] = digest(state)
        return state

    def status(self, operation):
        require(
            re.fullmatch(r'[a-f0-9]{48}', operation or '') is not None,
            'INVALID_PLAN',
        )
        self.inspect()
        if (self.root / 'operations').exists() or (
            self.root / 'operations'
        ).is_symlink():
            private_dir(self.root / 'operations')
        work = self.root / 'operations' / operation
        if not work.exists() and not work.is_symlink():
            return {'state': 'not_found', 'operationId': operation}
        private_dir(work)
        value = read_json(work / 'receipt.json')
        fields = {
            'provider',
            'operationId',
            'intentDigest',
            'state',
            'version',
            'login',
        }
        require(
            fields <= set(value) <= (fields | {'error', 'cleanupFailures'})
            and value['provider'] == self.provider
            and value['operationId'] == operation
            and re.fullmatch(VERSION, value['version']) is not None
            and re.fullmatch(r'[a-f0-9]{64}', value['intentDigest']) is not None
            and value['login'] == 'not_checked'
            and value['state']
            in ['preparing', 'installing', 'completed', 'reused', 'failed']
            and (
                'cleanupFailures' not in value
                or (
                    type(value['cleanupFailures']) is int
                    and value['cleanupFailures'] > 0
                )
            ),
            'INVALID_STATE',
        )
        if 'error' in value:
            value['error'] = 'INSTALL_FAILED'
        if value['state'] in ['preparing', 'installing']:
            regular(self.root / '.lock')
            fd = os.open(self.root / '.lock', os.O_RDWR | os.O_NOFOLLOW)
            try:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    value['state'] = 'unknown'
                except BlockingIOError:
                    if os.pread(fd, 49, 0) != operation.encode():
                        value['state'] = 'unknown'
            finally:
                os.close(fd)
        return value

    def _switch(self, target, expected):
        current = self.root / 'current'
        actual = os.readlink(current) if current.is_symlink() else None
        require(
            actual == expected and (not current.exists() or current.is_symlink()),
            'CURRENT_CHANGED',
        )
        temporary = self.root / ('.current-' + os.urandom(12).hex())
        os.symlink(target, temporary)
        os.replace(temporary, current)

    def run(self, action, version, integrity, expected, expires, operation):
        require(
            action in ['install', 'update']
            and re.fullmatch(VERSION, version or '') is not None,
            'INVALID_PLAN',
        )
        require(
            re.fullmatch(r'[a-f0-9]{64}', expected or '') is not None
            and re.fullmatch(r'[a-f0-9]{48}', operation or '') is not None,
            'INVALID_PLAN',
        )
        try:
            raw = base64.b64decode(integrity[7:], validate=True)
        except Exception:
            raise Refused('INVALID_INTEGRITY') from None
        require(
            integrity.startswith('sha512-')
            and len(raw) == 64
            and integrity == 'sha512-' + base64.b64encode(raw).decode(),
            'INVALID_INTEGRITY',
        )
        require(type(expires) is int and self.now() < expires, 'PLAN_EXPIRED')
        intent = {
            'provider': self.provider,
            'action': action,
            'version': version,
            'integrity': integrity,
            'expected': expected,
            'expires': expires,
        }
        identity = digest(intent)
        self.initialize()
        with self.claim(operation):
            work = self.root / 'operations' / operation
            if work.exists() or work.is_symlink():
                private_dir(work)
                receipt = read_json(work / 'receipt.json')
                require(receipt.get('intentDigest') == identity, 'REQUEST_CONFLICT')
                require(
                    receipt.get('state') in ['completed', 'reused'],
                    'RESULT_UNKNOWN',
                )
                return self.status(operation)
            before = self.inspect()
            require(
                before['installationRevision'] == expected,
                'STALE_INSTALLATION',
            )
            prior_current = before['active'] if before['managed'] else None
            require(
                action != 'update' or before['managed'],
                'MANAGED_UPDATE_REQUIRED',
            )
            private_dir(work, True)
            receipt = {
                'provider': self.provider,
                'operationId': operation,
                'intentDigest': identity,
                'state': 'preparing',
                'version': version,
                'login': 'not_checked',
            }
            atomic_json(work / 'receipt.json', receipt)
            if before['installed'] and before['version'] == version:
                require(
                    not before['managed']
                    or read_json(self.root / before['active'] / '.installed.json')[
                        'integrity'
                    ]
                    == integrity,
                    'INSTALLED_RELEASE_CHANGED',
                )
                receipt['state'] = 'reused'
                atomic_json(work / 'receipt.json', receipt)
                return receipt
            prefix = work / 'prefix'
            private_dir(prefix, True)
            published = None
            try:
                with install_budget((expires - self.now()) / 1000):
                    package = work / 'package.tgz'
                    url = (
                        'https://registry.npmjs.org/'
                        + self.package
                        + '/-/'
                        + self.package.split('/')[1]
                        + '-'
                        + version
                        + '.tgz'
                    )
                    self.downloader(url, package)
                    require(
                        package.stat().st_size <= MAX_PACKAGE
                        and hashlib.sha512(package.read_bytes()).digest() == raw,
                        'PACKAGE_INTEGRITY_FAILED',
                    )
                    receipt['state'] = 'installing'
                    atomic_json(work / 'receipt.json', receipt)
                    self.runner(package, prefix, work)
                    binary = executable(prefix, self.command)
                    require(
                        version_of(binary, self.provider) == version,
                        'INSTALLED_VERSION_MISMATCH',
                    )
                info = {
                    'provider': self.provider,
                    'version': version,
                    'integrity': integrity,
                    'executableSha256': hashlib.sha256(
                        binary.resolve().read_bytes()
                    ).hexdigest(),
                }
                atomic_json(prefix / '.installed.json', info)
                require(self.now() < expires, 'PLAN_EXPIRED')
                require(
                    self.inspect()['installationRevision'] == expected,
                    'STALE_INSTALLATION',
                )
                target = (
                    'versions/'
                    + version
                    + '-'
                    + hashlib.sha256(integrity.encode()).hexdigest()[:16]
                )
                final = self.root / target
                require(
                    not final.exists() and not final.is_symlink(),
                    'VERSION_ALREADY_STAGED',
                )
                os.rename(prefix, final)
                self._switch(target, prior_current)
                published = target
                keep_versions = (
                    (target[9:], prior_current[9:])
                    if prior_current
                    else (target[9:],)
                )
                cleanup_failures = tidy(
                    self.root / 'versions', *keep_versions
                ) + tidy(work, 'receipt.json')
                if cleanup_failures > 0:
                    receipt['cleanupFailures'] = cleanup_failures
                receipt['state'] = 'completed'
                atomic_json(work / 'receipt.json', receipt)
                return receipt
            except Exception as error:
                receipt.update(
                    state='failed',
                    error=error.code
                    if isinstance(error, Refused)
                    else 'INSTALL_FAILED',
                )
                if published is None:
                    cleanup_failures = receipt.get(
                        'cleanupFailures', 0
                    ) + tidy(work, 'receipt.json')
                    if cleanup_failures > 0:
                        receipt['cleanupFailures'] = cleanup_failures
                try:
                    atomic_json(work / 'receipt.json', receipt)
                except Exception:
                    raise Refused('RESULT_UNKNOWN') from None
                if published is not None:
                    try:
                        if prior_current is not None:
                            self._switch(prior_current, published)
                        elif (
                            (self.root / 'current').is_symlink()
                            and os.readlink(self.root / 'current') == published
                        ):
                            (self.root / 'current').unlink()
                        else:
                            raise Refused('RECOVERY_REQUIRED')
                    except Exception:
                        raise Refused('RECOVERY_REQUIRED') from None
                    extra_failures = remove_entry(
                        self.root / published
                    ) + tidy(work, 'receipt.json')
                    if extra_failures > 0:
                        receipt['cleanupFailures'] = (
                            receipt.get('cleanupFailures', 0) + extra_failures
                        )
                        try:
                            atomic_json(work / 'receipt.json', receipt)
                        except Exception:
                            pass
                raise Refused(receipt['error']) from None


def main():
    os.umask(0o077)
    require(len(sys.argv) == 8, 'INVALID_ARGUMENTS')
    action, provider, version, integrity, expected, expires, operation = sys.argv[1:]
    manager = Installer(Path(pwd.getpwuid(os.geteuid()).pw_dir), provider)
    if action == 'inspect':
        require(
            not any([version, integrity, expected, operation]),
            'INVALID_ARGUMENTS',
        )
        return manager.inspect()
    if action == 'status':
        require(
            not any([version, integrity, expected, expires]),
            'INVALID_ARGUMENTS',
        )
        return manager.status(operation)
    require(
        expires.isascii() and expires.isdigit() and len(expires) <= 16,
        'INVALID_PLAN',
    )
    return manager.run(action, version, integrity, expected, int(expires), operation)


if __name__ == '__main__':
    try:
        print(json.dumps(main(), sort_keys=True))
    except Exception as error:
        print(
            json.dumps(
                {
                    'state': 'refused',
                    'error': error.code
                    if isinstance(error, Refused)
                    else 'UNAVAILABLE',
                }
            )
        )
        sys.exit(1)
