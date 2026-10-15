#!/usr/bin/env python3
"""Stage only exact file-provider hostnames; never print the managed configuration."""
import ipaddress
import os
from pathlib import Path
import re
import socket
import stat
import sys
from settings_contract import parse_env


def update_source_hosts(text, raw):
    parse_env(text)
    if not isinstance(raw, str) or any(char in raw for char in '\r\n\0'):
        raise ValueError('Use comma-separated exact hostnames')
    hosts = []
    for value in raw.split(',') if raw.strip() else []:
        host = value.strip().lower()
        if not host or len(host) > 253 or not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in host.split('.')):
            raise ValueError('Use exact DNS hostnames, without URLs, wildcards or credentials')
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise ValueError('IP literals are not file-provider hostnames')
        try:
            socket.inet_aton(host)
        except OSError:
            pass
        else:
            raise ValueError('Numeric IP aliases are not file-provider hostnames')
        if host not in hosts:
            hosts.append(host)
    newline = '\r\n' if '\r\n' in text else '\n'
    kept = ''.join(line for line in text.splitlines(keepends=True) if not line.startswith('BRIDGE_UPLOAD_SOURCE_HOSTS='))
    if kept and not kept.endswith(('\r', '\n')):
        kept += newline
    return kept + 'BRIDGE_UPLOAD_SOURCE_HOSTS=' + ','.join(hosts) + newline


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
        hosts = input('Exact verified file-provider hostname(s), comma separated (empty disables): ') if sys.stdin.isatty() else sys.stdin.readline().rstrip('\r\n')
        proposed = update_source_hosts(text, hosts)
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as output:
            output.write(proposed.encode('utf-8')); output.flush(); os.fsync(output.fileno())
        print('File source settings staged. Existing secrets and authentication were preserved.')
    except Exception:
        print('File source setup refused; verify exact hostnames and private managed paths.', file=sys.stderr)
        sys.exit(1)
