# SSH Approval Portal 0.3.0

[English](README.md) · [관리자 로그인](docs/admin-login.ko.md) · [에이전트 파일 업로드](docs/agent-upload.ko.md) · [구조와 호환성](docs/architecture.ko.md)

SSH 명령과 파일 전송을 사용자가 확인하고 승인할 수 있는 MCP 서버입니다. ChatGPT·Claude의 MCP Apps 카드와 웹 관리자 화면을 함께 제공합니다. 현재 중계기 하나는 SSH 대상 하나에 연결합니다. 다중 서버 지원은 아직 설계 단계이며 구현된 기능이 아닙니다.

현재 버전은 **0.3.0 후보**입니다. 승인 규칙을 유지하며 도메인·애플리케이션·어댑터의 세 계층으로 책임을 분리합니다. 기존 클라이언트 시험, 새 에이전트 업로드 관측과 구조 변경의 로컬 검증은 구분해 기록합니다.

| 구분 | 확인한 범위와 남은 제약 |
| --- | --- |
| ChatGPT 웹 | 기존 카드의 실제 승인·거부와 PC 파일 업로드·다운로드 왕복을 확인했습니다. |
| Claude 데스크톱 앱 | 기존 카드의 실제 승인·거부와 PC 파일 업로드·다운로드 왕복을 확인했습니다. |
| ChatGPT 데스크톱·Claude 웹 | 전체 기능을 실제 클라이언트에서 확인하지 않았습니다. |
| ChatGPT `request-upload` | 실제 파일 입력이 `upload-source-not-configured` 응답과 공급자 hostname 반환까지 도달했습니다. 공급자 파일 가져오기·승인·SSH 왕복은 이 관측으로 확인되지 않았습니다. |
| Claude 자동 파일 전달 | 실제 시험에서 `file_uuid`와 빈 `download_url`이 전달되어 입력 검증에 실패했습니다. 샌드박스의 대상 HTTPS 연결도 proxy CONNECT 403으로 차단됐습니다. 자동 전송은 지원하지 않습니다. |
| 로컬 구조 변경 | 현재 변경의 통합 시험 결과는 별도 검증 기록으로 확인해야 합니다. 과거 후보의 47개 로컬 시험을 현재 변경의 통과 근거로 쓰지 않습니다. |

파일 공급자 허용 목록은 비어 있고, 카드 승인은 `BRIDGE_UI_ENABLED=false`, 웹 관리자 인증은 `BRIDGE_ADMIN_AUTH_MODE=token`이 기본값입니다. 기존 클라이언트 시험의 성공을 새 에이전트 업로드나 다른 플랫폼의 성공으로 해석하지 않습니다.

## 승인과 파일 전송

일반 조회와 sudo를 쓰지 않는 일반 다운로드는 즉시 처리합니다. 그 밖의 모든 명령, 업로드·덮어쓰기와 sudo 전송은 사용자가 카드 또는 웹에서 승인한 뒤 한 번만 실행합니다. 승인 전에 대상 서버로 업로드 바이트를 보내거나 목적지 파일을 변경하지 않습니다.

`ui-*` 도구는 카드 전용이며 승인 티켓을 모델 응답에 노출하지 않습니다.

| 도구 | 동작 |
| --- | --- |
| `read-command` | 읽기 전용으로 판정된 명령을 실행합니다. |
| `run-command` | 읽기 전용 명령은 즉시 실행하고, 나머지는 승인 대기에 등록합니다. |
| `get-request-status`·`show-approval` | 요청 상태를 조회하고 승인·거부 카드를 표시합니다. |
| `show-file-transfer` | PC 파일을 선택해 업로드하거나 서버 파일을 내려받는 카드를 표시합니다. |
| `request-download` | 일반 파일을 내려받거나 sudo 다운로드 승인을 요청합니다. |
| `request-upload` | ChatGPT/OpenAI의 `download_url`·`file_id` 파일 입력을 임시 저장한 뒤 업로드 승인 대기에 등록합니다. Claude의 `file_uuid`만으로는 호출할 수 없습니다. |
| `show-ui-probe` | 명령이나 파일을 실행하지 않고 카드와 비공개 메타데이터 전달을 확인합니다. |

