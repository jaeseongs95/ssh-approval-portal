#!/usr/bin/env python3
"""Create explicit-allowlist server packages; never copy node_modules or operator secrets."""
import hashlib
import json
import pathlib
import tarfile
import zipfile
import sys
import re

root = pathlib.Path(__file__).resolve().parents[1]
files = []
for name in ['package.json', 'package-lock.json', 'bridge.mjs', 'app.mjs', 'core.mjs', 'artifacts.mjs', 'transfers.mjs', 'secrets.mjs', 'README.ko.md', 'LICENSE', 'THIRD_PARTY_NOTICES.json', '.dockerignore']:
    files.append(root / name)
for folder in ['scripts', 'config', 'helper', 'vendor', 'test', 'web', 'docker']:
    files.extend(p for p in (root / folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts and (folder != 'test' or p.suffix in ('.mjs', '.py', '.sh', '.ps1', '.md', '.Dockerfile') or p.name == 'Dockerfile'))
files.append(root / 'ui/dist/card.html')
files.extend([root / 'ui/package.json', root / 'ui/package-lock.json', root / 'ui/build.mjs', root / 'ui/card.html', root / 'ui/card.js'])
entries = []
for path in sorted(set(files)):
    if not path.is_file() or path.is_symlink():
        raise ValueError('Missing or unsafe package file: ' + str(path.relative_to(root)))
    data = path.read_bytes()
    if re.search(rb'^-----BEGIN (?:OPENSSH|RSA|EC|ENCRYPTED) PRIVATE KEY-----', data, re.MULTILINE):
        raise ValueError('Private key in package')
    entries.append({'path': path.relative_to(root).as_posix(), 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
manifest = {'version': '0.3.0', 'status': 'candidate-pending-live-host-verification', 'runtime': 'Node.js 24', 'files': entries}
manifest_path = root / 'release-manifest.json'
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
files.append(manifest_path)
output = root / 'dist'
output.mkdir(exist_ok=True)
prefix = 'ssh-approval-portal-0.3.0'
archives = [output / (prefix + '.tar.gz'), output / (prefix + '.zip')]
with tarfile.open(archives[0], 'w:gz') as archive:
    for path in sorted(set(files)):
        info = archive.gettarinfo(str(path), prefix + '/' + path.relative_to(root).as_posix())
        info.uid = info.gid = 0; info.uname = info.gname = 'root'; info.mtime = 0
        info.mode = 0o755 if path.suffix == '.sh' or path.name == 'file-helper.py' else 0o644
        with path.open('rb') as source: archive.addfile(info, source)
with zipfile.ZipFile(archives[1], 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(set(files)):
        archive.write(path, prefix + '/' + path.relative_to(root).as_posix())
checksums = ''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name + '\n' for p in archives)
(output / 'SHA256SUMS').write_text(checksums, encoding='utf-8')
print(checksums, end='')
