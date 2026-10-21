"""Read-only trust check before running the installer-owned Node runtime."""
import os
from pathlib import Path
import stat
import sys


def directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError()


def check(path, parent_only=False):
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError()
    for parent in reversed(path.parents):
        directory(parent)
        if parent_only and not parent.stat().st_mode & 0o001:
            raise ValueError()
    if parent_only and not path.exists() and not path.is_symlink():
        return
    directory(path)
    if not path.stat().st_mode & 0o001:
        raise ValueError()
    if parent_only:
        return
    for entry in path.rglob('*'):
        info = entry.lstat()
        if info.st_uid != 0:
            raise ValueError()
        if stat.S_ISLNK(info.st_mode):
            if not entry.resolve(strict=True).is_relative_to(path):
                raise ValueError()
        elif (not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode))
              or info.st_mode & 0o6022
              or (stat.S_ISDIR(info.st_mode) and not info.st_mode & 0o001)
              or (stat.S_ISREG(info.st_mode) and info.st_nlink != 1)):
            raise ValueError()
    node = path/'bin/node'
    info = node.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o005 != 0o005:
        raise ValueError()


if __name__ == '__main__':
    try:
        if os.geteuid() != 0 or len(sys.argv) != 3 or sys.argv[1] not in ['parent', 'runtime']:
            raise ValueError()
        check(Path(sys.argv[2]), sys.argv[1] == 'parent')
    except (OSError, ValueError, RuntimeError):
        print('Node runtime is not a trusted root-owned installation.', file=sys.stderr)
        sys.exit(1)
