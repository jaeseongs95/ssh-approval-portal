"""Read the selected SSH account's CLI credential status; emit no vendor output."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time

PROVIDERS = {'codex': ['login', 'status'], 'claude': ['auth', 'status']}
LIMIT = 8192
TIMEOUT = 15
# Claude 2.1.307 is 291974512 bytes; keep a finite ceiling and streaming hash.
MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024


class LoginStatusError(ValueError):
    def __init__(self, reason):
        super().__init__('CLI login status unavailable')
        self.reason = reason


def require(ok, reason='invalid_installation'):
    if not ok:
        raise LoginStatusError(reason)


def trusted(path, home):
    resolved = path.resolve(strict=True)
    for entry in [path, *path.parents, resolved, *resolved.parents]:
        if entry in home.parents:
            continue
        info = entry.lstat()
        require(info.st_uid in (0, os.geteuid()) and
                (stat.S_ISLNK(info.st_mode) or not info.st_mode & 0o022), 'unsafe_path')
    require(resolved.is_file() and os.access(resolved, os.X_OK), 'unsafe_path')
    return path


def executable(home, provider):
    root = home / '.local/share/ssh-approval-cli' / provider
    current = root / 'current'
    if current.exists() or current.is_symlink():
        require(current.is_symlink())
        target = os.readlink(current)
        require(re.fullmatch(r'versions/((?:0|[1-9][0-9]{0,5})\.){2}(?:0|[1-9][0-9]{0,5})-[a-f0-9]{16}', target))
        prefix = root / target
        for directory in (root, root / 'versions', prefix):
            info = directory.lstat()
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
                    and stat.S_IMODE(info.st_mode) == 0o700)
        fd = os.open(prefix / '.installed.json', os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                    and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600)
            raw = stream.read(16385)
        require(len(raw) <= 16384)
        metadata = json.loads(raw)
        require(set(metadata) == {'provider', 'version', 'integrity', 'executableSha256'}
                and metadata['provider'] == provider)
        require(target == 'versions/' + metadata['version'] + '-' +
                hashlib.sha256(metadata['integrity'].encode()).hexdigest()[:16])
        binary = trusted(prefix / 'bin' / provider, home)
        resolved = binary.resolve(strict=True)
        require(resolved.is_relative_to(prefix.resolve()) and resolved.stat().st_size <= MAX_EXECUTABLE_BYTES)
        digest = hashlib.sha256()
        total = 0
        with resolved.open('rb') as stream:
            for block in iter(lambda: stream.read(65536), b''):
                total += len(block)
                require(total <= MAX_EXECUTABLE_BYTES)
                digest.update(block)
        require(digest.hexdigest() == metadata['executableSha256'])
        return binary
    for base in (home / '.local/bin', Path('/usr/local/bin'), Path('/usr/bin'), Path('/bin')):
        candidate = base / provider
        if candidate.exists() or candidate.is_symlink():
            return trusted(candidate, home)
    return None


def capture(binary, provider, home):
    # No API keys, service environment, shell startup files or project configuration.
    env = {'HOME': str(home), 'PATH': '/opt/ssh-approval/node/bin:/usr/local/bin:/usr/bin:/bin',
           'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'DISABLE_UPDATES': '1',
           'DISABLE_AUTOUPDATER': '1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
    with tempfile.TemporaryDirectory(prefix='ssh-cli-auth-') as cwd:
        process = subprocess.Popen([str(binary), *PROVIDERS[provider]], cwd=cwd, env=env,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True)
        output = [bytearray(), bytearray()]
        deadline = time.monotonic() + TIMEOUT
        try:
            with selectors.DefaultSelector() as selector:
                for index, stream in enumerate((process.stdout, process.stderr)):
                    os.set_blocking(stream.fileno(), False)
                    selector.register(stream, selectors.EVENT_READ, index)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    require(remaining > 0, 'timeout')
                    for key, _ in selector.select(min(remaining, 0.1)):
                        data = os.read(key.fd, 4096)
                        if not data:
                            selector.unregister(key.fileobj)
                        else:
                            output[key.data].extend(data)
                            require(sum(map(len, output)) <= LIMIT, 'output_limit')
            try:
                code = process.wait(timeout=max(0.001, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                raise LoginStatusError('timeout') from None
            return code, bytes(output[0]), bytes(output[1])
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            process.stdout.close()
            process.stderr.close()


def check(home, provider):
    require(provider in PROVIDERS and os.geteuid() != 0, 'check_failed')
    info = home.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o022, 'unsafe_path')
    binary = executable(home, provider)
    if binary is None:
        return 'not_installed'
    code, stdout, stderr = capture(binary, provider, home)
    if provider == 'codex':
        if code == 0:
            return 'signed_in'
        if code == 1 and (stdout + stderr).decode('utf-8', errors='replace').strip() == 'Not logged in':
            return 'signed_out'
    elif not stderr:
        try:
            value = json.loads(stdout)
        except (ValueError, UnicodeError):
            return 'unavailable'
        if isinstance(value, dict) and type(value.get('loggedIn')) is bool:
            if code == 0 and value['loggedIn']:
                return 'signed_in'
            if code == 1 and not value['loggedIn']:
                return 'signed_out'
    return 'unavailable'


def main():
    provider = sys.argv[1] if len(sys.argv) == 2 else None
    require(provider in PROVIDERS)
    reason = None
    try:
        state = check(Path(pwd.getpwuid(os.geteuid()).pw_dir), provider)
        if state == 'unavailable':
            reason = 'unexpected_response'
    except LoginStatusError as error:
        state, reason = 'unavailable', error.reason
    except Exception:
        state, reason = 'unavailable', 'check_failed'
    result = {'provider': provider, 'state': state}
    if reason is not None:
        result['reason'] = reason
    print(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    main()
