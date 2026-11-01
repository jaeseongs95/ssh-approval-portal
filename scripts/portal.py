#!/usr/bin/env python3
"""Native setup and pinned, independently running deployment jobs."""
import argparse
import json
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit

SOURCE = Path(__file__).resolve().parents[1]
ENV = '/etc/ssh-mcp-approval-bridge.env'
NODE = '/opt/ssh-approval/node/bin/node'


def arguments(argv=None):
    parser = argparse.ArgumentParser(description='SSH Portal 설치·배포·설정·검증')
    commands = parser.add_subparsers(dest='action', required=True)
    for action in ['install', 'connect', 'policy', 'verify', 'status']:
        command = commands.add_parser(action)
        command.add_argument('--dry-run', action='store_true', help='실행 없이 계획만 JSON으로 표시')
        if action in ['install', 'policy']:
            command.add_argument('--admin-origin', required=action == 'policy')
        if action == 'install':
            command.add_argument('--manifest-sha256', required=True, help='별도 확인한 릴리스 manifest SHA256')
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
    deployment = commands.add_parser('deploy', help='고정 계획·독립 실행·상태 조회·명시적 재개')
    actions = deployment.add_subparsers(dest='deployment_action', required=True)
    prepare = actions.add_parser('plan')
    prepare.add_argument('--source', required=True, help='검증할 root 소유 릴리스 디렉터리')
    prepare.add_argument('--manifest-sha256', required=True)
    prepare.add_argument('--import-legacy', action='store_true', help='기존 1.7.0 설치의 명시적 데이터 이전')
    apply = actions.add_parser('apply')
    apply.add_argument('--plan', required=True, help='plan이 저장한 고정 계획 파일')
    for name in ('status', 'resume'):
        item = actions.add_parser(name)
        item.add_argument('--job-id', required=True)
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
    if action == 'install':
        pin = options.manifest_sha256
        if len(pin) != 64 or any(c not in '0123456789abcdef' for c in pin):
            raise ValueError('릴리스 manifest SHA256이 필요합니다.')
        argv = script('install.sh', '--manifest-sha256', pin)
        if origin:
            argv += ['--admin-origin', origin]
        if getattr(options, 'grant_sudo_all', False):
            argv += ['--grant-sudo-all']
        # Installation only accepts a job. Health is the worker's final stage;
        # verifying here would race the independently running service transition.
        steps = [step(action, argv)]
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
    return {'action': action, 'steps': steps, 'policyUrl': origin + '/settings' if action == 'policy' else None,
            'settingsPreserved': action in ['verify', 'status'],
            'interactive': action == 'connect' and options.component != 'env-editor',
            'sudoGrantRequested': bool(getattr(options, 'grant_sudo_all', False))}


def execute(work, runner=subprocess.run):
    for item in work['steps']:
        try:
            runner(item['argv'], check=True)
        except subprocess.CalledProcessError as error:
            # An uncertain side effect must be inspected, never resubmitted here.
            return {'status': 'FAILED', 'step': item['name'], 'exitCode': error.returncode}
    return {'status': 'ACCEPTED' if work['action'] == 'install' else 'PASS', 'action': work['action']}


def deployment_command(options):
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ValueError('배포는 Ubuntu 관리자 터미널에서 sudo로 실행하세요.')
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('ssh_portal_deployment_entry', SOURCE / 'scripts/deployment_entry.py')
    entry = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(entry)
    action = options.deployment_action
    if action == 'plan':
        engine = entry.install_executor(Path(options.source), options.manifest_sha256)
        work = engine.create_plan(Path(options.source), manifest_sha256=options.manifest_sha256,
                                  import_legacy=options.import_legacy)
        plans = engine.STATE_ROOT / 'plans'
        if not plans.exists():
            plans.mkdir(mode=0o700)
            engine.sync_directory(plans.parent)
        engine.trusted_directory(plans)
        path = plans / (work['jobId'] + '.json')
        if os.path.lexists(path):
            raise ValueError('동일 작업의 계획이 이미 있습니다. 원래 파일을 확인하세요.')
        engine.atomic_json(path, work)
        return {'state': 'PLANNED', 'jobId': work['jobId'], 'planPath': str(path),
                'planSha256': work['planSha256'], 'targetVersion': work['targetVersion'],
                'readinessErrors': work['readinessErrors'], 'serviceChanged': False}
    if action == 'apply':
        path = Path(options.plan)
        if not path.is_absolute() or path.parent != Path('/var/lib/ssh-mcp/deployments/plans'):
            raise ValueError('plan이 저장한 고정 계획 경로를 지정하세요.')
        value = json.loads(entry.read_file(path, 8 * 1024 * 1024))
        if path.name != value.get('jobId', '') + '.json':
            raise ValueError('계획 파일 이름과 작업 번호가 다릅니다.')
        engine = entry.executor_for_plan(value)
        return engine.apply_plan(value)
    engine = entry.executor_for_job(options.job_id)
    return engine.status(options.job_id) if action == 'status' else engine.resume(options.job_id)


def main(argv=None):
    options = arguments(argv)
    if options.action == 'deploy':
        try:
            result = deployment_command(options)
        except (ValueError, OSError, RuntimeError) as error:
            print(json.dumps({'state': 'REFUSED', 'errorCode': getattr(error, 'code', type(error).__name__),
                              'message': '요청을 실행하지 못했습니다. 원래 작업 상태와 고정 계획을 확인하세요.'}, ensure_ascii=False))
            return 1
        print(json.dumps(result, ensure_ascii=False))
        return 1 if result.get('state') in ('NEEDS_REVIEW', 'FAILED') else 0
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
    return 0 if result['status'] in ('PASS', 'ACCEPTED') else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError):
        print('실행할 수 없습니다. 인자·지원 환경·설치 파일을 확인하세요.', file=sys.stderr)
        sys.exit(1)
