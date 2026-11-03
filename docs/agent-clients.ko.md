# 공급자 공통 에이전트 연결

서버의 명령·조회·승인 대기·출력 읽기는 표준 MCP의 JSON 입력과 텍스트 결과로 동작합니다. AI 모델이나 제품 이름으로 접근을 허용·차단하지 않습니다. 먼저 `get-client-capabilities`, `get-client-setup`, `list-targets`를 호출해 클라이언트 연결 경로, 대상 운영체제와 기능을 확인합니다. `structuredContent`를 지원하지 않는 클라이언트는 같은 공개 결과의 `content[].text`를 읽습니다. `read-command-output`은 첫 텍스트에 본문, 두 번째 텍스트에 `output-page-metadata` JSON을 반환합니다. `nextOffset`으로 다음 페이지를 요청하고 `eof`로 끝을 확인하며, 문자 수로 바이트 위치를 추정하지 않습니다.

`get-client-setup`에는 실제로 확인한 클라이언트 능력만 전달합니다. 다음 예시는 기존 파일 도구로 실제 바이트를 읽을 권한과 능력이 있는 에이전트의 입력입니다. 이 경우 추가 로컬 설치 없이 현재 원격 MCP 연결로 업로드합니다.

```json
{
  "client": {
    "fileBytes": true,
    "localProcess": false,
    "localStdio": false,
    "hostFileInput": false,
    "ui": false
  }
}
```

`fileBytes`는 기존 도구로 실제 파일 바이트를 읽을 수 있는 능력, `localProcess`는 로컬 프로세스 실행, `localStdio`는 로컬 stdio MCP 등록·사용, `hostFileInput`은 `openai/fileParams` 파일 입력, `ui`는 사용자 화면 사용 능력입니다. 제품 이름에서 추측하지 않습니다. 생략한 값은 `false`입니다. 추천 우선순위는 `remote-mcp` → `local-cli` → `local-stdio` → `host-file-input` → `owner-ui`입니다. `fileBytes`를 생략하거나 `false`로 보낸 기존 입력은 기존 경로를 유지합니다. 모두 미확인이면 `unavailable`이며, 이때도 실제 바이트를 읽을 수 있는 기존 도구가 있는지 먼저 확인할 수 있습니다. `unavailable`은 보고된 파일 공급 경로가 없다는 뜻이며 표준 명령·상태·출력·승인 대기 도구의 사용 불가를 뜻하지 않습니다.

`remote-mcp`에서는 `localReadiness: "not-required"`이며 로컬 CLI·stdio·패키지·cloudflared 설치가 필요하지 않습니다. 그 밖의 경로는 기존 `requires-local-check`를 유지합니다. 결과의 `local` 정보와 `doctor` 인자는 선택적인 로컬 경로에만 적용합니다. `fileTransport`는 `mcp-json-upload-v1` 계약, 네 도구, 서버가 설정한 `maxBytes`(최대 64MiB), `maxChunkBytes`(256KiB), `encoding:"base64"`와 기존 승인 경계를 안내합니다. 원격 서버는 PC 경로를 직접 읽거나 로컬 파일 권한을 검사하지 않습니다. `serverUi.enabled`와 기존 `uiEnabled`도 서버 설정일 뿐 카드 표시 성공의 증거가 아닙니다.

로컬 프로세스나 stdio를 지원해도 에이전트 실행 호스트와 파일이 있는 호스트가 같다고 추정하지 않습니다. WSL·컨테이너·원격 개발 환경의 로컬 파일시스템은 사용자 PC와 다를 수 있습니다. 두 호스트의 일치 또는 소유자가 확인한 안전한 매핑을 확인하기 전에는 사용자 PC 경로를 실행·전송에 사용하지 않습니다. 경로를 임의로 변환해 접근 가능하다고 판단하지 않습니다.

## 클라이언트 능력에 따른 경로

