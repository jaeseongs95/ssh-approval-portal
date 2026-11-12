# 3.0.0 Java 전환 3단계 설계 초안 (portal-ssh · portal-app 유스케이스와 포트)

상태: 초안(설계 조사 담당 산출물, 메인 판정 전). 이 문서는 제품 코드·빌드·시험을 하지 않고 쓴 설계다. 사실은 2.x 소스와 현재 Java 코드, 공식 문서에서 직접 읽은 것만 `[사실]`로 적었다.
기준 작업 사본: `D:/codex/build/ssh-portal-v300-ssh` (브랜치 `feature/v300-ssh`, HEAD `c14a6eb` = develop).
계획 정본: `C:\Users\Lenovo\.claude\plans\inherited-marinating-island.md`(「3. SSH·파일·실행 감독」, 미종결 결함 표, 제품 설계 기준).
형식 본보기: `stage2-design.md`(이 문서에서 `S2`로 줄여 부른다).

## 0. 읽는 법

### 0.1 표기
- `[사실]` 직접 읽은 것. 근거는 `파일:줄`이다. 2.x 경로는 저장소 루트 기준(`D:/claude/ssh-mcp/ssh-approval-portal`, `a44c4d1`), Java 경로는 `java/` 기준이다. 줄은 LF 기준이다.
- `[제안]` 이 문서의 설계 선택이다. 메인이 10.2절에서 판정한다.
- `[미확인]` 공식 문서·소스로 확인하지 못한 것이다. 시범(6절)이나 실제 OpenSSH CI(7절)로 확인한다.
- 코드·식별자·경로는 원문이다. 패키지 접두는 `io.github.jaeseongs95.portal`이고 본문에서는 `ssh.…`·`app.…`·`domain.…`로 줄인다.
- 제품 설계 기준(계획 정본 「제품 설계 기준」): 저장소는 공개다. 이 문서의 모든 기본값·시험 환경·설치 가정은 불특정 사용자가 자기 호스트에 설치한다는 전제다. 사용자 개인 운영 환경(특정 클라우드·도메인·프록시·DBMS 배치)은 이 문서에 넣지 않았다. 이 PC의 사실(7.4절)은 「시험을 어디서 돌릴 수 있나」를 말하는 근거로만 적었다.

### 0.2 읽은 입력(확인 범위)
- 계획 정본 전체, `stage2-design.md` 전체(13.6 이월 포함), `feature-map.md`(3단계 행, Q3·Q8·Q10·Q12, 4.1 판정), `official-docs-platform.md` Q1·Q2, `regression-cases.md`와 `part-a/b`(1,673행을 `|` 개수와 무관하게 「뒤에서 세 번째 칸」으로 모듈 열을 파싱), `vendor-ssh-mcp-rules.md` 0·3·4·5·9절, `foundation-cases.md` 5절.
- 현재 Java: `portal-app`(포트 interface 전부), `portal-domain`(`error`·`operation`·`schedule`·`target`·`path`·`command`·`classify`·`redact`), `portal-store`(`JdbcArtifactRegistry`·`ArtifactInventory`·`RetainedPayloads`·Flyway 위치), `portal-arch-checks`(`ModuleTable`·`PortalRules`), `portal-ssh`(`SshSpikeTest`, `build.gradle.kts`).
- 2.x 소스: `src/adapters/ssh/{execution-supervisor,connection-lifecycle,transfers,windows-command}.mjs` 전부, `vendor.mjs` 앞부분과 grep, `python-source.mjs` 앞 30줄, `src/application/files.mjs` 전부, `src/adapters/storage/artifacts.mjs`의 예산 부분, `helper/file-helper.py` 전부, `scripts/windows-file-helper.ps1` 전부, `scripts/windows-file-native.cs`(함수 목록·검사 줄만 grep), `scripts/manage-agent-cli.py` 640~780줄, `.github/workflows/windows-ssh.yml`.
- 공식 문서: `official-docs-platform.md`가 인용한 것 외에 이번에 MINA 2.20.1 소스를 직접 열었다(URL은 부록 A.4).
- 개발원칙 9절 체크리스트, 3.4절(오류), 2.2절(손 구현 범주), 3.6절(Spring 기능으로 먼저 푸는 것), 7.4절. 디자인 패턴 정리·안티패턴 정리는 이번에 다시 열지 않고 계획 정본이 인용한 항목(8.12, 8.15, D3, Z2, R3, T2, SP1)만 따랐다(미검증 한계, 부록 A.4).
- 읽지 못한 것: `windows-file-native.cs` 본문 전체(검사 줄 위치만 확인), `manage-agent-cli-windows.ps1`, `check-agent-cli-login.py`, `src/adapters/ssh/agent-cli.mjs`·`vendor.mjs` 본문 전체, `src/application/{agent-cli,commands,lifecycle,history,runtime-capacity,request-admission}.mjs`(S2가 읽은 요약만 사용).

### 0.3 이 조사가 새로 확인한 것(먼저 읽을 6건)
1. **MINA 2.20.1 클라이언트에는 `signal` 채널 요청을 보내는 공개 API가 보이지 않는다.** `ChannelSession`과 `AbstractClientChannel` 소스에서 `signal` 송신 메서드를 찾지 못했고, 받는 쪽(`exit-status`·`exit-signal` 핸들러)만 있다. 계획의 「채널 signal 취소」는 그대로는 쓸 수 없다(3.3절, 결정 D3-05). `[사실]` 소스 확인 범위는 두 파일이다. 상위 클래스 `AbstractChannel`은 열지 않았다(`[미확인]`).
2. **`exec` 요청의 응답 대기는 기본 꺼짐이다.** `CoreModuleProperties.REQUEST_EXEC_REPLY = Property.bool("channel-exec-want-reply", false)`(2.20.1)이다. 이 값이 거짓이면 「exec 요청이 서버에서 거절됐다」와 「요청이 갔는지 모른다」를 구분할 근거가 없다. D-0013·D-0038의 「시작 전 실패 대 시작 후 끊김」 경계가 이 값에 달려 있다(3.2절).
3. **`SftpClient.rename(old, new, CopyMode...)`는 협상 판이 5 미만이면 옵션이 있을 때 `UnsupportedOperationException`을 던진다.** 요청은 보내지지도 않는다(`AbstractSftpClient` 소스, 2.20.1). 1단계 시범 `SshSpikeTest.s06`은 MINA 서버(협상 판 6 추정)에 `CopyMode.Overwrite`를 써서 통과했지만, OpenSSH `sftp-server`는 3판이다. 그래서 원자적 교체는 `posix-rename@openssh.com` 확장 클라이언트(`OpenSSHPosixRenameExtension`)로 해야 하고, CopyMode 경로를 쓰면 실제 서버에서 깨진다(4.2절). 이 판 번호 추정은 `[미확인]`이다(실제 협상 판은 시범에서 읽는다).
4. **S2 9.4절의 「모듈 열이 깨진 행」 목록이 불완전하다.** 사례 표에서 `|`가 셀 안에 들어 칸이 밀린 행은 20개 이상인데 S2는 9개만 적었고, 그 결과 `portal-domain` 단독인 문법 사례 **A-464, A-465, B-567** 3건이 S2의 닫는 표·미루는 표 어디에도 없다. 이 문서가 3단계로 배정한다(8.2절 G1).
5. **`files` 도구의 `copy`·`move`·`remove`는 원격 SFTP 동작이 아니라 「서버에 올려 둔 staged 파일」에 대한 동작이다.** `copy`는 staged 파일을 대상에 게시하고 사본을 남기며, `move`는 게시가 확인된 뒤 staged 파일을 소비하고, `remove`는 staged 바이트만 지운다(`src/adapters/mcp/public-contract.mjs:224`, `src/application/opaque-files.mjs:78, 124, 177-179`). 그래서 SFTP 쓰기 경로는 업로드(게시) 하나이고, `remove`는 SSH가 필요 없다. 이 문서의 「copy·move·remove」는 이 의미로만 쓴다.
6. **`ARTIFACT_STORAGE_FULL`이 이미 계약 코드로 있다**(`domain.error.ArtifactErrorCode`, 2.x `src/adapters/http/opaque-file-api.mjs:16`에서 HTTP 507, ENOSPC·EDQUOT 대응 `src/application/opaque-files.mjs:18`). D-0012의 「디스크 부족」은 새 오류 코드 없이 이 값으로 나눌 수 있다. 다만 다운로드 작업의 `ExecutionFailure`(`ExecutionErrorCode` 7종)에는 대응 값이 없어 결정이 필요하다(결정 D3-03).

---

## 1. 범위와 비범위

### 1.1 3단계가 하는 것 [제안]
`portal-ssh`와 `portal-app`의 유스케이스·포트를 만들고, 거기서 쓰는 `portal-store`·`portal-domain`의 좁은 보강을 한다.

| 묶음 | 내용 | 절 |
|---|---|---|
| A. SSH 세션 | `SshSessionPool`(죽은 세션 사전 감지, 명령 재전송 없는 1회 재연결), 호스트 키 검증(TOFU·핀·strict), ProxyJump, 프로필 TOML·`SSH_MCP_*` 자격 증명, 연결 시간·heartbeat | 3.5, 3.6 |
| B. exec 감독 | 시간 한도, 취소, 출력 상한, 출력 sink(backpressure), 단계 경계(시작 전 실패 대 시작 후 끊김), 시각 기록, 자동 재전송 금지 | 3 |
| C. SFTP 파일 작업 | 업로드(게시)·다운로드, 원자적 교체(posix-rename 또는 백업 이름), 권한 오류·transport 오류 구분, 권한 지정(Windows는 미지원 결과) | 4 |
| D. 플랫폼 | `TargetPlatform` 구현 2종(`LinuxTargetPlatform`·`WindowsTargetPlatform`), `CommandLineGrammar` 구현 2종, Python 원본 실행 계획, Windows PowerShell 래핑(CLIXML) | 2.3 |
| E. 에이전트 CLI 설치(Q3)·elevate(Q8) | `AgentCliInstaller`, 승격 방식 시범 | 6 |
| F. 응용 유스케이스 | 대기 이벤트(`ApplicationEvent`), 디스패처, 요청 입장, operations·history·capacity 서비스, 파일 서비스, 읽기 명령 경로, lifecycle, 재시작 복원, 에이전트 CLI 서비스 | 8.2 |
| G. D-0012·D-0013·D-0035·D-0038 | 「이 실패 범주를 이렇게 막고 이 시험으로 고정한다」(원인은 확정하지 않는다) | 3.4, 4.5, 5, 8.4 |
| H. 이월 | 1.3절 | 1.3 |

### 1.2 4단계 이후로 넘기는 것 [제안]
| 항목 | 단계 | 이유 |
|---|---|---|
| direct-tcpip forward·GUI helper stream의 구현과 시험(A-715~729대, A-816~829, D-0021·D-0022) | 5 | 소비자가 `portal-desktop`이다. 3단계는 포트 이름과 서명 초안만 둔다(2.2절 `RemoteForwarder`·`RemoteStreamExecutor`) |
| `AgentReleaseCatalog` 어댑터(npm 레지스트리 `RestClient`), A-058~A-064 | 4 | `portal-web` 책임(S2 7.4절). 3단계 서비스 시험은 가짜 카탈로그로 한다 |
| 명령 자동화 서비스·`RiskEvaluator`·test-server-mode(`BRIDGE_TEST_SERVER_SECRET_REF` 해석), 자동 파일 정책(A-188~A-200), source 자동화(B-455 외) | 4 | vendor 문서 13.4: test-server-mode는 4단계. 3단계는 `FilePathPolicy` 포트를 소비만 한다 |
| MCP·관리자 HTTP 경계(오류 봉투 변환, `observe` 출력 페이지 D-0036), 오류 코드 → HTTP 상태 | 4 | `portal-web` |
| `portal-server` 전체 설정 바인딩(`BridgeProperties`, `BRIDGE_*` 키 전부) | 4 | 접두 소유권(S2 7.2절). 3단계는 값 객체를 생성자로 받는다(결정 D3-12는 최소 조립만) |
| 설정·환경 파일(B-831 등), H2 파일 DB 경로 점검(A-048) | 4 | S2 13.6 이월 그대로 |
| 이전된 legacy unknown 예산(B-189·B-191), 보존 비교 | 4·7 | `portal-migrate`가 만든 행이 필요 |
| 실제 npm 패키지 설치 smoke(B-550·B-551) | 7 | CI 구성(`package_smoke`) |
| Windows 소유자·DACL·ACE 신뢰 검사(결정 D3-02 (a) 선택 시) | 후속 | 4.4절 |
| keychain 인증(`auth = "keychain"`) | 미지원 | 2.x가 쓰는지 미확인(vendor U-09). 3단계는 미지원 결과로 돌려준다(결정 D3-09) |

### 1.3 2단계 이월 항목(S2 13.6)과 3단계 처리 [제안]
| 이월 항목 | 3단계 처리 | 담당(9절) | 사례 |
|---|---|---|---|
| 미룬 사례 A-173(유지보수 중 reap 정책) | `ArtifactReaper`(portal-app `@Component`, `@Scheduled`)가 유지보수 상태를 보고 reap을 보류한다 | 구현 D | A-173 |
| A-182·A-183(스트림 가져오기 예약·해시·정리) | SFTP 다운로드 유스케이스가 출력 포트 `openStream`·`streamDigest`를 쓴다(아래 「출력 포트」) | 구현 D | A-182, A-183 |
| B-004(보호 장치 실패 시 출력 reap 금지·시작 거절) | 조립 로직: `PrivateStorage` 검사 실패 시 reap 금지 + 시작 거절 | 구현 D | B-004 |
| `BudgetExceeded`가 보유분과 라이브 예약분을 나눠 싣기 | `ArtifactReservation.BudgetExceeded(requestedBytes, ReservedSplit(holdingBytes, liveBytes), budgetBytes)`로 바꾼다(5.2절). `JdbcArtifactRegistry.reserveRows`(`JdbcArtifactRegistry.java:102-105`)가 이미 `artifacts.chargedBytes() + quarantined`를 합산하므로 합치기 전 두 값을 그대로 싣는다 | 구현 D | S3-AR-02, S3-AR-05 |
| `cleanupFailures` 0의 의미 | 3.0에서 0은 「없음」이다(`JdbcAgentCliRequestStore`/`AgentCliMapper.java:53, 56-57`이 null→0으로 받음). 2.x는 helper가 낸 0을 거절해 unknown으로 만들었다(`test/agent-cli-delivery.test.mjs:112`). 3단계에서는 원격 helper가 없어 숫자를 낼 주체가 Java 설치기뿐이므로, 「정리 실패 횟수는 설치기가 센 0 이상의 값」으로 확정하고 0을 거절하는 시험은 뒤집는다 | 구현 B | S3-AG-08 |
| 저장소 전용 오류 코드: 정책 개정 충돌·유지보수 소유자 재사용·출력 버전 충돌 | 현재 Javadoc에만 이름이 있다(`CommandPolicyStore.java:14` `POLICY_REVISION_CONFLICT`, `MaintenanceStore.java:18` `MAINTENANCE_OWNER_USED`). 값 enum에 없다. 3단계에서 추가하고 `envelope.schema.json`의 `x-portal-errorCodes`를 갱신한다(S2 D-19 방식, 결정 D3-13) | 구현 C | S3-UC-07 |
| artifact 포트 보강: `holding/chunks/findStagedByKey`를 `ArtifactInventory`(`portal-store`)에서 `ArtifactRegistry`(`portal-app`)로 | 이동한다(`ArtifactInventory.java:20, 23, 26`). 소비자가 portal-app의 유스케이스라 store 내부 interface로 두면 DIP가 거꾸로다 | 구현 D | S3-AR-08 |
| artifact 고정 해제 | 「고정」은 `ArtifactRetention.PINNED`와 `submit`(작업을 만들면 고정, `ArtifactRow.java:45` 주석)이다. 작업이 종료 상태가 되면 `ArtifactRegistry.unpin(id, reason)`으로 풀고 만료 계산에 돌려준다. 현재 포트에는 해제 메서드가 없다 | 구현 D | S3-AR-07 |
| `beginConsume`의 `ConsumeReason` | `beginConsume(id, ConsumeReason)`로 바꾼다. 현재는 `completeConsume`에서만 받는다(`ArtifactRegistry.java:45, 48`). `move`는 게시 확인 뒤 소비(`MOVED`), `remove`는 로컬 삭제(`REMOVED`)이므로 시작 시점에 이유가 정해진다(0.3절 5) | 구현 D | S3-AR-09 |
| 출력 포트 `openStream`·`streamDigest` | `OutputPayloadStore`에 `PayloadRead openStream(OutputId)`와 `Digest streamDigest(OutputId)`를 더한다. 스풀 `.stream`을 해시하며 읽어 다운로드 artifact의 해시와 비교한다(A-182·A-183) | 구현 D | S3-AR-06 |
| `AuditFailedException`의 `PortalException` 편입 | 두 방법의 비교는 결정 D3-14다. 추천은 「어댑터 예외로 두고 유스케이스가 `DispatchRefusedException(StepFailed(DECISION_AUDIT·START_AUDIT, AUDIT_FAILED))`로 변환」이다. `DispatchReason.AUDIT_FAILED`·`DispatchStage.DECISION_AUDIT`·`START_AUDIT`가 이미 있다(S2 4.7절) | 구현 C | S3-UC-02 |
| 분류기·redactor `@Bean` 등록 | `VendorCommandClassifier`·`VendorOutputRedactor`는 `domain.classify`·`domain.redact`의 평범한 클래스라 Spring 어노테이션이 없다. `app.config.DomainBeans`(`@Configuration`, 이미 `Clock` 등을 만든다)에 `@Bean` 두 개를 더한다. 사유 주석은 DomainBeans와 같다(개발원칙 3.1) | 구현 C | S3-UC-03 |
| 서버 빈 조립: `StorageRoots`, `ArtifactLimits`, `OutputLimits`, `AuditFileLocation`, `Clock`·`JsonMapper`·`SecureRandom` | `Clock`·`SecureRandom`은 이미 `DomainBeans`에 있다. 나머지 네 값은 `portal-store`가 생성자로 요구하고 만드는 곳이 없다. 결정 D3-12 | 구현 D | S3-UC-08 |
| 제품 설계 기준(공개 저장소) | 위 모든 기본값은 불특정 사용자 전제다. 설정 이름은 `bridge.*`(`BRIDGE_*` 유지), 경로는 설정으로 받는다. 개인 환경 값은 문서·기본값·시험에 없다 | 전원 | 9.3절 완료 조건 |

### 1.4 계획·feature-map과 어긋나거나 확정이 필요한 전제(요약)
- 계획 3단계 문장 「exec 감독(…채널 signal 취소…)」: 0.3절 1, 결정 D3-05.
- feature-map `ssh/transfers.mjs` 행 「SFTP 부모 fd 결속 불가」: 4.3절에서 대체 통제와 남는 위험을 적었다.
- feature-map 판정 Q8 「`sudo -n <sftp-server>` 위에 MINA SFTP」: MINA 클라이언트가 임의 채널 위에서 SFTP를 말할 수 있는지 `[미확인]`이다(6.1절).

---

## 2. 포트·어댑터 경계

### 2.1 의존 방향과 ArchUnit [사실 + 제안]
- `[사실]` 모듈 표: `domain → ∅`, `app → {domain}`, `store → {app, domain}`, `ssh → {app, domain}`, `desktop → {app, domain}`, `web → {app, domain}`, `server → {전부}`(`portal-arch-checks/src/test/java/.../ModuleTable.java:18-24`). `ssh`는 `store`·`desktop`·`web`을 import하지 못한다. `portal-ssh/build.gradle.kts`는 `api(project(":portal-app"))`만 가진다.
- `[사실]` 이미 있는 규칙: A-DIR(방향), A-DOMAIN(domain은 JDK·jackson-annotations만), A-PROCESS(`ProcessBuilder`·`Runtime.exec`는 목록의 클래스만, `PortalRules.java:150-157`), A-SLEEP(`Thread.sleep` 금지, `:381-385`), A-OPTIONAL-*, A-UTIL, A-CYCLE.
- `[제안]` 3단계가 더하는 규칙(시험 S3-AB-01~08, 모두 `portal-arch-checks`에 두며 이 폴더는 메인 소유이므로 구현 담당은 요청만 한다):

| ID | 규칙 | 이유 |
|---|---|---|
| A-MINA | `org.apache.sshd..`를 import하는 클래스는 `portal-ssh`(`io.github.jaeseongs95.portal.ssh..`)에만 있다 | 벤더(MINA) 경계. app·domain·store가 구현 세부를 알면 안 된다(원칙 3.2·벤더 비종속) |
| A-NO-LOCAL-PROCESS | `portal-ssh`에서 `ProcessBuilder`·`Runtime.exec`를 쓰지 않는다 | 원격 명령은 SSH 채널이지 로컬 프로세스가 아니다. A-PROCESS 목록에 portal-ssh 클래스가 들어가지 않는다 |
| A-NO-RETRY-EXEC | `ssh.exec..` 패키지와 `RemoteExecutor` 구현은 `@Retryable`·`RetryTemplate`·`@ConcurrencyLimit`을 쓰지 않는다 | 자동 재전송 금지의 기계 검사. 개발원칙 3.6의 `@Retryable` 기본 재시도 3회(공식)는 exec에 부적합하다 |
| A-SSH-NO-PLATFORM-BRANCH | `ssh..`에서 `TargetOs`를 `switch`·`==`로 가르는 코드는 `TargetPlatformRegistry` 밖에 없다 | 패턴 8.12: 선택은 `List<TargetPlatform>` 주입, 공통 코드에 `if (windows)` 금지 |
| A-REMOTE-RESULT | `app.remote..`의 포트 반환 타입은 `sealed interface`이거나 `ExecutionReport`이고 `Optional`·`boolean`이 아니다 | 「없음·미지원·미확인」을 뭉치지 않는다(원칙 35항) |
| A-NO-UOE | `UnsupportedOperationException`을 던지는 `new`가 `ssh..`·`app..`에 없다(MINA가 던지는 것을 잡아 변환하는 `catch`는 허용) | LSP. 3.2 발견 3의 `rename` 옵션 예외가 이 규칙의 근거 사례다 |
| A-AUDIT-BOUNDARY | `AuditFailedException`이 `app.execution..`·`app.file..` 공개 메서드 밖으로 나가지 않는다(결정 D3-14 (b) 선택 시) | 변환 한 곳 |
| A-NO-CHARSET-DEFAULT | `new String(byte[])`·`getBytes()` 같은 문자셋 없는 변환이 없다(Z2) | 원격 출력은 UTF-8 명시. Windows는 래퍼가 UTF-8로 맞춘다(3.1절) |

