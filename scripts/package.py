#!/usr/bin/env python3
"""Create explicit-allowlist server packages; never copy operator secrets."""
import hashlib
import json
from pathlib import Path
import re
import stat
import tarfile
import zipfile

ROOT_FILES = ['package.json', 'package-lock.json', 'bridge.mjs', 'app.mjs',
              'README.md', 'README.ko.md', 'LICENSE', 'THIRD_PARTY_NOTICES.json', '.dockerignore']
CONFIG_FILES = ['bridge.env.example', 'config.example.toml', 'docker.example.env',
                'ssh-approval-bridge.service', 'settings-contract.json', 'ssh-approval-env.socket', 'ssh-approval-env@.service']
SOURCE_TYPES = {
    'src': {'.mjs', '.json'},
    'scripts': {'.mjs', '.py', '.sh'},
    'helper': {'.py'},
    'vendor': {'.tgz'},
    'test': {'.mjs', '.js', '.py', '.sh', '.ps1', '.md', '.json', '.html', '.Dockerfile'},
    'web': {'.js', '.mjs', '.html', '.css'},
    'docker': {'.yaml', '.yml', '.Dockerfile'},
    'docs': {'.md'},
    'ui/src': {'.js', '.mjs', '.html', '.css', '.json'},
}
UI_FILES = ['ui/dist/card.html', 'web/dist/app.js', 'ui/package.json', 'ui/package-lock.json',
            'ui/build.mjs', 'ui/card.html', 'ui/card.js']
DEPLOY_FILES = ['deploy/oidc/Caddyfile', 'deploy/oidc/oauth2-proxy.cfg']


def unsafe_link(path):
    return path.is_symlink() or bool(getattr(path.lstat(), 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def collect_files(root):
    root = Path(root)
    files = [root / name for name in ROOT_FILES + UI_FILES + DEPLOY_FILES]
    files.extend(root / 'config' / name for name in CONFIG_FILES)
    for folder, suffixes in SOURCE_TYPES.items():
        directory = root / folder
        if not directory.is_dir():
            raise ValueError('Missing package source directory: ' + folder)
        for path in directory.rglob('*'):
            if folder == 'test' and path.name.endswith('-results.json'):
                continue
            if any(part in ('node_modules', '__pycache__', '.git') or part.startswith('.') for part in path.relative_to(directory).parts):
                continue
            if unsafe_link(path):
                raise ValueError('Unsafe package symlink: ' + path.relative_to(root).as_posix())
            if path.is_file() and (path.suffix in suffixes or path.name == 'Dockerfile'):
                files.append(path)
    for path in files:
        if (not path.is_file() or unsafe_link(path)
                or any(unsafe_link(root / parent) for parent in path.relative_to(root).parents)):
            raise ValueError('Missing or unsafe package file: ' + path.relative_to(root).as_posix())
    # pathlib compares Windows paths case-insensitively; manifests must use
    # the same relative-path ordering on all packaging hosts.
    unique = {path.relative_to(root).as_posix(): path for path in files}
    return [unique[name] for name in sorted(unique)]


def package(root, output=None, *, release=False):
    root = Path(root).resolve()
    files = collect_files(root)
    version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
    entries = []
    for path in files:
        data = path.read_bytes()
        if re.search(rb'^-----BEGIN (?:OPENSSH|RSA|EC|ENCRYPTED) PRIVATE KEY-----', data, re.MULTILINE):
            raise ValueError('Private key in package')
        if path.suffix == '.json':
            try:
                record = json.loads(data)
            except (ValueError, UnicodeDecodeError):
                record = None
            if isinstance(record, dict) and record.get('kind') == 'secret-record':
                raise ValueError('Secret store record in package')
        entries.append({'path': path.relative_to(root).as_posix(), 'size': len(data),
                        'sha256': hashlib.sha256(data).hexdigest()})
    manifest = {'version': version, 'status': 'release' if release else 'candidate-pending-live-host-verification',
                'runtime': 'Node.js 24', 'files': entries}
    manifest_path = root / 'release-manifest.json'
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    files.append(manifest_path)
    output = Path(output) if output else root / 'dist'
    output.mkdir(parents=True, exist_ok=True)
    prefix = 'ssh-approval-portal-' + version
    archives = [output / (prefix + '.tar.gz'), output / (prefix + '.zip')]
    with tarfile.open(archives[0], 'w:gz') as archive:
        for path in sorted(files, key=lambda item: item.relative_to(root).as_posix()):
            info = archive.gettarinfo(str(path), prefix + '/' + path.relative_to(root).as_posix())
            info.uid = info.gid = 0
            info.uname = info.gname = 'root'
            info.mtime = 0
            info.mode = 0o755 if path.suffix == '.sh' or path.name == 'file-helper.py' else 0o644
            with path.open('rb') as source:
                archive.addfile(info, source)
    with zipfile.ZipFile(archives[1], 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(files, key=lambda item: item.relative_to(root).as_posix()):
            archive.write(path, prefix + '/' + path.relative_to(root).as_posix())
    checksums = ''.join(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n' for path in archives)
    (output / 'SHA256SUMS').write_text(checksums, encoding='utf-8', newline='\n')
    return archives, checksums


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--release', action='store_true', help='Mark an independently reviewed release package')
    args = parser.parse_args()
    _, checksums = package(Path(__file__).resolve().parents[1], release=args.release)
    print(checksums, end='')
