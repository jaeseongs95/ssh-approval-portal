# 2.0 배포와 구형 이력 이전

2.0.0 후보에도 기존 `scripts/deploy180.mjs`와 문서 파일명을 유지한다. `180`은 기존 배포·이력 이전 경로의 식별자이며 현재 제품 버전은 아니다. migration fixture·상태 파일·영수증의 이름과 과거 실행 기록은 바꾸지 않는다. UUID 서버·배포본 클라이언트를 포함한 최종 후보의 전체 시험·패키지·설치·배포는 별도 근거로 확인한다.

`scripts/deploy180.mjs`는 앱을 실행하거나 앱 HTTP API에 의존하지 않는 Node.js 24 배포 진입점이다. `inspect`, `stage`, `activate`, `verify`, `recover`를 각각 호출한다. 서비스 설치, unit/env 교체, SSH 키 생성과 인증 재설정은 수행하지 않는다. 기존 관리 서비스와 `app/releases/...`를 가리키는 활성 심볼릭 링크가 전제다. 일반 디렉터리로 설치된 구형 서비스는 이 도구가 자동 이동하지 않는다.

이 도구는 배포 호스트에서 실행한다. 프로젝트 제품 시험은 테스트 서버·GitHub Actions·Cloud에서 실행하며 로컬 제품 시험이나 Docker를 추가하지 않는다.

## 배포 계획

통합 배포 자산은 `npm run package:release -- --output /absolute/new/portal-2.0.0-release`로 아직 존재하지 않는 새 절대 디렉터리에 만든다. 서버·클라이언트의 tar.gz/zip 4개와 통합 `SHA256SUMS`를 생성하며 기존 출력은 거절한다. 이 문서 수정에서는 패키징을 실행하지 않았다. 클라이언트에는 별도 기존 Node.js `>=24.2.0 <25`·신뢰하는 `cloudflared`·owner 로그인 캐시가 필요하고 런타임·인증값은 클라이언트 자산에 넣지 않는다. 두 번째 로컬 MCP 서버는 선택 사항이다.

그중 공식 서버 패키지의 `release-manifest.json` SHA-256을 `generation`으로 고정한다. 계획 파일에는 경로와 공개 서비스 제어 명령만 넣는다. 비밀·토큰·로그인 설정을 넣지 않는다. 배포 계획은 관리자 입력이며 웹 요청으로 받지 않는다.

```json
{
  "generation": "<release-manifest.json의 64자리 SHA-256>",
  "sourceDir": "/srv/portal-candidate/ssh-approval-portal-2.0.0",
  "appRoot": "/var/lib/ssh-mcp/app",
  "activePath": "/var/lib/ssh-mcp/app/approval-bridge",
  "dataRoot": "/var/lib/ssh-mcp/transfers",
  "healthUrl": "http://127.0.0.1:3000/health",
  "service": {
    "stop": ["/usr/bin/systemctl", "stop", "ssh-approval-bridge.service"],
    "start": ["/usr/bin/systemctl", "start", "ssh-approval-bridge.service"],
    "status": ["/usr/bin/systemctl", "is-active", "--quiet", "ssh-approval-bridge.service"],
    "stoppedExitCode": 3
  }
}
```

`healthUrl`의 포트와 `dataRoot`는 현재 설치의 실제 값으로 지정한다. 도구가 인증·환경 파일을 읽어 추측하지 않는다. Linux native 배포에서는 기존 설치와 동일한 Node 실행 파일로 root 권한에서 호출한다. `dataRoot` 소유자가 서비스 계정이어야 한다. 마이그레이션 자식 프로세스는 그 UID/GID로 실행하여 새 SQLite 소유권을 보존한다.

```sh
sudo /opt/ssh-approval/node/bin/node scripts/deploy180.mjs inspect --plan /srv/portal-deploy180.json
sudo /opt/ssh-approval/node/bin/node scripts/deploy180.mjs stage --plan /srv/portal-deploy180.json
sudo /opt/ssh-approval/node/bin/node scripts/deploy180.mjs activate --plan /srv/portal-deploy180.json
sudo /opt/ssh-approval/node/bin/node scripts/deploy180.mjs verify --plan /srv/portal-deploy180.json
```

`inspect`는 읽기만 수행하며 현재 릴리스, 파일 수, 여유 공간을 반환한다. `stage`는 manifest에 있는 파일만 새 디렉터리에 복사하고 해시 검증, `npm ci --omit=dev --ignore-scripts`, 기존 import 검사를 수행한 뒤 `releases/<generation>`으로 rename한다. 기존 릴리스와 manifest도 고정한다. 같은 generation에 계획을 바꾸면 `DEPLOY_PLAN_CHANGED`로 거부한다.