### 2.2 portal-app 포트 [제안] (패키지 `app.remote`, 소비자 역할 단위로 좁게 나눈다)

`[제안]` 아래 서명은 초안이다. 반환 타입에 `Optional`을 쓰지 않는다(「없음」과 「미확인」이 갈리는 곳은 sealed). 모든 포트는 `RuntimeException`을 던지지 않고 결과로 답하는 것이 원칙이며, 던지는 것은 시작 전 거절(`DispatchRefusedException`)과 프로그래밍 오류뿐이다.

```java
package …app.remote;

/** exec 한 번의 수명을 소유한다(시간 한도·취소·출력 상한). 자동 재전송을 하지 않는다. */
public interface RemoteExecutor {
    ExecutionReport run(RemoteExecution request, OutputSink sink, ExecutionControl control);
}
public record RemoteExecution(TargetId target, TargetRevision revision, AccessMode access, PreparedCommand command, ExecutionLimits limits) {}
public record ExecutionLimits(Duration deadline, Duration stopGrace, DataSize outputPerStream) {}  // 2.x 기본 120s·5s·1MiB(execution-supervisor.mjs:3-5)
public record ExecutionControl(CancelToken cancel, DispatchGuard guard) {}
public interface DispatchGuard { void beforeDispatch(); }   // 연결 뒤·exec 요청 전 재확인. 거절은 DispatchRefusedException(target_changed 등)
public interface CancelToken { boolean requested(); /* 구독은 ApplicationEvent 또는 CompletableFuture로 */ }
public interface OutputSink { SinkResult accept(StreamFrame frame); }  // sealed SinkResult: Accepted · Failed(원인 보존). Failed 뒤에도 채널은 계속 비운다(D-0040)
/** 결과는 domain의 ExecutionOutcome을 그대로 쓰고, 시각 기록을 더한다. */
public record ExecutionReport(ExecutionOutcome outcome, ExecutionTimeline timeline) {}
public record ExecutionTimeline(List<PhaseMark> marks) {}   // PhaseMark(ExecutionPhase phase, Instant at). phase: CONNECT_STARTED, CONNECTED, CHANNEL_OPENED, REQUEST_SENT, FIRST_OUTPUT, EXIT_SEEN, CLOSED

/** SFTP 파일 작업. 결과는 sealed로, 「확정 거절」과 「확정 안 됨」을 가른다. */
public interface RemoteFileTransfer {
    UploadResult upload(UploadRequest request, PayloadSource source, ExecutionControl control);
    DownloadResult download(DownloadRequest request, PayloadSink sink, ExecutionControl control);
    PermissionResult applyPermissions(PermissionRequest request, ExecutionControl control);   // sealed: Applied · Unsupported(UnsupportedReason)
    ElevationResult checkElevation(ElevationRequest request, ExecutionControl control);      // sealed: Granted · Denied · NotApplicable(os)
}
public sealed interface UploadResult permits UploadResult.Published, UploadResult.Refused, UploadResult.RolledBack, UploadResult.Unconfirmed {
    record Published(Digest sha256, Instant confirmedAt, ReplaceMethod method) implements UploadResult {}   // = CompletionEvidence.FilePublished의 재료
    record Refused(TransferErrorCode code, FileDiagnostic diagnostic, CleanupState cleanup) implements UploadResult {}      // 교체 전. 대상 불변이 확정
    record RolledBack(TransferErrorCode code, FileDiagnostic diagnostic, RestoreEvidence restored) implements UploadResult {} // 교체 뒤 실패, 원본 복원 확정
    record Unconfirmed(UnconfirmedCause cause, CleanupState cleanup) implements UploadResult {}                              // transport 단절·복원 미확정 → UNKNOWN
}
public sealed interface DownloadResult permits DownloadResult.Fetched, DownloadResult.Refused, DownloadResult.Failed {
    record Fetched(long size, Digest sha256) implements DownloadResult {}
    record Refused(TransferErrorCode code, FileDiagnostic diagnostic) implements DownloadResult {}   // 권한·없음·경로 정책 등 확정 거절
    record Failed(TransferFailureCause cause) implements DownloadResult {}                          // transport 끊김 등. 원격 효과 없음(읽기)
}

/** 대상 접속 프로필의 출처. 2.x는 vendor TOML 레지스트리였다. */
public interface ProfileSource { ProfileLookup lookup(ProfileAlias alias); }  // sealed: Found(ConnectionProfile) · NotConfigured(alias)
/** 자격 증명. 비밀 값은 toString·로그에 나오지 않는 타입(SshCredential)으로 돌려준다. */
public interface SshCredentialSource { CredentialLookup resolve(ConnectionProfile profile); } // sealed: Resolved(SshCredential) · Missing(List<CredentialMiss>) · Unsupported(AuthMethod)
/** 허용 루트·TEST 우회. 구현은 4단계(test-server-mode). 3단계 시험은 가짜 구현. */
public interface FilePathPolicy { PathPolicyDecision decide(TargetId target, RemotePath path); } // sealed: Enforce(allowedRoot) · Bypass · NotApplicable · Unconfirmed

/** 5단계 데스크톱이 쓰는 이름만(3단계는 구현하지 않는다). */
public interface RemoteForwarder { ForwardOpenResult open(ForwardRequest request, ExecutionControl control); }            // sealed: Opened(ForwardHandle) · Refused · Unconfirmed
public interface RemoteStreamExecutor { StreamOpenResult open(StreamRequest request, ExecutionControl control); }         // PTY 없는 binary exec(A-816~829)

/** 에이전트 CLI 설치(Q3). */
public interface AgentCliInstallerPort {
    AgentCliInstallResult install(AgentCliPlan plan, ExecutionControl control);      // sealed: Installed · Reused · Refused · RolledBack · Unconfirmed
    AgentCliStatusResult status(AgentCliStatusRequest request, ExecutionControl control);
}
```
- `[제안]` 왜 `RemoteExecutor`가 `ExecutionOutcome`을 직접 돌려주나: S2가 `ExecutionOutcome`을 도메인 정산 입력으로 이미 정의했다(`domain/operation/ExecutionOutcome.java`: `notDispatched`·`transportLost`·`exited` 정적 생성과 `verdict()` 판정표 `:89-`). 어댑터가 같은 값을 만들어야 판정표가 한 곳(`Operation.settle`)에 남는다. 두 번째 결과 모양을 만들지 않는다.
- `[제안]` `PayloadSource`·`PayloadSink`는 portal-app의 좁은 interface다(`app.storage.PayloadRead`·`PayloadWrite`와 같은 쪽). 호출 쪽이 `ArtifactPayloadStore`를 열고 어댑터는 바이트만 흘린다. 어댑터는 트랜잭션을 모른다(개발원칙 4.4).
- `[제안]` 설정 값(시간·크기)은 `app.remote.SshSettings`(record, `Duration`·`DataSize`)로 생성자 주입을 받는다. `@ConfigurationProperties` 바인딩은 4단계 `BridgeProperties`가 한다(S2 7.2절의 접두 소유권). `portal-ssh`와 `portal-app`에는 `@ConfigurationProperties`를 두지 않는다.

### 2.3 `TargetPlatform`과 `CommandLineGrammar` [사실 + 제안]
- `[사실]` `TargetPlatform` 현재 서명은 `os()`·`pathSyntax()`·`capabilities(Target)`·`classify(CommandText)`·`commandLineGrammar()`·`deniesName(TargetRule, CommandText)` 여섯 개다(`app/target/TargetPlatform.java:24-39`). `TargetPlatformRegistry`가 `List<TargetPlatform>`을 `EnumMap`으로 모으고 누락·중복을 시작 시 거절한다(S2 7.3절, 구현됨).
- `[사실]` `CommandLineGrammar`는 `domain.command`가 소유한다(S2 13.1 D-01). 구현 2종(`PosixCommandLineGrammar`·`WindowsCommandLineGrammar`)이 3단계 `portal-ssh`다. 구현이 자기 식별값 `Platform platform()`을 답하고 `List<CommandLineGrammar>`로 합류한다(S2 6.3절).
- `[제안]` 3단계가 `TargetPlatform`에 더하는 메서드(S2 7.3절 「이름만」을 확정):

```java
PreparedCommand prepareCommand(CommandText command, WorkingDirectory workdir);      // Linux: 그대로(+cd 전치). Windows: PowerShell -EncodedCommand 래핑·CLIXML 억제·8000자 상한(windows-command.mjs:1-58)
PreparedCommand prepareSource(SourceText source, SourceArguments args, WorkingDirectory workdir);   // python-source-v1. 수신기는 고정 원문(바이트·sha256 검증 후 실행)
PathPolicyBinding pathPolicy(Target target);                                         // Linux: 정책 없음(NoRootPolicy). Windows: allowedRoot 비교 규칙
PermissionSupport permissionSupport();                                               // sealed: Supported · Unsupported(UnsupportedReason). Windows는 Unsupported(WINDOWS_SFTP_CHMOD)
ElevationPlan elevationPlan();                                                       // sealed: SudoNonInteractive(…) · WindowsAdministratorCheck(…) · NotSupported
AgentCliPlan agentCliPlan(AgentCliIntent intent, AgentRelease release);              // 고정 원격 명령 목록(6.2절). 에이전트 CLI 지원 능력이 없으면 호출하지 않는다
```
- `[제안]` `WorkingDirectory`는 sealed(`Default`·`At(RemotePath)`)다. 매개변수에 `Optional`을 쓰지 않는다. `PreparedCommand(String commandLine, StdinBytes stdin, CommandKind kind)`는 값이다. `commandLine`이 8000자를 넘으면 `TransferErrorCode.WINDOWS_COMMAND_TOO_LARGE`로 거절한다(`windows-command.mjs:22`; 값은 이미 enum에 있다).
- `[제안]` 두 구현은 `@Component`이고 클래스 이름에 OS 분기가 없다. `LinuxTargetPlatform.classify`는 `CommandClassifier`(`VendorCommandClassifier`)에 위임하고, `WindowsTargetPlatform.classify`는 모듈 한정 cmdlet 두 개만 `READ_ONLY`, 나머지 `SAFE`다(S2 7.3절 근거 `target-platform.mjs:20-28`).
- `[사실]` 원격 대상에서 사용자 명령·Python 원문을 실행하는 것은 제품 기능이라 외부 프로그램 사용 금지의 예외(대체 불가)다(계획 결정 2, feature-map `windows-command.mjs` 행). 그 이유를 `WindowsTargetPlatform`·`LinuxTargetPlatform` 클래스 Javadoc과 `docs/external-programs.{en,ko}.md`에 적는다. 이 코드는 로컬 프로세스를 띄우지 않으므로 A-PROCESS 목록에 넣지 않는다(A-NO-LOCAL-PROCESS).

### 2.4 `portal-ssh`의 내부 구성 [제안]
어댑터 안의 클래스는 interface를 붙이지 않는다(원칙 34항: 변화 축 경계에만). 변화 축은 위 포트 경계(MINA 대 다른 SSH 구현, Linux 대 Windows)뿐이다.

| 패키지(`ssh.`) | 클래스(`@Component`) | 책임 |
|---|---|---|
| `session` | `SshSessionPool`, `SessionProbe`, `ProxyJumpResolver`, `ServerKeyPolicy`(+`PinnedFingerprintVerifier`), `SshAlgorithmPolicy`, `MinaClientFactory` | 세션 수명·핫 경로(3.5절) |
| `profile` | `TomlProfileLoader`, `ProfileRegistry`(= `ProfileSource` 구현), `EnvironmentCredentialSource` | 프로필 TOML·`SSH_MCP_*`(3.6절). `jackson-dataformat-toml`은 BOM 안이면 쓰고, 아니면 이유를 적는다(`[미확인]`: Boot 4.1.2 BOM의 jackson TOML 포함 여부는 이번에 열지 못했다) |
| `exec` | `MinaRemoteExecutor`(= `RemoteExecutor`), `ExecSupervisor`, `OutputPump` | 3절 |
| `sftp` | `MinaRemoteFileTransfer`(= `RemoteFileTransfer`), `AtomicReplacer`, `SftpFailureClassifier`, `RemotePathChecker` | 4절 |
| `platform` | `LinuxTargetPlatform`, `WindowsTargetPlatform`, `PosixCommandLineGrammar`, `WindowsCommandLineGrammar`, `PythonSourceReceiver`(고정 원문 리소스 로더), `WindowsCommandWrapper` | 2.3절 |
| `cli` | `AgentCliInstaller`(= `AgentCliInstallerPort`) | 6.2절 |
| (5단계) `forward`·`stream` | 이름만 | 2.2절 |

- `[제안]` 원격에 보내는 고정 문장(PowerShell 래퍼 조각, Python 수신기)은 Java 문자열 상수가 아니라 `src/main/resources/ssh/remote/*.ps1|*.py`로 두고 `RemoteScripts`(`@Component`)가 읽는다. 해시를 시험이 고정한다(S2 6.2절의 리소스 바이트 고정과 같은 방식). 이 파일들은 「제품이 실행하는 파일」이 아니라 「대상에 보내는 데이터」다. 개발원칙 1.4(셸·Python 금지)의 예외 이유(원격 사용자 명령 실행 범주)를 `docs/external-programs.*`에 적는다.

---

## 3. exec 감독

### 3.1 2.x 동작 [사실]
- 한도 기본값: 실행 120,000ms, 정지 유예 5,000ms, 출력 1MiB/스트림(`src/adapters/ssh/execution-supervisor.mjs:3-5`). 값이 1 미만이거나 2^31-1 초과면 거절(`:9-11`).
- 취소·마감: 정지는 INT 즉시, TERM을 유예의 1/3 뒤, KILL을 2/3 뒤에 보내고(`:52-57`), 유예가 끝나면 채널을 닫고 정산한다. 「닫기는 이 채널을 버릴 뿐 프로세스 종료의 증거가 아니다」(`:58-62`).
- 단계 경계: 채널 열기 직전에 `dispatched = true`로 올리고(`:101-103`), 열기 오류가 `error.reason`(확정 CHANNEL_FAILURE)을 가지면 `dispatched = false`로 되돌린다(`:111-113`). 그 밖의 오류는 exec와 경합했을 수 있어 시작으로 본다(주석 `:112`).
- 정산: `remoteState = !dispatched ? 'not_dispatched' : exitObserved ? 'exited' : 'unknown'`(`:27`), `cleanupComplete = !dispatched || closed || transportLost`(`:28`), `requiresReconciliation = remoteState === 'unknown' || !cleanupComplete`(`:35`), 출력 상태는 포획 실패·잘림·unknown·정리 미완·`transport_lost`면 `partial`(`:36`). `automaticReplay`는 항상 거짓(`:34`).
- 출력: 두 스트림 각각 수신 바이트·보존 바이트·cursor·잘림 여부를 센다(`:29-31, 65-73`). 영속 sink가 느리면 채널을 `pause`하고, sink 실패 시 `captureFailed`로 표시하며(`:76-85`), 정산 직후 `resume`해 채널 해제가 다른 작업을 기다리지 않게 한다(`:38-41`, 결함 D-0040).
- transport 단절: `onTransportLost` 구독이 `reason = 'transport_lost'`(정지 중이 아닐 때)로 즉시 정산한다(`:92-97`). 채널 `error`는 `stop('transport_lost')`(`:133`), 종료 코드 없이 `close`가 오면 `transport_lost`(`:137`).
- Windows 표시: CLIXML 진행 기록은 표시에서만 지우고 원문 stderr는 따로 보관한다(`:148-156`, D-0011 VERIFIED).

### 3.2 Java 설계: 단계 경계 [제안]
exec 한 번의 단계(`ExecPhase`, `ssh.exec` 내부 sealed 상태)와 결과 대응이다. 「durable unknown은 실제로 불확실할 때만」이 원칙이므로, 각 줄의 「확정」 근거를 적는다.

| 단계·사건 | 원격에서 일어났을 수 있나 | 결과(`ExecutionOutcome`) | 근거 |
|---|---|---|---|
| P0 연결 전 취소·마감·`DispatchGuard` 거절 | 없음 | `notDispatched`(reason CANCEL/DEADLINE) 또는 `DispatchRefusedException` | 아무것도 보내지 않았다 |
| P1 연결·인증·호스트 키 실패 | 없음 | `NOT_STARTED`, `SSH_CONNECT_FAILED`(stage `SSH_CONNECT`) | 채널이 없다 |
| P2 `CHANNEL_OPEN_FAILURE`(`SshChannelOpenException`) | 없음 | `NOT_STARTED`, `SSH_CHANNEL_OPEN_FAILED` | 서버가 채널 열기를 거절했다(MINA `handleOpenFailure`, 부록 A.4) |
| P3 채널 열림 뒤 `DispatchGuard.beforeDispatch()` 거절 | 없음 | `DispatchRefusedException`(`target_changed`·`policy_changed` 등), 채널은 닫는다 | exec 요청을 쓰기 전 |
| P4 exec 요청 쓴 뒤 **응답 FAILURE** | 없음(서버가 거절) | `NOT_STARTED`, `SSH_EXECUTION_FAILED` | `channel-exec-want-reply=true`일 때만 확정할 수 있다 |
| P5 요청 쓴 뒤 응답 없이 단절·시간 초과 | **있을 수 있음** | `transportLost`(UNKNOWN, `requiresReconciliation`) | 2.x가 「그 밖의 오류는 시작」으로 본 경합(`execution-supervisor.mjs:112`) |
| P6 `exit-status` 수신 | 끝남 | `exited(code)` | 증거가 있다 |
| P7 `exit-signal` 수신 | 끝남(신호) | `Signaled` → FAILED | 증거가 있다 |
| P8 실행 중 단절 | 모름 | `transportLost` | 종료 증거 없음 |
| P9 마감 시한 도달 | 모름 → 정지 절차 | 종료 증거가 오면 EXITED(reason DEADLINE, FAILED), 없으면 UNKNOWN | 정지는 요청일 뿐이다(`:58-62`) |
| P10 취소 | 위와 같음 | 증거 있으면 CANCELLED, 없으면 UNKNOWN | `ExecutionOutcome.verdict()` 1~3행 |
| P11 출력 sink 실패 | 계속 실행 | `capture=FAILED`, `outputState=PARTIAL`, 채널은 계속 비운다 | D-0040(`:38-41`) |
| P12 stdin 쓰기 실패 | 모름 | `INPUT_FAILED` + 정지 절차 | 2.x `stop('input_failed')`(`:142`) |

- `[제안]` P4를 구분하려면 `CoreModuleProperties.REQUEST_EXEC_REPLY`를 참으로 켠다(3.2 MINA 소스: 기본 거짓). 켜도 (a) MINA가 FAILURE 응답을 `ChannelExec` 닫힘이나 예외로 어떻게 전달하는지, (b) Win32-OpenSSH가 exec 요청에 응답을 주는지는 `[미확인]`이다. 시범 P3-1이 확인하고, 응답 확정이 안 되면 P4를 `NOT_STARTED`로 쓰지 않고 P5(unknown)로 둔다(보수적). 이 선택은 결정 D3-06이다.
- `[제안]` D-0013·D-0038과의 연결: 「0.07초 만에 unavailable」과 「850바이트 다운로드가 `transport_lost`/`unknown`」은 모두 P1·P2·P5가 한 덩어리(`transport_lost`)로 합쳐졌을 가능성이 있는 범주다(원인은 확정하지 않는다). Java는 P1/P2/P5/P8을 서로 다른 `ExecutionErrorCode`·`RemoteOutcome`로 내고, 시각 기록(3.4절)으로 어느 단계에서 얼마 만에 끝났는지 남긴다.

### 3.3 취소와 채널 닫기 순서 [제안]
1. `CancelToken`이 서면 상태를 `STOPPING`, reason `CANCEL`로 바꾼다(이미 `STOPPING`이면 무시, 마감과 겹치면 먼저 선 쪽의 reason을 유지).
2. 채널이 아직 없으면(P0~P2) 열지 않고 `notDispatched`로 정산한다.
3. 채널이 열려 있고 exec 요청을 썼으면: **SSH `signal` 요청 INT → (유예 1/3) TERM → (2/3) KILL**을 보낸다. MINA 2.20.1 클라이언트에는 이 요청을 보내는 공개 메서드가 없다(0.3절 1). 선택지는 (a) `Session.createBuffer(SSH_MSG_CHANNEL_REQUEST)`로 `signal` 요청 패킷을 직접 쓰는 것(wantReply 거짓, 프로토콜 계층), (b) signal 없이 채널 닫기만 하는 것이다. 어느 쪽이든 `SignalDelivery`는 `REQUESTED`일 뿐 종료 증거가 아니다(2.x와 같음 `:44-51`). 추천은 (a)+(b) 폴백이고 결정 D3-05다. OpenSSH 서버가 `signal` 요청을 처리하는 판은 `[미확인]`(OpenSSH 릴리스 노트를 이번에 열지 못했다). 처리하지 않는 서버에서는 닫기만 남고 결과는 UNKNOWN이 된다.
4. 유예가 끝나면 `ChannelExec.close(false)`로 우아하게 닫는다(MINA `CHANNEL_CLOSE_TIMEOUT` 기본 5초, 시간이 지나면 즉시 닫음. `official-docs-platform.md` Q1). 닫기는 「이 채널을 버림」이며 종료 증거가 아니다.
5. 정산 후 세션은 유지한다(풀에 돌려준다). 세션 자체가 죽었으면 3.5절 규칙으로 버린다.
6. 취소·마감 타이머는 `TaskScheduler`(Boot가 만드는 `ThreadPoolTaskScheduler` 빈)로 걸고, 채널 이벤트는 `ChannelListener`·`CompletableFuture`로 받는다. `new Thread`·직접 `Executors`·`Thread.sleep`을 쓰지 않는다(원칙 2.2 범주 8, A-SLEEP). `ChannelExec.waitFor(mask, timeout)`은 이벤트 대기라 허용이며 `SshSpikeTest.s03`이 같은 방식을 이미 시험했다(`SshSpikeTest.java:207-215`).