| 할 일 | 필요한 클라이언트 능력 | 사용할 경로 |
| --- | --- | --- |
| 명령·Python 실행 요청, 상태 조회 | 인증된 Streamable HTTP MCP | `run-command`, `run-python-source`, `get-request-status` |
| 승인·완료 기다리기 | 같은 MCP 연결에서 도구 호출 | `wait-for-request`; 만료·실패를 재실행하지 않음 |
| 실행 결과 읽기 | 텍스트 MCP 결과 읽기 | `read-command-output` |
| 기존 도구로 읽은 파일 바이트 업로드 | 실제 파일 바이트 접근 권한과 표준 MCP JSON 호출 | `begin-upload`, `upload-chunk`, `get-upload-status`, `finish-upload`; 추가 설치 없음 |
| PC 파일 업로드·저장 | 해당 PC의 파일 접근과 로컬 명령 실행 | `scripts/portal-client.mjs` |
| 고정한 PC 파일을 MCP로 전송 | 해당 PC에서 stdio MCP 실행 | `scripts/portal-file-mcp.mjs`의 파일 ID 도구 |
| 호스트가 제공한 파일 자동 입력 | `openai/fileParams` 계약 | 원격 `request-upload` |
| 파일 선택·관리자 결정 화면 | MCP Apps 또는 사용자 브라우저 | 선택적 카드 또는 관리자 페이지 |

마지막 두 경로의 호스트 의존성이 나머지 도구까지 특정 AI 전용이라는 뜻은 아닙니다. 불투명 파일 ID나 PC 경로만으로 파일 바이트를 얻을 수는 없습니다. 기존 파일 도구가 허용한 바이트를 읽을 수 있으면 아래 원격 업로드를 사용합니다. 바이트·로컬 실행·파일 참조·선택 화면이 모두 없으면 보고된 파일 공급 경로가 없음을 알리고 기존 관리자 페이지를 안내합니다. 파일 내용으로 셸 명령을 만들거나 인증 쿠키를 복사해 우회하지 않습니다.

## 추가 설치 없는 원격 MCP 업로드

Codex·Claude·agy 등 어떤 공급자의 에이전트든 기존 파일 도구가 허용한 실제 바이트를 같은 네 도구에 전달합니다. 이 서버가 클라이언트의 경로를 직접 읽는 구조는 아닙니다. 현재 인증된 원격 MCP 연결을 사용하며 별도 로컬 CLI·stdio 서버·Cloudflare 사용자 로그인을 요구하지 않습니다. 파일을 읽을 권한 자체를 새로 부여하지도 않습니다.

1. `list-targets`에서 실제 대상 ID와 현재 64자리 소문자 16진수 `revision`을 확인합니다.
2. 원본 전체 바이트의 크기와 SHA-256을 구하고 `begin-upload`에 `target`, `expectedTargetRevision`, `fileName`, `size`, `sha256`, `remotePath`, `overwrite`, `elevate`를 보냅니다. 파일은 최대 67,108,864바이트이며 관리자 설정으로 더 작아질 수 있습니다. 반환된 `transferId`를 보관합니다. 이 단계는 staging 예약이고 SSH 전송·승인이 아닙니다.
3. 원본을 순서대로 읽어 canonical base64로 인코딩하고 `upload-chunk`에 `id`, 0부터 시작하는 `sequence`, `data`를 보냅니다. 한 청크의 디코딩된 바이트는 1~262,144이며 클라이언트 입력 상한이 작으면 더 작게 나눕니다. 빈 파일은 청크가 필요 없습니다.
4. 응답 유실·중단 시 `get-upload-status`에 같은 `id`를 보내 `sequence`·`received`를 확인한 뒤 그 위치부터 명시적으로 재개합니다. 직전 청크의 동일 재전달은 중복 쓰기 없이 확인될 수 있지만 상태를 보지 않고 청크·begin을 자동 반복하지 않습니다.
5. `finish-upload`에 같은 `id`를 한 번 보냅니다. 최종 크기와 전체 SHA-256 검증 후 기존 파일 정책에 따라 승인·실행 요청을 제출합니다. 성공 응답도 원격 파일 저장 완료는 아닙니다. 반환된 요청 ID로 실제 완료를 확인합니다.