`activate`는 현재 링크가 준비 당시와 같은지 확인하고 서비스를 중지한다. 상태 명령이 중지 상태를 확인한 뒤 최초 이전이면 원본 DB를 보관·이전하고, 이미 완료한 이전이면 아래의 보관본·journal 검증으로 그 증거를 재사용한다. 새 영구 저장소 전체의 fingerprint를 저장하고 임시 링크를 활성 링크로 atomic rename한 뒤 서비스를 시작한다. 시작 시도 전 상태를 디스크에 기록하므로 응답 유실을 미실행으로 오인하지 않는다. 서비스 중지·시작으로 해당 설치에 짧은 중단이 발생한다.

`verify`는 활성 링크와 manifest SHA-256, 서비스 실행 상태, `/health`의 `healthy`, `version`, `deploymentGeneration`을 함께 확인한다. `deploymentGeneration`은 현재 실행 소스의 manifest SHA-256이어야 한다. 단순한 HTTP 200을 배포 완료로 처리하지 않는다.

## 이력과 원본 보존

`src/adapters/storage/operation-migration.mjs`는 `command-automation.sqlite`, `agent-cli.sqlite`의 기존 `requests(id,body,digest)` 스키마를 읽기 전용 SQLite로 연다. 기존 adapter를 호출하지 않으므로 adapter 초기화의 상태 변경도 실행하지 않는다. 원본 DB의 `policy`와 요청 JSON, 요청 digest를 변경하지 않는다. 알 수 없는 스키마, 잔류 WAL/journal, 변경 중인 원본, 용량 초과는 명시적으로 실패한다.

아래 이력 용량 계약은 현재 구현과 아래의 고정 소스 패치 TEST 회귀에서 확인한 범위다. 두 원본은 각각 최대 10000행, 요청 `body`의 UTF-8 바이트 합계 64MiB, 행당 256KiB까지 읽는다. SQLite 파일 자체는 각각 128MiB까지다. 새 작업의 journal 기본 예산은 별도로 10000행·64MiB이며 명시된 `maxRows`·`maxBytes`는 유지한다. 이 한도는 CPU 기준 실행 대기·동시 실행 한도와 별개다.

이전 영수증의 `retainedHistoryBudget`은 `{count, bytes, sources: [{source, count, originalBytes}]}`다. `bytes`는 이전한 각 행의 UTF-8 JSON body와 canonical contract의 정확한 바이트 합이다. `originalBytes`는 `JSON.stringify(legacy.original)`의 UTF-8 바이트 합이며 원본 SQLite 파일 크기나 SQLite 내부 공간을 뜻하지 않는다. 최대 두 source에 각각 10000행·정규화 원문 64MiB까지 별도 보존 예산을 등록한다. 새 작업용 바이트 사용량은 `liveBytes = 총 body+contract 바이트 − Σ min(현재 해당 행 바이트, 원보존 기준 바이트)`로 계산한다. 따라서 다른 이력 행이 줄어든 여유를 새 행에 전용할 수 없다. 같은 행이 원보존 기준까지 다시 커지는 것은 기존 분량 안에서 허용하고 그 초과분만 새 작업용 예산에 계상한다. 원문·digest는 유지하고 같은 이력 재시도는 보존 예산을 중복 증가시키지 않는다.

행·이벤트·보존 예산은 최대 128행 단위의 동일 SQLite transaction에 기록한다. 실패한 묶음은 rollback하여 DB와 메모리 예산을 함께 되돌리고 앞서 commit한 묶음과 원본·보관본은 남긴다. rollback 자체가 실패하면 `OPERATION_TRANSACTION_UNCERTAIN`으로 연결을 폐기하며 같은 연결에서 작업을 계속하지 않는다. 다시 열 때 실제 DB에서 예산을 재계산한다. `operation_legacy_budget` 추가 테이블로 재시작 뒤에도 예산을 유지하며, 이전 중단으로 이미 존재하는 미등록 legacy 행은 `legacy.original`에서 재구성한 정확한 import projection·version 2·contract를 검증한 뒤 body·version·이벤트를 바꾸지 않고 예산만 등록한다. 일치하지 않는 행은 `INVALID_LEGACY_IMPORT_BASELINE`으로 거절하여 변경된 행을 새 무료 기준으로 삼지 않는다. 기본 이력 조회 범위도 새 작업 행 한도에 보존 이력 수를 더한다. 이전된 `unknown`은 재실행하지 않고 새 작업의 unknown 접수 예산에서 제외하지만 공개 상태의 unknown 총계에는 남는다. scheduler의 snapshot과 enqueue 시 unknown 접수 판정은 SQL 상태 집계를 사용하여 보존 이력 전체의 body를 조회·JSON 파싱하지 않는다. 원본 행 수·합계 바이트 또는 정규화 원문 합계 한도 초과는 `LEGACY_HISTORY_CAPACITY`, 새 작업 예산 초과는 `OPERATION_CAPACITY`로 구분한다.

