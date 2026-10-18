#!/usr/bin/env python3
"""One native lifecycle entry point; existing scripts retain all mutation authority."""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
from urllib.parse import urlsplit

SOURCE = Path(__file__).resolve().parents[1]
ENV = '/etc/ssh-mcp-approval-bridge.env'
NODE = '/opt/ssh-approval/node/bin/node'


def arguments(argv=None):
    parser = argparse.ArgumentParser(description='SSH Portal 설치·설정·검증·복구')
    commands = parser.add_subparsers(dest='action', required=True)
    for action in ['install', 'update', 'connect', 'policy', 'verify', 'status', 'rollback']:
        command = commands.add_parser(action)
        command.add_argument('--dry-run', action='store_true', help='실행 없이 계획만 JSON으로 표시')
        if action in ['install', 'policy']:
            command.add_argument('--admin-origin', required=action == 'policy')
        if action == 'install':
            command.add_argument('--grant-sudo-all', action='store_true', help='mcpops NOPASSWD ALL 명시적 선택')
        if action == 'connect':
            command.add_argument('component', choices=['access', 'upload-sources', 'env-editor'])
        if action == 'rollback':
            command.add_argument('backup')
    return parser.parse_args(argv)


def plan(options, source=SOURCE):
    action = options.action
    origin = getattr(options, 'admin_origin', None)
    if origin is not None:
        # Only a shape check here: install's existing WHATWG validator remains authoritative.
        parsed = urlsplit(origin)
        parsed.port  # urlsplit validates the port only when accessed.
        if (any(ord(c) < 33 for c in origin) or parsed.scheme != 'https' or not parsed.hostname
                or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
            raise ValueError('관리자 origin은 경로·자격정보 없는 HTTPS 주소여야 합니다.')
    script = lambda name, *args: ['bash', str(source / 'scripts' / name), *args]
    step = lambda name, argv: {'name': name, 'argv': argv}
    verify = [step('package', [NODE, str(source / 'scripts/verify.mjs'), str(source)]),
              step('health', [NODE, str(source / 'scripts/healthcheck.mjs'), ENV])]
    steps = []
    if action in ['install', 'update']:
        argv = script('install.sh')
        if origin:
            argv += ['--admin-origin', origin]
        if getattr(options, 'grant_sudo_all', False):
            argv += ['--grant-sudo-all']
        steps = [step(action, argv), *verify]
    elif action == 'connect':
        name = {'access': 'configure-admin-access.sh', 'upload-sources': 'configure-upload-sources.sh',
                'env-editor': 'configure-env-editor.sh'}[options.component]
        steps = [step(options.component, script(name)), *verify]
    elif action == 'verify':
        steps = verify
    elif action == 'status':
        steps = [step('status', script('status.sh'))]
    elif action == 'rollback':
        backup = PurePosixPath(options.backup)
        base = PurePosixPath('/var/lib/ssh-mcp/app/backups')
        if not backup.is_absolute() or backup.parent != base or '..' in backup.parts:
            raise ValueError('관리되는 backups 바로 아래의 백업 경로를 지정하세요.')
        # Verify the restored service, not this potentially newer source package.
        steps = [step('rollback', script('rollback.sh', str(backup))), verify[1]]
    return {'action': action, 'steps': steps, 'policyUrl': origin + '/settings' if action == 'policy' else None,
            'settingsPreserved': action in ['update', 'verify', 'status'],
            'interactive': action == 'connect' and options.component != 'env-editor',
            'sudoGrantRequested': bool(getattr(options, 'grant_sudo_all', False))}


def execute(work, runner=subprocess.run):
    for item in work['steps']:
        try:
            runner(item['argv'], check=True)
        except subprocess.CalledProcessError as error:
            # Never retry a mutation: install/rollback/configure scripts own recovery.
            return {'status': 'FAILED', 'step': item['name'], 'exitCode': error.returncode}
    return {'status': 'PASS', 'action': work['action']}


def main(argv=None):
    options = arguments(argv)
    work = plan(options)
    if options.dry_run:
        print(json.dumps({'status': 'DRY_RUN', **work}, ensure_ascii=False, indent=2))
        return 0
    if options.action == 'policy':
        print(json.dumps({'status': 'ACTION_REQUIRED', 'url': work['policyUrl'],
                          'message': '관리자 설정에서 대상·명령·sudo·전송·모델 정책을 검토하고 저장하세요. CLI는 정책을 켜거나 승인하지 않습니다.'}, ensure_ascii=False))
        return 3
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ValueError('실행은 Ubuntu 관리자 터미널에서 sudo로 진행하세요. 계획 조회에는 --dry-run을 사용하세요.')
    result = execute(work)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError):
        print('실행할 수 없습니다. 인자·지원 환경·설치 파일을 확인하세요.', file=sys.stderr)
        sys.exit(1)
