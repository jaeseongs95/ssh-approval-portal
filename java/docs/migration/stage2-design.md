# 3.0.0 Java 전환 2단계 설계 초안 (portal-domain · portal-store · portal-app 포트)

상태: 초안(설계 문서 작성 담당 산출물, 메인 판정 전). 이 문서는 코드·빌드·시험을 하지 않고 쓴 설계다.
기준 작업 사본: `D:/codex/build/ssh-portal-v300-domain` (브랜치 `feature/v300-domain`, HEAD `35b7360`).
계획 정본: `C:\Users\Lenovo\.claude\plans\inherited-marinating-island.md`(구조 표, 2·3단계, 미종결 결함 표).

## 0. 읽는 법

### 0.1 표기
- `[사실]` 2.x 소스·기준본에서 직접 읽은 것. 근거는 `파일:줄`(경로는 저장소 루트 기준, `src/…`).
- `[제안]` 이 문서의 설계 선택. 메인이 12절에서 판정한다.
- `[미확인]` 공식 문서·소스로 확인하지 못한 것.
- 줄 번호는 `LF` 기준 2.x 소스(`a44c4d1`)다. 여러 파일을 한 번에 연 탓에 줄이 어긋난 곳이 없도록 파일별로 다시 계산했다.
- 코드·식별자·SQL은 원문이다. 2.x의 소문자 wire 값(`completed` 등)은 따옴표로 적고 Java enum 상수 이름은 대문자 `COMPLETED`로 적는다.

### 0.2 읽은 입력(확인 범위)
- 규범: `Java·Spring 개발원칙.md` 전체(487줄), 디자인 패턴 정리 8·10절, 안티패턴 정리 15·16절, 벤더 비종속 설계와 공통 계층 구현 원칙(76줄). 위임 공통 규칙 `brief-common.md`.
- 계획 정본 전체, `feature-map.md`의 3.0 대상이 portal-domain·portal-store·portal-app인 행(포트 변경 행 포함)과 4절 판정, `regression-cases.md` 머리말·결함 연결표, `regression-cases.part-a.md`·`part-b.md` 사례 표(1,690행을 직접 파싱해 모듈 열로 걸러냄).
- 2.x 소스: `src/domain/*`(18개 파일 전부), `src/adapters/storage/*`(12개), `src/adapters/config/{capacity,targets,upload-hosts,settings}.mjs`, `src/contracts/ports.mjs`, `src/adapters/mcp/public-contract.mjs`, 그리고 이 파일들이 쓰는 `src/application/{request-admission,target-router,runtime-capacity,lifecycle,operations,commands,command-automation,test-server-mode,files,history}.mjs`.
- 1단계 산출물: `java/portal-arch-checks/**/PortalRules.java`·`ModuleTable.java`, 각 모듈 `build.gradle.kts`, `foundation-cases.md`, 계약 기준본 `java/portal-web/src/test/resources/contract/**`.
- 읽지 못한 것(미검증): `src/application/{agent-cli,files(166줄 이후),history(60줄 이후),desktop,opaque-files,command-policy-review,request-safety}.mjs`의 세부, `preservation-verification.mjs`·`offline-preservation.mjs`·`operation-migration.mjs` 전체(보존 비교·이전은 4·7단계), `artifacts.mjs`의 300줄 이후, 공식 문서 원문(H2·Spring Data JDBC 문서는 이번에 열지 못했다).

### 0.3 vendor 규칙 조사 문서
`D:/codex/build/ssh-portal-v300-prep/java/docs/migration/vendor-ssh-mcp-rules.md`는 2026-11-12 이 문서를 쓰는 시점에 존재하지 않았다(해당 폴더에 `vendor*` 파일 0개를 확인). 그래서 6절의 분류기·redactor 규칙은 「vendor 문서 대기」로 두었다.

### 0.4 핵심 수치(자체 점검 결과는 부록 A)
- 상태 값: Operation 상태 13(wire 공개 enum) = 내구 11 + `pending`·`evaluating`. 2.x 승인 큐 job 상태는 이 13의 부분집합이다.
- ErrorCode: 2.x 소스·기준본에서 잡힌 오류 코드 전부를 3.0 카테고리 enum 8종에 배정했다(5.4절).
- SQLite 표: 2.x 11개(`operations`, `operation_events`, `operation_legacy_budget`, `operation_schema`, `policy`, `requests`(명령), `requests`(CLI), `reservation`, `last_release`, `runtime_capacity`, `outputs`)와 파일 기반 artifact manifest 1종을 3.0 Flyway 표 26개로 옮겼다(8절).
- 사례: 2단계에서 닫는 사례 162건, 미루는 사례 558건과 모듈 열이 깨진 6건(9절).

### 0.5 이 문서가 바로잡는 계획·feature-map의 전제 2건
1. `[사실]` feature-map 4.1절은 `CommandLineGrammar` 포트를 portal-app에 두라고 했다. 그러나 명령 정책 `CommandPolicy`(portal-domain)가 이 문법을 협력 객체로 쓴다(`src/domain/command-policy.mjs:22-31, 98`). portal-domain은 어떤 모듈에도 의존하지 못한다(`ModuleTable.java`: `table.put("domain", Set.of())`, A-DIR). 그래서 `CommandLineGrammar` interface는 portal-domain `command` 패키지가 소유해야 한다(DIP: 정책이 자기가 필요한 interface를 정의). `TargetPlatform`은 portal-app에 둔다. 12절 결정 D-01.
2. `[사실]` feature-map이 `Limits`(상수 묶음) 클래스를 portal-domain에 두라고 했는데, 정적 메서드 없는 상수 클래스는 A-UTIL(`PortalRules.java:266-270`: 메서드가 0개면 helper가 아니다)을 통과하지만 상수 묶음 자체가 안티패턴 T5와 가깝다. 상수는 소유 타입으로 흩는다(11절).

---

## 1. 도메인 개념 목록

2.x 파일별 행동을 요약하고 3.0 타입에 대응시킨다. 「3.0 타입」은 패키지 접두 `io.github.jaeseongs95.portal.domain`를 생략한 이름이다. 모듈은 D(portal-domain), A(portal-app), S(portal-store), SSH(portal-ssh, 3단계), 기타.

### 1.1 `src/domain/*`

| 2.x 파일 | [사실] 행동 요약(근거) | 3.0 타입(모듈) |
|---|---|---|
| `approval-queue.mjs`(330줄) | 승인 정책 객체. 요청을 `pending`으로 받아(`:49-64`) 감사 기록 후 내구 저장소에 의도를 남기고(`:60-62`), 소유자 승인·자동 승인으로 `queued`(`:159-189`), 거부(`:108-113`), 만료(`:86-92`), 유지보수 예약(`:97-101`)을 다룬다. 포화는 `requestCapacity`(기본 100, `:23`)·`Queue full`(`:52`). 실행은 `executeScheduled`(`:251-276`)가 사전 guard(`checkStart` `:190-205`)를 다시 돌린 뒤 한다. 권한 심볼 4종(`:8-11`)이 「누가 시작을 승인했나」를 구분한다(`approvalMode` `:166`). 재시작은 `queued`·`running`을 `unknown`으로 되돌린다(`:114-121`). | `operation.Operation`(전이 메서드), `approval.ApprovalPolicy`(접수·만료·유지보수 판정), `approval.ApprovalMode`, `approval.StartAuthority`(sealed, 심볼 대체)(D) |
| `operation-scheduler.mjs`(166줄) | 내구 상태가 수용·claim을 소유하고 이 객체는 대상 링으로 공정 순서만 고른다(`:8`). 한도 기본값 `globalConcurrency 2, targetConcurrency 1, queueCapacity 32, targetQueueCapacity 32, unknownBudget 32, observerCapacity 256`(`:4`). `enqueue`는 포화(`:124`)·unknown 예산 초과(`:126`)를 구분해 거절한다. 만료는 대기 중(`:83`)과 claim 직후(`:62-65`) 두 번 검사한다. 취소는 accepted·queued를 바로 `cancelled`(`:136`), 실행 중은 `terminating`(`:137`)으로 만든다. 죽은 소비 효과가 나면 `paused`로 멈춘다(`:40, 44, 73`). | `schedule.OperationScheduler`(공정 선택 정책), `schedule.ConcurrencyLimits`, `schedule.SchedulingView`, `schedule.SchedulingDecision`(sealed)(D). 대기·알림·`@Scheduled` 구동은 A(3단계) |
| `capacity.mjs`(9줄) | 양의 안전 정수만 용량(`:1-4`), 문자열은 `^[1-9][0-9]*$`(`:6-9`). 설치 기본값은 `queue=cpus*10`, `concurrency=cpus`(`adapters/config/capacity.mjs:5-8`). | `capacity.Capacity`(record), `capacity.CapacityDefaults`(record, 메서드가 기본값을 답함)(D) |
| `validation.mjs`(46줄) | 숨은 문자 정규식(`:4`), 48자리 hex id(`:6`), SHA-256 hex digest(`:5`). 명령 텍스트: UTF-8 32KiB, 공백만 아님, TAB·LF·CRLF 외 제어 문자 금지(`:11-12`). 여러 줄이면 `read-only`를 `safe`로 낮춘다(`:20`). POSIX 경로(`:25-28`), Windows 경로(`:30-35`), 둘 중 문법으로 고르는 `anyRemotePath`(`:37-40`), basename(`:42-46`). | `id.OperationId`·`id.Digest`·`text.CommandText`, `path.RemotePath`(sealed)·`PosixRemotePath`·`WindowsRemotePath`(D) |
| `execution-context.mjs`(89줄) | 호출자 설명 8192자 상한(`:4, 40-45`), 평가용 12288(`:5`), 소스 증거 상한 `6*16384+3*4096+6*512+4096`(`:7`), 자격 증거 정규식(`:8-20`), 민감 경로 정규식(`:22`), 서버 사실 화이트리스트 13개 키(`:47-67`), `ssh-request-v1:` 봉투 호환(`:73-89`). | `command.CallerContext`, `command.ExecutionContext`(+`ServerFacts` record), `command.SensitiveText`(D) |
| `dispatch-failure.mjs`(23줄) | 배차 실패 이유 15종(`:3`)·단계 19종(`:4`). 예외 본문·임의 속성은 진단이 아니다(`:1`, WeakMap `:2`). `dispatchStep`은 알 수 없는 오류를 일반 오류로 감싼다(`:5-12`), `dispatchRefusal`은 확정 거절이다(`:14-19`), 미분류는 `unknown/unknown`(`:20-23`). | `failure.DispatchFailure`(sealed: `Refused`·`StepFailed`·`Unclassified`), `DispatchReason`·`DispatchStage`(enum)(D) |
| `execution-failure.mjs`(26줄) | 실행 실패 진단. 단계 6종(`:3`)·코드 7종(`:4`)·원격 결과 3종(`:5`), 자동 재전송은 항상 `false`(`:6, 13`). 표시 직전에 다시 검증한다(`:23-26`). | `failure.ExecutionFailure`(sealed), `ExecutionStage`·`ExecutionFailureCode`·`RemoteOutcome`(enum)(D) |
| `file-target-binding.mjs`(15줄) | 파일 작업을 승인 작업에 묶는 서버 소유 평면 필드 `fileTargetId/Revision`. 둘 다 없거나 둘 다 유효해야 한다(`:2-8, 10-15`). | `file.FileTargetBinding`(record)(D) |
| `target-platform.mjs`(43줄) | 대상 플랫폼 `linux`(기본)·`windows`(`:6`). 능력: `commandShell`·`fileTransfer`·`elevatedFileTransfer`·`pythonSource`(Windows는 `pythonExecutable`이 있을 때만)·`agentCli`·`commandNameApproval`(`:8-14`). Windows 분류는 모듈 한정 cmdlet 2개만 `read-only`, 나머지 `safe`(`:20-28`). 능력이 없으면 `TARGET_CAPABILITY_UNSUPPORTED`(`:32-36`). deny 힌트(`:38-43`). | 포트 `TargetPlatform`(A), 값 `target.TargetCapabilities`(D). 구현 `LinuxTargetPlatform`·`WindowsTargetPlatform`은 SSH(3단계) |
| `command-line.mjs`(120줄), `windows-command-line.mjs`(72줄) | POSIX·PowerShell 명령줄에서 「명령 이름」을 뽑는 문법(`names`·`complete`·`usesSudo`). 셸 평가기도 위험 분류기도 아니다. 동적 구문은 `complete=false`로 전체 평가 경로로 보낸다. | interface `command.CommandLineGrammar`(**D**, 12절 D-01), 구현 `PosixCommandLineGrammar`·`WindowsCommandLineGrammar`는 SSH(3단계) |
| `command-policy.mjs`(98줄) | 자동화 질문 버전 `ssh-command-risk-v5`·프롬프트 리비전·SHA-256(`:7-12`), 승인된 이름 검증(`:16-21`), 명시 승인 판정 `explicitUserApproval`(`:22-31`), 명령 집합 질문(`:32-40`), 정책 JSON 검증(`:43-71`: 대상 ≤32, 이름 ≤128, 임계값 확률 > 0.5), `inspectCommand`(`:74-84`), 위험 검증 `validatedRisk`(`:86-96`), `commandDigest`(`:97`), `deniedCommand`(`:98`). | `command.CommandPolicy`(문서 불변식)·`TargetRule`·`Threshold`·`command.CommandRiskCatalog`·`command.AutomaticApprovalPolicy`(D), 리소스 2종(5.3절) |
| `command-risks.json`(618줄), `automation-risk-question.json`(8줄) | 등록 전 명령 이름의 기능·위험 안내 카탈로그, 자동화 질문. 질문의 SHA-256이 질문 버전에 결속된다(`command-policy.mjs:12`). | 리소스 `risk/command-risks.json`·`risk/automation-risk-question.json`(바이트 동일), `CommandRiskCatalog`(D) |
| `safety.mjs`(86줄) | 관찰 전용 안전 평가. 라벨 `low_risk`·`high_risk`(`:5`), 프로토콜 상수(`:6-14`), 실패 이유 9종(`:15-16`), Jev 모델명 `jev-N.NN.NN`(`:28`), 평가 검증(`:29-40`: 확률 합 1±1e-6, 선택 라벨이 최대), 후보 일치 0.999/0.99(`:42-47`), 진단 코드 17종(`:61-80`), 실패 재구성(`:83-86`). | `safety.SafetyAssessment`(sealed: `Assessed`·`Unavailable`), `SafetyLabel`, `SafetyFailure`, `SafetyDiagnostic`(D) |
| `desktop-lease.mjs`(35줄), `desktop-state.mjs`(31줄) | 데스크톱 결속(`ownerId, targetId, targetRevision, epoch≥1`, `:6-12`), 입력 동작 검증(키·포인터·텍스트, 한 요청 ≤128 동작·≤4096 이벤트, `:14-35`), 신뢰된 어댑터가 공급하는 상태 4종·차단 사유 6종(`desktop-state.mjs:3-24`). | `desktop.DesktopBinding`, `DesktopAction`(sealed), `DesktopReadiness`(record), `DesktopState`·`DesktopBlocker`(enum)(D). lease 상태는 메모리(`desktop.mjs:12` Map)라 표를 만들지 않는다 |
| `agent-cli.mjs`(51줄) | 에이전트 CLI 계약 `agent-cli-install-v1`, 제공자 2종(`codex`·`claude`, `:5-8`), 공개 릴리스 검증(`:21-33`: 레지스트리 URL·sha512 integrity 형식), 의도 `agentCliIntent`(`:36-51`: 필드 8개 정확, 대상 결속·만료·다이제스트). | `agentcli.AgentCliProvider`(interface)·`CodexCliProvider`·`ClaudeCliProvider`, `agentcli.AgentRelease`, `agentcli.AgentCliIntent`(D) |

### 1.2 설정·계약 파일 중 도메인에 들어가는 것

| 2.x 파일 | [사실] 행동 요약(근거) | 3.0 타입 |
|---|---|---|
| `contracts/ports.mjs`(49줄) | 상수: `MAX_BYTES 64MiB`, `CHUNK_BYTES 256KiB`, `EXPIRES_MS 600000`(artifact), `APPROVAL_EXPIRES_MS 3600000`, `OUTPUT_PAGE_BYTES 16KiB`, `COMMAND_MAX_BYTES 32KiB`, `COMMAND_REQUEST_MAX_BYTES 512KiB`, `PYTHON_SOURCE_MAX_BYTES 16384`(`:2-9`). `utf8WithinLimit`: 문자열 길이 ≤ 한도, 정형(`isWellFormed`), UTF-8 바이트 ≤ 한도(`:11-12`). 포트 typedef(`:14-48`). | 상수는 소유 타입에(11절). 값 검증은 `text.Utf8Text`. 포트는 7절 |
| `adapters/config/targets.mjs`(82줄) | `BRIDGE_TARGETS` JSON을 대상 정의로(`:13-60`). 키 화이트리스트 11개, 별칭 `^[a-z][a-z0-9_-]{0,31}$`, 표시 이름 ≤80자·제어문자 금지, read·write 프로파일은 달라야 하고 Windows 전용 키는 Windows에서만. `revision = SHA-256(JSON({entry, reader, writer}))`(`:74`) — 요청은 ID만 고르고 SSH 주소를 정하지 못한다(`:12`). | `target.Target`(record), `target.TargetRevision`, `target.ConnectionProfile`(값)(D). 변환기 `BridgeTargetsConverter`는 portal-server |
| `adapters/config/upload-hosts.mjs`(27줄) | 정확 DNS 이름 또는 선행 `*.도메인` 접미사만. WHATWG 정규화로 숫자 IP 별칭(`127.1`, 16진, 8진) 거절(`:6-17`). ≤65536바이트, 개행·NUL 금지(`:19-23`). | `host.UploadHostPatterns`(record), `UploadHostPattern`(sealed: `ExactHost`·`WildcardSuffix`)(D) |
| `adapters/config/settings.mjs`(78줄) + `scripts/validate-origin.mjs` | `validateOrigin`: ≤4096바이트, 정규식 `^https://(?:\[[0-9a-f:]+\]|[a-z0-9._-]+)(?::[1-9][0-9]{0,4})?$`(`settings-contract.json:40`), `url.origin === value`, 포트 1~65535, 퓨니코드 왕복(`:13-28`). | `origin.AdminOrigin`(record)(D). 나머지 설정은 portal-server `BridgeProperties` |
| `adapters/mcp/public-contract.mjs`(301줄) | Contract 2.0 봉투·상태 enum·입력/출력 스키마·`presentOperation`·오류 코드 매핑. | `contract.*`(5절) |

### 1.3 `src/adapters/storage/*`와 관련 응용 파일

| 2.x 파일 | [사실] 행동 요약(근거) | 3.0 대응 |
|---|---|---|
| `operation-store.mjs`(285줄) | 모든 작업 종류의 단일 내구 저널. 표 `operations`·`operation_events`·`operation_legacy_budget`(`:59-67`). 상태 11종(`:6`), 허용 전이(`:10-17`), 낙관적 `version`(`:142-144`), 계약 불변 키 열(`:153-155`), `request_key` UNIQUE + 계약 digest 비교로 멱등(`:170-174`), claim은 전역·대상·unknown 예산·conflictKey를 한 트랜잭션에서 검사(`:248-259`), 결과 확정 `outcome`(`:261-269`), 재시작 `recover`(`:270-274`), 용량 한도 `maxRows 10000`·`maxBytes 64MiB`(`:42, 99-102`). | S: `OperationRow` 외 표 6개, 포트 A `OperationJournal`·`ClaimStore` |
| `command-state.mjs`(73줄) | 명령 자동화 정책 1행(`policy(id=1,revision,body)`, `:16`)과 요청 저널(`requests`)·시작 시 정규화(`pending`→`expired`, `queued·running·evaluating`→`unknown`, `:18-33`)·정책 CAS(`:45-51`)·저널 상한 10000(`:65`)·지표 투영(`:54-62`). | S: `command_policy*` 표 4개, `command_decision`은 `operation_decision`에 합침(8.3) |
| `agent-cli-state.mjs`(61줄) | CLI 설치 요청 저널. 표 `requests(id,request_key UNIQUE NOT NULL,digest,body,remote_status)`(`:20`), 키 형식 `agent-cli:…`(`:44-48`), 본문 ≤64KiB(`:16-17`), 정규화(`:21-27`), keyset 이력(`:33-43`), 원격 상태 기록(`:51-58`). | S: `agent_cli_request` |
| `maintenance-state.mjs`(46줄) | 유지보수 예약 1행(`reservation(id=1,owner_hash,baseline)`)·마지막 해제(`last_release`)(`:14`), 소유자는 SHA-256만 저장(`:16-19`), 같은 소유자 재사용 금지(`:25`), 기준선 한 번만 저장·≤4MiB(`:26-31`), 해제는 한 트랜잭션(`:36-43`). | S: `maintenance_reservation`·`maintenance_release` |
| `runtime-capacity-state.mjs`(34줄) | 용량 override 1행(`runtime_capacity(id=1, body)`, `:12`), compare-and-set(`:24-31`). | S: `runtime_capacity`·`runtime_capacity_target` |
| `command-output.mjs`(347줄) | 출력 manifest SQLite `outputs(id, body, digest, charge)`(`:53`)와 페이로드 파일 `.part`·`.out`·`.stream`(`:76, 108-117`). TTL 1h·파일당 16MiB·총 128MiB·최대 1000건(`:8, 144`). 상태 `pending`→`ready`/`unavailable`, 만료는 파생(`:137`). 예약은 디스크 여유도 본다(`:145-147`). | S: `command_output*` 표 3개 + 파일 `FileOutputPayloadStore` |
| `artifacts.mjs`(502줄) | 업로드·다운로드 artifact. 바이트는 `<id>.part`, 메타는 `<id>.json` manifest(`:91-149`), 상태 `staging·ready·deleting·consuming·consumed`(`:101`), 예산 512MiB(`:61`), 청크 SHA-256 이력, staged 파일(`purpose==='staged'`)은 공개 UUID·소유자·`operationKey`·액션 목록을 가진다(`:19-31`). | S: `artifact*` 표 3개 + 파일 `FileArtifactPayloadStore` |
| `scoped-artifacts.mjs`(33줄) | 대상이 소유하고 전역 쿼터는 하나만 두는 래퍼(`:1-33`). | A: `TargetScopedArtifacts`(3단계 유스케이스 쪽) |
| `history-query.mjs`(24줄) | 저널의 공개 메타만 순회, 상한 10000행(`operation`/`command-state`가 이를 사용). | S: `JdbcHistoryQuery`(파생 쿼리) |
| `offline-preservation`·`operation-migration`·`preservation-verification` | 2.x SQLite를 오프라인으로 읽어 보존 기준선을 잡거나 3.0으로 이전. | 7단계 portal-migrate·4단계 보존 비교. 2단계는 필요한 열만 제공(8.5) |
| `application/request-admission.mjs`(105줄) | 프로세스 로컬 요청 입장: 활성 8·대기 32·대기 5초·분리 64(`:19`), FIFO 대기·취소·시간 초과·닫힘·`detach`(`:30-104`). 오류 5종(`:1-7`). | 정책 값 `admission.AdmissionLimits`(D), 실행체 `RequestAdmission`(A, 3단계) |
| `application/target-router.mjs`(156줄) | 프로세스 단일 claim(`createClaims`, `:5-48`: 한도·대기 예약 32·구독자 알림), 대상 라우팅·유지보수 예약 조건(`:51-156`). | claim은 DB 슬롯으로 대체(3.3절), 라우팅은 A(3단계) |
| `application/lifecycle.mjs`(54줄) | 유지보수 예약·상태·비교 확인·해제·종료 순서. | A: `LifecycleService`(3·4단계). 2단계는 `MaintenanceStore` 포트만 |
| `application/runtime-capacity.mjs`(64줄) | 용량 override 검증·CAS·감사·적용. | A: `RuntimeCapacityService`(3단계). 2단계는 `RuntimeCapacityStore` 포트와 표 |
| `application/operations.mjs`(88줄), `commands.mjs`(38줄), `command-automation.mjs`(192줄), `test-server-mode.mjs`(20줄) | 제출·관찰·취소 유스케이스, 읽기 명령 경로, 자동 승인 평가 흐름, TEST 서버 능력 확인. | 규칙은 D(`AutomaticApprovalPolicy`), 흐름은 A(3단계) |

---

## 2. Operation 상태 기계

### 2.1 두 층을 하나로 합친다 [제안]
- `[사실]` 2.x는 상태를 두 곳에서 관리한다. 내구 저널은 11종(`operation-store.mjs:6`): `accepted, queued, starting, running, terminating, completed, failed, cancelled, expired, denied, unknown`. 메모리 승인 job은 `pending, evaluating, queued, running`에 종료 6종(`approval-queue.mjs:12`: `completed, failed, denied, expired, cancelled, unknown`)을 더한다. 관찰 응답은 `accepted`를 job 상태 또는 `pending`으로 바꿔 보여 준다(`operations.mjs:15-19`: `state: record.state === 'accepted' ? job?.state ?? 'pending' : record.state`). 공개 enum은 합집합 13종이다(`public-contract.mjs:15`).
- `[사실]` 두 층이 어긋나면 D-0004 같은 결함(승인된 요청이 대기열 대신 `busy_check`에서 즉시 실패)이 생겼다. `syncOperation`(`approval-queue.mjs:235-244`)이 두 층을 손으로 맞춘다.
- `[제안]` 3.0은 `Operation` 하나가 13개 상태를 모두 갖는다. 메모리 job을 두지 않는다. 재시작해도 DB 행이 진실이다.

### 2.2 `OperationState` enum (2.x 원값 그대로)

wire 값은 `public-contract.mjs:15` 순서다. Java 상수 이름은 대문자, wire 값은 `@JsonValue`(jackson-annotations, A-DOMAIN이 허용하는 유일한 외부 의존)로 낸다. DB에는 enum 이름(`COMPLETED`)이 저장된다(개발원칙 4.2).

| 상수 | wire(2.x 원값) | 뜻(2.x 근거) | 종료 | 2.x 내구 저널에 있나 |
|---|---|---|---|---|
| `ACCEPTED` | `accepted` | 의도가 내구 저장됨, 아직 승인 단계 전(`operation-store.mjs:176`) | 아니오 | 예 |
| `PENDING` | `pending` | 소유자 승인 대기(`approval-queue.mjs:59`) | 아니오 | 아니오(메모리 job) |
| `EVALUATING` | `evaluating` | 자동 승인 평가 중(`:123`) | 아니오 | 아니오(메모리 job) |
| `QUEUED` | `queued` | 승인됐고 실행 대기열에 있음(`operation-scheduler.mjs:129`) | 아니오 | 예 |
| `STARTING` | `starting` | claim됨, 외부 효과 직전(`operation-store.mjs:258`) | 아니오 | 예 |
| `RUNNING` | `running` | 실행 중(`operation-scheduler.mjs:66`) | 아니오 | 예 |
| `TERMINATING` | `terminating` | 취소 요청됨, 중지 미확인(`:137`) | 아니오 | 예 |
| `COMPLETED` | `completed` | 정상 확정 | 예 | 예 |
| `FAILED` | `failed` | 실패 확정 | 예 | 예 |
| `CANCELLED` | `cancelled` | 취소 확정 | 예 | 예 |
| `DENIED` | `denied` | 소유자·정책 거부 | 예 | 예 |
| `EXPIRED` | `expired` | 승인·대기 마감 초과 | 예 | 예 |
| `UNKNOWN` | `unknown` | 결과 불확실, 대조 필요 | 「종료」로 취급(`operation-store.mjs:8`)하지만 `COMPLETED·FAILED·CANCELLED`로만 나갈 수 있음 | 예 |

- `[사실]` 「종료」 집합(`terminal`)은 `completed, failed, cancelled, expired, denied, unknown`이다(`operation-store.mjs:8`, `operation-scheduler.mjs:1`, `approval-queue.mjs:12`). 활성 집합은 `starting, running, terminating`(`operation-store.mjs:9`).
- `[제안]` 메서드: `isTerminal()`(위 6종), `isFinal()`(`unknown` 제외 5종), `isActive()`, `isPreDispatch()`(`ACCEPTED, EVALUATING, PENDING, QUEUED` — 외부 효과 전이라 만료·거부·취소가 확정 가능한 상태).
- `[제안]` 새 코드는 `ACCEPTED`를 한 트랜잭션 안에서만 쓴다. `Operation.accept(...)`가 `ACCEPTED`(v1 이벤트)를 만들고 같은 트랜잭션에서 곧바로 `PENDING` 또는 `EVALUATING`(v2 이벤트)으로 전이한다. 그래서 관찰자는 `accepted`를 보지 못한다(2.x와 같은 관찰 동작). `ACCEPTED` 값은 계약 enum 호환·이전 행·충돌 복구를 위해 남긴다.

### 2.3 전이표 (출발 · 사건 · 도착 · 조건 · 2.x 근거)

`Operation`의 메서드로 둔다(2.4절). 모든 전이는 `version`을 1 올리고 이벤트 행을 하나 남긴다(`operation-store.mjs:158, 145`).

| # | 출발 | 사건(메서드) | 도착 | 조건 | 2.x 근거 |
|---|---|---|---|---|---|
| T1 | (없음) | `Operation.accept` | `ACCEPTED` | 요청 키 새로움, 계약 필드 유효, 유지보수 아님 | `operation-store.mjs:165-186`, `approval-queue.mjs:50` |
| T2 | `ACCEPTED` | `beginEvaluation` | `EVALUATING` | 자동화 평가 경로 | `approval-queue.mjs:123` |
| T3 | `ACCEPTED`·`EVALUATING` | `awaitOwnerDecision` | `PENDING` | 평가 끝(`review`) 또는 평가 없음 | `approval-queue.mjs:59, 131-137` |
| T4 | `PENDING` | `enqueue(mode)` | `QUEUED` | 유지보수 아님, 만료 아님, 시작 권한 일치(7.3), 큐 포화 아님 | `approval-queue.mjs:159-189`, `operation-scheduler.mjs:115-131` |
| T5 | `PENDING`·`QUEUED`·`EVALUATING` | `deny` | `DENIED` | 외부 효과 전 | `approval-queue.mjs:108-113, 131-136`, `operation-store.mjs:11-12` |
| T6 | `ACCEPTED`·`EVALUATING`·`PENDING`·`QUEUED` | `expire(at)` | `EXPIRED` | `at >= expiresAt`. 철회할 수 없다(감사 실패와 무관) | `approval-queue.mjs:86-92`, `operation-scheduler.mjs:83` |
| T7 | `ACCEPTED`·`EVALUATING`·`PENDING`·`QUEUED` | `requestCancel` | `CANCELLED` | 외부 효과 전, 결과 `outcomeCertainty=NOT_DISPATCHED` | `operation-scheduler.mjs:136` |
| T8 | `QUEUED` | `claim(at)` | `STARTING` | 한도(전역·대상·unknown 예산·conflictKey 펜스) 통과. 저장 계층이 같은 트랜잭션에서 보장(3.3절) | `operation-store.mjs:248-259` |
| T9 | `STARTING` | `refuseBeforeDispatch(failure)` | `FAILED` | 사전 guard 실패, `NOT_DISPATCHED`·`reason=input_failed` | `operation-scheduler.mjs:53-56`, `operation-store.mjs:265-267` |
| T10 | `STARTING` | `expire(at)` | `EXPIRED` | claim 직후 마감 확인, `NOT_DISPATCHED` | `operation-scheduler.mjs:62-65`, `operation-store.mjs:13` |
| T11 | `STARTING` | `settle(cancel before dispatch)` | `CANCELLED` | `terminating`이거나 abort됨 | `operation-scheduler.mjs:59-61` |
| T12 | `STARTING` | `markRunning` | `RUNNING` | 외부 효과 경계를 넘는 첫 전이. `expectedState=STARTING`·`expectedVersion` | `operation-scheduler.mjs:66` |
| T13 | `STARTING`·`RUNNING` | `requestCancel` | `TERMINATING` | 중지는 미확인 | `operation-scheduler.mjs:137`, `operation-store.mjs:12-14` |
| T14 | `RUNNING`·`TERMINATING`·`STARTING` | `settle(outcome)` | `COMPLETED` | 2.5절 판정표 | `operation-store.mjs:261-269` |
| T15 | 같음 | `settle(outcome)` | `FAILED` | 〃 | 〃 |
| T16 | 같음 | `settle(outcome)` | `CANCELLED` | 〃(`reason=cancel`) | 〃 |
| T17 | 같음 | `settle(outcome)` | `UNKNOWN` | 정산 안 됨·원격 상태 불명·대조 필요 | 〃, `operation-scheduler.mjs:69` |
| T18 | `STARTING`·`RUNNING`·`TERMINATING` | `recoverAfterRestart` | `UNKNOWN` | 시작 시 활성 상태 전부. `recoveryReason=BRIDGE_RESTART`, `requiresReconciliation` | `operation-store.mjs:270-274` |
| T19 | `QUEUED` | `recoverAfterRestart` | `UNKNOWN` | 2.x 승인 큐는 재시작 시 `queued`·`running`을 `unknown`으로(메모리 job 복원) | `approval-queue.mjs:119`, `command-state.mjs:23` |
| T20 | `PENDING` | `recoverAfterRestart` | `EXPIRED` | 시작 시 대기 중이던 소유자 승인 요청은 만료로 닫는다 | `command-state.mjs:24`, `agent-cli-state.mjs:21-27` |
| T21 | `EVALUATING` | `recoverAfterRestart` | `UNKNOWN` | 평가 중단은 결과 불명 | `command-state.mjs:23` |
| T22 | `UNKNOWN` | `reconcile(evidence)` | `COMPLETED`·`FAILED`·`CANCELLED` | 소유자 대조 근거가 있을 때만 | `operation-store.mjs:16` |
| T23 | `ACCEPTED`·`QUEUED` | `abortEvaluation`·`recordUnknown` | `UNKNOWN` | 평가·저장 중단 | `approval-queue.mjs:124`, `operation-store.mjs:11-12` |
| T24 | `QUEUED` | `refuseBeforeDispatch(maintenance)` | `FAILED` | 유지보수 예약 시 대기 작업 닫기 | `approval-queue.mjs:32-37` |
| T25 | `PENDING` | `refuseBeforeDispatch(queue_full·test_server_bypass)` | `FAILED` | 자동 배차 거절 후 소유자 검토를 남기지 않는 경우만 | `approval-queue.mjs:152-158` |

`[사실]` T18~T21의 출발 상태는 2.x에서 두 저장소가 따로 처리했다(내구 저널의 `recover`는 활성만, 명령·CLI 저널의 시작 정규화는 `queued·running·evaluating·pending`). 3.0은 `recoverAfterRestart` 하나가 상태별로 갈라 모두 처리한다.
`[제안]` T20(`PENDING`→`EXPIRED`)은 2.x가 저널을 열 때 하던 정규화를 그대로 옮긴 것이다. `EXPIRED`로 닫아 같은 요청 키로 다시 접수할 수 있게 한다.

### 2.4 금지 전이
| 금지 | 이유(2.x 근거·규칙) |
|---|---|
| `COMPLETED·FAILED·CANCELLED·EXPIRED·DENIED` → 어떤 상태든 | 종료 상태는 불변(`operation-store.mjs:10-17` 표에 출발 키가 없음, `:157` `INVALID_OPERATION_TRANSITION`) |
| `UNKNOWN` → `QUEUED·PENDING·STARTING·RUNNING·TERMINATING·EXPIRED·DENIED` | 결과 불명 작업의 자동 재전송 금지(`execution-failure.mjs:6, 13` `automaticReplay:false`, `approval-queue.mjs:253` 「never replay」). 나갈 수 있는 곳은 T22뿐 |
| `STARTING·RUNNING·TERMINATING` → `QUEUED·PENDING·EVALUATING·ACCEPTED` | 실행 경계를 넘은 뒤에는 되돌리지 않는다. 시작 롤백은 DB 트랜잭션 롤백이지 상태 전이가 아니다(2.x는 메모리 job을 손으로 `pending`으로 되돌렸다 `approval-queue.mjs:181`) |
| `ACCEPTED·EVALUATING·PENDING` → `STARTING·RUNNING` | 승인(`QUEUED`)을 건너뛰어 실행할 수 없다(`:12-13` 표) |
| `EVALUATING` → `QUEUED` | 평가 뒤에는 반드시 `PENDING`을 거친다(`approval-queue.mjs:131-137`; 자동 승인의 `startCommand`도 `pending`에서 시작 `:138-141`) |
| `QUEUED` → `RUNNING` | claim(`STARTING`)을 건너뛸 수 없다(`operation-store.mjs:12`) |
| `RUNNING` → `EXPIRED·DENIED` | 마감·거부는 외부 효과 전에만(`:14` 표에 없음) |
| 어떤 상태든 → `ACCEPTED` | 초기 상태 전용 |
| 계약 필드 변경(`request_key`, `owner`, `target_id`, `target_revision`, `kind`, 입력, `input_digest`, `created_at`, `conflict_key`, `expires_at`, `deadline`) | `OPERATION_CONTRACT_IMMUTABLE`(`operation-store.mjs:153-155`) |