먼저 두 원본을 `appRoot/legacy-archives/<generation>/`에 복사하고 해시를 대조한다. 보관 파일은 `0400`이다. root 배포에서는 이전 성공 뒤 보관 파일과 디렉터리를 root 소유로 고정한다. 원본 DB는 그대로 둔다. `completed`, `failed`, `cancelled`, `expired`, `denied`, `unknown` 이력을 같은 상태로 새 operation store에 명시적으로 import한다. 나머지 예전 작업은 `unknown` 증거로만 import하며 대기열에 넣거나 재실행하지 않는다. 원문은 `legacy.original`, 기존 digest는 `legacy.digest`에 유지한다. 같은 원본의 재시도는 동일 내용만 허용한다.

최초 이전이 완료되면 `appRoot/deployments/legacy-migration.json`에 원래 generation, `dataRoot`, 이전 영수증을 저장한다. 다음 generation 배포는 이후에도 바뀔 수 있는 `command-automation.sqlite`·`agent-cli.sqlite`를 다시 import하지 않는다. 원래 generation의 변경 금지 보관본을 영수증의 SHA-256·행 수와 대조하고, 현재 `operations.sqlite`에서 각 요청키의 `legacy.original`·`legacy.digest`가 보관본과 같은지 검사한 뒤 완료 증거를 재사용한다. 현재 operation의 상태나 결과를 옛 이력으로 덮어쓰지 않는다.

단, 안전 복구로 1.7 등 구형 릴리스가 다시 writer가 된 뒤 1.8로 재배포하는 경우에는 live 원본 두 DB도 최초 이전 영수증과 대조한다. 파일의 추가·누락이나 SHA-256 변경은 `LEGACY_MIGRATION_SOURCE_CHANGED`로 거부한다. 구형 서비스가 추가한 이력을 완료 표식만 보고 누락시키거나 자동으로 재import하지 않는다. 원본과 보관본을 유지한 채 별도의 명시적 이전 방안을 정해야 한다.

완료 표식이 없는 이전 배포 도구의 상태 파일도, 직전 generation이 `switching`, `start-attempted`, `activated`, `verified`, `recovered` 단계이고 유효한 이전 영수증을 갖고 있으면 같은 보관본·journal 검사를 거쳐 승계할 수 있다. `migrating` 같은 불완전 단계는 완료 증거가 아니다. 영수증 없는 기존 1.8 설치, 손상된 표식, 다른 `dataRoot`, 변경된 보관본, 누락된 canonical 행, 같은 요청키의 원문·digest 충돌은 거부한다. 보관 디렉터리의 symlink와 보관 파일의 symlink·복수 hardlink도 거부한다. 새 키로 바꾸거나 live 원본을 다시 import하여 불완전 증거를 숨기지 않는다. 원본 DB와 canonical journal을 자동 덮어쓰거나 삭제하지 않는다.

기존 `requests.request_key` 컬럼이 있으면 그 값을 정확히 새 journal의 요청키로 사용한다. 컬럼이 없거나 NULL인 구형 행에만 `legacy:<source>:<id>`를 사용한다. 새 journal은 전역 요청키를 사용하므로 두 구형 DB의 같은 키가 서로 다른 이력을 가리키면 `OPERATION_KEY_CONFLICT`로 멈춘다. 이름을 임의로 바꾸거나 기존 결과를 덮어쓰지 않는다. 실패 전에 import된 행은 새 journal에 남을 수 있지만 서비스 전환은 하지 않으며 원본 두 DB와 SHA-256 보관본은 유지한다. 충돌은 별도 명시적 이력 매핑으로 해결해야 하고, 새로운 키로 실행을 재제출해 해결하지 않는다.

기존 command output은 기존 파일과 만료 시각을 그대로 따른다. 기본 보존 TTL은 1시간이다. 이미 만료·삭제된 출력과 처음부터 영구 저장하지 않은 출력은 복원할 수 없다. 이력 이전이 출력 보존 기간을 연장하지 않는다. 출력 재생성을 위해 명령을 재실행하지 않는다. 1.7의 메모리 기반 transfer ID도 재개하지 않는다. 출력·정책을 실제 앱에서 읽는 경로는 1.8 앱 통합 검증으로 별도 확인해야 한다.

## 복구 경계

```sh
sudo /opt/ssh-approval/node/bin/node scripts/deploy180.mjs recover --plan /srv/portal-deploy180.json
```

실패 직후 자동 rollback하지 않는다. 운영자는 실패 영수증과 `appRoot/deployments/<generation>.json`의 단계를 확인하고 위 명령을 실행한다. `recover`는 준비 원본 디렉터리가 없어도 동작한다. 서비스를 먼저 중지한 뒤 활성 링크와 모든 지원 영구 데이터의 byte hash·mtime·파일 목록을 비교한다. operations DB뿐 아니라 기존 history/policy/maintenance DB, command-output manifest·payload·stream, transfer part·JSON, `orphans`의 격리 파일·진단도 검사한다. 새로운 저장소나 알 수 없는 항목도 복구를 차단한다.

