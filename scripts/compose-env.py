#!/usr/bin/env python3
"""Refresh service IDs without changing the administrator's image selection."""
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile


def prepare(path, uid, gid):
    if not uid.isdecimal() or int(uid) < 1 or not gid.isdecimal():
        raise ValueError('Expected a non-root UID and numeric GID')
    path = Path(path)
    existing = None
    if path.exists() or path.is_symlink():
        existing = path.lstat()
        if not stat.S_ISREG(existing.st_mode) or path.is_symlink():
            raise ValueError('Expected a regular Compose environment file')
        with path.open(encoding='utf-8', newline='') as source:
            text = source.read()
    else:
        text = ''
    newline = '\r\n' if '\r\n' in text else '\n'
    for name, value in [('BRIDGE_UID', uid), ('BRIDGE_GID', gid)]:
        if re.search(r'^' + name + '=', text, re.M):
            text = re.sub(r'^' + name + r'=[^\r\n]*', name + '=' + value, text, flags=re.M)
        else:
            if text and not text.endswith(('\n', '\r')):
                text += newline
            text += name + '=' + value + newline
    if not re.search(r'^BRIDGE_IMAGE=', text, re.M):
        version = json.loads((Path(__file__).resolve().parents[1] / 'package.json').read_text(encoding='utf-8'))['version']
        text += 'BRIDGE_IMAGE=ssh-approval-portal:' + version + newline
    fd, temporary = tempfile.mkstemp(prefix='.compose.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='') as output:
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        if existing is not None and hasattr(os, 'chown'):
            os.chown(temporary, existing.st_uid, existing.st_gid)
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise ValueError('Usage: compose-env.py FILE UID GID')
    prepare(*sys.argv[1:])