PC 파일은 카드에서 고르고 목적지 경로·덮어쓰기·sudo를 지정합니다. 중계기는 받은 바이트의 SHA-256과 설정을 고정해 승인 요청을 만듭니다. 새 `request-upload` 경로도 같은 승인을 거칩니다. 관리자가 실제 공급자의 정확한 hostname을 확인하고 허용하기 전에는 파일을 가져오지 않습니다. 설정과 클라이언트 제약은 [에이전트 업로드 안내](docs/agent-upload.ko.md)를 확인하세요. 로그인 쿠키, 임의 URL이나 채팅에 붙인 파일 바이트로 대신하지 않습니다.

파일 하나의 한도는 64 MiB, 임시 저장 총량의 기본값은 512 MiB입니다. `BRIDGE_TRANSFER_MAX_BYTES`는 64 MiB 이하로, `BRIDGE_TRANSFER_BUDGET_BYTES`는 파일 한도 이상으로 조절할 수 있습니다. 디렉터리·링크·장치 파일은 거부합니다. 폴더는 ZIP으로 전송하며 서버에서 자동으로 압축을 풀거나 파일을 실행하지 않습니다. 파일 스냅샷과 다운로드는 바이트를 마스킹하지 않습니다. 다운로드 링크는 10분·1회용이며 저장에 실패하면 카드에서 재발급합니다.

기존 파일의 소유권·모드·확장 속성을 보존할 수 없는 경우 덮어쓰기를 완료로 보고하지 않습니다. 새 파일의 모드는 0600이며 sudo 업로드는 root 소유입니다. 요청·파일·서버 변경, 만료 또는 재시작으로 유실된 요청에는 새 승인이 필요합니다. 연결 실패나 최종 반영 결과가 불명확한 작업은 자동으로 다시 실행하지 않습니다.

## 네이티브 설치와 업데이트

Ubuntu 22.04/24.04 x86_64·arm64, 인터넷 연결과 서버 관리자 터미널이 필요합니다. Node 24는 전용 경로에 설치하며 시스템 Node를 교체하지 않습니다.

```sh
tar -xzf ssh-approval-portal-0.3.0.tar.gz
cd ssh-approval-portal-0.3.0
sudo bash scripts/install.sh --admin-origin https://ssh-approve.example.com --grant-sudo-all
```

`--grant-sudo-all`은 `mcpops`에 비밀번호 없는 전체 sudo 권한을 부여합니다. 이 권한은 승인 중계기뿐 아니라 해당 SSH 계정의 다른 세션에도 적용됩니다. 옵션을 생략하면 일반 계정 권한으로 동작합니다. 기존 sudo 설정은 재작성하거나 삭제하지 않습니다.

기존 서버에서는 새 패키지로 `sudo bash scripts/install.sh`를 실행합니다. 먼저 대기·실행 요청을 마치거나 거부하세요. 기존 설정·토큰·SSH 키를 보존하며, UI 서명 키가 없는 설치에는 첫 업데이트 때 추가합니다. 설치 출력의 backup 경로를 사용해 `sudo bash scripts/rollback.sh BACKUP`을 실행하면 이전 버전으로 복원합니다.

기존 unit의 사용자 변경은 보존합니다. 관리 중인 ExecStart 패턴과 다르면 자동으로 덮어쓰지 않습니다. 원본 `ssh-mcp.service`는 설치하지 않습니다.

0.3의 업데이트·복원은 관리자 API에서 유지보수를 먼저 예약합니다. 실행·대기 요청이나 미완성 업로드가 있으면 예약을 거부하며, 예약 후 새 조회·승인·전송은 차단됩니다. 0.2에는 이 API가 없으므로 요청을 정리한 뒤 관리자 터미널에서 `sudo systemctl stop ssh-approval-bridge.service`를 실행하고 설치하세요. 예약 상태에서 설치 프로세스가 강제 종료되면 `sudo /opt/ssh-approval/node/bin/node scripts/maintenance.mjs release`로 해제할 수 있습니다.

## 연결과 카드 확인

