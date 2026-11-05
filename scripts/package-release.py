#!/usr/bin/env python3
"""Build server and model-external client assets together in a new directory."""
import argparse
import hashlib
import json
from pathlib import Path
import runpy


def package_release(root, output, *, release=False):
    root, output = Path(root).resolve(), Path(output).absolute()
    version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
    server = runpy.run_path(str(root / 'scripts/package.py'))
    client = runpy.run_path(str(root / 'scripts/package-client.py'))
    if client['CLIENT_VERSION'] != version:
        raise ValueError('Server and client versions must match')
    # Refuse an existing output, including a link. Never overwrite an older package.
    output.mkdir(parents=True, exist_ok=False)
    server_archives, _ = server['package'](root, output, release=release)
    client_result = client['package'](root, output)
    archives = [*server_archives, *map(Path, client_result['archives'])]
    sums = ''.join(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n' for path in archives)
    (output / 'SHA256SUMS').write_text(sums, encoding='utf-8', newline='\n')
    return {'version': version, 'archives': [path.name for path in archives], 'checksums': sums}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='New directory for all server and client release assets')
    parser.add_argument('--release', action='store_true', help='Mark an independently reviewed release package')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
    print(json.dumps(package_release(root, args.output or root / 'dist' / ('release-' + version), release=args.release)))
