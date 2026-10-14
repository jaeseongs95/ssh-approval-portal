#!/usr/bin/env python3
"""Regular-file operations for the SSH account; JSON metadata only, never shell paths."""
import hashlib
import json
import os
import pwd
import re
import stat
import sys
import secrets

STAGE_ROOT = '/var/lib/ssh-approval-transfer/incoming'
LIMIT = 64 * 1024 * 1024

def parent_fd(path):
    if not isinstance(path, str) or not path.startswith('/') or path == '/' or len(path) > 4096:
        raise ValueError('Invalid absolute file path')
    if path != path.strip() or any(ord(c) < 32 or 127 <= ord(c) < 160 or c in '\u202e\u202d\u200b\ufeff' for c in path):
        raise ValueError('Invalid path characters')
    parts = path.split('/')[1:]
    if any(p in ('', '.', '..') for p in parts):
        raise ValueError('Empty or dot path component')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in parts[:-1]:
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd, parts[-1]
    except BaseException:
        os.close(fd)
        raise

def regular(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        raise ValueError('Only regular files are supported')
    return info

def stage_fd():
    fd = os.open(STAGE_ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    owner = pwd.getpwnam('mcpops').pw_uid
    if info.st_uid != owner or info.st_mode & 0o077:
        os.close(fd)
        raise ValueError('Unsafe remote staging directory')
    return fd

def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

def copy_bytes(source, dest, maximum):
    digest = hashlib.sha256()
    count = 0
    while True:
        block = os.read(source, 256 * 1024)
        if not block:
            break
        count += len(block)
        if count > maximum:
            raise ValueError('File exceeds transfer limit')
        digest.update(block)
        offset = 0
        while offset < len(block):
            n = os.write(dest, block[offset:])
            if n <= 0:
                raise OSError('Incomplete file write')
            offset += n
    return count, digest.hexdigest()

def handle(request):
    transfer = request.get('id')
    if not isinstance(transfer, str) or not re.fullmatch('[a-f0-9]{48}', transfer):
        raise ValueError('Invalid transfer ID')
    action = request.get('action')
    maximum = request.get('maxBytes', LIMIT)
    if type(maximum) is not int or not 0 < maximum <= LIMIT:
        raise ValueError('Invalid transfer limit')
    stage = stage_fd()
    name = transfer + '.part'
    try:
        if action == 'cleanup':
            try:
                info = os.stat(name, dir_fd=stage, follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError('Unsafe staging entry')
                os.unlink(name, dir_fd=stage)
            except FileNotFoundError:
                pass
            return {'cleaned': True}
        parent, leaf = parent_fd(request.get('remotePath'))
        try:
            if action == 'snapshot':
                source = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                dest = None
                try:
                    before = regular(source)
                    if before.st_size > maximum:
                        raise ValueError('File exceeds transfer limit')
                    dest = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=stage)
                    size, digest = copy_bytes(source, dest, maximum)
                    if identity(before) != identity(regular(source)):
                        raise ValueError('Source changed during snapshot')
                    if os.geteuid() == 0:
                        account = pwd.getpwnam('mcpops')
                        os.fchown(dest, account.pw_uid, account.pw_gid)
                    os.fchmod(dest, 0o600)
                    os.fsync(dest)
                    return {'size': size, 'sha256': digest}
                except BaseException:
                    if dest is not None:
                        os.unlink(name, dir_fd=stage)
                    raise
                finally:
                    os.close(source)
                    if dest is not None:
                        os.close(dest)
            if action != 'publish' or type(request.get('overwrite')) is not bool:
                raise ValueError('Invalid operation')
            expected_hash = request.get('sha256')
            expected_size = request.get('size')
            if not isinstance(expected_hash, str) or not re.fullmatch('[a-f0-9]{64}', expected_hash) or type(expected_size) is not int or not 0 <= expected_size <= maximum:
                raise ValueError('Invalid approved file metadata')
            old = None
            old_fd = None
            try:
                old_fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                old = regular(old_fd)
            except FileNotFoundError:
                pass
            if old is not None and not request['overwrite']:
                if old_fd is not None: os.close(old_fd)
                raise FileExistsError('Overwrite was not approved')
            temporary = '.ssh-approval-' + secrets.token_hex(24) + '.part'
            source = None
            dest = None
            published = False
            try:
                source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=stage)
                src_info = regular(source)
                if src_info.st_size != expected_size:
                    raise ValueError('Staged file size changed')
                dest = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                size, digest = copy_bytes(source, dest, maximum)
                if size != expected_size or digest != expected_hash or identity(src_info) != identity(regular(source)):
                    raise ValueError('Staged file does not match approval')
                if old is not None:
                    os.fchown(dest, old.st_uid, old.st_gid)
                    for key in os.listxattr(old_fd):
                        os.setxattr(dest, key, os.getxattr(old_fd, key))
                os.fchmod(dest, stat.S_IMODE(old.st_mode) if old else 0o600)
                os.fsync(dest)
                if old is not None:
                    current = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
                    if identity(current) != identity(old):
                        raise ValueError('Destination changed; submit a new request')
                elif request['overwrite']:
                    try:
                        os.stat(leaf, dir_fd=parent, follow_symlinks=False)
                    except FileNotFoundError:
                        pass
                    else:
                        raise ValueError('Destination appeared; submit a new request')
                if request['overwrite']:
                    os.replace(temporary, leaf, src_dir_fd=parent, dst_dir_fd=parent)
                else:
                    os.link(temporary, leaf, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                    os.unlink(temporary, dir_fd=parent)
                published = True
                os.fsync(parent)
                final = os.fstat(dest)
                return {'published': True, 'size': size, 'sha256': digest, 'uid': final.st_uid, 'gid': final.st_gid, 'mode': oct(stat.S_IMODE(final.st_mode))}
            finally:
                if source is not None: os.close(source)
                if dest is not None: os.close(dest)
                if old_fd is not None: os.close(old_fd)
                if not published:
                    try: os.unlink(temporary, dir_fd=parent)
                    except FileNotFoundError: pass
        finally:
            os.close(parent)
    finally:
        os.close(stage)

def main():
    try:
        raw = sys.stdin.buffer.read(16_385)
        if len(raw) > 16_384:
            raise ValueError('Request too large')
        result = handle(json.loads(raw))
        print(json.dumps(result))
    except Exception:
        # No arbitrary exception text: paths and file contents stay out of diagnostics.
        print(json.dumps({'error': 'File operation refused or failed; verify paths, permissions and approved metadata.'}))
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