- MCP는 기본 localhost 39124의 `/mcp`, 웹 관리자는 기본 localhost 39125에서 제공합니다. 보호된 설정의 `BRIDGE_MCP_PORT`·`BRIDGE_ADMIN_PORT`로 1–65535 범위의 포트를 지정할 수 있으며 유지보수·시작 검사는 같은 값을 사용합니다.
- HTTPS 도메인은 Cloudflare Tunnel 등으로 연결합니다. Cloudflare Portal의 upstream Bearer에는 `BRIDGE_MCP_TOKEN`을 연결하고 본인 전용 접근 정책을 유지합니다. 관리자 토큰은 upstream에 연결하지 않습니다.
- `BRIDGE_ADMIN_ORIGIN`은 웹 관리자 HTTPS origin과 문자 그대로 일치해야 합니다. 소문자 hostname의 정규 HTTPS origin만 허용하며 경로·끝 슬래시·query·fragment·사용자 정보는 넣지 않습니다. 다른 SSH 서버를 쓰려면 설정의 읽기·쓰기 프로필을 같은 서버·계정으로 지정하고 공개 호스트 키를 검증해 고정합니다. 파일 helper와 비공개 원격 임시 저장 경로도 해당 서버에 준비해야 합니다.
- Portal 일반 도구 모드의 server ID는 `ssh-approval-bridge`를 유지합니다. 도구 alias를 바꾸면 `BRIDGE_UI_TOOL_PREFIX`와 UI 도구 매핑을 점검하세요. ChatGPT에서는 도구를 새로고침하고 Claude에는 같은 본인 전용 Portal URL을 연결합니다.
- `show-ui-probe`를 호출해 카드에는 비공개 표식이 보이고 모델 응답·컨텍스트에는 나타나지 않는지 확인합니다. 각 클라이언트의 UI resource, `_meta`와 app-only 도구 전달도 확인해야 합니다.
- `BRIDGE_UI_ENABLED=false`가 기본값입니다. 사용할 환경의 시험과 독립 감사를 마친 뒤 root env에서 true로 바꾸고 서비스를 재시작합니다. 확인하지 않은 플랫폼에 카드 승인을 활성화하지 마세요.
- 관리자 시크릿은 `/etc/ssh-mcp-approval-bridge.env`에 모드 0600으로 저장합니다. 값은 채팅이나 명령 출력으로 보내지 마세요. 실제 키·토큰은 패키지에 포함하지 않습니다.

## 웹 관리자와 로그인

웹 화면은 대기 요청, 처리 이력과 실행 결과를 보여 줍니다. 연결 후 화면이 보이는 동안 10초마다 갱신하며 수동 조회와 승인·거부 뒤에는 바로 갱신합니다. 브라우저 언어가 `ko`로 시작하면 한국어, 그 밖의 언어는 영어로 표시합니다.

기본값은 관리자 토큰 인증입니다. Cloudflare·Google·GitHub 로그인은 Cloudflare Access를 통한 **웹 관리자 로그인**이며 SSH 로그인이나 MCP 연결 인증을 대신하지 않습니다. 제공자 설정과 실제 로그인을 시험한 뒤 Access 모드를 명시적으로 활성화합니다. 자세한 설정·접근 제한·복구 절차는 [관리자 로그인 안내](docs/admin-login.ko.md)를 확인하세요.

로그아웃하면 자동 조회를 멈추고 표시 중인 요청을 비웁니다. Access 모드에서는 Cloudflare Access에서 로그아웃하고, 토큰 모드에서는 현재 탭에 입력한 토큰을 지웁니다. 서버 토큰을 폐기하거나 이미 실행 중인 작업을 취소하지는 않습니다.

## Docker Compose 배포

운영 대상은 Ubuntu 22.04/24.04의 Docker Engine과 Compose v2입니다. 중계기는 비 root 사용자, 읽기 전용 root filesystem과 capability 제거 설정으로 실행합니다. SSH 계정·sudo·파일 helper는 대상 서버에 준비하며 컨테이너에 `--privileged`나 Docker socket을 주지 않습니다. `scripts/prepare-docker.sh`도 공유 `scripts/ensure-node-runtime.sh`로 호스트의 `/opt/ssh-approval/node`에 Node 24 런타임을 준비하며 시스템 Node를 교체하지 않습니다.

