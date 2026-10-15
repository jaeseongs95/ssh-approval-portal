#!/usr/bin/env python3
"""Controller for synthetic installation fixtures only; never prints secrets."""
import hashlib
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from settings_contract import read_env

ENV = Path('/etc/ssh-mcp-approval-bridge.env')
FILES = ['/var/lib/ssh-mcp/.config/ssh-mcp/config.toml', '/var/lib/ssh-mcp/.ssh/id_ed25519',
         '/etc/sudoers.d/90-mcpops-approval-bridge', '/etc/systemd/system/ssh-approval-bridge.service',
         '/usr/local/libexec/ssh-approval-file-helper']


def run(action, path):
    path = Path(path)
    if action == 'capture':
        audit = Path('/var/lib/ssh-mcp/.local/share/ssh-mcp/approval-bridge-audit.jsonl')
        state = {'env': read_env(ENV), 'files': {name: hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in FILES},
                 'audit': audit.read_bytes().hex() if audit.exists() else ''}
        with path.open('w', encoding='utf-8') as output:
            os.chmod(path, 0o600)
            json.dump(state, output)
    elif action == 'assert-preserved':
        state = json.loads(path.read_text(encoding='utf-8'))
        current = read_env(ENV)
        assert all(current.get(key) == value for key, value in state['env'].items()), 'Existing environment value changed'
        for name, digest in state['files'].items():
            assert hashlib.sha256(Path(name).read_bytes()).hexdigest() == digest, 'Managed host file changed: ' + name
        audit = Path('/var/lib/ssh-mcp/.local/share/ssh-mcp/approval-bridge-audit.jsonl')
        assert not state['audit'] or audit.read_bytes().startswith(bytes.fromhex(state['audit'])), 'Existing audit history changed'
    elif action == 'break-release':
        with (path / 'bridge.mjs').open('a', encoding='utf-8', newline='\n') as output:
            output.write('\nthrow Error("synthetic startup failure");\n')
        manifest = path / 'release-manifest.json'
        data = json.loads(manifest.read_text(encoding='utf-8'))
        for entry in data['files']:
            raw = (path / entry['path']).read_bytes()
            entry.update(size=len(raw), sha256=hashlib.sha256(raw).hexdigest())
        manifest.write_text(json.dumps(data) + '\n', encoding='utf-8', newline='\n')
    elif action == 'docker-settings':
        with path.open('a', encoding='utf-8', newline='\n') as output:
            output.write('\nBRIDGE_MCP_PORT=39224\nBRIDGE_ADMIN_PORT=39225\n'
                         'BRIDGE_ADMIN_AUTH_MODE=token\n'
                         'BRIDGE_ACCESS_TEAM_DOMAIN=https://fixture.cloudflareaccess.com\n'
                         'BRIDGE_ACCESS_AUD=fixture-audience\n'
                         'BRIDGE_ACCESS_OWNER_EMAILS=owner@example.test,other@example.test\n'
                         'BRIDGE_UPLOAD_SOURCE_HOSTS=files.example.test\n')
    else:
        raise ValueError('Unknown synthetic fixture action')


if __name__ == '__main__':
    run(*sys.argv[1:])