중복·동시 finish는 새 요청을 만들지 않고 거절합니다. finish 응답을 잃었거나 `REMOTE_UPLOAD_REFUSED`가 반환되면 같은 전송 ID의 `get-upload-status`에서 기존 `submitted` 요청을 회수합니다. 이 일반 거절만으로 미실행을 보장하지 않습니다. `submitted`의 요청이 `pending`·`queued`·`failed`일 수 있으므로 원 요청 ID로 `get-request-status`·`wait-for-request`를 사용합니다. 중계기 재시작은 아직 제출하지 않은 staging을 무효화하며, 만료·없음·불명 결과를 새 ID로 자동 대체하지 않습니다. 대상 revision·Windows fileRoot·덮어쓰기·권한 상승·소유자 승인 정책은 그대로 적용됩니다.

다음은 실제 바이트가 `abc`인 3바이트 파일의 형식 예시입니다. `expectedTargetRevision`의 0 값은 `list-targets`가 반환한 현재 값으로 교체하고 실제 허용 목적지를 사용합니다.

```json
{"target":"windows","expectedTargetRevision":"0000000000000000000000000000000000000000000000000000000000000000","fileName":"input.bin","size":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","remotePath":"C:/upload/ssh-mcp/input.bin","overwrite":false,"elevate":false}
```

`begin-upload`가 실제 반환한 48자리 `transferId`를 아래 `id`에 넣어 `upload-chunk`를 호출합니다. 청크와 상태·finish의 `id`는 모두 같은 전송 ID입니다.

```json
{"id":"반환된48자리transferId","sequence":0,"data":"YWJj"}
```

`get-upload-status`·`finish-upload`의 입력은 각각 `{"id":"같은48자리transferId"}`입니다. 파일 내용은 파일 전송 도구에서만 전달하며 셸 명령·인증 도구·대화 본문으로 우회하지 않습니다.

## 선택적인 로컬 CLI

PC에 준비된 신뢰한 배포 패키지의 위치와 패키지가 요구하는 Node.js 24·의존성을 확인합니다. `scripts/portal-client.mjs`가 있는 패키지 루트에서 실행합니다. CLI는 AI 공급자 SDK를 사용하지 않습니다. 현재 owner CLI 인증은 Cloudflare Access이며 `--cloudflared`로 지정한 실행파일이 기존 사용자 캐시를 읽거나 `--access-token-stdin`으로 비공개 토큰 입력을 받습니다. OIDC·정적 관리자 토큰 모드를 지원한다고 가정하지 마세요.

`local.doctor.cwd`의 `<trusted package root>`는 실제 설치 위치가 확인되기 전까지 미해결 자리표시자입니다. 기존 소유자 설정이나 이미 등록된 로컬 도구에서 위치를 확인하고, 해당 호스트에서 패키지 루트·`scripts/portal-client.mjs`·필요한 런타임·의존성을 검증한 다음에만 `local.doctor.argv`를 실행합니다. 위치를 확인하지 못하면 `CLI_LOCATION_UNKNOWN`에 해당하는 상태로 이 로컬 단계를 멈추고 소유자에게 기존 패키지 위치만 요청합니다. 이 안내는 새 doctor 오류 코드가 아니며, 미설치로 단정하거나 자동 설치하는 근거도 아닙니다.

위치와 실행 조건을 확인한 뒤 `get-client-setup`이 반환한 `local.doctor.argv`로 로컬 준비 상태를 진단합니다. 아래 origin은 예시이며 반드시 결과에 포함된 실제 관리자 origin을 사용합니다. `doctor`는 명령·파일 전송·승인을 제출하지 않습니다. 진단 성공을 실제 전송이나 SSH 왕복 완료로 해석하지 않습니다.

