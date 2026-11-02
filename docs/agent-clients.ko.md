# 공급자 공통 에이전트 연결

서버의 명령·조회·승인 대기·출력 읽기는 표준 MCP의 JSON 입력과 텍스트 결과로 동작합니다. AI 모델이나 제품 이름으로 접근을 허용·차단하지 않습니다. 먼저 `get-client-capabilities`와 `list-targets`를 호출해 전송 방식, 대상 운영체제와 기능을 확인합니다. `structuredContent`를 지원하지 않는 클라이언트는 같은 공개 결과의 `content[].text`를 읽습니다.

## 클라이언트 능력에 따른 경로

| 할 일 | 필요한 클라이언트 능력 | 사용할 경로 |
| --- | --- | --- |
| 명령·Python 실행 요청, 상태 조회 | 인증된 Streamable HTTP MCP | `run-command`, `run-python-source`, `get-request-status` |
| 승인·완료 기다리기 | 같은 MCP 연결에서 도구 호출 | `wait-for-request`; 만료·실패를 재실행하지 않음 |
| 실행 결과 읽기 | 텍스트 MCP 결과 읽기 | `read-command-output` |
| PC 파일 업로드·저장 | 해당 PC의 파일 접근과 로컬 명령 실행 | `scripts/portal-client.mjs` |
| 고정한 PC 파일을 MCP로 전송 | 해당 PC에서 stdio MCP 실행 | `scripts/portal-file-mcp.mjs`의 파일 ID 도구 |
| 호스트가 제공한 파일 자동 입력 | `openai/fileParams` 계약 | 원격 `request-upload` |
| 파일 선택·관리자 결정 화면 | MCP Apps 또는 사용자 브라우저 | 선택적 카드 또는 관리자 페이지 |

마지막 두 경로의 호스트 의존성이 나머지 도구까지 특정 AI 전용이라는 뜻은 아닙니다. 원격 채팅의 파일 ID만으로 PC 파일을 읽을 수는 없습니다. 로컬 실행·파일 참조·파일 선택 화면이 모두 없는 클라이언트에는 파일 공급 경로가 없음을 그대로 알립니다. 파일 내용으로 셸 명령을 만들거나 인증 쿠키를 복사해 우회하지 않습니다.

## 로컬 CLI

신뢰한 배포 패키지를 PC에 준비하고 패키지가 요구하는 Node.js 24와 의존성을 설치합니다. `scripts/portal-client.mjs`가 있는 패키지 루트에서 실행합니다. CLI는 AI 공급자 SDK를 사용하지 않습니다. 현재 owner CLI 인증은 Cloudflare Access이며 `--cloudflared`로 기존 사용자 캐시를 읽거나 `--access-token-stdin`으로 비공개 토큰 입력을 받습니다. OIDC·정적 관리자 토큰 모드를 지원한다고 가정하지 마세요.

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

## 로컬 stdio MCP

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

## 승인과 검증 경계

`ui-*` 도구와 비공개 티켓은 사용자 화면용입니다. 일반 에이전트가 호출해 소유자 승인을 대신하지 않습니다. 카드가 없으면 사용자에게 관리자 페이지의 해당 요청을 안내하고 같은 요청 ID의 완료를 기다립니다. MCP 연결이 끝난 에이전트를 깨우는 푸시 기능으로 해석하지 않습니다.

표준 클라이언트 시험·실제 SSH 왕복·특정 AI 제품의 실제 사용은 서로 다른 증거입니다. 미검증 클라이언트까지 실사용 확인으로 표시하지 않습니다. 서버의 파일·명령 한도, 대상 revision, 재시도 금지와 승인 정책은 전송 방식에 관계없이 유지합니다.