새 서비스 시작 시도 뒤 이 fingerprint가 바뀌면 `DOWNMIGRATION_FORBIDDEN_AFTER_WRITES`로 거부한다. 시작 초기화나 TTL 정리도 보수적으로 새 쓰기로 취급한다. 이 경우 서비스는 중지 상태로 남으며 새 DB·출력·후보 링크를 보존한다. 새 데이터를 옛 스키마로 되돌리지 말고 해당 영구 스키마를 읽을 수 있는 수정 릴리스로 전진 복구한다. 쓰기가 없음을 확인한 경우에만 고정된 이전 manifest를 검증하고 링크를 되돌려 기존 서비스를 시작한다. 이전 DB를 덮어쓰거나 새 DB를 삭제하지 않는다.

동시 호출은 `.deploy180.lock`으로 거부한다. 프로세스 강제 종료 뒤 잠금 파일이 남을 수 있다. 배포 프로세스가 실제로 종료됐는지 관리자가 확인한 뒤 해당 잠금만 수동 해제한다. 도구는 다른 프로세스의 잠금을 자동 삭제하지 않는다. 실패한 임시 stage나 보관 자료도 자동 삭제하지 않는다.

각 성공 단계는 `portal.deployment-receipt.v1` JSON과 `deployments/<generation>-<stage>-receipt.json`을 남긴다. 실패는 비밀이나 자식 출력 대신 구분 가능한 `code`와 실패 단계의 JSON을 출력하며 종료 코드 1을 반환한다. 상태 파일과 성공 영수증은 `0600`이다. 제품 시험용 검사는 `node --test test/operation-migration-180.test.mjs`이며 허용된 서버·CI에서 실행한다.

## 과거 실행 근거와 현재 후보의 제한

이 문서는 소스의 절차와 실패 경계를 설명하며 실제 설치·운영 전환 완료를 주장하지 않는다. 다음은 당시 고정 후보의 기존 기록이며 2.0.0 최종 후보의 통과 근거로 확대하지 않는다. 2026-11-03 고정 commit `8ba925e4313934c29bcb6ec74816c148b85c89d6`에서 TEST Linux Node 24.22.1로 `node --test --test-reporter=tap --test-concurrency=2 --test-timeout=60000 test/operation-migration-180.test.mjs`를 실행하여 15개 통과, 실패·취소·skip 0, 종료 코드 0을 확인했다. 이는 격리 fixture의 이력 이전·재배포·복구 회귀 결과이며 최종 후보 전체 시험 또는 실제 배포 성공을 뜻하지 않는다. 실제 서비스 중지·기동, 운영 데이터 보존과 복구는 각 실행의 고정 commit·명령·종료 코드·영수증으로 별도 확인해야 한다.

이후 이력 용량·batch 수정은 base commit `12b11e92799d2be652a746085ac2969c99784fa1`에 정확한 8파일 패치(SHA-256 `248e5da7220c4ef2c818e7cf7660304dc9f5e46a7886c1bd305e0cdcc567505f`)를 적용한 격리 TEST에서 검증했다. `mcpbridge` UID로 `node --test --test-reporter=tap --test-concurrency=1 --test-timeout=180000`에 `test/operation-migration-batch.test.mjs`, `test/operation-migration-retained-budget.test.mjs`, `test/operation-store.test.mjs`, `test/operation-migration-180.test.mjs`, `test/operation-scheduler.test.mjs`의 동일 5개 시험 파일을 실행했다. 실제 TAP은 47개 통과, 실패·취소·skip 0, 종료 코드 0, 24922.118237ms다. 배포 자식의 기존 60000ms 제한은 유지했다. 당시 작업 공간의 `design180/live-candidate/migration-timeout-r3/execution-receipt.json`, `green-r3.tap`, `patch-pins.json`에 입력·명령·결과를 고정했다.

이는 합성 원본의 용량·일반 rollback·재열기·hot-journal 복구 회귀다. 실제 디스크 장애를 주입한 rollback 실패 시험은 하지 않았으며 연결 폐기 경로는 소스로 검토했다. 실제 본서비스의 기존 partial 이력과 원본 사이 의미 충돌 여부도 별도 확인 대상이다. 당시 기록에서는 최종 manifest·TEST 본서비스 1.8 전환·PROD 전환·릴리스를 완료로 보지 않았다. 이 문서 수정만으로 이후 상태나 2.0.0 전환 완료를 판정하지 않는다. 앞선 timeout·실패와 공식 복구 근거도 그대로 보존한다.
