#!/usr/bin/env python3
"""Refresh service IDs without changing the administrator's image selection."""
import json
import hashlib
import os
from pathlib import Path
import re
import stat
import sys
import tempfile


def assignments(text):
    """Locate dotenv values without evaluating interpolation or changing other bytes."""
    end = 0
    pattern = r'^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*[=:][ \t]*([^\r\n]*)'
    for match in re.finditer(pattern, text, re.M):
        if match.start() < end:
            continue  # An apparent assignment inside a quoted multiline value.
        start = match.start(2)
        raw = match[2]
        if raw.startswith(("'", '"')):
            quote, end = raw[0], start + 1
            while end < len(text):
                if text[end] == '\\':
                    end += 2
                elif text[end] == quote:
                    end += 1
                    break
                else:
                    end += 1
            else:
                raise ValueError('Unterminated quoted Compose environment value')
        else:
            comment = re.search(r'[ \t]+#', raw)
            value = raw[:comment.start()] if comment else raw
            end = start + len(value.rstrip(' \t'))
        yield match[1], start, end


def load_file(path):
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
    return path, existing, text


def write_file(path, existing, text):
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


def prepare(path, uid, gid):
    if not uid.isdecimal() or int(uid) < 1 or not gid.isdecimal():
        raise ValueError('Expected a non-root UID and numeric GID')
    path, existing, text = load_file(path)
    newline = '\r\n' if '\r\n' in text else '\n'
    entries = list(assignments(text))
    names = {name for name, _, _ in entries}
    values = {'BRIDGE_UID': uid, 'BRIDGE_GID': gid}
    for name, start, end in reversed(entries):
        if name in values:
            text = text[:start] + values[name] + text[end:]
    if 'BRIDGE_IMAGE' not in names:
        version = json.loads((Path(__file__).resolve().parents[1] / 'package.json').read_text(encoding='utf-8'))['version']
        values['BRIDGE_IMAGE'] = 'ssh-approval-portal:' + version
    for name, value in values.items():
        if name not in names:
            if text and not text.endswith(('\n', '\r')):
                text += newline
            text += name + '=' + value + newline
    write_file(path, existing, text)


def render_image(text, image):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/@-]+', image):
        raise ValueError('Invalid image reference')
    entries = [entry for entry in assignments(text) if entry[0] == 'BRIDGE_IMAGE']
    for _, start, end in reversed(entries):
        text = text[:start] + image + text[end:]
    if not entries:
        newline = '\r\n' if '\r\n' in text else '\n'
        if text and not text.endswith(('\n', '\r')):
            text += newline
        text += 'BRIDGE_IMAGE=' + image + newline
    return text


def update_image(path, image):
    path, existing, text = load_file(path)
    write_file(path, existing, render_image(text, image))


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise ValueError('Usage: compose-env.py FILE UID GID | compose-env.py image FILE IMAGE')
    if sys.argv[1] == 'expected-image-sha':
        _, _, text = load_file(sys.argv[2])
        print(hashlib.sha256(render_image(text, sys.argv[3]).encode('utf-8')).hexdigest())
    elif sys.argv[1] == 'image':
        update_image(sys.argv[2], sys.argv[3])
    else:
        prepare(*sys.argv[1:])
