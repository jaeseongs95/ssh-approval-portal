#!/usr/bin/env python3
import os, pathlib, pwd, re, secrets, sys, tempfile
native = pathlib.Path('/etc/ssh-mcp-approval-bridge.env')
destination = pathlib.Path('/etc/ssh-approval-portal/docker-secrets.env')
source = destination if destination.exists() else native
if source.exists() and (not source.is_file() or source.is_symlink()): raise ValueError('Unsafe existing secret file')
text = source.read_text(encoding='utf-8') if source.exists() else ''
has = lambda name: re.search('^' + name + '=', text, re.M)
origin = sys.argv[1] if len(sys.argv) > 1 else ''
if not has('BRIDGE_ADMIN_ORIGIN') and not re.fullmatch(r'https://[^/\s]+', origin): raise ValueError('Initial setup needs HTTPS origin')
for name in ['BRIDGE_MCP_TOKEN', 'BRIDGE_ADMIN_TOKEN', 'BRIDGE_UI_TICKET_KEY']:
    if not has(name): text += '\n' + name + '=' + secrets.token_hex(32) + '\n'
if not has('BRIDGE_ADMIN_ORIGIN'): text += 'BRIDGE_ADMIN_ORIGIN=' + origin + '\n'
if not has('BRIDGE_UI_ENABLED'): text += 'BRIDGE_UI_ENABLED=false\n'
if not has('BRIDGE_UI_TOOL_PREFIX'): text += 'BRIDGE_UI_TOOL_PREFIX=ssh-approval-bridge_\n'
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