### 2.5 `settle` 판정표 [사실: `operation-store.mjs:261-269`]
입력은 `ExecutionOutcome`(6.4절). 위에서부터 첫 일치가 이긴다.

| 순서 | 조건 | 도착 |
|---|---|---|
| 1 | `phase != settled` 또는 `cleanupComplete != true` | `UNKNOWN` |
| 2 | `remoteState ∉ {not_dispatched, exited}` 또는 `requiresReconciliation == true` | `UNKNOWN` |
| 3 | `reason == cancel` | `CANCELLED` |
| 4 | `failed == true` 또는 `remoteState != exited` 또는 `reason != exit` 또는 `exitCode != 0` | `FAILED` |
| 5 | 그 밖(정상 종료 코드 0) | `COMPLETED` |

`outcomeCertainty`는 `UNKNOWN`이면 `UNKNOWN`, 아니면 `remoteState` 값(`NOT_DISPATCHED`·`EXITED`)이다(`:268`). `requiresReconciliation`은 상태가 `UNKNOWN`일 때만 참이다.

### 2.6 불변식 [사실 + 제안]
1. **완료는 확정 뒤에만(D-0035).** `[제안]` `COMPLETED`로 가는 `settle`은 `CompletionEvidence`(sealed: `CommandExited(exitCode==0)`, `FilePublished(confirmedAt, sha256)`, `FileRead(verified)`)가 있을 때만 성공한다. 파일 교체는 임시 파일 → 교체 확정이 끝난 뒤에만 `FilePublished`를 만들 수 있고(계획 3단계 D-0035), 교체 후 실패는 원본 복원 뒤 `FAILED`다. 증거 없이 `COMPLETED`를 만드는 생성자는 없다.
2. **알 수 없는 결과는 재전송 금지.** `[사실]` 활성 상태는 재시작 시 `UNKNOWN`이고(`operation-store.mjs:272`), 이 상태에서는 어떤 실행 전이도 없다. 같은 요청 키로 관찰만 가능하다(`operations.mjs:60-80`).
3. **종료 알림·정리는 한 번.** `[사실]` `terminalNotified` 표지(`approval-queue.mjs:224, 238`). `[제안]` 3.0은 `FINISHED` 이벤트를 `@TransactionalEventListener(AFTER_COMMIT)`로 한 번 낸다. 같은 전이는 낙관적 잠금 때문에 한 번만 커밋되므로 표지가 필요 없다.
4. **낙관적 버전.** `[사실]` 모든 갱신은 `WHERE id=? AND version=?`(`operation-store.mjs:142-144`), 충돌은 `OPERATION_VERSION_CONFLICT`. `expectedState`도 지원(`:152`). `[제안]` `@Version long version`, `OptimisticLockingFailureException`을 저장 어댑터가 `OperationVersionConflictException`(코드 `OPERATION_VERSION_CONFLICT`)으로 바꾼다.
5. **요청 키 멱등.** `[사실]` 같은 `request_key` + 같은 계약 digest는 기존 작업을, 다르면 `OPERATION_KEY_CONFLICT`(`:170-174`). `[제안]` `UNIQUE(request_key)`와 계약 digest 비교. 동시 접수의 승자는 `DuplicateKeyException`으로 정해진다.
6. **스케줄러 claim이 취소·만료를 이긴다.** `[사실]` 내구 상태가 `accepted·queued`가 아니면 승인 큐의 사전 종료는 물러난다(`approval-queue.mjs:207-211`). `[제안]` 사전 종료 전이(T5~T7)는 `expectedVersion` 불일치 시 재조회해 `STARTING`이면 포기한다.
7. **만료는 철회 불가.** `[사실]` 만료 확정은 감사 어댑터가 실패해도 남는다(`approval-queue.mjs:88`). `[제안]` `expire`는 감사와 무관하게 커밋한다.
8. **계약 불변.** 2.4절 마지막 행.
9. **자동 승인은 정책 revision이 같을 때만.** `[사실]` 실행 직전 `policy.revision !== job.decision.policyRevision`이면 `policy_changed` 거절(`command-automation.mjs:27`).
10. **시간은 값으로 받는다.** `[제안]` 전이 메서드는 `Instant at`을 인자로 받는다. 한 유스케이스가 `Clock`을 한 번 읽어 모든 전이에 같은 시각을 준다.

### 2.7 `Operation`의 모양 [제안]
- `final class Operation`(불변). 상태·버전·시각·결과를 모두 보관하고, 전이마다 새 인스턴스를 돌려준다. 바깥 `static` 판정은 두지 않는다. 필드마다 null을 쓰지 않도록 아래를 sealed·enum으로 모델링한다.
  - 식별·계약(불변): `OperationId id`, `RequestKey requestKey`, `OwnerId owner`, `TargetId targetId`, `TargetRevision targetRevision`, `OperationKind kind`(`COMMAND, SOURCE, UPLOAD, DOWNLOAD`), `OperationInput input`(sealed: `CommandInput`·`SourceInput`·`UploadInput`·`DownloadInput`), `Digest contractDigest`, `Instant createdAt`, `Deadline expiry`(sealed: `NoDeadline`·`DeadlineAt(Instant)`), `ConflictKey conflictKey`(sealed: `NoConflictKey`·`ConflictKeyOf(String)`).
  - 가변(전이로만 변경): `OperationState state`, `long version`, `Instant updatedAt`, `ApprovalMode approvalMode`(`OWNER`·`AUTOMATIC`·`NOT_DECIDED` enum — null 대신), `DecisionRecord decision`(sealed: `NoDecision`·`Decided(...)`), `Settlement settlement`(sealed: `Unsettled`·`Settled(ExecutionResult result, OutcomeCertainty certainty, Reconciliation reconciliation, Instant finishedAt)`), `RecoveryReason recovery`(`NONE`·`BRIDGE_RESTART`·`LEGACY_IMPORT`), `Instant cancellationRequestedAt`(sealed 대신 `CancellationRequest`: `NotRequested`·`RequestedAt`).
- 메서드 시그니처(구현 담당이 이름·인자를 그대로 쓴다): `static Operation accept(NewOperation spec, OperationId id, Instant at)`, `Operation beginEvaluation(Instant at)`, `Operation awaitOwnerDecision(Instant at)`, `Operation recordDecision(DecisionRecord decision, Instant at)`, `Operation enqueue(StartAuthority authority, Instant at)`, `Operation deny(Instant at)`, `Operation expire(Instant at)`, `Operation claim(Instant at)`, `Operation markRunning(Instant at)`, `Operation requestCancel(Instant at)`, `Operation refuseBeforeDispatch(DispatchFailure failure, Instant at)`, `Operation settle(ExecutionOutcome outcome, Instant at)`, `Operation recoverAfterRestart(Instant at)`, `Operation reconcile(ReconciliationEvidence evidence, Instant at)`. 잘못된 전이는 `InvalidOperationTransitionException`(코드 `INVALID_OPERATION_TRANSITION`).
- `[제안]` `OperationState`의 전이 표는 `OperationState#canMoveTo(OperationState)`(enum 인스턴스 메서드, 표는 2.3절의 데이터)가 한 곳에서 갖고, `Operation` 메서드가 그 표와 추가 조건을 같이 본다. 표는 시험이 2.3·2.4절을 전수 열거로 확인한다(13×13 = 169 조합).

---

## 3. 승인 대기열·스케줄러·용량

### 3.1 한도와 포화: 2.x에 세 층이 있다 [사실]
| 층 | 2.x 값·근거 | 포화·초과 시 | 3.0 대응 |
|---|---|---|---|
| (a) 요청 입장(프로세스 로컬 HTTP 수용) | 활성 8·대기 32·대기 5000ms·분리 64(`request-admission.mjs:19`). FIFO, 취소·시간 초과·닫힘 | `REQUEST_QUEUE_FULL`(`:85`), `REQUEST_QUEUE_TIMEOUT`, `REQUEST_QUEUE_CLOSED`, `REQUEST_ABORTED`, `REQUEST_WAIT_LIMIT` | D `AdmissionLimits`(검증 값), A `RequestAdmission`(3단계). `Semaphore`+`Duration` |
| (b) 승인 요청 보관 한도 | `requestCapacity`(기본 100, `BRIDGE_REQUEST_CAPACITY`, `approval-queue.mjs:23`, `settings-contract.json:9`) | 일반 `Queue full`(`:52`) — 코드가 없다 | D `ApprovalPolicy.admit`. `[제안]` 신규 코드 `REQUEST_CAPACITY_EXCEEDED`(D-0038 코드 분리, 12절 D-07) |
| (c) 내구 실행 대기열 | 전역 동시 2·대상 동시 1·큐 32·대상 큐 32·unknown 예산 32(`operation-scheduler.mjs:4`). 설치 기본 `queue=cpus*10`, `concurrency=cpus`(`config/capacity.mjs:5-8`). `unknownBudget` 기본 `max(32, 전역 동시)`(`operation-scheduler.mjs:22`) | `OPERATION_QUEUE_FULL`(`:124`), `OPERATION_RECONCILIATION_CAPACITY`(`:126`), `INVALID_OPERATION_CLAIM_LIMIT`(`operation-store.mjs:250`) | D `ConcurrencyLimits`·`OperationScheduler` |
| (d) 프로세스 claim(옛 방식) | `createClaims(limit, maxWaiting 32)`(`target-router.mjs:5-48`) | `Global concurrency limit reached`, `EXECUTION_QUEUE_FULL`(`:35` 기준 `application` 코드) | `[제안]` 3.0은 (c)의 DB 상태로 대체한다. 메모리 카운터는 8.15(singleton 가변 필드)에 해당해 두지 않는다 |

### 3.2 스케줄러는 판정만 한다 [제안]
- `OperationScheduler`(D)는 상태 없는 정책 객체다. 입력 `SchedulingView`(record): 대기 중 작업 목록(준비 순서 오름차순 `readySequence`), 대상별 활성 수, 전역 활성 수, 전역 `unknown` 수(이전된 legacy 제외 `operation-store.mjs:255`), 대상별 마지막 시작 시각, 펜스에 걸린 `(targetId, targetRevision, conflictKey)` 집합, `ConcurrencyLimits`, `Instant now`. 출력 `SchedulingDecision`(sealed): `Claim(OperationId, long expectedVersion)`, `ExpireQueued(List<OperationId>)`, `Idle`, `Saturated(SaturationReason)`(`GLOBAL_CONCURRENCY`·`TARGET_CONCURRENCY`·`UNKNOWN_BUDGET`·`CONFLICT_FENCE`).
- `[사실]` 2.x의 공정성은 메모리 링 `ring`이다(`operation-scheduler.mjs:12, 85-105`): 준비된 대상을 한 바퀴 돌며 대상마다 FIFO 후보 하나를 claim 시도하고, 후보가 막히면 같은 `conflictKey`가 펜스에 걸린 경우만 다음 후보로 넘어간다(`:94-101`). 후보를 못 얻는 대상이 한 바퀴 내내 이어지면 멈춘다(`:90, 102`).
- `[제안]` 링 상태를 싱글턴 가변 필드로 두면 8.15에 걸린다. 공정성을 데이터로 계산한다: 후보 대상 중 `lastStartedAt`이 가장 오래된 대상(없으면 가장 앞선 `readySequence`) 순으로 시도한다. 재시작에도 같고 동시에 두 번 돌려도 같은 결과다. 시험(B-186)은 대상 3개 균형·한 대상 고갈 사례로 2.x와 같은 관찰 결과를 확인한다. 결정 D-05.
- 만료: 대기 중 `expiresAt <= now`는 `ExpireQueued`(`operation-scheduler.mjs:83`), claim 직후 `expire`(T10). `[제안]` `@Scheduled(fixedDelay)`는 3단계 `OperationDispatcher`가 연다. `Thread.sleep` 폴링이 아니라 만료 시각으로 다음 실행을 잡는다(안티패턴 D3, 계획 「이벤트로 깨운다」).

### 3.3 동시성은 무엇을 어디에 두는가 [제안, 2.x 근거 병기]
| 일 | 도메인(순수) | 저장 계층 | 근거 |
|---|---|---|---|
| 전이 유효성(2.3·2.4) | `Operation`·`OperationState#canMoveTo` | 열 CHECK는 값 집합만 보장 | `operation-store.mjs:157` |
| 같은 작업의 동시 변경 | — | `@Version`, 충돌 시 재조회·재판정 | `:142-144` |
| 요청 키 중복 접수 | 계약 digest 비교(`Operation#sameContractAs`) | `UNIQUE(request_key)`, `DuplicateKeyException` | `:170-174` |
| claim 한도(전역·대상·unknown 예산) | `OperationScheduler.select`가 후보를 고름 | `OperationJournal.claim`이 **한 트랜잭션에서 개수를 다시 세고** `@Version` 갱신 | `operation-store.mjs:248-259`(`BEGIN IMMEDIATE`) |
| conflictKey 펜스 | `SchedulingView.fenced` 판정 | 위 같은 트랜잭션에서 `existsBy…` 조회. 대안: `operation_fence` 표 PK(8.2의 O-2) | `operation-store.mjs:257` |
| 승인 접수의 감사 순서 | `ApprovalPolicy`가 단계 순서를 정함 | 감사 파일 기록 → 트랜잭션 커밋 순(파일 I/O를 트랜잭션 밖으로, 개발원칙 4.4) | `approval-queue.mjs:60-62` |
| 알림(관찰자 깨움) | — | `AFTER_COMMIT` 이벤트 | `operation-scheduler.mjs:27-30` |

