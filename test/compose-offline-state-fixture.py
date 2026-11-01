"""일회성 GitHub Compose fixture의 명시적 이전 경계.

요구: schema 0 구버전 거부 시험 뒤 현재 baseline은 명시 이전된 schema 1을 쓴다.
사례/판별: 정상 정지 뒤 기존 migrator와 verifier를 호출하고 원본 보존·요청 1건·
모든 DB user_version 1을 확인한다. 임의 버전 덧씌우기로 기동 가드를 우회하지 않는다.
수준: 실제 CI 호스트 SQLite·현재 Node 변환기·Compose bind 전환 통합 시험.
로컬 제품 실행은 하지 않으며 이 파일의 로컬 검사는 구문 분석뿐이다.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import time


def files(root):
    return {path.relative_to(root).as_posix():
            (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_uid,
             path.stat().st_gid, stat.S_IMODE(path.stat().st_mode))
            for path in root.rglob('*') if path.is_file()}


def main():
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.geteuid() != 0:
        raise RuntimeError('Disposable GitHub runner root fixture required')
    repo = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(repo / 'scripts'))
    from deployment_migration import inspect_state, migrate_state, verify_migration

    source = Path('/var/lib/ssh-mcp/transfers')
    destination = source.with_name('compose-migrated-state')
    preserved = source.with_name('compose-legacy-state-preserved')
    if destination.exists() or destination.is_symlink() or preserved.exists() or preserved.is_symlink():
        raise RuntimeError('Fixture migration destinations must be absent')
    before = inspect_state(source, uid=10001)
    before_files = files(source)
    assert before['databases']['command-automation.sqlite']['rows']['requests'] == 1
    node = Path(shutil.which('node') or '').resolve(strict=True)
    os.environ['SSH_PORTAL_MIGRATION_NODE'] = str(node)
    receipt = migrate_state(source, destination, uid=10001, gid=10001, now_ms=int(time.time() * 1000))
    verified = verify_migration(source, destination, receipt)
    assert verified['status'] == 'VERIFIED' and verified['newLosses'] == 0
    assert inspect_state(source, uid=10001) == before
    after = inspect_state(destination, uid=10001)
    after_files = files(destination)
    assert after['databases']['command-automation.sqlite']['rows']['requests'] == 1
    assert all(db['userVersion'] == 1 for db in after['databases'].values())
    # 일회성 fixture의 기존 원본을 보존한 채 검증된 새 세대만 bind 경로로 선택한다.
    source.rename(preserved)
    destination.rename(source)
    # rename는 디렉터리 ctime을 바꾸므로 경로 이전 뒤 fingerprint 동일성을 요구하지 않는다.
    assert files(source) == after_files
    assert files(preserved) == before_files
    assert inspect_state(source, uid=10001)['databases'] == after['databases']
    assert inspect_state(preserved, uid=10001)['databases'] == before['databases']
    print(json.dumps({'fixture': 'COMPOSE_EXPLICIT_MIGRATION', 'status': 'VERIFIED',
                      'sourcePreserved': True, 'requestCount': 1,
                      'databaseVersions': {name: db['userVersion'] for name, db in after['databases'].items()}}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # 저장된 요청 본문이나 비밀이 예외 메시지에 실려 나가지 않게 종류만 출력한다.
        print(json.dumps({'fixture': 'COMPOSE_EXPLICIT_MIGRATION', 'status': 'FAILED',
                          'errorType': type(error).__name__}), file=sys.stderr)
        raise SystemExit(1) from None
