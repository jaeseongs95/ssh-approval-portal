import re

ENV = pathlib.Path('/etc/ssh-mcp-approval-bridge.env')


def capacity_bytes(data):
    # 다른 줄·주석·인코딩·개행은 원바이트를 그대로 보존한다.
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError as error:
        raise RuntimeError('유효하지 않은 UTF-8 ENV') from error
    if any(line.strip() and not line.lstrip().startswith('#') and not re.fullmatch(r'[A-Z_][A-Z0-9_]*=.*', line.removesuffix('\r')) for line in text.split('\n')):
        raise RuntimeError('지원하지 않는 ENV 줄 형식')
    lines = data.splitlines(keepends=True)
    key = b'BRIDGE_REQUEST_CAPACITY='
    matches = [i for i, line in enumerate(lines) if line.startswith(key)]
    if len(matches) > 1 or b'\x00' in data or b'\r' in data.replace(b'\r\n', b''):
        raise RuntimeError('중복 키 또는 지원하지 않는 ENV 형식')
    if matches:
        i = matches[0]
        ending = b'\r\n' if lines[i].endswith(b'\r\n') else b'\n' if lines[i].endswith(b'\n') else b''
        lines[i] = key + b'1000' + ending
        return b''.join(lines)
    ending = b'\r\n' if b'\r\n' in data else b'\n'
    return data + (ending if data and not data.endswith(b'\n') else b'') + key + b'1000' + ending


def read_env():
    fd = os.open(ENV, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1:
            raise RuntimeError('unsafe ENV')
        return stream.read()


def private_backup(data):
    fd = os.open(ROOT / 'env.before', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    fd = os.open(ROOT / 'managed.before.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(snap_managed(), stream)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def replace_env(expected, target, expected_meta):
    if read_env() != expected or snap_managed()[str(ENV)] != expected_meta:
        raise RuntimeError('ENV changed; manual review required')
    tmp = ENV.parent / ('.ssh-mcp-capacity-' + secrets.token_hex(12))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(target)
            os.fchown(stream.fileno(), expected_meta[1], expected_meta[2])
            os.fchmod(stream.fileno(), expected_meta[3])
            stream.flush()
            os.fsync(stream.fileno())
        if read_env() != expected or snap_managed()[str(ENV)] != expected_meta:
            raise RuntimeError('ENV drifted before replacement')
        os.replace(tmp, ENV)
        directory = os.open(ENV.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        tmp.unlink(missing_ok=True)
