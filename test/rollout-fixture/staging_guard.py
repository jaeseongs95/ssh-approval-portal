"""Preserve completed transfer-cache bytes before an explicitly coordinated restart."""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat

PART = re.compile(r'[a-f0-9]{48}\.part\Z')
MAX_FILE = 64 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024

def require(condition, code):
    if not condition:
        raise RuntimeError(code)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def private_directory(path):
    s = path.lstat()
    require(not path.is_symlink() and stat.S_ISDIR(s.st_mode) and s.st_uid == os.geteuid() and stat.S_IMODE(s.st_mode) == 0o700, 'cache-backup-directory')

def regular(path, owner):
    s = path.lstat()
    require(not path.is_symlink() and stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == owner and stat.S_IMODE(s.st_mode) == 0o600, 'cache-private-file')
    return s

def state(path):
    s = regular(path, path.parent.stat().st_uid)
    return {'uid': s.st_uid, 'gid': s.st_gid, 'mode': stat.S_IMODE(s.st_mode), 'sha256': digest(path.read_bytes())}

def backup(transfer, expected_files, destination):
    """Called after confirmed maintenance, before stopping the existing process.

    If a file expires/changes during copying this fails with the process still up.
    It never deletes, renames or modifies a source entry.
    """
    transfer, destination = Path(transfer), Path(destination)
    candidates = [Path(name) for name in expected_files if Path(name).parent == transfer and PART.fullmatch(Path(name).name)]
    require(len(candidates) <= 100, 'cache-count-bound')
    sizes = [regular(p, transfer.stat().st_uid).st_size for p in candidates]
    require(all(n <= MAX_FILE for n in sizes) and sum(sizes) <= MAX_TOTAL, 'cache-byte-bound')
    destination.mkdir(mode=0o700)
    private_directory(destination)
    entries = {}
    copied = 0
    for path in sorted(candidates):
        expected = expected_files[str(path)]
        before = regular(path, transfer.stat().st_uid)
        target = destination / path.name
        h = hashlib.sha256()
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as source:
            first = os.fstat(source.fileno())
            require((first.st_dev, first.st_ino) == (before.st_dev, before.st_ino), 'cache-source-identity')
            with target.open('xb') as output:
                target.chmod(0o600)
                count = 0
                for block in iter(lambda: source.read(65536), b''):
                    count += len(block)
                    copied += len(block)
                    require(count <= MAX_FILE and copied <= MAX_TOTAL, 'cache-growth-bound')
                    h.update(block)
                    output.write(block)
                output.flush()
                os.fsync(output.fileno())
            last = os.fstat(source.fileno())
        after = path.lstat()
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_uid, s.st_gid, stat.S_IMODE(s.st_mode), s.st_nlink)
        require(identity(before) == identity(first) == identity(last) == identity(after), 'cache-source-changed')
        original = {'uid': before.st_uid, 'gid': before.st_gid, 'mode': stat.S_IMODE(before.st_mode), 'sha256': h.hexdigest()}
        require(original == expected and state(target)['sha256'] == original['sha256'], 'cache-copy-mismatch')
        entries[path.name] = {'original': original, 'size': count}
    with (destination / 'manifest.json').open('x', encoding='utf8') as stream:
        os.chmod(stream.name, 0o600)
        json.dump(entries, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    return len(entries)

def verified(destination):
    destination = Path(destination)
    private_directory(destination)
    record = destination / 'manifest.json'
    regular(record, os.geteuid())
    entries = json.loads(record.read_text())
    require(isinstance(entries, dict) and len(entries) <= 100, 'cache-manifest')
    require(set(p.name for p in destination.iterdir()) == set(entries) | {'manifest.json'}, 'cache-backup-entries')
    for name, entry in entries.items():
        require(PART.fullmatch(name) and set(entry) == {'original', 'size'}, 'cache-entry')
        path = destination / name
        s = regular(path, os.geteuid())
        require(s.st_size == entry['size'] <= MAX_FILE and digest(path.read_bytes()) == entry['original']['sha256'], 'cache-backup-changed')
    require(sum(e['size'] for e in entries.values()) <= MAX_TOTAL, 'cache-backup-bound')
    return entries

def before_start(transfer, destination):
    transfer = Path(transfer)
    parts = [p for p in transfer.iterdir() if PART.fullmatch(p.name)]
    if not parts:
        return
    entries = verified(destination)
    for path in parts:
        require(path.name in entries and state(path) == entries[path.name]['original'], 'unbacked-cache-before-start')

def adjusted(transfer, before, destination):
    """Only admit expiry of exact, privately backed up top-level cache files.

    Command output payloads, database rows, policies and other transfer files
    retain the original strict guard. Capability URLs cannot survive restart.
    """
    transfer = Path(transfer)
    entries = verified(destination)
    adjusted = copy.deepcopy(before)
    removed = 0
    for name, value in before['files'].items():
        if not PART.fullmatch(name):
            continue
        require(name in entries and value.get('type') == 'file' and {k: value[k] for k in ['uid', 'gid', 'mode', 'sha256']} == entries[name]['original'], 'cache-snapshot-binding')
        if not (transfer / name).exists():
            adjusted['files'].pop(name)
            removed += 1
    return adjusted, removed, len(entries)
