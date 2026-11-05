#!/usr/bin/env python3
"""Build the standalone Node client from its explicit entrypoint import graph."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import tarfile
import zipfile

CLIENT_VERSION = '2.2.0'
PREFIX = 'ssh-approval-portal-client-' + CLIENT_VERSION
IMPORT = re.compile(r'''^\s*(?:import\s+(?:[^;]*?\s+from\s+)?|export\s+[^;]*?\s+from\s+)['"]([^'"]+)['"]''', re.MULTILINE)


def unsafe(path):
    return path.is_symlink() or bool(getattr(path.lstat(), 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def source_files(root):
    """Only statically imported in-repository modules/data; no directory crawling."""
    root = Path(root).resolve()
    pending = ['scripts/portal-files.mjs', 'scripts/portal-completion-hook.mjs']
    files = {}
    while pending:
        name = pending.pop()
        if name in files:
            continue
        if len(files) >= 128:
            raise ValueError('Client import graph is unexpectedly large')
        path = root / name
        if (path.suffix not in {'.mjs', '.json'} or not path.is_file() or unsafe(path)
                or any(unsafe(root / p) for p in path.relative_to(root).parents)):
            raise ValueError('Unsafe or missing client source: ' + name)
        data = path.read_bytes()
        if re.search(rb'^-----BEGIN (?:OPENSSH|RSA|EC|ENCRYPTED) PRIVATE KEY-----', data, re.MULTILINE):
            raise ValueError('Private key is not a client source')
        if path.suffix == '.json':
            if isinstance(value := json.loads(data), dict) and value.get('kind') == 'secret-record':
                raise ValueError('Secret record is not a client source')
        else:
            for specifier in IMPORT.findall(data.decode('utf-8')):
                if specifier.startswith('node:'):
                    continue
                if not specifier.startswith(('./', '../')):
                    raise ValueError('Standalone client requires an undeclared external module: ' + specifier)
                # Normalize dot segments without resolving away a symlink or
                # junction that must be rejected when that module is visited.
                target = Path(os.path.abspath(path.parent / specifier))
                relative = target.relative_to(root).as_posix()
                pending.append(relative)
        files[name] = data
    return files


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def package(root, output):
    root, output = Path(root).resolve(), Path(output).resolve()
    files = source_files(root)
    for name in ['LICENSE', 'docs/client-files.ko.md', 'hooks/codex.json', 'hooks/claude-code.json', 'hooks/antigravity.json', '.codex-plugin/plugin.json']:
        path = root / name
        if not path.is_file() or unsafe(path) or any(unsafe(root / p) for p in path.relative_to(root).parents):
            raise ValueError('Missing or unsafe client documentation: ' + name)
        files[name] = path.read_bytes()
    files['README.ko.md'] = files['docs/client-files.ko.md']
    files['package.json'] = encoded({'name': 'ssh-approval-portal-client', 'version': CLIENT_VERSION, 'private': True,
        'type': 'module', 'description': 'Owner-authenticated PC file staging client; one existing remote MCP connection.',
        'engines': {'node': '>=24.2.0 <25'}, 'dependencies': {}})
    manifest = {'schemaVersion': '1.0.0', 'name': 'ssh-approval-portal-client', 'version': CLIENT_VERSION,
        'entrypoint': 'scripts/portal-files.mjs', 'runtime': 'Preinstalled Node.js >=24.2.0 <25; no npm install required.',
        'authentication': 'Existing trusted cloudflared executable and owner login cache; no credential or executable is bundled.',
        'files': [{'path': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in sorted(files.items())]}
    files['client-manifest.json'] = encoded(manifest)
    output.mkdir(parents=True, exist_ok=True)
    archives = [output / (PREFIX + '.tar.gz'), output / (PREFIX + '.zip')]
    checksum = output / ('SHA256SUMS-client-' + CLIENT_VERSION)
    for path in [*archives, checksum]:
        if path.exists():
            raise FileExistsError('Client output already exists: ' + str(path))
    with archives[0].open('xb') as destination:
        with gzip.GzipFile(filename='', fileobj=destination, mode='wb', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w') as archive:
                for name, data in sorted(files.items()):
                    info = tarfile.TarInfo(PREFIX + '/' + name)
                    info.size, info.mode, info.mtime = len(data), 0o644, 0
                    info.uid = info.gid = 0
                    info.uname = info.gname = 'root'
                    archive.addfile(info, io.BytesIO(data))
    with archives[1].open('xb') as destination:
        with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in sorted(files.items()):
                info = zipfile.ZipInfo(PREFIX + '/' + name, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system, info.external_attr, info.compress_type = 3, (stat.S_IFREG | 0o644) << 16, zipfile.ZIP_DEFLATED
                archive.writestr(info, data)
    sums = ''.join(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n' for path in archives)
    with checksum.open('x', encoding='utf-8', newline='\n') as destination:
        destination.write(sums)
    return {'version': CLIENT_VERSION, 'files': len(files), 'archives': [str(p) for p in archives], 'checksums': sums}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='New build output directory; existing artifacts are never overwritten')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    print(json.dumps(package(root, args.output or root / 'dist' / 'client'), ensure_ascii=False))
