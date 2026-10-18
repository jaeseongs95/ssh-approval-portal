"""Code-only update primitives. Caller owns maintenance, validation and recovery.

Never copies ENV, units, helpers or databases. The shared installer flock covers
cooperating installers; checks cannot serialize an unrelated root writer.
"""
from contextlib import contextmanager
import ctypes
import errno
import fcntl
import os
from pathlib import Path
import shutil
import stat
import tempfile
import uuid


@contextmanager
def installer_lock(path):
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid():
            raise RuntimeError('unsafe installer lock')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)


def exact_active(active, expected):
    active = Path(active)
    if not active.is_symlink() or os.readlink(active) != str(expected):
        raise RuntimeError('active release changed; manual review required')


def _publish_new(stage, destination):
    # Linux renameat2 prevents replacing even an empty destination directory.
    rename = ctypes.CDLL(None, use_errno=True).renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(stage), -100, os.fsencode(destination), 1) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def publish_release(source, destination, group_id, verify):
    """Publish a private stage only after caller verification; never reuse NEW."""
    source, destination = Path(source), Path(destination)
    if destination.exists() or destination.is_symlink():
        raise FileExistsError(errno.EEXIST, 'release already exists')
    if source.is_symlink() or not source.is_dir() or destination.parent.is_symlink() or not destination.parent.is_dir():
        raise RuntimeError('unsafe release directory')
    stage = Path(tempfile.mkdtemp(prefix='.portal-code-', dir=destination.parent))
    try:
        shutil.copytree(source, stage, symlinks=True, dirs_exist_ok=True)
        for path in [stage, *stage.rglob('*')]:
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                path.resolve(strict=True).relative_to(stage)
                os.chown(path, os.geteuid(), group_id, follow_symlinks=False)
            elif stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                os.chown(path, os.geteuid(), group_id)
                path.chmod(0o750 if path.is_dir() else 0o640)
            else:
                raise RuntimeError('unsupported release member')
        verify(stage)
        _publish_new(stage, destination)
    except BaseException:
        # This stage was created here, is private, and has never been activated.
        if stage.is_dir() and not stage.is_symlink():
            shutil.rmtree(stage)
        raise


def activate_release(active, expected, target, verify):
    """Change only the release link; the same boundary is used for rollback."""
    active, target = Path(active), Path(target)
    if target.is_symlink() or not target.is_dir():
        raise RuntimeError('invalid release target')
    verify()
    exact_active(active, expected)
    temporary = active.parent / ('.portal-link-' + uuid.uuid4().hex)
    os.symlink(str(target), temporary)
    try:
        verify()
        exact_active(active, expected)
        os.replace(temporary, active)
    finally:
        temporary.unlink(missing_ok=True)