```powershell
node scripts/portal-client.mjs --origin 'https://your-admin.example' doctor
node scripts/portal-client.mjs --origin 'https://your-admin.example' doctor --cloudflared 'C:\tools\cloudflared.exe'
```

둘째 명령의 경로는 이미 존재하는 정확한 절대 실행파일 경로로 바꿉니다. 탐색 우선순위는 명시한 `--cloudflared` → `PORTAL_CLOUDFLARED` 환경변수 → `PATH`의 정확한 실행파일 이름입니다. `PATH` 밖의 portable 설치는 플래그 또는 환경변수로 명시해야 합니다. `PATH`에서 찾지 못했다는 결과만으로 미설치라고 판단하지 않습니다. 디스크 전체를 재귀 탐색하거나 비슷한 이름의 프로그램을 대신 실행하지 않습니다. 기존 실행파일을 확인하지 못했다면 경로를 지어내지 않고 `doctor`의 로컬 진단 결과를 읽습니다.

다음은 PowerShell 예시입니다. `$portalRoot`와 `$cloudflared`는 실제 설치 경로로 바꾸며, 에이전트에 파일 접근과 명령 실행 권한이 있어야 합니다.

```powershell
$portalRoot = 'C:\tools\ssh-approval-portal'
$cloudflared = 'C:\tools\cloudflared.exe'
$portal = @("$portalRoot\scripts\portal-client.mjs", '--origin', 'https://ssh-test-approve.jaeseong.dev', '--cloudflared', $cloudflared)
node @portal targets
node @portal upload 'C:\work\input.json' '/home/mcpops/input.json' --target default
node @portal upload 'C:\work\input.json' 'C:/upload/input.json' --target windows
```

두 업로드 예시는 각각 다른 대상에 대한 선택지입니다. 반환된 요청 ID로 `status ID`를 조회하고 필요하면 사용자가 관리자 페이지에서 승인합니다. 에이전트는 이 CLI의 owner 승인 명령을 자동 실행하지 않습니다. 인증 캐시가 없다면 사용자가 `cloudflared access login`을 먼저 수행하며 비밀번호·인증코드를 에이전트에 보내지 않습니다.

다운로드는 `request-download 원격경로 --target ID`로 준비하고, 완료된 요청을 `save 요청ID 절대로컬경로`로 저장합니다. `completed`는 서버 준비, `saved`는 PC의 검증된 저장입니다. 같은 파일의 불명확한 결과는 같은 전송 ID로 조회하고, 명시적 재개만 사용합니다.

## 선택적인 로컬 stdio MCP

