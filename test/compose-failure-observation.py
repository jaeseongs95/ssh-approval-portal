"""실패한 일회성 Compose 시험에서 비밀 없는 정형 표식만 수집한다.

컨테이너 원문 로그·환경·명령 인자·DB 본문은 출력하지 않는다. 이미 알려진 고정
오류 메시지는 열거된 표식으로만 바꾸며 미지 메시지의 내용은 보관하지 않는다.
"""
import argparse
import json
import os
from pathlib import Path
import re
import struct
import subprocess


KNOWN_ERRORS = {
    'State schema requires explicit offline migration': 'SCHEMA_MIGRATION_REQUIRED',
    'Legacy command result requires explicit offline migration': 'LEGACY_OUTPUT_MIGRATION_REQUIRED',
    'Unsupported state schema': 'SCHEMA_UNSUPPORTED',
    'Corrupt state schema': 'SCHEMA_CORRUPT',
    'Unsafe command state': 'COMMAND_STATE_TRUST_REFUSED',
    'Unsafe CLI journal': 'CLI_STATE_TRUST_REFUSED',
    'Unsafe maintenance state': 'MAINTENANCE_STATE_TRUST_REFUSED',
    'Unsafe output manifest': 'OUTPUT_MANIFEST_TRUST_REFUSED',
    'Unsafe output root': 'OUTPUT_ROOT_TRUST_REFUSED',
}
ERROR_TYPES = {'Error', 'TypeError', 'SyntaxError', 'RangeError', 'AssertionError', 'AggregateError'}
DATABASES = ('command-automation.sqlite', 'agent-cli.sqlite', 'maintenance.sqlite', 'command-outputs/manifest.sqlite')


def command(argv):
    try:
        result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
        return result.returncode, result.stdout[:131072].decode('utf-8', errors='replace')
    except (OSError, subprocess.TimeoutExpired):
        return None, ''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', required=True)
    parser.add_argument('--phase', required=True)
    args = parser.parse_args()
    if os.environ.get('GITHUB_ACTIONS') != 'true' or not re.fullmatch(r'ssh-compose-ci-[0-9]+', args.project):
        raise ValueError('Disposable CI project required')
    if not re.fullmatch(r'[a-z0-9-]{1,80}', args.phase):
        raise ValueError('Known fixture phase required')
    result = {'fixture': 'COMPOSE_CI_FAILURE', 'phase': args.phase, 'containers': [],
              'databaseHeaders': {}, 'headersAreNotConsistentSnapshot': True}
    status, ids = command(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + args.project,
                           '--filter', 'label=com.docker.compose.service=bridge'])
    result['containerListExitCode'] = status
    for identifier in ids.splitlines():
        if not re.fullmatch(r'[a-f0-9]{12,64}', identifier):
            continue
        code, state = command(['docker', 'inspect', '--format', '{{json .State}}', identifier])
        item = {'id': identifier, 'inspectExitCode': code}
        try:
            value = json.loads(state)
            # Docker Error와 Health.Log.Output에는 원문이 들어갈 수 있으므로 읽어도 출력하지 않는다.
            item.update({key: value[key] for key in ('Running', 'Restarting', 'OOMKilled', 'Dead', 'ExitCode') if key in value})
            health = value.get('Health', {}).get('Status')
            item['health'] = health if health in ('starting', 'healthy', 'unhealthy') else 'unknown'
        except (ValueError, TypeError):
            item['stateUnavailable'] = True
        # node writes startup exceptions to stderr; combine only inside memory, never expose raw bytes.
        try:
            read = subprocess.run(['docker', 'logs', '--tail', '120', identifier], stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, timeout=10)
            log_code, logs = read.returncode, read.stdout[:131072].decode('utf-8', errors='replace')
        except (OSError, subprocess.TimeoutExpired):
            log_code, logs = None, ''
        item['logReadExitCode'] = log_code
        item['knownErrorMarkers'] = sorted({marker for message, marker in KNOWN_ERRORS.items() if message in logs})
        item['errorTypes'] = sorted(set(re.findall(r'(?:^|\n)([A-Za-z]*Error):', logs)) & ERROR_TYPES)
        item['unknownErrorPresent'] = bool(re.search(r'(?:^|\n)[A-Za-z]*Error:', logs)) and not item['knownErrorMarkers']
        result['containers'].append(item)
    for name in DATABASES:
        path = Path('/var/lib/ssh-mcp/transfers') / name
        header = {'exists': path.exists()}
        if path.is_symlink():
            header['symlinkRefused'] = True
        elif path.is_file():
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, 'rb') as stream:
                    data = stream.read(100)
                header['sqliteHeader'] = data[:16] == b'SQLite format 3\x00'
                if header['sqliteHeader'] and len(data) == 100:
                    header['userVersion'] = struct.unpack('>I', data[60:64])[0]
            except OSError:
                header['readUnavailable'] = True
        result['databaseHeaders'][name] = header
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'fixture': 'COMPOSE_CI_FAILURE', 'observation': 'UNAVAILABLE',
                          'errorType': type(error).__name__}))
