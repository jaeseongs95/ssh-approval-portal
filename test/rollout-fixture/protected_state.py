"""Private file evidence. Never print its return value or put it in public receipts."""
import hashlib
import os
from pathlib import Path
import stat


def digest_prefix(path, length):
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size < length:
            raise RuntimeError('unsafe protected file')
        digest, remaining = hashlib.sha256(), length
        while remaining:
            block = os.read(descriptor, min(65536, remaining))
            if not block:
                raise RuntimeError('short protected file')
            digest.update(block)
            remaining -= len(block)
        after = os.fstat(descriptor)
        current = os.lstat(path)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_nlink)
        stable = lambda s: (identity(s), s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        path_stable = (identity(after), after.st_size, after.st_mtime_ns) == (identity(current), current.st_size, current.st_mtime_ns)
        if stable(before) != stable(after) or not path_stable or after.st_size < length:
            raise RuntimeError('protected file changed during capture')
        return {'identity': list(identity(before)), 'length': length, 'sha256': digest.hexdigest()}
    finally:
        os.close(descriptor)


def capture(paths, audit):
    """Capture exact regular files and the append-only audit prefix.

    Caller must enumerate all relevant files and prove all applicable writers are
    fenced. SQLite and output payloads require the separate service baseline.
    """
    records = {}
    for value in paths:
        path = Path(value)
        if not path.is_absolute() or str(path.resolve(strict=True)) != str(path) or path.is_symlink():
            raise RuntimeError('noncanonical protected file')
        info = path.lstat()
        records[str(path)] = digest_prefix(path, info.st_size)
    audit = Path(audit)
    if not audit.is_absolute() or str(audit.resolve(strict=True)) != str(audit) or audit.is_symlink():
        raise RuntimeError('noncanonical audit file')
    return {'files': records, 'auditPath': str(audit), 'audit': digest_prefix(audit, audit.lstat().st_size)}


def compare(before):
    for path, old in before['files'].items():
        info = os.lstat(path)
        if info.st_size != old['length'] or digest_prefix(path, old['length']) != old:
            raise RuntimeError('protected file changed')
    if digest_prefix(before['auditPath'], before['audit']['length']) != before['audit']:
        raise RuntimeError('audit prefix changed')
    return True
