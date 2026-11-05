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
import errno
from contextlib import contextmanager

STAGE_ROOT = '/var/lib/ssh-approval-transfer/incoming'
LIMIT = 64 * 1024 * 1024

class FileOperationError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)

@contextmanager
def file_errors(missing='OPERATION_FAILED'):
    try:
        yield
    except OSError as error:
        code = {errno.ENOENT: missing, errno.EACCES: 'PERMISSION_DENIED',
                errno.EPERM: 'PERMISSION_DENIED', errno.ELOOP: 'UNSAFE_PATH',
                errno.ENOTDIR: 'UNSAFE_PATH'}.get(error.errno, 'OPERATION_FAILED')
        raise FileOperationError(code) from None

def parent_fd(path):
    if not isinstance(path, str) or not path.startswith('/') or path == '/' or len(path) > 4096:
        raise FileOperationError('UNSAFE_PATH')
    if path != path.strip() or any(ord(c) < 32 or 127 <= ord(c) < 160 or c in '\u202e\u202d\u200b\ufeff' for c in path):
        raise FileOperationError('UNSAFE_PATH')
    parts = path.split('/')[1:]
    if any(p in ('', '.', '..') for p in parts):
        raise FileOperationError('UNSAFE_PATH')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        with file_errors('PARENT_NOT_FOUND'):
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
        raise FileOperationError('UNSAFE_PATH')
    return info

def stage_fd():
    with file_errors('STAGING_UNAVAILABLE'):
        fd = os.open(STAGE_ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        owner = pwd.getpwnam('mcpops').pw_uid
        if info.st_uid != owner or info.st_mode & 0o077:
            raise FileOperationError('STAGING_UNAVAILABLE')
        return fd
    except BaseException:
        os.close(fd)
        raise

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
            raise FileOperationError('FILE_TOO_LARGE')
        digest.update(block)
        offset = 0
        while offset < len(block):
            n = os.write(dest, block[offset:])
            if n <= 0:
                raise OSError('Incomplete file write')
            offset += n
    return count, digest.hexdigest()

def handle(request):
    if not isinstance(request, dict):
        raise FileOperationError('INVALID_REQUEST')
    transfer = request.get('id')
    if not isinstance(transfer, str) or not re.fullmatch('[a-f0-9]{48}', transfer):
        raise FileOperationError('INVALID_REQUEST')
    action = request.get('action')
    maximum = request.get('maxBytes', LIMIT)
    if type(maximum) is not int or not 0 < maximum <= LIMIT:
        raise FileOperationError('INVALID_REQUEST')
    stage = stage_fd()
    name = transfer + '.part'
    destination_published = False
    try:
        if action == 'cleanup':
            try:
                info = os.stat(name, dir_fd=stage, follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode):
                    raise FileOperationError('STAGING_UNAVAILABLE')
                os.unlink(name, dir_fd=stage)
            except FileNotFoundError:
                pass
            return {'cleaned': True}
        parent, leaf = parent_fd(request.get('remotePath'))
        try:
            if action == 'snapshot':
                with file_errors('FILE_NOT_FOUND'):
                    source = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                dest = None
                try:
                    before = regular(source)
                    if before.st_size > maximum:
                        raise FileOperationError('FILE_TOO_LARGE')
                    dest = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=stage)
                    size, digest = copy_bytes(source, dest, maximum)
                    if identity(before) != identity(regular(source)):
                        raise FileOperationError('FILE_CHANGED')
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
                raise FileOperationError('INVALID_REQUEST')
            expected_hash = request.get('sha256')
            expected_size = request.get('size')
            if not isinstance(expected_hash, str) or not re.fullmatch('[a-f0-9]{64}', expected_hash) or type(expected_size) is not int or not 0 <= expected_size <= maximum:
                raise FileOperationError('INVALID_REQUEST')
            old = None
            old_fd = None
            try:
                old_fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                old = regular(old_fd)
            except FileNotFoundError:
                pass
            except BaseException:
                if old_fd is not None: os.close(old_fd)
                raise
            if old is not None and not request['overwrite']:
                if old_fd is not None: os.close(old_fd)
                raise FileOperationError('DESTINATION_EXISTS')
            temporary = '.ssh-approval-' + secrets.token_hex(24) + '.part'
            source = None
            dest = None
            published = False
            try:
                with file_errors('STAGING_UNAVAILABLE'):
                    source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=stage)
                src_info = regular(source)
                if src_info.st_size != expected_size:
                    raise FileOperationError('FILE_CHANGED')
                dest = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                size, digest = copy_bytes(source, dest, maximum)
                if size != expected_size or digest != expected_hash or identity(src_info) != identity(regular(source)):
                    raise FileOperationError('FILE_CHANGED')
                if old is not None:
                    os.fchown(dest, old.st_uid, old.st_gid)
                    for key in os.listxattr(old_fd):
                        os.setxattr(dest, key, os.getxattr(old_fd, key))
                os.fchmod(dest, stat.S_IMODE(old.st_mode) if old else 0o600)
                os.fsync(dest)
                if old is not None:
                    current = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
                    if identity(current) != identity(old):
                        raise FileOperationError('FILE_CHANGED')
                elif request['overwrite']:
                    try:
                        os.stat(leaf, dir_fd=parent, follow_symlinks=False)
                    except FileNotFoundError:
                        pass
                    else:
                        raise FileOperationError('FILE_CHANGED')
                if request['overwrite']:
                    os.replace(temporary, leaf, src_dir_fd=parent, dst_dir_fd=parent)
                    destination_published = True
                else:
                    try:
                        os.link(temporary, leaf, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                    except FileExistsError:
                        raise FileOperationError('DESTINATION_EXISTS') from None
                    destination_published = True
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
        except Exception:
            if destination_published:
                raise FileOperationError('OPERATION_FAILED') from None
            raise
        finally:
            try: os.close(parent)
            except OSError:
                if destination_published: raise FileOperationError('OPERATION_FAILED') from None
                raise
    finally:
        try: os.close(stage)
        except OSError:
            if destination_published: raise FileOperationError('OPERATION_FAILED') from None
            raise

def main():
    try:
        raw = sys.stdin.buffer.read(16_385)
        if len(raw) > 16_384:
            raise FileOperationError('INVALID_REQUEST')
        try:
            request = json.loads(raw)
        except (ValueError, UnicodeError):
            raise FileOperationError('INVALID_REQUEST') from None
        with file_errors():
            result = handle(request)
        print(json.dumps(result))
    except Exception as error:
        # No arbitrary exception text: paths and file contents stay out of diagnostics.
        code = error.code if isinstance(error, FileOperationError) else 'OPERATION_FAILED'
        print(json.dumps({'error': 'File operation refused or failed; verify paths, permissions and approved metadata.', 'errorCode': code}))
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