### 3.4 출력 상한·redaction·시각 기록 [제안]
- **상한**: 스트림마다 `DataSize outputPerStream`(기본 1MiB). 넘는 바이트는 버리되 「수신 바이트」는 센다(`StreamCapture`: received/retained/cursor/truncated, 2.x `:29-31`). 두 스트림이 따로 센다.
- **backpressure**: MINA 클라이언트 채널은 `setOut(OutputStream)`(MINA 스레드가 직접 씀)과 `getInvertedOut()`(호출자가 끌어 읽음)이 있다(`official-docs-platform.md` Q1). 전자는 느린 sink가 MINA IO 스레드를 막을 수 있으므로 **`getInvertedOut()`/`getInvertedErr()`를 `OutputPump`가 읽어 `OutputSink`로 넘긴다.** sink가 `Failed`를 돌려주면 이후 바이트는 읽어서 버리기만 한다. 이렇게 하면 D-0040(「영속 sink가 readable을 pause로 남김」)의 Java판 동치 상태가 없다(`pause` 개념이 없다). 이 가정(역방향 스트림의 윈도 반환 동작)은 `[미확인]`이고 시험 S3-EX-05가 확인한다.
- **redaction 연결**: `OutputSink` 구현(portal-app 유스케이스)은 **원 바이트를 `OutputPayloadStore.append`(비공개 스풀 `.stream`)에 쓴다.** 공개 렌더링(`finish(json, text)`)을 만들 때 전체 텍스트에 `OutputRedactor`(`VendorOutputRedactor`)를 한 번 적용한다. 이유: 2.x가 「chunk-local redaction cannot protect split secret records」로 명시했다(`src/adapters/storage/command-output.mjs:205-206`)와 「Public pages retain the existing whole-result redaction」(`src/application/operations.mjs:75`). 어댑터(`portal-ssh`)는 redaction을 모른다(관심사 분리). 문자셋은 `StandardCharsets.UTF_8` 명시이고, 잘린 UTF-8 경계는 바이트를 보존한 채 렌더링 단계에서 한 번에 해독한다(Z2, 시험 S3-EX-13).
- **시각 기록(D-0038)**: `ExecutionTimeline`(2.2절)을 모든 `ExecutionReport`가 싣는다. 이미 저장되는 것: 작업 행의 `created_at`·`ready_at`·`started_at`(claim 시각)·`finished_at`과 이벤트 표의 `occurred_at`(`V1__operation_journal.sql:29-35, 64`). 빠진 것: 연결 시작·연결 완료·exec 요청·첫 출력·종료 관측 시각. 결정 D3-04: (a) 구조화 로그만, (b) `operation_result`에 nullable `TIMESTAMP(6)` 열 3개(`exec_connected_at`, `exec_dispatched_at`, `exec_closed_at`)를 더하는 Flyway `common/V7`, (c) 별도 표. 추천 (b).
- **자동 재전송 금지**: 어댑터에는 재시도 경로가 없다. 유스케이스는 같은 `operationKey`의 재호출을 `Operation`의 상태(저널)로 막는다(2.x `automaticReplay` 상수 거짓). 시험 S3-EX-09가 「exec 요청이 서버에 도착한 횟수」를 세어 어떤 실패 뒤에도 1회임을 고정한다.

### 3.5 세션 수명 [제안] (D-0038)
2.x 사실: vendor 연결은 `isConnected()`가 `connected && client !== null`일 뿐이라 `close` 이벤트가 오기 전에는 죽은 연결도 돌려준다(vendor 규칙 CR-01·CR-29). 끊김 감지는 소켓 close/end나 keepalive 실패(15초 × 3)에 의존한다(CR-11). 채널 열기는 3회 재시도하고 실패마다 150·300ms를 기다린다(CR-14, `channel-retry.js:1, 10`). 2.x가 그 위에 얹은 「퇴역」은 채널 열기가 같은 클라이언트에서 3번 거절되면 표시해 두었다가 다음 요청에서 닫고 새로 얻는 방식이다(`src/adapters/ssh/connection-lifecycle.mjs:5, 136-138`). vendor 문서는 0.07초가 이 재시도 대기(최소 450ms)로는 설명되지 않는다고 적었고 원인은 미확인이다(vendor U-05). 그래서 Java는 원인을 가정하지 않고 아래 범주를 구조로 막는다.

