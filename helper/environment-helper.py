#!/usr/bin/env python3
"""Socket-activated root broker. Only one fixed ENV file and one fixed service.

No caller-selected paths, commands, process environment or shell evaluation.
The web process retains NoNewPrivileges and never receives root-owned secrets.
"""
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import unicodedata

ENV = Path('/etc/ssh-mcp-approval-bridge.env')
ROOT = Path('/var/lib/ssh-approval-env')
SERVICE = 'ssh-approval-bridge.service'
HELPER = '/usr/local/libexec/ssh-approval-environment-helper'
LIMIT = 65536
# Bootstrap identity, ports, SSH profiles and filesystem paths remain terminal-only.
# They can invalidate the recovery channel itself and are never returned as values.
FIELDS = {
    'BRIDGE_DISPLAY_NAME': ('중계기 표시 이름', 'text'),
    'BRIDGE_TARGET_DISPLAY_NAME': ('대상 서버 표시 이름', 'text'),
    'BRIDGE_UI_ENABLED': ('파일 전송·승인 카드 활성화', 'boolean'),
    'BRIDGE_UI_TOOL_PREFIX': ('카드 도구 접두사', 'text'),
    'BRIDGE_UPLOAD_SOURCE_HOSTS': ('업로드 허용 도메인', 'text'),
    'BRIDGE_TRANSFER_MAX_BYTES': ('파일당 최대 바이트', 'number'),
    'BRIDGE_TRANSFER_BUDGET_BYTES': ('전송 보관 총 바이트', 'number'),
    'BRIDGE_COMMAND_AUTOMATION': ('명령 자동승인 설정 활성화', 'boolean'),
    'BRIDGE_JEV_ENABLED': ('Jev 평가 사용', 'boolean'),
    'BRIDGE_JEV_MAX_CALLS': ('Jev 호출 한도', 'number'),
    'BRIDGE_JEV_KEY_REF': ('Jev 키의 시크릿 참조', 'text'),
    'JEV_API_KEY': ('Jev API 키', 'secret'),
}


class Refused(Exception):
    def __init__(self, code):
        self.code = code


