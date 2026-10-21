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
            command.add_argument('component', choices=['access', 'oidc', 'upload-sources', 'env-editor', 'cloudflare'])
            command.add_argument('--config', help='Cloudflare 공개 연결 설정 JSON (비밀 제외)')
            mode = command.add_mutually_exclusive_group()
            mode.add_argument('--apply', action='store_true', help='새 Cloudflare 자원 생성')
            mode.add_argument('--cleanup', action='store_true', help='이 실행이 생성한 Cloudflare 자원 정리')
            mode.add_argument('--connector', action='store_true', help='이번 터널 전용 connector 서비스 설치')
            mode.add_argument('--remove-connector', action='store_true', help='이번 connector 서비스만 제거')
            mode.add_argument('--link-environment', action='store_true', help='이번 관리자 Access 앱을 ENV에 연결')
            mode.add_argument('--restore-environment', action='store_true', help='이번 ENV 연결 전 인증 설정 복원')
            mode.add_argument('--sync-server', action='store_true', help='연결된 이번 MCP 서버의 기능 목록 동기화')
            command.add_argument('--state-dir', help='Cloudflare 실행 기록 폴더 (Linux 전용)')
            binary = command.add_mutually_exclusive_group()
            binary.add_argument('--cloudflared', help='설치된 root 소유 cloudflared 절대 경로')
            binary.add_argument('--install-cloudflared', action='store_true', help='공식 cloudflared를 전용 경로에 검증·설치')
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
        if options.component == 'cloudflare':
            argv = [sys.executable, str(source / 'scripts/cloudflare_setup.py')]
            if options.config:
                argv += ['--config', options.config]
            argv += [*(['--apply'] if options.apply else []), *(['--cleanup'] if options.cleanup else [])]
            argv += [*(['--connector'] if options.connector else []), *(['--remove-connector'] if options.remove_connector else [])]
            argv += [*(['--link-environment'] if options.link_environment else []), *(['--restore-environment'] if options.restore_environment else [])]
            argv += ['--sync-server'] if options.sync_server else []
            if options.state_dir:
                argv += ['--state-dir', options.state_dir]
            if options.cloudflared:
                argv += ['--cloudflared', options.cloudflared]
            if options.install_cloudflared:
                argv += ['--install-cloudflared']
            mutating = bool(options.apply or options.cleanup or options.connector or options.remove_connector or options.link_environment or options.restore_environment or options.sync_server)
            return {'action': action, 'steps': [step('cloudflare-change' if mutating else 'cloudflare-read-only', argv)],
                    'externalMutation': mutating and not options.dry_run, 'interactive': True}
        if options.config or options.apply or options.cleanup or options.state_dir or options.connector or options.remove_connector or options.cloudflared or options.install_cloudflared or options.link_environment or options.restore_environment or options.sync_server:
            raise ValueError('--config는 Cloudflare 연결에서만 사용할 수 있습니다.')
        name = {'access': 'configure-admin-access.sh', 'oidc': 'configure-admin-access.sh', 'upload-sources': 'configure-upload-sources.sh',
                'env-editor': 'configure-env-editor.sh'}[options.component]
        steps = [step(options.component, script(name, *(['--oidc'] if options.component == 'oidc' else []))), *verify]
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
    if options.action == 'connect' and options.component == 'cloudflare':
        # A read-only dry run must not populate scripts/__pycache__ on a new install.
        sys.dont_write_bytecode = True
        from cloudflare_setup import main as cloudflare_main
        args = ['--config', options.config] if options.config else []
        args += [*(['--apply'] if options.apply else []), *(['--cleanup'] if options.cleanup else [])]
        args += [*(['--connector'] if options.connector else []), *(['--remove-connector'] if options.remove_connector else [])]
        args += [*(['--link-environment'] if options.link_environment else []), *(['--restore-environment'] if options.restore_environment else [])]
        args += ['--sync-server'] if options.sync_server else []
        if options.state_dir:
            args += ['--state-dir', options.state_dir]
        if options.cloudflared:
            args += ['--cloudflared', options.cloudflared]
        if options.install_cloudflared:
            args += ['--install-cloudflared']
        return cloudflare_main([*args, *(['--dry-run'] if options.dry_run else [])])
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