명령 실행 도구가 없지만 로컬 MCP 서버를 등록할 수 있으면 [파일 ID 설정](agent-upload.ko.md#pc-파일-id-전용-로컬-mcp)을 준비합니다. 소유자가 로컬 파일·목적지·크기·해시·만료를 고정한 manifest와 전용 journal 폴더를 관리합니다. 일반적인 MCP 클라이언트 등록 예시는 다음과 같습니다. 제품마다 바깥 설정 형식은 다를 수 있으나 프로그램과 인자는 같습니다.

```json
{
  "mcpServers": {
    "portal-files": {
      "command": "node",
      "args": [
        "C:/tools/ssh-approval-portal/scripts/portal-file-mcp.mjs",
        "--manifest", "C:/private/portal-files.json",
        "--journal", "C:/private/portal-journal",
        "--cloudflared", "C:/tools/cloudflared.exe"
      ]
    }
  }
}
```

에이전트는 `file_capabilities`에서 받은 ID로 `file_upload`, `file_download_request`, `file_status`, `file_upload_resume`, `file_save`를 호출합니다. 이 전달기는 로컬 파일 전용이며 원격 명령 도구를 대체하지 않습니다. 원격 SSH MCP와 함께 등록합니다. 임의 경로·새 권한을 모델이 인수로 추가할 수 없습니다.

## 에이전트가 직접 파일을 고르는 모드

소유자가 파일 선택을 허용한 PC에서는 `--manifest` 대신 `--agent-uploads --origin https://관리자호스트`로 같은 stdio MCP를 시작할 수 있습니다. `--journal`과 기존 인증 실행기는 그대로 사용합니다. 이 모드의 `file_upload_select`에 고유한 48자리 소문자 16진수 `capabilityId`, `localPath`, `remotePath`, `target`을 전달하면 크기·해시·대상 revision을 고정합니다. Linux 절대경로와 `C:/upload/file.bin` 또는 `C:\upload\file.bin` 같은 Windows 경로를 지원하며, 실제 대상 운영체제와 맞아야 합니다. 선택 결과의 `available`은 업로드 완료가 아닙니다. 반환된 ID로 `file_upload`를 한 번 호출하고 같은 ID의 `file_status`로 결과를 확인합니다.

이 기능은 Codex·Claude 등 특정 제품의 파일 카드가 필요하지 않습니다. 파일이 있는 PC에서 stdio 프로세스가 실행되어야 하며, 원격 서버 배포만으로 PC의 기존 MCP 프로세스가 갱신되지는 않습니다. 새 패키지로 로컬 MCP를 갱신한 뒤 클라이언트에서 다시 연결합니다. 기존 journal은 보존합니다.

`INVALID_REMOTE_PATH`는 대상 경로 형식 오류, `CAPABILITY_UNAVAILABLE`는 선택 기록이 없는 ID, `CAPABILITY_SELECTION_MISMATCH`는 같은 ID에 다른 파일·목적지를 지정한 경우입니다. 인증 오류는 `ACCESS_CREDENTIAL_UNAVAILABLE`로 구분합니다. 알 수 없는 내부 오류만 `CAPABILITY_REQUEST_REFUSED`로 반환하며 원문 경로·인증정보는 노출하지 않습니다. 상태가 불명확하거나 전송이 실패한 기록을 새 ID로 바꿔 자동 재실행하지 마세요.

## 승인과 검증 경계

`ui-*` 도구와 비공개 티켓은 사용자 화면용입니다. 일반 에이전트가 호출해 소유자 승인을 대신하지 않습니다. 카드가 없으면 `get-client-capabilities` 또는 `get-client-setup`의 기존 `approvals.adminUrl`과 요청 ID로 관리자 페이지의 해당 요청을 안내하고 같은 요청 ID의 완료를 기다립니다. 새 승인 링크나 토큰을 만들지 않습니다. 이 주소에는 승인 티켓이나 인증정보가 없습니다. MCP 연결이 끝난 에이전트를 깨우는 푸시 기능으로 해석하지 않습니다.

카드 없이도 `list-targets`로 대상을 확인하고, 승인된 정확한 작업을 `run-command` 또는 `run-python-source`로 제출하며, 반환된 요청 ID로 `get-request-status`·`wait-for-request`를 호출할 수 있습니다. `pending`이면 소유자에게 기존 관리자 페이지의 요청을 안내하고 `wait-for-request`로 실제 결정을 기다립니다. 타임아웃은 승인이 아니며 같은 ID로 대기를 계속합니다. `queued`는 실행 순서 대기이므로 다시 승인하거나 제출하지 않습니다. 완료 후 `read-command-output`으로 저장된 결과를 읽습니다. 불명확·실패·만료 결과를 자동 재실행하거나 전송 경로를 바꿔 재제출하지 않습니다.

표준 클라이언트 시험·실제 SSH 왕복·특정 AI 제품의 실제 사용은 서로 다른 증거입니다. 미검증 클라이언트까지 실사용 확인으로 표시하지 않습니다. 서버의 파일·명령 한도, 대상 revision, 재시도 금지와 승인 정책은 전송 방식에 관계없이 유지합니다.
