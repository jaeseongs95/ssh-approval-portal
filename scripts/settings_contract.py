#!/usr/bin/env python3
"""Non-secret configuration policy shared by deployment and runtime adapters."""
import json
import os
from pathlib import Path
import re
import stat
import sys
import shutil
import subprocess

contract = json.loads((Path(__file__).resolve().parents[1] / 'config/settings-contract.json').read_text(encoding='utf-8'))
defaults = contract['defaults']


def validate_origin(value):
    try:
        if not isinstance(value, str):
            raise ValueError()
        encoded = value.encode('utf-8')
        if not encoded or len(encoded) > contract['originMaxBytes']:
            raise ValueError()
        # Trust the administrator-owned managed runtime first, otherwise the host's PATH.
        # Neither the executable nor script path is selected from the configuration value.
        managed = Path('/opt/ssh-approval/node/bin/node')
        node = str(managed) if managed.is_file() else shutil.which('node')
        if not node:
            raise ValueError()
        child_env = {key: item for key, item in os.environ.items() if key not in ('NODE_OPTIONS', 'NODE_PATH')}
        result = subprocess.run([node, str(Path(__file__).with_name('validate-origin.mjs'))], input=encoded,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, shell=False, env=child_env)
        # The trusted CLI bounds output before writing; also reject any unexpected response here.
        if result.returncode or len(result.stdout) > contract['originMaxBytes'] or result.stdout != encoded:
            raise ValueError()
    except (OSError, ValueError, subprocess.SubprocessError):
        raise ValueError('Configure one canonical HTTPS administrator origin') from None
    return value


def validate_port(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]+', value) or not 1 <= int(value) <= 65535:
        raise ValueError('Configure a TCP port from 1 to 65535')
    return int(value)


def validate_upload_hosts(value):
    """Use the same Node24 hostname/pattern contract as the HTTPS source adapter."""
    try:
        if not isinstance(value, str) or len(value.encode('utf-8')) > 65536 or any(char in value for char in '\r\n\0'):
            raise ValueError()
        managed = Path('/opt/ssh-approval/node/bin/node')
        node = str(managed) if managed.is_file() else shutil.which('node')
        if not node:
            raise ValueError()
        child_env = {key: item for key, item in os.environ.items() if key not in ('NODE_OPTIONS', 'NODE_PATH')}
        result = subprocess.run([node, str(Path(__file__).with_name('validate-upload-hosts.mjs'))],
                                input=value.encode('utf-8'), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=5, shell=False, env=child_env)
        if result.returncode or len(result.stdout) > 65536:
            raise ValueError()
        canonical = result.stdout.decode('ascii')
        if any(char in canonical for char in '\r\n\0'):
            raise ValueError()
        return canonical.split(',') if canonical else []
    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
        raise ValueError('Configure exact DNS hostnames or leading *.domain suffixes') from None


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