`SshSessionPool`(`@Component`, 상태는 이 빈이 가진 `ConcurrentHashMap<ProfileAlias, Slot>` 하나. 싱글턴 가변 필드 금지 규칙에 따라 상태는 이 전용 객체에만 두고 다른 빈은 메서드로만 접근한다):
1. **획득(`acquire(alias)`)** — 세션을 얻는 이 한 곳에서만 재연결한다. 순서: 슬롯 없음 → 연결. 슬롯이 `Live`이면 `isOpen()` 확인. 유휴가 `probeAfter`(기본 10초) 이상이면 능동 확인을 한다(전역 요청 `keepalive@openssh.com` wantReply, 짧은 시간 한도. API 이름은 `[미확인]`, 시범 P3-2) — 실패하면 그 세션을 닫고 새로 연결한다. 이것이 「죽은 세션 사전 감지」다.
2. **1회 재연결의 정의**: 재연결은 「명령을 보내기 전에」 세션 획득 단계에서만 한다. 사전 확인이 죽음을 알려 주면 새 연결 1회를 시도하고, 그 연결이 실패하면 `SSH_CONNECT_FAILED`(`NOT_STARTED`)로 끝낸다. **명령을 보낸 뒤 세션이 죽으면 재연결하지 않는다**(P5·P8: UNKNOWN). 다음 요청이 새 세션을 얻는다.
3. **동시 호출 합치기**: 연결 중인 슬롯에는 같은 `CompletableFuture`를 돌려준다(CR-02). 연결이 실패하면 슬롯을 지운다(CR-04). 실패한 `Future`를 프로세스 수명 동안 재생하는 결함(vendor #197, CR-28)을 막는 시험을 둔다(S3-SS-02).
4. **채널 열기**: 채널 열기 거절은 세션을 죽은 것으로 보지 않는다(P2). 2.x의 「3회 재시도」와 「퇴역」은 옮기지 않는다 — 손 재시도 루프 금지(원칙 2.2 범주 8)이고, 거절은 `SSH_CHANNEL_OPEN_FAILED`로 사용자에게 돌려 주는 것이 단순하다. 같은 세션에서 연속 `N`번 거절이면 그 세션을 사용 중 채널이 없을 때 닫는 정책만 둔다(`N` 기본 3, 결정 D3-08). 이 부분은 2.x 시험 B-474~B-477이 정한 동작(「열기 시도 3회」)과 달라지므로 사례 기대를 「열기 시도 1회, 거절은 코드로 돌려줌」으로 다시 쓴다(`regression-cases.md` 0.1: 이식 전 원 시험을 다시 읽고 확정).
5. **채널 동시 수**: 세션마다 `Semaphore`(`ChannelPermits`, 기본 8)로 제한한다. OpenSSH 서버의 `MaxSessions` 기본 10(OpenSSH 공식 `sshd_config`, `[미확인]` 이번에 열지 않음)을 넘기지 않기 위해서다. 한도가 차면 대기하지 않고 `RequestRefusedException(EXECUTION_QUEUE_FULL)`이 아니라 `Saturated`(스케줄러가 claim 전에 막는 것이 정상). 어댑터에서 허가를 못 얻는 경우는 프로그래밍 오류 수준이므로 `ExecutionFailedException`(`SSH_CHANNEL_OPEN_FAILED`)로 둔다.
6. **heartbeat**: `CoreModuleProperties.HEARTBEAT_INTERVAL`을 15초로 켠다(2.x keepalive 15초와 같음, CR-11). 응답 없는 횟수 상한은 `HEARTBEAT_NO_REPLY_MAX`(2.13+, `official-docs-platform.md` Q1)로 3. 세션 닫힘은 `SessionListener.sessionClosed`로 받아 슬롯을 비운다. 이 조합의 감지 지연은 문서에 없다(`[미확인]`, 시험 S3-SS-06이 임베디드 서버에서 잰다).
7. **세 코드의 분리(D-0038)**: 연결 실패 = `SSH_CONNECT_FAILED`(stage `SSH_CONNECT`, `NOT_STARTED`), 대기열 포화 = 스케줄러의 `ClaimResult.Saturated(SaturationReason)`와 `OperationErrorCode.OPERATION_QUEUE_FULL`/`CapacityErrorCode.EXECUTION_QUEUE_FULL`(SSH를 시도하지 않음), transport 실패 = `transportLost`(P5·P8). 이 셋이 서로 다른 값임을 S3-SS-03이 표로 고정한다.
8. **대상 변경 보호**: `ConnectionProfile`은 불변 record이므로(S2 4.5절) 요청 시작 시 스냅샷을 쥐고 디스패치 직전에 `ProfileSource.lookup`이 같은 값(`equals`)을 돌려주는지 확인한다. 다르면 `DispatchRefusedException(target_changed, target_guard)`(2.x `vendor.mjs:53`, vendor CR-34).

### 3.6 호스트 키·ProxyJump·프로필·자격 증명 [제안]
- **호스트 키(TOFU)**: `[사실]` MINA의 기본 검증기는 모든 키를 받는다(`official-docs-platform.md` Q1). `[사실]` 1단계 시범이 `DefaultKnownHostsServerKeyVerifier(AcceptAllServerKeyVerifier.INSTANCE, true, knownHosts)`로 「첫 키는 기록하고 같은 키는 다시 받아들이며(s07), 바뀐 키는 거절하고 기록은 그대로 둔다(s08)」를 시험했다(`SshSpikeTest.java:263-296`). `ServerKeyPolicy`는 모드(`tofu`·`strict`·`insecure`, 2.x `BRIDGE_HOST_KEY_MODE`, CR-23)와 핀(`trustedHostKey`, CR-19)을 합성한다: 핀이 있으면 핀이 우선하고(`PinnedFingerprintVerifier`, 지문은 `SHA256:` + base64 패딩 제거, CR-18), 없으면 모드를 따른다. **2.x는 호스트 키를 프로세스 메모리에만 두어 재시작하면 다시 신뢰했다(vendor 5.3절).** Java는 `known_hosts` 파일에 남긴다(행동 강화이며 업그레이드 안내에 적는다). 파일 위치는 설정값이고 `PrivateStorage` 규칙(S2 13.6 Windows 보호)을 따른다. `insecure`는 호환을 위해 남기되 시작 로그에 경고를 남긴다(결정 D3-10).
- **고정 알고리즘**: 2.x는 kex·cipher·hostkey·hmac 목록을 고정했다(CR-24~27, `algorithms.js:3-31`). Java는 `SshAlgorithmPolicy`가 MINA 팩토리를 같은 이름 순서로 고르되, MINA 2.20.1이 `curve25519-sha256`·`chacha20-poly1305@openssh.com`을 지원하는지는 `[미확인]`이다(시범 P3-3). 지원하지 않는 이름은 목록에서 빠지며 그 사실을 시작 로그와 문서에 적는다.
- **ProxyJump**: MINA는 2.6.0부터 `HostConfigEntry`의 ProxyJump를 따르고 체인은 2.13.0 뒤 지원하며 `MAX_PROXY_JUMPS` 기본 10이다(`official-docs-platform.md` Q1). 그러나 점프 호스트마다 다른 자격 증명·호스트 키 핀을 어떻게 줄지는 문서에 없다(`[미확인]`). 시범 P3-5: (a) `HostConfigEntry.proxyJump` 체인에 프로필별 자격 증명을 주는 방법, (b) 점프 세션 위에 `createDirectTcpipChannel`로 대상까지 채널을 만들어 그 위로 두 번째 세션을 얹는 방법. 2.x 동작(vendor CR-03·CR-05): 점프 프로필의 연결이 죽으면 객체를 버리고 새로 만든다. 실패 문장은 `ProxyJump via "<alias>" failed`.
- **프로필 TOML**: vendor 문서 3절(PF-01~PF-28)이 입력이다. 2.x는 `BRIDGE_CONFIG_PATH`만 쓰고(`~`·환경 변수 확장 없음, PF-02), POSIX에서는 그룹·기타 권한이 있으면 거절하며(PF-04), Windows에서는 외부 프로그램 `icacls.exe`로 DACL을 읽어 판정한다(PF-05). **Java는 `icacls`를 실행하지 않는다.** `AclFileAttributeView`가 이미 있다(S2 13.6의 `AclPrivateStorage`가 같은 방식으로 소유자 전용 ACL을 검사한다). 파싱은 Jackson TOML(손 파서 금지, 원칙 2.2 범주 13), 검증은 Jakarta Validation record(범주 9). 알 수 없는 키·필수·타입·병합·선택 규칙(PF-07~PF-28)은 vendor 사례 VR-319~374(56건)가 정본이다(8.3절).
- **자격 증명(`SSH_MCP_*`)**: vendor 문서 4절(EV-01~EV-13). 출처는 프로필 접두(`SSH_MCP_<이름 대문자·비영숫자는 _>`)의 `_PASSWORD`·`_PASSPHRASE`·`_KEY`·`_CERT`와 전역 `SSH_MCP_PASSWORD`·`_PASSPHRASE`·`_KEY`, 프로필 `keyRef`이다. 2.x는 `BRIDGE_SECRET_ENV_FILE`의 `SSH_MCP_[A-Z0-9_]+` 항목을 받아 `process.env`에 복사했다(`src/adapters/config/secrets.mjs:10`, `vendor.mjs:177`). Java는 `process.env` 대신 Spring `Environment`에서 읽는다(`System.getenv` 금지). 같은 이름을 그대로 유지하는 것이 업그레이드 안내를 줄인다(결정 D3-09). `sudoPassword`는 2.x가 쓰지 않으므로 옮기지 않는다(EV-03). 키체인은 미지원 결과로 돌려준다.
- `[사실]` 프로필 이름 충돌(`a-b`와 `a_b`가 같은 접두로 충돌, EV-01)은 2.x 사실이다. Java는 이 충돌을 로드 시 검사해 거절한다(보수적 강화, 사례 VR 기대와 어긋나면 사례를 고치지 않고 보고).

---

## 4. SFTP 파일 작업

### 4.1 동작 목록 [제안]
| 동작 | 2.x | 3.0 |
|---|---|---|
| 업로드(게시) | helper로 스테이징(`.part`)에 SFTP로 올린 뒤 `publish` 호출로 원자 교체(`transfers.mjs:151-153`) | 대상 디렉터리에 임시 이름으로 올리고 검증한 뒤 교체(4.2절). 원격 스테이징 폴더·helper가 없다 |
| 다운로드 | `snapshot`으로 스테이징에 복사한 뒤 SFTP로 받음(`:192-194`) | 읽기 전용: 대상을 `stat`하고 직접 읽어 로컬 artifact로 쓴다. 원격에 임시 파일을 만들지 않는다 |
| copy·move | staged 파일에 대한 동작(0.3절 5): 업로드(게시)를 만들고, `move`는 게시 확인 뒤 소비 | 같다. SFTP 쓰기는 업로드 하나다. `move`의 소비는 `ConsumeReason.MOVED` |
| remove | staged 바이트 삭제만 | 원격 SSH 없음. `ArtifactPayloadStore.delete` |
| 권한 지정 | Linux 새 파일 0600, overwrite는 기존 모드 유지(`file-helper.py:126, 181`) | `PermissionResult`(4.6절) |
| 정리 | helper `cleanup` | 임시 이름 파일 삭제. 불가하면 `CleanupState.INCOMPLETE`(= UNKNOWN, 2.x와 같은 보수) |

### 4.2 원자적 교체 [사실 + 제안] (D-0035)
- `[사실]` 계획·`official-docs-platform.md`: OpenSSH(Win32 포크 포함) `sftp-server`는 `posix-rename@openssh.com`을 광고·처리하고, 일반 rename은 대상이 있으면 `SSH2_FX_FAILURE`다. MINA 클라이언트 쪽 확장 `OpenSSHPosixRenameExtension.posixRename(old, new)`가 있다(MINA docs/sftp.md).
- `[사실]` **`rename(old, new, CopyMode...)`는 SFTP 3·4에서 옵션이 있으면 `UnsupportedOperationException`**(0.3절 3, `AbstractSftpClient`). 따라서 어댑터는 이 오버로드를 쓰지 않는다(A-NO-UOE가 이 클래스에서 시험 근거로 작동한다). 서버가 확장을 광고하는지는 `sftp.getServerExtensions()`(`NavigableMap<String, byte[]>`)로 읽는다(`SshSpikeTest.java:255`가 MINA 서버에서 이미 읽는다).
- `[제안]` `AtomicReplacer`의 교체 방법은 sealed `ReplaceMethod`: `PosixRename`(확장 광고됨), `BackupSwap`(광고 안 됨), `NoClobberRename`(덮어쓰기 금지 게시). 순서:

```
공통 사전: 부모 확인(PARENT_NOT_FOUND) → 대상 lstat → 종류·크기·덮어쓰기 정책 판정
1 임시 이름 `.ssh-approval-<24바이트 hex>.part`을 대상 디렉터리에 OpenMode.Create|Exclusive|Write로 만든다 (모드 0600: setStat/attrs)
2 바이트를 흘리며 SHA-256·크기를 센다(선언된 크기·상한 초과 → FILE_TOO_LARGE, 임시 삭제)
3 (기본) 임시 파일을 다시 읽어 SHA-256을 대조한다(2.x helper가 대상 쪽에서 한 번 더 해시한 것과 같은 의미) — 결정 D3-11
4 덮어쓰기 금지: 일반 rename(temp→target)만 시도. 대상이 있으면 서버가 FAILURE로 거절 → DESTINATION_EXISTS (OpenSSH 서버의 일반 rename은 대상이 있으면 실패하므로 원자적이다)
5 덮어쓰기 허용 + PosixRename: 교체 직전 대상 stat이 1단계의 stat과 같은지 비교(다르면 FILE_CHANGED, 임시 삭제) → posixRename(temp, target)
6 덮어쓰기 허용 + BackupSwap(확장 없음): 
   6a 대상 → `.ssh-approval-bak-<hex>` 로 rename   (대상이 없는 순간 이후 모든 실패는 복원 대상)
   6b 임시 → 대상 rename
   6c 성공하면 백업 삭제(삭제 실패는 CleanupState.INCOMPLETE, 결과는 Published이나 texts에 경고)
   6d 6b 실패 → 백업을 대상으로 되돌리는 rename. 되돌림 성공 → RolledBack(원본 복원 확정). 되돌림 실패/단절 → Unconfirmed(UNKNOWN, requiresReconciliation)
7 교체 뒤 확정 단계: 대상 stat(크기)·필요 시 해시 재확인 → Published(confirmedAt = 이 시각) → 여기서만 CompletionEvidence.FilePublished를 만든다
8 확정 뒤 단계(부모 fsync@openssh.com 등 내구화)를 시도했는데 실패하면 Unconfirmed(UNKNOWN)다. 2.x도 이 경우를 OPERATION_FAILED(결과 불명)로 쳤다(`file-helper.py:215-218`, B-818). 확장이 광고되지 않아 시도하지 않은 경우는 Published이고, 내구성 미확정을 진단에 남긴다. 판정은 11절 D3-15다.
```
- `[제안]` **8번의 결정 근거와 열린 점**: 2.x는 「게시 이후의 실패는 권한 오류여도 OPERATION_FAILED(결과 불명)」이라고 했다(`:215-218`, 사례 B-818). 이는 「게시 뒤 실패를 성공으로 쓰지 않는 보수」다. Java에서 교체가 확정(7번의 대조 통과)된 뒤 내구화(`fsync@openssh.com`)만 실패하면 「성공으로 기록하되 내구성 미확정을 진단」이 맞는지, 2.x처럼 UNKNOWN인지가 갈린다. 추천은 후자(2.x와 같은 보수)이고 시험 S3-SF-05가 그 기대를 쓴다(결정 D3-15). 사례 B-818의 기대(`OPERATION_FAILED`, 대상은 게시된 채 유지, 임시 없음)와 일치한다.
- `[제안]` **완료 기록은 교체 확정 뒤에만**: `UploadResult.Published`만 `CompletionEvidence.FilePublished`를 만들고, `Operation.settle`은 확정 증거가 없는 정상 종료를 COMPLETED로 만들지 못하며 UNKNOWN으로 돌린다(`ExecutionOutcome.verdict()` 마지막 줄, `CompletionEvidence.java:40`의 Javadoc 「A failure after the replacement is rolled back to the original and is a failure, not this evidence」). 그래서 D-0035(「교체 후 실패에도 completed 잔류」)가 구조로 막힌다. 저널은 증거가 올 때 한 번만 쓰이므로 「교체됨 → 실패 → 복원」 사이에 `completed`를 쓸 경로가 없다. 잔류 가능성은 두 곳뿐이다: (i) `Published` 결과를 받은 뒤 저널 커밋이 실패하는 경우(작업은 UNKNOWN으로 남고 재시작 복구가 `OPERATION_OUTCOME_PERSISTENCE_FAILED`로 소유자 대조를 요구한다. 시험 S3-SF-05), (ii) 에이전트 CLI 설치의 영수증(6.2절).

### 4.3 경로 검사와 TOCTOU [사실 + 제안]
- `[사실]` 2.x Linux helper는 `/`부터 컴포넌트마다 `O_NOFOLLOW|O_DIRECTORY`로 열고 부모 fd를 쥐어(`file-helper.py:40-47`) 이후 모든 leaf 동작을 그 fd 기준(`dir_fd=parent`)으로 했다(검사와 사용 사이의 경합 방지). Windows helper는 부모 핸들 기준 leaf I/O(`windows-file-native.cs` `OpenLeaf`, `PinTrustedDirectory`)였다.
- `[사실]` SFTP 프로토콜에는 부모 디렉터리 핸들 기준 상대 열기가 없다(feature-map `windows-file-native.cs` 행이 이미 적었다). 따라서 같은 강도를 줄 수 없다.
- `[제안]` 대체 통제와 남는 위험(보안 감사 범위에 넣는다):
  1. 경로 문법은 `PosixRemotePath`·`WindowsRemotePath`(S2 4.3절, 구현됨)가 거른다(`..`·`.`·제어 문자·예약 이름·4096자).
  2. 부모와 leaf를 `canonicalPath`(realpath)로 풀어 요청 경로와 같은 컴포넌트 열인지 확인한다(심볼릭 링크를 따라가면 `UNSAFE_PATH`). leaf는 `lstat`로 종류(일반 파일)를 확인한다(링크·디렉터리·FIFO는 거절. 사례 B-812·B-815·B-819).
  3. 교체 직전에 대상을 다시 `lstat`해 처음 본 값(크기·수정 시각·권한·종류)과 같은지 비교한다(`FILE_CHANGED`). 2.x가 쓰던 inode·ctime은 SFTP 속성에 없다 → 비교가 약해진다.
  4. 다운로드: 읽기 전후 `stat`을 비교하고(크기·mtime), 읽은 바이트 수가 첫 `stat`의 크기와 같은지 확인한다(2.x `file-helper.py:71-72, 128-129`의 identity 대조보다 약함).
  5. 임시 파일은 예측할 수 없는 이름 + `Create|Exclusive`로 만들어 남의 파일을 덮지 않는다.
  - **남는 위험**: 2번의 검사 뒤 3번의 재확인 사이에 공격자(같은 대상에 쓰기 권한을 가진 주체)가 컴포넌트를 심볼릭 링크로 바꾸는 경합. SFTP 서버는 로그인 계정 권한으로 동작하므로, 공격자가 그 계정과 같은 권한을 이미 가졌다면 이 경합으로 얻는 것이 없고, 다른 주체라면 디렉터리 쓰기 권한이 필요하다. 이 판단과 한계를 `docs/`에 적고 보안 감사(8단계 `software-security-auditor`) 범위에 넣는다. 사례 B-908(D-0003 확정)의 기대는 이 대체 통제 기준으로 다시 정한다(`regression-cases.md` 3.3 4항 지시).

### 4.4 2.x helper 검사의 이전 표 [사실 + 제안]
`MINA SFTP`는 SFTP 프로토콜 동작, `고정 원격 명령`은 대상에서 실행하는 읽기 전용 문장, `Java`는 서버 쪽 계산이다. 「불가」는 Java로 옮길 수 없는 검사이고 이유를 적었다.

| # | 2.x 검사 | 근거 | 3.0 위치 | 비고 |
|---|---|---|---|---|
| 1 | 요청 JSON 16KiB 상한·필드 형식(48 hex id, action, maxBytes ≤ 64MiB) | `file-helper.py:93-103, 232-234` | Java(record·Jakarta Validation) | 원격 JSON이 없어짐 |
| 2 | 경로 문법(절대·`/` 단독 금지·4096·앞뒤 공백·제어 문자·`.`/`..`) | `file-helper.py:33-39` | Java `PosixRemotePath` | S2 구현 |
| 3 | 컴포넌트별 `O_NOFOLLOW` 부모 fd 결속 | `file-helper.py:40-47` | 대체 통제(4.3절) | **같은 강도 불가**: SFTP에 부모 핸들 상대 열기가 없다 |
| 4 | 일반 파일만(`S_ISREG`, FIFO·디렉터리 거절) | `file-helper.py:52-56` | MINA SFTP(`lstat` 종류) | 사례 B-819 |
| 5 | 스테이징 루트 소유자·모드(`mcpops`, `0o077`) | `file-helper.py:58-69` | **소멸** | 원격 스테이징 루트가 없다. 임시 파일은 대상 디렉터리에 둔다(`STAGING_UNAVAILABLE`의 뜻이 바뀜, 4.5절) |
| 6 | 크기 상한 64MiB·`FILE_TOO_LARGE` | `file-helper.py:15, 82-83, 124-125`, `windows-file-native.cs:449, 523` | Java(선언 크기 + 흐른 바이트 계수) | 양방향 |
| 7 | 읽는 동안 파일 변경 감지(dev·ino·size·mtime·ctime) → `FILE_CHANGED` | `file-helper.py:71-72, 128-129` | MINA SFTP `stat` 전후 비교 | ino·ctime 없어 **약함** |
| 8 | 교체 직전 대상 재stat 비교 | `file-helper.py:183-193` | MINA SFTP `lstat` | 같은 의미, 속성 부족 |
| 9 | 게시 파일 크기·해시 대조(스테이징에서 대상 쪽으로 복사하며 계산) | `file-helper.py:171-176` | Java(전송 중 계산) + 임시 파일 재읽기 해시(결정 D3-11) | |
| 10 | 새 파일 `0600`, 덮어쓰기는 기존 모드 유지 | `file-helper.py:126, 133, 173, 181` | MINA SFTP `setStat`(Linux) | Windows 불가(4.6절) |
| 11 | 덮어쓰기 시 소유자·그룹·xattr 보존 | `file-helper.py:177-180` | **불가**(일반 사용자) | SFTP `setStat`의 uid/gid 변경은 root가 필요. 일반 로그인 계정에서는 교체 뒤 소유자가 그 계정이 된다. 승격 경로(6.1절)에서만 가능성이 있다. 릴리스 노트의 「동작 변경」으로 적는다 |
| 12 | 원자 교체 `os.replace`, 덮어쓰기 금지는 `link`+`unlink` | `file-helper.py:194-203` | MINA SFTP(`posix-rename@openssh.com` 또는 일반 rename·백업 방식, 4.2절) | |
| 13 | 상위 디렉터리 `fsync` | `file-helper.py:205` | MINA SFTP 확장 `fsync@openssh.com`(광고될 때만, 선택) | 미광고 시 내구성 미확정을 진단에 적는다 |
| 14 | 게시 뒤 실패는 결과 불명(`OPERATION_FAILED`) | `file-helper.py:215-218` | Java 상태 기계(4.2절 8번) | D-0035 |
| 15 | errno → 코드(`ENOENT`→missing, `EACCES/EPERM`→`PERMISSION_DENIED`, `ELOOP/ENOTDIR`→`UNSAFE_PATH`, 그 외 `OPERATION_FAILED`) | `file-helper.py:27-30` | MINA `SftpException.getStatus()` 변환 `SftpFailureClassifier`(4.5절) | |
| 16 | 허용 루트 `PATH_OUTSIDE_ALLOWED_ROOT`, TEST 우회 `bypassRoot` | `windows-file-native.cs:496-498`, `transfers.mjs:91, 119-130` | Java `FilePathPolicy` 포트 + `WindowsRemotePath` 포함 판정(대소문자 무시) | `PATH_POLICY_UNSUPPORTED`는 정책을 확정하지 못할 때(`Unconfirmed`) 낸다. 2.x의 「구형 helper가 `policy` 동작을 모름」은 사라진다 |
| 17 | Windows 경로 문법(드라이브 필수·예약 이름·`<>:"|?*`·끝 공백/점) | `windows-file-native.cs:143-152` | Java `WindowsRemotePath` | S2 구현 |
| 18 | NTFS만 허용 | `windows-file-native.cs:182` | **불가** | SFTP로 볼륨 파일 시스템 종류를 알 수 없다. 검사를 두지 않는다 |
| 19 | 리파스 포인트·하드링크 수 1·파일 종류(`Inspect`) | `windows-file-native.cs:172` | MINA SFTP `lstat`(링크 여부는 서버가 보고하는 만큼) | Win32-OpenSSH가 리파스 포인트를 어떻게 보고하는지 `[미확인]`(시험 S3-RW-04). 하드링크 수는 SFTP 속성에 없어 **불가** |
| 20 | 소유자 신뢰·DACL 존재·ACE·상위 경로·쓰기 허용 주체·보안 기술자 크기(`UNTRUSTED_OWNER`·`MISSING_DACL`·`UNSAFE_ANCESTOR`·`UNTRUSTED_WRITER`·`UNSUPPORTED_ACE`·`SECURITY_DESCRIPTOR_TOO_LARGE`) | `windows-file-native.cs:308-345`, `windows-file-helper.ps1:46-54` | **결정 D3-02**: (a) 옮기지 않음 (b) 고정 PowerShell 읽기 전용 조회가 판정 JSON을 돌려줌 (c) Java가 보안 기술자 바이너리를 해석 | 아래 설명 |
| 21 | 설치 SID·계정 SID 일치(`config.accountSid`) | `windows-file-helper.ps1:46-49` | **소멸** | 설치할 helper가 없다 |
| 22 | 관리자 승격 확인(`RequireAdministrator`) | `windows-file-helper.ps1:52`, `windows-file-native.cs:130-135` | 고정 원격 명령(Q8, 6.1절) | |
| 23 | overwrite 시 DACL·소유자·시각·필수 무결성 레이블 보존 | `windows-file-native.cs:372-436` | **불가** | SFTP 교체는 임시 파일의 속성을 가진다. 시각은 `setStat`으로 맞출 수 있는지 `[미확인]`, DACL·레이블은 SFTP 속성에 없다. 사례 B-914·B-916·B-917은 삭제 표로 옮기자고 제안한다(8.2절) |
| 24 | 새 파일의 비공개 DACL(상속 차단·허용 주체 3개) | `windows-file-native.cs:155-168` | **불가** | SFTP는 ACL을 설정하지 못한다. 사례 B-902 같은 이유 |
| 25 | 임시 파일 정리(자기 stage만, 링크면 `UNSAFE_PATH`) | `file-helper.py:107-115`, 사례 B-922·B-923 | MINA SFTP(`lstat` 후 `remove`) | |

- `[제안]` 20번에 대한 판단(결정 D3-02의 설명): 2.x Linux helper는 소유자·ACL 신뢰 검사가 없었고(`file-helper.py` 전체에 소유자 대조가 스테이징 루트뿐, `:58-69`), Windows helper가 훨씬 강했다. 그 신뢰 검사는 helper가 **SYSTEM이 설치한 스테이징·설치 루트**를 가졌기 때문에 필요했다(다른 로컬 사용자가 그 폴더에 파일을 심는 위협). 3.0에는 그 루트가 없고 SFTP는 로그인 계정 권한으로 동작하므로 OS 권한이 1차 통제가 된다. 또 이 검사가 거짓 거절을 낸 사례가 결함이다(D-0001: GUI가 만든 파일을 `UNTRUSTED_OWNER`로 거절, VERIFIED). 그래서 추천은 (a) 「3단계는 옮기지 않고, 여섯 코드는 3.0에서 발생하지 않는다고 문서화, 값은 enum에 남겨 계약 호환 유지」다. 단 이것은 보안 판단이므로 메인 결정이다. (b)를 고르면 고정 PowerShell 문장은 대상에서 실행되는 읽기 전용 질의이고, 결과는 record로 받는다(손 파서 금지). (c)는 Java에 Windows 보안 기술자 파서가 없어(JDK 표준 API 부재, `AclFileAttributeView`는 로컬 파일에만 동작) 손 구현이 되므로 추천하지 않는다.

### 4.5 `TransferErrorCode` 18개의 3.0 발생 조건 [제안]
값은 `domain.error.TransferErrorCode`에 이미 있다(`INSTALL_FAILED, PARENT_NOT_FOUND, FILE_NOT_FOUND, PERMISSION_DENIED, DESTINATION_EXISTS, UNSAFE_PATH, PATH_OUTSIDE_ALLOWED_ROOT, PATH_POLICY_UNSUPPORTED, STAGING_UNAVAILABLE, FILE_CHANGED, INVALID_REQUEST, UNTRUSTED_OWNER, MISSING_DACL, UNSAFE_ANCESTOR, UNTRUSTED_WRITER, UNSUPPORTED_ACE, SECURITY_DESCRIPTOR_TOO_LARGE, WINDOWS_COMMAND_TOO_LARGE`). `FILE_TOO_LARGE`는 `ArtifactErrorCode`, `OPERATION_FAILED`·`SSH_*`는 `ExecutionErrorCode`에 있다.

| 코드 | 3.0에서 내는 조건 |
|---|---|
| `INSTALL_FAILED` | 에이전트 CLI 설치 중 확정 실패(6.2절) |
| `PARENT_NOT_FOUND` | 부모 디렉터리 `stat`이 `SSH_FX_NO_SUCH_FILE`(2) |
| `FILE_NOT_FOUND` | 다운로드 대상 `stat`/`open`이 `SSH_FX_NO_SUCH_FILE`(2) |
| `PERMISSION_DENIED` | `SftpException.getStatus() == 3`(`SSH_FX_PERMISSION_DENIED`). **transport 오류·디스크 부족과 섞지 않는다**(D-0013·D-0034) |
| `DESTINATION_EXISTS` | 덮어쓰기 금지 게시에서 서버가 rename을 FAILURE로 거절하고 대상이 있을 때, 또는 `SSH_FX_FILE_ALREADY_EXISTS`(11) |
| `UNSAFE_PATH` | 링크·디렉터리·FIFO·realpath 불일치(4.3절 2) |
| `PATH_OUTSIDE_ALLOWED_ROOT` | `FilePathPolicy`가 `Enforce`이고 정규화한 경로가 루트 밖 |
| `PATH_POLICY_UNSUPPORTED` | `FilePathPolicy`가 `Unconfirmed` |
| `STAGING_UNAVAILABLE` | 의미 변경: 「대상 디렉터리에 임시 파일을 만들 수 없음(권한이 아닌 사유)」. 상태 코드 4(FAILURE)이고 `statvfs@openssh.com`이 가능하면 공간 부족을 진단에 적는다 |
| `FILE_CHANGED` | 4.3절 3·4, 해시·크기 대조 실패 |
| `INVALID_REQUEST` | 잘못된 입력(Java 검증을 통과한 뒤에는 거의 없다) |
| 소유자·DACL 계열 6개 | **결정 D3-02 (a)이면 발생하지 않음** |
| `WINDOWS_COMMAND_TOO_LARGE` | PowerShell 래핑 결과가 8000자 초과(2.3절) |

`SftpException.getStatus()` 값(MINA 2.20.1 `SftpConstants`, 인용: `official-docs-platform.md` Q1): `SSH_FX_NO_SUCH_FILE=2`, `SSH_FX_PERMISSION_DENIED=3`, `SSH_FX_FAILURE=4`, `SSH_FX_NO_CONNECTION=6`, `SSH_FX_CONNECTION_LOST=7`, `SSH_FX_OP_UNSUPPORTED=8`, `SSH_FX_FILE_ALREADY_EXISTS=11`, `SSH_FX_NO_SPACE_ON_FILESYSTEM=14`, `SSH_FX_QUOTA_EXCEEDED=15`. 단 OpenSSH `sftp-server`가 3판에서 어떤 코드를 돌려주는지(예: ENOSPC를 FAILURE로 뭉치는지)는 `[미확인]`이다(실제 OpenSSH 시험 S3-RO-03). 뭉쳐지면 `SSH_FX_FAILURE`일 때 `statvfs@openssh.com`으로 공간을 읽어 구분한다.

### 4.6 Windows chmod는 미지원 결과 [제안]
- `[사실]` Win32-OpenSSH 위키: 「SFTP doesn't support chmod」(`official-docs-platform.md` Q2).
- `[제안]` `TargetPlatform.permissionSupport()`가 sealed `PermissionSupport`를 답한다. `WindowsTargetPlatform`은 `Unsupported(WINDOWS_SFTP_CHMOD)`, `LinuxTargetPlatform`은 `Supported`다. `RemoteFileTransfer.applyPermissions`는 `Unsupported`이면 SFTP를 호출하지 않고 `PermissionResult.Unsupported`를 돌려준다. 호출 쪽(파일 서비스)은 「권한을 명시한 요청」이면 `RequestRefusedException(TARGET_CAPABILITY_UNSUPPORTED)`로 거절하고, 명시하지 않은 기본 게시(Linux의 0600 기본)는 Windows에서 건너뛴다. 조용히 무시하지 않는다. `UnsupportedOperationException`·`Optional.empty`를 쓰지 않는다(LSP, 35항).

### 4.7 elevate와 파일 [제안]
6.1절.

---

## 5. artifact 가져오기·예산 (D-0012)

### 5.1 2.x와 현재 Java [사실]
- 2.x는 예산 거절 하나를 `Staging budget exhausted` → `ARTIFACT_QUOTA`로만 냈다(`src/adapters/storage/artifacts.mjs:224`, `public-contract.mjs:151`). 디스크 부족은 따로 판정하지 않았고, 다운로드 예약이 디스크 여유를 본다는 사실만 확인됐다(S2 1.3절 `command-output.mjs:145-147`). 「1090바이트 업로드 예약이 `ARTIFACT_QUOTA`로 거절됐고 디스크는 86G 여유였다」(D-0012 장부)의 2.x 원인은 미확인이다.
- 현재 Java `JdbcArtifactRegistry.reserve`(`JdbcArtifactRegistry.java:89-99`)는 세 가지를 서로 다른 변형으로 답한다: `FileTooLarge`(파일 크기 한도, `:92-94`), `BudgetExceeded(requested, reservedBytes, budgetBytes)`(`:104-106`), `DiskSpaceInsufficient(requested, usable)`(`:107-109`). 예산은 `artifacts.chargedBytes() + quarantined`(`:103`), 디스크는 `payloads.usable()` 읽기가 트랜잭션 밖이다(`:96-97`). 파일 크기 한도는 예산 판정보다 먼저다.
- `ArtifactReservation`의 변형 정의: `ArtifactReservation.java`(`BudgetExceeded`, `DiskSpaceInsufficient`, `FileTooLarge`).

### 5.2 3단계 설계 [제안]
1. **포트 모양 변경**: `BudgetExceeded(long requestedBytes, ReservedSplit reserved, long budgetBytes)`. `ReservedSplit(long liveBytes, long holdingBytes)`는 현재 합쳐 있는 `charged`와 `quarantined`를 나눠 싣는다(S2 13.6 이월). 이유: 사용자(또는 에이전트)가 「예산이 찬 것이 진행 중 예약 때문인지, 격리 보관분 때문인지」를 구분해야 풀 방법(기다림 대 운영자 정리)이 갈린다. `ArtifactReservation`은 portal-app 소유라 포트 변경이다.
2. **값을 오류에 싣는다**: 예산 거절 → `ARTIFACT_QUOTA`에 `requestedBytes·liveBytes·holdingBytes·budgetBytes`, 디스크 부족 → `ARTIFACT_STORAGE_FULL`에 `requestedBytes·usableBytes`, 파일 한도 → `FILE_TOO_LARGE`에 `limitBytes`. 값은 `RequestRefusedException`의 `ErrorData` record로 싣고 문장은 `MessageSource`(ko·en)다. 이 데이터가 응답 봉투의 `error.data`에 들어가는 모양은 4단계가 정한다(계약의 `additionalProperties:false`와의 호환 확인 필요 `[미확인]`).
3. **판정 순서(고정)**: 파일 크기 한도 → 예산 → 디스크(`usable - 요청 크기 < diskMarginBytes`이면 부족, `JdbcArtifactRegistry.java:107-109`. 여유 여백 `diskMarginBytes`의 기본값·설정 이름은 `ArtifactLimits`가 가지며 거절 값에 함께 싣는다). 시험 S3-AR-01~04가 「예산 0 + 디스크 충분 + 1090B → `Reserved`」「예산 충분 + 디스크 부족 → `DiskSpaceInsufficient`」「예산 부족 + 디스크 충분 → `BudgetExceeded`」를 각각 고정한다(D-0012 계획 시험 「1KB 예약 수락, 예산 초과와 디스크 부족 구분」). 「87G 여유인데 1090B가 거절됨」 범주를 막는 직접 시험은 「디스크 읽기 값을 바꿔 가며 예산 판정이 디스크 값에 영향을 받지 않음」과 「`usable()`이 예외를 던지면 거절이 아니라 `ARTIFACT_STORAGE_IO_ERROR`」다(S3-AR-03).
4. **다운로드 작업 경로**: 예약 거절은 SSH 효과 전이므로 `ExecutionFailure.Classified(stage=OUTPUT_RESERVATION|OPERATION, code, NOT_STARTED)`로 낸다(`ExecutionStage`의 허용 짝 `ExecutionStage.java:16, 18`). 예산 거절은 `ARTIFACT_QUOTA`(허용 짝). 디스크 부족은 `ExecutionErrorCode`에 대응 값이 없다 → 결정 D3-03: (a) `ExecutionErrorCode.ARTIFACT_STORAGE_FULL` 추가 + 허용 짝에 추가(어휘 확장, `envelope.schema.json`의 `x-portal-errorCodes`는 이미 이 이름을 가진다, 릴리스 노트 「새 오류 코드」), (b) `OPERATION_FAILED`+진단으로 둔다(D-0012의 구분이 다운로드 경로에서 빠진다). 추천 (a).
5. **고정 해제와 소비**(1.3절): `submit`이 고정, 종료 상태가 풀기, `beginConsume(id, ConsumeReason)`.
6. **보유분(격리)과 라이브 예약의 합산**은 유지한다(S2 13.6: 같은 디스크를 쓰므로 합산). 단 위 1번으로 값에는 나눠 보인다.
7. **출력 예산**도 같은 모양이다(`OutputManifestStore.reserve`가 `OutputReservation`을 답하고 같은 구분이 필요한지는 이번에 읽지 않았다 `[미확인]`; 구현 D가 같은 변형을 쓰는지 확인).

### 5.3 시험으로 고정(D-0012) [제안]
S3-AR-01~09(8.3절). 핵심: 「예산 거절과 디스크 거절은 다른 변형·다른 코드·다른 값」, 「1090B 예약은 예산에 여유가 있으면 항상 수락」, 「보유분이 예산을 먹어 거절될 때 값이 보유분과 라이브분을 나눠 보인다」.

---

## 6. elevate(Q8)와 에이전트 CLI 설치(Q3)

### 6.1 elevate (Q8) [제안]
- 계획 판정: 계약 필드라 유지한다. Linux 1순위는 exec 채널에서 `sudo -n <sftp-server>`를 띄우고 그 위에 MINA SFTP를 얹는 것, 안 되면 고정 명령 exec(A안). Windows는 고정 원격 명령으로 관리자 여부를 확인하고 아니면 계약의 거절 결과를 돌려준다.
- `[미확인]` 시범으로 확인할 것(시범 P3-4):
  1. MINA 2.20.1 `SftpClient`가 임의 채널(exec 채널의 입출력)을 SFTP 전송 계층으로 받을 수 있는가. 공개 `SftpClientFactory.createSftpClient(session)`은 `sftp` 서브시스템 채널을 연다(공식 docs/sftp.md). 임의 스트림용 생성자·확장 지점이 있는지는 이번에 `DefaultSftpClient` 소스를 열지 않았다.
  2. `sudo -n /usr/lib/openssh/sftp-server`의 경로(Debian 계열 기준, 배포판마다 다름)를 어떻게 정하는가. 후보: `sshd -T`는 root가 필요, 서브시스템 줄 파싱 불가. 후보: 고정 후보 목록을 `test -x`로 확인하는 읽기 전용 고정 명령.
  3. `sudoers`의 NOPASSWD 범위(2.x `--grant-sudo-all`, Q12)가 `sftp-server` 실행을 허용하는가.
  4. 1번이 안 되면 폴백: 고정 명령 exec로 `sudo -n` + stdin/stdout 파일 전송(`cat`/`tee`, 해시는 Java가 계산). 이때 원자 교체는 `sudo -n mv`의 같은 파일 시스템 rename을 쓴다.
- `[제안]` 코드 모양: `ElevationPlan`(2.3절)이 sealed로 방식을 답하고, `MinaRemoteFileTransfer`는 `Elevated` 요청이면 승격 채널 위의 SFTP(성공 시) 또는 폴백 어댑터(`ElevatedExecTransfer`, 같은 포트 구현)를 고른다. 구현을 고르는 것은 `ElevationPlan`이다.
- `[제안]` Windows: 관리자 확인은 읽기 전용 고정 명령(예: 현재 토큰이 Administrators 역할인지 출력) 하나이며 결과를 `ElevationResult.Granted|Denied`로 받는다. 아니면 `RequestRefusedException(…, "Administrator connection token required")`와 같은 계약 문구(사례 B-601: 상승 거부는 `failed==true`, 텍스트에 문구, marker 미생성).

### 6.2 에이전트 CLI 설치 (Q3) [제안]
- 계획 판정: Java가 레지스트리 메타데이터와 tarball을 내려받아 해시(sha512 integrity)를 검증하고 SFTP로 올린다. 원격에서는 최소한의 고정 명령만 exec로 실행한다. 로그인 상태 확인은 SFTP `stat`이다. 공급자는 `codex`·`claude`(`AgentCliProvider` 구현 빈, S2 6.7절).
- 흐름(`AgentCliInstaller`):
  1. (portal-app `AgentCliService`) 계획·의도 digest·만료·대상 revision 결속을 검증한다(S2 `AgentCliIntent`, 구현됨). 승인 뒤 `AgentReleaseCatalog`(4단계 어댑터, 3단계 시험은 가짜)가 tarball 바이트를 준다.
  2. Java가 sha512를 `AgentRelease.integrity`와 비교한다. 불일치 → 원격에 아무것도 보내지 않고 `Refused(PACKAGE_INTEGRITY…)`(사례 B-637).
  3. SFTP로 `<관리 루트>/versions/<버전>-<해시16>.partial/package.tgz`에 올린다.
  4. 고정 원격 명령 목록(`AgentCliPlan`이 가진다): ① 홈·루트 확인(읽기), ② 압축 해제(`tar`), ③ 설치된 바이너리의 버전 질의(읽기 전용, 비신뢰 경로 실행 금지 B-662), ④ `current` 링크 전환(`ln -sfn` 또는 rename). **npm을 대상에서 돌려야 하는지, 대상에 node가 있는지는 `[미확인]`이다**(2.x는 대상의 번들 노드 런타임으로 `npm install`을 했다 `manage-agent-cli.py:265, 690`). `@openai/codex`·`@anthropic-ai/claude-code` 패키지가 플랫폼별 바이너리를 어떻게 싣는지는 이번에 열지 않았다. 시범 P3-6이 「tarball 해제만으로 쓸 수 있는지, 대상에 npm이 필요한지」를 확인한다. npm이 필요하면 설치 범위·환경 정리(사례 B-646~648)가 다시 필요하고 REPLACE 분류(8.2절)가 바뀐다.
  5. **D-0035 순서(영수증이 아니라 증거)**: 2.x helper는 `completed` 영수증을 **전환 뒤**에 쓰고, 그 기록이 실패하면 `failed` 영수증을 쓰고 이전 current로 되돌리는데, 그 `failed` 기록까지 실패하면 `RESULT_UNKNOWN`이었다(`manage-agent-cli.py:735-779`, 사례 B-664~669). 구형 v16 helper에서 「교체·rollback 뒤에도 completed 기록이 남는」 경계가 이 순서에 있었다(장부 원인은 미확인). Java는 원격에 영수증 파일을 두지 않는다: 작업 저널이 유일한 기록이다. 순서는 (a) 전환(rename) → (b) 전환 확정 읽기(`readlink`·바이너리 버전) → (c) `CompletionEvidence.FilePublished`와 같은 확정 증거 → (d) 저널 `COMPLETED`. (b)나 (c)가 실패하면 이전 current로 되돌리고(rename), 되돌림이 확정되면 `RolledBack`(작업 FAILED), 확정되지 않으면 `Unconfirmed`(UNKNOWN). 증거 없이 `completed`를 쓰는 경로가 없다.
  6. `cleanupFailures`: 설치기가 정리(옛 버전 삭제·`.partial` 삭제)를 시도해 센 0 이상의 값이다. 0은 「없음」이다(1.3절).
  7. 상태 질의(`status`): SFTP `stat`·`readlink`와 버전 질의 고정 명령(읽기 전용). 인증 상태는 자격 파일 존재 여부(`stat`)만 본다 — 로그인 여부를 CLI에게 묻지 않는다(2.x는 CLI를 실행해 물었다 `check-agent-cli-login.py`). 그래서 사례 B-673~B-682(로그인 확인 helper 내부)는 대체 시험으로 바뀐다(8.2절 REPLACE).
- `[제안]` 외부 프로그램 이유 문서: 대상에서 실행되는 고정 명령(`tar`, `ln`, 설치된 CLI의 버전 질의)은 「원격 대상 명령 범주(대상에 JVM이 없다)」라서 Java 대체가 불가하다. `docs/external-programs.*`에 목록과 이유를 적는다. 그 목록은 코드(`AgentCliPlan`의 상수 리소스)와 같은 줄 수·내용이어야 한다(시험 S3-AG-10이 대조).
- 시범으로 확인할 점: 위 4번의 npm 필요 여부, 대상별 `tar` 존재, Windows 대상의 압축 해제 수단(`tar.exe`는 Windows 10 1803부터 있으나 이번에 공식 문서로 확인하지 않았다 `[미확인]`; 없으면 PowerShell `Expand-Archive`가 zip만 지원해 tgz에 못 쓴다 `[미확인]`).

---

## 7. 시험 전략

### 7.1 MINA 내장 SSH 서버로 하는 것 [제안]
`SshSpikeTest`가 보여 준 패턴(서버: `CommandFactory`로 가짜 명령, `SftpSubsystemFactory`, 임시 폴더 루트, 비밀번호/키 인증 `SshSpikeTest.java:139-140`)을 공용 `ssh.testkit.EmbeddedSshServer`(시험 소스 세트)로 올린다. 이 PC와 두 CI에서 모두 돈다(Mockito 없음, 7.1).

| 대상 | 방법 |
|---|---|
| exec 기본·종료 코드·stderr 분리 | `ScriptedCommand`(1단계 시범 그대로) |
| 마감·취소·출력 상한 | 「끝나지 않는 명령」「큰 출력 명령」「신호를 무시하는 명령」 |
| transport 단절(P5·P8) | 서버가 `ServerSession.close(true)` 또는 소켓을 끊음. 요청 수신 횟수를 서버 쪽에서 센다(자동 재전송 금지 시험) |
| 연결·인증 실패, 호스트 키 TOFU·변경·핀 | 닫힌 포트, 틀린 비밀번호(s09), 다른 호스트 키 서버 |
| 죽은 세션 사전 감지(D-0038) | 서버가 유휴 세션을 닫게 한 뒤 다음 요청을 보내 「한 번만 실행되고 성공」을 확인 |
| SFTP 업로드·다운로드·rename·확장 목록 | MINA SFTP 서버(`getServerExtensions`) |
| SFTP 오류 주입 | 시험용 `FileSystemFactory`/`SftpEventListener`로 `AccessDeniedException`·`IOException`(공간 부족 흉내)·읽기 중 연결 끊김 |
| 확장 미광고 서버(백업 방식 경로) | MINA 서버가 확장 광고를 끄는 설정이 있는지 `[미확인]`. 없으면 `SftpSubsystemFactory`를 시험 코드에서 상속해 광고 목록에서 `posix-rename@openssh.com`을 뺀다 |
| 채널 수 한도·거절 | 서버 쪽 `MAX_CONCURRENT_SESSIONS`류 속성 `[미확인]` |
| ProxyJump | 서버 2대 + 전달 허용 필터 |
| 프로필·자격 증명·알고리즘 | 파일·`Environment`만으로 가능(SSH 불필요) |
| `TargetPlatform`·문법·Windows 래퍼 문자열 | 순수 단위 시험(SSH 불필요) |

### 7.2 실제 OpenSSH에서만 하는 것 [제안]
내장 서버가 흉내 낼 수 없거나 서버 구현에 달린 동작이다.
| ID | 환경 | 확인 |
|---|---|---|
| S3-RO-01~06 | Linux CI | exec 응답(`channel-exec-want-reply`)과 `signal` 요청의 서버 처리, `sudo -n sftp-server` 위 SFTP(시범 P3-4), SFTP 3판의 rename·posix-rename·ENOSPC/EACCES 상태 코드, `MaxSessions`, OpenSSH heartbeat, 에이전트 CLI 설치(가짜 레지스트리) |
| S3-RW-01~06 | Windows CI | 기본 셸(`cmd.exe`)에서 PowerShell 래퍼(CLIXML·8000자), SFTP 경로 형식(`/C:/…` 여부), chmod 미지원, 리파스 포인트·열린 핸들 위 교체, 관리자 확인, 8000자 한도 |

### 7.3 CI 환경 준비 [제안]
- 2.x Windows CI는 `test/windows-ssh-ci.ps1`(439줄)로 로컬 계정 두 개, `authorized_keys`, `sshd_config`(임의 포트), 예약 작업으로 SYSTEM `sshd -D -f …`를 띄웠다(`windows-ssh-ci.ps1:31-34, 151-157, 301-329`).
- 3.0: Gradle 시험 작업 `realOpenSshTest`(Linux)·`realOpenSshWindowsTest`(Windows)를 만들고(`portal-store`의 `externalDbmsTest`와 같은 방식: 명시 호출 전용, `check`·`build`에 붙지 않음, 접속 값은 Gradle 속성 `portal.test.openssh.{host,port,user,key-file,host-key}`로만 받고 없으면 실패한다 — H2·내장 서버로 대체하지 않는다). `portal-store/build.gradle.kts:31-65`가 같은 패턴이다.
- 서버를 띄우는 일(OS 계정 생성·SYSTEM 서비스·`sshd` 실행)은 Java API가 없으므로 CI 준비 스크립트(`ci/openssh-linux.sh`, `ci/openssh-windows.cmd`)가 맡고, 이유를 스크립트 머리말과 `docs/external-programs.*`에 적는다(설치 스크립트가 OS 서비스를 등록하는 것과 같은 범주). 시험 자체는 Java다. 결정 D3-11의 선택지: (a) 위 준비 스크립트, (b) Linux는 CI 서비스 컨테이너(CI에서만, 이 PC는 Docker 금지와 무관), Windows는 (a), (c) 시험 소스 세트의 Java 클래스가 `ProcessBuilder`로 준비(A-PROCESS 목록에 시험 클래스를 넣어야 하고 Windows 계정 생성은 Java로 불가). 추천 (b).

### 7.4 이 PC(Windows 11)에서 돌릴 수 있는 범위 [사실 + 제안]
- `[사실]` 이 PC에는 Windows OpenSSH **서버가 없다**: `C:\Windows\System32\OpenSSH\sshd.exe`·`sftp-server.exe` 모두 없고 `sshd` 서비스도 없다(`Test-Path`·`Get-Service`로 확인). 서버 설치는 Windows 전역 설정 변경이라 하지 않는다(지시). Docker는 금지다.
- 그래서 이 PC에서 도는 것: 단위 시험, MINA 내장 서버 시험 전부(7.1절), ArchUnit. 도는 시간은 1단계 시범이 72건을 한 번에 돌린 것과 같은 규모다(수치 약속은 하지 않는다 — 실측 전 추정 금지, 원칙 5.2).
- 이 PC에서 못 도는 것: `realOpenSsh*Test`(S3-RO·S3-RW 12건), Windows·Linux 실제 OpenSSH 위 에이전트 CLI 설치(B-617·B-618). 이 사례들은 8단계 CI와 TEST 서버 E2E로만 확인한다(미검증 표시 규칙, 8.2절).

### 7.5 skip을 0으로 만드는 방법 [제안]
- 조건부 건너뜀(`Assumptions`·`@Disabled`·`@EnabledOnOs`)을 새로 쓰지 않는다. 환경에 따라 달라지는 시험은 **별도 Gradle 시험 작업**으로 나눠 그 환경의 CI에서만 실행한다(해당 작업이 실행되지 않으면 「건너뜀」이 아니라 「없음」이다).
- 기본 `test` 작업의 skip은 0이어야 한다. S2 13.6의 skip 예외 9개 자리(이 PC에서 7건)는 그대로이며 3단계가 늘리지 않는다.
- **두 CI 합쳐 skip 0** 기준: Linux CI와 Windows CI의 `test-results/**/*.xml`에서 `skipped`를 센 합이 S2 13.6의 예외 자리(Linux CI에서 Windows용 ACL 시험 7건 + 이 PC 목록과 같은 Linux용 7건이 한쪽에서만 실행됨)를 빼고 0이어야 한다. 3단계는 `realOpenSsh*Test`가 두 CI에서 각각 실행됨을 확인하고, 실행 횟수(tests)가 0인 작업은 실패로 처리한다(`failOnNoMatchingTests`).
- 이 PC에서 시험 `-Dtest` 필터나 `--tests`로 줄이는 것은 개발 중에만 허용하고, 완료 판정은 `build` 전체다(원칙 7.4).

---

## 8. 사례 배정

### 8.1 기준과 수량
- 대상: 사례 표 1,673행에서 「3.0 모듈」 열(칸이 밀린 행은 뒤에서 세 번째 칸)에 `portal-ssh`가 있는 **257행**(A 54 + B 203, `regression-cases.md` 1절의 포함 수와 같음)과, S2가 3단계로 넘긴 `portal-app` 사례(9.3절 「3」 또는 「3·4」 표 11개 묶음 161건 + 이월 4건 + 이 문서가 새로 발견한 문법 3건 + 모듈 열이 깨진 B-566·B-626 = 170건). 두 집합의 교집합은 B-517 1건이다. **합집합 426건**.
- 이 426건을 다음 다섯으로 가른다. 합계: 닫음 330 + 미룸 58 + 삭제 표 이동 제안 38 = 426. (미룸 58 = 5단계 29 + 4단계 27 + 7단계 2)
  1. **닫음**: 3단계가 JUnit으로 닫는다. 「2.x 구현 세부(helper·fd·SQLite)는 3.0 방식으로 다시 확정」(regression-cases.md 0.1)이 적용된다.
  2. **미룸**: 이유와 단계를 적는다.
  3. **삭제 표 이동 제안**: 2.x helper 내부 구현 세부로, Java 판에 같은 행동이 없다. 대체 행동은 새 사례(S3-)로 고정한다. 삭제 표로 옮기는 것은 메인이 판정한다(결정 D3-16).
- ID는 `RC-` 접두를 생략했다. 모든 ID가 사례 표에 있음을 부록 A.3에서 확인했다.

### 8.2 닫는 사례 330건 (묶음별)
| 묶음 | 사례 ID | 건수 | 구현 담당 | 비고 |
|---|---|---|---|---|
| G1 문법·분류(`PosixCommandLineGrammar`·`WindowsCommandLineGrammar`·`TargetPlatform.classify`) | A-430, A-436, A-445~446, A-452, A-464~466, A-479~480, B-075~077, B-566~569, B-588~589, B-597, B-623, B-626, B-628 | 23 | B | S2 9.3 「문법」 18건 + A-464·A-465·B-567(S2에 없음) + B-566·B-626(칸이 밀린 행) |
| G2 승인·관찰 이벤트(`ApplicationEvent`, `@TransactionalEventListener`, 구독자 알림·만료 깨움) | A-142~149, A-154~155, A-748~751, A-769, B-193~194, B-196 | 18 | C | `Thread.sleep` 폴링 없이(D3) |
| G3 명령·읽기 경로·lifecycle·감사 흐름 | A-467~475, A-622, A-624, B-328, B-356, B-358 | 14 | C | D-0004 확정 사례 A-467 포함 |
| G4 파일 서비스·opaque 파일·업로드 흐름 | A-772~778, A-802, B-051, B-053, B-105, B-129~138, B-293~294, B-304, B-368, B-371 | 26 | D | |
| G5 operations 서비스 | B-233~242 | 10 | C | |
| G6 요청 입장·큐 용량 서비스 | B-372~378, B-381~383 | 10 | C | `RequestAdmission` |
| G7 이력·용량 서비스 | B-393~394, B-396~401, B-410 | 9 | D | |
| G8 시작 시 종료 상태 복원 | B-493~495 | 3 | C | `ApplicationRunner`, S2 `RestartRecovery` 소비 |
| G9 S2 이월 4건 | A-173, A-182~183, B-004 | 4 | D | 1.3절 |
| G10 에이전트 CLI 서비스·전달·설치 | A-011~026, A-065~082, A-084~087, B-617~618, B-631~643, B-649~656, B-658~660, B-662~671 | 74 | B(설치기)·C(서비스) | D-0035 후보 B-664~669 포함, 6.2절의 시범 P3-6에 달림 |
| G11 exec 감독·세션 수명·호스트 키 | A-187, A-458~459, A-483, B-057~058, B-067, B-457~458, B-462, B-474~491 | 28 | A | D-0038 후보 B-474~477, D-0010 후보 B-481·B-482, D-0040 확정 B-489 |
| G12 Python 원본 실행(Linux·Windows) | A-906, B-344~352, B-473, B-595~596, B-598~603 | 19 | B | B-473은 Linux 실제 OpenSSH(S3-RO) |
| G13 Windows 명령 래핑·경로·dispatch 결속 | B-511, B-517, B-558~565, B-570~576, B-578~579, B-584~587, B-590, B-604~616, B-619~622, B-624~625 | 43 | B(플랫폼)·C(결속) | B-558(D-0009 확정), B-559(D-0011 확정), B-579(D-0013 후보), B-604~622는 Windows 실제 OpenSSH(S3-RW) |
| G14 SFTP 파일 전송(helper 시험의 Java 재해석 포함) | A-159, A-796, B-496~502, B-506, B-510, B-512~516, B-518~521, B-538~539, B-811~819, B-901, B-903, B-906~913, B-915, B-918~924 | 49 | B | D-0012 후보 B-510, D-0013 후보 A-159, D-0035 후보 B-818, D-0001 확정 B-903, D-0002 확정 B-497·B-921, D-0003 확정 B-908(기대 재설정), D-0034 확정 B-912 |
| **합계** | | **330** | | A 92, B 238 |

- 칸이 밀린 행(B-517, B-566, B-567, B-601, B-605, B-607, B-609, B-612, B-626, A-464, A-465)은 사례 본문으로 판정한 것이다. 부분 파일의 해당 행 열을 바로잡는 일은 이 작업 범위 밖이라 보고만 한다.

### 8.3 미루는 사례 58건
| 이유 | 단계 | 사례 ID | 건수 |
|---|---|---|---|
| direct-tcpip forward·GUI helper stream·GUI 계정 준비: 소비자가 `portal-desktop`이다. 3단계는 포트 이름과 서명 초안만 둔다 | 5 | A-715~719, A-721, A-723, A-725, A-728, A-735, A-805, A-814~829, A-901, B-492 | 29 |
| 에이전트 CLI 릴리스 카탈로그(`AgentReleaseCatalog` 어댑터, npm 레지스트리) | 4 | A-058~064 | 7 |
| 자동 파일 정책·TEST 서버 파일 정책(명령 자동화 서비스·`RiskEvaluator`와 함께) | 4 | A-188, A-190~191, A-193, A-196~200 | 9 |
| source 자동화·test-server-mode secret 정책(test-server-mode는 4단계, vendor 13.4) | 4 | B-455, B-459, B-461, B-463, B-465, B-504~505, B-508~509 | 9 |
| 에이전트 CLI 설치 UI·로그인 UI(`portal-web` 반쪽, 같은 ID를 4단계에서 다시 시험) | 4 | A-216~217 | 2 |
| 실제 npm 패키지 설치 smoke(CI `package_smoke` 구성) | 7 | B-550~551 | 2 |
| **합계** | | | **58** |

### 8.4 삭제 표 이동 제안 38건 (결정 D3-16)
Java 판에 같은 행동이 없다. 각 묶음의 대체 사례는 8.5절에서 고정한다.

| 묶음 | 사례 ID | 건수 | 이유 | 대체 |
|---|---|---|---|---|
| Windows 에이전트 CLI helper 내부(PowerShell 스크립트의 환경 정리·영수증·잠금·정리 규칙) | B-541~549 | 9 | Q3: 원격 PowerShell helper를 폐지한다(feature-map `manage-agent-cli-windows.ps1` 삭제). 사례 B-541의 「3.0도 고정 스크립트로 유지」는 Q3 판정 이전 문장이다 | S3-AG-01~10 |
| Windows CLI 설치 계획 구조(고정 PowerShell 계획 생성·변조 거부·로그인 진단 계획·상한 결속) | B-553~557 | 5 | 계획(스크립트 원문 생성) 자체가 없어진다. 의도 digest·만료·revision 결속은 S2 `AgentCliIntent`가 닫았다 | S3-AG-01, S3-AG-10 |
| Python 에이전트 CLI helper 내부(하드링크 잠금·영수증 추가 필드·자식 환경·npm 설정·프로세스 간 claim·npm 프로세스 그룹) | B-644~648, B-657, B-661 | 7 | 영수증·잠금 파일·프로세스 간 claim이 없다(저널이 대체). npm 필요 여부는 시범 P3-6에 달림(필요하면 B-646~648·B-661은 닫는 쪽으로 되돌림) | S3-AG-02, S3-AG-09 |
| 로그인 확인 helper 내부 | B-672~682 | 11 | 3.0은 CLI를 실행하지 않고 자격 파일 `stat`만 본다(Q3) | S3-AG-07 |
| Windows 파일 helper의 DACL·소유자·라벨 보존과 정책 신뢰 | B-902, B-904~905, B-914, B-916~917 | 6 | SFTP로 설정·검사할 수 없다(4.4절 20·23·24번) | S3-RW-05(문서화된 차이 시험), 릴리스 노트 |
| **합계** | | **38** | | |

- `[제안]` D3-02에서 (b)를 고르면 B-904·B-905는 닫는 쪽으로 돌아간다(고정 PowerShell 조회가 같은 판정을 한다).

### 8.5 새 사례 104건 (`S3-xx-nn`, 개발원칙 7.1: 사례를 먼저 적는다)
판정은 JUnit이다. 약어: 내장 = MINA 내장 서버, RO = 실제 OpenSSH Linux CI, RW = Windows CI.

| ID | 대상 | 입력 | 기대·판정 |
|---|---|---|---|
| S3-EX-01 | `RemoteExecutor` 기본 | `echo ok`(내장) | stdout `ok\n`, 종료 0, `EXITED`, `CompletionEvidence.CommandExited(0)`, 타임라인 마크 7개 순서대로 |
| S3-EX-02 | 마감 | 끝나지 않는 명령, deadline 1s, stopGrace 300ms | reason `DEADLINE`, 부분 출력 보존, `timeoutMs` 보고, 종료 증거 없으면 UNKNOWN(D-0010 관련) |
| S3-EX-03 | 연결 전 취소 | 연결 시작 전에 `CancelToken` 설정 | `notDispatched`(CANCEL), 서버가 받은 연결 0 |
| S3-EX-04 | 실행 중 취소 | 신호를 무시하는 명령 | INT→TERM→KILL 요청 순서(서버가 신호 요청을 기록하는 경우), `SignalDelivery=REQUESTED` 또는 `UNSUPPORTED`, 종료 증거 없으면 UNKNOWN, 있으면 CANCELLED |
| S3-EX-05 | 출력 sink 실패 | sink가 두 번째 프레임에서 `Failed` | `capture=FAILED`, `outputState=PARTIAL`, 채널은 끝까지 비워져 닫힘(D-0040), 이후 같은 세션의 다음 명령 성공 |
| S3-EX-06 | 출력 상한 | 2MiB 출력, 상한 1MiB | `receivedBytes 2MiB`, `retainedBytes 1MiB`, `truncated`, stdout·stderr 각각 따로 |
| S3-EX-07 | exit-signal | 서버가 `exit-signal`로 끝냄 | `ExitStatus.Signaled(name)`, FAILED |
| S3-EX-08 | stdin 쓰기 실패 | 서버가 입력 도중 끊음 | `INPUT_FAILED`, 정지 절차 후 정산 |
| S3-EX-09 | 자동 재전송 금지 | exec 요청 쓴 뒤 단절(서버가 요청 수신 횟수를 셈) | 결과 UNKNOWN, 서버가 받은 exec 요청 정확히 1건, 이어지는 별도 요청만 새 세션 사용 |
| S3-EX-10 | 채널 열기 거절 | 서버가 `CHANNEL_OPEN_FAILURE` | `NOT_STARTED`, `SSH_CHANNEL_OPEN_FAILED`, 열기 시도 1회, 세션 유지 |
| S3-EX-11 | 실행 중 transport 단절 | 서버가 소켓을 끊음 | `transportLost`(UNKNOWN, `requiresReconciliation`), 정리 `INCOMPLETE`가 아니라 세션이 이미 죽은 경우의 정리 규칙 확인 |
| S3-EX-12 | exec 응답 경계(P4/P5) | 서버가 요청 응답을 보내지 않고 끊음 / FAILURE 응답을 보냄 | 전자 UNKNOWN, 후자 `NOT_STARTED`(응답 대기 켠 경우). 시범 P3-1 결과에 따라 후자 기대를 조정 |
| S3-EX-13 | UTF-8 경계 | 멀티바이트 문자가 프레임 경계에 걸림 | 원 바이트 보존, 렌더링 후 문자 손상 0(Z2) |
| S3-EX-14 | 32KiB 명령 | 32768바이트 명령 | 셸까지 전체 전달(A-483의 Java판), 32769는 `CommandText`가 거절 |
| S3-SS-01 | 죽은 세션 사전 감지(D-0038 핵심) | 서버가 유휴 세션을 닫은 뒤 다음 요청 | 사전 확인이 죽음을 알아 새 연결, 명령은 서버에서 정확히 1회 실행, 성공 |
| S3-SS-02 | 연결 실패 후 복구 | 첫 연결 실패, 서버 시작 뒤 다음 요청 | 첫 요청 `SSH_CONNECT_FAILED`, 둘째 성공(실패한 `Future` 재생 없음) |
| S3-SS-03 | 세 코드의 분리(D-0038) | (a) 닫힌 포트 (b) 스케줄러 포화 (c) 실행 중 단절 | (a)`SSH_CONNECT_FAILED`·`NOT_STARTED` (b)`Saturated`→`EXECUTION_QUEUE_FULL`, SSH 시도 0 (c)`transportLost`·UNKNOWN. 서로 다른 값 |
| S3-SS-04 | 채널 열기 거절은 세션을 죽이지 않음 | 거절 1회 뒤 성공 | 연결 객체 동일, 재연결 0 |
| S3-SS-05 | 시각 기록 | 정상·실패 각각 | 타임라인 마크 순서·단조 증가, 연결 실패는 `CONNECT_STARTED`만 있고 `REQUEST_SENT` 없음 |
| S3-SS-06 | heartbeat | 서버가 응답하지 않음 | 설정한 간격×횟수 안에 `sessionClosed`, 슬롯 비워짐(지연을 측정해 보고) |
| S3-SS-07 | 호스트 키 | 첫 키 기록(TOFU), 같은 키, 바뀐 키, 핀 일치·불일치, strict+미지 호스트 | 기록·수락·거절이 규칙대로, 바뀐 키에서 exec 0, 재시작 뒤에도 기록 유지 |
| S3-SS-08 | ProxyJump | 점프 서버 + 대상 서버, 점프 실패 | 대상 도달, 점프 실패는 `SSH_CONNECT_FAILED`에 점프 별칭 진단 |
| S3-SS-09 | 대상 변경 보호 | 연결 대기 중 `ProfileSource` 값이 바뀜 | `DispatchRefusedException(target_changed)`, exec 0 |
| S3-SS-10 | 인증 실패 | 틀린 키·비밀번호 | `SSH_CONNECT_FAILED`, 세션 슬롯 정리, 비밀 값이 로그·예외 문구에 없음 |
| S3-SS-11 | 동시 획득 | 같은 프로필로 동시 8요청 | 연결 1회만 수립(CR-02), 채널 허가 한도 준수 |
| S3-SF-01 | 업로드 새 파일 | 1MiB 파일(내장) | 임시 이름 → rename, 최종 바이트 일치, 임시 없음, 모드 0600 |
| S3-SF-02 | 덮어쓰기(확장 있음) | 대상 존재 + overwrite | `posixRename`, 모드 유지, `ReplaceMethod.PosixRename` |
| S3-SF-03 | 덮어쓰기(확장 없음) | 확장 미광고 서버 | `BackupSwap`: 최종 바이트 일치, 백업 삭제 |
| S3-SF-04 | 백업 방식의 교체 실패 복원(D-0035) | 6b에서 실패 주입 | 대상은 원본 바이트로 복원, 결과 `RolledBack`, 작업 FAILED, completed 0 |
| S3-SF-05 | 교체 뒤 실패(D-0035) | (a) 교체 뒤 확정 읽기 실패 (b) 내구화 실패 (c) 결과 수신 뒤 저널 커밋 실패 | (a) 복원 확정이면 FAILED, 아니면 UNKNOWN (b) 결정 D3-15에 따라 UNKNOWN (c) 작업 UNKNOWN + 재시작 복구가 `OPERATION_OUTCOME_PERSISTENCE_FAILED`. 어느 경우도 증거 없는 COMPLETED 0 |
| S3-SF-06 | 다운로드 850B(D-0013) | 850바이트 파일(내장) | `Fetched`, 크기·해시 일치, `FileRead(verified=true)`, COMPLETED |
| S3-SF-07 | 다운로드 크기 경계 | 64MiB, 64MiB+1 | 전자 수락, 후자 `FILE_TOO_LARGE`(읽기 전 `stat`에서) |
| S3-SF-08 | 다운로드 권한 거부(D-0013) | 서버가 권한 없음 | `Refused(PERMISSION_DENIED)`, transport 오류와 다른 코드, `requiresReconciliation=false` |
| S3-SF-09 | 다운로드 중 연결 끊김(D-0013) | 읽기 도중 서버가 끊음 | `Failed(TRANSPORT)`, 로컬 artifact 삭제·예산 반환, 원격 효과 없음 → UNKNOWN이 아니라 FAILED(결정 D3-17 기대), 자동 재시도 0 |
| S3-SF-10 | 원격 공간 부족 구분(D-0034) | 서버가 공간 부족 상태 코드 | `PERMISSION_DENIED`로 뭉치지 않고 공간 부족 진단 |
| S3-SF-11 | Windows chmod | `WindowsTargetPlatform`에 권한 지정 | `PermissionResult.Unsupported`, SFTP 호출 0, 예외 없음 |
| S3-SF-12 | Linux chmod | 권한 지정 | `Applied`, 모드 반영 |
| S3-SF-13 | 위험 경로 | 링크 leaf, `..`, 디렉터리, FIFO(내장에서 가능한 것) | `UNSAFE_PATH`, 대상·링크 대상 불변 |
| S3-SF-14 | 읽는 동안 변경 | 읽기 중 서버가 파일 크기를 바꿈 | `FILE_CHANGED`, 로컬 artifact 삭제 |
| S3-SF-15 | 허용 루트 | `FilePathPolicy`가 `Enforce(C:\root)` / `Bypass` / `Unconfirmed` | `PATH_OUTSIDE_ALLOWED_ROOT` / 우회 허용 / `PATH_POLICY_UNSUPPORTED`, 대소문자 무시 |
| S3-SF-16 | 동시 게시 | 같은 대상에 두 업로드(덮어쓰기 금지) | 정확히 1건 성공, 다른 건 `DESTINATION_EXISTS`(B-924의 Java판) |
| S3-SF-17 | 임시 정리 | 실패 뒤 (a) 정리 성공 (b) 정리 실패 | (a) 임시 0, `CleanupState.COMPLETE` (b) `INCOMPLETE`→UNKNOWN, 진단에 임시 이름 |
| S3-SF-18 | SFTP 판 협상 | 서버를 3판으로 제한 | rename은 확장 또는 일반 rename만 사용, `UnsupportedOperationException` 0(0.3절 3의 회귀 시험) |
| S3-SF-19 | 오류 분류표 | `SftpException` 상태 2·3·4·6·7·8·11·14·15 | 4.5절 표의 코드(매개변수화) |
| S3-SF-20 | 해시 대조 | 전송 도중 바이트 변조(서버 쪽) | 임시 재읽기 해시 불일치 → `FILE_CHANGED`, 대상 불변 |
| S3-AR-01 | 1090B 예약(D-0012) | 예산 비어 있음, 디스크 충분 | `Reserved` |
| S3-AR-02 | 예산 거절 값 | 예산 부족 | `BudgetExceeded`, `liveBytes`·`holdingBytes`가 따로, `ARTIFACT_QUOTA`에 값 포함 |
| S3-AR-03 | 디스크 부족 거절 | 예산 충분, `usable()` 작음 | `DiskSpaceInsufficient`, `ARTIFACT_STORAGE_FULL`에 `requested·usable`; `usable()` 예외 → `ARTIFACT_STORAGE_IO_ERROR` |
| S3-AR-04 | 판정 순서 | 파일 한도·예산·디스크가 동시에 부족 | 한도 → 예산 → 디스크 순, 한 번에 하나만 |
| S3-AR-05 | 보유분 합산 | 격리 파일이 예산을 채움 | 거절 + `holdingBytes>0`, 격리 파일 삭제 후 수락 |
| S3-AR-06 | `openStream`·`streamDigest` | 스풀이 있는 출력 | 같은 입력에 해시 일치, 변조 시 불일치(A-182·A-183 연결) |
| S3-AR-07 | 고정·해제 | `submit` 뒤 종료 상태 | 종료 전 만료 계산에서 제외, 종료 뒤 `unpin` → 만료 대상 |
| S3-AR-08 | 포트 이동 | `ArtifactRegistry`에서 `holding/chunks/findStagedByKey` | 시작 점검·begin 재시도가 같은 공개 UUID를 받음(B-091), store 내부 interface 없이 |
| S3-AR-09 | `beginConsume(id, reason)` | `MOVED`·`REMOVED` | 시작 시 이유 기록, 완료 전 크래시 뒤 복구가 같은 이유로 이어짐 |
| S3-AG-01 | 설치 정상 | 가짜 레지스트리 tarball, 내장 서버 | 해시 검증 → 업로드 → 고정 명령 순서 → `Installed`, 서버가 실행한 명령이 목록과 같음 |
| S3-AG-02 | 해시 불일치 | 변조 tarball | 원격 접속 0, `Refused` |
| S3-AG-03 | 같은 버전 재사용 | 이미 설치됨 | `Reused`, 원격 쓰기 0(B-633) |
| S3-AG-04 | 업데이트 보존 | 이전 버전·인증 파일 | 이전 버전 보존, 인증 파일 불변(B-636) |
| S3-AG-05 | D-0035 설치 순서 | 전환 뒤 확정 읽기 실패 | 이전 current 복원 확정 → `RolledBack`(FAILED), 복원 실패 → `Unconfirmed`(UNKNOWN), `completed` 0 |
| S3-AG-06 | 정상 종료 직후 단절 | 전환 확정 직후 단절 | UNKNOWN, 같은 의도 재요청은 새 접속에서 상태 질의만(재설치 0) |
| S3-AG-07 | 로그인 상태 | 자격 파일 있음·없음·미설치 | `signed_in`·`signed_out`·`not_installed`에 해당하는 결과, CLI 실행 0 |
| S3-AG-08 | `cleanupFailures` | 정리 0·1·2건 실패 | 0은 「없음」, 양수는 개수 그대로(0 거절 시험을 뒤집음) |
| S3-AG-09 | 마감 시한 | 느린 업로드 | 마감 시 `.partial` 정리, 직전 버전 보존 |
| S3-AG-10 | 고정 명령 목록 | 설치기가 대상에 보낸 모든 명령 | 문서의 목록(`external-programs`)과 동일, 사용자 입력이 명령 문자열에 들어가지 않음 |
| S3-EL-01 | Linux 승격(시범) | `sudo -n sftp-server` 위 SFTP | 성공 시 업로드·다운로드 왕복(RO), 실패 시 폴백 경로로 왕복 |
| S3-EL-02 | sudo 거부 | NOPASSWD 없음 | 파일 작업 전에 거절, 대상 불변 |
| S3-EL-03 | Windows 관리자 확인 | 관리자·비관리자 | `Granted`·`Denied`(계약 거절 문구), marker 미생성(B-601) |
| S3-EL-04 | 승격 방식 선택 | `ElevationPlan` | 구현 선택이 `if`가 아니라 plan 값(패턴 8.12) |
| S3-TP-01 | 등록기 | 구현 누락·중복 | 시작 실패(S2 `TargetPlatformRegistry`) |
| S3-TP-02 | 경로 문법 | Linux·Windows 대상 | `PathSyntax` 대로 |
| S3-TP-03 | 능력 | Windows `pythonExecutable` 없음 | `pythonSource` 능력 꺼짐(S2 7.3절) |
| S3-TP-04 | Windows 래퍼 | 한글·따옴표·`$`·곡선 따옴표 | 원문 보존(B-624), 8000자 경계(B-625), 초과는 `WINDOWS_COMMAND_TOO_LARGE` |
| S3-TP-05 | CLIXML | 진행 기록이 섞인 stderr | 표시에서만 제거, 원문 보관(D-0011) |
| S3-TP-06 | Python 수신기 | 원문 16384B·잘림·변조 | 효과 전 거부(B-600) |
| S3-TP-07 | 문법 계약 시험 | 같은 사례를 두 문법에 | `CommandLineGrammarContract`(S2 6.3절) 통과 |
| S3-TP-08 | 분류 | Windows 두 cmdlet만 `READ_ONLY` | 나머지 `SAFE`, Linux는 분류기에 위임(B-626) |
| S3-AB-01 | A-DIR | ssh에 store import 시도 fixture | 규칙 위반 감지 |
| S3-AB-02 | A-MINA | app·store에 `org.apache.sshd` import fixture | 감지 |
| S3-AB-03 | A-NO-LOCAL-PROCESS | ssh에 `ProcessBuilder` fixture | 감지 |
| S3-AB-04 | A-NO-RETRY-EXEC | exec 패키지에 `@Retryable` fixture | 감지 |
| S3-AB-05 | A-NO-UOE | `new UnsupportedOperationException` fixture | 감지 |
| S3-AB-06 | A-REMOTE-RESULT | 포트가 `Optional`/`boolean` 반환 fixture | 감지 |
| S3-AB-07 | A-NO-CHARSET-DEFAULT | 문자셋 없는 `getBytes()` fixture | 감지 |
| S3-AB-08 | 새 모듈 파일이 규칙 대상에 포함 | `portal-ssh` 실제 클래스 | 규칙이 실제 클래스를 검사(대상이 비어 있지 않음) |
| S3-UC-01 | 디스패처 | `QUEUED` → claim → 실행 → 정산 | 한 번만 실행, 정산은 `Operation.settle`, 이벤트가 AFTER_COMMIT 뒤에만 발행 |
| S3-UC-02 | 감사 실패 | `AuditFailedException` | 승인 허용 안 함, `DispatchRefusedException(AUDIT_FAILED)`로 변환(결정 D3-14), 예외가 유스케이스 밖으로 나가지 않음 |
| S3-UC-03 | 분류기·redactor 빈 | `ApplicationContextRunner` | `CommandClassifier`·`OutputRedactor` 각 1개, `DomainBeans`에서 |
| S3-UC-04 | 폴링 없음 | `observe waitMs` | 이벤트로 깨어남, `Thread.sleep` 0(A-SLEEP), 시간 한도 안에서 반환 |
| S3-UC-05 | 재시작 복원 | 활성·대기 상태 행 | S2 `RestartRecovery` 결과를 `ApplicationRunner`가 반영, 재시작 뒤 같은 작업 재실행 0 |
| S3-UC-06 | reaper | 유지보수 중·정책 변경 | A-173 대로 reap 보류, B-004 대로 보호 장치 실패 시 reap 금지 |
| S3-UC-07 | 저장소 전용 오류 코드 | 정책 개정 충돌·소유자 재사용·출력 버전 충돌 | 값 enum에 존재, 기준본 `x-portal-errorCodes` 포함, 각 던지는 자리에서 해당 코드 |
| S3-UC-08 | 서버 빈 조립 | `portal-server` 최소 조립 | `StorageRoots`·`ArtifactLimits`·`OutputLimits`·`AuditFileLocation`이 설정값으로 만들어지고 `ApplicationContext`가 올라옴, 외부 DBMS(H2)에서 파일 I/O가 트랜잭션 밖(4.4) |
| S3-RO-01 | exec 응답·signal(RO) | OpenSSH 서버에 exec 요청, 취소 | 응답 FAILURE/SUCCESS 구분, `signal` 처리 여부 관측(시범 P3-1·P3-3) |
| S3-RO-02 | `sudo -n sftp-server`(RO) | 승격 SFTP | 6.1절 시범 결과대로(성공 시 왕복) |
| S3-RO-03 | SFTP 3판 오류 코드(RO) | EACCES·ENOSPC(작은 파일 시스템)·ENOENT | 4.5절 표의 코드, 뭉쳐지면 `statvfs`로 구분 |
| S3-RO-04 | rename·posix-rename(RO) | 대상 있음/없음 | 일반 rename 실패(`DESTINATION_EXISTS`), `posixRename` 성공 |
| S3-RO-05 | 세션 한도·heartbeat(RO) | `MaxSessions` 초과, 유휴 단절 | 거절은 `SSH_CHANNEL_OPEN_FAILED`, 죽은 세션 사전 감지 |
| S3-RO-06 | 에이전트 CLI 설치(RO) | 가짜 레지스트리 | S3-AG-01·05의 실제 서버판 |
| S3-RW-01 | PowerShell 래퍼(RW) | 한글·따옴표·종료 코드·stderr 원문 | B-604의 Java판, CLIXML 제거(D-0011), 8000자 경계 |
| S3-RW-02 | SFTP 경로 형식(RW) | `C:\x`, `/C:/x` | 어느 형식이 통하는지 관측하고 어댑터가 그 형식으로 변환(`[미확인]` 해소) |
| S3-RW-03 | 업로드·다운로드 왕복(RW) | 빈 파일·덮어쓰기·묵시적 덮어쓰기 거절 | B-615의 Java판 |
| S3-RW-04 | 위험 경로(RW) | 심볼릭 링크·리파스 포인트·ADS(`:`) | `UNSAFE_PATH`(어댑터가 서버 보고만큼 판정) |
| S3-RW-05 | 문서화된 차이(RW) | 덮어쓰기 뒤 DACL·소유자 | 임시 파일의 속성을 가짐(보존 안 됨)을 시험이 명시적으로 단정, 릴리스 노트와 짝 |
| S3-RW-06 | 관리자 확인·열린 핸들 교체(RW) | 비관리자 승격 요청, 읽기 핸들이 열린 대상 덮어쓰기 | 전송 전 거절(B-616), 열린 핸들이면 `PERMISSION_DENIED`+원본 보존(B-915) |

신규 사례 수 **104건**: EX 14, SS 11, SF 20, AR 9, AG 10, EL 4, TP 8, AB 8, UC 8, RO 6, RW 6.

### 8.6 결함 4건과 사례 연결 [제안]
「원인은 2.x에서 미확인」이라 확정하지 않는다. 수정 기록에는 「Java 판에서 해당 실패 범주를 이렇게 막고 이 시험으로 고정함」으로 적는다.

| 결함 | 막는 범주 | 고정 시험(새) | 연결 후보 사례(닫음) |
|---|---|---|---|
| D-0012 | 예산 거절과 디스크 거절을 한 코드·문장으로 합침, 작은 파일이 예산·보유분 합산에 막힘 | S3-AR-01~05 | A-160(S2 닫음, 이월 재확인), B-094(S2 닫음), B-510(G14) |
| D-0013 | 작은 파일 다운로드의 권한·끊김·시작 전 실패가 `transport_lost`/unknown으로 합쳐짐. 읽기 전용 전송을 unknown으로 쳤을 가능성 | S3-SF-06~09, S3-EX-11, S3-RO-03 | A-159, B-579(G13·G14) |
| D-0035 | 교체·rollback·기록 순서의 경계에서 증거 없는 completed 가능 | S3-SF-03~05, S3-AG-05~06 | B-664~669, B-818(G10·G14) |
| D-0038 | 죽은 세션·재전송·연결 실패/포화/transport 실패의 코드 혼합 | S3-SS-01~06, S3-EX-09, S3-EX-12 | B-474~477(G11) |

---

## 9. 구현 분담 제안

### 9.1 쓰기 범위 4개(겹치지 않음) [제안]
| 담당 | 쓰기 범위(Write·Edit 허용) | 맡는 것 | 예상 클래스(추정) |
|---|---|---|---|
| **구현 A: SSH 세션·exec** | `java/portal-ssh/src/{main,test}/java/…/ssh/{session,profile,exec,testkit}/**`, `java/portal-ssh/build.gradle.kts`, `java/portal-ssh/src/{main,test}/resources/**`(프로필 TOML 시험 자료만) | 3.2~3.6절. `EmbeddedSshServer` 시험 도구(B가 쓴다, 먼저 납품) | 약 30 |
| **구현 B: SFTP·플랫폼·문법·CLI 설치** | `java/portal-ssh/src/{main,test}/java/…/ssh/{sftp,platform,cli}/**`, `java/portal-ssh/src/main/resources/ssh/remote/**` | 4절, 2.3절, 6절. G1·G10·G12·G13·G14 사례 | 약 40 |
| **구현 C: app 포트·실행/관찰 유스케이스·오류 코드** | `java/portal-app/src/{main,test}/java/…/app/{remote,execution,event,admission,operation,recovery,config,target}/**`(config는 `DomainBeans`에 `@Bean` 두 개), `java/portal-domain/src/{main,test}/java/…/domain/error/**`(오류 코드 추가·`PortalException` 변경 시), `java/portal-web/src/test/resources/contract/mcp/envelope.schema.json`(새 코드 반영 한 파일) | 2.2절 포트(**선행 납품**), G2·G3·G5·G6·G8, S3-UC-01~04·07 | 약 45 |
| **구현 D: 파일·artifact·출력·store 보강·서버 최소 조립** | `java/portal-app/src/{main,test}/java/…/app/{file,artifact,output,storage,agentcli,history,capacity,lifecycle}/**`, `java/portal-store/src/**`(포트 이동·`openStream`·`streamDigest`·`unpin`·`beginConsume` 구현, Flyway `V7` 필요 시), `java/portal-server/src/**`(최소 조립 + 통합 시험) | 1.3절 이월, 5절, G4·G7·G9, S3-AR·UC-06·08 | 약 40 |

- 공유 파일은 없다. `settings.gradle.kts`·루트 `build.gradle.kts`·`portal-arch-checks`는 메인 소유다(3단계가 더하는 A-MINA 등은 메인이 반영). 구현 A만 `portal-ssh/build.gradle.kts`를 만진다(의존 추가 요청은 A가 메인을 거침). `portal-app`은 C(`remote…config`)와 D(`file…lifecycle`)가 **패키지로** 나눠 쓴다. `ArtifactRegistry`·`OutputPayloadStore`는 D, `RemoteFileTransfer`·`TargetPlatform`은 C가 소유한다(두 담당이 서로의 패키지를 고치지 않고 필요한 타입 변경은 메인을 거친다).
- `[사실]` 구현 담당은 Gradle을 실행하지 않고 Write·Edit로만 파일을 쓴다. 빌드·시험은 메인이 한 번에 하나씩 돌린다(S2 13.5, 전용 `GRADLE_USER_HOME`).

### 9.2 순서와 의존 [제안]
1. **선행 납품(병렬)**: C가 `app.remote` 포트·결과 sealed 타입·오류 코드를 내고(구현 A·B·D가 쓴다), A가 `EmbeddedSshServer`와 `SshSettings` 값을 낸다. 메인이 통합·확인한다.
2. **시범 게이트**: 6절의 P3-1~P3-6(아래 표)을 A·B가 작은 시험으로 확인해 보고하면 메인이 결정 D3-05·06·08·11·15·17과 REPLACE 분류를 확정한다. 이 판정 전에는 A의 취소 구현, B의 교체·승격·CLI 설치 구현을 시작하지 않는다.
3. **본작업(4명 병렬)**: A(세션·exec), B(SFTP·플랫폼·문법), C(유스케이스·이벤트), D(파일·artifact·store 보강). C·D의 유스케이스 시험은 가짜 포트 구현을 쓰고(실제 어댑터를 기다리지 않는다), 가짜는 시험 소스 세트의 평범한 클래스다(Mockito 없음).
4. **통합**: D의 `portal-server` 최소 조립 시험이 A·B·C·D를 합친다. 이 시험이 store와 ssh를 한 컨텍스트에 올리는 유일한 자리다(ssh→store 의존은 금지이므로 `portal-server`만 가능).
5. **실제 OpenSSH**: 7.3절 준비 뒤 CI에서 S3-RO·S3-RW(8단계 이전, 별도 확인).

시범 P3 목록:
| ID | 확인할 것 | 담당 |
|---|---|---|
| P3-1 | exec 응답 대기를 켰을 때 MINA가 SUCCESS/FAILURE를 어떻게 알려 주는가(내장), OpenSSH·Win32-OpenSSH 응답 | A |
| P3-2 | 능동 세션 확인 API(전역 요청 wantReply) 이름·시간 한도 동작 | A |
| P3-3 | `signal` 요청을 `Session` 버퍼로 직접 보내는 방법, 고정 알고리즘 이름의 MINA 지원 | A |
| P3-4 | 임의 채널 위 SFTP(`sudo -n sftp-server`) 가능 여부 | B |
| P3-5 | ProxyJump 점프별 자격 증명·핀 | A |
| P3-6 | 에이전트 CLI tarball 구성과 대상의 압축 해제·npm 필요 여부 | B |

### 9.3 담당별 완료 조건 [제안]
- 사례 먼저(원칙 7.1): 8.2·8.5의 자기 사례 ID를 `@DisplayName`에 적은 시험을 만든 뒤 구현한다. 사례 ID는 시험 소스와 `.tsv`로 대조한다(S2 13.6 방식).
- 개발원칙 9절 35항 + 디자인 패턴 10절 13항 + 안티패턴 16절 17항을 자기 diff에 적용하고 예/아니오 근거를 보고한다.
- `javac` 경고 0(`-Xlint:all -Werror`), 새 skip 0, ArchUnit 위반 0, `ProcessBuilder` 0(portal-ssh), `Thread.sleep` 0, `static` 업무 판정 0(10.1절).
- 공개 저장소 기준: 코드·시험·문서에 개인 운영 환경 값 0(호스트 이름·IP·도메인·계정). 자격 증명 값이 로그·예외·`toString`에 나오지 않는다.
- A·B: 임베디드 서버 시험은 이 PC에서 통과해야 하고, 실제 OpenSSH 시험 소스(S3-RO·S3-RW)는 작성하되 이 PC에서는 실행하지 못한다(미검증으로 보고).
- C·D: 유스케이스 시험은 실제 `portal-store`(H2)와 가짜 원격 포트로 돈다(재시작·트랜잭션 경계 포함).

---

## 10. static 계획과 결정 필요 목록

### 10.1 static 계획 [제안] (S2 11절 원칙 그대로)
- 업무 판정(「이 경로가 허용되나」「이 오류를 어느 코드로 매기나」「교체가 확정됐나」)은 `static`이 아니라 값 타입 메서드이거나 주입받은 협력 객체의 메서드다. 업무 판정 `static` 유틸 **0개**, 정적 메서드만 가진 클래스 **0개**, 생성자를 막은 유틸 모양 클래스 **0개**(A-UTIL).
- 남길 `static`(예상): ① 정규식 `Pattern` 상수(`SftpFailureClassifier`가 쓰지 않음, `ProfileAlias` 접두 정규화·`WindowsCommandWrapper`의 경로 검사 등 약 6곳), ② 소유 타입의 상수(`ExecutionLimits.DEFAULT_*` 3개: 2.x 120s·5s·1MiB, `ChannelPermits.DEFAULT` 등), ③ 정적 생성(`ExecutionReport.of`, `ExecutionTimeline.start`, `UploadResult.published` 같은 소수). 예상 정적 메서드 약 12개이고 모두 정적 생성이다.
- 빈·객체로 옮기는 2.x 모듈 함수: `superviseExecution`→`ExecSupervisor`, `acquireSshConnection`·`withConnectionLifecycle`→`SshSessionPool`, `Transfers.call/upload/download`→`MinaRemoteFileTransfer`+`AtomicReplacer`, `fileFailure`·`fileFailures`→`SftpFailureClassifier`+`MessageSource`(문장은 ko·en 번들), `fileDiagnostic`→`FileDiagnostic` record, `wrapWindowsCommand`·`prepareWindowsCommand`→`WindowsCommandWrapper`, `presentStderr`→`WindowsTargetPlatform`의 표시 메서드, `verifyHostKey`→`ServerKeyPolicy`, `resolveCredentials`→`EnvironmentCredentialSource`.
- 기계 검증: 통합 때 메인이 정적 메서드 수(정적 생성·상수 구분), 정적 전용 클래스 수(0), 유틸 모양 클래스 수(0)를 센다(S2 11.4와 같음).

### 10.2 결정 필요 목록 (메인이 판정)
각 항목: 선택지 / 추천 / 근거.

| 번호 | 제목 | 선택지 | 추천 | 근거 |
|---|---|---|---|---|
| **D3-01** | 에이전트 CLI 설치기·서비스를 3단계에 넣나 | (a) `AgentCliInstaller`(portal-ssh)와 `AgentCliService`(portal-app)를 3단계, 카탈로그 어댑터만 4단계 (b) 전부 4단계 | **(a)** | `AgentCliInstallerPort`가 SSH 어댑터이고 D-0035가 이 흐름에 걸린다(6.2절). 시범 P3-6 전에는 REPLACE 분류가 가분류다 |
| D3-02 | Windows 소유자·DACL·ACE 신뢰 검사 | (a) 옮기지 않음(여섯 코드는 발생하지 않음) (b) 고정 PowerShell 읽기 전용 조회 (c) Java 보안 기술자 파서 | **(a)** | 4.4절 20번: 로그인 계정 권한이 1차 통제이고 helper 쪽 루트가 사라졌으며, Linux helper도 이 검사가 없었다(패리티). 이 검사가 D-0001의 거짓 거절을 냈다. **보안 판단이므로 메인이 확정하고 보안 감사 범위에 넣는다** |
| D3-03 | 다운로드 경로의 디스크 부족 코드 | (a) `ExecutionErrorCode.ARTIFACT_STORAGE_FULL` 추가 (b) `OPERATION_FAILED`+진단 | **(a)** | D-0012의 구분이 다운로드 경로에서도 유지된다. 코드 이름은 이미 `x-portal-errorCodes`에 있고, 릴리스 노트 「새 코드」(D-07 방식) |
| D3-04 | D-0038 시각 기록의 저장 | (a) 구조화 로그만 (b) `operation_result`에 nullable `TIMESTAMP(6)` 3열(`V7`) (c) 별도 표 | **(b)** | 장부가 「시각 기록」을 요구했고, 이미 `started_at`·`finished_at`이 있어 열 3개로 단계 구분이 된다. ANSI 공통(`common/V7`), `CLOB`·IDENTITY 없음 |
| D3-05 | 취소의 `signal` 요청 | (a) `Session` 버퍼로 직접 쓴 `signal` 요청 + 채널 닫기 폴백 (b) 채널 닫기만 | **(a)** | MINA 2.20.1 클라이언트에 API가 없다(0.3절 1). (b)면 종료 증거가 없어 취소가 UNKNOWN으로 끝나는 비율이 높아진다. 시범 P3-3 결과로 확정 |
| D3-06 | exec 응답 대기(`channel-exec-want-reply`) | (a) 켬 + 응답 확정 시에만 `NOT_STARTED` (b) 끔(항상 P5로 보수) | **(a)**, P3-1에서 응답이 확인되지 않는 서버에서는 (b) | D-0013·D-0038의 「시작 전 대 시작 후」 경계(3.2절). 켜는 비용은 서버가 응답을 안 주면 대기 시간 한도뿐 |
| D3-07 | 세션 기본값 | 2.x와 같은 값(연결 20s, heartbeat 15s×3, 유휴 확인 10s) / 다른 값 | **2.x 값 유지** | vendor CR-10·CR-11. 값은 `SshSettings`(`Duration`)이고 4단계에서 `BRIDGE_*`로 바인딩 |
| D3-08 | 채널 열기 재시도·세션 퇴역 | (a) 재시도 없음, 연속 거절 N회면 유휴 시 세션을 닫음 (b) 2.x처럼 3회 재시도(`@Retryable` 한정, 열기 전에만) | **(a)** | 손 재시도 루프 금지(원칙 2.2 범주 8). B-474~B-477의 「열기 3회」 기대는 새로 쓴다(D-0038 시험으로 고정) |
| D3-09 | `SSH_MCP_*` 이름과 keychain | (a) 이름 유지·`Environment`에서 읽기·keychain 미지원 (b) 새 이름 | **(a)** | `BRIDGE_SECRET_ENV_FILE`의 기존 항목이 그대로 동작(업그레이드 안내 감소). keychain은 2.x 배포물에서 쓰는지 미확인(vendor U-09) |
| D3-10 | 호스트 키 저장 | (a) `known_hosts` 파일에 영속(TOFU) (b) 2.x처럼 메모리만 | **(a)** | 재시작마다 재신뢰하는 것은 공개 제품의 기본값으로 약하다. 업그레이드 안내에 「동작 강화」로 적음. `insecure` 모드는 호환으로 유지+시작 경고 |
| D3-11 | 실제 OpenSSH CI 준비 | (a) `ci/` 준비 스크립트(Linux·Windows) (b) Linux는 CI 서비스 컨테이너, Windows는 (a) (c) 시험 클래스가 `ProcessBuilder`로 | **(b)** | OS 계정·서비스 생성은 Java API가 없다(7.3절). 이유를 문서화. 또한 임시 파일 재읽기 해시(4.2절 3번) 기본 켬은 별도 소결정 — 켬 추천(2.x가 대상 쪽에서 한 번 더 해시) |
| D3-12 | 서버 빈 조립을 3단계가 하는가 | (a) `portal-server` 최소 조립(`StorageRoots` 등 4개 + 통합 시험) 3단계 (b) 4단계 | **(a)** | store+ssh를 한 컨텍스트에 올려 보는 통합 시험이 3단계의 검증에 필요하다(ssh→store 의존 금지라 `portal-server`만 가능) |
| D3-13 | 저장소 전용 오류 코드 3개의 위치 | (a) 기존 enum에 주제별로 추가(예: `RequestErrorCode.POLICY_REVISION_CONFLICT`) (b) 새 `StoreErrorCode` enum | **(a)** | `ErrorCode`가 sealed·8범주 enum(S2 D-08). 주제 분류가 유지된다. 기준본 `x-portal-errorCodes` 갱신 포함 |
| D3-14 | `AuditFailedException` | (a) 4번째 `PortalException` 변형으로 편입 (b) 어댑터 예외로 두고 유스케이스가 `DispatchRefusedException(AUDIT_FAILED)`로 변환 | **(b)** | 2.x가 감사 실패를 배차 거절 이유로 다뤘고(`DispatchReason.AUDIT_FAILED`) 계층 변경이 필요 없다. 3.4절 「원인을 달아 업무 예외로 변환」 충족. (a)는 sealed 계층·완전 `switch`·기준본 영향이 있다 |
| D3-15 | 교체 확정 뒤 내구화(`fsync@openssh.com`) 실패의 결과 | (a) UNKNOWN(2.x 보수와 같음, B-818) (b) 성공 + 진단 | **(a)** | D-0035의 「증거 없이 completed 금지」와 일치, 사례 기대 유지 |
| D3-16 | 삭제 표로 옮기는 38건 | (a) 제안대로 옮김 (b) 일부를 닫는 쪽으로 | **(a)**, B-646~648·B-661은 시범 P3-6 결과에 따라 | 8.4절 이유. 옮기면 `regression-cases.md` 수량·삭제 표 갱신이 따른다(메인 prep 작업) |
| D3-17 | 읽기 전용 전송 실패의 `ExecutionOutcome` 표현 | (a) 원격 효과가 없으므로 `remoteState=NOT_DISPATCHED`·`reconciliation NOT_REQUIRED`·FAILED로 낸다(의미: 「상태를 바꾸는 요청을 보내지 않았다」) (b) 현행 규칙대로 transport 단절이면 UNKNOWN | **(a)** | D-0013의 「850B 다운로드가 `transport_lost`/unknown」이 읽기 전용에는 부적절하다. 단 `RemoteState`는 계약 wire enum이라 값을 더할 수 없고, (a)는 기존 값의 의미를 한 줄 문서화해야 한다. 업로드는 (b) 그대로 |
| D3-18 | 사례 표의 칸 밀린 행 정정 | 이 문서가 찾은 11행(8.2절 끝 목록) 열을 prep에서 바로잡음 | **정정** | 모듈 열이 틀려 S2가 3건을 놓쳤다(0.3절 4) |

---

## 부록 A. 자체 점검

### A.1 인용 줄 재확인
인용한 파일:줄은 작성 뒤 다시 열어 대조했다(대조 방법: 아래 표의 명령 또는 `Read`).
| 대상 | 방법 | 결과 |
|---|---|---|
| `execution-supervisor.mjs`의 `:3-5, 9-11, 27-28, 29-31, 34-36, 38-41, 44-62, 65-85, 92-97, 99, 101-113, 133, 137, 142, 148-156` | `cat -n`으로 157줄 전체를 읽은 뒤 인용 | 일치 |
| `connection-lifecycle.mjs:5, 136-138` | `cat -n`으로 142줄 전체 | 일치 |
| `transfers.mjs:61-64, 91, 119-130, 151-153, 184, 192-194` | `cat -n`으로 216줄 전체 | 일치 |
| `file-helper.py`의 `:15, 27-30, 33-39, 40-47, 52-56, 58-69, 71-72, 82-83, 93-103, 107-115, 124-129, 171-181, 183-203, 205, 215-218, 232-234` | `cat -n`으로 250줄 전체 | 일치 |
| `windows-file-helper.ps1:46-54` | `cut`으로 110줄 전체 | 일치(46-49 SID, 52 관리자, 54 고정 설치 폴더). 이 문서의 이전 초안이 적은 `73-76`은 오류 코드 변환 `catch`(소유자 신뢰 검사가 아님)라 인용에서 뺐다 |
| `windows-file-native.cs`의 `:130-135, 143-152, 155-168, 172, 182, 308-345, 372-436, 449, 496-498, 523` | `grep -n`으로 함수·검사 줄만 확인(본문 전체는 읽지 않음) | 줄 번호는 grep 결과와 일치, 내용 해석은 함수 이름과 대표 줄에 근거 |
| `manage-agent-cli.py:265, 690, 735-779` | `sed -n 640,780p`와 `sed -n 265p;689p` | 일치(전환·영수증·되돌림 순서). `:265`는 `npm_install` 정의, `:689`는 영수증 `installing` 기록이고 `self.runner(package, prefix, work)` 호출은 그 다음 줄 `:690` |
| `src/adapters/mcp/public-contract.mjs:151, 224`, `opaque-file-api.mjs:16`, `opaque-files.mjs:18, 78, 124, 177-179`, `artifacts.mjs:224` | `grep -n` | 일치 |
| Java `JdbcArtifactRegistry.java:89-110`, `ArtifactInventory.java:20-26`, `AuditFailedException.java:7-10`, `TargetPlatform.java:24-39`, `ModuleTable.java:18-24`, `PortalRules.java:150-157, 381-385`, `SshSpikeTest.java:207-215, 255, 263-296`, `ExecutionOutcome.java:65-89`, `CompletionEvidence.java:40, 54`, `ExecutionStage.java:16, 18`, `AgentCliMapper.java:53-57` | `grep -n` 및 파일 열람 | 일치 |
| `V1__operation_journal.sql:29-35, 64` | `grep -n _at` | 일치 |
| `windows-ssh-ci.ps1:31-34, 151-157, 301-329` | `grep -n` | 일치 |
| `command-output.mjs:205-206`, `operations.mjs:75` | `grep -n redact` | 일치 |

### A.2 공식 문서 직접 확인 [사실]
이번 조사에서 MINA 2.20.1 소스(GitHub 태그 `sshd-2.20.1`)를 직접 열었다.
- `https://raw.githubusercontent.com/apache/mina-sshd/sshd-2.20.1/sshd-core/src/main/java/org/apache/sshd/client/channel/ChannelExec.java` — `wantReply = CoreModuleProperties.REQUEST_EXEC_REPLY.getRequired(this)`, `addPendingRequest(Channel.CHANNEL_EXEC, wantReply)`.
- `…/sshd-core/src/main/java/org/apache/sshd/core/CoreModuleProperties.java` — `REQUEST_EXEC_REPLY = Property.bool("channel-exec-want-reply", false)`, 설명 「Configure whether reply for the "exec" request is required」.
- `…/sshd-core/src/main/java/org/apache/sshd/client/channel/ChannelSession.java`, `…/AbstractClientChannel.java` — `signal` 송신 메서드 없음, `exit-status`·`exit-signal` 핸들러만, `handleOpenFailure`가 `SshChannelOpenException`으로 `openFuture`를 완료.
- `…/sshd-sftp/src/main/java/org/apache/sshd/sftp/client/SftpClient.java` — `CopyMode {Atomic, Overwrite}`, `rename(String, String, CopyMode...)`, `getServerExtensions()`, `getExtension(...)`, `stat/lstat/setStat/remove/mkdir/canonicalPath`.
- `…/sshd-sftp/src/main/java/org/apache/sshd/sftp/client/impl/AbstractSftpClient.java` — 판 5 미만에서 옵션이 있으면 `UnsupportedOperationException`, `Atomic`·`Overwrite`는 판 5 이상에서만 비트로 변환.
- 도구가 요약 모델로 처리한 결과이므로 인용은 도구 반환 원문이다. `AbstractChannel` 등 상위 클래스·`DefaultSftpClient`·`ChannelDirectTcpip` 소스는 열지 않았다.
- 그 밖의 인용은 `official-docs-platform.md`가 담은 것을 그대로 썼다(MINA docs 일부, Win32-OpenSSH 위키, systemd 등).

### A.3 사례 수 검산
| 점검 | 방법 | 결과 |
|---|---|---|
| 사례 표 파싱 | `awk -F'|'`로 `^| RC-[AB]-` 행 1,673개를 읽고 모듈 열을 `NF-3`번째 필드로 정함(칸이 밀린 행에도 적용) | 1,673행. `portal-ssh` 포함 257행, `portal-app` 포함 465행(`regression-cases.md` 1절과 일치) |
| 칸이 밀린 행 | `NF != 10`인 행을 출력 | 20행 이상(A-126, A-228, A-249, A-340, A-418, A-460, A-464, A-465, B-466, B-517, B-566, B-567, B-580, B-601, B-605, B-607, B-609, B-612, B-626, B-755). S2가 적은 9행에 A-464·A-465·B-567이 없어 S2 어디에도 배정되지 않음 |
| S2 726건 재현 | S2 9.2·9.3 표(1243~1313줄)의 ID를 범위 전개해 모았고, domain·store·app 포함 717행 + 깨진 행 9건과 비교 | 미배정은 A-464, A-465, B-567 3건뿐 |
| 3단계 집합 | `portal-ssh` 257 ∪ S2 3단계 이월 170(S2 9.3의 「3」·「3·4」 묶음 11개 161건 + A-173·A-182·A-183·B-004 + B-566·B-626 + A-464·A-465·B-567 = 170) | 교집합 B-517 1건, 합집합 426 |
| 배정 합계 | 닫음 330(G1 23 + G2 18 + G3 14 + G4 26 + G5 10 + G6 10 + G7 9 + G8 3 + G9 4 + G10 74 + G11 28 + G12 19 + G13 43 + G14 49) + 미룸 58(5단계 29 + 4단계 7+9+9+2 = 27 + 7단계 2) + 삭제 표 이동 제안 38(9+5+7+11+6) | 330 + 58 + 38 = 426 |
| 묶음 겹침 | 각 묶음을 우선순위 순서로 뺄셈해 겹침 제거 | 남은 사례 0 |
| 새 사례 | 8.5절 표의 `S3-` 행을 센 값을 아래 명령으로 확인 | 104(EX 14, SS 11, SF 20, AR 9, AG 10, EL 4, TP 8, AB 8, UC 8, RO 6, RW 6) |
| vendor 사례 | `vendor-ssh-mcp-rules.md`의 VR-319~374(프로필, 56), VR-375~408(`SSH_MCP_*`, 34), VR-409~464(연결·호스트 키, 56) = 146건. vendor 문서 13.4절이 이 세 절을 3단계로 배정했다 | 146건은 위 426건과 **별개의 새 사례 묶음**이다. 3단계가 S2 구현 4와 같은 방식(소스 추적 기대, 처음 실행하는 확인, 어긋나면 사례를 고치지 않고 보고, 더 엄격한 쪽으로만 수정)으로 채택하자고 제안한다. 담당: 프로필·자격 증명은 A, 호스트 키·연결은 A. 수량은 세 절의 사례 ID 범위에서 센 값이며 사례 본문은 이번에 읽지 않았다 |

### A.4 미검증·한계
- 이 문서의 Java 서명과 SQL 열 이름은 컴파일·실행하지 않았다(설계 문서). 모양 설명용이다.
- `[미확인]` 표시 항목 일람: ① MINA `AbstractChannel` 등 상위 클래스의 `signal` 송신 가능성, ② exec 응답을 켰을 때 MINA 동작·OpenSSH·Win32-OpenSSH의 응답 여부, ③ OpenSSH 서버의 `signal` 요청 처리 판, ④ 임의 채널 위 MINA SFTP, ⑤ `sudo -n sftp-server` 경로, ⑥ MINA의 `curve25519-sha256`·`chacha20-poly1305@openssh.com` 지원, ⑦ ProxyJump 점프별 자격 증명, ⑧ `getInvertedOut()` 윈도 반환 동작, ⑨ MINA 서버의 확장 광고 비활성화·동시 세션 한도 설정, ⑩ OpenSSH 3판 `sftp-server`의 ENOSPC 상태 코드, ⑪ Win32-OpenSSH SFTP 경로 형식·리파스 포인트 보고·`setStat` 시각 지원, ⑫ OpenSSH `MaxSessions` 기본값 출처, ⑬ Boot 4.1.2 BOM의 Jackson TOML 포함 여부, ⑭ 에이전트 CLI npm 패키지 구성과 대상의 `tar`·npm, ⑮ 오류 `data` 필드와 응답 봉투 `additionalProperties:false`의 호환, ⑯ 출력 예약(`OutputManifestStore.reserve`)의 예산·디스크 구분.
- 읽지 못한 것: `windows-file-native.cs`·`windows-file-helper.ps1`의 세부(검사 줄·함수 이름과 대표 줄만 확인했다), `manage-agent-cli-windows.ps1`, `check-agent-cli-login.py`, vendor `ssh/sftp.js`(vendor U-06), 사례 표의 입력·기대 셀 대부분(모듈 열·대상 기능 열·제목 위주로 분류. 묶음별 배정은 사례 제목과 원 시험 파일 이름에 근거하며 개별 사례의 「기대」를 다시 읽지는 않았다), 디자인 패턴·안티패턴 문서 본문(계획 정본이 인용한 항목만 사용).
- `D-0038` 장부의 「unavailable」이 정확히 어느 필드·상태 값인지는 확인하지 못했다. 2.x 소스에서 `unavailable`은 출력 상태(`public-contract.mjs:17`)·평가 상태 등 여러 곳에 있다. 이 문서는 「0.07초 만에 실패로 끝남」이라는 행동만 근거로 삼았고 필드 이름은 가정하지 않았다.
- 시험 설계(7절)의 이 PC 실행 가능 범위는 환경 사실(OpenSSH 서버 없음)에서만 도출했고 실행 시간·메모리는 실측하지 않았다.
- AGPL 전환 등 라이선스 변경(3.0.0)은 이 문서의 범위 밖이다. MINA SSHD(Apache-2.0)와의 호환은 7단계 의존성 라이선스 점검에서 확인한다(미확인).
- 이 문서를 쓰는 동안 사용한 셸 점검은 읽기 전용(`grep`, `awk`, `sed -n`, `cat`, `comm`)이었고 저장소에는 이 파일 하나만 썼다. 사례 집합 계산은 셸 변수와 파이프로만 했으며 중간 파일을 만들지 않았다.

---

## 11. 메인 판정(2026-11-12, Opus)

이 절이 10.2절보다 우선한다. 구현 담당은 이 절을 기준으로 삼고, 어긋나는 본문은 이 절을 따른다.

### 11.1 결정 판정
| 번호 | 판정 | 판정 근거와 조건 |
|---|---|---|
| D3-01 | (a) 채택 | `AgentCliInstaller`(portal-ssh)·`AgentCliService`(portal-app)는 3단계, `AgentReleaseCatalog` 어댑터는 4단계다. 3단계 시험은 시험 소스의 가짜 카탈로그로 한다. |
| D3-02 | (a) 채택 | Windows 소유자·DACL·ACE 신뢰 검사는 옮기지 않는다. 여섯 코드는 enum에 남겨 계약 호환을 지키고, 3.0에서 내지 않는다고 Javadoc·`docs/`에 적는다. 근거는 세 가지다. ① 검사 대상이던 SYSTEM 설치 루트가 3.0에 없다. ② SFTP는 로그인 계정 권한으로 동작하므로 OS 권한이 1차 통제다. ③ Linux helper에도 없던 검사이고, 같은 검사가 D-0001의 거짓 거절을 냈다. 남는 위험(4.3절 경합, 상위 경로를 다른 주체가 쓸 수 있는 경우)은 `docs/`에 적고 8단계 보안 감사 범위에 넣는다. 릴리스 노트 「동작 변경」에도 적는다. |
| D3-03 | (a) 채택 | `ExecutionErrorCode.ARTIFACT_STORAGE_FULL`을 추가하고 `ExecutionStage` 허용 짝에도 넣는다. 릴리스 노트에 「새 코드」로 적는다. |
| D3-04 | (b) 채택 | Flyway `common/V7__execution_timeline.sql`을 추가한다. `operation_result`에 nullable `TIMESTAMP(6)` 열 3개를 둔다. H2·PostgreSQL·MariaDB 공통 DDL이며 `CLOB`·IDENTITY는 쓰지 않는다. 메인은 `externalDbmsTest`로 PostgreSQL을 확인한다. |
| D3-05 | (a) 채택 | `signal` 요청은 MINA 공개 API `Session.createBuffer(SSH_MSG_CHANNEL_REQUEST)`·`writePacket`으로 보낸다. wantReply는 거짓이다. 이어서 유예 뒤 채널을 닫는다. 이 코드는 `ssh.exec` 안의 한 클래스(`ChannelSignals`)에만 둔다. 서버가 처리하지 않으면 결과는 UNKNOWN이고, 이것이 정상 동작이다. 실제 OpenSSH 처리는 S3-RO로 확인한다. |
| D3-06 | (a) 채택 | `channel-exec-want-reply`를 켠다. 응답 FAILURE를 받았을 때만 `NOT_STARTED`로 한다. 응답이 없는 채 시간 한도에 걸리거나 끊기면 P5(UNKNOWN)다. 응답 대기 시간 한도는 `SshSettings.execReplyTimeout`(기본 10초)이다. P3-1 결과 Win32-OpenSSH가 응답하지 않으면 대상 OS별로 끌 수 있게 `TargetPlatform`이 값을 답한다. |
| D3-07 | 채택 | 2.x 값을 유지한다(연결 20s, heartbeat 15s×3, 유휴 확인 10s). 값은 `SshSettings`(`Duration`)로 둔다. |
| D3-08 | (a) 채택 | 채널 열기 재시도는 없다. 거절은 `SSH_CHANNEL_OPEN_FAILED`(`NOT_STARTED`)로 돌려준다. 세션당 채널 허가 8개로 서버 `MaxSessions` 초과를 미리 막는다. 연속 거절 3회면 그 세션은 쓰는 채널이 없을 때 닫는다. B-474~B-477의 기대는 이 동작으로 다시 쓴다. 다시 쓴 근거는 사례 표 비고에 적는다. |
| D3-09 | (a) 채택 | `SSH_MCP_*` 이름을 유지한다. Spring `Environment`에서 읽고 keychain은 `Unsupported`로 돌려준다. |
| D3-10 | (a) 채택 | `known_hosts` 파일에 영속한다. 경로는 설정값이고 기본은 데이터 디렉터리 아래다. `PrivateStorage` 규칙을 따른다. `insecure` 모드는 호환용으로 남기고 시작 시 WARN 로그를 남긴다. 업그레이드 안내에 「동작 강화」로 적는다. |
| D3-11 | (a) 채택(수정) | 실제 OpenSSH 시험 환경은 CI 러너 자체에 준비한다. Linux는 `java/ci/openssh-linux.sh`, Windows는 `java/ci/openssh-windows.cmd`가 맡는다. Linux도 서비스 컨테이너가 아니라 러너에 둔다. P3-4(`sudo -n sftp-server`)를 시험하려면 sudo가 있는 실제 계정이 필요하기 때문이다. 이 PC에서는 실행하지 않는다. 시험은 Java(Gradle 작업 `realOpenSshTest`, 명시 호출 전용)다. 소결정으로 임시 파일 재읽기 해시는 기본 켬이다(파일 상한 64MiB라 비용 한정). |
| D3-12 | (a) 채택 | `portal-server` 최소 조립과 store+ssh 통합 시험을 3단계에서 한다. 바인딩(`BridgeProperties`)은 4단계다. 3단계는 시험용 값으로 생성자 주입한다. |
| D3-13 | (a) 채택 | 기존 주제별 enum에 추가하고 `envelope.schema.json`의 `x-portal-errorCodes`를 갱신한다. |
| D3-14 | (b) 채택 | `AuditFailedException`은 인프라(어댑터) 예외로 둔다. 실행 유스케이스가 원인을 보존해 `DispatchRefusedException(AUDIT_FAILED)`로 변환한다. S2 13.6의 「`PortalException` 편입」 이월 문구는 이 판정으로 대체한다. 4단계 관리자 경로의 감사 실패 변환은 4단계가 같은 원칙(유스케이스 경계에서 업무 결과로 변환)으로 정한다. A-AUDIT-BOUNDARY 규칙을 둔다. |
| D3-15 | (a) 채택 | 교체 확정 뒤 시도한 내구화가 실패하면 UNKNOWN이다(4.2절 8번 본문 수정함). 확장이 광고되지 않아 시도하지 않은 경우는 Published+진단이다. |
| D3-16 | (a) 채택 | 38건을 삭제 표로 옮긴다. B-646~648·B-661은 P3-6 결과가 나올 때까지 「보류」 표시로 남긴다. 옮길 때는 대체 행동을 고정하는 S3 사례 ID를 함께 적는다. |
| D3-17 | (a) 채택 | 읽기 전용 다운로드의 실패는 `remoteState=NOT_DISPATCHED`, 정산 불요, FAILED다. 이 경우 `NOT_DISPATCHED`의 뜻은 「대상 상태를 바꾸는 요청을 보내지 않았다」이고, 이를 계약 문서·`RemoteState` Javadoc에 한 줄 적는다. 3.0의 다운로드는 원격에 임시 파일을 만들지 않으므로 이 뜻이 성립한다. 업로드·exec는 현행 규칙 그대로다. 릴리스 노트 「동작 변경」(D-0013)에 적는다. |
| D3-18 | 정정 | 칸 밀린 11행을 바로잡는다. |

### 11.2 추가 판정
- **vendor 사례 146건(VR-319~464) 채택.** S2 구현 4와 같은 방식으로 채택한다.
  - 기대는 소스를 추적해 정하고, 처음 실행해 확인한다.
  - 어긋나면 사례를 고치지 않고 보고하며, 고칠 때는 더 엄격한 쪽으로만 고친다.
  - 담당은 A2(11.3)다.
- **시범 게이트는 막지 않는다.** 9.2절 2번 「판정 전에는 구현을 시작하지 않는다」는 채택하지 않는다.
  - 각 구현은 보수적 기본값으로 먼저 만든다. 응답이 확정되지 않으면 UNKNOWN, 확장이 없으면 백업 방식을 쓰는 식이다.
  - 실제 서버 동작은 S3-RO·S3-RW 시험이 확인한다.
  - P3-1·2·3·5는 내장 서버에서 확인할 수 있는 만큼 담당이 시험으로 확인해 보고한다.
  - P3-4(`sudo -n sftp-server`)와 P3-6(CLI tarball)은 실제 서버 시험으로 확인한다. 결과가 나오기 전에는 elevate를 「고정 명령 exec 폴백」으로 구현한다. P3-4가 통과하면 SFTP 승격 경로를 더한다.
- **출력 펌프 스레드**: `getInvertedOut()`·`getInvertedErr()`를 읽는 작업은 주입받은 Spring `TaskExecutor`(`AsyncTaskExecutor`)로 돌린다. `new Thread`·`Executors`는 쓰지 않는다(A-THREAD).
- **원격 고정 문장 리소스**(`src/main/resources/ssh/remote/**`)는 대상에 보내는 데이터다. 이 리소스와 대상 고정 명령은 「원격 대상 명령」 범주의 대체 불가 예외다. 이유는 `docs/external-programs.{en,ko}.md`에 적는다. 이 문서가 없으면 E가 만든다.

### 11.3 구현 분담(9절 대체)
쓰기 범위는 서로 겹치지 않는다. Gradle은 메인만 실행한다. 아래 순서로 진행한다.
1. **1차**: C·E·A1(testkit)
2. **2차**: A1·A2·B·D(C의 포트 위에서)

| 담당 | 쓰기 범위 | 맡는 것 |
|---|---|---|
| A1 SSH 세션·exec | `portal-ssh/…/ssh/{session,exec,testkit}/**`(main·test), `portal-ssh/build.gradle.kts` | 3.2~3.5절, ProxyJump, `EmbeddedSshServer`(1차 납품), S3-EX·S3-SS, B-474~477 등 G11, P3-1·2·3·5 |
| A2 프로필·자격 증명·호스트 키 | `portal-ssh/…/ssh/{profile,hostkey}/**`(main·test), `portal-ssh/src/test/resources/profile/**` | 3.6절(ProxyJump 제외), `ServerKeyPolicy`·`PinnedFingerprintVerifier`·known_hosts 영속, vendor VR-319~464 |
| B SFTP·플랫폼·문법·CLI | `portal-ssh/…/ssh/{sftp,platform,cli}/**`(main·test), `portal-ssh/src/main/resources/ssh/remote/**` | 4절, 2.3절, 6절, S3-SF·S3-TP·S3-AG·S3-EL, G1·G10·G12·G13·G14 |
| C app 포트·실행 유스케이스·오류 코드 | `portal-app/…/app/{remote,execution,event,admission,operation,recovery,config,target}/**`, `portal-domain/…/domain/error/**`, `portal-web/src/test/resources/contract/mcp/envelope.schema.json` | 2.2절 포트(1차 납품), D3-03·13·14·17, S3-UC-01~04·07, G2·G3·G5·G6·G8 |
| D 파일·artifact·출력·store·서버 조립 | `portal-app/…/app/{file,artifact,output,storage,agentcli,history,capacity,lifecycle}/**`, `portal-store/src/**`, `portal-server/src/**` | 1.3절 이월, 5절, D3-04·12, S3-AR·S3-UC-06·08, G4·G7·G9 |
| E 아키텍처 규칙·사례 표·CI·문서 | `portal-arch-checks/**`, `docs/migration/regression-cases*.md`, `.github/workflows/java-openssh.yml`(새), `java/ci/**`(새), `docs/external-programs.{en,ko}.md` | 2.1절 규칙 8개(A-MINA 등, 위반 고정 fixture 포함), D3-16·18 사례 표 정정, S3-RO·S3-RW용 CI 준비(D3-11), 외부 프로그램 문서 |