```sh
sudo bash scripts/prepare-docker.sh --admin-origin https://ssh-approve.example.com --grant-sudo-all
sudo docker compose --env-file /etc/ssh-approval-portal/compose.env -f docker/compose.yaml build
sudo docker compose --env-file /etc/ssh-approval-portal/compose.env -f docker/compose.yaml up -d --wait
```

현재 서버를 Compose로 옮길 때는 요청을 정리하고 `ssh-approval-bridge.service`를 먼저 중지하세요. helper 버전이 다르면 검증된 네이티브 업데이트를 먼저 적용합니다. 새 Compose 서비스가 정상 상태임을 확인한 뒤 기존 네이티브 unit의 자동 시작을 해제합니다. 같은 서버에서 두 방식에 같은 포트를 지정해 동시에 실행하면 충돌합니다. 기본 포트는 39124/39125입니다. 원본 `ssh-mcp.service`는 어느 방식에서도 설치하지 않습니다.

미리 빌드한 이미지는 릴리스 자산의 `VALIDATION.json`에서 실제 태그와 아키텍처를 먼저 확인하세요. `sudo docker load -i IMAGE.tar`로 불러온 뒤 `/etc/ssh-approval-portal/compose.env`의 `BRIDGE_IMAGE`를 그 태그로 맞추고, 위의 Compose 시작 명령에 `--no-build`를 추가해 실행합니다. 이미지에는 Node 24.21.0과 버전을 고정한 의존성 및 UI가 포함됩니다. amd64·arm64 이미지를 구분하세요. ARM64 에뮬레이션 시험은 실제 ARM 하드웨어 시험을 대신하지 않습니다.

토큰은 Compose 환경변수가 아니라 `/run/secrets/bridge_config` 파일로 전달합니다. 호스트 원본은 `/etc/ssh-approval-portal/docker-secrets.env`이며 서비스 계정만 읽을 수 있습니다. SSH 키·설정은 읽기 전용으로, audit와 전송 임시 저장은 별도 쓰기 경로로 마운트합니다. Linux host network로 기존 localhost SSH·Cloudflare 터널 경로를 유지합니다.

업데이트할 이미지를 먼저 준비한 뒤 `sudo bash scripts/compose-update.sh IMAGE_TAG_OR_DIGEST`를 실행하세요. 유지보수를 예약해 새 실행을 차단한 뒤 전환하며 시작 검사에 실패하면 이전 이미지 ID로 되돌립니다. 출력에 기록된 이전 이미지 ID를 같은 스크립트에 넘겨 복원할 수 있습니다. 이미지·전송 임시 저장과 시크릿을 `docker compose down -v`로 무조건 삭제하지 마세요. 새 업로드 설정을 모르는 이전 이미지로 복원할 때는 해당 버전에 맞는 보호된 설정 백업도 함께 복원해야 합니다.

## 검증과 상태 확인

```sh
npm ci --ignore-scripts
npm run build:ui
npm test
npx playwright install chromium
npm run test:browser
python3 test/test_helper.py
sudo bash scripts/status.sh
```

UI는 별도 `ui` 의존성으로 빌드하며 서버 SDK를 업그레이드하지 않습니다. UI와 웹의 모듈을 바꾸면 `npm run build:ui`로 배포 자산을 다시 만듭니다. 계층 경계·호환성·향후 시험 기준은 [구조 안내](docs/architecture.ko.md)와 [검증 계획](test/PLAN.md)에 정리했습니다. `test/docker-tests.ps1`은 합성 데이터로 격리된 Ubuntu 컨테이너를 생성·정리합니다. 실제 클라이언트의 카드·파일 저장, 플랫폼 파일 입력과 실제 ARM 하드웨어 시험은 각각 수행한 근거가 있을 때만 완료로 기록합니다.

릴리스의 `release-manifest.json`과 `SHA256SUMS`를 검증하세요. 패키지에는 node_modules, 실제 설정, 토큰, 개인키와 사용자 세션을 넣지 않습니다. 현재 후보의 시험 기록과 위 검증 범위를 함께 확인하세요. 공개 게시와 Cloudflare 설정 변경은 자동으로 수행하지 않습니다.
