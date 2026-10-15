#!/usr/bin/env python3
"""Non-secret configuration policy shared by deployment and runtime adapters."""
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import sys
from urllib.parse import urlsplit

contract = json.loads((Path(__file__).resolve().parents[1] / 'config/settings-contract.json').read_text(encoding='utf-8'))
defaults = contract['defaults']


def validate_origin(value):
    if not isinstance(value, str) or not re.fullmatch(contract['originPattern'], value):
        raise ValueError('Configure one canonical HTTPS administrator origin')
    parsed = urlsplit(value)
    host = parsed.hostname
    port = parsed.port
    if not host or port == 443 or port == 0:
        raise ValueError('Configure one canonical HTTPS administrator origin')
    if ':' in host:
        canonical_host = '[' + ipaddress.IPv6Address(host).compressed + ']'
    else:
        canonical_host = host
        if re.fullmatch(r'(?:[0-9]+|0x[0-9a-f]*)', host.rstrip('.').split('.')[-1]):
            canonical_host = str(ipaddress.IPv4Address(host))
        for label in host.rstrip('.').split('.'):
            if label.startswith('xn--'):
                label.encode('ascii').decode('idna')
    canonical = 'https://' + canonical_host + (':' + str(port) if port is not None else '')
    if canonical != value:
        raise ValueError('Configure one canonical HTTPS administrator origin')
    return value


def validate_port(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]+', value) or not 1 <= int(value) <= 65535:
        raise ValueError('Configure a TCP port from 1 to 65535')
    return int(value)


def parse_env(text):
    settings = {}
    for line in text.split('\n'):
        line = line.removesuffix('\r')
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r'([A-Z_][A-Z0-9_]*)=(.*)', line)
        if not match or (match[1] not in contract['allowedKeys'] and not re.fullmatch(r'SSH_MCP_[A-Z0-9_]+', match[1])):
            raise ValueError('Unsupported secret configuration entry')
        value = match[2].strip()
        if len(value) >= 2 and value[0] in '\'"' and value[-1] == value[0]:
            value = value[1:-1]
        if any(char in value for char in '\r\n\0'):
            raise ValueError('Invalid secret configuration value')
        settings[match[1]] = value
    return settings


def read_env(env_path):
    try:
        fd = os.open(env_path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    except FileNotFoundError:
        return {}
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or (os.name != 'nt' and info.st_mode & 0o077) or info.st_size > 65536 or Path(env_path).is_symlink():
            raise ValueError('Expected a private regular managed configuration')
        with os.fdopen(fd, 'rb', closefd=False) as source:
            return parse_env(source.read().decode('utf-8'))
    finally:
        os.close(fd)


def validated_ports(env_path):
    settings = {**defaults, **read_env(env_path)}
    return {kind: validate_port(settings[key]) for kind, key in [('mcp', 'BRIDGE_MCP_PORT'), ('admin', 'BRIDGE_ADMIN_PORT')]}


if __name__ == '__main__':
    try:
        command, env_path, kind = sys.argv[1:]
        if command != 'port' or kind not in ('mcp', 'admin'):
            raise ValueError('Use port ENV_PATH mcp|admin')
        print(validated_ports(env_path)[kind])
    except Exception:
        print('Configuration check failed; use valid private settings and supported ports.', file=sys.stderr)
        sys.exit(1)
