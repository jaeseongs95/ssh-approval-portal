#!/usr/bin/env python3
"""실제 systemd·HTTP·SQLite 경계를 검사한다. 로컬 제품 시험으로 실행 금지.

CS9/OB-ACK-COMPLETION: 접수와 완료 구분, 중계기 재시작 후 독립 worker 완료,
새 InvocationID·generation·보존·maintenance 해제·같은 작업 재개를 대조한다.
OB-MIGRATION/OB-RESUME/OB-UNIT-INSTALL의 정상 통합 경계도 포함한다.
고장 주입 전체 조합은 별도 engine/migration 시험의 책임이며 여기서는 주장하지 않는다.
"""
import argparse
from contextlib import closing
import hashlib
import io
import json
import os
from pathlib import Path
import pwd
import shutil
import sqlite3
import subprocess
import tarfile
import time
import urllib.request

BASE = Path('/var/lib/ssh-mcp')
STATE = BASE / 'deployments'
ENV = Path('/etc/ssh-mcp-approval-bridge.env')
UNIT = Path('/etc/systemd/system/ssh-approval-bridge.service')
SERVICE = 'ssh-approval-bridge.service'
NODE = '/opt/ssh-approval/node/bin/node'
LEGACY_ARCHIVE = '780fbc485bce4eea6358026ac57847e02ab80eef0b2a5b35fcc832c0e18e6471'
LEGACY_MANIFEST = 'ec752d6873473a5500a447cbefc2ed577ac39b2dfd8b2c88ee562739e5d3ae59'
STAGES = ('prepare', 'reserve', 'stop', 'migrate', 'baseline', 'launcher', 'helper',
          'bootstrap', 'reload', 'promote', 'start', 'compare', 'release', 'final')


class CheckFailure(Exception):
    pass


