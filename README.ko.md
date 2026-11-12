# SSH Approval Portal 2.4.2

2.4.2은 기존 MCP 도구 호출과 완료 관찰을 네이티브 hook으로 자동 연결합니다. 설치 상태·호스트별 검증 범위는 릴리스 노트에서 확인하세요.

완료 hook은 로컬 수신함에 저장한 상태를 호스트의 네이티브 훅으로 에이전트에 전달하고, 별도로 처리 ACK를 받습니다. Claude Code는 백그라운드 `asyncRewake` 훅을 사용합니다. 호스트별 지원·재적재·유휴 수신 제한은 [클라이언트 hook 안내](docs/client-files.ko.md)를 참고하세요.


[English](README.md) · [v2.4.2 다운로드](https://github.com/jaeseongs95/ssh-approval-portal/releases/tag/v2.4.2) · [아키텍처](docs/architecture.ko.md) · [MCP 도구 계약](docs/mcp-tools.ko.md)

SSH 명령 실행, 파일 전송, 실제 OS 데스크톱 조작을 제공하는 벤더 독립 MCP 서버입니다. 에이전트는 공통 도구 계약을 사용하며, 서버 정책·소유자 결정·대상 계정의 권한에 따라 작업을 실행합니다.

- Linux 셸 명령, Windows PowerShell 명령, 명시적으로 제출한 Python 원문을 실행합니다.
- PC 파일을 모델 문맥 밖에서 업로드하고, UUID로 SSH 대상에 배치합니다.
- 백엔드와 접근 정책을 구성한 Linux·Windows GUI 데스크톱을 에이전트 도구로 관측하고 조작합니다.
- 관리자 웹에서 승인, 이력, 대상별 정책, 실행 용량을 관리합니다.

## 시작점 고르기

| 현재 상황 | 시작할 곳 | 확인할 결과 |
| --- | --- | --- |
| 관리자가 제공한 MCP 연결이 이미 있음 | [첫 명령 실행](#agent) | 실제 대상 ID·revision·capability |
| 이 PC의 파일을 올려야 함 | [PC 파일 클라이언트](#files) | 기존 Node/cloudflared·관리자 Access 인증, 이후 ready UUID |
| 새 중계기를 설치해야 함 | [서버 설치·연결](#server) | 로컬 서비스 건강 상태·보호된 HTTPS·실제 MCP 응답 |
| 에이전트가 그래픽 데스크톱을 사용해야 함 | [GUI 설정](#gui) | 백엔드 준비와 현재 TEST 정책·비밀 설정 조건 |

## 구성과 지원 환경

```text
에이전트 / MCP 호스트 ── MCP ──> Linux 중계기 ── SSH ──> Linux / Windows 대상
PC 파일 클라이언트 ── HTTPS ──> UUID 임시 보관 ── files copy/move ──> 대상
소유자 브라우저 ── HTTPS ──> 승인·설정·이력
```

| 구성 요소 | 현재 지원 범위 |
| --- | --- |
| 중계기 호스트 | 네이티브 Ubuntu 22.04/24.04, Node.js >=24.2.0 및 <25. 설치기가 전용 Node 실행 환경을 준비합니다. Windows 중계기 호스팅은 지원하지 않습니다. |
| SSH 대상 | Linux와 Windows OpenSSH. Windows는 [대상·도우미 설정](docs/windows-targets.ko.md)이 필요합니다. 중계기 하나에 대상을 최대 32개 등록합니다. |
| PC 파일 클라이언트 | 별도 포터블 압축 배포본. 기존 Node.js >=24.2.0 및 <25, 신뢰하는 `cloudflared`, 소유자 인증이 필요합니다. npm·전역 설치나 두 번째 MCP 연결은 필요 없습니다. |
| 그래픽 데스크톱 | 관리형 Linux X11, Linux 중계기를 통한 Windows RDP, 구성한 RFB. GUI 실행 환경의 지원 범위는 일반 SSH보다 좁습니다. [GUI 설정](#gui)을 확인하세요. |
| MCP Apps 카드 | 호스트별 선택적 UI입니다. 카드가 없는 클라이언트는 공통 MCP 도구와 관리자 웹을 사용합니다. |

네이티브 설치기에는 ARM64 경로가 있지만 실제 ARM64 하드웨어 수용 검증은 확정하지 않았습니다. 동봉한 Windows GUI 중계 실행 환경은 Ubuntu 24.04 x86_64용이며, Ubuntu 22.04·ARM64 호환성을 포괄하는 의미가 아닙니다.

공통 계약은 벤더에 종속되지 않지만 모든 웹·데스크톱·CLI 호스트의 파일·UI 기능이 같다는 뜻은 아닙니다. `targets`와 실제 클라이언트 응답으로 확인하세요. 자세한 연결 방식은 [에이전트 클라이언트 안내](docs/agent-clients.ko.md)에 있습니다.

<a id="agent"></a>
## 첫 명령 실행

관리자가 제공한 MCP 엔드포인트에 연결한 뒤 다음 순서로 사용합니다.

1. `targets({})`를 호출해 활성 대상을 고르고 `revision`과 capability를 읽습니다.
2. 안정된 `operationKey`로 `submit`을 호출합니다. 아래 자리표시자는 실제 대상과 revision으로 바꿉니다.
3. 응답의 `data.id`를 보관하고, 결과가 확인될 때까지 같은 ID를 `observe`합니다.

`submit` 예시입니다. `hostname`은 Linux와 Windows에서 모두 사용할 수 있습니다.

```json
{
  "kind": "command",
  "operationKey": "readme-hostname-0001",
  "target": "<target-id>",
  "expectedTargetRevision": "<revision-from-targets>",
  "command": "hostname"
}
```

`observe`의 ID는 실제 응답 값으로 바꿉니다.

```json
{
  "id": "<request-id>",
  "waitMs": 0,
  "includeOutput": true
}
```

`pending`은 소유자 승인 대기, `queued`는 실행 자리 대기입니다. 관측 시간이 끝나도 실행을 취소하지 않습니다. 원래 ID나 작업 키로 관측을 이어가며, 결과가 불명확하다는 이유로 새 키를 만들어 제출하지 않습니다.

명령은 여러 줄 원문을 보존하고 대상의 기본 셸을 사용합니다. `kind:"source"`는 Python 원문, `kind:"download"`는 파일 스냅샷을 별도로 요청합니다. 해당 종류의 필드만 사용하세요. 명령 요청에서는 `elevate:false`도 포함해 `elevate` 필드 자체를 생략해야 합니다. `context`와 `displayContext`는 선택적 설명이며 인증이나 언어 요건이 아닙니다.

출력은 `includeOutput:true`로 명시해서 읽고 필요한 경우 페이지를 이어 읽습니다. 현재 공개 API는 실행 중 raw 출력을 스트리밍하지 않습니다. 상태·출력 페이지·실행 제한 시간·취소의 정확한 필드는 [도구 계약](docs/mcp-tools.ko.md)을 따릅니다.

<a id="files"></a>
## 파일 본문을 모델 문맥에 넣지 않고 PC에서 업로드

[릴리스](https://github.com/jaeseongs95/ssh-approval-portal/releases/tag/v2.4.2)에서 `ssh-approval-portal-client-2.4.2.zip` 또는 `.tar.gz`를 내려받아 압축을 풉니다. 압축을 푼 폴더에서 진입 파일을 실행합니다. 포터블 클라이언트는 이 폴더에서 바로 실행할 수 있습니다. 버전별 설치, TEST/PROD 실행 명령, Codex·Claude Code·Antigravity Native hook 등록은 [클라이언트 설치기](docs/client-install.ko.md)를 사용합니다. 기본 읽기 전용 계획을 검토한 뒤 적용하며, 이전 버전과 관련 없는 호스트 설정을 보존합니다. PATH와 인증은 바꾸지 않습니다.

현재 클라이언트는 **Access 모드**로 구성한 관리자 HTTPS origin, 신뢰하는 기존 `cloudflared`, 소유자 로그인 캐시가 필요합니다. MCP 연결 인증이나 서버의 기본 관리자 token 모드로 대신할 수 없습니다.

PowerShell 예시입니다. origin과 파일 경로는 실제 값으로 바꿉니다.

```powershell
$portalFiles = @(
  'scripts/portal-files.mjs',
  '--origin', 'https://approve.example.com',
  '--cloudflared', 'C:/tools/cloudflared.exe'
)
node @portalFiles doctor
node @portalFiles upload --file 'C:/work/package.tar.gz' --operation-key 'package-upload-0001'
```

네이티브 완료 훅이 구성된 호스트에서는 `submit`·`observe`가 백그라운드 감시를 자동으로 연결하므로 수동으로 `watch`를 실행할 필요가 없습니다. 완료 훅이 없는 호스트에서 SSH 실행 중 다른 작업을 하려면 호스트의 백그라운드 실행 도구로 `node @portalFiles watch REQUEST_ID`를 시작합니다. 기존 클라이언트가 모델 밖에서 대기하고 종료 이벤트 한 줄을 반환합니다. 완료 통지·자동 재개는 호스트별 지원을 확인해야 합니다. [클라이언트 완료 관찰 안내](docs/client-files.ko.md#작업-완료를-모델-밖에서-기다리기)를 참고하세요.

`doctor`는 기존 실행 환경·인증·연결을 진단합니다. 로그인, 파일 업로드, 승인, SSH 명령 실행을 하지 않습니다. 업로드가 성공하면 JSON 객체 하나를 출력합니다.

```json
{"uuid":"12345678-1234-4234-8234-123456789abc"}
```

UUID는 서버의 임시 객체를 가리키며, 공개 파일 경로나 대상 배치 완료를 뜻하지 않습니다. **기존 원격 MCP 연결**에서 `files`를 호출해 배치를 요청합니다.

```json
{
  "action": "copy",
  "uuid": "<uuid-from-upload>",
  "operationKey": "package-placement-0001",
  "target": "<target-id>",
  "expectedTargetRevision": "<revision-from-targets>",
  "remotePath": "/home/mcpops/package.tar.gz"
}
```

선택한 대상에서 쓰기 가능한 목적지를 지정합니다. Windows의 `C:/upload/package.tar.gz` 같은 경로도 같은 계약을 사용합니다. 응답에 `data.request.id`가 있으면 그 ID를 관측합니다. 접수 결과가 불명확하면 다음 행동 전에 같은 UUID의 상태와 작업을 확인합니다.

| 동작 | 의미 |
| --- | --- |
| `files stat` | UUID metadata와 배치 작업을 조회합니다. |
| `files copy` | 선택한 대상에 파일을 배치하고 임시 원본을 유지합니다. |
| `files move` | 파일을 배치하고 publication 확정 뒤 임시 원본을 소비합니다. |
| `files remove` | 임시 UUID 원본만 제거하며, 이미 배치한 대상 파일은 유지합니다. |

원격 MCP 서버가 PC 경로를 직접 읽을 수는 없습니다. 에이전트가 클라이언트를 실행하려면 호스트의 로컬 실행·파일 접근 권한이 필요합니다. 그런 기능이 없으면 사용자가 클라이언트를 실행하거나 호스트의 지원 파일 UI를 사용합니다. 파일 바이트는 모델이 옮겨 적지 않고 클라이언트에서 HTTPS로 직접 전송합니다.

standalone 클라이언트는 **`doctor`·`upload`·`status`·`watch`**를 제공합니다. 다운로드·save 명령은 없습니다. 서버 다운로드는 `submit(kind=download)`와 `artifact-read`를 사용하며, PC 저장은 허용된 클라이언트 코드나 호스트 UI에서 수행한 뒤 크기·해시를 확인해야 합니다. 이미 바이트에 접근할 수 있는 코드에는 저수준 `artifact-*` 도구도 제공합니다. 파일당 상한은 64 MiB, 대상들이 공유하는 기본 임시 저장 예산은 512 MiB입니다. 설정·인증·결과 불명 처리는 [파일 클라이언트 안내](docs/client-files.ko.md)를 참고하세요.

<a id="server"></a>
## 중계기 설치·연결

기존 서버 상태에 맞는 경로를 고릅니다.

| 서버 상태 | 진행 경로 |
| --- | --- |
| 기존 설치가 없는 새 서버 | 아래 신규 설치 예시를 사용합니다. |
| 실행 중인 관리형 설치이며 영속 유지보수를 지원함 | [설치·갱신 안내](docs/install-workflow.ko.md)의 지원되는 업데이트·유지보수 절차를 따릅니다. |
| 중지된 기존 설치, 지원하지 않는 구형 배치, 2.0 이력 전환 | 먼저 상태를 확인하고 이전을 계획합니다. [배포·이전·복구](docs/deployment-180.ko.md)를 따르며 신규 설치를 복구로 취급하지 않습니다. |

### 신규 네이티브 설치

Python 3, 인터넷 연결, 관리자 터미널을 갖춘 Ubuntu 22.04/24.04 서버를 준비합니다. [릴리스](https://github.com/jaeseongs95/ssh-approval-portal/releases/tag/v2.4.2)에서 서버 압축 파일과 `SHA256SUMS`를 내려받고, 해당 서버에서 실행합니다.

```sh
sha256sum --check --ignore-missing SHA256SUMS
tar -xzf ssh-approval-portal-2.4.2.tar.gz
cd ssh-approval-portal-2.4.2
python3 scripts/portal.py install --admin-origin https://approve.example.com --dry-run
sudo python3 scripts/portal.py install --admin-origin https://approve.example.com
sudo python3 scripts/portal.py status
```

`--dry-run`은 실행할 명령을 표시하며, 설치 준비 검사나 실제 설치가 아닙니다. 실제 설치기는 전용 Node 24 실행 환경과 로컬 서비스를 준비합니다. **설치만으로 외부 HTTPS 경로·인증 공급자 설정·MCP 로그인을 완료하지는 않습니다.**

기본 예시는 전체 sudo 권한을 부여하지 않습니다. 선택 옵션 `--grant-sudo-all`은 `mcpops` 계정의 다른 세션까지 포함해 비밀번호 없는 전체 sudo를 부여하므로 해당 권한이 필요할 때만 선택합니다.

Linux Docker Compose 배포는 별도 [준비 스크립트](scripts/prepare-docker.sh), [Compose 설정](docker/compose.yaml), [유지보수 절차](docs/maintenance-test-and-recovery.ko.md)를 사용합니다. 같은 포트·저장소에 네이티브 서비스와 Compose 서비스를 동시에 실행하지 마세요.

### HTTPS·인증·대상 연결

기본 로컬 엔드포인트는 MCP `http://127.0.0.1:39124/mcp`, 관리자 `http://127.0.0.1:39125`입니다. 보호된 HTTPS 경로로 연결하고, 소유자 접근과 MCP upstream 자격을 따로 구성합니다. [설치·연결 안내](docs/install-workflow.ko.md) 또는 [Cloudflare 없는 HTTPS](docs/non-cloudflare-https.ko.md)를 따르세요.

| 인증 경계 | 인증하는 대상 |
| --- | --- |
| MCP 연결 | MCP를 호출하는 클라이언트입니다. PC 파일 접근 권한을 만들지 않습니다. |
| 관리자 웹 | 요청·설정을 검토하는 소유자입니다. 기본값은 token 모드이며 Access/OIDC는 별도로 구성합니다. |
| SSH 대상 | 원격 계정과 고정한 호스트 키입니다. 해당 계정의 실제 OS 권한을 따릅니다. |
| Windows GUI 자격 | RDP 백엔드의 GUI 로그온입니다. SSH 공개키로 대신할 수 없습니다. |

각 대상의 호스트 키를 검증·고정한 뒤 사용합니다. 대상 ID·revision 결속·프로필 설정은 [다중 대상 설정](docs/multi-targets.ko.md)을 참고하되, 호출에는 [2.0 도구 계약](docs/mcp-tools.ko.md)의 `targets`·`submit`·`observe`를 사용합니다.

에이전트 호스트에서 MCP URL을 연결하고 도구 목록을 새로고침한 뒤 `targets`로 확인합니다. 카드는 선택 기능이며 기본값은 `BRIDGE_UI_ENABLED=false`입니다. 켰을 때의 렌더링은 호스트의 MCP Apps 지원에 달려 있고, app 전용 `ui-*` 동작은 독립 위젯이 아닙니다. 브라우저 세션은 [관리자 로그인 안내](docs/admin-login.ko.md)를 따릅니다. 관리자 로그아웃은 현재 관리자 세션을 끝내며 MCP 인증을 유지합니다.

<a id="gui"></a>
## 에이전트가 사용하는 그래픽 데스크톱

GUI 도구는 실제 OS 화면을 조작합니다. 에이전트가 lease를 열고 PNG 프레임을 관측한 뒤 해당 프레임에 결속된 텍스트·키·포인터 입력을 보내고, 결과를 다시 관측한 후 lease를 닫습니다.

```text
targets → desktop-open → desktop-status / desktop-observe
        → desktop-input → desktop-observe → desktop-close
```

서버에는 백엔드의 필수 구성요소와 대상 설정이 필요합니다. **현재 에이전트 GUI 접근에는 해당 대상의 활성 TEST 정책과 서버 측 TEST 비밀 설정도 필요합니다.** `desktop.enabled`만 켜서는 사용할 수 없으며 관리자 GUI 접근은 별도 권한 경로를 사용합니다. GUI를 쓰기 위해 운영 대상의 TEST 우회를 켜지 마세요.

- **Linux:** 관리형 백엔드가 SSH 계정으로 전용 Xvnc/Openbox/xterm X11 세션을 만듭니다. 기존 Wayland 화면을 공유하는 기능은 아닙니다.
- **Windows:** Linux 중계기가 고정한 SSH를 통해 전용 FreeRDP 실행 환경을 Windows RDP 서비스에 연결합니다. 비밀 참조로 저장한 GUI 로그온 자격이 필요하며, 사람의 세션에 영향을 주지 않도록 전용 계정을 사용합니다. 동봉한 네이티브 실행 환경은 Ubuntu 24.04 x86_64를 지원합니다.
- **기존 RFB:** 의도적으로 구성한 신뢰된 세션만 공유하며, OS 세션을 자동으로 생성하거나 잠금을 해제하지 않습니다.

사용자가 PC의 RDP 창을 계속 열거나 에이전트의 데스크톱을 수동으로 유지할 필요는 **없습니다**. 백엔드 준비·transport 연결·인증된 사용 가능 화면은 서로 다른 상태입니다. 보고된 상태를 확인하고 입력 결과를 관측하세요. lease 종료는 Windows 로그아웃이 아닙니다. 자세한 내용은 [GUI 설정](docs/desktop.ko.md)과 [인증 상태](docs/desktop-auth-state.ko.md)를 따릅니다.

<a id="policy"></a>
## 승인·실행 용량·TEST 모드

정책은 대상별로 평가합니다. 사전승인한 명령 이름은 옵션·인자까지 허용하며 금지 규칙이 우선합니다. 전체 명령을 정책으로 허용할 수 없으면, 설정한 모델 평가를 통해 자동 실행 또는 소유자 승인 요청을 판단할 수 있습니다. 모델 평가는 선택 사항이며 명시적인 정보 전송 설정이 필요하고 전송 파일 본문은 검사하지 않습니다.

업로드·다운로드·sudo 자동승인은 각각 선택합니다. UUID, 작업 설명, 승인 허용 설정으로 원격 계정의 실제 OS 권한을 늘리지는 않습니다.

관리자 페이지에서 전체·대상별 **대기열 크기**와 **동시 실행 수**를 설정합니다. 최초 기본값은 중계기의 사용 가능한 CPU 수 `N`을 기준으로 대기열 `N × 10`, 동시 실행 `N`입니다. 저장한 관리자 설정은 유지합니다. SSH 실행 대기와 HTTP 접수 대기는 별개이며, `queued`는 추가 승인 요청이 아닙니다.

TEST 우회는 기본적으로 꺼져 있습니다. 전용 서버 비밀과 현재 대상·정책 결속이 유효하면 금지 명령·개별 자동승인 설정에 관계없이 심사·개별 승인·설정된 허용 루트 소속 제한을 우회합니다. 인증·경로 안전성 검사·실제 OS 권한·자원 한도는 유지합니다. ACL 변경, 자격 생성, UAC 우회를 수행하지 않으며 TEST를 끄면 대상의 일반 정책을 다시 적용합니다.

<a id="upgrade"></a>
## 이전·문제 해결

2.0은 1.x 공개 도구 계약을 교체합니다. 캐시된 MCP 도구 정의를 새로고침하고 구버전 `list-targets`·`run-command`·`wait-for-request` 대신 `targets`·`submit`·`observe`를 사용합니다.

기존 이력은 [배포 안내](docs/deployment-180.ko.md)의 배치 구조·무결성·용량 검사 조건에 따라 이전할 수 있습니다. 원본·보관 증거를 유지하고 결과 불명인 과거 요청을 재실행하거나 만료된 출력을 재생성하지 않습니다. `deploy180.mjs`는 유지한 스크립트 이름이며 제품 버전이 아닙니다. 복구는 명시적으로 수행합니다. 실패나 결과 불명만으로 DB를 복원하거나 무작정 재시도하지 않습니다.

| 증상 | 다음 확인 |
| --- | --- |
| 구형 도구·`INVALID_ARGUMENT`·오래된 출력 스키마 | MCP 도구 목록을 새로고침하고 현재 계약과 비교합니다. |
| `OPERATION_INPUT_CONFLICT` | 제출 종류별 허용 필드를 확인합니다. 명령에서는 `elevate`를 생략합니다. |
| 승인 대기 또는 `queued` | 기존 요청을 확인하고 필요한 승인만 진행하며 같은 ID를 관측합니다. |
| 연결 종료·실행 기한 초과·결과 불명 | 원래 ID/키와 `execution` metadata를 확인하고 대체 작업을 새로 만들지 않습니다. |
| PC 클라이언트 인증 실패 | 관리자 origin과 신뢰하는 cloudflared 경로로 `doctor`를 실행하며 MCP 로그인과 구분합니다. |
| GUI 미준비·인증 필요 | 입력 전에 `desktop-status`와 백엔드 준비 조건을 확인합니다. |

<a id="docs"></a>
## 상세 문서

| 주제 | 안내 |
| --- | --- |
| 공개 계약·에이전트 클라이언트 | [도구 계약](docs/mcp-tools.ko.md) · [클라이언트 기능](docs/agent-clients.ko.md) |
| PC 파일 업로드 | [클라이언트 배포본·UUID 파일](docs/client-files.ko.md) |
| 설치·복구 | [설치·갱신](docs/install-workflow.ko.md) · [이전·복구](docs/deployment-180.ko.md) |
| 관리자 인증 | [한국어](docs/admin-login.ko.md) · [English](docs/admin-login.en.md) |
| 대상 설정 | [다중 대상](docs/multi-targets.ko.md) · [Windows](docs/windows-targets.ko.md) |
| 그래픽 데스크톱 | [설정](docs/desktop.ko.md) · [인증 상태](docs/desktop-auth-state.ko.md) |
| 비밀·Cloudflare 없는 연결 | [비밀 참조](docs/secret-management.ko.md) · [HTTPS](docs/non-cloudflare-https.ko.md) |
| 설계·검증 | [아키텍처](docs/architecture.ko.md) · [시험 계획](test/PLAN.md) · [로컬 브라우저 시험](docs/browser-testing.ko.md) |

일부 상세 문서는 버전별 과거 실행 기록을 보존합니다. 해당 기록은 고정한 환경의 근거이며 이후 릴리스의 포괄적 수용 결과가 아닙니다. v2.0.0은 정식 게시됐지만 호스트·GUI·파일 저장·아키텍처의 개별 조합은 각각의 실행 근거로 확인해야 합니다.

## 개발·패키징

개발할 때는 소스 작업 사본을 사용하며, 배포본 사용자가 패키지를 직접 빌드할 필요는 없습니다. 서버 시험은 프로젝트가 허용한 TEST/CI 환경에서, 브라우저 회귀는 안내에 따라 로컬 PC에서 실행합니다.

```sh
npm ci --ignore-scripts
npm run build:ui
npm test
python3 test/test_helper.py
```

서버·클라이언트 압축 파일을 만들 때는 아직 존재하지 않는 **새 절대 출력 디렉터리**를 지정합니다.

```sh
npm run package:release -- --output /absolute/new/portal-2.4.2-release
```

서버 압축 파일 이름은 `ssh-approval-portal-2.4.2.tar.gz`입니다.

패키징은 서버·클라이언트의 `.tar.gz`·`.zip`과 체크섬을 만듭니다. Node.js·cloudflared·인증 정보·사용자 세션은 포함하지 않습니다. 소스·fixture·실제 호스트·클라이언트 UI·배포 검사는 서로 다른 근거입니다. 명령이 있다는 이유만으로 시험이 통과했다고 판단하지 않습니다. 공개한 자산은 고정하고 사용 전에 릴리스 체크섬과 대조하세요.

## 라이선스

SSH Approval Portal은 [GNU Affero General Public License 3판 또는 (선택에 따라) 그 이후 판](LICENSE)(SPDX 식별자 `AGPL-3.0-or-later`)으로 배포합니다. 이 라이선스는 3.0.0과 그 뒤에 공개하는 모든 릴리스에 적용됩니다. 이전 판 계열의 후속 유지보수 릴리스도 포함합니다.

2.4.2 이하 릴리스는 MIT 라이선스로 공개되었습니다. MIT 조건은 이미 공개된 그 릴리스의 사본에만 계속 적용됩니다.

자체 라이선스 고지가 있는 파일은 그 라이선스를 유지합니다. 해당 파일은 `native/freerdp-input/`(Apache-2.0, FreeRDP 패치)과 Gradle wrapper(`java/gradlew`, `java/gradlew.bat`, `java/gradle/wrapper/`, Apache-2.0)입니다.

프로그램을 수정해 네트워크로 사용자에게 제공하면, 라이선스 13조에 따라 그 사용자에게 수정판의 대응 소스 코드를 받을 수 있는 방법을 제공해야 합니다.