def read_private(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > LIMIT:
            raise Refused('unsafe-file')
        with os.fdopen(fd, 'rb', closefd=False) as source:
            data = source.read(LIMIT + 1)
        if len(data) > LIMIT:
            raise Refused('too-large')
        return data
    finally:
        os.close(fd)


def atomic(path, data):
    fd, temporary = tempfile.mkstemp(prefix='.env-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as dest:
            os.fchmod(dest.fileno(), 0o600)
            dest.write(data)
            dest.flush()
            os.fsync(dest.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def entries(data):
    values = {}
    for line in data.decode('utf-8').split('\n'):
        line = line.removesuffix('\r')
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r'([A-Z_][A-Z0-9_]*)=(.*)', line)
        if not match or match[1] in values:
            raise Refused('unsupported-env')
        value = match[2].strip()
        if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
            value = value[1:-1]
        values[match[1]] = value
    return values


def patch_env(data, changes):
    if not isinstance(changes, dict) or not changes or any(key not in FIELDS for key in changes):
        raise Refused('invalid-fields')
    for key, value in changes.items():
        # Use the common plain ENV subset understood by systemd and our parsers.
        if value is not None and (not isinstance(value, str) or len(value.encode('utf-8')) > 8192 or value != value.strip() or any(c in value for c in '\r\n\0\\\"\'') or any(unicodedata.category(c) in ('Cc', 'Cf', 'Zl', 'Zp') for c in value)):
            raise Refused('invalid-value')
        if FIELDS[key][1] == 'boolean' and value not in ('true', 'false', None):
            raise Refused('invalid-value')
    entries(data)
    text = data.decode('utf-8')
    nl = '\r\n' if '\r\n' in text else '\n'
    result = '\n'.join(line for line in text.split('\n') if line.split('=', 1)[0] not in changes)
    if result and not result.endswith('\n'):
        result += nl
    result += ''.join(key + '=' + value + nl for key, value in changes.items() if value is not None)
    encoded = result.encode('utf-8')
    if len(encoded) > LIMIT:
        raise Refused('too-large')
    return encoded


def clean_run(args, timeout=40, **kwargs):
    return subprocess.run(args, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, stdin=subprocess.DEVNULL,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout, check=True, **kwargs)


def validate(data):
    # The active release is root-owned, fixed by the native installer.
    result = subprocess.run(['/opt/ssh-approval/node/bin/node', '/var/lib/ssh-mcp/app/approval-bridge/scripts/validate-environment.mjs'],
                            input=data, env={'PATH': '/usr/bin:/bin'}, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, timeout=8, check=False)
    if result.returncode:
        raise Refused('validation-failed')


class Editor:
    def __init__(self, env=ENV, root=ROOT, validator=validate, scheduler=None, release=None):
        self.env, self.root, self.validate = env, root, validator
        self.scheduler = scheduler or self.schedule
        self.release = release or self.release_maintenance

    def initialize(self):
        self.root.mkdir(mode=0o700, exist_ok=True)
        info = self.root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise Refused('unsafe-state')

    def revision(self, data):
        # Opaque, keyed revision: no public digest of low-entropy secret values.
        return hmac.new(read_private(self.root / 'key'), data, hashlib.sha256).hexdigest()

    def state(self):
        try:
            return json.loads(read_private(self.root / 'state.json'))
        except FileNotFoundError:
            return {'state': 'idle'}

    def record(self, value):
        atomic(self.root / 'state.json', json.dumps(value).encode())

    def snapshot(self, data, state):
        values = entries(data)
        return {'available': True, 'revision': self.revision(data), 'restart': state,
                'pendingRestart': (self.root / 'pending.env').exists(),
                'fields': [{'key': key, 'label': label, 'type': kind, 'configured': bool(values.get(key)),
                            **({} if kind == 'secret' else {'value': values.get(key, '')})} for key, (label, kind) in FIELDS.items()],
                'readOnlyKeys': sorted(set(values) - set(FIELDS))}

    def dispatch(self, request):
        if not isinstance(request, dict) or request.get('action') not in ('read', 'save', 'restart'):
            raise Refused('invalid-request')
        self.initialize()
        # All socket workers share this lock, including the delayed restart job.
        fd = os.open(self.root / 'lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | (fcntl.LOCK_NB if request['action'] == 'read' else 0))
            except BlockingIOError:
                # Status reads must not delay shutdown while the restart worker
                # holds the mutation lock. Files are private and atomically replaced.
                return self.snapshot(read_private(self.env), self.state())
            if not (self.root / 'key').exists():
                atomic(self.root / 'key', secrets.token_bytes(32))
            data = read_private(self.env)
            state = self.state()
            if request['action'] == 'read':
                return self.snapshot(data, state)
            if state['state'] in ('scheduled', 'restarting'):
                raise Refused('restart-in-progress')
            if request.get('expectedRevision') != self.revision(data):
                raise Refused('conflict')
            if request.get('acknowledged') is not True:
                raise Refused('confirmation-required')
            if (self.root / 'pending.env').exists() and state.get('savedRevision') != self.revision(data):
                raise Refused('conflict')
            if request['action'] == 'save':
                proposed = patch_env(data, request.get('changes'))
                self.validate(proposed)
                if read_private(self.env) != data:
                    raise Refused('conflict')
                # Preserve the earliest pre-change configuration until a healthy restart.
                if not (self.root / 'pending.env').exists():
                    atomic(self.root / 'pending.env', data)
                backup = 'backup-' + secrets.token_hex(12) + '.env'
                atomic(self.root / backup, data)
                atomic(self.env, proposed)
                state = {'state': 'idle', 'savedRevision': self.revision(proposed)}
                self.record(state)
                return self.snapshot(proposed, state) | {'saved': True, 'backupId': backup}
            owner = request.get('maintenanceOwner')
            if not isinstance(owner, str) or not re.fullmatch(r'[a-f0-9]{64}', owner):
                raise Refused('maintenance-owner-required')
            job = secrets.token_hex(16)
            # The credential is never included in status, logs, or process arguments.
            atomic(self.root / ('owner-' + job), owner.encode('ascii'))
            state = {'state': 'scheduled', 'id': job, 'revision': self.revision(data)}
            self.record(state)
            try:
                self.scheduler(job)
            except Exception:
                self.record({'state': 'schedule-failed', 'id': job})
                raise Refused('schedule-failed') from None
            return {'accepted': True, 'restart': state}

    def schedule(self, job):
        clean_run(['/usr/bin/systemd-run', '--quiet', '--on-active=3s', '--collect', '--unit=ssh-approval-env-restart-' + job,
                   '/usr/bin/python3', '-I', HELPER, '--restart', job])

    @staticmethod
    def release_maintenance(owner):
        subprocess.run(['/opt/ssh-approval/node/bin/node', '/var/lib/ssh-mcp/app/approval-bridge/scripts/maintenance.mjs', 'release'],
                       input=owner, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'},
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, check=True)

    def restart(self, job, restart=None, healthy=None):
        restart = restart or (lambda: clean_run(['/usr/bin/systemctl', 'restart', SERVICE], timeout=200))
        healthy = healthy or self.healthy
        self.initialize()
        fd = os.open(self.root / 'lock', os.O_RDWR | os.O_NOFOLLOW)
        with os.fdopen(fd, 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            state = self.state()
            data = read_private(self.env)
            if state.get('id') != job or state['state'] != 'scheduled':
                raise Refused('stale-restart')
            owner_path = self.root / ('owner-' + job)
            owner = read_private(owner_path)
            if not re.fullmatch(rb'[a-f0-9]{64}', owner):
                raise Refused('invalid-maintenance-owner')
            if state.get('revision') != self.revision(data):
                self.record({'state': 'conflict', 'id': job})
                return
            self.record({'state': 'restarting', 'id': job})
            try:
                restart()
                if not healthy(data):
                    raise Refused('health-failed')
                state = {'state': 'healthy', 'id': job}
            except Exception:
                state = {'state': 'failed', 'id': job}
                if (self.root / 'pending.env').exists():
                    try:
                        backup = read_private(self.root / 'pending.env')
                        # Never replace an independently edited ENV during recovery.
                        if self.revision(read_private(self.env)) != self.revision(data):
                            raise Refused('conflict')
                        atomic(self.env, backup)
                        restart()
                        state['state'] = 'rolled-back' if healthy(backup) else 'recovery-failed'
                    except Exception:
                        state['state'] = 'recovery-failed'
            if state['state'] in ('healthy', 'rolled-back'):
                try:
                    self.release(owner)
                except Exception:
                    state['state'] = 'maintenance-release-unconfirmed'
                else:
                    owner_path.unlink()
            if state['state'] in ('healthy', 'rolled-back') and (self.root / 'pending.env').exists():
                # Backup archive remains; only the pending marker is cleared.
                os.unlink(self.root / 'pending.env')
            self.record(state)

    @staticmethod
    def healthy(data):
        port = entries(data).get('BRIDGE_MCP_PORT', '39124')
        if not re.fullmatch(r'[0-9]{1,5}', port) or not 1 <= int(port) <= 65535:
            return False
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(20):
            try:
                with opener.open('http://127.0.0.1:' + port + '/health', timeout=1) as response:
                    result = json.loads(response.read(4096))
                if result.get('healthy') is True:
                    clean_run(['/usr/bin/systemctl', 'is-active', '--quiet', SERVICE])
                    return True
            except Exception:
                pass
            time.sleep(1)
        return False


def main():
    if os.geteuid() != 0:
        raise Refused('root-required')
    if len(sys.argv) == 3 and sys.argv[1] == '--restart' and re.fullmatch(r'[a-f0-9]{32}', sys.argv[2]):
        Editor().restart(sys.argv[2])
        return
    if len(sys.argv) != 1:
        raise Refused('invalid-request')
    connection = socket.socket(fileno=os.dup(0))
    connection.settimeout(12)
    _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
    if uid != pwd.getpwnam('mcpbridge').pw_uid:
        raise Refused('forbidden')
    body = bytearray()
    while b'\n' not in body:
        chunk = connection.recv(4096)
        if not chunk or len(body) + len(chunk) > LIMIT:
            raise Refused('invalid-request')
        body.extend(chunk)
    if body.count(b'\n') != 1 or not body.endswith(b'\n'):
        raise Refused('invalid-request')
    try:
        result = Editor().dispatch(json.loads(body))
    except Refused as error:
        result = {'error': error.code}
    except Exception:
        result = {'error': 'unavailable'}
    connection.sendall(json.dumps(result, ensure_ascii=False).encode() + b'\n')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # No request values, exception strings or secret-derived diagnostics.
        sys.exit(1)
