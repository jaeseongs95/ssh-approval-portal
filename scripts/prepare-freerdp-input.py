#!/usr/bin/env python3
"""Verify the pinned private FreeRDP bundle; publish no partial runtime."""
import ctypes
import errno
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import sys
import tarfile
import tempfile

SOURCE = Path(__file__).absolute().parents[1]
# Native builder r3: compressed 17,694,051 bytes; source remains inside this archive.
BUNDLE_PATH = 'vendor/freerdp-input-v1-linux-x64.tgz'
BUNDLE_SHA256 = '91ae43e00d67bbf7581950043b167232061857bae4a75b093a74b7702d01a578'
UPSTREAM = 'bf217a504e54cc719880c228e82353382cd7d4fa'
RUNTIME = Path('native/freerdp-input/runtime')
COMPRESSED_LIMIT = 64 * 1024 * 1024
EXPANDED_LIMIT = 256 * 1024 * 1024
ENTRY_LIMIT = 512


def fail(code):
    raise ValueError(code)


def regular_bytes(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            fail('FREERDP_UNSAFE_FILE')
        data = source.read(limit + 1)
        after = os.fstat(source.fileno())
    if (len(data) > limit or len(data) != before.st_size
            or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
        fail('FREERDP_FILE_CHANGED')
    return data


def directory(path, create=False):
    if create:
        try:
            path.mkdir(mode=0o755)
        except FileExistsError:
            pass
        else:
            path.chmod(0o755)  # mkdir mode alone is filtered by the deployer's umask.
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        fail('FREERDP_UNSAFE_DIRECTORY')


def relative_name(value):
    if (not isinstance(value, str) or len(value) > 4096 or not re.fullmatch(r'[A-Za-z0-9_+./-]+', value)
            or value.startswith('/') or any(part in ('', '.', '..') for part in value.split('/'))):
        fail('FREERDP_INVALID_PATH')
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail('FREERDP_DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def decode(data):
    return json.loads(data, object_pairs_hook=unique_object)


def runtime_manifest(data):
    if len(data) > 131072:
        fail('FREERDP_MANIFEST_LIMIT')
    manifest = decode(data)
    if (not isinstance(manifest, dict) or manifest.get('format') != 'portal.freerdp-native.v1'
            or manifest.get('upstreamVersion') != '3.32.1' or manifest.get('upstreamCommit') != UPSTREAM
            or not isinstance(manifest.get('patchSha256'), str)
            or not re.fullmatch(r'[a-f0-9]{64}', manifest['patchSha256'])
            or manifest.get('executable') != 'bin/xfreerdp3'
            or not isinstance(manifest.get('files'), list) or not 1 <= len(manifest['files']) <= 256):
        fail('FREERDP_INVALID_MANIFEST')
    files = {}
    total = 0
    for item in manifest['files']:
        if not isinstance(item, dict) or set(item) != {'path', 'size', 'sha256', 'mode'}:
            fail('FREERDP_INVALID_MANIFEST')
        name = relative_name(item['path'])
        if (name in files or not (name == 'bin/xfreerdp3'
                or re.fullmatch(r'lib/[A-Za-z0-9_+.-]+\.so(?:\.[A-Za-z0-9_+.-]+)?', name)
                or name in ('licenses/FreeRDP-LICENSE', 'licenses/FreeRDP-NOTICE'))
                or type(item['size']) is not int or not 1 <= item['size'] <= 32 * 1024 * 1024
                or type(item['mode']) is not int or item['mode'] not in (0o644, 0o755)
                or not isinstance(item['sha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', item['sha256'])):
            fail('FREERDP_INVALID_MANIFEST')
        total += item['size']
        files[name] = item
    if (total > EXPANDED_LIMIT or files.get('bin/xfreerdp3', {}).get('mode') != 0o755
            or 'licenses/FreeRDP-LICENSE' not in files or not any(name.startswith('lib/') for name in files)):
        fail('FREERDP_INVALID_MANIFEST')
    return files


def pinned_bundle(root):
    if (not isinstance(BUNDLE_PATH, str) or not re.fullmatch(r'vendor/[A-Za-z0-9_.+-]+\.tgz', BUNDLE_PATH)
            or not isinstance(BUNDLE_SHA256, str) or not re.fullmatch(r'[a-f0-9]{64}', BUNDLE_SHA256)):
        fail('FREERDP_BUNDLE_PIN_REQUIRED')
    directory(root / 'vendor')
    release = decode(regular_bytes(root / 'release-manifest.json', 8 * 1024 * 1024))
    entries = release.get('files') if isinstance(release, dict) else None
    if not isinstance(entries, list):
        fail('FREERDP_RELEASE_PIN_REQUIRED')
    matches = [item for item in entries if isinstance(item, dict) and item.get('path') == BUNDLE_PATH]
    if (len(matches) != 1 or matches[0].get('sha256') != BUNDLE_SHA256
            or type(matches[0].get('size')) is not int or not 1 <= matches[0]['size'] <= COMPRESSED_LIMIT):
        fail('FREERDP_RELEASE_PIN_REQUIRED')
    data = regular_bytes(root / BUNDLE_PATH, COMPRESSED_LIMIT)
    if len(data) != matches[0]['size'] or hashlib.sha256(data).hexdigest() != BUNDLE_SHA256:
        fail('FREERDP_BUNDLE_HASH_MISMATCH')
    return data


def verified_archive(data):
    # Bound decompression, including tar headers and extension metadata, before tarfile parses it.
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as compressed:
        expanded = compressed.read(EXPANDED_LIMIT + 1)
    if len(expanded) > EXPANDED_LIMIT:
        fail('FREERDP_EXPANDED_LIMIT')
    archive = tarfile.open(fileobj=io.BytesIO(expanded), mode='r:')
    members = {}
    total = 0
    try:
        for member in archive:
            if len(members) >= ENTRY_LIMIT:
                fail('FREERDP_ENTRY_LIMIT')
            name = relative_name(member.name[:-1] if member.isdir() and member.name.endswith('/') else member.name)
            if name in members:
                fail('FREERDP_DUPLICATE_ENTRY')
            if name.split('/')[0] not in ('runtime', 'source') or not (member.isdir() or member.isreg()):
                fail('FREERDP_UNSAFE_ARCHIVE_ENTRY')
            if name in ('runtime', 'source') and not member.isdir():
                fail('FREERDP_UNSAFE_ARCHIVE_ENTRY')
            if member.mode & ~0o777 or member.mode & 0o022 or member.size < 0:
                fail('FREERDP_UNSAFE_ARCHIVE_MODE')
            total += member.size
            if total > EXPANDED_LIMIT:
                fail('FREERDP_EXPANDED_LIMIT')
            members[name] = member
        for name in members:
            for parent in Path(name).parents:
                if parent.as_posix() in members and not members[parent.as_posix()].isdir():
                    fail('FREERDP_ARCHIVE_PATH_CONFLICT')
        entry = members.get('runtime/manifest.json')
        if entry is None or not entry.isreg() or entry.mode != 0o644 or entry.size > 131072:
            fail('FREERDP_INVALID_MANIFEST')
        manifest = archive.extractfile(entry).read(131073)
        files = runtime_manifest(manifest)
        actual = {name.removeprefix('runtime/') for name, item in members.items()
                  if name.startswith('runtime/') and item.isreg() and name != 'runtime/manifest.json'}
        if actual != set(files):
            fail('FREERDP_UNLISTED_RUNTIME_FILE')
        directories = {'runtime', 'runtime/bin', 'runtime/lib', 'runtime/licenses'}
        for name, member in members.items():
            if name.startswith('runtime') and member.isdir() and name not in directories:
                fail('FREERDP_UNLISTED_RUNTIME_DIRECTORY')
        for name, item in files.items():
            member = members['runtime/' + name]
            if member.size != item['size'] or member.mode != item['mode']:
                fail('FREERDP_RUNTIME_METADATA_MISMATCH')
            digest = hashlib.sha256()
            with archive.extractfile(member) as source:
                for block in iter(lambda: source.read(1048576), b''):
                    digest.update(block)
            if digest.hexdigest() != item['sha256']:
                fail('FREERDP_RUNTIME_HASH_MISMATCH')
        return archive, manifest, files
    except BaseException:
        archive.close()
        raise


def existing_runtime(root, manifest, files):
    directory(root)
    if stat.S_IMODE(root.lstat().st_mode) != 0o755 or regular_bytes(root / 'manifest.json', 131072) != manifest:
        fail('FREERDP_EXISTING_RUNTIME_MISMATCH')
    found = set()
    count = 0
    for base, dirs, names in os.walk(root, followlinks=False):
        directory(Path(base))
        if stat.S_IMODE(Path(base).lstat().st_mode) != 0o755:
            fail('FREERDP_EXISTING_RUNTIME_MISMATCH')
        for name in dirs:
            count += 1
            if (Path(base) / name).relative_to(root).as_posix() not in ('bin', 'lib', 'licenses'):
                fail('FREERDP_EXISTING_RUNTIME_MISMATCH')
            directory(Path(base) / name)
        for name in names:
            count += 1
            if count > ENTRY_LIMIT:
                fail('FREERDP_ENTRY_LIMIT')
            path = Path(base) / name
            relative = path.relative_to(root).as_posix()
            found.add(relative)
            item = files.get(relative)
            if relative == 'manifest.json':
                if path.lstat().st_uid != os.geteuid() or stat.S_IMODE(path.lstat().st_mode) != 0o644:
                    fail('FREERDP_EXISTING_RUNTIME_MISMATCH')
            elif (item is None or path.lstat().st_uid != os.geteuid()
                    or stat.S_IMODE(path.lstat().st_mode) != item['mode']
                    or hashlib.sha256(regular_bytes(path, item['size'])).hexdigest() != item['sha256']):
                fail('FREERDP_EXISTING_RUNTIME_MISMATCH')
    if found != set(files) | {'manifest.json'}:
        fail('FREERDP_EXISTING_RUNTIME_MISMATCH')


def publish(temporary, destination):
    # Linux renameat2 provides atomic directory publication without replacing even an empty directory.
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, 'renameat2', None)
    if rename is None:
        fail('FREERDP_ATOMIC_PUBLISH_UNAVAILABLE')
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(temporary), -100, os.fsencode(destination), 1):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def prepare(root=SOURCE, *, system=None, machine=None):
    system = sys.platform if system is None else system
    machine = platform.machine() if machine is None else machine
    receipt = {'type': 'portal.freerdp-preparation.v1', 'platform': system, 'architecture': machine,
               'runtime': RUNTIME.as_posix()}
    if system != 'linux' or machine not in ('x86_64', 'amd64'):
        return {**receipt, 'status': 'skipped', 'reason': 'UNSUPPORTED_NATIVE_PLATFORM'}
    root = Path(root).absolute()
    directory(root)
    data = pinned_bundle(root)
    archive, manifest, files = verified_archive(data)
    temporary = None
    try:
        parent = root
        for part in RUNTIME.parts[:-1]:
            parent /= part
            directory(parent, create=True)
        destination = root / RUNTIME
        if os.path.lexists(destination):
            existing_runtime(destination, manifest, files)
            return {**receipt, 'status': 'reused', 'archive': BUNDLE_PATH, 'archiveSha256': BUNDLE_SHA256, 'files': len(files)}
        temporary = Path(tempfile.mkdtemp(prefix='.runtime-', dir=parent))
        for name in [*files, 'manifest.json']:
            target = temporary / name
            if target.parent != temporary:
                target.parent.mkdir(mode=0o755, exist_ok=True)
                target.parent.chmod(0o755)
            content = manifest if name == 'manifest.json' else archive.extractfile('runtime/' + name).read(files[name]['size'] + 1)
            mode = 0o644 if name == 'manifest.json' else files[name]['mode']
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as output:
                output.write(content)
                output.flush()
                os.fchmod(output.fileno(), mode)
                os.fsync(output.fileno())
        temporary.chmod(0o755)
        existing_runtime(temporary, manifest, files)
        for name in ('bin', 'lib', 'licenses', ''):
            fd = os.open(temporary / name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        try:
            publish(temporary, destination)
            temporary = None
            status = 'prepared'
        except OSError as error:
            if error.errno != errno.EEXIST:
                raise
            existing_runtime(destination, manifest, files)
            status = 'reused'
        fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return {**receipt, 'status': status, 'archive': BUNDLE_PATH, 'archiveSha256': BUNDLE_SHA256, 'files': len(files)}
    finally:
        archive.close()
        if temporary is not None:
            shutil.rmtree(temporary)  # Only this invocation's exclusively created, private extraction.


if __name__ == '__main__':
    try:
        print(json.dumps(prepare()))
    except (ValueError, OSError, tarfile.TarError, EOFError) as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r'FREERDP_[A-Z_]+', str(error)) else 'FREERDP_PREPARATION_FAILED'
        print(json.dumps({'type': 'portal.freerdp-preparation.v1', 'status': 'failed', 'code': code}))
        sys.exit(1)
