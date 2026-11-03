#!/usr/bin/env python3
import os, pathlib, pwd, re, secrets, sys, tempfile
from settings_contract import capacity_defaults, defaults, read_env, validate_origin
native = pathlib.Path('/etc/ssh-mcp-approval-bridge.env')
destination = pathlib.Path('/etc/ssh-approval-portal/docker-secrets.env')
source = destination if destination.exists() or destination.is_symlink() else native
existing = read_env(source)
text = ''
if source.exists():
    with source.open(encoding='utf-8', newline='') as input_file:
        text = input_file.read()
newline = '\r\n' if '\r\n' in text else '\n'
origin = sys.argv[1] if len(sys.argv) > 1 else ''
validate_origin(existing.get('BRIDGE_ADMIN_ORIGIN', origin))
generated_defaults = capacity_defaults()
for name in generated_defaults:
    if name in existing and (not re.fullmatch(r'[1-9][0-9]*', existing[name]) or int(existing[name]) > 9007199254740991):
        raise ValueError('Invalid execution capacity')
for name in ['BRIDGE_MCP_TOKEN', 'BRIDGE_ADMIN_TOKEN', 'BRIDGE_UI_TICKET_KEY']:
    if name not in existing: text += newline + name + '=' + secrets.token_hex(32) + newline
if text and not text.endswith('\n'): text += newline
if 'BRIDGE_ADMIN_ORIGIN' not in existing: text += 'BRIDGE_ADMIN_ORIGIN=' + origin + newline
for name, value in {**defaults, **generated_defaults}.items():
    if name not in existing: text += name + '=' + str(value) + newline
account = pwd.getpwnam('mcpbridge')
fd, temporary = tempfile.mkstemp(prefix='.secrets.', dir=destination.parent)
try:
    with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as output:
        output.write(text); output.flush(); os.fsync(output.fileno())
    os.chown(temporary, account.pw_uid, account.pw_gid); os.chmod(temporary, 0o600)
    os.replace(temporary, destination)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
print('Docker secret file prepared; values were not printed.')