- `[제안]` claim은 `@Transactional(isolation = Isolation.SERIALIZABLE)`로 선언하고, 이 서비스는 단일 스케줄러 스레드(`TaskScheduler` 풀 크기 1)에서만 호출한다. 두 겹으로 막는 이유: 하나의 앱 인스턴스가 하나의 DB를 소유한다는 2.x 가정(`feature-map` store 행 「다중 인스턴스 비지원」)이 깨져도 `@Version`이 중복 claim을 막는다. `[미확인]` H2 2.x의 SERIALIZABLE이 「개수 세기 후 갱신」 쓰기 왜곡을 막는지 H2 공식 문서로 확인하지 못했다(구현 담당이 https://h2database.com/html/advanced.html 의 Transaction Isolation 절 확인). 확인되지 않으면 O-2(`operation_slot` 표 PK)로 바꾼다.
- `[제안]` 요청 입장(층 a)은 DB를 쓰지 않는다. 프로세스 지역 `Semaphore` 기반 빈(3단계). 층 (b)는 `ApprovalPolicy.admit(OperationCounts, Capacity)` 판정만 도메인에 둔다.

### 3.4 유지보수 예약 중 접수 거절 [사실 + 제안]
- `[사실]` 유지보수 중 `submitOperation`은 `MAINTENANCE_ACTIVE`(`retryable:true`, `executionAttempted:false`)로 거절(`approval-queue.mjs:50`). 예약이 켜지는 순간 `queued` 작업은 `failed`(`dispatchFailureReason:'maintenance'`)(`:32-37`). 예약 조건: 이미 유지보수 중이거나 `queued·running` 작업이 있거나 `pending·evaluating·queued`가 하나라도 있으면 거절(`:97-99`). 파일 서비스도 `Maintenance or file service closed`(`files.mjs:20`).
- `[제안]` `ApprovalPolicy.admit(...)`가 `MaintenanceState`(sealed: `Open`·`Reserved`)를 받아 `Admission`(sealed: `Accepted`·`RejectedMaintenance`·`RejectedCapacity`)을 돌려준다. 유지보수 상태는 `MaintenanceStore`(A 포트, S 구현)가 DB 한 행으로 보관한다(재시작 후에도 유지, 8.3). 예약 가능 조건은 `MaintenancePolicy.canReserve(OperationCounts)`가 판정한다.

### 3.5 자동 승인 조건 [사실, `command-automation.mjs`]
자동 승인은 「실행 결정(`DecisionKind`)」을 만든다. 결정 사유(`DecisionReason`)와 자동 여부는 아래가 전부다(`:148`: `['command_set','model_passed','test_server_bypass']`만 자동).

| 순서 | 조건 | 사유(wire) | 결정 | 근거 |
|---|---|---|---|---|
| 1 | 대상 규칙 없음이 아니고, 정책에 거부 이름이 있고 시험 서버 우회가 아님 | `policy_denied` | `deny` → `DENIED` | `:134-135` |
| 2 | `testServer == true` | `test_server_bypass` | `execute`(자동) | `:138` |
| 3 | 소스 작업이고 `sourceExecutionContract != 'python-source-v1'` / `automaticSudo != true` / 거부 이름 존재 | `source_execution_not_enabled` / `source_privilege_policy_review` / `source_command_policy_review` | `review` | `:19-21, 139` |
| 4 | POSIX에서 `sudo` 사용인데 `automaticSudo != true` | `sudo_not_enabled` | `review` | `:140` |
| 5 | 문법이 완전(`complete`)하고 모든 이름이 승인 목록에 있음(`sudo`는 `automaticSudo`) / Windows는 `explicitUserApproval` | `command_set` | `execute`(자동) | `:141` |
| 6 | 그 밖: 모델 평가(`assess`) | 아래 7~15 | | `:37-103` |
| 7 | 정책의 `externalDisclosure != true` | `disclosure_not_enabled` | `review` | `:39` |
| 8 | 호출자 context가 비었음 | `context_required` | `review` | `:40` |
| 9 | 명령이 민감(`sensitiveText`) | `sensitive_input` | `review` | `:41` |
| 10 | 소스 증거가 평가 한도 초과 | `source_evidence_too_large` | `review` | `:48` |
| 11 | 호출 예산(`maxCalls` 기본 100, `BRIDGE_JEV_MAX_CALLS`) 소진 | `budget_exhausted` | `review` | `:59, 71` |
| 12 | 평가 도중 정책·대상이 바뀜(동의 철회) | `policy_changed` | `review` | `:66-70, 78` |
| 13 | 모델 응답 무효 또는 시간 초과(10초) | 시도 실패 후 폴백, 모두 실패 | `evaluation_unavailable` | `:76, 80-83, 103` |
| 14 | 유효 응답: `label==low_risk` 이고 `low_risk 확률 ≥ minLowRisk`이고 임곗값의 모델·질문 버전·basis가 모두 일치 | `model_passed` | `execute`(자동) | `:87-102` |
| 15 | 위 AND 조건 중 하나라도 실패 | `model_review`(또는 `observation_only`: 실행 비활성·임곗값 없음) | `review` + `reviewReason` | `:87-102` |

- `[사실]` 유효한 위험 응답이 나오면 그 결과가 최종이다. 두 번째 의견을 구하지 않는다(`:85` 주석 「never shop for a second opinion」). 폴백 평가기는 주 평가기가 「사용할 수 없음」일 때만 돈다(`:55-84` 반복, `continue` `:83`).
- `[사실]` 결정 사유 전체(20종): `policy_denied, test_server_bypass, source_execution_not_enabled, source_privilege_policy_review, source_command_policy_review, sudo_not_enabled, command_set, disclosure_not_enabled, context_required, sensitive_input, source_evidence_too_large, budget_exhausted, policy_changed, evaluation_unavailable, model_passed, model_review, observation_only, evaluation_failed, execution_busy, execution_start_failed`(`:134-159`의 모든 `reasonCode`). 검토 사유 6종: `execution_disabled, threshold_missing, model_mismatch, question_mismatch, basis_mismatch, below_threshold`(`:91-96`) + 라벨 값 `high_risk`.
- `[제안]` D의 `AutomaticApprovalPolicy`(상태 없음)가 위 표를 한 메서드 `ApprovalDecision decide(ApprovalInput input)`로 구현한다. 입력 `ApprovalInput`: `CommandText`, `TargetRule`(없으면 `NoRule` sealed), `CommandLineAnalysis`(문법 결과, 6.3절), `CallerContext`, `EvaluationResult`(sealed: `NotEvaluated`·`Evaluated(SafetyAssessment, provider, threshold)`·`EvaluationFailed(attempts)`). 모델 호출 자체(Jev)는 A 포트 `RiskEvaluator`(3단계)다. 판정 순서(표의 순서)와 경계값(`≥`)을 시험이 못 박는다(A-420: 0.9 경계 포함).
- `[제안]` 파일 업로드·다운로드 자동 정책(`automaticUploads/Downloads`)과 `testServer`의 파일 정책 우회(D-0002)는 `TargetRule`의 필드를 읽는 별도 판정(`FileAutomationPolicy`)이며 유스케이스(3단계)가 쓴다. 이 2단계는 `TargetRule`에 필드만 둔다.

### 3.6 시간 [제안]
- 도메인의 시간 판정은 두 가지 방식만 쓴다: (1) `Instant`를 인자로 받는 값 메서드(`Operation.expire(at)`, `Deadline.isReached(at)`), (2) 정책 객체가 생성자로 받은 `java.time.Clock`(`ApprovalPolicy`, `OperationScheduler`). A-TIME이 `Instant.now()`·`ZoneId.systemDefault()`·`Date`를 막으므로 정책 객체는 `clock.instant()`만 쓴다. 한 유스케이스가 시각을 한 번 읽어 `Instant`로 전이에 넘기는 쪽을 기본으로 한다(결정 D-06).
- `[사실]` 2.x 상수: 승인 만료 1시간(`ports.mjs:5`), artifact TTL 10분(`:4`), 출력 TTL 1시간(`command-output.mjs:8`). `[제안]` `Duration` 상수로 소유 타입에 둔다(`ApprovalPolicy.VALIDITY`, `ArtifactRetention.UPLOAD_TTL`, `OutputRetention.TTL`).

---

## 4. 값 객체와 결과 타입

### 4.1 규칙 [제안, 개발원칙 3.0·3.3 근거]
- 값 객체는 불변 `record`이고 불변식은 compact constructor에서 검사한다. 실패는 `IllegalArgumentException`(프로그래밍 오류) 또는 계약 오류가 되는 경우 `RequestRefusedException`(5.5절)이다.
- `Optional`은 메서드 반환 타입에만 쓴다. `record` 구성요소·필드·매개변수·컬렉션 요소에는 쓰지 않는다(A-OPTIONAL-SLOT). 없는 값은 sealed 변형(`NoDeadline` 등)이나 enum(`NOT_DECIDED`)으로 모델링한다.
- 「없음·미지원·미확인」이 갈라지는 계약은 sealed 결과로 답한다(4.9절). 그 밖의 「찾았지만 없음」 한 가지 뜻뿐인 조회만 `Optional<T>`를 돌려준다.
- 정규식은 타입의 `private static final Pattern`으로 한 번 컴파일한다(개발원칙 5.1). 이는 상수이지 업무 판정 `static`이 아니다(11절).
- 문자열 비교는 `"상수".equals(변수)`·`Objects.equals`, enum 비교는 `==`.
- 도메인은 JDK와 `com.fasterxml.jackson.annotation`만 쓴다(A-DOMAIN). 그래서 JSON 파싱·직렬화는 도메인에 없다(5·6절의 JSON 리소스는 A 모듈의 `@Component`가 읽는다).

### 4.2 식별·다이제스트·텍스트 값

| 타입(패키지) | 구성요소 | compact constructor 불변식 | 2.x 근거 |
|---|---|---|---|
| `OperationId`(`id`) | `String value` | `^[a-f0-9]{48}$`. 생성은 `OperationIdGenerator`(D 클래스, 생성자로 `SecureRandom` 주입): 무작위 24바이트를 `HexFormat.of().formatHex`. UUID가 아니다(CHAR(48), 8.1절) | `validation.mjs:6`, `approval-queue.mjs:23`, `public-contract.mjs:7` |
| `ArtifactId`(`id`) | `String value` | 〃(같은 48 hex, 별도 타입) | `artifacts.mjs`(`id=randomBytes(24)`), `public-contract.mjs:7` |
| `ArtifactUuid`(`id`) | `UUID value` | 버전 4, 변종 `[89ab]`, 정규 소문자 문자열과 일치(`toString().equals(원문)`) | `artifacts.mjs:15`, `public-contract.mjs:12` |
| `RequestKey`(`id`) | `String value` | `^[A-Za-z0-9_.:-]{16,128}$` 전체 일치. 정규식 `$`가 아니라 전체 일치로 끝의 CR/LF를 거절한다 | `public-contract.mjs:10-11` |
| `TargetId`(`id`) | `String value` | `^[a-z][a-z0-9_-]{0,31}$` | `public-contract.mjs:9`, `targets.mjs:5` |
| `OwnerId`(`id`) | `String value` | 1~512자, 제어 문자(`\x00-\x1f\x7f`) 없음 | `artifacts.mjs:16` |
| `Digest`(`id`) | `String hex` | 정확히 64자 소문자 hex. 정적 생성 `Digest.of(byte[] 32바이트)`는 `HexFormat`으로 | `validation.mjs:5`, `public-contract.mjs:8` |
| `TargetRevision`(`target`) | `Digest value` | `Digest`와 같음(의미 구분용) | `public-contract.mjs:8` |
| `FileName`(`file`) | `String value` | 1~255자, 제어 문자·`/`·`\` 없음 | `artifacts.mjs:36-37` |
| `Utf8Text`(`text`) | `String value` | 정형 문자열(짝 없는 서로게이트 없음) — `value.isWellFormed()`는 JDK 24+이므로 Java 25에서 그대로 쓴다. `byteLength()`는 UTF-8 인코딩 길이 | `ports.mjs:11-12` |
| `CommandText`(`text`) | `Utf8Text` | UTF-8 ≤ 32768B, `trim()` 후 비어 있지 않음, `\r\n`·`\n`·`\t`를 뺀 뒤 「숨은 문자」(`[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]`) 없음 | `validation.mjs:4, 11-12` |
| `SourceText`(`text`) | `Utf8Text` | 1자 이상, ≤ 16384B, NUL 없음 | `ports.mjs:9`, `execution-context.mjs:36` |
| `CallerContext`(`command`) | `Utf8Text`, 빈 값 허용 | ≤ 8192자, NUL 없음, 자격 증거 정규식(`-----BEGIN`·`Bearer `·`(api_key\|password\|secret\|token)\s*[=:]`)에 걸리지 않음. 단 `secret://provider/name` 참조는 허용 | `execution-context.mjs:4, 8-20, 40-45` |
| `Deadline`(`operation`) | sealed `NoDeadline` · `DeadlineAt(Instant)` | `DeadlineAt`은 생성 시각보다 뒤이고 접수 시각 + 1시간 이하 | `approval-queue.mjs:56` |

- `[사실]` 서로 다른 「한도」 값이 한 곳에서 단위가 섞여 있다. `utf8WithinLimit`은 UTF-16 길이도 한도 이하여야 한다(`ports.mjs:12`: `value.length <= maxBytes`). UTF-8 바이트 수가 UTF-16 길이 이상이므로 이 조건은 UTF-8 한도에 이미 포함된다. `[제안]` Java는 UTF-8 바이트 검사만 두고, 이 점을 시험 사례(B-074의 32KiB 경계)로 확인한다.
- `[제안]` 해시 계산은 도메인 interface `Digester`(`Digest digest(byte[] data)`) 한 곳에서 한다. 구현 `Sha256Digester`는 JDK `MessageDigest`를 호출마다 새로 만든다(스레드 안전, 개발원칙 3.7). 도메인 안에 업무 판정 `static` 해시 도우미를 두지 않는다. `Digester`를 쓰는 값(`TargetRevision.of`, `OperationContract.digest`, `AgentCliIntent`)은 인자로 받는다. 구현 `Sha256Digester`도 평범한 클래스이고, 스프링 빈 등록은 A 모듈 `@Configuration`의 `@Bean`으로 한다(portal-domain에 Spring 어노테이션을 못 붙이는 경우의 정당한 `@Bean` 사유, 개발원칙 3.1).

### 4.3 원격 경로: `RemotePath` sealed [사실 + 제안]
```java
public sealed interface RemotePath permits PosixRemotePath, WindowsRemotePath {
    String value();
    String basename();
    static RemotePath parse(String text);   // 구문으로 고른다: ^[A-Za-z]: 이면 Windows, 아니면 POSIX (validation.mjs:37-40)
}
public record PosixRemotePath(String value) implements RemotePath { /* compact ctor */ }
public record WindowsRemotePath(String value) implements RemotePath { /* compact ctor */ }
```
- `PosixRemotePath` 불변식 `[사실: validation.mjs:25-28]`: `/`로 시작, `/` 단독 아님, 길이 ≤ 4096, 앞뒤 공백 없음(`value.equals(value.strip())` — JS `trim`은 유니코드 공백도 제거하므로 `strip()`을 쓴다), 숨은 문자 없음, `/`로 나눈 조각 중 `.`·`..` 없음(빈 조각은 허용: `//`는 통과). `basename()`: 끝의 `/`를 모두 제거하고 마지막 조각(`:42-46`).
- `WindowsRemotePath` 불변식 `[사실: :30-35]`: `^[A-Za-z]:[\\/]` 시작, 길이 ≤ 4096, 앞뒤 공백 없음, 숨은 문자 없음. 3번째 글자 이후를 `[\\/]`로 나눠 각 조각이: 비어 있지 않음, `.`·`..` 아님, `<>:"|?*` 없음, 끝이 공백·`.`이 아님, 예약 장치 이름 아님(`(?i)^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)`). `basename()`은 `[\\/]`로 나눈 마지막 조각.
- `[제안]` 왜 `java.nio.file.Path`가 아닌가: 이 값은 서버 파일 시스템의 경로가 아니라 **원격 대상**의 경로이고, Linux 서버가 Windows 대상의 `C:\x`를 다뤄야 한다. `Path`는 「typically represent a system dependent file path」(JDK `Path` API, 개발원칙 1.2 표)로 실행 중인 OS의 구문만 안다. 그래서 대상 쪽 구문 검증은 위 정규식(`Pattern` 상수)이 한다. OS 판별은 없다(A-OS). 이 이유를 클래스 Javadoc에 적는다(개발원칙 2.1 5항). 로컬 서버의 파일 경로(artifact 저장 폴더)는 `Path`·`Files`만 쓴다.
- `[제안]` 대상이 어느 구문을 쓰는지는 `TargetPlatform#pathSyntax()`(7.3절)가 `PathSyntax`(enum `POSIX`·`WINDOWS`)로 답하고, 호출 쪽이 `PosixRemotePath.of`·`WindowsRemotePath.of`를 고른다. `RemotePath.parse`는 staged 파일처럼 「어느 대상의 경로인지 아직 모르는」 경계에서만 쓴다(`artifacts.mjs`의 `anyRemotePath`).
- 사례: B-580(허용·거부·basename), B-581(기존 POSIX 보존), 신규 S2-N-RP-xx(예약 이름·곡선 따옴표 없는 경계 등).

### 4.4 용량·원점·호스트 패턴

| 타입 | 구성요소·불변식 | 2.x 근거 |
|---|---|---|
| `Capacity`(`capacity`) | `int value`, `value >= 1`. 정적 생성 `Capacity.parse(String)`: `^[1-9][0-9]*$`(범위 밖 숫자는 `NumberFormatException`을 `IllegalArgumentException`으로 감쌈) | `capacity.mjs:1-9` |
| `CapacityDefaults`(`capacity`) | `int availableCpus`(≥1). 메서드 `queueCapacity()`(= cpus × 10), `maxConcurrency()`(= cpus) | `config/capacity.mjs:5-8` |
| `AdminOrigin`(`origin`) | `String value`. 4096바이트 이하, `^https://(?:\[[0-9a-f:]+\]\|[a-z0-9._-]+)(?::[1-9][0-9]{0,4})?$`, 포트 1~65535, `java.net.URI`로 파싱한 `scheme://authority`가 원문과 같음(경로·쿼리·사용자 정보 없음), `xn--` 라벨은 `IDN.toUnicode`→`IDN.toASCII`가 원문과 같음 | `settings.mjs:13-28`, `settings-contract.json:40-41` |
| `UploadHostPatterns`(`host`) | `List<UploadHostPattern> values`(순서 보존, 중복 제거). 입력 문자열 ≤ 65536바이트, 개행·NUL 금지, 빈 문자열은 빈 목록, `,`로 나눠 `strip`·`toLowerCase(Locale.ROOT)` | `upload-hosts.mjs:19-23` |
| `UploadHostPattern`(sealed) | `ExactHost(String)` · `WildcardSuffix(String)`. 라벨 `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`, 전체 ≤ 253자, 와일드카드는 선행 `*.`이고 나머지에 `.`가 있어야 함. **숫자 IP 별칭 거절**: 마지막 라벨이 모두 숫자이거나 `0x`로 시작하는 16진이면 거절(WHATWG 「ends in a number」 검사). 매칭 메서드 `matches(String host)`: 정확 일치 또는 `host.endsWith(접미사)`이고 더 긺 | `upload-hosts.mjs:6-17, 25-27` |

- `[사실]` 공유 벡터가 기준본에 있다: `contract/settings/settings-contract.json`의 `originVectors`(42행~), `uploadHostVectors`(81행~, `127.1`·`2130706433`·`0x7f000001`·`0177.0.0.1`·`files.123` 거절 포함), `uploadHostMatchVectors`(108행~), `portVectors`(117행~). 사례 B-887·B-888·B-889·B-891이 이 벡터를 쓴다. 3.0 시험은 같은 JSON을 읽어 모든 벡터를 대조한다(기준본 파일은 portal-web 시험 리소스, 도메인 시험은 Gradle `sourceSets.test.resources.srcDir`로 그 폴더를 가리킨다 — 복사본을 만들지 않는다).
- `[미확인]` Java에는 WHATWG URL 파서가 없다. 「ends in a number」 규칙은 URL Standard(https://url.spec.whatwg.org/#ends-in-a-number-checker)의 규칙인데 이번에 원문을 열지 못했다. 구현 담당은 위 벡터가 모두 통과하는지로 확인하고, 통과하지 않는 벡터가 있으면 규칙을 원문과 대조해 고친다. `java.net.IDN`은 IDNA2003이라 UTS46인 WHATWG와 드물게 다르다 — `originVectors`의 퓨니코드 벡터가 판정한다.

### 4.5 `Target` · `TargetRevision` · 접속 프로파일 [사실 + 제안]
- `Target`(record, 관리자가 정한 시작 설정 한 줄): `TargetId id`, `DisplayName displayName`(`strip` 후 1~80자, 제어·서식·줄 구분 문자 `\p{Cc}\p{Cf}\p{Zl}\p{Zp}` 없음), `ProfileAlias readProfile`, `ProfileAlias writeProfile`(둘은 달라야 함), `ProfileAlias credentialRevision`(`^[a-z][a-z0-9_-]{0,31}$`), `Toggle enabled`(`ON`/`OFF`, 기본 `ON`), `TargetOs os`(`LINUX`·`WINDOWS`, wire `linux`·`windows`, 기본 `LINUX`), `WindowsRuntime windows`(sealed `NoWindowsRuntime`·`WindowsRuntimeSettings(WindowsDirectory workdir, WindowsPythonExecutable python)` — Windows가 아니면 `NoWindowsRuntime`만 허용), `CapacityOverride queueCapacity`·`maxConcurrency`(sealed `Inherited`·`Explicit(Capacity)`), `DesktopSettings desktop`(sealed 아래).
  - `[사실]` 허용 키 12개: `id, displayName, readProfile, writeProfile, credentialRevision, enabled, platform, workdir, pythonExecutable, queueCapacity, maxConcurrency, desktop`(`targets.mjs:24`). Windows 전용 키(`workdir`·`pythonExecutable`)는 Windows 대상에서만(`:28-30`). `pythonExecutable`은 `[\\/]python(?:\d+(?:\.\d+)*)?\.exe$`(대소문자 무시)(`:33`). `workdir`은 `^[A-Za-z]:[\\/]$`(드라이브 루트) 또는 `WindowsRemotePath`(≤512바이트, `:7-11`).
  - `DesktopSettings`(sealed, `targets.mjs:37-54`): `AttachedRfb(port 1..65535, GeometrySetting)` · `ManagedXvnc(GeometrySetting)`(Windows 대상 불가) · `Rdp(SecretReference credentialRef, GeometrySetting)`(Windows 대상만). 해상도 `width·height` 320~4096 정수, 곱 ≤ 4194304, 기본 1280×720. `DesktopSettings`는 `NoDesktop`·`Disabled(backend)` 변형도 가진다(`enabled` 필드).
- `ConnectionProfile`(record): `String host`, `int port`, `String user`, `HostKeyPin pin`(`NoPin`·`PinnedKey(String)`), `ProfileAlias via`(점프, sealed `NoJump`·`JumpVia`), `AuthMethod auth`(enum), `CredentialRef keyRef`, `AccessMode access`(`READ_ONLY`·`READ_WRITE`), `TtyMode tty`(`TTY`·`NO_TTY`).
  - `[사실]` `resolveTargets`의 조건(`targets.mjs:62-82`): reader는 읽기 전용·writer는 쓰기 가능, 두 프로파일의 `host, port, user, trustedHostKey, via, auth, keyRef, keychainEntry`가 같음(명시 대상일 때, 기본 대상은 `host, port, user`만), 명시 대상은 `trustedHostKey`가 필수, Windows 대상은 프로파일 `workdir`·`tty=true` 금지.
  - `[제안]` 2.x는 이 프로파일을 vendor ssh-mcp의 레지스트리에서 읽었다. 3.0에는 그 레지스트리가 없고(feature-map: vendor ssh-mcp 삭제), 프로파일의 출처는 3단계 portal-ssh·portal-server가 정한다. 2단계는 `ConnectionProfile`을 **값 타입과 조건 검사(`ResolvedTarget.of(Target, reader, writer, Digester)`)까지만** 정의한다.
- `TargetRevision.of(Target, ConnectionProfile reader, ConnectionProfile writer, Digester)`:
  - `[사실]` 2.x는 `SHA-256(JSON.stringify({entry, reader, writer}))`(`targets.mjs:74`) — JS 객체 키 삽입 순서에 의존하는 형식이다. 입력 `reader`·`writer`가 2.x의 레지스트리 형식이라 Java가 같은 바이트를 만들 수 없다.
  - `[제안]` Java는 고정 순서의 줄 형식(`필드명=길이:값\n`, UTF-8)을 `CanonicalForm` 값 객체가 만들고 그 바이트를 `Digester`로 해시한다(JSON이나 Jackson이 아님). 2.x revision과는 달라진다 → 이전 작업 이력의 `target_revision`은 `legacy-unbound`로 남기고 관찰 시 `TARGET_REVISION_CONFLICT`가 나는 2.x 규칙(`operations.mjs:61, 66`)을 이전 이력에는 적용하지 않는 처리가 7단계에서 필요하다. 결정 D-09.
  - 불변식: 크레덴셜 값 자체는 revision 입력이 아니다(참조 이름만). 순환·재시작에서도 같은 입력이면 같은 revision(결정적). 시험: 필드 하나만 바뀌어도 revision이 바뀜, 필드 순서·공백이 같으면 같음.

### 4.6 다른 절에 있는 값 타입
`ExecutionContext`·`CommandPolicy` 입력 값은 6절, `DesktopBinding` 등은 6.7절에 있다.

### 4.7 실패 타입 [사실 + 제안]

**DispatchFailure**(`failure`, 외부 효과가 시작되기 전의 진단) `[사실: dispatch-failure.mjs]`
```java
public sealed interface DispatchFailure permits DispatchFailure.Refused, DispatchFailure.StepFailed, DispatchFailure.Unclassified {
    DispatchReason reason();   DispatchStage stage();
    record Refused(DispatchReason reason, DispatchStage stage) implements DispatchFailure {}      // dispatchRefusal :14-19
    record StepFailed(DispatchStage stage, DispatchReason reason) implements DispatchFailure {}   // dispatchStep :5-12
    record Unclassified() implements DispatchFailure {}                                           // unknown/unknown :20-23
}
```
- `DispatchReason`(15): `unknown, maintenance, request_state, authority, invalid_command, private_plan, target_changed, policy_changed, policy_denied, plan_expired, busy, queue_full, claim_failed, audit_failed, persistence_failed`(`:3`).
- `DispatchStage`(19): `unknown, maintenance, request_state, authority, command_validation, command_guard, file_guard, source_plan, target_guard, cli_guard, policy_guard, busy_check, execution_queue, execution_claim, decision_persistence, decision_audit, evaluation_persistence, start_audit, start_persistence`(`:4`).
- 이유·단계 짝의 허용 표를 둔다(`:5-19`의 호출처에서 쓰이는 짝만): 시험이 `DispatchFailure.Refused`·`StepFailed` 생성 시 목록 밖 짝을 거절하는지 확인한다(2.x는 두 집합에 속하는지만 검사 `:6, 15`). 이 표는 구현 담당이 `approval-queue.mjs`·`command-automation.mjs`의 모든 `dispatchRefusal`/`dispatchStep` 호출에서 뽑아 `DispatchFailurePairs`(enum 중첩 데이터)로 둔다.
- 예외 본문·임의 속성은 진단이 아니다 `[사실: :1-2]` → `[제안]` `DispatchRefusedException(DispatchFailure failure)`의 메시지는 고정 문장이고 원인 예외는 `cause`로만 보관한다. 외부에 나가는 것은 `failure.reason()`·`stage()`뿐이다.
- 결과 저장: `decision.dispatchFailure = 'not_dispatched'` + `dispatchFailureReason/Stage`(`approval-queue.mjs:216, 261`). `[제안]` `operation_result`의 두 enum 열(8.2절).

**ExecutionFailure**(`failure`, 외부 효과 뒤의 진단) `[사실: execution-failure.mjs]`
```java
public sealed interface ExecutionFailure permits ExecutionFailure.Classified, ExecutionFailure.Unclassified {
    record Classified(ExecutionStage stage, ExecutionErrorCode code, RemoteOutcome remoteOutcome) implements ExecutionFailure {}
    record Unclassified() implements ExecutionFailure {}  // stage=operation, code=OPERATION_FAILED, remoteOutcome=unknown (:6)
}
```
- `ExecutionStage`(6): `ssh_connect, ssh_channel, ssh_execution, output_reservation, output_capture, operation`(`:3`). `ExecutionErrorCode`(7, 5.3절): `SSH_CONNECT_FAILED, SSH_CHANNEL_OPEN_FAILED, SSH_EXECUTION_FAILED, OUTPUT_CAPACITY, OUTPUT_CAPTURE_FAILED, OPERATION_FAILED, ARTIFACT_QUOTA`(`:4`). `RemoteOutcome`(3): `not_started, unknown, completed`(`:5`).
- 불변식: 자동 재전송은 항상 `false`이므로 필드가 없다(상수). 단계·코드 짝(`SSH_CONNECT_FAILED`↔`ssh_connect` 등)을 `Classified`의 compact constructor가 검사한다. 2.x는 짝을 검사하지 않았다(`:12`) — `[제안]` 짝 표: `SSH_CONNECT_FAILED`→`ssh_connect`, `SSH_CHANNEL_OPEN_FAILED`→`ssh_channel`, `SSH_EXECUTION_FAILED`→`ssh_execution`, `OUTPUT_CAPACITY`→`output_reservation`, `OUTPUT_CAPTURE_FAILED`→`output_capture`, `OPERATION_FAILED`→`operation`, `ARTIFACT_QUOTA`→`output_reservation`·`operation` 중 하나. `ARTIFACT_QUOTA`의 짝은 2.x에서 확인하지 못했다(`[미확인]`, 구현 담당이 `artifacts.mjs`의 던지는 자리에서 확인).
- D-0009·D-0010 연결: 실제 오류 문구를 일반 문구로 바꾸지 않는다 `[사실]`(VERIFIED). `ExecutionFailure`는 문구를 담지 않고 enum만 담으므로 「실제 오류 문구」는 `ExecutionResult.diagnostic`의 허용 목록 필드(`origin, policyReason, nativeStep, nativeError`)로 따로 전달한다(5절 `Diagnostic`). 60초 종료(D-0010)는 `ExecutionReason.DEADLINE`+`timeoutMs`로 보고한다.

**실행 결과 `ExecutionOutcome`**(`operation`) `[사실: operation-store.mjs:261-269, public-contract.mjs:24-33]`
- 입력 `Settle`용 값. `record ExecutionOutcome(ExecutionReason reason, RemoteState remoteState, ExitStatus exit, SignalDelivery signalDelivery, Phase phase, CleanupState cleanup, Reconciliation reconciliation, OutputState outputState, CaptureState capture, TimeoutMs timeout, StreamMetadata stdout, StreamMetadata stderr, ExecutionFailure failure, ResultFlag failed, List<String> texts, CompletionEvidence evidence)`.
  - `ExecutionReason`: `exit, deadline, cancel, transport_lost, channel_open_failed, input_failed`. `RemoteState`: `not_dispatched, exited, unknown`. `Phase`: `settled`. `OutputState`: `partial, complete`. `SignalDelivery`: `requested, unsupported`(또는 없음 → sealed `NoSignal`). `ExitStatus`(sealed): `Exited(int code)` · `Signaled(String name)`(`^[A-Z0-9_-]{1,32}$`) · `NoExit`.
  - `cleanup`·`reconciliation`·`capture`는 `boolean` 대신 enum(`CleanupState.COMPLETE/INCOMPLETE`, `Reconciliation.REQUIRED/NOT_REQUIRED`, `CaptureState.FAILED/OK`).
  - `[사실]` 2.x는 필드마다 허용 값을 다시 검증해 표시한다(`presentExecution`, `public-contract.mjs:34-40`: 맞지 않는 필드는 `null`). `[제안]` 3.0은 생성 시점에 한 번 검증하고(compact constructor) 표시 단계에서는 다시 검증하지 않는다. 저장된 값(DB enum 열 + CHECK)은 이미 유효하다.

### 4.8 예외 계층 [제안, 개발원칙 3.4]
```java
public sealed abstract class PortalException extends RuntimeException
        permits RequestRefusedException, DispatchRefusedException, ExecutionFailedException { ... }
public final class RequestRefusedException extends PortalException { ErrorCode code; boolean retryable; ExecutionAttempt attempt; }
public final class DispatchRefusedException extends PortalException { DispatchFailure failure; }
public final class ExecutionFailedException extends PortalException { ExecutionFailure failure; }
```
- `ExecutionAttempt`(enum `NOT_ATTEMPTED`·`ATTEMPTED`·`UNKNOWN`) — wire는 `false`·`true`·`"unknown"`(`public-contract.mjs:73`). `@JsonValue Object wire()`로 `Boolean`/`String`을 돌려준다.
- 2.x `error.retryable`·`error.accepted === false`·`executionAttempted`(`public-contract.mjs:162-168`) 산식을 예외 필드로 옮긴다: `retryable`은 코드가 `ARTIFACT_MAINTENANCE`이거나 예외가 명시한 경우, `executionAttempted`는 명시값이 있으면 그것, 없고 「접수되지 않음」이거나 문구 매핑이 있으면 `false`, 그 밖은 `"unknown"`. 3.0은 「문구→코드 매핑」(`transferRefusals`) 자체를 없앤다(각 던지는 자리가 자기 코드를 가진다). 이 24행 매핑은 계약 시험 입력표(시나리오 → 기대 코드)로만 남는다.
- 모든 업무 실패는 `PortalException`의 한 변형이다. 프로그래밍 오류(`null` 인자 등)는 `Objects.requireNonNull`·`IllegalArgumentException`(개발원칙 3.4).

### 4.9 「없음·미지원·미확인」을 갈라 답하는 자리 [제안, 개발원칙 3.3, 벤더 비종속 원칙 「지원 능력과 미지원 처리」]

| 조회·결과 | sealed 변형 | 2.x에서 뭉쳐 있던 모습(근거) |
|---|---|---|
| 대상 선택 | `TargetLookup`: `Found(ResolvedTarget)` · `NotRegistered(TargetId)` · `Disabled(TargetId)` | `targets.select`가 모두 `Select a registered enabled target`(`target-router.mjs:53-57`) |
| 작업 조회 | `Optional<Operation> find(OperationId)`(「찾았지만 없음」 한 가지) | `get` null/예외(`operation-store.mjs:98`) |
| 출력 조회 | `OutputLookup`: `Ready(OutputSnapshot)` · `Pending` · `Unavailable(UnavailableReason)` · `Expired` · `Missing` | `state`가 `pending/ready/unavailable` + 파생 `expired`(`command-output.mjs:137`) |
| claim | `ClaimResult`: `Claimed(Operation)` · `NotQueued` · `Contended` · `Saturated(SaturationReason)` | `claim`이 `null` 하나(`operation-store.mjs:252, 256, 257`) → D-0038 코드 분리 |
| 접수 | `Admission`: `Accepted(Operation)` · `Existing(Operation)` · `RejectedMaintenance` · `RejectedCapacity(CapacityKind)` · (키 충돌은 예외 `OPERATION_KEY_CONFLICT`) | `submitOperation`이 예외 문자열(`approval-queue.mjs:50, 52`) |
| artifact 예약 | `ArtifactReservation`: `Reserved(ArtifactId)` · `BudgetExceeded(long requested, long reserved, long budget)` · `DiskSpaceInsufficient(long requested, long usable)` · `FileTooLarge(long limit)` | 모두 `Staging budget exhausted`→`ARTIFACT_QUOTA`(`public-contract.mjs:151`), D-0012 |
| 원격 결과 | `RemoteOutcome`(`not_started`·`unknown`·`completed`)와 `CompletionEvidence` | `transport_lost`에 모두 뭉침(D-0013) |
| 정책 문서 | `RuleLookup`: `Rule(TargetRule)` · `NoRule` | `ruleFor`가 `undefined`(`command-automation.mjs:22`) |
| 데스크톱 지원 | `DesktopSupport`: `Supported` · `Unsupported(reason)`(5단계) | Windows 서버는 미지원(feature-map) |
| 권한 지정 | `PermissionResult`: `Applied` · `Unsupported`(3단계 portal-ssh) | Windows chmod |

---

## 5. 계약 타입 (portal-domain `contract` 패키지)

### 5.1 봉투 `Envelope` [사실: public-contract.mjs:73-75, 145-148, 162-168]
```java
public sealed interface Envelope<T> permits Envelope.Success, Envelope.Failure {
    ContractVersion contractVersion();   // 상수 "2.0" — enum ContractVersion { V2_0 } with @JsonValue("2.0")
    boolean ok();
    @JsonInclude(JsonInclude.Include.ALWAYS) record Success<T>(ContractVersion contractVersion, boolean ok, T data, ErrorData error) ... // ok=true, error=null
    @JsonInclude(JsonInclude.Include.ALWAYS) record Failure(ContractVersion contractVersion, boolean ok, Void data, ErrorData error) ... // ok=false, data=null
}
```
- `[사실]` 4개 필드는 항상 존재한다(`ok:true`면 `data` 비-null·`error` null, `ok:false`면 반대 — `.refine`). `[사실: 1단계 시범]` null 필드는 `@JsonInclude(ALWAYS)`로 보존해야 기준본과 같다(계획 「1단계 시범 판정」).
- `content[0].text`는 이 봉투의 JSON, `structuredContent`는 같은 객체(`publicReply`)다. `observe` 본문(D-0036)도 같은 바이트를 두 곳에 싣는다 — 이는 4단계 portal-web 책임이고, 도메인은 같은 `Envelope` 값 하나를 만든다.
- `ErrorData(ErrorCode code, boolean retryable, ExecutionAttempt executionAttempted)`: `code`는 `^[A-Z][A-Z0-9_]{1,95}$`(wire 값은 enum 이름이 이 정규식을 만족해야 함), 시험이 모든 상수를 이 정규식으로 검사한다.

### 5.2 데이터 record와 wire enum [사실: public-contract.mjs:15-72, 245-279]
시각·크기는 wire에서 정수 `long`이다(`createdAt` 등 에포크 밀리초, `public-contract.mjs:42`). 도메인 내부는 `Instant`지만 계약 record는 `long`을 갖고, `OperationData.from(Operation, ...)` 정적 생성이 변환한다(순수 값 변환이라 정적 생성 메서드로 허용, 11절). 모든 정수 필드는 `≥ 0`(`z.number().int().nonnegative()`), 크기는 `≤ MAX_BYTES`. `strict()`이므로 알 수 없는 필드는 없다(`additionalProperties:false`).

| record(필드) | wire 값 집합·제약 | 2.x 줄 |
|---|---|---|
| `OperationData`(id, operationKey, kind, state, targetId, targetRevision, approvalMode, createdAt, expiresAt, finishedAt, failed, auditFailure, failureCode, remoteOutcome, allowedRoot, diagnostic, remoteCleanup, execution, output, artifact, outputPage, streamPage(항상 null), waitTimedOut) | `kind` ∈ `command·source·upload·download`, `state` = `OperationState` 13종, `approvalMode` ∈ `owner·automatic`, `remoteOutcome` ∈ `not_started·completed·unknown`, `remoteCleanup` ∈ `confirmed·unconfirmed` | `:41-46` |
| `ExecutionData`(phase, reason, remoteState, exitCode, signal, automaticReplay(항상 false), signalDelivery, timeoutMs, cleanupComplete, requiresReconciliation, outputState, captureFailed, stdout, stderr) | 4.7절의 enum들, 전부 `nullable` | `:24-33` |
| `OutputReference`(version=1, captureSource=`redacted-adapter-outcome`, sshCompleteness=`unknown`, id, state, bytes, snapshotBytes, sha256, expiresAt) | `state` ∈ `pending·ready·unavailable·expired` | `:16-18` |
| `OutputPage`(text, cursor, nextCursor, bytes, totalBytes, sha256, eof, expiresAt) | | `:19-20` |
| `ArtifactSummary`(fileName, size, sha256), `Diagnostic`(origin ∈ `policy·os`, policyReason, nativeStep, nativeError), `StreamMetadata`(receivedBytes, retainedBytes, cursor, truncated) | | `:21-23` |
| `TargetsData`(targets[], defaultTarget, limits, approval) + `TargetData`(id, displayName, enabled, isDefault, revision, platform, capabilities, gui?, filePolicy) + `TargetCapabilitiesData`(commandShell ∈ `posix·windows-powershell-5.1`, fileTransfer, elevatedFileTransfer, pythonSource, agentCli, commandNameApproval, desktop) + `FilePolicyData`(testServerConfigured, testServerActive, mode ∈ `configured-root·test-server-bypass·ssh-account-permissions`, allowedRoot, allowedRootObservedAt, osPermissionsEnforced=true, pathSafetyEnforced=true, elevationRequiresExplicitRequest=true) + `LimitsData`(commandBytes, sourceBytes, artifactBytes, chunkBytes, outputPageBytes, maxWaitMs) + `ApprovalData`(ownerUrl, agentSelfApproval=false) | `gui`는 `GuiDescriptor`(configured, backend ∈ `rfb·xvnc·rdp`, lifecycle ∈ `attached·managed`, status ∈ `disabled·configured·backend_unavailable`, reason ≤256자, actions ⊂ `observe·pointer·key·text`(≤4), requiresUserClient=false, openRequest?) | `:47-60, 51-53` |
| `TransferData`(id, received, sequence, size, sha256, expiresAt, targetId, targetRevision), `BeginData`(+maxChunkBytes=262144), `TransferStatus`(state ∈ `staging·ready·expired·submitted`, transfer, request), `ChunkData`(sequence, received), `ArtifactPage`(id, artifactId, fileName, encoding=`base64`, data, offsetBytes, bytes ≤ 262144, nextOffset, totalBytes, sha256, eof, expiresAt) | | `:61-67` |
| `StagedFile`(uuid, state ∈ `staging·ready·expired·consuming·moved·removed`, fileName, size, sha256, expiresAt, received, sequence, operations[]{operationKey, action ∈ `copy·move`, requestId, state ∈ `accepted·queued·starting·running·terminating·completed·failed·cancelled·expired·denied·unknown·admission-unconfirmed·refused`}) | | `:68-72` |
| `FilesData`(action, uuid, file, request) | | `:97` |
| 데스크톱(5단계가 채움, 형태는 2단계가 확정): `SessionData`, `FrameData`, `InputReceipt`, `DesktopReadinessData`, `DesktopCapabilitiesData`, `CloseData` | `state` ∈ `transport_ready·auth_required·desktop_ready·capture_unavailable`, 차단 사유 6종, `sessionState` ∈ `terminated·preserved·unknown` | `:245-279` |

- `[제안]` 입력 스키마(`publicInputSchemas`, `:77-94`)는 portal-web 4단계의 `@RequestBody` record(+Bean Validation)와 MCP 도구 인자이며 2단계 범위가 아니다. 단, 공통 값(`RequestKey`·`TargetId`·`Digest`·`ArtifactId`)은 도메인 타입을 재사용해 정규식이 한 곳에 있게 한다.
- `[제안]` wire enum은 대응 도메인 enum을 그대로 쓰고 `@JsonValue`로 2.x 원값을 낸다. 도메인에 없는 표시 전용 값(`GuiBackend` 등)만 `contract` 패키지의 별도 enum이다.

### 5.3 ErrorCode 전체 [사실: 계약 기준본 `x-portal-errorCodes` + `src/**` 직접 grep]

**구조 `[제안]`**: `public sealed interface ErrorCode permits RequestErrorCode, OperationErrorCode, ArtifactErrorCode, HistoryErrorCode, CapacityErrorCode, DesktopErrorCode, TransferErrorCode, ExecutionErrorCode`. 각 category는 `enum … implements ErrorCode`이고 wire 값은 상수 이름 그대로(2.x 값이 이미 `UPPER_SNAKE`)다. 한 값은 한 enum에만 있다(공용 값은 아래에 소유 enum을 적었다). 오류 → HTTP·MCP 변환은 portal-web이 `ErrorCode`의 완전 `switch` 한 곳에서 한다(개발원칙 3.4). 새 코드는 두지 않는다(두 종류의 제안만 12절 D-07에서 판정).

각 줄은 `[사실]`로 2.x에서 확인한 값이다. 「소멸」은 2.x의 SQLite·Node·표 이름 조립에만 있던 값이라 3.0 enum에 두지 않는 것(근거는 괄호), 「이전」은 portal-migrate 소유라 계약 enum이 아닌 것이다.

**RequestErrorCode (30)**: `OPERATION_INPUT_CONFLICT, OPERATION_INPUT_REQUIRED, OPERATION_NOT_FOUND, OPERATIONS_UNAVAILABLE, OPERATION_LOOKUP_REQUIRED, OPERATION_SELECTOR_REQUIRED, OUTPUT_READ_NOT_REQUESTED, OUTPUT_BINDING_CONFLICT, OPAQUE_FILES_UNAVAILABLE, FILE_ACTION_INPUT_CONFLICT, FILE_ACTION_INPUT_REQUIRED, REQUEST_REFUSED, INVALID_OPERATION_INPUT, OPERATION_KEY_CONFLICT, TARGET_REVISION_CONFLICT, TARGET_UNAVAILABLE, TARGET_CAPABILITY_UNSUPPORTED, OPERATION_ACCEPTANCE_NOT_CONFIRMED, INVALID_COMMAND_CONTEXT, COMMAND_CONTEXT_TOO_LARGE, COMMAND_CONTEXT_CONTAINS_SECRET, SOURCE_CREDENTIAL_MATERIAL, SOURCE_ARGUMENTS_SENSITIVE, SOURCE_WORKDIR_SENSITIVE, READ_COMMAND_BUSY, READ_COMMAND_REQUIRES_APPROVAL, READ_COMMAND_NOT_STARTED, READ_COMMAND_EXECUTION_UNKNOWN, MAINTENANCE, MAINTENANCE_ACTIVE`

**OperationErrorCode (23)**: `OPERATION_QUEUE_FULL, OPERATION_RECONCILIATION_CAPACITY, OPERATION_ADMISSION_CLOSED, INVALID_OPERATION_RECORD, INVALID_OPERATION_REQUEST_KEY, INVALID_OPERATION_OBSERVER, OPERATION_OBSERVER_CAPACITY, OPERATION_OBSERVER_ABORTED, OPERATION_NOTIFICATION_FAILED, OPERATION_STORE_FAILED, OPERATION_OUTCOME_PERSISTENCE_FAILED, OPERATION_DISPATCH_PERSISTENCE_FAILED, OPERATION_CAPACITY, OPERATION_TOO_LARGE, OPERATION_VERSION_CONFLICT, OPERATION_CONTRACT_IMMUTABLE, INVALID_OPERATION_TRANSITION, OPERATION_PRESERVATION_NOT_IDLE, INVALID_OPERATION_FILTER, INVALID_OPERATION_LIMIT, INVALID_OPERATION_STATE, INVALID_OPERATION_CLAIM_LIMIT, INVALID_OPERATION_PORT`

**ArtifactErrorCode (46)**: `ARTIFACT_INVALID_CHUNK, ARTIFACT_READ_UNAVAILABLE, ARTIFACT_INVALID_FILENAME, ARTIFACT_INVALID_HASH, ARTIFACT_LIMIT, ARTIFACT_SEQUENCE_OR_SIZE, ARTIFACT_NOT_WRITABLE, ARTIFACT_INCOMPLETE_OR_EXPIRED, ARTIFACT_HASH_MISMATCH, ARTIFACT_UNKNOWN, ARTIFACT_MAINTENANCE, ARTIFACT_STALE_TARGET, ARTIFACT_WRONG_PROTOCOL, ARTIFACT_ALREADY_SUBMITTED, ARTIFACT_REQUEST_UNAVAILABLE, ARTIFACT_INVALID_RANGE, ARTIFACT_NOT_READY, ARTIFACT_BINDING_OR_RETENTION, ARTIFACT_CHANGED, ARTIFACT_TARGET_VERIFIER_UNAVAILABLE, INVALID_OPERATION_KEY, INVALID_FILE_NAME, INVALID_FILE_SIZE, INVALID_FILE_HASH, INVALID_ARTIFACT_CHUNK, INVALID_FILE_FLAG, INVALID_REMOTE_PATH, ARTIFACT_NOT_FOUND, ARTIFACT_INCOMPLETE, ARTIFACT_BUSY, ARTIFACT_CHUNK_CONFLICT, STAGED_FILE_CONSUMED, STAGED_FILE_CHANGED, OPAQUE_ADMISSION_BUSY, OPAQUE_ACTION_CONFLICT, OPAQUE_ACTION_RECONCILIATION_REQUIRED, ARTIFACT_EXPIRED, STAGED_FILE_EXPIRED, FILE_TOO_LARGE, CHUNK_HASH_MISMATCH, ARTIFACT_PERMISSION_DENIED, ARTIFACT_STORAGE_FULL, ARTIFACT_STORAGE_IO_ERROR, OPAQUE_FILES_CLOSED, ARTIFACT_STORAGE_UNSAFE, ARTIFACT_INTERNAL_ERROR`

**HistoryErrorCode (9)**: `HISTORY_INVALID_RANGE, HISTORY_INVALID_FIELDS, HISTORY_INVALID_FILTER, HISTORY_SEARCH_TOO_LARGE, HISTORY_INVALID_CURSOR, HISTORY_AMBIGUOUS_REQUEST, HISTORY_ENTRY_CHANGED, HISTORY_METADATA_UNAVAILABLE, HISTORY_ENTRY_TOO_LARGE`

**CapacityErrorCode (12)**: `REQUEST_QUEUE_CLOSED, REQUEST_WAIT_LIMIT, REQUEST_ABORTED, REQUEST_QUEUE_TIMEOUT, REQUEST_QUEUE_FULL, EXECUTION_QUEUE_FULL, INVALID_CAPACITY_STATE, INVALID_CAPACITY_TARGETS, INVALID_CAPACITY_TARGET, INVALID_CAPACITY_FIELDS, UNKNOWN_CAPACITY_TARGET, CAPACITY_REVISION_CONFLICT`

**ExecutionErrorCode (7)**(실행 실패 진단의 허용 코드, 4.7절): `SSH_CONNECT_FAILED, SSH_CHANNEL_OPEN_FAILED, SSH_EXECUTION_FAILED, OUTPUT_CAPACITY, OUTPUT_CAPTURE_FAILED, OPERATION_FAILED, ARTIFACT_QUOTA`

**TransferErrorCode (18)**(파일 전송·에이전트 CLI 설치 어댑터, 3단계가 던짐): `INSTALL_FAILED, PARENT_NOT_FOUND, FILE_NOT_FOUND, PERMISSION_DENIED, DESTINATION_EXISTS, UNSAFE_PATH, PATH_OUTSIDE_ALLOWED_ROOT, PATH_POLICY_UNSUPPORTED, STAGING_UNAVAILABLE, FILE_CHANGED, INVALID_REQUEST, UNTRUSTED_OWNER, MISSING_DACL, UNSAFE_ANCESTOR, UNTRUSTED_WRITER, UNSUPPORTED_ACE, SECURITY_DESCRIPTOR_TOO_LARGE, WINDOWS_COMMAND_TOO_LARGE`

**DesktopErrorCode (72)**(5단계가 던짐, 값만 2단계가 확정): `DESKTOP_OPEN_REQUEST_CAPACITY, DESKTOP_OPEN_REQUEST_GENERATION, DESKTOP_OPEN_REQUEST_EXPIRED, DESKTOP_EXPIRED, DESKTOP_NOT_AUTHORIZED, DESKTOP_OWNER_AUTH_REQUIRED, DESKTOP_NOT_READY, DESKTOP_RELEASE_FAILED, DESKTOP_INVALID_CLEANUP_RECEIPT, DESKTOP_CLOSE_FAILED, DESKTOP_NOT_FOUND, DESKTOP_STALE_LEASE, DESKTOP_BUSY, DESKTOP_STALE_FRAME, DESKTOP_INPUT_SEQUENCE, DESKTOP_INPUT_CONFLICT, DESKTOP_OBSERVE_UNSUPPORTED, DESKTOP_INPUT_UNSUPPORTED, DESKTOP_OPEN_CONFLICT, DESKTOP_RESOURCE_BUSY, DESKTOP_CAPACITY, DESKTOP_INVALID_PROVIDER, DESKTOP_INVALID_BINDING, DESKTOP_INVALID_STATE, DESKTOP_INVALID_FRAME, DESKTOP_INVALID_CONFIG, DESKTOP_BACKEND_UNAVAILABLE, DESKTOP_WIRE_LIMIT, DESKTOP_CLOSE_TIMEOUT, DESKTOP_NATIVE_INVALID_CHANNEL, DESKTOP_START_TIMEOUT, DESKTOP_TRANSPORT_CLOSED, DESKTOP_CLEANUP_FAILED, DESKTOP_CAPTURE_UNAVAILABLE, DESKTOP_INVALID_INPUT, DESKTOP_RDP_NATIVE_MANIFEST, DESKTOP_RDP_NATIVE_HASH_MISMATCH, DESKTOP_RDP_CLIENT_UNAVAILABLE, DESKTOP_RDP_NATIVE_CAPABILITY_MISMATCH, DESKTOP_RDP_NATIVE_MISSING, DESKTOP_RDP_NATIVE_PROBE_FAILED, DESKTOP_RDP_INVALID_TUNNEL, DESKTOP_RDP_CREDENTIAL_UNAVAILABLE, DESKTOP_RDP_INPUT_DETACH_UNKNOWN, DESKTOP_RDP_DISPLAY_CLEANUP_FAILED, DESKTOP_RDP_TUNNEL_CLEANUP_FAILED, DESKTOP_RDP_IDENTITY_UNVERIFIED, DESKTOP_RDP_INVALID_SESSION, DESKTOP_SESSION_BINDING_UNVERIFIED, DESKTOP_CLOSED, DESKTOP_RDP_OPEN_FAILED, DESKTOP_TRANSPORT_FAILED, DESKTOP_TIMEOUT, DESKTOP_NOT_CONFIGURED, DESKTOP_INVALID_CHANNEL, DESKTOP_WRITE_TIMEOUT, DESKTOP_FRAME_LIMIT, DESKTOP_KEY_LIMIT, DESKTOP_UNSUPPORTED_RFB_VERSION, DESKTOP_UNSUPPORTED_SECURITY, DESKTOP_AUTH_FAILED, DESKTOP_UNSUPPORTED_MESSAGE, DESKTOP_UNSUPPORTED_ENCODING, DESKTOP_UNSTABLE_GEOMETRY, DESKTOP_TUNNEL_CLEANUP_UNKNOWN, DESKTOP_TUNNEL_UNAVAILABLE, DESKTOP_STALE_TARGET, DESKTOP_UNAVAILABLE, DESKTOP_SESSION_QUERY_UNSUPPORTED, DESKTOP_SESSION_QUERY_FAILED, DESKTOP_AUTH_REQUIRED, DESKTOP_AUTH_BROKER_UNAVAILABLE`

**기준본에는 없지만 2.x 소스에 있는 값 11개 `[사실: grep 차이]`**: `COMMAND_CONTEXT_CONTAINS_SECRET, COMMAND_CONTEXT_TOO_LARGE, INVALID_COMMAND_CONTEXT, READ_COMMAND_BUSY, READ_COMMAND_EXECUTION_UNKNOWN, READ_COMMAND_NOT_STARTED, READ_COMMAND_REQUIRES_APPROVAL, SOURCE_ARGUMENTS_SENSITIVE, SOURCE_CREDENTIAL_MATERIAL, SOURCE_WORKDIR_SENSITIVE, DESKTOP_AUTH_BROKER_UNAVAILABLE`(위 enum들에 포함됨). 이 값들은 기준본 `x-portal-errorCodes`의 grep이 놓친 것이므로 기준본 보정(메인 판정)이 필요하다.

**「소멸」 6개(2.x 저장소·Node 고유, 3.0 enum에 두지 않음)**: `OPERATION_PATH`·`INVALID_OPERATION_BUDGET`·`UNSAFE_OPERATION_STORE`·`UNSUPPORTED_OPERATION_SCHEMA`·`OPERATION_TRANSACTION_UNCERTAIN`·`UNSAFE_CAPACITY_STORE`(SQLite 파일 열기·스키마 버전·트랜잭션 오염 검사. 3.0은 Flyway·JDBC 트랜잭션이 맡는다). 이름 조각 2개 `OPERATION_ID`·`LEGACY_SOURCE`는 `INVALID_${name}` 조립의 일부이고(`operation-store.mjs:23`) 코드가 아니다. 이 조립형 코드(`INVALID_REQUESTKEY, INVALID_OWNER, INVALID_TARGETID, INVALID_TARGETREVISION, INVALID_KIND, INVALID_OPERATION_ID, INVALID_OPERATION_PATH`와 스케줄러 설정 오류 `INVALID_globalConcurrency` 등)는 compact constructor의 `IllegalArgumentException`과 `@ConfigurationProperties` 검증으로 바뀐다.

**「이전」 portal-migrate 소유(16, 계약 enum 아님)**: `UNSAFE_LEGACY_FILE, LEGACY_NOT_QUIESCENT, UNSUPPORTED_LEGACY_SCHEMA, LEGACY_HISTORY_CAPACITY, INVALID_LEGACY_HISTORY, INVALID_LEGACY_REQUEST_KEY, LEGACY_ENTRY_TOO_LARGE, UNSAFE_LEGACY_ROOT, LEGACY_CHANGED_DURING_READ, INVALID_MIGRATION_TARGET, UNSAFE_LEGACY_ARCHIVE, LEGACY_ARCHIVE_MISMATCH, LEGACY_CHANGED_DURING_IMPORT, INVALID_LEGACY_IMPORT_BASELINE, LEGACY_MIGRATION_RECORD_MISSING, INVALID_LEGACY_BATCH`.

**`portal-desktop` 내부 wire 코드 9개(계약 enum 아님, 서버↔`freerdp-input` 프로토콜 안)**: `WIRE_LIMIT, TRANSPORT_CLOSED, TRANSPORT_FAILED, ACK_TIMEOUT, INVALID_FRAME, CAPABILITY_MISMATCH, INPUT_BUSY, INVALID_ACK, PARTIAL_OR_UNKNOWN`(`OPERATION_FAILED`는 `ExecutionErrorCode`가 소유). 5단계 `DesktopNativeErrorCode`.

- `[제안]` 기준본 일치 시험(`ErrorCodeBaselineTest`): (1) 모든 상수 이름이 `^[A-Z][A-Z0-9_]{1,95}$`, (2) 8개 enum의 합집합 = (`x-portal-errorCodes`의 모든 코드 − 「소멸」 − 「이전」 − 「내부 wire」 − 비-코드 조각) + 위 「기준본에 없던 11개」, (3) 값 중복 0, (4) `transferRefusals`의 24행 시나리오가 기대 코드를 돌려줌. 기준본이 portal-web 쪽 시험 리소스이므로 도메인 시험은 Gradle로 그 폴더를 리소스 경로에 더해 읽는다(JSON 읽기는 시험 전용 Jackson, A-DOMAIN은 main 클래스만 본다 — `ArchitectureRulesTest`가 `classes/java/main`을 읽음, `foundation-cases.md` 2절).

### 5.4 기준본과 맞추는 방법 [제안, `contract-baseline.md` 8.1절 규칙 사용]
1. **상태·enum 어휘**: `OperationState.values()`의 wire 값 집합 = `mcp/tools/submit.json`·`observe.json`·`cancel.json`·`artifact-finish.json`의 `outputSchema…state.enum`.
2. **필드 구조**: 각 도구의 `outputSchema`(`properties`, `required`, `type`, `enum`, `additionalProperties`)와 `contract` record를 Jackson(시험 전용)으로 직렬화한 샘플의 키 집합을 비교한다(8.1: wire 모양은 8단계 E2E에서 확인, 구조 비교만). 필드는 `null`도 직렬화되어야 한다(`@JsonInclude(ALWAYS)`).
3. **봉투 규칙**: `envelope.schema.json`의 `ok`/`data`/`error` 관계와 `error.code` 정규식을 시험한다.
4. **한도 상수**: `targets.limits`의 `commandBytes 32768, sourceBytes 16384, artifactBytes ≤ 67108864, chunkBytes 262144, outputPageBytes 16384, maxWaitMs 60000`(`public-contract.mjs:194-195`)과 도메인 상수가 같음.
5. **계약 정규식**: `identifier`·`digest`·`target`·`key`·`uuid`·`openRequestKey`(`^[a-f0-9]{32}_[0-9]{1,16}_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$`, `:50`)가 도메인 값 타입의 패턴과 같은 문자열(기준본 JSON 스키마의 `pattern`과 문자열 비교).

### 5.5 `RequestRefusedException`의 매핑 표
`ErrorCode` → 공개 오류 봉투: `{code, retryable, executionAttempted}`. 기본값은 2.x와 같다: `retryable=false`(예외가 `ARTIFACT_MAINTENANCE`/명시하면 `true`), `executionAttempted`는 접수 거절 계열이면 `NOT_ATTEMPTED`(`public-contract.mjs:102, 166`의 `executionAttempted:false`) 아니면 `UNKNOWN`. `OPERATION_QUEUE_FULL`·`OPERATION_RECONCILIATION_CAPACITY`·`REQUEST_QUEUE_FULL`·`MAINTENANCE_ACTIVE`는 `retryable=true`(`operation-scheduler.mjs:3`, `approval-queue.mjs:50`).

---

## 6. 명령 정책·안전 판정

### 6.1 `CommandPolicy` 문서 `[사실: command-policy.mjs:43-71]` → 타입
- `CommandPolicyDocument`(record): `List<TargetRule> targets`(≤ 32, `targetId` 중복 없음). 정책 `revision`은 문서 밖(저장소의 `command_policy.revision`, 8.2절)이며 `PolicySnapshot(long revision, CommandPolicyDocument document)`로 함께 다닌다.
- `TargetRule`(record): `TargetId targetId`, `TargetRevision targetRevision`(64 hex), `ProfileAlias profile`(`^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,79}$`), `TargetOs os`(기본 `LINUX`), `CommandNames commands`·`CommandNames deniedCommands`(각 ≤ 128, 중복 없음 — Linux는 이름 정규식 `^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,79}$`, Windows는 `WindowsPolicyName`), `Toggle externalDisclosure`, `Toggle modelExecution`, `Toggle automaticUploads`·`automaticDownloads`·`automaticSudo`·`testServer`(2.x에서 선택 필드, 없음은 `OFF`), `SourceContract sourceExecutionContract`(`NONE`·`PYTHON_SOURCE_V1`), `Fallback fallback`(`NONE`·`LUNA`·`SONNET`), `Thresholds thresholds`(`jev`·`luna`·`sonnet` 키만).
- `Threshold`(sealed): `ProbabilityThreshold(String model, QuestionVersion questionVersion, double minLowRisk, String validationRef)` — `basis==safety-probability-v1`이면 `minConfidence`가 없어야 함; `ConfidenceThreshold(…, double minConfidence)` — 구형 정책(v2·v3·v4·combined)으로 읽기만 하고 자동 승인에는 쓰이지 않음(A-421). 공통 불변식: `model`은 `^[A-Za-z0-9_.:-]{1,100}$`, `minLowRisk ∈ (0.5, 1]`, `minConfidence ∈ (0.5, 1]`(있을 때), `validationRef`는 `^[A-Za-z0-9_.:/-]{1,200}$`, 질문 버전 ∈ `v2·v3·v4·v5`(`command-policy.mjs:50`).
- `QuestionVersion` enum: `V2("ssh-command-risk-v2"), V3("ssh-command-risk-v3"), V4("ssh-command-risk-v4"), V5("ssh-command-risk-v5")`. 현재 질문 버전은 `V5`(`:7`), 프롬프트 리비전 `ssh-command-risk-v5-binary-r1`(`:10`), 확률 기준 `safety-probability-v1`(`:8`).
- 허용되지 않는 키가 있으면 거절(`keys(...)`): 3.0은 Jackson `FAIL_ON_UNKNOWN_PROPERTIES`(portal-web `@RequestBody` record 경계)와 record 정의로 같은 효과를 낸다. 도메인 시험은 record 불변식만 본다.
- 판정 메서드는 값이 가진다: `TargetRule#denies(CommandText, CommandLineGrammar)`(`deniedCommand` `:98`: 문법의 이름 집합에 거부 이름이 있거나, 명령을 `[^A-Za-z0-9_.+-]+`로 쪼갠 조각에 거부 이름이 있음 — 후자는 문법이 모르는 우회를 잡는 보수 규칙), `TargetRule#approves(CommandLineAnalysis)`, `CommandPolicyDocument#ruleFor(TargetId, TargetRevision, ProfileAlias)`(sealed `RuleLookup`).
- 정책 변경 시 revision 충돌은 저장 계층(`@Version` 또는 CAS, 8.2절)이 막는다. 도메인은 「기대 revision과 같을 때만 새 문서를 승인」하는 값 메서드 `PolicySnapshot#replaceWith(CommandPolicyDocument, long expectedRevision)`만 둔다(`command-state.mjs:45-51`: `revision conflict`).

### 6.2 `CommandRiskCatalog`와 리소스 2종 `[사실]`
- `command-risks.json`(22,856바이트, SHA-256 `eb65ce4e1e1f73259a405afd5e4741fda1f529d1a64d2227bb33faff03c47d83`)과 `automation-risk-question.json`(4,644바이트, SHA-256 `ef0f1cc10b76a0aa1203a690697be61b4d2017d3879c8a1f954e7202f04b8fbc`)을 `portal-domain/src/main/resources/risk/`에 **바이트 그대로** 둔다. 해시는 2026-11-12 `src/domain/` 파일에서 `sha256sum`으로 계산했다(LF만, 개행 변환 없음).
- `[제안]` 바이트 보존: 저장소 `java/.gitattributes`에 `portal-domain/src/main/resources/risk/*.json -text`를 더해 체크아웃 때 개행이 바뀌지 않게 한다. 시험은 두 파일의 SHA-256·바이트 길이를 위 값과 비교한다.
- `[사실]` 질문 digest: `AUTOMATION_PROMPT_SHA256 = SHA-256(JSON.stringify({type, instructions, criteria:{low_risk, high_risk}}))`(`command-policy.mjs:12`, 키는 파일 순서, 공백 없는 압축형). 고정값은 `77634c80b0c225777dca0ddc2766db5072b173b7a34e01fdf8e35a48560ac0c5`(`test/jev-prompt-revision.test.mjs:9`). `[제안]` 도메인은 JSON을 읽지 못하므로 A 모듈 `@Component AutomationQuestionLoader`(주입된 `JsonMapper`)가 리소스를 읽어 `AutomationQuestion` record를 만들고, 같은 키 순서의 압축 JSON을 만들어 `Digester`로 해시해 위 고정값과 같은지 시험한다. 같지 않으면 Jackson 직렬화(문자 이스케이프·키 순서)가 JS `JSON.stringify`와 다른 것이다 — 구현 담당이 `JsonMapper` 설정이 아니라 **질문 record의 필드 순서**와 출력 이스케이프(`\u2028` 등 없음 확인)로 맞춘다.
- `CommandRiskCatalog`: `defaultCommands`·`excludedCommands`(`sudo`)·`defaultRisk`·`commands`(이름 → `RiskEntry(description, category, riskLevel, capabilities, reason)`)를 담은 record. 로더 `CommandRiskCatalogLoader`(A `@Component`, `JsonMapper`)가 리소스를 읽는다. 메서드 `RiskEntry describe(String name)`(없으면 `defaultRisk`)는 sealed 결과 `RiskDescription`: `Known(RiskEntry)` · `Unknown(DefaultRisk)`로 답한다. 값은 이 문서에서 옮기지 않았다(파일 그대로, 형식을 바꾸지 않음, feature-map).
- 모델 대상 문장은 영어 고정(개발원칙 4.6). `SAFETY_QUESTION`(`safety.mjs:17-24`), `COMMAND_SET_QUESTION`·`WINDOWS_COMMAND_SET_QUESTION`(`command-policy.mjs:32-40`)의 긴 영어 문장은 새 리소스 JSON(`risk/safety-question.json`, `risk/command-set-question.json`, `risk/windows-command-set-question.json`)로 **원문 그대로** 옮기고 시험이 각 `instructions`의 SHA-256을 고정한다(해시는 구현 담당이 `sha256sum`으로 2.x 소스에서 뽑아 시험에 적는다 — 이 문서는 값을 만들지 않았다).

### 6.3 `CommandLineGrammar`와 분석 결과 `[사실 + 제안]`
```java
package …domain.command;
public interface CommandLineGrammar {                 // D 소유(결정 D-01). 구현: PosixCommandLineGrammar·WindowsCommandLineGrammar (portal-ssh)
    CommandLineAnalysis analyze(CommandText command);
    PolicyName normalize(String proposedName);        // 정책 이름 정규화. 부적합이면 sealed NormalizedName 로 답함
    Platform platform();                              // 식별값(enum TargetOs). List<CommandLineGrammar> 주입 시 구현이 자기 식별값을 답한다 (패턴 8.12)
}
public record CommandLineAnalysis(List<String> names, Completeness completeness, SudoUse sudo) { /* 불변식: complete 이면 names 비어 있지 않음 */ }
public enum Completeness { COMPLETE, INCOMPLETE }     // INCOMPLETE 는 전체 평가(모델) 경로
public enum SudoUse { USES_SUDO, NO_SUDO }
```
- `[사실]` 2.x 반환은 `{names, complete, usesSudo}`(`command-line.mjs:162`, `windows-command-line.mjs:231`). `complete`는 `names.size>0`이어야 참(`:162`, Windows `:231`).
- 의미 계약(LSP): 구현을 바꿔도 `INCOMPLETE`는 「이름 승인 불가, 전체 평가로」, `COMPLETE`는 「모든 이름이 문법으로 확정」을 뜻한다. 미지원 구문은 예외가 아니라 `INCOMPLETE`로 답한다(2.x `unknown()`을 던져 잡아 `complete=false`로 바꾸던 흐름을 `command-line.mjs:160-161`에서 확인; 3.0은 예외를 흐름 제어에 쓰지 않는다(개발원칙 3.4)).
- `[사실]` POSIX 문법은 sudo 앞 옵션 해석, `sh/bash/dash/zsh -c` 재귀(깊이 16), `$()`·백틱 치환, 리다이렉션을 다루고(`command-line.mjs:50-163`), Windows 문법은 `&` 호출 연산자, 따옴표 리터럴, 모듈 한정 cmdlet·`.exe`·절대 경로 이름만 허용하고 곡선 따옴표·`$`·``` ` ```·`@` 등을 거절한다(`windows-command-line.mjs:23-72`). **두 구현은 3단계 portal-ssh가 짓는다.** 2단계는 interface와 위 값 타입, 그리고 구현에 대한 계약 시험 틀(`CommandLineGrammarContract` 추상 시험 — 같은 사례를 두 구현에 돌리는 JUnit 상속 틀은 시험 코드의 구현 상속이라 허용)만 둔다.
- 2단계 domain 시험 중 문법이 필요한 사례(9절 「3단계로 미룸」 표)는 문법 구현이 생길 때 portal-ssh에서 `CommandPolicy` 조합 시험으로 닫는다. 2단계 domain 시험은 `CommandPolicy`의 경계 규칙만 가짜 문법 없이 값으로 확인한다(예: 확률 경계, 임계값 불변식, 정책 문서 불변식).

### 6.4 `SafetyAssessment` `[사실: safety.mjs]`
```java
public sealed interface SafetyAssessment permits SafetyAssessment.Assessed, SafetyAssessment.Unavailable {
    record Assessed(JevModel model, SafetyLabel label, Probability confidence, LabelProbabilities probabilities, UsageNote usage) {}
    record Unavailable(SafetyFailure reason, DiagnosticNote diagnostic) {}      // DiagnosticNote: sealed NoDiagnostic · Diagnosed(SafetyDiagnostic)
}
```
- `Assessed` 불변식 `[사실: :29-40]`: 모델명 `^jev-[1-9][0-9]?\.[0-9]{1,2}\.[0-9]{1,2}$`, 라벨 ∈ {`low_risk`, `high_risk`}, `confidence` ∈ [0,1], 확률 두 개 모두 [0,1], 합 = 1 ± 1e-6, **선택 라벨의 확률이 최대**, 토큰 수 ≥ 0. 위반 시 2.x는 `null`을 돌렸다 → 3.0은 `SafetyAssessmentRejected`(sealed `Rejected(SafetyDiagnostic)`)로 진단을 답한다(`assessmentDiagnostic` `:67-80`의 17종 중 해당 값). D-0037: 검증 실패는 항목별로 원값과 함께 보존하고 전체 연구를 중단하지 않는다 — 허용치(1e-6)는 바꾸지 않는다.
- `SafetyLabel`(`LOW_RISK`, `HIGH_RISK`; wire `low_risk`·`high_risk`). `SafetyFailure`(9): `not_configured, busy, invalid_input, input_too_large, timeout, http_error, invalid_response, response_too_large, request_failed`. `SafetyDiagnostic`(17): `ASSESSMENT_STATUS, MODEL_MISMATCH, LABEL_DOMAIN, CONFIDENCE_RANGE, PROBABILITY_KEYS, PROBABILITY_RANGE, PROBABILITY_SUM, CHOICE_NOT_MAX, USAGE_SCHEMA, ANSWER_KEYS, ANSWER_TYPE, CONTENT_TYPE, BODY_MISSING, BODY_READ, UTF8_DECODE, JSON_PARSE, UNCLASSIFIED_VALIDATION_FAILURE`(`safety.mjs:61-64`). 값 모양은 알 수 없는 문자열을 보존하지 않는다: 경계에서 enum으로만 바꾼다(`:83-86`).
- 후보 일치(`candidateMatch`, `:42-47`): `Assessed#isCandidate()` — `LOW_RISK`이고 `low_risk ≥ 0.999`이고 `confidence ≥ 0.99`(상수는 `SafetyProtocol` record: `version ssh-command-risk-observation-v2`, `adapterRevision typesafe-choice-v1`, `model jev-1.14.0`, `thresholdStatus unvalidated`, 자동 실행 `false`, `:6-14`). 이 값은 **관찰 전용**이며 실행 권한이 없다(`:4`).
- 입력(`SafetyInput`): `command`(UTF-8 ≤ 32768B), `target`·`environment`(≤ 4096자), `context`(≤ 12288자, 소스일 때 증거 상한)(`:50-58`) — 값 타입 `CommandText`·`CallerContext`·`AssessmentContext`가 각 불변식을 가진다.
- 위험 검증 `validatedRisk`(`command-policy.mjs:86-96`)는 `Assessed`와 같은 조건에서 토큰 수가 선택 필드이고 모델명 형식 검사를 하지 않는다(기대 모델과 같기만 함). `[제안]` `SafetyAssessment.Assessed#matchesModel(String expected)`와 토큰 수 `nullable`을 sealed `UsageNote`(`Reported(in,out)`·`NotReported`)로 모델링한다.

### 6.5 `ExecutionContext`·명령 요청 `[사실: execution-context.mjs]`
- `ExecutionContext`(record) = 호출자 설명(`CallerContext`) + 서버 사실(`ServerFacts`: `targetId, targetDisplayName, targetRevision, profile, sshTarget, commandClass, policyRevision, requestState, externalDisclosure, modelExecution, fallback, targetPlatform, commandLanguage` 13개만 — 화이트리스트, 값은 문자열(≤2048)·수·불리언만, 유한 수) + 소스 증거(`SourceEvidence`, 선택). 평가 문맥은 UTF-8이 아닌 **UTF-16 길이 ≤ 12288**(소스가 있으면 + 소스 증거 상한 117760, `:5, 7, 24-38`)로 센다.
- `ServerFacts`는 호출자가 값을 정할 수 없는 서버 소유 값이라 별도 타입이다(`callerSituationSource: 'Caller-supplied claims, not independently verified and never authorization'`, `:47-67`). `assessmentContext`의 JSON 조립은 도메인이 아니라 A/web의 직렬화 경계에서 record로 한다(개발원칙 2.2 범주 1: 손으로 JSON을 조립하지 않는다) — 도메인은 조립에 필요한 값 record만 만든다.
- `ssh-request-v1:` 봉투 호환(`commandRequest`, `:73-89`)은 호스트가 command만 보낼 수 있던 시절의 호환이다. 이 경로(JSON 봉투를 명령 문자열 안에 넣는 것)는 계약이며(기준본 `A-478`) 4단계 portal-web 입력 변환에서 `CommandRequestEnvelope` record로 푼다. 2단계 도메인은 풀린 값(`command, context, requestKey, displayContext`)을 `SubmitCommand` record로 받는 쪽만 정의한다.

### 6.6 분류기·redactor — vendor 문서 대기
- `[사실]` 2.x `domain/*`은 명령 분류기를 직접 갖지 않는다. 분류는 vendor `ssh-mcp-2.18.0`의 `policy/classifier.js`(`classify(command) → {class}`)이고 출력 redaction은 `guard/redactor.js`다(feature-map 5절). 결과 `class` ∈ `read-only`·`safe`·`privileged`(+ 분류기 예외 시 `unknown`, `command-policy.mjs:74-84`).
- `[사실]` 2.x가 vendor 위에 덮어쓴 부분(이 문서가 입력으로 삼을 것):
  1. 여러 줄 명령은 `read-only`여도 `safe`로 내린다(분류기가 입력을 `trim`해 전체 프로그램이 읽기 전용임을 증명하지 못하므로, `validation.mjs:20`). 사례 B-072~B-074(D-0005 확정).
  2. Windows 대상 분류는 vendor를 쓰지 않는다: 모듈 한정 `Microsoft.PowerShell.Utility\Get-Date`·`Microsoft.PowerShell.Management\Get-Location` 한 줄만 `read-only`, 나머지 전부 `safe`(`target-platform.mjs:20-28`). 3단계 `WindowsTargetPlatform`.
  3. `inspectCommand`의 「vendor `safe`는 모르는 프로그램의 대체값일 뿐 안전 증명이 아니다」 규칙: `sudo`는 앞 `sudo [-n]`을 벗긴 뒤 분류하고, 분류기 예외는 `unknown`, 위험 판정은 `민감 텍스트 || 셸 메타문자 || 실행 파일 없음 || class != read-only`(`command-policy.mjs:74-84`).
  4. 자격 증거·민감 경로 정규식(`execution-context.mjs:8-22`)은 vendor redactor와 별개인 2.x 자체 규칙이다.
- `[제안]` 도메인 interface `CommandClassifier`(`CommandClass classify(CommandText)`)와 `OutputRedactor`(`RedactedText redact(String raw)`)를 D에 두고(소비자: 정책·출력 저장), 구현은 vendor 규칙 조사 문서를 입력으로 3단계 이후 한 클래스씩 둔다. 계획(구조 표)은 「명령 분류·redaction(엔트로피 포함)」을 portal-domain 책임으로 적었다. 규칙 목록·엔트로피 임계값은 문서 도착 후 확정한다. **지금은 interface와 값 타입(`CommandClass`, `RedactedText`)만 2단계에 둔다.**
- `[미확인]` vendor 규칙 조사 문서가 도착하면: (a) `CommandClassifier` 구현의 규칙 표, (b) redactor 패턴·엔트로피, (c) `SSH_MCP_*` 의미를 이 6.6절에 옮기고 시험 사례를 만든다.

### 6.7 데스크톱·에이전트 CLI·파일 결속 값 `[사실]`
- `DesktopBinding(String ownerId(≤256), TargetId targetId, TargetRevision targetRevision, long epoch≥1)`(`desktop-lease.mjs:6-12`).
- `DesktopAction`(sealed): `KeyAction(int keysym 1..0x1fffffff, boolean down)` · `PointerAction(int x, int y, int buttons 0..255)`(`x<width`·`y<height`는 `DesktopActions#validate(width, height)`가 한 요청 단위로 검사) · `TextAction(String text 1..2048, 정형)`. 한 요청: 동작 1~128개, 이벤트 수 ≤ 4096(텍스트는 문자당 2 이벤트)(`:14-35`).
- `DesktopReadiness`(record): 상태 4종·차단 사유 6종(`desktop-state.mjs:3-5`), `observedAt ≥ 0`, `generation`(64 hex 또는 없음), `osSessionId`(양수 또는 없음), `locked`(참·거짓·모름), 불리언 5개(`sessionBindingVerified, displayBindingVerified, inputVerified, inputAllowed, ownerOnly`), `sessionRef`·`resourceGeneration` 선택. `DESKTOP_READY`는 세 검증이 모두 참·잠금 아님·`sessionRef`나 (`osSessionId`+`locked=false`)·`resourceGeneration`이나 `generation`이 있을 때만(`:17-19`), `CAPTURE_UNAVAILABLE`은 `inputAllowed`일 수 없음(`:20`). 잠금 `null`은 sealed `LockState`(`LOCKED`·`UNLOCKED`·`UNKNOWN`)로. **데스크톱 lease는 메모리 상태**(`desktop.mjs:12`의 `Map`)라 2단계에 표가 없다. 판정 규칙(결속 일치·epoch)만 도메인 값 메서드로 둔다. 2.x 시험 사례(A-694~A-714)는 5단계 portal-desktop이 소유한다.
- `AgentCliProvider`(interface): `AgentCliProviderId id()`(`CODEX`·`CLAUDE` 식별 enum), `String packageName()`, `String command()`. 구현 `CodexCliProvider`(`@openai/codex`)·`ClaudeCliProvider`(`@anthropic-ai/claude-code`)는 `List<AgentCliProvider>` 주입으로 합류(패턴 8.12, `agent-cli.mjs:5-8`). `AgentRelease`(record, `provider, packageName, version(^(0|[1-9][0-9]{0,5})(\.…){2}$), tarball(레지스트리 고정 URL), integrity(sha512-… 정확히 86자 + ==, base64 왕복 일치), releaseDigest`)(`:21-33`). `AgentCliIntent`(record)(`:36-51`: 필드 8개 정확, 대상·revision·profile이 결속과 같음, 만료 > 지금, 설치 revision 64 hex, 요청 키 형식, `intentDigest`).
- `FileTargetBinding(TargetId targetId, TargetRevision targetRevision)`: 둘 다 유효할 때만(`file-target-binding.mjs:2-8`). 사례 A-801.

---

## 7. portal-app 포트

portal-app는 도메인 위의 계층이고 의존은 `portal-domain`·`spring-context`·`spring-tx`뿐이다(`java/portal-app/build.gradle.kts`). 2단계에는 유스케이스(`@Service`)를 두지 않고 **저장 포트·빈·3단계가 구현할 포트**만 둔다. 포트는 소비자 역할 단위로 좁게 쪼갠다(ISP, 개발원칙 3.0). 패키지 접두 `io.github.jaeseongs95.portal.app`.

### 7.1 저장 포트(2단계에 필요, portal-store가 구현)

| interface | 소비자 역할 | 메서드(시그니처, 반환 타입에만 `Optional`) |
|---|---|---|
| `OperationJournal` | 접수·전이 저장(유스케이스) | `Admission accept(NewOperation spec)`(sealed `Admission`: `Inserted(Operation)` · `Existing(Operation)` — 같은 키·다른 계약은 `OperationKeyConflictException`), `Optional<Operation> find(OperationId)`, `Optional<Operation> findByRequestKey(RequestKey)`, `Operation save(Operation next, long expectedVersion)`(CAS, 이벤트 행 추가, 충돌 시 `OperationVersionConflictException`), `List<OperationEvent> events(OperationId)` |
| `OperationQueueView` | 스케줄러가 판정에 쓰는 읽기 모델 | `List<Operation> ready(int limit)`(준비 순서 오름차순), `StateCounts counts()`, `int activeOnTarget(TargetId)`, `int liveUnknown()`(이전된 legacy 제외), `boolean fenced(TargetId, TargetRevision, ConflictKey)`, `Map<TargetId, Instant> lastStartedAt(Collection<TargetId>)`, `List<Operation> inStates(Set<OperationState> states, TargetFilter filter, int limit)`(sealed `TargetFilter`: `AnyTarget`·`OnlyTarget(TargetId)`) |
| `ClaimStore` | 디스패처 | `ClaimResult claim(OperationId id, long expectedVersion, ConcurrencyLimits limits, Instant at)` — 개수 재확인 + `@Version` 갱신을 한 트랜잭션에서(3.3절). 결과 sealed(4.9절) |
| `RestartRecovery` | 시작 시 정리 | `List<Operation> recoverAfterRestart(Instant at)` — T18~T21을 한 트랜잭션으로 |
| `HistoryQuery` | 이력 조회(읽기 전용) | `HistoryPage page(HistoryFilter filter, HistoryCursor after, int pageSize)`, `Optional<Operation> publicMetadata(OperationId)` — 페이지 20·응답 256KiB는 유스케이스(3단계)가 지킴 |
| `ArtifactRegistry` | artifact 메타·예산 | `ArtifactReservation reserve(ArtifactSpec)`(sealed 4.9절), `ArtifactRecord append(ArtifactId, int chunkNo, ChunkDigest chunk)`, `ArtifactRecord markReady(ArtifactId, Digest sha256)`, `Optional<ArtifactRecord> find(ArtifactId)`, `Optional<ArtifactRecord> findStaged(ArtifactUuid)`, `ArtifactBudget budget()`, `List<ArtifactRecord> expired(Instant now)`, `void release(ArtifactId, ReleaseReason)`, 상태 전이 메서드(`consume`, `delete`) |
| `ArtifactPayloadStore` | artifact 바이트(파일) | `PayloadWrite append(ArtifactId, long offset, byte[] data)`(`fsync` 후 반환), `void truncate(ArtifactId, long length)`, `PayloadRead open(ArtifactId)`(`ReadableByteChannel`), `void delete(ArtifactId)`, `DiskSpace usable()`. **트랜잭션 밖에서 호출한다**(개발원칙 4.4) |
| `OutputManifestStore` | 출력 manifest | `OutputLookup find(OutputId)`(sealed 4.9절), `OutputReservation reserve(OutputBinding)`, `OutputManifest markReady(OutputId, OutputFormats)`, `void markUnavailable(OutputId, Instant expiresAt)`, `OutputBudget budget()`, `List<OutputManifest> expired(Instant now)`, `void delete(OutputId)` |
| `OutputPayloadStore` | 출력 바이트(파일) | `void append(OutputId, StreamFrame)`, `PayloadRead openFormat(OutputId, OutputFormat)`, `void delete(OutputId)`, `long retainedBytes(OutputId)` |
| `CommandPolicyStore` | 명령 정책 | `PolicySnapshot current()`, `PolicySnapshot replace(CommandPolicyDocument next, long expectedRevision)`(충돌 시 `PolicyRevisionConflictException`) |
| `AgentCliRequestStore` | CLI 설치 요청 | `void insert(AgentCliRequest)`, `Optional<AgentCliRequest> findByOperation(OperationId)`, `RemoteStatus recordRemote(OperationId, RemoteStatus)`, `AgentCliHistoryPage history(AgentCliBinding, AgentCliCursor after)` |
| `MaintenanceStore` | 유지보수 예약 | `MaintenanceStatus status(OwnerHash)`(sealed: `Reserved`·`Released`·`Unknown`), `boolean occupied()`, `void reserve(OwnerHash)`(같은 소유자 재사용은 `MaintenanceOwnerUsedException`), `void saveBaseline(OwnerHash, PreservationBaseline)`(한 번만), `Optional<PreservationBaseline> baseline(OwnerHash)`, `void release(OwnerHash)` |
| `RuntimeCapacityStore` | 런타임 용량 | `Optional<CapacityState> read()`, `CapacityState initialize(CapacityState)`(있으면 기존 유지), `void compareAndSet(String expectedRevision, CapacityState next)`(`CapacityRevisionConflictException`) |
| `AuditLog` | 감사 기록 | `void append(AuditEvent event)` — 실패하면 `AuditFailedException`(승인을 허용하지 않는다, `feature-map` `jsonl.mjs` 행). 구현은 JSONL 파일(S, `FileChannel`·`force`) |

- `[사실]` `OutputLookup`·`ArtifactReservation`·`ClaimResult`·`Admission`의 형태는 4.9절. `Optional`이 필요한 자리는 「찾았지만 없음」이 유일한 의미인 조회뿐이다. 매개변수에 `Optional`을 쓰지 않는다(`TargetFilter` sealed로 대체).
- `[제안]` 파일 입출력 포트(`ArtifactPayloadStore`·`OutputPayloadStore`)를 메타 포트와 분리한 이유: 트랜잭션 안에서 파일 I/O를 하지 않는 규칙(개발원칙 4.4)과 구현 교체(디스크 → 객체 저장소)가 변화 축이기 때문이다. 사례 B-091~B-095는 이 두 포트의 순서(바이트 `fsync` → 메타 커밋)를 확인한다.

### 7.2 빈 — `Clock`·난수·다이제스트 [제안, 개발원칙 3.7·4.5]

`DomainBeans`(`@Configuration`, portal-app): portal-domain에는 Spring 어노테이션을 붙일 수 없고(A-DOMAIN), `Clock`·`SecureRandom`은 JDK 클래스라 어노테이션을 붙일 수 없으므로 아래만 `@Bean` 팩토리 메서드로 만든다(개발원칙 3.1의 정당한 사유를 메서드 주석에 적는다).

| 빈 | 만드는 법 | 비고 |
|---|---|---|
| `Clock` | `Clock.systemUTC()` 하나 | 시험은 `Clock.fixed`·`Clock.offset`으로 바꿔 끼움(`@Primary` 없음, 시험 구성에서 대체). `ZoneId.systemDefault()` 금지(A-TIME) |
| `SecureRandom` | `new SecureRandom()` 하나 | 호출마다 만들지 않는다 |
| `Digester` | `new Sha256Digester()` | 4.2절. `MessageDigest`는 호출마다 새로 만들어 스레드 안전 |
| `OperationIdGenerator`·`ArtifactIdGenerator`·`ArtifactUuidGenerator` | 생성자 인자 `SecureRandom` | 도메인의 평범한 클래스(JDK만 의존) |
| `AvailableCpus` | `Runtime.getRuntime().availableProcessors()`를 감싼 값 인터페이스 `AvailableCpus` | 2.x `availableParallelism()`(`config/capacity.mjs:5`). 시험이 CPU 수를 바꿔 `CapacityDefaults`를 확인 |
| `CommandRiskCatalog`·`AutomationQuestion` | `@Component` 로더(`CommandRiskCatalogLoader`, `AutomationQuestionLoader`)가 도메인 리소스를 읽어 반환 | 로더가 `JsonMapper`(Boot 빈)를 주입받음 |

`ApprovalPolicy`·`OperationScheduler`·`ConcurrencyLimits`·`Capacity` 빈은 한도 값이 `BRIDGE_*`(접두 `bridge`) 설정에서 오므로 portal-server의 `BridgeProperties`가 확정된 뒤 3단계에서 조립한다. 2단계 portal-app에는 `@ConfigurationProperties`를 두지 않는다(접두 소유권). 2단계 시험은 `ApplicationContextRunner`로 위 빈들이 컨텍스트에 올라오고 `Clock`이 하나뿐임을 확인한다.

### 7.3 `TargetPlatform`·`CommandLineGrammar` 메서드 서명 (구현은 3단계 portal-ssh)

`CommandLineGrammar`는 6.3절의 interface(portal-domain 소유, 결정 D-01)다. `TargetPlatform`은 portal-app 소유다:
```java
package io.github.jaeseongs95.portal.app.target;
public interface TargetPlatform {
    TargetOs os();                                     // 식별값. List<TargetPlatform> → Map<TargetOs, TargetPlatform>. 빠진 값이 있으면 시작 때 실패(패턴 8.12, 체크 5)
    PathSyntax pathSyntax();                           // POSIX | WINDOWS  (RemotePath 구현 선택, 4.3절)
    TargetCapabilities capabilities(Target target);    // commandShell, fileTransfer, elevatedFileTransfer, pythonSource, agentCli, commandNameApproval (target-platform.mjs:8-14)
    CommandClassification classify(CommandText command);   // classifyForTarget (:20-28). Linux는 CommandClassifier 위임, Windows는 2개 cmdlet만 READ_ONLY
    CommandLineGrammar commandLineGrammar();           // commandNamesForTarget (:30)
    boolean deniesName(TargetRule rule, CommandText command);  // deniedForTarget (:38-43) — Windows는 마지막 경로 조각 소문자 비교, Linux는 TargetRule#denies
}
```
- `CommandClassification`(sealed 값): `record CommandClassification(CommandClass commandClass)`; `CommandClass` enum `READ_ONLY, SAFE, PRIVILEGED, UNKNOWN`(wire `read-only·safe·privileged·unknown`).
- 능력이 없는 요청: 호출 쪽이 `TargetCapabilities`를 보고 `RequestRefusedException(TARGET_CAPABILITY_UNSUPPORTED)`를 던진다(`target-platform.mjs:32-36`). `UnsupportedOperationException`은 던지지 않는다(A-LSP).
- Windows chmod 미지원·관리자 확인·에이전트 CLI 설치 같은 3단계 메서드(`PermissionResult applyPermissions(...)`, `ElevationResult checkElevation(...)`, `AgentCliPlan agentCliPlan(...)`)는 **3단계 담당이 이 interface에 더하고 이름만 여기 적는다**. 2단계 시험은 서명이 컴파일되는지와 `List<TargetPlatform>` → `EnumMap` 조립기(`TargetPlatformRegistry`, `@Component`)가 중복·누락을 시작 시 거절하는지만 확인한다.

### 7.4 3단계 이후 포트(이름만)
`RemoteExecutor`(SSH exec·취소·출력 상한, 3단계), `RemoteFileTransfer`(SFTP, 3단계), `AgentCliInstallerPort`(3단계), `AgentReleaseCatalog`(npm 레지스트리, 4단계), `RiskEvaluator`(Jev 등, 4단계), `SecretResolver`(4단계), `DesktopBackend`·`DesktopLeaseStore`(5단계), `AdminAuthMethod`(4단계), `HostHookAdapter`(portal-client 6단계, app 포트가 아님), `OperationObserver`(대기 이벤트, 3단계). 2단계는 이 포트들을 만들지 않는다.

---

## 8. portal-store

### 8.1 방침 [제안, 개발원칙 4.1~4.4]
- Spring Data JDBC(`@Table` 엔티티·리포지토리·`@Query`)와 Boot 자동 설정 `DataSource`. Flyway가 `classpath:db/migration`의 `V{n}__*.sql`을 적용한다(`spring-boot-starter-flyway`, `java/portal-store/build.gradle.kts`). H2 기본(runtimeOnly), 시험은 호환 모드 없는 내장 H2(개발원칙 7.3).
- DDL은 ANSI만: `CHAR`, `VARCHAR`, `CLOB`, `BIGINT`, `INTEGER`, `DOUBLE PRECISION`, `TIMESTAMP`(UTC, 시간대 없음), `CHECK`, `UNIQUE`, `FK`, `GENERATED BY DEFAULT AS IDENTITY`(SQL:2003). 함수·프로시저·트리거·DBMS 고유 기능 없음. 부분 인덱스·`LIMIT`·`JSON` 타입을 쓰지 않는다.
- ID: 작업·artifact·출력은 **48자리 hex**(`CHAR(48)`) — 계약의 `identifier`가 이 형식이다(`public-contract.mjs:7`). UUID(`CHAR(36)`)는 staged 파일의 공개 UUID뿐이다(`public-contract.mjs:12`).
- enum은 `VARCHAR`+`CHECK`, 값은 Java enum 이름(Spring Data JDBC 기본 매핑 「Enums get mapped to their names」, `Converter` 없음). 불리언 열을 쓰지 않는다(상태가 두 가지여도 enum).
- 시각은 `TIMESTAMP`(UTC), Java `Instant`. Spring Data JDBC가 `Instant`를 `TIMESTAMP`로 옮기는 방식과 UTC 보장은 `spring.jdbc`/드라이버 설정이 아니라 JVM `-Duser.timezone=UTC` 프리셋(개발원칙 4.5)에 의존한다 `[미확인: Spring Data JDBC의 Instant ↔ TIMESTAMP 변환이 JVM 시간대에 의존하는지 공식 문서(https://docs.spring.io/spring-data/relational/reference/jdbc/mapping.html)로 확인 필요]`. 시험이 `user.timezone`을 UTC가 아닌 값으로 두고 왕복해 같은 `Instant`가 돌아오는지 확인한다.
- 낙관적 잠금: `@Version long version`(Spring Data JDBC가 갱신 시 `WHERE id=? AND version=?`을 붙이고 불일치는 `OptimisticLockingFailureException`). 대상 표: `operation`, `artifact`, `command_output`, `command_policy`, `runtime_capacity`.
- 엔티티는 portal-store의 `record`(불변, wither)이고 portal-domain 타입과 **별개**다. 도메인에는 Spring Data 어노테이션을 붙일 수 없기 때문이다(A-DOMAIN). 변환기 `@Component`(`OperationMapper` 등)가 둘을 오간다.

### 8.2 Flyway 스크립트와 DDL 초안
파일: `V1__operation_journal.sql`, `V2__artifact.sql`, `V3__command_output.sql`, `V4__command_policy.sql`, `V5__agent_cli_request.sql`, `V6__maintenance_capacity.sql`. 표 26개.

**V1__operation_journal.sql** — 작업 저널(2.x `operations`·`operation_events`·`operation_legacy_budget` + 명령 저널 `requests`의 본문 필드)
```sql
CREATE TABLE operation (
    id                        CHAR(48)      NOT NULL,
    request_key               VARCHAR(512)  NOT NULL,   -- 신규 128자 이하, 이전 행 'legacy:<source>:<id>' 최대 512 (operation-store.mjs:23 required ≤512)
    owner_id                  VARCHAR(512)  NOT NULL,   -- 'mcp' · 'approval' · 'legacy-owner' …
    target_id                 VARCHAR(512)  NOT NULL,   -- 신규 32자 이하 별칭, 이전 행 'legacy-unbound' 또는 user@host:port
    target_revision           VARCHAR(64)   NOT NULL,   -- 64 hex 또는 'legacy-unbound'
    kind                      VARCHAR(9)    NOT NULL,
    state                     VARCHAR(11)   NOT NULL,
    version                   BIGINT        NOT NULL,
    approval_mode             VARCHAR(11)   NOT NULL,
    command_class             VARCHAR(10)   NOT NULL,
    profile                   VARCHAR(80)   NOT NULL,
    input_digest              CHAR(64),
    contract_digest           CHAR(64)      NOT NULL,
    conflict_key              VARCHAR(512),
    ready_sequence            BIGINT,
    created_at                TIMESTAMP     NOT NULL,
    accepted_at               TIMESTAMP     NOT NULL,
    updated_at                TIMESTAMP     NOT NULL,
    expires_at                TIMESTAMP,
    deadline_at               TIMESTAMP,
    ready_at                  TIMESTAMP,
    started_at                TIMESTAMP,
    finished_at               TIMESTAMP,
    cancellation_requested_at TIMESTAMP,
    outcome_certainty         VARCHAR(14),
    reconciliation            VARCHAR(12)   NOT NULL,
    recovery_reason           VARCHAR(14)   NOT NULL,
    audit_failure             VARCHAR(6)    NOT NULL,
    CONSTRAINT pk_operation PRIMARY KEY (id),
    CONSTRAINT uq_operation_request_key UNIQUE (request_key),
    CONSTRAINT ck_operation_kind CHECK (kind IN ('COMMAND','SOURCE','UPLOAD','DOWNLOAD','AGENT_CLI')),
    CONSTRAINT ck_operation_state CHECK (state IN ('ACCEPTED','PENDING','EVALUATING','QUEUED','STARTING','RUNNING','TERMINATING','COMPLETED','FAILED','CANCELLED','DENIED','EXPIRED','UNKNOWN')),
    CONSTRAINT ck_operation_approval CHECK (approval_mode IN ('OWNER','AUTOMATIC','NOT_DECIDED')),
    CONSTRAINT ck_operation_class CHECK (command_class IN ('READ_ONLY','SAFE','PRIVILEGED','UNKNOWN')),
    CONSTRAINT ck_operation_certainty CHECK (outcome_certainty IS NULL OR outcome_certainty IN ('NOT_DISPATCHED','EXITED','UNKNOWN')),
    CONSTRAINT ck_operation_reconcile CHECK (reconciliation IN ('NOT_REQUIRED','REQUIRED')),
    CONSTRAINT ck_operation_recovery CHECK (recovery_reason IN ('NONE','BRIDGE_RESTART','LEGACY_IMPORT')),
    CONSTRAINT ck_operation_audit CHECK (audit_failure IN ('NONE','FAILED')),
    CONSTRAINT ck_operation_revision CHECK (LENGTH(target_revision) = 64 OR target_revision = 'legacy-unbound'),
    CONSTRAINT ck_operation_version CHECK (version >= 1)
);
CREATE INDEX ix_operation_ready ON operation (state, ready_sequence);
CREATE INDEX ix_operation_target_state ON operation (target_id, state);
CREATE INDEX ix_operation_created ON operation (created_at, id);

CREATE TABLE operation_event (
    event_sequence BIGINT GENERATED BY DEFAULT AS IDENTITY NOT NULL,
    operation_id   CHAR(48)     NOT NULL,
    version        BIGINT       NOT NULL,
    state          VARCHAR(11)  NOT NULL,
    occurred_at    TIMESTAMP    NOT NULL,
    CONSTRAINT pk_operation_event PRIMARY KEY (event_sequence),
    CONSTRAINT uq_operation_event_version UNIQUE (operation_id, version),
    CONSTRAINT fk_operation_event_op FOREIGN KEY (operation_id) REFERENCES operation (id),
    CONSTRAINT ck_operation_event_state CHECK (state IN ('ACCEPTED','PENDING','EVALUATING','QUEUED','STARTING','RUNNING','TERMINATING','COMPLETED','FAILED','CANCELLED','DENIED','EXPIRED','UNKNOWN'))
);

-- 종류별 입력(1:1). 2.x 는 body JSON 안의 operation 필드였다(approval-queue.mjs:58, command-automation.mjs:111-114, files.mjs:42-46).
CREATE TABLE operation_command (
    operation_id    CHAR(48) NOT NULL,
    command_text    CLOB     NOT NULL,
    caller_context  CLOB     NOT NULL,
    display_context CLOB     NOT NULL,
    CONSTRAINT pk_operation_command PRIMARY KEY (operation_id),
    CONSTRAINT fk_operation_command_op FOREIGN KEY (operation_id) REFERENCES operation (id)
);
CREATE TABLE operation_source (          -- 소스 본문은 저장하지 않는다(2.x: 메모리 비공개 계획, 재시작 시 unknown)
    operation_id         CHAR(48)     NOT NULL,
    launcher_command     CLOB         NOT NULL,
    source_contract      VARCHAR(16)  NOT NULL,
    plan_digest          CHAR(64)     NOT NULL,
    source_sha256        CHAR(64)     NOT NULL,
    source_bytes         INTEGER      NOT NULL,
    argv_json            CLOB         NOT NULL,
    cwd                  VARCHAR(512) NOT NULL,
    elevation            VARCHAR(4)   NOT NULL,
    environment_revision CHAR(64)     NOT NULL,
    caller_context       CLOB         NOT NULL,
    display_context      CLOB         NOT NULL,
    CONSTRAINT pk_operation_source PRIMARY KEY (operation_id),
    CONSTRAINT fk_operation_source_op FOREIGN KEY (operation_id) REFERENCES operation (id),
    CONSTRAINT ck_operation_source_contract CHECK (source_contract = 'PYTHON_SOURCE_V1'),
    CONSTRAINT ck_operation_source_elev CHECK (elevation IN ('NONE','SUDO')),
    CONSTRAINT ck_operation_source_bytes CHECK (source_bytes >= 1 AND source_bytes <= 16384)
);
CREATE TABLE operation_upload (          -- artifact_id 에 FK 를 두지 않는다: artifact 는 이력보다 먼저 해제된다(A-495)
    operation_id          CHAR(48)      NOT NULL,
    artifact_id           CHAR(48)      NOT NULL,
    remote_path           VARCHAR(4096) NOT NULL,
    file_name             VARCHAR(255)  NOT NULL,
    size_bytes            BIGINT        NOT NULL,
    sha256                CHAR(64)      NOT NULL,
    overwrite_mode        VARCHAR(15)   NOT NULL,
    elevation             VARCHAR(4)    NOT NULL,
    file_target_id        VARCHAR(32),
    file_target_revision  CHAR(64),
    upload_protocol       VARCHAR(12),
    CONSTRAINT pk_operation_upload PRIMARY KEY (operation_id),
    CONSTRAINT fk_operation_upload_op FOREIGN KEY (operation_id) REFERENCES operation (id),
    CONSTRAINT ck_operation_upload_overwrite CHECK (overwrite_mode IN ('REPLACE','FAIL_IF_EXISTS')),
    CONSTRAINT ck_operation_upload_elev CHECK (elevation IN ('NONE','SUDO')),
    CONSTRAINT ck_operation_upload_protocol CHECK (upload_protocol IS NULL OR upload_protocol = 'MCP_JSON_V1'),
    CONSTRAINT ck_operation_upload_binding CHECK ((file_target_id IS NULL AND file_target_revision IS NULL) OR (file_target_id IS NOT NULL AND file_target_revision IS NOT NULL))
);
CREATE TABLE operation_download (
    operation_id          CHAR(48)      NOT NULL,
    remote_path           VARCHAR(4096) NOT NULL,
    elevation             VARCHAR(4)    NOT NULL,
    file_target_id        VARCHAR(32),
    file_target_revision  CHAR(64),
    caller_context        CLOB          NOT NULL,
    display_context       CLOB          NOT NULL,
    CONSTRAINT pk_operation_download PRIMARY KEY (operation_id),
    CONSTRAINT fk_operation_download_op FOREIGN KEY (operation_id) REFERENCES operation (id),
    CONSTRAINT ck_operation_download_elev CHECK (elevation IN ('NONE','SUDO')),
    CONSTRAINT ck_operation_download_binding CHECK ((file_target_id IS NULL AND file_target_revision IS NULL) OR (file_target_id IS NOT NULL AND file_target_revision IS NOT NULL))
);

-- 자동 승인 결정(2.x job.decision, command-automation.mjs:134-159)
CREATE TABLE operation_decision (
    operation_id             CHAR(48)     NOT NULL,
    decision                 VARCHAR(7)   NOT NULL,
    reason_code              VARCHAR(34)  NOT NULL,
    review_reason            VARCHAR(20),
    policy_revision          BIGINT       NOT NULL,
    provider                 VARCHAR(6),
    decision_rule_version    VARCHAR(32),
    question_version         VARCHAR(4),
    threshold_model          VARCHAR(100),
    threshold_min_low_risk   DOUBLE PRECISION,
    assessed_label           VARCHAR(9),
    assessed_low_risk        DOUBLE PRECISION,
    assessed_confidence      DOUBLE PRECISION,
    assessed_input_tokens    BIGINT,
    assessed_output_tokens   BIGINT,
    prompt_revision          VARCHAR(48),
    prompt_sha256            CHAR(64),
    assessed_at              TIMESTAMP,
    latency_ms               BIGINT,
    caller_context_provided  VARCHAR(3),
    model_called             VARCHAR(3),
    CONSTRAINT pk_operation_decision PRIMARY KEY (operation_id),
    CONSTRAINT fk_operation_decision_op FOREIGN KEY (operation_id) REFERENCES operation (id),
    CONSTRAINT ck_operation_decision_kind CHECK (decision IN ('EXECUTE','REVIEW','DENY')),
    CONSTRAINT ck_operation_decision_reason CHECK (reason_code IN ('POLICY_DENIED','TEST_SERVER_BYPASS','SOURCE_EXECUTION_NOT_ENABLED','SOURCE_PRIVILEGE_POLICY_REVIEW','SOURCE_COMMAND_POLICY_REVIEW','SUDO_NOT_ENABLED','COMMAND_SET','DISCLOSURE_NOT_ENABLED','CONTEXT_REQUIRED','SENSITIVE_INPUT','SOURCE_EVIDENCE_TOO_LARGE','BUDGET_EXHAUSTED','POLICY_CHANGED','EVALUATION_UNAVAILABLE','MODEL_PASSED','MODEL_REVIEW','OBSERVATION_ONLY','EVALUATION_FAILED','EXECUTION_BUSY','EXECUTION_START_FAILED')),
    CONSTRAINT ck_operation_decision_review CHECK (review_reason IS NULL OR review_reason IN ('EXECUTION_DISABLED','THRESHOLD_MISSING','MODEL_MISMATCH','QUESTION_MISMATCH','BASIS_MISMATCH','HIGH_RISK','BELOW_THRESHOLD')),
    CONSTRAINT ck_operation_decision_provider CHECK (provider IS NULL OR provider IN ('JEV','LUNA','SONNET')),
    CONSTRAINT ck_operation_decision_label CHECK (assessed_label IS NULL OR assessed_label IN ('LOW_RISK','HIGH_RISK')),
    CONSTRAINT ck_operation_decision_flags CHECK ((caller_context_provided IS NULL OR caller_context_provided IN ('YES','NO')) AND (model_called IS NULL OR model_called IN ('YES','NO')))
);
CREATE TABLE operation_decision_attempt (
    operation_id    CHAR(48)     NOT NULL,
    attempt_no      INTEGER      NOT NULL,
    provider        VARCHAR(6)   NOT NULL,
    status          VARCHAR(11)  NOT NULL,
    reason          VARCHAR(20),
    failure_reason  VARCHAR(24),
    diagnostic      VARCHAR(40),
    CONSTRAINT pk_operation_decision_attempt PRIMARY KEY (operation_id, attempt_no),
    CONSTRAINT fk_operation_decision_attempt FOREIGN KEY (operation_id) REFERENCES operation_decision (operation_id),
    CONSTRAINT ck_operation_attempt_provider CHECK (provider IN ('JEV','LUNA','SONNET')),
    CONSTRAINT ck_operation_attempt_status CHECK (status = 'UNAVAILABLE')
);
CREATE TABLE operation_decision_command (
    operation_id  CHAR(48)     NOT NULL,
    position      INTEGER      NOT NULL,
    command_name  VARCHAR(512) NOT NULL,
    CONSTRAINT pk_operation_decision_command PRIMARY KEY (operation_id, position),
    CONSTRAINT fk_operation_decision_command FOREIGN KEY (operation_id) REFERENCES operation_decision (operation_id)
);

-- 확정된 결과(2.x job.result / outcome, operation-store.mjs:261-269, public-contract.mjs:24-46, 119-143)
CREATE TABLE operation_result (
    operation_id            CHAR(48)      NOT NULL,
    result_flag             VARCHAR(6)    NOT NULL,
    exec_reason             VARCHAR(20),
    remote_state            VARCHAR(14),
    exit_kind               VARCHAR(8)    NOT NULL,
    exit_code               INTEGER,
    exit_signal             VARCHAR(32),
    signal_delivery         VARCHAR(11),
    timeout_ms              BIGINT,
    cleanup                 VARCHAR(10),
    exec_reconciliation     VARCHAR(12),
    output_state            VARCHAR(8),
    capture                 VARCHAR(6),
    stdout_received_bytes   BIGINT,
    stdout_retained_bytes   BIGINT,
    stdout_cursor           BIGINT,
    stdout_truncated        VARCHAR(9),
    stderr_received_bytes   BIGINT,
    stderr_retained_bytes   BIGINT,
    stderr_cursor           BIGINT,
    stderr_truncated        VARCHAR(9),
    failure_kind            VARCHAR(12)   NOT NULL,
    failure_stage           VARCHAR(18),
    failure_code            VARCHAR(30),
    failure_remote_outcome  VARCHAR(11),
    dispatch_reason         VARCHAR(24),
    dispatch_stage          VARCHAR(24),
    artifact_file_name      VARCHAR(255),
    artifact_size_bytes     BIGINT,
    artifact_sha256         CHAR(64),
    file_error_code         VARCHAR(40),
    allowed_root            VARCHAR(4096),
    diag_origin             VARCHAR(6),
    diag_policy_reason      VARCHAR(120),
    diag_native_step        VARCHAR(80),
    diag_native_error       INTEGER,
    remote_cleanup          VARCHAR(11),
    result_texts            CLOB          NOT NULL,
    CONSTRAINT pk_operation_result PRIMARY KEY (operation_id),
    CONSTRAINT fk_operation_result_op FOREIGN KEY (operation_id) REFERENCES operation (id),
    CONSTRAINT ck_operation_result_flag CHECK (result_flag IN ('FAILED','OK')),
    CONSTRAINT ck_operation_result_reason CHECK (exec_reason IS NULL OR exec_reason IN ('EXIT','DEADLINE','CANCEL','TRANSPORT_LOST','CHANNEL_OPEN_FAILED','INPUT_FAILED')),
    CONSTRAINT ck_operation_result_remote CHECK (remote_state IS NULL OR remote_state IN ('NOT_DISPATCHED','EXITED','UNKNOWN')),
    CONSTRAINT ck_operation_result_exit CHECK (exit_kind IN ('EXITED','SIGNALED','NO_EXIT')),
    CONSTRAINT ck_operation_result_signal CHECK (signal_delivery IS NULL OR signal_delivery IN ('REQUESTED','UNSUPPORTED')),
    CONSTRAINT ck_operation_result_cleanup CHECK (cleanup IS NULL OR cleanup IN ('COMPLETE','INCOMPLETE')),
    CONSTRAINT ck_operation_result_recon CHECK (exec_reconciliation IS NULL OR exec_reconciliation IN ('NOT_REQUIRED','REQUIRED')),
    CONSTRAINT ck_operation_result_output CHECK (output_state IS NULL OR output_state IN ('PARTIAL','COMPLETE')),
    CONSTRAINT ck_operation_result_capture CHECK (capture IS NULL OR capture IN ('OK','FAILED')),
    CONSTRAINT ck_operation_result_trunc CHECK ((stdout_truncated IS NULL OR stdout_truncated IN ('TRUNCATED','COMPLETE')) AND (stderr_truncated IS NULL OR stderr_truncated IN ('TRUNCATED','COMPLETE'))),
    CONSTRAINT ck_operation_result_fkind CHECK (failure_kind IN ('NONE','CLASSIFIED','UNCLASSIFIED')),
    CONSTRAINT ck_operation_result_fstage CHECK (failure_stage IS NULL OR failure_stage IN ('SSH_CONNECT','SSH_CHANNEL','SSH_EXECUTION','OUTPUT_RESERVATION','OUTPUT_CAPTURE','OPERATION')),
    CONSTRAINT ck_operation_result_fcode CHECK (failure_code IS NULL OR failure_code IN ('SSH_CONNECT_FAILED','SSH_CHANNEL_OPEN_FAILED','SSH_EXECUTION_FAILED','OUTPUT_CAPACITY','OUTPUT_CAPTURE_FAILED','OPERATION_FAILED','ARTIFACT_QUOTA')),
    CONSTRAINT ck_operation_result_fremote CHECK (failure_remote_outcome IS NULL OR failure_remote_outcome IN ('NOT_STARTED','UNKNOWN','COMPLETED')),
    CONSTRAINT ck_operation_result_dreason CHECK (dispatch_reason IS NULL OR dispatch_reason IN ('UNKNOWN','MAINTENANCE','REQUEST_STATE','AUTHORITY','INVALID_COMMAND','PRIVATE_PLAN','TARGET_CHANGED','POLICY_CHANGED','POLICY_DENIED','PLAN_EXPIRED','BUSY','QUEUE_FULL','CLAIM_FAILED','AUDIT_FAILED','PERSISTENCE_FAILED')),
    CONSTRAINT ck_operation_result_dstage CHECK (dispatch_stage IS NULL OR dispatch_stage IN ('UNKNOWN','MAINTENANCE','REQUEST_STATE','AUTHORITY','COMMAND_VALIDATION','COMMAND_GUARD','FILE_GUARD','SOURCE_PLAN','TARGET_GUARD','CLI_GUARD','POLICY_GUARD','BUSY_CHECK','EXECUTION_QUEUE','EXECUTION_CLAIM','DECISION_PERSISTENCE','DECISION_AUDIT','EVALUATION_PERSISTENCE','START_AUDIT','START_PERSISTENCE')),
    CONSTRAINT ck_operation_result_origin CHECK (diag_origin IS NULL OR diag_origin IN ('POLICY','OS')),
    CONSTRAINT ck_operation_result_rcleanup CHECK (remote_cleanup IS NULL OR remote_cleanup IN ('CONFIRMED','UNCONFIRMED'))
);

-- 이전된 2.x 이력의 원문 보존(operation_legacy_budget + body.legacy, operation-store.mjs:33-37, 64-67, 103-111)
CREATE TABLE operation_legacy (
    operation_id   CHAR(48)      NOT NULL,
    legacy_source  VARCHAR(512)  NOT NULL,
    original_bytes BIGINT        NOT NULL,
    reserved_bytes BIGINT        NOT NULL,
    legacy_digest  CHAR(64),
    original_text  CLOB          NOT NULL,
    CONSTRAINT pk_operation_legacy PRIMARY KEY (operation_id),
    CONSTRAINT fk_operation_legacy_op FOREIGN KEY (operation_id) REFERENCES operation (id),
    CONSTRAINT ck_operation_legacy_bytes CHECK (original_bytes >= 0 AND original_bytes <= 262144 AND reserved_bytes >= 0)
);
```
- `[사실]` 2.x는 정규 표(`operations`)의 `body` 열에 JSON 한 덩이로 모든 필드를 담고 `contract` 열(정렬된 JSON)과 그 SHA-256 `digest`로 멱등을 확인했다. 3.0은 열로 풀고 계약 digest만 `contract_digest`로 남긴다(`Operation#contractDigest`는 도메인이 계산: 불변 필드 `owner, targetId, targetRevision, kind, 입력, inputDigest, conflictKey, expiresAt, deadline`을 고정 순서 정규형으로 `Digester`에 넣음). 2.x의 `generation`·`policyRevision`·`approval` 계약 필드는 생산 코드에서 설정하는 곳이 0이라 열을 만들지 않았다(`[사실: src/**`에서 `generation:`·`deadline:`을 설정하는 곳을 찾지 못함, 요청 키 검사에만 등장 `operation-store.mjs:28-32`] — 결정 D-10). `deadline_at`·`conflict_key`는 스케줄러가 읽으므로(`operation-scheduler.mjs:99`, `operation-store.mjs:257`) 유지한다.
- `[제안]` `kind`에 `AGENT_CLI`를 더한 이유: 2.x는 CLI 요청을 별도 SQLite 저널(`agent-cli.sqlite`)에 같은 job 모양으로 두고 스케줄러 슬롯만 공유했다(A-073). 상태 기계를 하나로 합치려고(2.1절) 같은 `operation` 행에 `AGENT_CLI`로 두고 세부는 `agent_cli_request`(V5)에 둔다. 공개 wire `kind` 4값에는 나오지 않는다(owner HTTP 전용, 2.x `kind:'command'`로 보였음 — 표시는 4단계). 결정 D-11.
- `[제안]` 작업 이력의 상한: 2.x는 `maxRows 10000`·`maxBytes 64MiB`를 넘으면 `OPERATION_CAPACITY`로 새 접수를 거절(`operation-store.mjs:99-102`)하고 저널 행 상한을 명령·CLI 저널에도 10000으로 걸었다(`command-state.mjs:65`). 3.0은 행 수 상한(`COUNT(*) < 10000 + legacy 행 수`)만 둔다. 바이트 상한은 본문이 열·CLOB 길이 제약으로 바뀌어 의미가 없다. 결정 D-12.
- `[제안]` `operation_fence`(선택 O-2): `CREATE TABLE operation_fence (target_id VARCHAR(512) NOT NULL, target_revision VARCHAR(64) NOT NULL, conflict_key VARCHAR(512) NOT NULL, operation_id CHAR(48) NOT NULL, CONSTRAINT pk_operation_fence PRIMARY KEY (target_id, target_revision, conflict_key), CONSTRAINT fk_operation_fence_op FOREIGN KEY (operation_id) REFERENCES operation (id))`. claim이 `STARTING`으로 가면서 한 행을 넣고 종료(`UNKNOWN` 제외 5종)로 가면서 지운다. 같은 키의 동시 claim은 PK 충돌(`DuplicateKeyException`)로 막힌다. 3.3절의 SERIALIZABLE을 H2에서 확인하지 못하면 이 표와 `operation_slot`(전역·대상별 슬롯 PK)으로 한도를 DB 제약으로 옮긴다. 기본안에는 넣지 않았다(표 26개는 이 선택 표를 세지 않음).

**V2__artifact.sql** — artifact 메타(2.x는 `<id>.json` manifest 파일, `artifacts.mjs:91-149`; 바이트는 `<id>.part` 파일)
```sql
CREATE TABLE artifact (
    id                      CHAR(48)      NOT NULL,
    direction               VARCHAR(8)    NOT NULL,
    purpose                 VARCHAR(8)    NOT NULL,
    state                   VARCHAR(9)    NOT NULL,
    public_uuid             CHAR(36),
    owner_id                VARCHAR(512),
    operation_key           VARCHAR(128),
    file_name               VARCHAR(255)  NOT NULL,
    remote_path             VARCHAR(4096),
    size_bytes              BIGINT        NOT NULL,
    received_bytes          BIGINT        NOT NULL,
    chunk_count             INTEGER       NOT NULL,
    sha256                  CHAR(64),
    target_id               VARCHAR(32),
    target_revision         CHAR(64),
    file_target_binding     VARCHAR(7)    NOT NULL,
    upload_protocol         VARCHAR(12),
    overwrite_mode          VARCHAR(15)   NOT NULL,
    elevation               VARCHAR(4)    NOT NULL,
    retention               VARCHAR(10)   NOT NULL,
    expires_at              TIMESTAMP     NOT NULL,
    submission_id           CHAR(48),
    consume_reason          VARCHAR(7),
    provenance_source_uuid  CHAR(36),
    provenance_owner_id     VARCHAR(512),
    provenance_request_id   CHAR(48),
    version                 BIGINT        NOT NULL,
    created_at              TIMESTAMP     NOT NULL,
    CONSTRAINT pk_artifact PRIMARY KEY (id),
    CONSTRAINT uq_artifact_public_uuid UNIQUE (public_uuid),
    CONSTRAINT uq_artifact_owner_key UNIQUE (owner_id, operation_key),
    CONSTRAINT ck_artifact_direction CHECK (direction IN ('UPLOAD','DOWNLOAD')),
    CONSTRAINT ck_artifact_purpose CHECK (purpose IN ('STAGED','TRANSFER')),
    CONSTRAINT ck_artifact_state CHECK (state IN ('STAGING','READY','DELETING','CONSUMING','CONSUMED')),
    CONSTRAINT ck_artifact_binding CHECK (file_target_binding IN ('BOUND','UNBOUND')),
    CONSTRAINT ck_artifact_protocol CHECK (upload_protocol IS NULL OR upload_protocol = 'MCP_JSON_V1'),
    CONSTRAINT ck_artifact_overwrite CHECK (overwrite_mode IN ('REPLACE','FAIL_IF_EXISTS')),
    CONSTRAINT ck_artifact_elevation CHECK (elevation IN ('NONE','SUDO')),
    CONSTRAINT ck_artifact_retention CHECK (retention IN ('PINNED','RELEASABLE')),
    CONSTRAINT ck_artifact_consume CHECK (consume_reason IS NULL OR consume_reason IN ('MOVED','REMOVED')),
    CONSTRAINT ck_artifact_sizes CHECK (size_bytes >= 0 AND size_bytes <= 67108864 AND received_bytes >= 0 AND received_bytes <= size_bytes AND chunk_count >= 0),
    CONSTRAINT ck_artifact_staged CHECK (purpose <> 'STAGED' OR (public_uuid IS NOT NULL AND owner_id IS NOT NULL AND operation_key IS NOT NULL AND remote_path IS NULL AND target_id IS NULL))
);
CREATE INDEX ix_artifact_state_expiry ON artifact (state, expires_at);
CREATE TABLE artifact_chunk (
    artifact_id CHAR(48) NOT NULL,
    chunk_no    INTEGER  NOT NULL,
    size_bytes  INTEGER  NOT NULL,
    sha256      CHAR(64) NOT NULL,
    CONSTRAINT pk_artifact_chunk PRIMARY KEY (artifact_id, chunk_no),
    CONSTRAINT fk_artifact_chunk FOREIGN KEY (artifact_id) REFERENCES artifact (id),
    CONSTRAINT ck_artifact_chunk_size CHECK (size_bytes >= 1 AND size_bytes <= 262144)
);
CREATE TABLE staged_action (
    artifact_id     CHAR(48)      NOT NULL,
    operation_key   VARCHAR(128)  NOT NULL,
    request_key     VARCHAR(128)  NOT NULL,
    input_digest    CHAR(64)      NOT NULL,
    request_id      CHAR(48)      NOT NULL,
    action          VARCHAR(4)    NOT NULL,
    state           VARCHAR(8)    NOT NULL,
    target_id       VARCHAR(32)   NOT NULL,
    target_revision CHAR(64)      NOT NULL,
    remote_path     VARCHAR(4096) NOT NULL,
    overwrite_mode  VARCHAR(15)   NOT NULL,
    elevation       VARCHAR(4)    NOT NULL,
    CONSTRAINT pk_staged_action PRIMARY KEY (artifact_id, operation_key),
    CONSTRAINT fk_staged_action FOREIGN KEY (artifact_id) REFERENCES artifact (id),
    CONSTRAINT ck_staged_action_kind CHECK (action IN ('COPY','MOVE')),
    CONSTRAINT ck_staged_action_state CHECK (state IN ('RESERVED','SUBMITTED','REFUSED','SETTLED')),
    CONSTRAINT ck_staged_action_overwrite CHECK (overwrite_mode IN ('REPLACE','FAIL_IF_EXISTS')),
    CONSTRAINT ck_staged_action_elev CHECK (elevation IN ('NONE','SUDO'))
);
```
- `[사실]` 청크 이력(`chunks[]`의 SHA-256·크기), `sequence`(수신한 청크 수), `received`, 상태 5종, 소유자·`operationKey`·액션 목록·`consumeReason`(`moved`·`removed`)·출처(`provenance`의 세 필드)·`submissionId`·`fileTargetBound`·`uploadProtocol`은 manifest의 필드(`artifacts.mjs:19-31, 91-149`)이고 위 열이 그대로 대응한다. `purpose`는 `staged` 또는 없음(`artifacts.mjs:36, 260`)이라 `STAGED`/`TRANSFER` 두 값이다. 예산은 열이 아니라 질의로 센다: 점유 = `SUM(CASE WHEN state = 'CONSUMED' THEN 1 WHEN size_bytes < 1 THEN 1 ELSE size_bytes END)`(`artifacts.mjs:18`의 `charge`), 기본 예산 512MiB(`:61`, `B-440`).
- `[사실]` 격리(`quarantine`)·고아 복구(`#restoreOrphans`, `artifacts.mjs:186-205`)는 파일 시스템 상태라 표에 두지 않는다.

**V3__command_output.sql** — 출력 manifest(2.x `manifest.sqlite`의 `outputs`, `command-output.mjs:53`)
```sql
CREATE TABLE command_output (
    id              CHAR(48)     NOT NULL,
    execution_id    CHAR(48)     NOT NULL,
    target_id       VARCHAR(32),
    target_revision CHAR(64),
    state           VARCHAR(11)  NOT NULL,
    expires_at      TIMESTAMP    NOT NULL,
    size_bytes      BIGINT,
    charge_bytes    BIGINT       NOT NULL,
    stream_state    VARCHAR(8)   NOT NULL,
    stream_bytes    BIGINT,
    stream_size     BIGINT,
    stream_sha256   CHAR(64),
    stdout_cursor   BIGINT,
    stderr_cursor   BIGINT,
    stream_truncated VARCHAR(9),
    version         BIGINT       NOT NULL,
    CONSTRAINT pk_command_output PRIMARY KEY (id),
    CONSTRAINT fk_command_output_op FOREIGN KEY (execution_id) REFERENCES operation (id),
    CONSTRAINT ck_command_output_state CHECK (state IN ('PENDING','READY','UNAVAILABLE')),
    CONSTRAINT ck_command_output_stream CHECK (stream_state IN ('NONE','OPEN','COMPLETE')),
    CONSTRAINT ck_command_output_trunc CHECK (stream_truncated IS NULL OR stream_truncated IN ('TRUNCATED','COMPLETE')),
    CONSTRAINT ck_command_output_charge CHECK (charge_bytes >= 0)
);
CREATE INDEX ix_command_output_expiry ON command_output (state, expires_at);
CREATE TABLE command_output_format (
    output_id  CHAR(48) NOT NULL,
    format     VARCHAR(4) NOT NULL,
    offset_bytes BIGINT NOT NULL,
    size_bytes BIGINT   NOT NULL,
    sha256     CHAR(64) NOT NULL,
    CONSTRAINT pk_command_output_format PRIMARY KEY (output_id, format),
    CONSTRAINT fk_command_output_format FOREIGN KEY (output_id) REFERENCES command_output (id),
    CONSTRAINT ck_command_output_format CHECK (format IN ('JSON','TEXT'))
);
CREATE TABLE command_output_page (
    output_id CHAR(48)   NOT NULL,
    format    VARCHAR(4) NOT NULL,
    page_no   INTEGER    NOT NULL,
    sha256    CHAR(64)   NOT NULL,
    CONSTRAINT pk_command_output_page PRIMARY KEY (output_id, format, page_no),
    CONSTRAINT fk_command_output_page FOREIGN KEY (output_id, format) REFERENCES command_output_format (output_id, format)
);
```
- `[사실]` manifest 본문의 필드: `id`, `binding{executionId, targetId, targetRevision?}`, `state`(`pending`·`ready`·`unavailable`; `expired`는 만료 시각으로 파생 `command-output.mjs:137`), `expiresAt`, `formats{text|json:{offset, bytes, sha256, chunks[페이지별 SHA-256]}}`, `size`, `stream{bytes, size, sha256, stdoutCursor, stderrCursor, truncated, complete}`, 그리고 행의 `charge`·`digest`(본문 JSON의 SHA-256, `:53, 101`). 3.0은 `digest`(행 위변조 점검)를 두지 않는다(DB가 무결성을 맡는다). 한도: TTL 1시간, 파일당 16MiB, 총 128MiB, 최대 1000건, 디스크 여유 ≥ 한도 + 1MiB(`:8, 144-147`). 상태 `expired`는 열에 저장하지 않는다(파생). `execution_id`에 FK를 둔 것은 2.x가 실행 id를 필수 결속으로 둔 것(`binding.executionId`)을 DB 제약으로 올린 제안이다.

**V4__command_policy.sql** — 명령 정책(2.x `policy(id=1, revision, body)`, `command-state.mjs:16`)
```sql
CREATE TABLE command_policy (
    id       INTEGER NOT NULL,
    revision BIGINT  NOT NULL,
    CONSTRAINT pk_command_policy PRIMARY KEY (id),
    CONSTRAINT ck_command_policy_single CHECK (id = 1),
    CONSTRAINT ck_command_policy_revision CHECK (revision >= 0)
);
INSERT INTO command_policy (id, revision) VALUES (1, 0);
CREATE TABLE command_policy_rule (
    target_id             VARCHAR(32) NOT NULL,
    target_revision       CHAR(64)    NOT NULL,
    profile               VARCHAR(80) NOT NULL,
    os                    VARCHAR(7)  NOT NULL,
    external_disclosure   VARCHAR(3)  NOT NULL,
    model_execution       VARCHAR(3)  NOT NULL,
    automatic_uploads     VARCHAR(3)  NOT NULL,
    automatic_downloads   VARCHAR(3)  NOT NULL,
    automatic_sudo        VARCHAR(3)  NOT NULL,
    test_server           VARCHAR(3)  NOT NULL,
    source_contract       VARCHAR(16) NOT NULL,
    fallback              VARCHAR(6)  NOT NULL,
    CONSTRAINT pk_command_policy_rule PRIMARY KEY (target_id),
    CONSTRAINT ck_policy_rule_os CHECK (os IN ('LINUX','WINDOWS')),
    CONSTRAINT ck_policy_rule_toggles CHECK (external_disclosure IN ('ON','OFF') AND model_execution IN ('ON','OFF') AND automatic_uploads IN ('ON','OFF') AND automatic_downloads IN ('ON','OFF') AND automatic_sudo IN ('ON','OFF') AND test_server IN ('ON','OFF')),
    CONSTRAINT ck_policy_rule_source CHECK (source_contract IN ('NONE','PYTHON_SOURCE_V1')),
    CONSTRAINT ck_policy_rule_fallback CHECK (fallback IN ('NONE','LUNA','SONNET'))
);
CREATE TABLE command_policy_name (
    target_id    VARCHAR(32)  NOT NULL,
    list_kind    VARCHAR(7)   NOT NULL,
    position     INTEGER      NOT NULL,
    command_name VARCHAR(512) NOT NULL,
    CONSTRAINT pk_command_policy_name PRIMARY KEY (target_id, list_kind, position),
    CONSTRAINT uq_command_policy_name UNIQUE (target_id, list_kind, command_name),
    CONSTRAINT fk_command_policy_name FOREIGN KEY (target_id) REFERENCES command_policy_rule (target_id),
    CONSTRAINT ck_command_policy_kind CHECK (list_kind IN ('ALLOWED','DENIED'))
);
CREATE TABLE command_policy_threshold (
    target_id         VARCHAR(32)      NOT NULL,
    provider          VARCHAR(6)       NOT NULL,
    model             VARCHAR(100)     NOT NULL,
    question_version  VARCHAR(2)       NOT NULL,
    basis             VARCHAR(23)      NOT NULL,
    min_low_risk      DOUBLE PRECISION NOT NULL,
    min_confidence    DOUBLE PRECISION,
    validation_ref    VARCHAR(200)     NOT NULL,
    CONSTRAINT pk_command_policy_threshold PRIMARY KEY (target_id, provider),
    CONSTRAINT fk_command_policy_threshold FOREIGN KEY (target_id) REFERENCES command_policy_rule (target_id),
    CONSTRAINT ck_policy_threshold_provider CHECK (provider IN ('JEV','LUNA','SONNET')),
    CONSTRAINT ck_policy_threshold_question CHECK (question_version IN ('V2','V3','V4','V5')),
    CONSTRAINT ck_policy_threshold_basis CHECK (basis IN ('LEGACY','SAFETY_PROBABILITY_V1')),
    CONSTRAINT ck_policy_threshold_range CHECK (min_low_risk > 0.5 AND min_low_risk <= 1 AND (min_confidence IS NULL OR (min_confidence > 0.5 AND min_confidence <= 1))),
    CONSTRAINT ck_policy_threshold_shape CHECK ((basis = 'SAFETY_PROBABILITY_V1' AND min_confidence IS NULL) OR (basis = 'LEGACY' AND min_confidence IS NOT NULL))
);
```
- `[사실]` 정책 문서 불변식(대상 ≤ 32, 이름 ≤ 128, 확률 범위, 확률 기준이면 `minConfidence` 없음)은 `command-policy.mjs:43-71`. DB CHECK는 범위·모양만 막고 개수 상한(≤32, ≤128)은 도메인(`CommandPolicyDocument`)이 막는다. `command_policy` 시드 행 `INSERT`는 마이그레이션 스크립트의 정적 데이터이며 DB 로직이 아니다. `revision`은 `@Version`처럼 `UPDATE … WHERE id = 1 AND revision = ?`(2.x `setPolicy`, `command-state.mjs:45-51`)로 CAS한다. 자동 승인 결정은 V1의 `operation_decision`이 소유한다(2.x는 명령 저널 `requests.body`에 있었음).

**V5__agent_cli_request.sql**
```sql
CREATE TABLE agent_cli_request (
    operation_id                  CHAR(48)     NOT NULL,
    provider                      VARCHAR(6)   NOT NULL,
    action                        VARCHAR(7)   NOT NULL,
    package_name                  VARCHAR(100) NOT NULL,
    release_version               VARCHAR(20)  NOT NULL,
    release_tarball               VARCHAR(512) NOT NULL,
    release_integrity             VARCHAR(100) NOT NULL,
    release_digest                CHAR(71)     NOT NULL,
    expected_installation_revision CHAR(64)    NOT NULL,
    intent_digest                 CHAR(71)     NOT NULL,
    plan_expires_at               TIMESTAMP    NOT NULL,
    remote_state                  VARCHAR(10),
    remote_version                VARCHAR(20),
    remote_error                  VARCHAR(14),
    remote_cleanup_failures       INTEGER,
    CONSTRAINT pk_agent_cli_request PRIMARY KEY (operation_id),
    CONSTRAINT fk_agent_cli_request_op FOREIGN KEY (operation_id) REFERENCES operation (id),
    CONSTRAINT ck_agent_cli_provider CHECK (provider IN ('CODEX','CLAUDE')),
    CONSTRAINT ck_agent_cli_action CHECK (action IN ('INSTALL','UPDATE')),
    CONSTRAINT ck_agent_cli_remote CHECK (remote_state IS NULL OR remote_state IN ('NOT_FOUND','UNKNOWN','PREPARING','INSTALLING','COMPLETED','REUSED','FAILED')),
    CONSTRAINT ck_agent_cli_error CHECK (remote_error IS NULL OR remote_error = 'INSTALL_FAILED'),
    CONSTRAINT ck_agent_cli_cleanup CHECK (remote_cleanup_failures IS NULL OR remote_cleanup_failures > 0)
);
```
- `[사실]` 2.x `requests(id, request_key UNIQUE NOT NULL, digest, body, remote_status)`(`agent-cli-state.mjs:20`). 요청 키는 `agent-cli:` + 16~128자(`:44-48`)로 `operation.request_key`(≤512)에, `digest`는 `operation.contract_digest`/`input_digest`에, `body`(≤ 64KiB, `:16-17`)는 위 열로 풀렸다. 원격 상태는 `{provider, operationId, state, login:'not_checked', version?, error?, cleanupFailures?}`(`:51-58`): `login`은 항상 `not_checked`라 열이 없다. `version`은 `^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$`(`:55`), `state`가 `not_found`가 아니면 필수, `failed`일 때만 `error`가 `INSTALL_FAILED`(`:57-58`) — `[제안]` 이 조건 간 규칙은 도메인 `RemoteStatus` record의 compact constructor가 지킨다.

**V6__maintenance_capacity.sql**
```sql
CREATE TABLE maintenance_reservation (
    id         INTEGER  NOT NULL,
    owner_hash CHAR(64) NOT NULL,
    baseline   CLOB,
    CONSTRAINT pk_maintenance_reservation PRIMARY KEY (id),
    CONSTRAINT ck_maintenance_reservation_single CHECK (id = 1)
);
CREATE TABLE maintenance_release (
    id         INTEGER  NOT NULL,
    owner_hash CHAR(64) NOT NULL,
    CONSTRAINT pk_maintenance_release PRIMARY KEY (id),
    CONSTRAINT ck_maintenance_release_single CHECK (id = 1)
);
CREATE TABLE runtime_capacity (
    id              INTEGER  NOT NULL,
    revision        CHAR(32) NOT NULL,
    queue_capacity  INTEGER  NOT NULL,
    max_concurrency INTEGER  NOT NULL,
    version         BIGINT   NOT NULL,
    CONSTRAINT pk_runtime_capacity PRIMARY KEY (id),
    CONSTRAINT ck_runtime_capacity_single CHECK (id = 1),
    CONSTRAINT ck_runtime_capacity_range CHECK (queue_capacity >= 1 AND max_concurrency >= 1)
);
CREATE TABLE runtime_capacity_target (
    target_id       VARCHAR(32) NOT NULL,
    queue_capacity  INTEGER,
    max_concurrency INTEGER,
    CONSTRAINT pk_runtime_capacity_target PRIMARY KEY (target_id),
    CONSTRAINT ck_runtime_capacity_target CHECK ((queue_capacity IS NULL OR queue_capacity >= 1) AND (max_concurrency IS NULL OR max_concurrency >= 1))
);
```
- `[사실]` 유지보수: 소유자는 64 hex 문자열을 받아 SHA-256만 저장(`maintenance-state.mjs:16-19`), 같은 소유자의 재예약은 거절(`:25`), 기준선은 소유자 일치·`baseline IS NULL`일 때 한 번만 쓰고 ≤ 4MiB(`:26-31`), 해제는 예약 삭제와 `last_release` 교체를 한 트랜잭션에서(`:36-43`). 용량: 한 행(`id=1`)에 JSON `{revision(32 hex), settings{queueCapacity, maxConcurrency}, targets[{id, queueCapacity|null, maxConcurrency|null}]}`(`runtime-capacity.mjs:3, 12-26`) — 설정에서 빠진 대상의 override도 보존한다(`:21` 주석)고 하여 `runtime_capacity_target`에 FK를 두지 않았다. 수정은 `compareAndSet(expectedRevision, next)`(`runtime-capacity-state.mjs:24-31`).

### 8.3 표 이름·열 대조표(2.x → 3.0) `[사실 + 제안]`

| 2.x 표(파일) | 2.x 열 | 3.0 표·열 |
|---|---|---|
| `operations`(`operation-store.mjs:59-61`) | `id` | `operation.id` |
| | `request_key` UNIQUE NOT NULL | `operation.request_key` UNIQUE |
| | `digest`·`contract` | `operation.contract_digest`(계약 원문은 보관하지 않고 필드가 열로 있음) |
| | `version` | `operation.version`(`@Version`) |
| | `state` | `operation.state` |
| | `target_id`·`target_revision`·`conflict_key` | 같은 이름의 열 |
| | `ready_sequence` | `operation.ready_sequence` |
| | `body`(나머지 모든 필드) | `operation_command/source/upload/download`·`operation_decision*`·`operation_result`·`operation_legacy` + `operation`의 시각·상태 열 |
| `operation_events`(`:64-65`) | `sequence`·`operation_id`·`version`·`state`·`at` | `operation_event.event_sequence/operation_id/version/state/occurred_at` |
| `operation_legacy_budget`(`:66-67`) | `operation_id`·`source`·`original_bytes`·`reserved_bytes` | `operation_legacy.operation_id/legacy_source/original_bytes/reserved_bytes` |
| `operation_schema`(`:57`) | `version` | 소멸(Flyway 이력 표 `flyway_schema_history`가 대신함) |
| `policy`(`command-state.mjs:16`) | `id`·`revision`·`body` | `command_policy.id/revision` + `command_policy_rule/_name/_threshold` |
| `requests`(명령, `:16`) | `id`·`request_key`·`digest`·`body` | `operation` + `operation_command`·`operation_decision`·`operation_result` |
| `requests`(CLI, `agent-cli-state.mjs:20`) | `id`·`request_key`·`digest`·`body`·`remote_status` | `operation`(kind `AGENT_CLI`) + `agent_cli_request` |
| `reservation`(`maintenance-state.mjs:14`) | `id`·`owner_hash`·`baseline` | `maintenance_reservation.id/owner_hash/baseline` |
| `last_release`(`:14`) | `id`·`owner_hash` | `maintenance_release.id/owner_hash` |
| `runtime_capacity`(`runtime-capacity-state.mjs:12`) | `id`·`body` | `runtime_capacity.id/revision/queue_capacity/max_concurrency/version` + `runtime_capacity_target` |
| `outputs`(`command-output.mjs:53`) | `id`·`body`·`digest`·`charge` | `command_output.id/…/charge_bytes` + `command_output_format`·`command_output_page`(`digest`는 소멸) |
| artifact manifest `<id>.json`(`artifacts.mjs:91-149`) | 파일 필드 전부 | `artifact`·`artifact_chunk`·`staged_action` |

### 8.4 엔티티 `@Table`과 리포지토리 [제안]
패키지 접두 `io.github.jaeseongs95.portal.store`. 엔티티는 불변 `record` + `@Table`(이름은 명시), 모든 enum 열은 Java enum(이름 저장), `@Version`은 8.1의 5개 표.

| `@Table` | 엔티티 record | 리포지토리(`CrudRepository<엔티티, ID>`) | 도메인 ↔ 엔티티 변환 |
|---|---|---|---|
| `operation` | `OperationRow` | `OperationRowRepository` | `OperationMapper` |
| `operation_event` | `OperationEventRow` | `OperationEventRowRepository` | 〃 |
| `operation_command` · `operation_source` · `operation_upload` · `operation_download` | `OperationCommandRow` 외 3 | 각각 `…Repository` | 〃(`OperationInput` sealed ↔ 4개 행) |
| `operation_decision` · `_attempt` · `_command` | `OperationDecisionRow` 외 2 | 각각 | `DecisionMapper` |
| `operation_result` | `OperationResultRow` | `OperationResultRowRepository` | `ResultMapper` |
| `operation_legacy` | `OperationLegacyRow` | `OperationLegacyRowRepository` | `LegacyMapper`(7단계가 사용) |
| `artifact` · `artifact_chunk` · `staged_action` | `ArtifactRow` 외 2 | 각각 | `ArtifactMapper` |
| `command_output` · `_format` · `_page` | `CommandOutputRow` 외 2 | 각각 | `OutputMapper` |
| `command_policy` · `_rule` · `_name` · `_threshold` | `CommandPolicyRow` 외 3 | 각각 | `PolicyMapper` |
| `agent_cli_request` | `AgentCliRequestRow` | `AgentCliRequestRowRepository` | `AgentCliMapper` |
| `maintenance_reservation` · `maintenance_release` | `MaintenanceReservationRow`·`MaintenanceReleaseRow` | 각각 | — |
| `runtime_capacity` · `runtime_capacity_target` | `RuntimeCapacityRow`·`RuntimeCapacityTargetRow` | 각각 | `CapacityMapper` |

포트 구현 `@Repository` 클래스(7.1절 포트별 1개): `JdbcOperationJournal`, `JdbcOperationQueueView`, `JdbcClaimStore`, `JdbcRestartRecovery`, `JdbcHistoryQuery`, `JdbcArtifactRegistry`, `JdbcOutputManifestStore`, `JdbcCommandPolicyStore`, `JdbcAgentCliRequestStore`, `JdbcMaintenanceStore`, `JdbcRuntimeCapacityStore`, 그리고 파일 쪽 `FileArtifactPayloadStore`·`FileOutputPayloadStore`·`JsonlAuditLog`(이것들은 `@Component`, DB 어댑터가 아님).

### 8.5 출력 본문·artifact 바이트: 파일인가 DB인가
- `[사실]` 2.x는 둘 다 **파일**이다. 출력: 페이로드 `.part`(수집 중)·`.out`(확정, JSON+text 연이어)·`.stream`(5바이트 헤더 프레임: 스트림 종류 1바이트 + 길이 4바이트 BE)을 `<root>/command-outputs/<id>.*`에, 매니페스트만 SQLite(`command-output.mjs:53, 76, 108-117, 249-265`). 한도: 파일당 16MiB, 총 128MiB(`:8`), 소유자 전용 0600·심볼릭 링크·하드 링크 거절(`:30, safe()`). artifact: 바이트 `<root>/<id>.part`, 메타 `<id>.json`(소유자 전용, `fsync` 후 rename이 커밋 지점, 미확인 바이트 꼬리는 재시작 때 `truncate`, `artifacts.mjs:84-149, 130-135`). 한도: 파일당 64MiB, 총 512MiB(`ports.mjs:2`, `artifacts.mjs:61`).
- `[제안]` 바이트는 **파일에 둔다**(후보 비교: 파일 / DB `BLOB` / 작은 것은 DB·큰 것은 파일). 이유: (1) 최대 16~64MiB 본문을 `BLOB`으로 두면 H2 파일 DB와 사용자가 붙일 JDBC DBMS 모두에서 백업·크기·메모리 부담이 커지고, JDBC `BLOB` 스트리밍 거동이 DBMS마다 달라 개발원칙 4.3(DBMS 중립)과 부딪힌다. (2) 2.x가 이미 파일 + 소유자 전용 권한 검사를 구현했고 그 보안 규칙(심볼릭·하드 링크 거절)은 `Files`·`PosixFilePermissions`·`isSameFile`로 Java에서 옮길 수 있다(개발원칙 1.2). (3) 쿼터가 디스크 여유를 본다(`statfsSync` → Java `FileStore.getUsableSpace()`). 결정 D-13.
- 파일 쪽 정합: **바이트 `fsync` → 메타 커밋** 순서(바이트 먼저)로 하고, 시작 시 대조 루틴이 (a) 메타 없는 파일은 격리 폴더로, (b) 메타의 `received_bytes`보다 긴 파일은 그 길이로 `truncate`, (c) `received_bytes`보다 짧거나 청크 해시가 다른 파일은 시작 거절(2.x와 같음, `artifacts.mjs:130-144`)한다. 트랜잭션 안에서 파일 I/O를 하지 않는다(개발원칙 4.4) — 7.1절 포트 분리가 이를 구조로 강제한다.
- `[제안]` D-0012(작은 파일 `ARTIFACT_QUOTA`)를 막는 예약 계산: 예약 가능 여부 = (`budget() − reserved ≥ 요청 크기`) AND (`디스크 여유 ≥ 요청 크기 + 안전 여유`). 앱 예약 예산(`DataSize`, `BRIDGE_TRANSFER_BUDGET_BYTES`)과 디스크 여유를 따로 계산해 4.9절 `ArtifactReservation`의 두 거절을 따로 낸다(2.x는 한 문구).

### 8.6 2.x가 표마다 쓰던 쿼리 → Spring Data JDBC
`[사실]`은 2.x의 SQL, `[제안]`은 3.0 대응. 파생 쿼리는 메서드 이름, 나머지는 `@Query`(ANSI)다. `LIMIT`은 ANSI가 아니므로 `Pageable`/`Limit` 인자(방언이 처리) 또는 `FETCH FIRST n ROWS ONLY`를 쓴다 `[미확인: Spring Data JDBC가 방언별 limit을 만드는지 공식 문서로 확인 필요 — https://docs.spring.io/spring-data/relational/reference/jdbc/query-methods.html]`.

| 표 | 2.x 쿼리(근거) | 3.0 대응 |
|---|---|---|
| `operation` | `SELECT body FROM operations WHERE id=?`(`:98`) | `findById` |
| | `SELECT digest,body FROM operations WHERE request_key=?`(`:171, 233`) | `Optional<OperationRow> findByRequestKey(String)` |
| | `INSERT INTO operations VALUES(…)`+이벤트 `INSERT`(`:181-182`) | `save`(신규) + `OperationEventRowRepository.save` — 한 `@Transactional` |
| | `UPDATE operations SET … WHERE id=? AND version=?`(`:142-144`) | `save`(`@Version`), 충돌 → `OptimisticLockingFailureException` |
| | `SELECT state,count(*) … GROUP BY state`(`:238`) | `@Query("SELECT state, COUNT(*) AS n FROM operation GROUP BY state")` → `List<StateCountRow>` |
| | 같음, 이전 행 제외 `WHERE id NOT IN (SELECT operation_id FROM operation_legacy_budget)`(`:237`) | `@Query` 동일(표 이름만 `operation_legacy`) |
| | `list`: `state IN (…)`, `target_id=?`, `ORDER BY coalesce(ready_sequence, max), rowid LIMIT ?`(`:241-247`) | `findByStateInAndTargetIdOrderByReadySequenceAscCreatedAtAscIdAsc(…, Limit)`; 전체는 `findByStateInOrderBy…` — NULL `ready_sequence`는 마지막이 되도록 `@Query`에 `ORDER BY CASE WHEN ready_sequence IS NULL THEN 1 ELSE 0 END, ready_sequence, created_at, id` |
| | claim 개수: `state IN ('starting','running','terminating')`(전체·대상별)(`:253-254`) | `long countByStateIn(Collection<OperationState>)`, `long countByTargetIdAndStateIn(String, Collection<OperationState>)` |
| | unknown 개수(이전 제외)(`:255`) | `@Query("SELECT COUNT(*) FROM operation o WHERE o.state = 'UNKNOWN' AND o.id NOT IN (SELECT operation_id FROM operation_legacy)")` |
| | conflict 펜스(`:257`) | `boolean existsByStateInAndTargetIdAndTargetRevisionAndConflictKey(Collection<OperationState>, String, String, String)` |
| | 대상별 마지막 시작(신규, 3.2절) | `@Query("SELECT target_id, MAX(started_at) AS last_started FROM operation WHERE target_id IN (:ids) GROUP BY target_id")` |
| | 이력: 공개 메타만 순회, 상한 10000(`history-query.mjs`) | `findAllBy…(Pageable)` + 열 투영 인터페이스 `HistoryRow` — 본문 열(`operation_command.command_text` 등)은 조인하지 않고 필요할 때 지연 조회(B-400) |
| `operation_event` | `SELECT sequence,version,state,at … WHERE operation_id=? ORDER BY sequence`(`:281`) | `List<OperationEventRow> findByOperationIdOrderByEventSequence(String)` |
| | `coalesce(max(sequence),0)+1`(준비 순서, `:160`) | 3.0은 `QUEUED` 이벤트 행의 `event_sequence`를 `ready_sequence`로 쓴다(별도 질의 없음) |
| 명령 저널·정책 | `SELECT revision,body FROM policy WHERE id=1`(`command-state.mjs:34`) | `CommandPolicyRowRepository.findById(1)` + 하위 표 조회 |
| | `UPDATE policy SET body=?,revision=revision+1 WHERE id=1 AND revision=?`(`:48`) | `@Modifying @Query("UPDATE command_policy SET revision = revision + 1 WHERE id = 1 AND revision = :expected")`가 1행이어야 하고 이어서 하위 표 교체(한 트랜잭션) |
| | 지표: `json_extract(body, …)`로 `createdAt` 범위 투영(`:54-62`) | `@Query`로 `operation JOIN operation_decision`에서 `target_id, approval_mode, reason_code, provider, assessed_label, input/output tokens, latency_ms`와 시도 수(`COUNT` 서브쿼리)를 `created_at BETWEEN :from AND :to`로. JSON 함수(DBMS 고유) 불필요 |
| | 저널 시작 정규화(`:18-33`) | `RestartRecovery`가 대신함(T18~T21) |
| CLI 저널 | keyset 이력: `ORDER BY createdAt DESC, id DESC LIMIT 21`(`agent-cli-state.mjs:33-43`) | `@Query("… FROM operation o JOIN agent_cli_request a ON … WHERE a.provider = :p AND o.target_id = :t AND o.target_revision = :r AND o.profile = :pf AND (o.created_at < :before OR (o.created_at = :before AND o.id < :beforeId)) ORDER BY o.created_at DESC, o.id DESC")` + `Limit` 21 |
| | `UPDATE requests SET remote_status=? WHERE id=?`(`:58`) | `AgentCliRequestRow` `save` |
| 유지보수 | `SELECT owner_hash FROM reservation WHERE id=1`, `INSERT`, `UPDATE … WHERE baseline IS NULL AND owner_hash=?`, `DELETE`, `INSERT OR REPLACE last_release`(`maintenance-state.mjs:22-43`) | `findById(1)`, `save`, `@Modifying @Query("UPDATE maintenance_reservation SET baseline = :b WHERE id = 1 AND owner_hash = :h AND baseline IS NULL")`, `deleteById(1)`, `last_release`는 `deleteById`+`save`(같은 트랜잭션, `INSERT OR REPLACE`는 DBMS 고유) |
| 용량 | `SELECT body FROM runtime_capacity WHERE id=1`, `INSERT OR IGNORE`, `UPDATE … WHERE …`(`runtime-capacity-state.mjs:12-31`) | `findById(1)`, `existsById` 후 `save`(동시 최초 삽입은 PK 충돌 → 기존 읽기), `@Modifying @Query("UPDATE runtime_capacity SET … , revision = :next, version = version + 1 WHERE id = 1 AND revision = :expected")` |
| 출력 | `SELECT body,digest FROM outputs WHERE id=?`(`command-output.mjs:86`) | `findById` |
| | upsert `INSERT … ON CONFLICT(id) DO UPDATE`(`:101`, DBMS 고유) | `save`(`@Version`) — 신규/갱신은 Spring Data JDBC가 판정 |
| | `SELECT count(*), coalesce(sum(charge),0) FROM outputs`(`:144`) | `@Query("SELECT COUNT(*) AS n, COALESCE(SUM(charge_bytes), 0) AS bytes FROM command_output")` |
| | `SELECT id,charge FROM outputs`(`:330`), `UPDATE charge`, `DELETE`(`:333-343`) | `findAll`, `save`, `deleteById`, 만료 `findByExpiresAtBeforeAndStateNot(Instant, state)` |
| artifact | 메모리 `Map` + 파일 스캔(`artifacts.mjs:84-150`) | `findById`, `Optional<ArtifactRow> findByPublicUuid(String)`, `findByOwnerIdAndOperationKey`, `findByStateAndExpiresAtBefore`, 예산 `@Query("SELECT COALESCE(SUM(CASE WHEN state = 'CONSUMED' THEN 1 WHEN size_bytes < 1 THEN 1 ELSE size_bytes END), 0) FROM artifact")`, 청크 `findByArtifactIdOrderByChunkNo` |

### 8.7 낙관적 잠금 컬럼 요약
`operation.version`(전이마다 +1, 2.x `version`, `:158`), `artifact.version`(청크 추가·상태 전이), `command_output.version`, `command_policy.revision`(+1, CAS는 `@Query`), `runtime_capacity.version`(+ 계약 토큰 `revision`). 전이 시도가 충돌하면 어댑터가 `Optimistic…`를 `OPERATION_VERSION_CONFLICT`·`CAPACITY_REVISION_CONFLICT` 등 코드가 있는 예외로 바꾼다(개발원칙 3.4: `DuplicateKeyException`·`OptimisticLockingFailureException`을 잡고 `SQLException`은 잡지 않는다).

---

## 9. 사례 배정

### 9.1 기준과 수량
- 대상: 사례 표(`regression-cases.part-a.md` 1절 885행 + `part-b.md` 2절 805행 = 1,690행)에서 「3.0 모듈」 열에 `portal-domain`·`portal-store`·`portal-app`이 하나라도 있는 717건과, 표의 `|`가 모듈 열을 밀어내 열이 깨진 9행(A-228, A-249, A-418, A-460, B-466, B-517, B-566, B-580, B-626)을 사례 본문으로 판정한 것을 합친 726건. 깨진 9행 중 A-418·B-517(portal-app)은 9.3의 미루는 표에, B-580(portal-domain, 원격 경로 문법)은 9.2의 닫는 표에 넣었고, 나머지 6행은 9.4절에서 처리했다.
- **2단계에서 닫는 사례 162건**: 모듈 열이 `{domain, store, app}`의 부분집합이고, 도메인 객체·저장소·2단계 포트만으로 판정 가능한 것. 「app」이 병기된 사례는 도메인·저장 쪽 판정을 2단계에서 구현하고 유스케이스 흐름이 필요하면 9.3절로 미뤘다. 예외 1건: A-160은 `web`이 병기되었지만 D-0012(예약 계산)의 도메인·저장 반쪽이 핵심이라 포함했다(봉투 반쪽은 4단계에서 같은 ID로 다시 시험).
- 미루는 사례 558건(+ 열이 깨진 6건): 9.3절.
- ID는 `RC-A-nnn`·`RC-B-nnn`이다(아래 표는 접두 `RC-`를 생략). 자체 점검(부록 A)으로 모든 ID가 사례 표에 있음을 확인했다.

### 9.2 2단계에서 닫는 사례 (타입별)

| 구현 타입(모듈·패키지) | 사례 ID | 건수 | 비고 |
|---|---|---|---|
| `agentcli.AgentCliProvider`·`AgentRelease`·`AgentCliIntent`(D) | A-088, A-089, A-090, A-091, A-092, A-093, A-094, A-095, A-096, A-097, A-907, B-552 | 12 | 공급자 카탈로그·릴리스 검증·의도 digest 정규화 |
| `text.CommandText`(D) | B-072, B-073, B-074 | 3 | 여러 줄 입력 수용·신원·32KiB 경계. B-075·B-076·B-077은 문법·실셸이 필요해 9.3으로 |
| `path.RemotePath`·`PosixRemotePath`·`WindowsRemotePath`(D) | B-580, B-581 | 2 | 허용·거부·basename, POSIX 보존 |
| `origin.AdminOrigin`(D) | B-888, B-889 | 2 | 공유 벡터(`settings-contract.json`) 전부. 포트 벡터는 server 단계 |
| `host.UploadHostPatterns`(D) | B-887, B-891 | 2 | 공유 벡터·거절 |
| `file.FileTargetBinding`(D) | A-801 | 1 | 빈·부분 결속 거절 |
| 버전 값(`release.SemanticVersion`, D) | B-525 | 1 | semver 파서·비교기(`v` 접두·prerelease). 제안: record `SemanticVersion` + `compareTo` |
| `operation.Operation`·`OperationState`·`approval.ApprovalPolicy`(D) | A-083, A-157, A-765, A-766, A-767, A-768, A-770, A-771, B-195, B-197, B-199, B-200, B-359 | 13 | 승인 기한 1시간·기한 거절, 승인 의도 선(先)저장, 같은 대상 슬롯 수만큼 승인, 대기 중 정책 재검증, 불확실 실행은 durable unknown, 만료 시 실행기 미시작 |
| `schedule.OperationScheduler`·`ConcurrencyLimits`(D) | A-745, A-746, A-747, B-065, B-186, B-187, B-188, B-190, B-192, B-198 | 10 | 한도 검증·활성 한도·대기 슬롯, 공정성, 중복 enqueue, unknown 격리·예산, 용량 축소, 임의 상한 없음. A-748~A-751(구독자 알림)은 9.3 |
| `failure.DispatchFailure`(D) | A-625, A-626, A-736, A-737, A-738 | 5 | 고정 원인·단계 보존, 영속 실패와 원격 실패 구분, guard 사유 구분 |
| `failure.ExecutionFailure`(D) | A-759, A-760, A-761, A-762, A-763 | 5 | 허용 6원인(+`OPERATION_FAILED` 미분류), 신뢰 불가 필드 배제, 허용 목록 복사, 같은 경계의 고정 문구 |
| `command.CallerContext`·`ExecutionContext`(D) | A-439, A-442, A-752, A-753, A-754, A-758 | 6 | 민감 경로는 context로 허용, 자격 정보·과대 거절, 상세 context 보존, 빈 context의 모델 호출 보류, secret 참조 |
| `command.CommandPolicy`·`AutomaticApprovalPolicy`(D) | A-419, A-420, A-421, A-422, A-423, A-424, A-425, A-432, A-433, A-444, A-448, A-449, A-450 | 13 | 확률 경계 포함, 구형 임계값 읽기, 설명(첫 실패 관문), 폴백 순서, 정책 revision 변경 시 결정 폐기, sudo 기본 개별 승인, prompt 출처 기록. 문법이 필요한 하위 단언은 3단계로(9.3) |
| `safety.SafetyAssessment`(D) | A-860, A-861, A-864, A-866, A-868, B-419 | 6 | 이진 질문·응답 검증, 진단 고정 어휘, 동점·정확한 합, 후보 임계값, 질문 문구의 불변 버전·prompt digest |
| (D 소계) | | 81 | |
| `OperationJournal`·`JdbcOperationJournal`(S) | B-201, B-202, B-203, B-204, B-206, B-207 | 6 | 같은 계약=같은 id, 낙관적 claim·계약 불변, 재시작 시 queued 보존, typed 원격 증거만으로 종료, conflictKey 직렬화, unknown 예산·저널 용량 |
| `AuditLog`·`JsonlAuditLog`(S) | A-623 | 1 | 부분 기록은 완료하고 0바이트 기록은 실패 |
| 요청 키 영속·시작 복원(S) | A-426, A-427, A-428 | 3 | 요청 키는 재시작 뒤에도 유지·인자 변경 거부, 중단된 평가·실행은 unknown, 시작 시 claim된 명령은 unknown |
| 저널·정규화(S) | A-027, A-028, A-029, A-047, A-048, A-485, A-486, A-487 | 8 | CLI 이력 keyset·커서 거절, 저널 정규화·키 충돌, 시작 정규화(미변경 행은 UPDATE 안 함·실패 시 전체 롤백). A-048(심볼릭 링크·넓은 권한)은 파일 쪽이라 H2 파일 DB 위치 검사로 대응 |
| `CommandOutputStore`(S) | A-488, A-489, A-490, A-491, A-492, A-493, A-494, A-495, A-496, A-497, A-498, A-499, A-500, A-501, A-502, A-503, A-504, A-505, A-506, A-507, A-508, A-509, A-510, A-511 | 24 | 출력 회계(`charge`)·스트림 spool·finish·truncation·abandon·유지보수 reap·고아 격리·권한 재검사 |
| `ArtifactRegistry`·`FileArtifactPayloadStore`(S) | A-158, A-160, A-161, A-162, A-163, A-164, A-165, A-166, A-167, A-168, A-169, A-170, A-171, A-172, A-173, A-176, A-177, A-178, A-179, A-180, A-181, A-182, A-183, B-063, B-068, B-091, B-092, B-093, B-094, B-095, B-440, B-583 | 32 | 보관 시간(스테이징 10분)·예약(D-0012: A-160, B-094)·복구·재시작·복원 검사·staged UUID·CR/LF 거부·tombstone·기본 예산·두 대상 문법 수용 |
| `MaintenanceStore`(S) | B-004, B-008 | 2 | 보호 장치 실패 시 출력 정리, 활성 owner의 독점·비정상 종료 |
| `RuntimeCapacityStore`(S) | B-405, B-406, B-407, B-408, B-409 | 5 | 저장·상속·축소, CAS·유지보수·검증, 손상 시 정리(타입 열로 손상 불가 → DDL CHECK 시험으로 대응), 제거된 대상 용량 보존 |
| (S 소계) | | 81 | |
| **합계** | | **162** | D 81 + S 81 |

- 이식 위치: 도메인 시험은 `portal-domain/src/test/java/…`(Spring 없이), 저장 시험은 `portal-store/src/test/java/…`(`@DataJdbcTest`+호환 모드 없는 내장 H2, 개발원칙 7.2~7.3). 시험의 `@DisplayName`에 사례 ID를 적는다(`regression-cases.md` 0.1절 권장).
- 사례의 「입력·기대·판정」은 부분 파일 사례 표가 정본이다. 「(추정)」 표기와 2.x 구현 세부(SQLite·fd)는 이식 전에 원 시험을 다시 읽고 3.0 방식으로 확정한다(`regression-cases.md` 0.1절).

### 9.3 미루는 사례 (이유와 함께)

| 이유 | 대상 단계 | 사례 ID | 건수 |
|---|---|---|---|
| `CommandLineGrammar` 구현이 필요(POSIX·Windows 이름 추출). 정책 판정 사례 중 문법 결과를 쓰는 것 | 3(portal-ssh 구현 뒤 `CommandPolicy` 조합 시험) | A-430, A-436, A-445, A-446, A-452, A-466, A-479, A-480, B-075, B-076, B-077, B-568, B-569, B-588, B-589, B-597, B-623, B-628 | 18 |
| 에이전트 CLI 서비스·릴리스 카탈로그(유스케이스·`AgentReleaseCatalog` 포트) | 3·4 | A-058, A-059, A-060, A-061, A-062, A-063, A-064, A-065, A-067, A-068, A-069, A-070, A-071, A-072, A-073, A-074, A-075, A-076, A-077, A-078, A-079, A-080, A-081, A-082, A-084, A-085, A-086, A-087 | 28 |
| 승인·관찰 대기 이벤트(`ApplicationEvent`·`@TransactionalEventListener`, 구독자 알림, 만료 깨움) | 3 | A-142, A-143, A-144, A-145, A-146, A-147, A-148, A-149, A-154, A-155, A-748, A-749, A-750, A-751, A-769, B-193, B-194, B-196 | 18 |
| 파일 자동 정책·TEST 서버 파일 정책(유스케이스) | 3·4 | A-188, A-190, A-191, A-193, A-196, A-197, A-198, A-199, A-200 | 9 |
| 자동화 지표 서비스 | 4 | A-201, A-202 | 2 |
| 명령 자동화·정책 검토 서비스(평가기 포트·감사·요청 키 중복 평가 방지) | 4 | A-418, A-434, A-435, A-437, A-438, A-516, A-517, A-518, A-519, A-520, A-521, A-522, A-523, A-620, A-756, A-867, B-334 | 17 |
| 명령·읽기 경로·lifecycle·감사 흐름 | 3 | A-467, A-468, A-469, A-470, A-471, A-472, A-473, A-474, A-475, A-622, A-624, B-328, B-356, B-358 | 14 |
| 파일 서비스·opaque 파일·업로드 흐름 | 3 | A-772, A-773, A-774, A-775, A-776, A-777, A-778, A-802, B-051, B-053, B-105, B-129, B-130, B-131, B-132, B-133, B-134, B-135, B-136, B-137, B-138, B-293, B-294, B-304, B-368, B-371 | 26 |
| **`file-source`(URL 가져오기) 사례 — feature-map Q11은 이 파일을 이식하지 않는다고 판정(「2.x에서도 미사용」). 삭제 표로 옮길지 메인 판정 필요** | 판정 | A-779, A-780, A-781, A-782, A-783, A-784, A-785, A-786, A-787, A-788, A-789, A-790, A-791, B-439 | 14 |
| 이전된 legacy `unknown` 예산(portal-migrate가 만든 행 필요) | 7 | B-189, B-191 | 2 |
| `operations` 서비스(`OperationService`) | 3 | B-233, B-234, B-235, B-236, B-237, B-238, B-239, B-240, B-241, B-242 | 10 |
| 보존 기준선 캡처·비교(유지보수·업그레이드 흐름) | 4·7 | B-336, B-337, B-338, B-339, B-340, B-341, B-342, B-343 | 8 |
| 요청 입장(`RequestAdmission`)·큐 용량 서비스 | 3 | B-372, B-373, B-374, B-375, B-376, B-377, B-378, B-381, B-382, B-383 | 10 |
| 요청 위험 평가 서비스 | 4 | B-386, B-387, B-388, B-389, B-391 | 5 |
| 이력·용량 서비스 | 3 | B-393, B-394, B-396, B-397, B-398, B-399, B-400, B-401, B-410 | 9 |
| **안전성 평가 시뮬레이션·보고서·CLI 보호 — feature-map Q6(연구 도구 삭제)와의 관계 확인 필요** | 판정 | B-420, B-421, B-423 | 3 |
| 비밀 참조 해석·모듈 경계(`B-438`은 1단계 ArchUnit A-DIR·A-DOMAIN이 대체) | 4 / 완료 | B-432, B-438 | 2 |
| 소스 자동화·TEST 서버·전송 실패·dispatch 결속·Windows 앱 | 3·4 | B-455, B-459, B-461, B-463, B-465, B-504, B-505, B-508, B-509, B-511, B-517, B-559, B-572, B-573, B-574, B-584 | 16 |
| 시작 시 종료 상태 복원(`ApplicationRunner` 유스케이스, 저장 반쪽은 2단계 `RestartRecovery`) | 3 | B-493, B-494, B-495 | 3 |
| 설정·환경 파일 | 4(web)·server | B-831, B-884, B-885, B-886, B-890, B-892 | 6 |
| 모듈 열에 `portal-web` 병기(MCP·관리자 HTTP·UI) | 4 | 아래 9.3.1 | 201 |
| 모듈 열에 `portal-ssh` 병기(SSH·SFTP 실물) | 3 | 아래 9.3.1 | 84 |
| 모듈 열에 `portal-desktop` 병기 | 5 | A-694~A-714(21), A-731, A-734, A-807~A-812(6) | 29 |
| 모듈 열에 `portal-client` 병기(로컬 비밀 저장소) | 6 | A-887, A-888, A-889, A-890, A-891 | 5 |
| 모듈 열에 `portal-migrate` 병기 | 7 | A-515, B-082, B-083, B-084, B-205 | 5 |
| 모듈 열에 `portal-server` 병기(설정 바인딩·종료) | 4(조립) | A-354, A-355, A-356, A-357, A-455, B-054, B-055, B-056, B-066, B-379, B-380, B-523, B-524 | 13 |
| 모듈 열에 `packaging` 병기 | 7 | B-473 | 1 |
| **합계** | | | **558** |

**9.3.1 `portal-web` 병기 201건(4단계)**: A-031, A-033, A-035, A-037, A-038, A-039, A-040, A-041, A-043, A-044, A-045, A-046, A-049, A-052, A-053, A-054, A-055, A-056, A-057, A-130, A-131, A-132, A-133, A-134, A-135, A-150, A-151, A-153, A-156, A-159, A-174, A-175, A-185, A-186, A-192, A-194, A-195, A-205, A-206, A-207, A-212, A-213, A-216, A-217, A-222, A-223, A-224, A-226, A-229, A-230, A-231, A-236, A-240, A-241, A-242, A-245, A-247, A-248, A-250, A-251, A-252, A-253, A-254, A-255, A-256, A-258, A-259, A-261, A-262, A-263, A-264, A-265, A-266, A-267, A-268, A-269, A-270, A-271, A-276, A-277, A-278, A-280, A-282, A-283, A-284, A-347, A-349, A-352, A-364, A-365, A-429, A-440, A-441, A-443, A-447, A-451, A-453, A-454, A-456, A-457, A-462, A-476, A-477, A-478, A-512, A-513, A-524, A-621, A-627, A-755, A-757, A-764, A-792, A-793, A-794, A-795, A-797, A-799, A-800, A-803, A-834, A-835, A-840, A-841, A-862, A-863, A-880, B-005, B-006, B-007, B-009, B-010, B-017, B-018, B-019, B-024, B-025, B-026, B-027, B-036, B-037, B-038, B-039, B-040, B-041, B-042, B-043, B-047, B-049, B-050, B-052, B-059, B-060, B-061, B-062, B-064, B-069, B-070, B-071, B-364, B-365, B-366, B-367, B-369, B-384, B-385, B-392, B-395, B-403, B-412, B-422, B-425, B-426, B-441, B-442, B-451, B-452, B-453, B-454, B-456, B-460, B-464, B-467, B-468, B-469, B-470, B-471, B-472, B-503, B-507, B-516, B-520, B-526, B-527, B-577, B-591, B-592, B-593, B-594, B-627, B-629.
- 이 중 도메인 값을 직접 시험하는 것(예: A-476·A-477·A-478·B-027 명령 길이 한도, A-862·A-863 Jev 응답)은 2단계의 `CommandText`·`SafetyAssessment` 단위 시험이 같은 경계값을 먼저 덮고, 사례 ID는 4단계에서 닫는다.

**9.3.2 `portal-ssh` 병기 84건(3단계)**: A-011, A-066, A-187, A-458, A-459, A-796, A-906, B-057, B-067, B-457, B-458, B-462, B-475, B-491, B-496, B-497, B-500, B-501, B-506, B-510, B-512, B-513, B-514, B-515, B-570, B-571, B-575, B-576, B-578, B-579, B-611, B-614, B-631, B-632, B-633, B-634, B-635, B-636, B-637, B-638, B-639, B-640, B-641, B-642, B-643, B-644, B-645, B-646, B-647, B-648, B-649, B-650, B-651, B-652, B-653, B-654, B-655, B-656, B-657, B-658, B-659, B-660, B-661, B-662, B-663, B-664, B-665, B-666, B-667, B-668, B-669, B-670, B-671, B-672, B-673, B-674, B-675, B-676, B-677, B-678, B-679, B-680, B-681, B-682.

### 9.4 모듈 열이 깨진 6행
A-228, A-249, A-460(브라우저·UI 입력, 4단계 portal-web), B-466(MCP submit 거절 봉투, 4단계), B-566(Windows 이름 인식 = `WindowsCommandLineGrammar`, 3단계), B-626(Windows 분류 = `WindowsTargetPlatform`, 3단계). B-580은 같은 형태로 깨졌으나 본문이 `RemotePath` 문법이라 9.2에 넣었다. 부분 파일의 해당 행의 열을 바로잡는 일은 이 작업 범위 밖이라 보고만 한다.

### 9.5 신규 사례 (2단계가 먼저 적는 사례 — 개발원칙 7.1)
사례 표에 없지만 2단계 설계가 새로 요구하는 행동이다. 접두 `S2-`. 판정은 JUnit(도메인은 Spring 없이, 저장은 `@DataJdbcTest`).

| ID | 대상 | 입력 | 기대·판정 |
|---|---|---|---|
| S2-ST-01 | `OperationState#canMoveTo` | 13×13 = 169 조합 | 2.3절 T1~T25의 도메인 전이만 true, 나머지 false. 종료 5종은 출발로 항상 false. `UNKNOWN`의 도착은 `COMPLETED·FAILED·CANCELLED`뿐 |
| S2-ST-02 | `Operation.settle` 판정표 | 2.5절 5행 × 경계(예: `cleanupComplete=false`+정상 종료) | 표대로 `COMPLETED/FAILED/CANCELLED/UNKNOWN`, `outcomeCertainty`·`reconciliation` 일치 |
| S2-ST-03 | D-0035 | `FilePublished` 증거 없이 `COMPLETED` 요구 | 컴파일되지 않는 생성자(없음) + 증거가 `CommandExited(코드≠0)`면 `FAILED` |
| S2-ST-04 | 시작 복원 | 각 활성·대기 상태 행 | T18~T21대로 `UNKNOWN`/`EXPIRED`, `recoveryReason=BRIDGE_RESTART`, 이벤트 1건 |
| S2-ST-05 | 불변 필드 | 전이 뒤 `requestKey`·`targetRevision`·입력 비교 | 변하지 않음. 계약 digest가 같음 |
| S2-ST-06 | 시간 | `Clock.fixed`로 `expire(at)` 경계(`at == expiresAt`, `at+1ns`) | `at >= expiresAt`이면 `EXPIRED` |
| S2-SC-01 | `OperationScheduler.select` | 대상 3개·각 큐 깊이 다름·`lastStartedAt` 다름 | 가장 오래 쉰 대상 먼저, 같은 상태에서 두 번 호출해도 같은 결과(결정적) |
| S2-SC-02 | 포화 사유 | 전역 한도·대상 한도·unknown 예산·펜스 | `Saturated(GLOBAL_CONCURRENCY\|TARGET_CONCURRENCY\|UNKNOWN_BUDGET\|CONFLICT_FENCE)`가 각각 다름(D-0038) |
| S2-SC-03 | 접수 포화 | 큐 32·대상 큐 32·보관 100 | `OPERATION_QUEUE_FULL`·`REQUEST_CAPACITY_EXCEEDED`(채택 시) 구분 |
| S2-VA-01 | `OperationId`·`Digest`·`RequestKey`·`TargetId`·`ArtifactUuid` | 형식 경계 입력(47/48/49자, 대문자, 끝 개행, 버전 3 UUID) | 정규식대로 거절·수용 |
| S2-VA-02 | `Utf8Text`·`CommandText` | 짝 없는 서로게이트, 32768/32769바이트(UTF-8 멀티바이트), CRLF 단독 CR | B-072~B-074 경계 + 거절 |
| S2-VA-03 | `PosixRemotePath` | `/`, `//a`, `/a/../b`, 4097자, 앞뒤 공백, U+202E | 2.x 규칙대로 |
| S2-VA-04 | `WindowsRemotePath` | `C:\`, `C:\a\.`, `C:\CON`, `C:\a.`, `C:\a b `, `c:/x/y` | 2.x 규칙대로 |
| S2-VA-05 | `Capacity`·`CapacityDefaults` | `"0"`, `"01"`, `"9007199254740993"`, CPU 1·8 | 거절/수용, `queue=cpus*10` |
| S2-VA-06 | `Target` | 12개 키 모두, 중복 id, 같은 read/write 프로파일, Windows 전용 키를 Linux에 | 2.x `parseTargets` 규칙(`:13-60`) |
| S2-VA-07 | `TargetRevision` | 같은 입력 2회, 한 필드 변경, 필드 공백 차이 | 결정적, 변경 시 달라짐 |
| S2-FA-01 | `DispatchFailure`·`ExecutionFailure` | 표 밖 이유/단계 짝, 임의 예외 | 거절 또는 `Unclassified`, 메시지·속성이 진단에 섞이지 않음 |
| S2-FA-02 | `PortalException` 매핑 | 코드마다 | `retryable`·`ExecutionAttempt` 기본값(5.5절) |
| S2-CO-01 | `ErrorCode` 기준본 일치 | 8개 enum 전체 | 5.3절 (1)~(4) |
| S2-CO-02 | 계약 record 구조 | `OperationData` 등 30여 record를 `null` 포함 직렬화 | `mcp/tools/*.json` outputSchema와 구조 일치(8.1: `properties·required·type·enum·additionalProperties`) |
| S2-CO-03 | `Envelope` | `ok=true`+`error` 있음, `ok=false`+`data` 있음 | 생성 거절. 직렬화에 4개 필드 모두 존재 |
| S2-CO-04 | `OperationState` wire | 13개 | `@JsonValue`가 `public-contract.mjs:15`와 같은 소문자 13값 |
| S2-CO-05 | 상수 | `commandBytes` 등 6개 | `targets.limits`와 일치 |
| S2-RE-01 | 리소스 바이트 | `risk/command-risks.json`, `risk/automation-risk-question.json` | 길이 22856/4644, SHA-256 `eb65ce4e…3d83`/`ef0f1cc1…8fbc` |
| S2-RE-02 | 질문 digest | 로더가 만든 압축 JSON | SHA-256 `77634c80b0c225777dca0ddc2766db5072b173b7a34e01fdf8e35a48560ac0c5` |
| S2-RE-03 | 질문 문장 3종 | `safety-question`·`command-set-question`·`windows-command-set-question` | 2.x 소스 문자열 SHA-256과 일치(값은 구현 담당이 계산) |
| S2-PO-01 | `TargetRule` 불변식 | 정책 문서 위반 12종(대상 33개, 이름 129개, `minLowRisk=0.5`, 확률 기준에 `minConfidence`…) | `IllegalArgumentException` |
| S2-PO-02 | `AutomaticApprovalPolicy.decide` | 3.5절 표의 15행 각각 | 사유·결정·자동 여부가 표와 같음(문법 결과는 값으로 직접 줌) |
| S2-SA-01 | `SafetyAssessment` | 확률 합 1±1e-6 경계, 선택 라벨이 최대가 아님 | `Rejected(진단)` |
| S2-DB-01 | Flyway | 빈 H2에 `V1~V6` 적용 | 26개 표·모든 제약 생성, 두 번째 실행은 무변경 |
| S2-DB-02 | CHECK 전수 | 각 enum 열에 목록 밖 값 삽입 | 제약 위반(`DataIntegrityViolationException`) — 열마다 1회 |
| S2-DB-03 | 낙관적 잠금 | 같은 `operation`을 두 곳에서 읽고 둘 다 저장 | 하나만 성공, 다른 쪽 `OPERATION_VERSION_CONFLICT` |
| S2-DB-04 | 요청 키 멱등 | 같은 키·같은 계약 2회 / 다른 계약 | 같은 행 / `OPERATION_KEY_CONFLICT` |
| S2-DB-05 | claim 한도 | 동시 2·대상 1·unknown 예산 경계 | 한도 초과 시 `Saturated`, 성공은 정확히 한도까지 |
| S2-DB-06 | 동시 claim | 스레드 2개가 같은 작업을 동시에 claim | 정확히 하나 `Claimed` |
| S2-DB-07 | UTC 왕복 | JVM `user.timezone`을 UTC가 아닌 값으로 두고 `Instant` 저장·조회 | 같은 `Instant`(8.1절 미확인 해소) |
| S2-DB-08 | 정책 CAS | 같은 revision으로 두 번 교체 | 한 번만 성공, 하위 표 일관 |
| S2-DB-09 | 트랜잭션 밖 파일 I/O | `ArtifactRegistry.append`+`ArtifactPayloadStore` | 바이트 `fsync` 후 메타 커밋, 메타 커밋 실패 시 재시작 대조가 바이트 꼬리를 `truncate`(A-162와 함께) |
| S2-AP-01 | `DomainBeans` | `ApplicationContextRunner` | `Clock`·`SecureRandom`·`Digester` 각 1개, `Clock`은 UTC |
| S2-AP-02 | `TargetPlatformRegistry` | 구현 하나 누락 / 중복 | 시작 시 `IllegalStateException` |
| S2-AR-01 | 구조 | `portal-arch-checks` | A-UTIL·A-DOMAIN·A-OPTIONAL-SLOT 위반 0, 새 모듈 파일이 규칙 대상에 포함됨 |

신규 사례 수 41건(각각 매개변수화로 여러 시험 메서드가 될 수 있음).

---

## 10. 구현 분담 제안

### 10.1 쓰기 범위 3개(겹치지 않음)

| 담당 | 쓰기 범위(Write·Edit 허용 경로) | 맡는 것 | 예상 클래스(추정) | 예상 시험 메서드(추정) |
|---|---|---|---|---|
| **구현 1: 도메인 핵심** | `java/portal-domain/src/{main,test}/java/io/github/jaeseongs95/portal/domain/{id,text,path,target,host,origin,capacity,operation,schedule,approval,failure,file,release}/**` | 값 객체(4.2~4.5절), `Operation`·`OperationState`·`ApprovalPolicy`·`OperationScheduler`(2·3절), `DispatchFailure`·`ExecutionFailure`·`ExecutionOutcome`(4.7절), `Digester`·`Sha256Digester`·ID 생성기 | 약 55(+ 중첩 record) | 약 150 (사례 44건 + 신규 S2-ST/SC/VA/FA ≈ 18) |
| **구현 2: 도메인 계약·정책** | `java/portal-domain/src/{main,test}/java/…/domain/{contract,command,safety,agentcli,desktop}/**`, `java/portal-domain/src/main/resources/risk/**`, `java/portal-domain/src/test/resources/**`, `java/portal-domain/build.gradle.kts`, `java/.gitattributes`(`risk/*.json -text` 한 줄) | `ErrorCode` 8 enum·`PortalException` 계층(선행 납품), 계약 record·`Envelope`(5절), `CommandPolicy`·`TargetRule`·`Threshold`·`CommandLineGrammar`·`CommandClassifier`·`OutputRedactor` interface·`AutomaticApprovalPolicy`·`ExecutionContext`(6절), `SafetyAssessment`, 데스크톱·에이전트 CLI 값(6.7절), 리소스 | 약 75 | 약 150 (사례 37건 + 신규 S2-CO/RE/PO/SA ≈ 14) |
| **구현 3: 포트·저장** | `java/portal-app/src/{main,test}/**`, `java/portal-store/src/{main,test}/**`(`resources/db/migration/V1~V6` 포함), `java/portal-app/build.gradle.kts`, `java/portal-store/build.gradle.kts` | 7절 포트·`DomainBeans`·`TargetPlatform`·로더(`CommandRiskCatalogLoader`·`AutomationQuestionLoader`), 8절 DDL·엔티티·리포지토리·어댑터·파일 어댑터·`JsonlAuditLog` | app 약 25 + store 약 60 | 약 170 (사례 81건 + 신규 S2-DB/AP ≈ 11) |

- 공유 파일은 없다. `settings.gradle.kts`·`build.gradle.kts`(루트)·`portal-arch-checks`는 이 단계에서 바꾸지 않는다(필요하면 메인에게 요청). 구현 2만 `portal-domain/build.gradle.kts`를 만진다(시험 리소스 경로 추가).
- `[제안]` 구현 1·2가 같은 모듈(`portal-domain`)을 쓰므로 패키지 단위로 나누었다. 서로의 패키지를 직접 고치지 않고, 필요한 타입 변경은 메인을 거쳐 요청한다.

### 10.2 순서와 의존
1. **선행 납품(병렬 2건, 작은 것)**: 구현 2가 `contract` 패키지의 `ErrorCode`·8 enum·`PortalException` 계층·`ExecutionAttempt`를 먼저 낸다(구현 1의 `Operation`·`failure`가 `ErrorCode`를 쓴다). 구현 1은 `id`·`text`·`path`·`capacity`·`OperationState`(전이표 포함)를 먼저 낸다(구현 3의 매퍼·엔티티 enum이 쓴다). 메인이 둘을 통합·확인한 뒤 다음으로 간다.
2. **본작업(3명 병렬)**: 구현 1(`Operation` 메서드·스케줄러·정책 객체), 구현 2(계약 record·명령 정책·안전), 구현 3(DDL·엔티티·리포지토리는 선행 납품 직후 바로, 도메인 매퍼·포트 구현은 구현 1의 `Operation`이 들어온 뒤).
3. **통합**: 구현 3의 `JdbcOperationJournal`·`JdbcClaimStore`가 구현 1·2의 타입을 쓰므로 마지막에 메인이 통합 빌드(`./gradlew build`, 포크·워커 설정은 `brief-common.md` 작업 환경)로 확인한다.
- 의존 방향(ArchUnit A-DIR): domain ← app ← store. 구현 3의 store가 domain·app을 쓰고 반대는 없다.

### 10.3 완료 조건(담당별 공통)
- 사례 먼저(개발원칙 7.1): 9.2·9.5의 ID를 `@DisplayName`에 적은 시험을 만든 뒤 구현한다.
- 개발원칙 9절 35항 + 디자인 패턴 10절 13항 + 안티패턴 16절 17항을 자기 diff에 적용하고 예/아니오 근거를 보고한다.
- `javac` 경고 0(`-Xlint:all -Werror`), 시험 skip 0, ArchUnit 위반 0.

---

## 11. static 계획

### 11.1 원칙
- 업무 판정(「이 값이 허용되나」「이 전이가 가능한가」「다음에 무엇을 실행하나」)은 `static`이 아니라 값 타입의 인스턴스 메서드이거나 협력 객체를 주입받은 객체의 메서드다. 업무 판정 `static` 유틸은 **0개**다. A-UTIL(정적 메서드만 가진 클래스 0)이 기계로 확인한다.
- `static`을 허용하는 것은 정확히 세 가지다: (1) 상수(`static final` 필드), (2) 정적 생성 메서드(`of`·`parse`·`accept`·`from`), (3) 상태·협력 객체가 없는 순수 값 변환(결과가 인자에만 의존).

### 11.2 남길 `static` (2단계 예상 전부)
| 위치 | 종류 | 목록 | 이유 |
|---|---|---|---|
| 값 타입의 `Pattern` 상수 | 상수 | `OperationId`·`RequestKey`·`TargetId`·`Digest`·`ArtifactUuid`·`PosixRemotePath`·`WindowsRemotePath`·`UploadHostPattern`·`AdminOrigin`·`SemanticVersion`·`CommandText`(숨은 문자)·`CallerContext`(자격 증거) | 정규식은 한 번 컴파일(개발원칙 5.1) |
| 소유 타입의 상수 | 상수 | `CommandText.MAX_BYTES 32768`, `SourceText.MAX_BYTES 16384`, `CallerContext.MAX_CHARS 8192`, `AssessmentContext.MAX_CHARS 12288`, `ApprovalPolicy.VALIDITY`, `ArtifactRetention.UPLOAD_TTL`, `OutputRetention.TTL/MAX_BYTES/BUDGET/MAX_COUNT`, `ArtifactLimits.MAX_BYTES/CHUNK_BYTES`, `ConcurrencyLimits.DEFAULT_*`, `AdmissionLimits.DEFAULT_*`, `ErrorData` 정규식 | 한도는 소유 타입에 둔다. 한곳에 모은 `Limits` 클래스는 만들지 않는다(안티패턴 T5) |
| 정적 생성 | 정적 생성 | `Operation.accept`, `Digest.of(byte[])`, `Capacity.parse`, `RemotePath.parse`, `PosixRemotePath.of`, `WindowsRemotePath.of`, `UploadHostPatterns.parse`, `OperationData.from`·`TargetData.from`·`ExecutionData.from`(계약 변환), `Envelope.success`·`Envelope.failure`, `DispatchFailure.refused`·`stepFailed` | 새 값을 만드는 자리. 구성요소 검증은 compact constructor |
| 순수 값 변환 | 순수 변환 | `Digest.toHex()`(인스턴스), `SemanticVersion.compareTo`(인스턴스) | 인스턴스 메서드이므로 `static`이 아님 |

예상 정적 메서드 수: 정적 생성 약 15개. 허용 목록(`UTILITY_ALLOWED`)에 넣을 클래스는 0개(정적 메서드만 가진 클래스가 없으므로).

### 11.3 빈·객체로 옮기는 업무 판정 (2.x 모듈 함수 → 3.0)
| 2.x 함수(근거) | 3.0 |
|---|---|
| `validateCommand`·`commandTextValid`(`validation.mjs:11-23`) | `CommandText` 생성자 + `CommandClassifier`(분류) — 여러 줄 `safe` 강등은 `CommandClassification#forMultiline`(인스턴스) |
| `remotePath`·`windowsRemotePath`·`anyRemotePath`·`remoteBasename`(`:25-46`) | `RemotePath` sealed 변형의 compact constructor·`basename()` |
| `hash`·`idValid`(`:4-6`) | `Digester`(주입)·`OperationId` 생성자 |
| `validateCapacity`·`parseCapacity`·`capacityDefaults`(`capacity.mjs`, `config/capacity.mjs`) | `Capacity`·`CapacityDefaults#queueCapacity()` |
| `callerContext`·`credentialText`·`sensitiveText`·`assessmentContext`(`execution-context.mjs`) | `CallerContext` 생성자, `SensitiveText`(값, `isSensitive()`), `AssessmentContext`(값) |
| `dispatchStep`·`dispatchRefusal`·`dispatchFailureDetails`(`dispatch-failure.mjs`) | `DispatchFailure` sealed + `DispatchRefusedException`. 「단계를 감싸는 `dispatchStep(stage, fn, reason)`」는 `try`-`catch`를 흩지 않으려고 만든 함수라 3.0에서는 호출 쪽이 `StepFailed`를 던진다. 공통 변환 한 곳은 AOP(3단계 유스케이스) |
| `executionFailure`·`executionFailureDetails`·`safeExecutionFailure` | `ExecutionFailure` sealed + `ExecutionFailedException` |
| `fileTargetBinding`·`fileTargetFields` | `FileTargetBinding` record |
| `platformOf`·`targetCapabilities`·`classifyForTarget`·`commandNamesForTarget`·`requireTargetCapability`·`deniedForTarget`(`target-platform.mjs`) | 포트 `TargetPlatform` 메서드(7.3절) + `TargetCapabilities`(값) |
| `commandLineNames`·`windowsCommandLineNames`·`windowsPolicyName` | `CommandLineGrammar` 구현(3단계) · `WindowsPolicyName`(값 record) |
| `approvedCommandNames`·`explicitUserApproval`·`validateCommandPolicy`·`deniedCommand`·`inspectCommand`·`validatedRisk`·`commandDigest`(`command-policy.mjs`) | `CommandNames`(값)·`TargetRule#approves/denies`·`CommandPolicyDocument`·`CommandInspection`(값)·`SafetyAssessment.Assessed#matchesModel`·`OperationContract#digest(Digester)` |
| `validateAssessment`·`candidateMatch`·`assessmentDiagnostic`·`safetyFailureDetails`·`safetyInput`(`safety.mjs`) | `SafetyAssessment` 변형·`Assessed#isCandidate`·`SafetyDiagnostic`(enum)·`SafetyInput`(값) |
| `desktopBinding`·`desktopActions`·`desktopState`·`transportDesktopState`·`desktopFail` | `DesktopBinding`·`DesktopAction`·`DesktopReadiness` 생성자·`DesktopError`(= `PortalException` 변형) |
| `agentCliProvider(s)`·`validateAgentRelease`·`agentCliIntent` | `AgentCliProvider` 구현 빈 목록·`AgentRelease`·`AgentCliIntent` |
| `createOperationScheduler`의 `configure`·`drain`·`enqueue`·`cancel`·`observe`(`operation-scheduler.mjs`) | `OperationScheduler`(판정, D)·`OperationDispatcher`(`@Component`, 3단계)·`OperationObserver`(이벤트, 3단계)·`Operation#requestCancel` |
| `createClaims`(`target-router.mjs:5-48`) | 소멸(DB 상태·`ClaimStore`로 대체) |
| `createRequestAdmission`(`request-admission.mjs`) | `RequestAdmission`(`@Component`, 3단계) + `AdmissionLimits`(D 값) |
| `ApprovalQueue` 클래스 전체 | `Operation`(전이)·`ApprovalPolicy`(접수·만료·유지보수)·`AutomaticApprovalPolicy`(자동 승인)·유스케이스(3단계) |
| `createOperationStore`의 `transitions` 표·`validateRecord`·`operationContract` | `OperationState#canMoveTo`·`Operation` 생성자·`Operation#contractDigest` |

### 11.4 기계 검증 [제안]
2단계 통합 때 메인이 다음을 센다: `static` 메서드 수(정적 생성·상수 구분), 정적 메서드만 가진 클래스 수(0), 생성자를 막은 유틸 모양 클래스 수(0). 기존 A-UTIL 규칙이 정적 전용 클래스를 막고, `Optional` 규칙(A-OPTIONAL-SLOT·A-OPTIONAL-GET)은 이 단계 코드에도 그대로 적용된다. 업무 판정을 `static`으로 짠 경우를 잡는 추가 ArchUnit 규칙은 만들지 않았다(의미 판단, 개발원칙 9절 32번은 diff 검토).

---

## 12. 결정 필요 목록

각 항목: 선택지 / 권장안 / 근거. 권장안은 이 문서의 본문과 일치한다.

| 번호 | 제목 | 선택지 | 권장 | 근거 |
|---|---|---|---|---|
| **D-01** | `CommandLineGrammar` interface의 소유 모듈 | (a) portal-app 포트(feature-map 판정) (b) portal-domain interface, 구현은 portal-ssh | **(b)**. `TargetPlatform`은 portal-app 유지 | `CommandPolicy`(domain)가 문법을 쓰고 domain은 어떤 모듈에도 의존할 수 없다(`ModuleTable.java`: `domain → Set.of()`, A-DIR). DIP: 정책이 자기 interface를 정의(개발원칙 3.0). feature-map 4.1의 한 문장 수정 필요 |
| D-02 | 작업 상태 기계: 두 층 유지 vs 하나로 통합 | (a) 내구 11종 + 메모리 job (b) `Operation` 13종 통합 | **(b)** | 두 층의 불일치가 D-0004류 결함의 원인(`approval-queue.mjs:235-244`의 수동 동기화). 상태·동작을 한 타입에(개발원칙 3.0 캡슐화) |
| D-03 | `ACCEPTED`의 취급 | (a) 계속 노출 (b) 같은 트랜잭션에서 `PENDING`·`EVALUATING`으로 곧바로 전이(관찰 불가), 값은 계약·이전용으로 유지 | **(b)** | 2.x 관찰 동작 보존(`operations.mjs:15-19`: `accepted`→`pending`) |
| D-04 | wire 값과 enum 상수 이름 | (a) 상수를 소문자로 정의 (b) 대문자 상수 + `@JsonValue`로 2.x 소문자 wire 값, DB는 이름 | **(b)** | A-DOMAIN은 jackson-annotations만 허용(`PortalRules.domain`). Spring Data JDBC 기본 「Enums get mapped to their names」(개발원칙 4.2). Java 명명 관례 |
| D-05 | 스케줄러 공정성 구현 | (a) 메모리 링 유지(2.x) (b) 데이터로 계산(대상별 `lastStartedAt`) | **(b)** | 싱글턴 가변 필드 금지(패턴 8.15). 재시작·이중 실행에 결정적. 사례 B-186 관찰 결과는 같음 |
| D-06 | 시간 접근 방식 | (a) 전이 메서드에 `Instant` 인자(유스케이스가 `Clock` 한 번 읽음) (b) 도메인 객체 안에서 `Clock` 호출 | **(a)** + 정책 객체는 `Clock` 생성자 주입 | `Clock` 한 빈(개발원칙 4.5), 시험이 결정적. 한 유스케이스 안 시각 일관 |
| D-07 | 새 오류 코드 허용 | (a) 2.x 코드만 (b) 최소 추가(`REQUEST_CAPACITY_EXCEEDED` 1개, 승인 요청 보관 한도 초과) | **(b)** | D-0038(대기열 포화·연결 실패·transport 실패를 뭉치지 않기). 2.x는 이 경우 코드가 없는 `Queue full`(`approval-queue.mjs:52`). 코드 어휘 확장은 계약 호환(정규식 만족) — 단 기준본 갱신 필요 |
| D-08 | `ErrorCode` 구조 | (a) 단일 enum (b) sealed interface + 8개 category enum (c) 열린 interface + 모듈별 enum | **(b)** | 개발원칙 3.4 「sealed 계층과 범주별 코드 enum」, 변환 `switch` 한 곳이 완전(컴파일러가 누락 검사). desktop·ssh 값을 domain이 소유하는 비용은 값 문자열뿐 |
| D-09 | `TargetRevision` 알고리즘 | (a) 2.x JSON 바이트와 같게(불가능: 입력 형식이 vendor 레지스트리) (b) 새 정규형 + 이전 이력의 `legacy-unbound` 처리 | **(b)** | 2.x 입력(`reader`·`writer`)이 3.0에 없음. 7단계 portal-migrate가 이전 행의 revision을 `legacy-unbound`로 두는 규칙 필요 |
| D-10 | `operation`의 미사용 계약 필드 | (a) `generation`·`policyRevision`·`approval` 열 유지 (b) 열을 만들지 않음 | **(b)** | 2.x 생산 코드가 설정하는 곳 0(`operation-store.mjs:28-32`의 계약 digest 입력에만 등장). 필요하면 추가 마이그레이션 `V7` |
| D-11 | CLI 설치 요청의 저장 | (a) 별도 상태·표(2.x 별도 SQLite) (b) `operation`(kind `AGENT_CLI`) + `agent_cli_request` | **(b)** | 상태 기계 하나(D-02). 스케줄러 슬롯을 이미 공유(A-073). 공개 wire `kind`에는 노출 안 함 |
| D-12 | 이력 상한 | (a) 행 10000 + 바이트 64MiB(2.x) (b) 행 수만 | **(b)** | 본문이 열이 되어 바이트 상한이 의미 없음. 값은 메인이 확정 |
| D-13 | artifact·출력 바이트 저장 | (a) 파일 (b) `BLOB` (c) 소형 DB·대형 파일 | **(a)** | 2.x가 파일(8.5절 사실), DBMS 중립(개발원칙 4.3), 쿼터가 디스크 여유를 봄. 트랜잭션 밖 파일 I/O(4.4) |
| D-14 | claim 동시성 | (a) 단일 스케줄러 스레드 + `@Transactional(SERIALIZABLE)` + `@Version` (b) `operation_slot`·`operation_fence` 표 PK 제약 | **(a)**, H2 SERIALIZABLE이 쓰기 왜곡을 막는지 확인 실패 시 (b) | 사실 보존은 FK·CHECK·UNIQUE(개발원칙 4.2~4.3). `[미확인]` H2 문서 확인 |
| D-15 | 작업 입력·결과의 저장 모양 | (a) 열로 풀기(표 26개) (b) 종류별 JSON을 `CLOB` 한 열 | **(a)** | ANSI·DBMS 중립, 이력·지표 질의가 JSON 함수(DBMS 고유) 없이 가능, CHECK로 어휘 보존. 비용: DDL 길이. (b)는 표 12개로 줄지만 질의·제약 포기 |
| D-16 | domain 객체의 스프링 빈 등록 | (a) portal-app `@Configuration`의 `@Bean`(사유: domain에 Spring 의존 금지) (b) domain에 `jakarta.inject` 같은 표준 어노테이션 허용 | **(a)** | A-DOMAIN(JDK·jackson-annotations만), 개발원칙 3.1(어노테이션을 붙일 수 없을 때 `@Bean`, 사유 주석) |
| D-17 | 해시 도우미 | (a) domain `interface Digester` + `Sha256Digester` + app `@Bean` (b) `Digest.sha256` 정적 | **(a)** | 개발원칙 3.7·2.2 범주 10(도우미 빈 한 곳). 비용: 해시가 필요한 값 팩토리가 `Digester` 인자를 받음 |
| D-18 | 사례 표와 feature-map의 충돌 2건 | (a) `file-source`(A-779~A-791, B-439)와 안전성 평가 연구(B-420·B-421·B-423)를 삭제 표로 이동 (b) 이식 | **(a)** 메인 확인 후 | feature-map Q11(「file-source.mjs는 옮기지 않음, 2.x에서도 미사용」)·Q6(연구 도구 삭제). 두 사례 묶음은 현재 사례 표의 3.0 모듈이 portal-app |
| D-19 | 계약 기준본의 오류 코드 보정 | (a) 지금 11개를 `x-portal-errorCodes`에 추가 (b) 그대로 | **(a)** | 기준본 grep이 `Object.assign(Error, {code})` 계열을 놓쳤다(5.3절). 시험 오라클이 불완전하면 ErrorCode 일치 시험이 약해진다 |
| D-20 | vendor 문서 지연 시 분류기·redactor 범위 | (a) 문서 도착까지 2단계는 interface만 (b) 2.x 소스에서 직접 규칙 추출 | **(a)** | vendor 규칙은 `vendor/ssh-mcp-2.18.0.tgz`(feature-map 5절)에 있고 별도 담당이 조사 중(0.3절). 6.6절에 입력 조건 명시 |
| D-21 | 도메인 시험의 기준본 접근 | (a) Gradle `sourceSets.test.resources.srcDir`로 portal-web 기준본 폴더를 가리킴 (b) 복사본 + 드리프트 시험 | **(a)** | 한 곳이 정본(중복 원천 금지, `regression-cases.md` 0.1절). 구현 2가 `portal-domain/build.gradle.kts`만 수정 |
| D-22 | 정책 플래그 모양 | (a) `boolean` (b) enum `Toggle{ON,OFF}` | **(b)** | DB 열은 불리언 대신 enum(개발원칙 4.2). 도메인·DB가 같은 타입. wire(관리자 API)는 `@JsonValue Boolean` |
| D-23 | 문법이 필요한 사례의 시험 위치 | (a) 3단계 portal-ssh에서 `CommandPolicy` 조합 시험 (b) domain에 문법 구현을 두기 | **(a)** | feature-map 메인 판정(구현은 portal-ssh). 단 D-01 선택에 따라 interface는 domain |

### 12.1 이 작업 중 확인된 사실로 닫힌 질문
- **C4(`test-server-mode.mjs`의 설정 키 이름)**: 정확한 키는 `BRIDGE_TEST_SERVER_SECRET_REF`(`settings.mjs:71` `testServerSecretRef: value('BRIDGE_TEST_SERVER_SECRET_REF')`, `settings-contract.json:23, 37`). 기본값은 빈 문자열. 값은 `secret://provider/name` 참조이며 해석된 값이 64자 소문자 hex여야 능력이 켜진다(`test-server-mode.mjs:13`). feature-map 해당 행의 「미확인」을 이 값으로 갱신할 수 있다.
- **vendor 규칙 조사 문서**: 작성 시점에 존재하지 않음(0.3절).

---

## 13. 메인 판정 (2026-11-12, SSH MCP 리드)

이 절이 12절의 권장안보다 우선한다. 본문과 이 절이 어긋나면 이 절을 따른다.

### 13.1 결정별 판정
| 번호 | 판정 | 덧붙임 |
|---|---|---|
| D-01 | **(b) 채택** | `CommandLineGrammar` interface는 portal-domain `command`가 소유한다. 구현 2종은 3단계 portal-ssh가 만든다(D-23). feature-map 4.1절의 해당 문장은 prep 쪽에서 고친다 |
| D-02 | **(b) 채택** | `Operation` 하나가 상태 13종을 모두 가진다 |
| D-03 | **(b) 채택** | |
| D-04 | **(b) 채택** | |
| D-05 | **(b) 채택** | 2.x 링과 똑같이 관찰되는지는 B-186이 판정한다. 다르면 사례 표의 기대값을 바꾸지 말고 보고한다 |
| D-06 | **(a) 채택** | |
| D-07 | **(b) 채택** | `REQUEST_CAPACITY_EXCEEDED`는 `CapacityErrorCode`에 둔다. 응답 봉투의 `error.code` 정규식 안에서 값을 하나 더하는 변경이므로, 3.0 릴리스 노트와 업그레이드 안내(7단계)에 「새 오류 코드」로 적는다 |
| D-08 | **(b) 채택** | |
| D-09 | **(b) 채택** | revision 값이 2.x와 달라지므로, 업그레이드 뒤 에이전트가 갖고 있던 2.x revision으로 제출하면 `TARGET_REVISION_CONFLICT`가 난다. 이것은 의도한 결과이며, 7단계 업그레이드 안내에 「업그레이드 후 `targets`를 다시 조회」라고 적는다 |
| D-10 | **(b) 채택** | |
| D-11 | **(b) 채택** | |
| D-12 | **(b) 채택** | 값은 행 10,000으로 2.x와 같다 |
| D-13 | **(a) 채택** | |
| D-14 | **(b)로 변경** | 아래 13.2 |
| D-15 | **(a) 채택** | |
| D-16 | **(a) 채택** | |
| D-17 | **(a) 채택** | |
| D-18 | **(a) 채택** | feature-map Q11(`file-source.mjs`는 옮기지 않음, 2.x에서도 쓰지 않음)과 Q6 A안(연구 도구 삭제)으로 확인했다(`feature-map.md:76, 81`). A-779~A-791, B-439, B-420, B-421, B-423 등 17건은 사례 표의 삭제 표로 옮긴다(prep 문서 작업, 메인) |
| D-19 | **(a) 채택** | 구현 2가 `java/portal-web/src/test/resources/contract/mcp/envelope.schema.json`의 `x-portal-errorCodes`에 11개를 더한다. 이 파일 하나만 쓰기 범위에 넣는다. 각 코드가 실제로 던져지는 2.x 위치(`파일:줄`)를 보고에 적는다 |
| D-20 | **변경: vendor 문서 도착** | `vendor-ssh-mcp-rules.md`(prep, 1,300줄, 규칙 276개, 사례 VR-001~520)가 도착했다. 분류기·redactor 구현은 portal-domain 책임이므로(계획 구조 표) 2단계에서 **구현 4**가 `classify`·`redact` 패키지로 만든다. 13.3 참고 |
| D-21 | **(a) 채택** | |
| D-22 | **(b) 채택** | 근거: 개발원칙 266행 「불리언 열 대신 `enum`을 쓴다.」 |
| D-23 | **(a) 채택** | |

### 13.2 D-14 변경 이유와 형태
- 계획 결정 3에 따라 저장소는 `spring.datasource.*`로 다른 JDBC로 바꿀 수 있다. SERIALIZABLE의 동작은 DBMS마다 다르다(재시도가 필요한 직렬화 실패를 내는 DBMS도 있고, 잠금으로 처리하는 DBMS도 있다). H2에서 「개수 세기 후 갱신」 쓰기 왜곡을 막는지도 확인되지 않았다. 반면 한도는 사실 보존 규칙(개발원칙 「사실 보존은 FK·CHECK·UNIQUE」)에 따라 제약으로 막을 수 있다. 그래서 한도를 PK 제약으로 옮긴다.
- `operation_slot`: `scope VARCHAR(40) NOT NULL`(`GLOBAL` 또는 `TARGET:<targetId>`), `slot_no INTEGER NOT NULL`(1 이상), `operation_id CHAR(48) NOT NULL`(FK `operation`)로 두고, `PRIMARY KEY (scope, slot_no)`와 `UNIQUE (scope, operation_id)`를 건다. 한 작업이 행 2개(전역 1개, 대상 1개)를 가지므로 `operation_id` 단독 UNIQUE는 두지 않는다.
  - **claim**: 한 트랜잭션 안에서 각 범위의 1..한도 중 비어 있는 가장 작은 번호를 읽어 행을 넣고, `operation`을 `@Version`으로 `STARTING`으로 바꾼다. 같은 번호에 동시에 들어오면 PK 위반이 나고, 이것을 `ClaimResult.Contended`로 돌려준다. 다음 차례에 다시 판정하며, 자동 재전송은 하지 않는다.
  - **해제**: 활성 상태(`STARTING·RUNNING·TERMINATING`)를 벗어나는 전이와 같은 트랜잭션에서 슬롯을 지운다. 대상이 `UNKNOWN`이어도 지운다. 2.x에서도 `unknown`은 활성 개수가 아니라 따로 둔 unknown 예산으로 셌다.
  - 한도를 줄이면 이미 차 있는 큰 번호 슬롯은 해제될 때까지 남는다. 새 claim은 줄어든 한도 안에서만 번호를 찾으므로 결과가 맞다(B-198 「용량 축소」).
- `operation_fence`: 8.2절 O-2 정의를 그대로 기본안에 넣는다. 종료 5종으로 갈 때 지우고, `UNKNOWN`일 때는 남긴다. 결과가 불확실한 작업의 conflictKey를 계속 막아 두기 위해서다.
- **unknown 예산**: 같은 트랜잭션에서 개수를 확인한다. `UNKNOWN`으로 가는 정산은 거절할 수 없는 사실 기록이다. 그래서 이 확인은 새 claim만 막는 느슨한 상한이며, 경합하면 1건 넘칠 수 있다. 이 사실을 `ClaimStore` Javadoc과 시험(S2-DB-05)에 적는다.
- 디스패처는 그대로 단일 스케줄러 스레드다. 격리 수준은 기본값(READ COMMITTED)을 쓰고 SERIALIZABLE은 선언하지 않는다. S2-DB-06(동시 claim)은 스레드 2개와 서로 다른 작업 2개로 「한도 1 → 정확히 하나만 `Claimed`」를 확인하는 사례를 더한다.
- 표 개수는 26 + 2 = 28이다.

### 13.3 이름 충돌·경계 보정
- **`Admission` 이름 충돌**: 3.4절, 4.9절, 7.1절이 서로 다른 모양에 같은 이름을 썼다. 다음으로 나눈다.
  - 도메인 `approval.AdmissionDecision`(sealed): `Admit` · `RejectedMaintenance` · `RejectedCapacity(CapacityKind)`
  - app 저장 포트 `OperationJournal.accept`의 결과 `JournalInsert`(sealed): `Inserted(Operation)` · `Existing(Operation)`
  - 같은 키에 다른 계약이 오면 예외 `OPERATION_KEY_CONFLICT`를 낸다.
- **저장 결과 타입의 위치**: `ClaimResult`, `JournalInsert`, `ArtifactReservation`, `OutputLookup`, `MaintenanceStatus`는 포트와 같은 portal-app 패키지에 둔다. 도메인 판정 결과(`SchedulingDecision`, `AdmissionDecision`, `RuleLookup`, `TargetLookup`, `RiskDescription`, `SafetyAssessment`)는 portal-domain에 둔다.
- **`Operation`의 저장 경계**(구현 1과 구현 3 사이의 약속):
  - 구현 1은 `public record OperationSnapshot(...)`을 만든다. 구성요소는 2.7절 필드 순서 그대로다.
  - `Operation`은 `OperationSnapshot snapshot()`과 정적 생성 `static Operation restore(OperationSnapshot s)`를 둔다. `restore`는 불변식을 다시 검사한다.
  - 접근자 이름은 필드 이름과 같다(`state()`, `version()` …).
  - 구현 3의 `OperationMapper`는 이 두 메서드만 쓴다.
- **`TargetRule#denies`**: 인자를 `CommandLineGrammar` 대신 `CommandLineAnalysis`와 `CommandText`로 받는다. 값만 받으면 도메인 시험에 가짜 문법이 필요 없다. 이렇게 해도 interface 소유(D-01)는 그대로다. `AutomaticApprovalPolicy`도 이미 분석 값을 받는다.
- **AGS run-209의 수용 기준 문구**: `--max-workers=1 -Pportal.test.forks=1`은 그 뒤 사용자 지시(「이 피시 설정만」, 명령줄 덮어쓰기 금지)로 바뀌었다. 빌드는 전용 `GRADLE_USER_HOME=D:\codex\build\tools\gradle-home-ssh-portal`에서 명령줄 인자 없이 돌린다.

### 13.3a 외부 DBMS 연동(사용자 2026-11-12)
- 사용자 원문: 「h2 기반이긴하지만 dbms 연동 가능하다. <- 이 정책 고수해.」, 「글고 dbms 연동을 적극 권장한다.」, 「이 pc에도 dbms설치되어있어.」
- DDL과 `@Query`는 H2, PostgreSQL, MariaDB/MySQL에서 그대로 돌아야 한다.
  - `CLOB`, `GENERATED BY DEFAULT AS IDENTITY`처럼 DBMS마다 지원이 갈리는 타입과 구문은 쓰지 않는다. 식별자는 앱이 만든다. 이벤트 표는 `(operation_id, version)` 복합 PK로 둔다.
  - 공통 타입이 정말 없을 때만 Flyway `{vendor}` 위치에 벤더별 스크립트를 따로 둔다.
- 로컬 기본 시험은 호환 모드 없는 H2로 한다. 외부 DBMS 확인은 이 PC에 설치된 DBMS(접속 규칙은 AGS 리드에게 확인)와 CI 서비스 컨테이너로 한다.
- 8.2절 DDL 초안의 `CLOB`와 IDENTITY는 이 절에 따라 바꾼다.
- 이 PC의 DBMS(AGS 리드 회신, 2026-11-12 03:35)
  - 버전과 배포판: PostgreSQL 18.6(EDB Windows zip).
  - 주소: `127.0.0.1:55432`. 이 PC 안에서만 접속할 수 있다.
  - 이 프로젝트 몫: 계정과 DB 모두 `ssh_portal_test`. 이 계정은 자기 DB만 소유하고 연결 한도는 10이다. superuser·CREATEDB·CREATEROLE 권한은 없다.
  - 아직 쓸 수 없다. 사용자가 관리자 권한으로 스크립트를 한 번 실행해야 서비스(`postgresql-ags-dbms`)와 계정이 생긴다.
  - 지킬 것
    - 커넥션 풀은 10개 이하로 둔다.
    - 서버 설정과 `pg_hba.conf`를 바꾸지 않는다.
    - 서비스를 멈추거나 다시 시작하지 않는다.
    - 새 DB나 계정을 만들지 않는다.
    - 시험 뒤에는 자기 DB의 데이터만 정리한다.
  - (갱신 03:45) 사용자 지시 「db계정 ags리드한테 받으라고」에 따라 AGS 리드가 계정과 DB를 발급했다. 메인이 접속을 확인했다(`ssh_portal_test|ssh_portal_test|PostgreSQL 18.6 …|UTF8|UTC`, exit 0).
  - 비밀번호는 `C:\ags-test-secrets\ags-dbms-ssh_portal_test.pw` 파일에 한 줄로 들어 있다. 프로그램이 이 파일을 읽어 연결 설정에만 넘기고, 값은 출력·로그·커밋에 남기지 않는다. 같은 폴더의 다른 파일은 열지 않는다. 구현 담당(서브에이전트)은 이 폴더에 접근하지 않는다.
  - 외부 DBMS 시험은 별도 Gradle 시험 작업으로 메인이 돌린다. 이 작업은 URL, 계정, 비밀번호 파일 경로만 받는다(값은 받지 않는다). 이 값들은 이 PC 전용 `GRADLE_USER_HOME`의 `gradle.properties`에서 읽고, 시험 JVM에는 시스템 속성으로 넘긴다. 작업 정의는 구현 3이 끝난 뒤 메인이 정한다.

### 13.4 vendor 규칙 문서 판정(조건부 채택)
- 메인이 tgz 원문과 직접 대조했다: `package/build/policy/classifier.js:621`의 `FORBIDDEN_PATTERNS` 첫 정규식 `/rm\s+-rf?\s+\/(\s|$)/`, `package/build/guard/redactor.js:19`의 후보 최소 길이 20, `:40`의 임계값 기본 4.5, `:41`의 후보 정규식. 4곳 모두 일치했다.
- 조건이 하나 있다. 사례 520개의 기대값은 실행으로 확인하지 않고 소스를 읽어 추적한 값이다(문서 9절). 그래서 Java 시험이 처음으로 실행하는 확인이 된다. 시험과 문서 기대값이 어긋나면 사례를 고치지 말고, vendor 원문을 다시 읽어 판정한 결과를 보고한다.
- vendor의 구멍(예: VR-041 `rm -fr /`가 `safe`로 분류됨)은 **더 엄격한 쪽으로만** 고친다. 고친 사례마다 「의도한 동작 변경」으로 표시하고 이유를 적는다. 더 느슨해지는 변경은 하지 않는다.
- 2단계 범위는 분류기(1절)와 redactor(2절)다. 프로필 TOML(3절), `SSH_MCP_*`(4절), 연결·호스트 키(5절)는 3단계 portal-ssh가 가져간다. test-server-mode(6절)는 4단계가 가져간다.

### 13.5 분담 확정(4명, 쓰기 범위 겹침 없음)
| 담당 | 쓰기 범위 |
|---|---|
| 구현 1 | 10.1절 그대로. 패키지에 `OperationSnapshot`을 더한다 |
| 구현 2 | 10.1절 그대로. `java/portal-web/src/test/resources/contract/mcp/envelope.schema.json` 한 파일을 더한다(D-19) |
| 구현 3 | 10.1절 그대로. DDL은 13.2를 반영한다 |
| 구현 4 | `java/portal-domain/src/{main,test}/java/io/github/jaeseongs95/portal/domain/{classify,redact}/**`, `java/portal-domain/src/test/resources/vendor/**` |

- `CommandClassifier`·`OutputRedactor` interface와 `CommandClass`·`RedactedText` 값은 구현 4가 `classify`·`redact`에 둔다. 6.6절에서 구현 2에게 준 부분은 구현 4로 옮긴다.
- 빌드·시험은 메인이 한 번에 하나씩 돌린다. 이 PC의 Gradle 부하를 늘리지 않기 위해서다. 구현 담당은 Gradle을 실행하지 않고 Write·Edit로만 파일을 쓴다. 메인이 빌드한 결과(오류 원문)를 SendMessage로 돌려주면 담당이 고친다.

### 13.6 구현 보고 뒤 판정(2026-11-12)
- **T19 철회.** `recoverAfterRestart`는 `QUEUED`를 바꾸지 않는다. 3.0 저널은 내구 저장이고 `QUEUED→STARTING` claim은 외부 효과 전에 같은 트랜잭션에서 일어나므로, `QUEUED`는 시도되지 않았음이 확정이다. 2.x approval-queue의 queued→unknown은 메모리 job 유실 때문이었고, 내구 저장소 시험 RC-B-203(`test/operation-store.test.mjs:44`)은 queued를 재시작 전과 같게 보존한다. `UNKNOWN`으로 바꾸면 시도하지 않은 작업에 소유자 대조를 강요한다. T18·T20·T21은 유지한다.
- **RC-A-169·170 채택.** 복구한 레거시(격리) 보유 바이트는 공유 스테이징 예산에 넣는다(2.x와 같음). 같은 저장 루트의 디스크를 쓰므로, 빼면 실제 사용량이 설정 예산을 넘는다. D-0012 대응(8.5절)은 예산 거절과 디스크 부족 거절을 나누고, 예산 거절 값에 보유분·라이브 예약분을 따로 싣는다.
- **Flyway 위치.** `db/migration/common`(ANSI 공통)과 `db/migration/{vendor}`(긴 텍스트 열만: H2 `CLOB`, PostgreSQL `TEXT`, MariaDB·MySQL `MEDIUMTEXT`)로 나눈 구현 3안을 채택한다. 서버 설정은 `spring.flyway.locations=classpath:db/migration/common,classpath:db/migration/{vendor}`를 기본값으로 둔다. 8.2절의 `db/migration/V1~V6` 경로는 이것으로 대체한다.
- **`operation_fence`는 `conflict_digest`(SHA-256 hex) 열로 PK를 만든다.** MariaDB·MySQL InnoDB 색인 한도(3072바이트) 때문이다.
- **`ReviewReason`은 통합 때 `command`에서 `operation`으로 옮긴다**(패키지 순환 `operation`↔`command` 제거).
- **리소스 해시**: 6.2절의 22856/4644바이트·`eb65ce4e…`/`ef0f1cc1…`은 CRLF 작업 트리 값이다. 정본은 git 커밋 바이트(LF) 22238/4636바이트이다.
- **vendor 사례 표기 오류**: VR-315 입력은 18자로 적혀 있으나 기대값은 20자 기준이다. 둘 다 시험한다. VR-204 `max: 1.5`는 Java `int`로 표현할 수 없어 같은 분기 `-1`로 시험한다.
- **보류(빌드 뒤 판정)**: 저장소 전용 오류 코드(정책 개정 충돌·유지보수 소유자 재사용·출력 버전 충돌), artifact·출력 포트 보강(구현 3 보고 5절), `AuditFailedException`의 `PortalException` 편입.
- **식별자 따옴표 끔.** Spring Data JDBC가 `@Table` 값을 그대로 따옴표로 감싸 H2(대문자 접힘)에서 표를 못 찾았다. `RelationalMappingContext#setForceQuote(false)`로 끄고(`store.IdentifierQuoting`), 따옴표 없는 DDL과 같은 규칙으로 각 DBMS가 접게 한다.
- **CHECK는 `IN` 목록 대신 `CASE WHEN col = 'A' THEN 1 … ELSE 0 END = 1`.** H2 2.4.240에서 `IN (상수…)` CHECK가 만든 연결이 닫힌 뒤 `Check constraint invalid … The database has been closed`로 실패한다(구현 3이 작은 시험으로 재현, 메인은 재현 결과 원문만 확인). `NoInListInChecksTest`가 재발을 막는다. PostgreSQL·MariaDB에서의 동작은 외부 DBMS 시험에서 확인한다.
- **Windows(NTFS) 저장 보호.** POSIX 권한이 없는 파일 시스템에서 폴더·파일 보호를 검사하지 않고 통과하던 것은 결함이다. 보호 규칙을 interface 하나와 POSIX·ACL 구현 둘로 두고 `FileStore#supportsFileAttributeView`로 고른다. 둘 다 없으면 거절한다. ACL 경로는 소유자 전용 ACL을 만들고 검사하며, 하드 링크 수는 Java API가 없어 「폴더 ACL이 소유자 전용이므로 다른 주체가 링크를 만들 수 없다」를 근거로 검사하지 않는다(문서화된 판단). 사례 S2-DB-10.
  - 구현(`store.storage`): `PrivateStorage` interface, `PosixPrivateStorage`(`@Order(1)`)·`AclPrivateStorage`(`@Order(2)`) `@Component`, 선택·링크·종류 검사는 `PrivateStorages`(`List<PrivateStorage>` 주입) 한 곳. 아티팩트·출력·감사 파일 저장소가 모두 이것을 쓴다.
  - ACL 규칙: 새 폴더·파일의 ACL을 소유자·SYSTEM 전체 권한 두 항목으로 바꾼다(폴더 항목은 상속 가능). 검사는 소유자·SYSTEM·Administrators 밖 주체에게 데이터 읽기·쓰기·추가 또는 ACL·소유자 변경을 주는 ALLOW 항목이 있으면 거절한다. 주체는 이름이 아니라 `UserPrincipal.equals`(SID)로 비교하므로 언어판과 무관하다.
  - 확인 범위: 한국어 Windows 11 한 대(NTFS, 일반 사용자 토큰)에서 실제 ACL로 시험 14건 실행. 관리자 권한 프로세스(소유자가 Administrators로 바뀌는 경우)와 네트워크 드라이브는 미검증이며 8단계 Windows CI·설치 시험에서 확인한다.
- **skip 예외(수용 기준 보정).** 파일 시스템 기능에 따라 조건부로 건너뛰는 시험은 아래 9개 자리뿐이고, 각각은 Linux CI나 Windows CI 중 한쪽에서 반드시 실행된다. 8단계에서 「두 CI의 실행 결과를 합치면 skip 0」을 확인한다. 그 밖의 skip은 0이어야 한다. Windows 전역 설정(개발자 모드)은 바꾸지 않는다.
  - Linux에서 실행(이 PC에서 skip 7건): `FileArtifactPayloadStoreTest`의 RC-A-179·RC-A-166·RC-A-171, `ArtifactStartupCheckTest`의 RC-A-166, `PosixPrivateStorageTest` 3건(RC-A-178·179·171). 이 PC는 심볼릭 링크 생성 권한과 링크 수 조회가 없고 POSIX 권한도 없다.
  - Windows에서 실행(Linux CI에서 skip 예정): `AclPrivateStorageTest` 7건(사례 S2-DB-10).
  - 2026-11-12 메인 전체 빌드(`build --rerun-tasks`, exit 0): tests 1176, failures 0, errors 0, skipped 7(위 Linux 목록과 일치), javac 경고 0.
- **`ReviewReason`은 `operation` 패키지로 옮겼다**(위 판정 이행). `operation`→`command` import는 0이다.
- **외부 DBMS 시험(`portal-store` `externalDbmsTest`, 13.3a 이행).** 명시 호출 전용 `Test` 작업이고 `check`·`build`에 붙지 않는다. 접속 값은 Gradle 속성 `portal.test.dbms.postgresql.{url,user,password-file}`로 받고, 없으면 실패한다(H2로 대체하지 않음). 빌드 스크립트는 비밀번호 경로만 넘기고, 시험 쪽 `EnvironmentPostProcessor`가 실행 시 파일을 읽는다. 시험은 DB 안의 전용 스키마 `portal_store_it`만 쓰며 시작 때 만들고 끝날 때 지운다. 풀은 4개, 컨텍스트 캐시는 1개다. 8단계 CI는 같은 작업을 서비스 컨테이너로 돌린다.
  - 첫 실행(PostgreSQL 18.6)은 265건 중 실패 7건이었다. 6건은 PostgreSQL이 위반 뒤 트랜잭션을 중단(SQL state 25P02)하는데 시험이 같은 트랜잭션에서 계속 실행해서 생겼다. 위반 문장을 savepoint 안에서 실행하도록 시험을 고쳤고 단정은 그대로다. 1건(RC-B-094)은 `TIMESTAMP(6)` 해상도 때문으로, 경계를 1ns에서 1µs로 맞췄다. 제품 결함은 `JdbcRuntimeCapacityStore.initialize` 1곳(바깥 트랜잭션 안의 첫 INSERT 위반)이다.
  - 위반을 번역해 곧바로 던지는 저장소 메서드에는 savepoint를 넣지 않는다. 넣어 보니 `@Transactional` 메서드의 예외가 합류한 바깥 트랜잭션을 rollback-only로 만들어, 이후 savepoint 생성이 실패했다(H2 9건). 한 트랜잭션에서 거절 뒤 계속하는 호출자가 자기 savepoint로 감싼다.
  - savepoint는 `store.Savepoints`(`@Component`, `PROPAGATION_NESTED`) 하나로 모았다. `JdbcClaimStore`·`JdbcOperationJournal`의 중복 `TransactionTemplate`을 이것으로 바꿨다. 새 사례는 S2-DB-11(따옴표 없는 이름), S2-DB-12(savepoint 슬롯 충돌), S2-DB-13(마이크로초), S2-DB-14(CHAR 공백 채움), S2-DB-15(vendor 폴더·스키마), S2-DB-16(접속 값 공급·비밀번호 비노출), S2-DB-17(거절 뒤 트랜잭션 계속)이다.
  - 2026-11-12 메인 실행: H2 전체 빌드는 tests 1191, failures 0, skipped 7, 경고 0이다. `externalDbmsTest`는 tests 267, failures 0, skipped 7(위 Linux 목록과 같음)이다. 실행 뒤 `portal_%` 스키마는 0개다. MariaDB·MySQL은 이 PC에 없어 8단계 CI에서 확인한다(미검증).
- **domain 패키지 순환(다음 작업).** `contract`↔`operation`(`OperationData`→`OperationState`, `Operation`→`OperationErrorCode`·`RequestRefusedException`)과 `contract`↔`failure`(예외→`DispatchFailure`·`ExecutionFailure`, `ExecutionFailure`·`ExecutionStage`→`ExecutionErrorCode`)가 있다. 오류 코드 enum·`PortalException` 계열과 `failure` 패키지를 새 `error` 패키지로 모으고, `contract`에는 wire record만 남겨 의존을 한 방향(`contract`→`operation`·`error`, `operation`→`error`)으로 만든다. ArchUnit에 portal-domain 패키지 순환 0 규칙을 더한다.
- **run-209 수용 기준 문구의 `--max-workers=1 -Pportal.test.forks=1`** 은 사용자 지시(전용 GRADLE_USER_HOME, 병렬 2·힙 1g)로 대체한다(13.3절과 같음).

---

## 부록 A. 자체 점검 결과

점검은 읽기 전용 셸 도구(`grep`, `awk`, `comm`, `sha256sum`)로 했다(작업 도구, 제품 코드 아님). 점검용 중간 파일은 이 저장소 밖 세션 임시 폴더에만 두었고 저장소 파일은 이 문서 하나만 썼다.

### A.1 상태 enum·ErrorCode 값 대조 (소스 재추출 ↔ 이 문서)
| 점검 | 방법 | 결과 |
|---|---|---|
| Operation 상태 13종 | 소스에서 `'accepted'…'unknown'` 리터럴 13개를 `grep -rhoE`로 다시 뽑고(`src/**/*.mjs`), 공개 enum(`public-contract.mjs:15`)·내구 11종(`operation-store.mjs:6`)·승인 job 종료 6종(`approval-queue.mjs:12`) + `pending`·`evaluating`의 합집합과 2.2절 표를 `comm`으로 대조 | 소스 리터럴 13개, 세 집합 모두 차이 0, 2.2절 표의 wire 13값과 차이 0, 중복 0 |
| 배차 실패 이유 15·단계 19 | `dispatch-failure.mjs`의 `reasons`·`stages` ↔ V1 DDL `dispatch_reason`·`dispatch_stage` CHECK | 차이 0 |
| 실행 실패 단계 6·코드 7 | `execution-failure.mjs`의 `stages`·`codes` ↔ DDL `failure_stage`·`failure_code` CHECK | 차이 0 |
| 실행 `reason` 6종 | `public-contract.mjs`의 `reason: z.enum` ↔ DDL `exec_reason` | 차이 0 |
| 자동 결정 사유 20종 | `command-automation.mjs`의 모든 `reasonCode` 리터럴 ↔ DDL `reason_code` CHECK | 차이 0(정규식이 함께 잡은 `source_plan`은 배차 단계 이름이라 사유가 아님) |
| 데스크톱 상태 4종·안전 실패 9종·진단 17종 | `desktop-state.mjs:3`, `safety.mjs:15-16, 61-64` ↔ 문서 | 차이 0(진단 17은 숫자 포함 이름 `UTF8_DECODE`까지 센 값) |
| ErrorCode 어휘 | 기준본 `x-portal-errorCodes`의 UPPER_SNAKE 토큰 239개(비-코드 문자열 5개 `LC_ALL, NOT_MEASURED, PORTAL_CLOUDFLARED, SSH_UI_PRIVATE_PROBE_NOT_FOR_MODEL, SSH_UI_PUBLIC_PROBE` 제외)와 `src/**`(`adapters/cli`·`adapters/http` 제외) 따옴표 UPPER_SNAKE 리터럴을 `grep -rhoE`로 다시 뽑아 5.3절 토큰과 `comm` 대조 | 기준본 239개가 모두 5.3절에 있다(누락 0). 기준본에 없고 소스에 있는 코드 11개를 5.3절이 추가했다(`COMMAND_CONTEXT_*` 2, `INVALID_COMMAND_CONTEXT` 1, `READ_COMMAND_*` 4, `SOURCE_*` 3, `DESKTOP_AUTH_BROKER_UNAVAILABLE` 1 = 11). 분류 합계: 계약 enum 8종 217값(Request 30, Operation 23, Artifact 46, History 9, Capacity 12, Execution 7, Transfer 18, Desktop 72) = 기준본 206 + 추가 11, 이전 16, 내부 wire 9, 소멸 6, 이름 조각 2. 기준본 239 = 206 + 16 + 9 + 6 + 2. 8개 enum 사이 중복 값 0 |
| ErrorCode 선언 개수 | 문서의 각 `…ErrorCode (N)` 표기와 실제 나열된 토큰 수를 `awk`로 비교 | 일치(수정 전 Desktop 80·Operation 24·Artifact 47·「이전」 17·내부 wire 10 표기는 이 점검으로 바로잡음) |

### A.2 SQLite 표·열 대조 (소스 재추출 ↔ DDL 초안)
| 점검 | 방법 | 결과 |
|---|---|---|
| 2.x 표 11개와 열 | `CREATE TABLE IF NOT EXISTS` 문(`command-state.mjs:16`, `agent-cli-state.mjs:20`, `maintenance-state.mjs:14`, `runtime-capacity-state.mjs:12`, `command-output.mjs:53`, `operation-store.mjs:57-67`)을 소스에서 다시 뽑아 열 이름이 8.3절 대조표에 모두 나오는지 확인 | 11개 표, 모든 열이 대조표에 있음(`operations`의 `body`·`contract`·`digest`는 열로 풀거나 `contract_digest`로, `operation_schema`는 소멸로 표시) |
| 3.0 DDL 표 개수 | 문서의 `CREATE TABLE` 문 수 | 26개(V1 11, V2 3, V3 3, V4 4, V5 1, V6 4). 선택 표 `operation_fence`·`operation_slot`은 세지 않음 |
| 열 폭과 CHECK 값 길이 | 각 enum 열의 최장 값 길이 ≤ `VARCHAR` 폭을 직접 확인(예: `TERMINATING` 11자 = `state VARCHAR(11)`) | 불일치 0 |
| 미실행 | DDL을 H2에서 실행하지 못했다(빌드·시험은 이 작업의 금지 범위) | **미검증**: 구문 오류·H2 호환(`GENERATED BY DEFAULT AS IDENTITY`, `CLOB`, `CHECK` 이름 길이)은 구현 3이 `S2-DB-01`로 확인 |

### A.3 사례 ID 대조 (사례 표 ↔ 이 문서)
| 점검 | 방법 | 결과 |
|---|---|---|
| 사례 표 파싱 | `part-a` 19~908행, `part-b` 24~887행에서 `RC-[AB]-nnn` 행 1,690개를 읽어 모듈 열로 걸러냄(결과는 세션 임시 폴더) | 1,690행. 모듈 열에 domain·store·app이 있는 행 717, 모듈 열이 깨진 행 9(본문으로 판정) |
| 존재·결번 | 9.2·9.3 표의 사례 ID(범위 `~`는 전개)를 사례 표의 ID 집합과 `comm` | 닫는 162건·미루는 558건 모두 사례 표에 존재. 결번 ID(A-136~141, 431, 514, 869~879, 881, 884, 885 등)는 하나도 인용하지 않음(사례 표에 없어 위 비교로 걸러짐) |
| 중복·누락 | 닫는 집합 ∩ 미루는 집합, 후보 717행 − (닫는 ∪ 미루는) | 교집합 0, 누락 0 |
| 합계 | 162 + 558 + 모듈 열이 깨진 6(9.4) = 726 | 일치 |
| 건수 표기 | 9.2·9.3 표의 「건수」 열 합 | D 81 + S 81 = 162, 미루는 표 합 558 |

### A.4 미검증·한계
- 이 문서의 Java 코드 조각과 DDL은 컴파일·실행하지 않았다(작업 범위가 설계 문서). 모양 설명용 서명이다.
- `[미확인]`으로 표기한 외부 사실: H2 SERIALIZABLE의 쓰기 왜곡 방지, Spring Data JDBC의 `Instant`↔`TIMESTAMP` UTC 변환과 `Limit` 지원, URL Standard의 「ends in a number」 규칙, `java.net.IDN`(IDNA2003)과 WHATWG(UTS46)의 차이. 구현 담당이 공식 문서로 확인한다(경로는 본문 각 절).
- 사례 표의 「입력·기대·판정」 셀은 모듈 열과 대상 기능 열만 읽었다. 각 사례의 세부는 이식 때 원 시험으로 확정한다.
- `preservation-verification.mjs`·`offline-preservation.mjs`·`operation-migration.mjs`는 전체를 읽지 않았다(4·7단계).
- vendor 규칙 조사 문서는 없었다(0.3절).
- 읽기 전용 점검 중 셸 명령 한 번이 AGS 훅에 막혔다. 막은 훅 메시지 원문: `[AGS] Product file #3 changed outside the running workflows' writeTargets: (path unknown: Bash) (incl. 2 changed earlier outside them). If this is separate work, start another workflow with non-overlapping writeTargets; …`. 해당 명령은 세션 임시 폴더로 리다이렉션해 ErrorCode 차이를 만들던 점검이었고, 같은 점검을 파일 쓰기 없이(`comm`+프로세스 치환) 다시 했다. 훅을 우회하지 않았다.

