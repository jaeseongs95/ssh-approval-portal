# PC 파일 전송 클라이언트 2.4.0

## 완료 알림을 hook으로 받기

기존 원격 MCP 연결은 그대로 사용합니다. 로컬 클라이언트가 owner HTTP로 요청 완료를 관찰하고, 완료 metadata를 로컬 SQLite 수신함에 먼저 저장합니다. 같은 세션의 네이티브 hook이 본문을 인수해 에이전트 문맥에 넣습니다. Codex·agy의 별도 깨우기는 `[ssh-mcp:completion:UUID]` 표식만 보냅니다. Claude Code는 공식 `asyncRewake` 백그라운드 hook이 새 본문을 stderr에 출력하고 exit 2로 종료해 유휴 세션을 깨웁니다. AGS 설치나 추가 MCP 연결은 필요하지 않습니다.

배포본에는 `scripts/portal-completion-hook.mjs`와 호스트별 `hooks/*.json`이 포함됩니다. Codex용 `.codex-plugin/plugin.json`은 hook만 등록합니다. 호스트가 실행할 로컬 hook 정의를 신뢰·재적재해야 하며, 파일을 압축 해제한 것만으로 현재 세션에 적재됐다고 판단하지 않습니다. 기존 AGS·다른 hook·인증 설정을 덮어쓰지 마세요.

설치기에 TEST/PROD origin과 기존 cloudflared를 지정하면 `completion-watch.json`을 만들고 기존 호스트 hook에 연결합니다. 등록된 SSH MCP의 `submit`·`observe` 호출이 끝나면 훅이 같은 작업의 관찰을 자동으로 시작합니다. 에이전트는 별도 watch 명령이나 추가 MCP 연결 없이 다른 일을 계속합니다. 관찰은 기존 클라이언트의 유한한 백그라운드 작업이며 원격 명령을 다시 실행하지 않습니다.

Codex·Claude Code는 호스트가 전달한 MCP 응답의 ID를 사용합니다. Antigravity는 도구 응답을 제공하지 않으므로 원래 입력의 operationKey 또는 observe ID를 사용하며, operationKey 관찰은 서버의 `/api/operations/by-key` 지원이 필요합니다. 도구 이름이 기본 별칭과 다르면 설치기의 `--test-mcp-tools`·`--prod-mcp-tools`에 실제 submit·observe 이름을 쉼표로 지정합니다. origin·실행 파일은 로컬 설치 설정에서만 읽고 도구 응답에서 가져오지 않습니다.

각 호스트 hook을 등록한 다음 실제 `SessionStart` 또는 도구 경계에서 세션 결속을 만듭니다. 세션은 호스트가 제공한 현재 세션 ID만 사용합니다. 다른 세션의 기록을 탐색해 ID를 찾거나 임의 세션을 대신 등록하지 않습니다. 아래 명령은 자동 연결을 지원하지 않는 호스트에서 사용하는 명시적 대체 경로입니다.

```bash
node scripts/portal-files.mjs --origin https://YOUR-PORTAL watch REQUEST_ID --notify-hook --host codex --session EXACT_SESSION_ID --wake-executable /absolute/path/to/codex
```

이 명령은 호스트의 백그라운드 실행 기능으로 시작하고 에이전트는 다른 작업을 계속합니다. Claude Code는 `--host claude-code`, agy는 `--host antigravity`를 사용합니다. Claude socket/token을 읽거나 복사하지 않습니다. agy의 project/LS 환경은 해당 호스트가 자식 프로세스에 제공한 현재 환경만 사용합니다. 다른 설정·인증 파일을 찾아 복사하지 않습니다.

Claude Code는 같은 client 폴더를 `claude --plugin-dir /absolute/path/to/client`로 해당 실행에 적재할 수 있습니다. `.claude-plugin/plugin.json`은 hook만 등록합니다. `SessionStart`는 짧게 세션을 등록하고 별도의 `asyncRewake` 대기를 시작합니다. 대기 handler는 `async: true`도 명시합니다. Claude Code 2.1.314는 `asyncRewake`만 지정하면 비대화형 단일입력 `-p`에서 동기로 대기하므로, 이 플래그를 생략하면 도구 진행이 막힐 수 있습니다. `PostToolUse`·`Stop`에서도 대기를 준비하되, SQLite의 세션별 lease로 중복 대기를 억제합니다. `SessionEnd`는 대기를 무효화하고 미처리 metadata는 보존합니다.

