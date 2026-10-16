#!/usr/bin/env python3
"""Stage verified exact hosts or *.domain patterns; never print managed secrets."""
import os
from pathlib import Path
import stat
import sys
from settings_contract import parse_env, validate_upload_hosts


def update_source_hosts(text, raw):
    parse_env(text)
    hosts = validate_upload_hosts(raw)
    newline = '\r\n' if '\r\n' in text else '\n'
    kept = ''.join(line for line in text.splitlines(keepends=True) if not line.startswith('BRIDGE_UPLOAD_SOURCE_HOSTS='))
    if kept and not kept.endswith(('\r', '\n')):
        kept += newline
    proposed = kept + 'BRIDGE_UPLOAD_SOURCE_HOSTS=' + ','.join(hosts) + newline
    if len(proposed.encode('utf-8')) > 65536:
        raise ValueError('Managed configuration exceeds its size limit')
    return proposed


def read_private_config(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        value = os.fstat(fd)
        if not stat.S_ISREG(value.st_mode) or value.st_mode & 0o077 or value.st_size > 65536 or Path(path).is_symlink():
            raise ValueError('Expected a private regular managed configuration')
        with os.fdopen(fd, 'rb', closefd=False) as source:
            return source.read().decode('utf-8')
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        source, destination = sys.argv[1:]
        if source not in ['/etc/ssh-mcp-approval-bridge.env', '/etc/ssh-approval-portal/docker-secrets.env'] or not Path(destination).is_absolute():
            raise ValueError('Use a managed configuration and absolute staging file')
        text = read_private_config(source)
        hosts = input('Verified exact hostname(s) or *.domain patterns, comma separated (empty disables): ') if sys.stdin.isatty() else sys.stdin.readline().rstrip('\r\n')
        proposed = update_source_hosts(text, hosts)
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as output:
            output.write(proposed.encode('utf-8')); output.flush(); os.fsync(output.fileno())
        print('File source settings staged. Existing secrets and authentication were preserved.')
    except Exception:
        print('File source setup refused; verify exact hostnames or *.domain patterns and private managed paths.', file=sys.stderr)
        sys.exit(1)
