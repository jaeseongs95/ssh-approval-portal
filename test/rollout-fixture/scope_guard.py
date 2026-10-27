"""Private, bounded protected-path evidence; never return it to portal clients."""
import hashlib
import os
from pathlib import Path
import stat

MAX_ENTRIES = 10000
MAX_BYTES = 1024 * 1024 * 1024


def snapshot(paths):
    records, total = {}, 0
    pending = list(map(Path, paths))
    while pending:
        path = pending.pop()
        key = str(path)
        if not path.is_absolute() or key in records:
            raise RuntimeError('invalid or overlapping protected scope')
        try:
            before = path.lstat()
        except FileNotFoundError:
            records[key] = {'missing': True}
            continue
        kind = stat.S_IFMT(before.st_mode)
        identity = (before.st_dev, before.st_ino, before.st_uid, before.st_gid,
                    stat.S_IMODE(before.st_mode), before.st_nlink, kind)
        item = {'identity': identity}
        if stat.S_ISLNK(before.st_mode):
            item['link'] = os.readlink(path)
        elif stat.S_ISDIR(before.st_mode):
            pending.extend(sorted(path.iterdir()))
        elif stat.S_ISREG(before.st_mode) and before.st_nlink == 1:
            total += before.st_size
            if total > MAX_BYTES:
                raise RuntimeError('protected data budget exceeded')
            digest = hashlib.sha256()
            fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
            try:
                opened = os.fstat(fd)
                if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                    raise RuntimeError('protected file identity changed')
                with os.fdopen(fd, 'rb', closefd=False) as source:
                    for block in iter(lambda: source.read(65536), b''):
                        digest.update(block)
                after = os.fstat(fd)
            finally:
                os.close(fd)
            # Linux includes ctime; Windows runs local contract tests only.
            stable = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns,
                                s.st_ctime_ns if os.name != 'nt' else 0)
            current = path.lstat()
            if stable(before) != stable(after) or stable(after) != stable(current):
                names = ('device', 'inode', 'size', 'mtime', 'ctime')
                changed = [name for name, first, last, live in zip(names, stable(before), stable(after), stable(current)) if first != last or last != live]
                raise RuntimeError('protected file changed during snapshot: ' + ','.join(changed))
            item.update(size=before.st_size, sha256=digest.hexdigest())
        else:
            raise RuntimeError('unsupported protected path')
        records[key] = item
        if len(records) > MAX_ENTRIES:
            raise RuntimeError('protected entry budget exceeded')
    return records


def verify(paths, expected):
    if snapshot(paths) != expected:
        raise RuntimeError('protected paths changed')
