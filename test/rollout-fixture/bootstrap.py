"""Pinned bootstrap; only execute after the launcher has verified these bytes."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import types

NAMES = ('run_linux.py', 'controller.py', 'linux_adapter.py', 'scope_guard.py', 'protected_state.py',
         'staging_guard.py', 'offline-baseline.mjs', 'maintenance-request.mjs')


def private_bytes(path, limit=4 * 1024 * 1024):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            raise RuntimeError('invalid private file')
        if os.name != 'nt' and (before.st_uid != 0 or stat.S_IMODE(before.st_mode) != 0o600):
            raise RuntimeError('unsafe private file')
        with os.fdopen(descriptor, 'rb', closefd=False) as source:
            value = source.read(limit + 1)
        after = os.fstat(descriptor)
        live = os.lstat(path)
        # Windows is supported for local contract tests only; production remains
        # Linux and includes ctime in this identity comparison.
        stable = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns,
                            s.st_ctime_ns if os.name != 'nt' else 0, s.st_mode, s.st_uid, s.st_nlink)
        if stable(before) != stable(after) or stable(after) != stable(live) or len(value) != before.st_size:
            raise RuntimeError('private file changed')
        return value
    finally:
        os.close(descriptor)


def validate(root, intent_digest):
    root = Path(root)
    info = root.lstat()
    if root.is_symlink() or not stat.S_ISDIR(info.st_mode) or root.resolve() != root:
        raise RuntimeError('invalid task directory')
    if os.name != 'nt' and (os.geteuid() != 0 or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700):
        raise RuntimeError('unsafe task directory')
    if not re.fullmatch(r'[0-9a-f]{64}', intent_digest):
        raise RuntimeError('invalid intent pin')
    raw = private_bytes(root / 'intent.json')
    if hashlib.sha256(raw).hexdigest() != intent_digest:
        raise RuntimeError('intent pin mismatch')
    pins = json.loads(raw).get('controllerDigests')
    if not isinstance(pins, dict) or set(pins) != set(NAMES):
        raise RuntimeError('incomplete controller pins')
    values = {}
    for name in NAMES:
        pin = pins[name]
        if not isinstance(pin, str) or not re.fullmatch(r'[0-9a-f]{64}', pin):
            raise RuntimeError('invalid controller pin')
        data = private_bytes(root / name)
        if hashlib.sha256(data).hexdigest() != pin:
            raise RuntimeError('controller pin mismatch')
        values[name] = data
    return values


def main(root, intent_digest):
    # Never import or run candidate controller files before every pin succeeds.
    values = validate(root, intent_digest)
    for name in ('controller', 'protected_state', 'scope_guard', 'staging_guard', 'linux_adapter'):
        path = str(Path(root) / (name + '.py'))
        module = types.ModuleType(name)
        module.__file__ = path
        sys.modules[name] = module
        exec(compile(values[name + '.py'], path, 'exec'), module.__dict__)
    sys.argv = [str(Path(root) / 'run_linux.py'), root]
    exec(compile(values['run_linux.py'], sys.argv[0], 'exec'), {'__name__': '__main__', '__file__': sys.argv[0]})


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('task directory and intent digest required')
    main(sys.argv[1], sys.argv[2])