def require(value, code):
    if not value:
        raise CheckFailure(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class Fixture:
    def __init__(self, options):
        self.options = options
        self.results = options.results
        self.report = {'state': 'RUNNING', 'candidate': options.candidate,
                       'mode': options.mode, 'checks': [], 'jobs': []}
        self.step = '진입'
        self.work = Path('/opt/ssh-approval-ci')
        self.source = self.work / 'candidate'

    def write(self, name, value):
        path = self.results / name
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        path.chmod(0o644)

    def check(self, condition, name):
        require(condition, name)
        self.report['checks'].append(name)
        self.write('result.json', self.report)

    def command(self, name, argv, *, stdin=None, timeout=900, check=True):
        self.step = name
        result = subprocess.run([str(x) for x in argv], input=stdin, capture_output=True,
                                timeout=timeout, env=os.environ | {'PYTHONDONTWRITEBYTECODE': '1'})
        # stdout/stderr와 ENV·DB·키·payload는 공개 artifact에 복사하지 않는다.
        with (self.results / 'commands.jsonl').open('a', encoding='utf-8') as stream:
            stream.write(json.dumps({'name': name, 'exitCode': result.returncode,
                                     'candidate': self.options.candidate}, ensure_ascii=False) + '\n')
        if check:
            require(result.returncode == 0, name + '_COMMAND_FAILED')
        return result

    def cli(self, *args):
        result = self.command('deploy-' + args[0], ['/usr/bin/python3', '-I', '-B',
                              self.source / 'scripts/portal.py', 'deploy', *args], check=False)
        try:
            value = json.loads(result.stdout)
        except (ValueError, UnicodeError):
            raise CheckFailure('CLI_JSON_INVALID') from None
        require(isinstance(value, dict), 'CLI_RESULT_INVALID')
        if result.returncode:
            # 안정된 오류 코드만 보관하고 원래 body/message는 출력하지 않는다.
            self.report['lastErrorCode'] = value.get('errorCode', value.get('phase', 'UNCONFIRMED'))
            raise CheckFailure('CLI_' + args[0] + '_FAILED')
        return value

    def service(self):
        result = self.command('systemd-instance', ['systemctl', 'show', SERVICE,
                              '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'InvocationID'])
        return dict(line.split('=', 1) for line in result.stdout.decode().splitlines() if '=' in line)

    def health(self, version):
        for _ in range(60):
            try:
                with urllib.request.urlopen('http://127.0.0.1:8787/health', timeout=2) as response:
                    value = json.load(response)
                if value.get('healthy') is True and value.get('version') == version and value.get('maintenance') is False:
                    return value
            except (OSError, ValueError):
                pass
            time.sleep(1)
        raise CheckFailure('HTTP_HEALTH_NOT_CONFIRMED')

    def wait(self, job):
        for _ in range(600):
            value = self.cli('status', '--job-id', job)
            if value['state'] == 'PASS':
                self.check(value.get('jobId') == job and value.get('databaseRestored') is False
                           and value.get('automaticReplay') is False, '작업_완료_안전표식_' + job)
                self.check(all(value.get('stages', {}).get(stage, {}).get('state') == 'done' for stage in STAGES),
                           '전체_단계_완료_' + job)
                self.report['jobs'].append(job)
                return value
            if value['state'] in ('NEEDS_REVIEW', 'FAILED', 'REFUSED'):
                self.report['lastErrorCode'] = value.get('errorCode')
                self.report['lastPhase'] = value.get('phase')
                raise CheckFailure('WORKER_' + value['state'])
            time.sleep(1)
        raise CheckFailure('WORKER_TIMEOUT')

    def active(self):
        return json.loads((STATE / 'active.json').read_text(encoding='utf-8'))

    def package(self):
        require(not self.work.exists(), 'FIXTURE_WORK_ALREADY_EXISTS')
        self.work.mkdir(mode=0o755)
        # 프로젝트의 패키징 명령을 사용하고 checkout의 생성물은 바꾸지 않는다.
        shutil.copytree(self.options.source, self.source,
                        ignore=shutil.ignore_patterns('.git', 'node_modules', '__pycache__', 'dist'))
        # 빌드 산출물 ui/dist·web/dist는 명시적인 패키지 입력이다.
        for name in ('ui/dist', 'web/dist'):
            source = self.options.source / name
            if source.is_dir():
                shutil.copytree(source, self.source / name, dirs_exist_ok=True)
        for path in [self.work, *self.source.rglob('*')]:
            if not path.is_symlink():
                path.chmod(0o755 if path.is_dir() else 0o644)
        self.command('package-candidate', ['/usr/bin/python3', '-I', '-B', self.source / 'scripts/package.py'])
        self.pin = sha((self.source / 'release-manifest.json').read_bytes())
        self.version = json.loads((self.source / 'package.json').read_text())['version']
        self.report['manifestSha256'] = self.pin

    def install(self):
        if self.options.mode == 'fresh':
            value = self.command('install-fresh', ['bash', self.source / 'scripts/install.sh',
                                 '--manifest-sha256', self.pin, '--admin-origin', 'https://ci.example.invalid'])
            records = []
            for line in value.stdout.decode().splitlines():
                try:
                    records.append(json.loads(line))
                except ValueError:
                    pass
            accepted = next((v for v in reversed(records) if isinstance(v, dict) and 'jobId' in v), None)
            require(accepted is not None, 'INSTALL_JOB_ACK_MISSING')
            self.report['installAcknowledgement'] = accepted['state']
            self.wait(accepted['jobId'])
            self.health(self.version)
            return self.active()
        url = ('https://github.com/jaeseongs95/ssh-approval-portal/releases/download/'
               'v1.7.0/ssh-approval-portal-1.7.0.tar.gz')
        with urllib.request.urlopen(url, timeout=90) as response:
            raw = response.read(64 * 1024 * 1024 + 1)
        self.check(sha(raw) == LEGACY_ARCHIVE, '실제_170_압축파일_외부지문')
        with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
            # 외부 asset은 핀 대조 후에도 경로·링크를 제한한다.
            for member in archive.getmembers():
                path = Path(member.name)
                require(not path.is_absolute() and '..' not in path.parts
                        and path.parts[0] == 'ssh-approval-portal-1.7.0'
                        and (member.isfile() or member.isdir()), 'LEGACY_ARCHIVE_UNSAFE')
            archive.extractall(self.work, filter='data')
        legacy = self.work / 'ssh-approval-portal-1.7.0'
        self.check(sha((legacy / 'release-manifest.json').read_bytes()) == LEGACY_MANIFEST,
                   '실제_170_명세서_외부지문')
        self.command('install-legacy-1.7.0', ['bash', legacy / 'scripts/install.sh',
                     '--admin-origin', 'https://ci.example.invalid'])
        self.health('1.7.0')
        self.report['legacyArchiveSha256'] = LEGACY_ARCHIVE
        return {'generation': 'legacy-1.7.0', 'release': str((BASE / 'app/approval-bridge').resolve()),
                'dataRoot': str(BASE / 'transfers')}

    def protected(self):
        roots = [ENV, BASE / '.config', BASE / '.ssh',
                 Path(pwd.getpwnam('mcpops').pw_dir) / '.ssh']
        result = {}
        for root in roots:
            for path in [root, *(sorted(root.rglob('*')) if root.is_dir() else [])]:
                st = path.lstat()
                require(not path.is_symlink(), 'PROTECTED_LINK')
                result[str(path)] = [st.st_uid, st.st_gid, st.st_mode,
                                     sha(path.read_bytes()) if path.is_file() else None]
        return result

    def seed(self, old):
        self.command('stop-for-fixture', ['systemctl', 'stop', SERVICE])
        root = Path(old['dataRoot'])
        # 서비스 자체 storage adapter로 실제 SQLite·출력 파일을 생성한다.
        code = r'''
import {pathToFileURL} from 'node:url';
const [release, root] = process.argv.slice(2);
const load = name => import(pathToFileURL(release + '/src/adapters/storage/' + name + '.mjs'));
const {createCommandState} = await load('command-state');
const {createAgentCliState} = await load('agent-cli-state');
const {CommandOutputs} = await load('command-output');
const command = createCommandState(root), cli = createAgentCliState(root);
const outputs = new CommandOutputs(root, {ttl:86400000});
try {
 const now=Date.now(), id='a'.repeat(48), cliId='b'.repeat(48);
 const operation={kind:'command',command:'printf fixture'};
 const job={id,kind:'command',operation,command:operation.command,profile:'fixture-write',targetId:'fixture',
   targetRevision:'1'.repeat(64),state:'completed',createdAt:now-1000,finishedAt:now,expiresAt:now+86400000};
 job.result=outputs.finish(outputs.reserve({executionId:id,targetId:'fixture',targetRevision:job.targetRevision,profile:job.profile}),
   {failed:false,texts:['보존 표본🙂\r\n'],data:{fixture:[1,'한글']}});
 command.insert(job,'deployment-fixture-command','c'.repeat(64));
 const policy={targets:[{targetId:'fixture',targetRevision:'1'.repeat(64),profile:'fixture-write',commands:['printf'],deniedCommands:['rm'],
   externalDisclosure:false,modelExecution:false,automaticSudo:false,fallback:null,thresholds:{}}]};
 command.setPolicy(policy,command.policy().revision);
 const cliJob={...job,id:cliId,operation:{...operation,agentCliContract:'agent-cli-install-v1',agentCliProvider:'codex',
   agentCliTargetId:'fixture',agentCliTargetRevision:'1'.repeat(64),agentCliProfile:'fixture-write',agentCliOperationId:'8'.repeat(48)}};
 delete cliJob.result;
 cli.insert(cliJob,'agent-cli:deployment-fixture-0001','d'.repeat(64));
 cli.recordRemote(cliId,{provider:'codex',operationId:'8'.repeat(48),state:'not_found',login:'not_checked'});
} finally {command.close();cli.close();outputs.close();}
'''
        self.command('seed-real-sqlite-and-output', ['sudo', '-n', '-u', 'mcpbridge', '--', NODE,
                     '--input-type=module', '-', old['release'], root], stdin=code.encode())
        # ENV 표본은 값이 노출되지 않는 주석이며 기동 설정 의미를 바꾸지 않는다.
        with ENV.open('ab') as stream:
            stream.write(b'\n# deployment fixture preservation marker\n')
        snapshot = self.data(root)
        self.check(snapshot['counts'] == {'command': 1, 'cli': 1, 'output': 1}, '비어있지_않은_독립_데이터_표본')
        self.command('start-fixture-predecessor', ['systemctl', 'start', SERVICE])
        self.health('1.7.0' if self.options.mode != 'fresh' else self.version)
        return snapshot

    def data(self, root):
        result = {'tables': {}, 'payloads': {}, 'counts': {}}
        for name, tables in [('command-automation.sqlite', ('policy', 'requests')),
                             ('agent-cli.sqlite', ('requests',)), ('command-outputs/manifest.sqlite', ('outputs',))]:
            with closing(sqlite3.connect((root / name).as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
                require(db.execute('PRAGMA integrity_check').fetchone() == ('ok',), 'DATABASE_INTEGRITY')
                for table in tables:
                    rows = db.execute('SELECT * FROM ' + table + ' ORDER BY id').fetchall()
                    result['tables'][name + ':' + table] = rows
                    if table != 'policy':
                        result['counts'][{'command-automation.sqlite':'command','agent-cli.sqlite':'cli',
                                          'command-outputs/manifest.sqlite':'output'}[name]] = len(rows)
        for path in sorted((root / 'command-outputs').glob('*.out')):
            result['payloads'][path.name] = sha(path.read_bytes())
        return result

    def deploy(self, old, snapshot):
        protected = self.protected()
        before = self.service()
        self.check(before['ActiveState'] == 'active' and before['SubState'] == 'running', '실제_선행_프로세스_실행')
        argv = ['plan', '--source', str(self.source), '--manifest-sha256', self.pin]
        if self.options.mode != 'fresh':
            argv += ['--import-legacy']
        plan = self.cli(*argv)
        self.check(plan['state'] == 'PLANNED' and plan['readinessErrors'] == [], '고정_계획_준비')
        self.check(self.service() == before and self.protected() == protected, '계획_서비스와_보호파일_불변')
        accepted = self.cli('apply', '--plan', plan['planPath'])
        self.check(accepted['jobId'] == plan['jobId'], '접수와_동일_작업번호')
        # 호출 프로세스는 이미 종료됐다. worker는 중계기 정지·재기동을 독립 수행한다.
        completed = self.wait(plan['jobId'])
        current = self.active()
        after = self.service()
        self.health(self.version)
        self.check(current['generation'] == plan['jobId'] and current['generation'] != old['generation']
                   and current['release'] != old['release'] and current['dataRoot'] != old['dataRoot'], '새_코드와_데이터_세대_선택')
        self.check(after['MainPID'] != before['MainPID'] and after['InvocationID'] != before['InvocationID']
                   and after['ActiveState'] == 'active', '실제_새_서비스_인스턴스')
        final = completed['stages']['final']['result']
        self.check(final.get('invocation') == after['InvocationID'], '최종_완료와_같은_새_인스턴스')
        self.check(UNIT.read_bytes() == (self.source / 'config/ssh-approval-bridge.service').read_bytes(), '실제_시스템_unit_게시')
        self.check(self.protected() == protected, '정책외_설정_ENV_키_인가목록_보존')
        self.check(Path(old['release']).is_dir() and Path(old['dataRoot']).is_dir(), '선행_코드와_데이터_원본_존치')
        self.check(self.data(Path(old['dataRoot'])) == snapshot, '선행_원본_행과_출력_바이트_불변')
        journal_path = STATE / 'jobs' / plan['jobId'] / 'journal.json'
        journal = journal_path.read_bytes()
        migration = STATE / 'jobs' / plan['jobId'] / 'migration.json'
        migration_before = migration.read_bytes()
        for _ in range(2):
            self.check(self.cli('status', '--job-id', plan['jobId']) == completed, '동일_완료_상태_조회')
            self.check(self.cli('resume', '--job-id', plan['jobId']) == completed, '동일_완료_작업_재개')
        self.check(self.service() == after and journal_path.read_bytes() == journal
                   and migration.read_bytes() == migration_before and self.active() == current,
                   '완료_작업_재개_중복_기동_이전_승격_없음')
        self.command('stop-for-independent-data-oracle', ['systemctl', 'stop', SERVICE])
        actual = self.data(Path(current['dataRoot']))
        self.check(actual == snapshot, '독립_SQLite_행_정책_ID_출력_바이트_보존')
        self.command('restart-after-independent-oracle', ['systemctl', 'start', SERVICE])
        self.health(self.version)
        self.report['instances'] = {'before': before['InvocationID'], 'completed': after['InvocationID']}
        self.report['preservedCounts'] = actual['counts']
        self.report['coverage'] = ['CS9', 'OB-ACK-COMPLETION', 'OB-MIGRATION-normal',
                                   'OB-RESUME-completed-idempotence', 'OB-UNIT-INSTALL-normal']

    def run(self):
        self.check(os.geteuid() == 0 and os.environ.get('GITHUB_ACTIONS') == 'true'
                   and os.environ.get('RUNNER_OS') == 'Linux', '폐기형_GitHub_Linux_VM')
        self.check(Path('/proc/1/comm').read_text().strip() == 'systemd', '실제_systemd_필수')
        self.check(not BASE.exists() and not ENV.exists() and not UNIT.exists(), '깨끗한_설치_호스트')
        self.package()
        old = self.install()
        snapshot = self.seed(old)
        self.deploy(old, snapshot)
        self.report['state'] = 'PASS'
        self.report['limitations'] = ['중간 단계 강제 종료와 재부팅은 이 정상 통합시험의 검증 범위 밖이다.']

    def finish(self):
        # 작업 본문·보존 HMAC·private command 로그·소유 토큰은 절대 공개하지 않는다.
        summaries = []
        if (STATE / 'jobs').is_dir():
            for path in sorted((STATE / 'jobs').glob('*/journal.json')):
                try:
                    value = json.loads(path.read_text())
                    summaries.append({key: value.get(key) for key in
                                      ('jobId', 'planSha256', 'state', 'phase', 'errorCode',
                                       'databaseRestored', 'automaticReplay')}
                                     | {'stages': {stage: item.get('state') for stage, item in value.get('stages', {}).items()}})
                except (ValueError, OSError):
                    summaries.append({'state': 'UNREADABLE'})
        self.write('job-receipts.json', summaries)
        self.write('result.json', self.report)
        print(json.dumps({'state': self.report['state'], 'mode': self.options.mode,
                          'checks': len(self.report['checks']), 'step': self.step}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--results', type=Path, required=True)
    parser.add_argument('--mode', choices=['fresh', 'legacy-1.7.0'], required=True)
    parser.add_argument('--candidate', required=True)
    fixture = Fixture(parser.parse_args())
    try:
        fixture.run()
    except Exception as error:
        fixture.report.update(state='FAILED', step=fixture.step,
                              errorCode=str(error) if isinstance(error, CheckFailure) else type(error).__name__)
    finally:
        fixture.finish()
    return 0 if fixture.report['state'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