이 백그라운드 hook은 원격 HTTP나 모델을 기다리지 않고 로컬 수신함만 확인합니다. 네이티브 hook timeout은 86,400초, 내부 대기는 86,340,000ms로 유한합니다. 대기가 만료된 뒤 아무 호스트 이벤트도 없는 유휴 상태까지 자동 수신을 보장하지 않습니다. 다음 시작·도구 실행·턴 종료에서 다시 준비됩니다. `--wait-timeout-ms`로 더 짧은 대기 시간을 지정할 수 있습니다. host가 `asyncRewake`를 지원하고 세션을 유지해야 하며, 종료된 `claude -p` 실행은 다시 깨울 수 없습니다.

수신함 기본 위치는 Windows `%LOCALAPPDATA%/ssh-mcp-completion/completion.sqlite`, POSIX `$XDG_STATE_HOME/ssh-mcp-completion/completion.sqlite` 또는 `$HOME/.local/state/ssh-mcp-completion/completion.sqlite`입니다. `--inbox ABSOLUTE_DB`를 쓰면 hook과 watcher 모두 같은 경로를 지정해야 합니다. 인증·SSH 출력·파일 내용은 저장하지 않고 완료 metadata 13필드만 저장합니다. POSIX 전용 leaf는 0700, DB는 0600이며 Windows는 사용자 프로필의 기존 ACL 상속을 유지합니다. Windows ACL 독점성이나 같은 OS 계정 내부의 격리를 보장하지 않습니다.

hook은 출력 후 자동 ACK하지 않습니다. 에이전트가 기록을 처리한 뒤 본문의 정확한 receipt·claim으로 다음 명령을 실행합니다. 다른 세션이나 오래된 claim의 ACK는 거절됩니다.

```bash
node scripts/portal-completion-hook.mjs ack --host codex --session EXACT_SESSION_ID --receipt RECEIPT_UUID --claim CLAIM_UUID
```

저장 완료·wake 요청·hook 인수·모델 수신·ACK·원격 업무 완료는 각각 다릅니다. Claude의 `notification.wake.state=deferred`는 네이티브 hook이 수신함에서 처리할 예정이라는 뜻이며, 실제 모델 수신을 확인한 값이 아닙니다. 성공한 watch와 수신함 저장의 exit 0 역시 모델 수신을 보장하지 않습니다. wake 실패에도 기록은 남습니다. 중단·충돌로 ACK하지 못한 기록은 lease 뒤 다음 사용자 입력·재개 hook에서 다시 전달될 수 있습니다. Claude의 백그라운드 대기는 새 pending만 인수하므로, 같은 미ACK 건으로 계속 자동 재개하지 않습니다. 이를 원격 작업 재실행으로 해석하지 마세요. hook에는 원격 HTTP 대기·모델 호출·원격 명령 제출이 없습니다.

| 호스트 | 본문 수신 경계 | 유휴 깨우기 전제 |
| --- | --- | --- |
| Codex | SessionStart, UserPromptSubmit, PostToolUse, Stop | 선택한 실행 파일 또는 공식 managed launcher의 `queue`; 살아 있는 같은 세션 필요 |
| Claude Code | UserPromptSubmit 및 native asyncRewake 본문 | asyncRewake 지원·실행 중인 같은 세션·활성 대기 hook 필요 |
| Antigravity/agy | SessionStart, PreInvocation, PostToolUse, PostInvocation, Stop | 현재 project·agentapi·LS·CSRF 환경 및 project 일치 필요 |

긴 단일 도구 호출 도중에는 다음 hook 경계까지 본문 주입이 늦을 수 있습니다. hook이 없는 ChatGPT 웹·일반 MCP 클라이언트에 로컬 hook 주입이나 자동 재개가 있다고 주장하지 않습니다. 기존 MCP의 즉시 상태 조회와 해당 호스트의 지원 경로를 사용합니다. 위 표는 구현 경계이며 실제 호스트 수용 여부는 해당 릴리스의 시험 근거에서 별도로 확인합니다. 구형 `--notify-codex ... --thread ...` 직접 메시지 옵션은 호환용이고 hook 옵션과 함께 쓰지 않습니다.

이 클라이언트는 PC 파일을 직접 읽어 owner 인증 HTTPS로 서버의 임시 보관소에 올립니다. 완료되면 UUID 한 개만 반환합니다. 파일 바이트·base64·인증 토큰을 모델 인자나 대화에 넣지 않습니다. 이후 복사·이동 등은 기존 원격 MCP 연결에 UUID를 전달해 요청합니다. 원격 MCP 연결을 추가하지 않습니다.

클라이언트의 upload는 임시 보관까지만 수행합니다. SSH 대상·목적지 경로를 받지 않으며, 원격 파일 반영이나 소유자 승인을 대신하지 않습니다.

## 실행 준비

Node.js 24.2 이상인 24.x와 신뢰하는 기존 cloudflared 실행 파일이 필요합니다. 이 배포본은 Node·cloudflared·인증 정보를 포함하지 않습니다. npm 의존성·전역 설치·설치 프로그램은 필요 없습니다. 기존 cloudflared owner 로그인 캐시만 사용하며 로그인이나 설치를 자동 실행하지 않습니다.

관리자 HTTPS origin의 인증 모드가 `access`여야 합니다. 기본 관리자 `token` 모드나 MCP 연결용 bearer로 대체할 수 없으며, `--origin`은 MCP 도구 URL이 아니라 관리자 사이트의 origin입니다. `ACCESS_MODE_REQUIRED`이면 이 전제를 확인하세요. 클라이언트는 인증 모드·설정·로그인을 자동으로 바꾸지 않습니다. [관리자 로그인 안내](https://github.com/jaeseongs95/ssh-approval-portal/blob/4ccfe36d4bde0943e88d6e12d53795dc56e9379a/docs/admin-login.ko.md)를 참고하세요.

tar.gz 또는 zip을 새 작업 폴더에 풀고 그 폴더에서 아래 명령을 실행합니다. 예시 origin과 파일 경로는 실제 허용 대상으로 바꿉니다. cloudflared는 절대 경로로 지정할 수 있고, 생략하면 PORTAL_CLOUDFLARED와 PATH 순서로 기존 실행 파일을 확인합니다.

```powershell
$portalFiles = @(
  'scripts/portal-files.mjs',
  '--origin', 'https://approve.example.test',
  '--cloudflared', 'C:/tools/cloudflared.exe'
)
node @portalFiles doctor
node @portalFiles upload --file 'C:/work/package.tar.gz' --operation-key 'package-upload-20261104-r1'
```

doctor는 기존 owner 인증과 연결 상태만 확인합니다. 파일 전송·SSH 실행·승인·설치를 하지 않습니다. 캐시가 만료됐다면 소유자가 해당 origin의 기존 로그인 절차를 완료해야 합니다. 토큰 값을 복사하거나 에이전트에게 전달하지 않습니다.

operation-key는 호출자가 정하는 안정된 16~128자 식별자이며 영문·숫자·점·밑줄·콜론·하이픈을 사용할 수 있습니다. 한 논리적 업로드에는 같은 키를 보존합니다. 결과가 불명확하다는 이유로 다른 키를 만들지 않습니다.

## 성공과 결과 불명

upload는 파일의 불변 스냅샷·전체 크기·SHA-256을 먼저 확정하고, 최대 262,144바이트의 raw HTTP 청크를 보냅니다. 서버가 임시 보관 완료를 반환하고 같은 UUID의 ready 상태·전체 해시·수신 바이트 수까지 확인하면 stdout은 아래 JSON 한 줄뿐입니다.

```json
{"uuid":"12345678-1234-4234-8234-123456789abc"}
```

초기에 UUID를 받으면 stderr에도 해당 UUID와 staging 단계만 기록합니다. 성공 stdout을 보존해 기존 원격 MCP의 UUID 파일 처리에 전달합니다. status 출력의 원래 파일명·내부 경로·파일 바이트·owner 쿠키는 모델에게 전달되지 않습니다.

중간 응답이 끊기거나 청크 확인에 실패하면 성공 UUID를 stdout에 쓰지 않습니다. stderr에는 에러 코드·알고 있는 같은 UUID·단계와 확인 가능한 수신 상태만 남습니다. 클라이언트는 새 업로드를 만들거나 청크·complete 요청을 자동 반복하지 않습니다.

서버가 명시적인 안전 코드를 반환하면 기존 오류 코드와 별도로 serverCode를 표시합니다. 예를 들어 PORTAL_REQUEST_REFUSED의 원인이 ARTIFACT_QUOTA인지 CHUNK_HASH_MISMATCH인지 구분할 수 있습니다. 응답 원문·스택·경로는 전달하지 않으며, 잘못된 JSON이나 네트워크 결과 불명에서 원인을 만들어 넣지 않습니다. 401은 기존 OWNER_REAUTH_REQUIRED로 처리합니다.

```powershell
node @portalFiles status '12345678-1234-4234-8234-123456789abc'
```

status는 같은 UUID의 state·size·sha256·expiresAt·received·sequence만 읽습니다. staging은 수신 중, ready는 서버 임시 보관 완료, expired는 만료입니다. 후속 파일 동작의 consuming·moved·removed도 상태로 관측할 수 있습니다. ready는 PC나 SSH 목적지에 저장됐다는 뜻이 아닙니다.

이미 일부를 받은 staging 업로드는 자동 재개하지 않습니다. ARTIFACT_ALREADY_STAGING이면 같은 UUID의 상태와 원본을 유지합니다. 시작 응답 자체가 유실되어 UUID를 모르면 원래 operation-key와 오류 기록을 유지하고 서버에서 해당 업로드를 확인해야 합니다. 다른 키로 새 요청을 만들어 결과를 추측하지 않습니다.

동일한 키가 이미 ready인 동일 크기·해시의 파일을 가리키면 그 UUID를 관측해 반환하며 파일 청크나 완료 요청을 다시 보내지 않습니다. 파일 바이트·크기·해시가 다르면 중지합니다.

## 기존 원격 MCP에서 UUID 사용

성공 UUID를 받은 에이전트는 `targets`로 대상 ID와 revision을 확인하고 `files`를 호출합니다. `stat`는 metadata를 조회합니다. `copy`·`move`에는 UUID와 안정된 `operationKey`, `target`, `expectedTargetRevision`, `remotePath`가 필요하며 `overwrite`·`elevate`는 선택 사항입니다. `data.request`가 있으면 그 `id`를 `observe`합니다. request가 null이거나 결과가 불명확하면 같은 UUID의 `file.operations`를 먼저 확인합니다. copy는 임시 원본을 유지하고 move는 대상 publication 성공을 확인한 뒤 소비합니다. `remove`는 임시 원본만 제거하며 이미 배치된 대상 파일을 삭제하지 않습니다. UUID 자체가 승인이나 OS 권한을 부여하지 않습니다. 자세한 필드는 [UUID files 계약](https://github.com/jaeseongs95/ssh-approval-portal/blob/4ccfe36d4bde0943e88d6e12d53795dc56e9379a/docs/mcp-tools.ko.md#모델-밖-파일-전송과-uuid-files-계약)을 따릅니다.

현재 standalone 클라이언트에는 다운로드 요청·PC 저장 명령이 없습니다. 원격 MCP의 `submit`의 `download` 요청과 `artifact-read`는 승인된 서버 스냅샷을 읽는 공통 계약이며 PC 저장 완료를 뜻하지 않습니다. 실제 PC 저장은 허용된 모델 밖 코드나 지원 호스트의 파일 저장 UI에서 수행하고 결과를 확인해야 합니다. 모델 답변에 대량 base64를 재출력하지 않습니다.

## 작업 완료를 모델 밖에서 기다리기

원격 MCP의 `submit`에서 받은 요청 ID를 `watch`에 전달합니다. UUID 파일 ID와는 다릅니다. 이 명령은 기존 owner 인증을 재사용하고 상태만 기다리며, 작업을 제출·승인·취소·재실행하지 않습니다. 서버도 2.1.0 이상이어야 합니다.

```powershell
node @portalFiles watch 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' --timeout-ms 600000
```

에이전트는 위 명령을 **호스트의 백그라운드 프로세스 실행 도구**로 시작한 뒤 독립 작업을 계속합니다. 일반 포그라운드 실행이나 모델의 반복 `observe` 호출로 대체하면 대기 문제가 해결되지 않습니다. 클라이언트가 25초 단위 상태 대기를 수행하며, 완료 시 stdout에 `operation.finished` JSON 한 줄과 원래 요청 ID·대상 revision·상태·종료 코드·출력 준비 상태만 반환합니다. 명령 본문·출력 본문·서버 내부 경로·인증 정보는 포함하지 않습니다. 필요한 출력은 이후 원격 MCP `observe`에서 같은 ID와 `includeOutput=true`로 읽습니다.

완료 프로세스 통지와 에이전트의 다음 턴 예약은 호스트 기능입니다. 해당 기능을 지원하고 설정된 호스트에서는 완료 알림을 소비합니다. 지원 여부를 확인하지 못한 호스트에서는 자동 재개를 보장하지 않습니다. 기본 stdout 관찰에는 별도 로컬 MCP나 상주 서비스를 요구하지 않습니다. native hook 전달에는 해당 호스트 완료 플러그인 적재가 필요합니다.

관찰 제한시간은 기본 600,000ms이며 `--timeout-ms`로 1~600,000ms를 지정할 수 있습니다. 실행 자체의 시간 제한과 다릅니다. `completed`이며 실패·감사 오류가 없으면 exit 0, 실패·거부·만료·취소·결과 불명은 exit 1입니다. 인증 만료·연결 유실·관찰 만료도 원래 ID를 보존한 채 exit 1로 종료합니다. watcher를 멈춰도 SSH 작업은 취소되지 않습니다. 다시 확인할 때는 같은 ID를 사용하며 새 작업 키를 만들지 않습니다.

Codex에서 백그라운드 프로세스의 완료 통지를 지원하지 않는 실행 경로라면, 설치된 Codex 실행 파일의 절대경로와 **현재 자신의 세션 UUID**를 명시해 선택적으로 전달할 수 있습니다.

```powershell
node scripts/portal-files.mjs --origin https://ssh-test-approve.jaeseong.dev --cloudflared C:\tools\cloudflared.exe watch REQUEST_ID --notify-codex C:\tools\codex.exe --thread CURRENT_SESSION_UUID
```

이 옵션도 호스트의 백그라운드 실행으로 시작합니다. 클라이언트는 완료 메타데이터만 `codex queue --thread ... --resume`으로 한 번 전달합니다. `notification.state=queued`는 큐 접수이며, 에이전트의 수신·처리 완료를 뜻하지 않습니다. `resumption=requested`도 재개 요청만 뜻합니다. 살아 있는 Codex 호스트가 없거나 경고가 발생하면 자동 재개를 보장하지 않습니다. 전달 실패는 원래 SSH 결과와 구분해 `COMPLETION_NOTIFICATION_FAILED`로 보고하며 자동 재전송하지 않습니다. 다른 세션 UUID로 보내지 마세요.

Claude Code처럼 백그라운드 작업 완료를 자체적으로 통지하는 호스트는 공통 `watch` 명령의 stdout을 그 기능으로 받으면 됩니다. 호스트별 동작을 확인하기 전에는 자동 재개를 가정하지 않습니다. 파일 업로드와 기본 관찰 기능에는 Codex가 필요하지 않습니다.

## 배포 파일

ssh-approval-portal-client-2.3.3.tar.gz와 같은 이름의.zip은 동일 클라이언트 소스를 담습니다. client-manifest.json은 포함 파일의 크기·SHA-256과 Node 요구사항을 기록합니다. SHA256SUMS-client-2.3.3은 두 압축 파일의 전체 해시입니다. 서버 설치 파일이나 인증 캐시는 포함하지 않습니다. 실행 진입점은 `scripts/portal-files.mjs`이며 명령은 `doctor`·`upload`·`status`·`watch`입니다. 별도 `scripts/portal-client.mjs`·`scripts/portal-file-mcp.mjs` 실행 스크립트는 이 client 자산에 포함하지 않습니다.

개발자는 python scripts/package-client.py --output 새출력폴더로 같은 진입점의 소스 의존 그래프를 묶습니다. 기존 결과물은 덮어쓰지 않습니다. 로컬 생성 허용과 제품 동작 시험은 구분하며, 동작 회귀와 압축 해제 사본의 실행 검사는 승인된 TEST 환경에서 수행합니다.

자동 설치·호스트 등록은 [클라이언트 설치 안내](https://github.com/jaeseongs95/ssh-approval-portal/blob/v2.4.0/docs/client-install.ko.md)를 따릅니다. background watch·native 수신·receipt/claim ACK 순서는 [완료 훅 안내](https://github.com/jaeseongs95/ssh-approval-portal/blob/v2.4.0/docs/mcp-tools.ko.md#완료-훅으로-다른-작업과-병행하기)를 참고하세요.
