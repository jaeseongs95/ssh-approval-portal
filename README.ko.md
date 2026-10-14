# SSH Approval Portal 0.3.0

명령 승인, 파일 업로드·다운로드와 GPT/Claude MCP Apps UI를 하나의 서버에서 처리합니다. 기존 웹 승인 화면을 유지합니다. 현재 산출물은 실제 호스트 검증 전 candidate입니다.

## 설치

Ubuntu 22.04/24.04 x86_64·arm64, 인터넷 연결, 서버 관리자 터미널이 필요합니다. Node 24를 전용 경로에 설치하며 시스템 Node를 교체하지 않습니다.

```sh
tar -xzf ssh-approval-portal-0.3.0.tar.gz
cd ssh-approval-portal-0.3.0
sudo bash scripts/install.sh --admin-origin https://ssh-approve.example.com --grant-sudo-all
```

`--grant-sudo-all`은 `mcpops`의 비밀번호 없는 전체 sudo 권한을 생성합니다. 이 권한은 승인 중계기 외의 해당 SSH 계정 세션에도 적용됩니다. 옵션을 생략하면 일반 계정 권한으로 동작합니다. 현재 서버의 기존 sudo 설정은 재작성하지 않습니다.

기존 서버 업데이트는 동일 패키지에서 `sudo bash scripts/install.sh`를 실행합니다. 대기·실행 요청을 먼저 정리하세요. 기존 설정·토큰·키를 보존하며 첫 업데이트에서 UI 서명 키만 추가합니다. 설치 출력의 backup 경로로 `sudo bash scripts/rollback.sh BACKUP`을 실행하면 이전 버전으로 복원합니다. 기존 sudo 설정을 삭제하지 않습니다.

기존 unit의 사용자 변경은 보존합니다. 관리 중인 ExecStart 패턴과 다르면 자동 덮어쓰지 않습니다. 원본 `ssh-mcp.service`는 설치하지 않습니다.

0.3의 업데이트·복원은 관리자 API에서 유지보수 예약을 먼저 잡습니다. 실행·대기 요청과 미완성 업로드가 있으면 거부하며, 예약 후 새 조회·승인·전송은 차단됩니다. 0.2에는 이 API가 없으므로 실행·대기 요청을 정리한 뒤 관리자 터미널에서 `sudo systemctl stop ssh-approval-bridge.service`를 실행하고 설치하세요. 예약 상태에서 설치 프로세스가 강제 종료되면 `sudo /opt/ssh-approval/node/bin/node scripts/maintenance.mjs release`로 해제할 수 있습니다.

## 연결 및 UI 검증

- MCP: localhost 39124 `/mcp`; 웹 관리자: localhost 39125.
- HTTPS 도메인은 Cloudflare Tunnel 등으로 연결합니다. Cloudflare Portal은 upstream Bearer에 `BRIDGE_MCP_TOKEN`을 바인딩하고 본인 전용 접근 정책을 유지합니다. 관리자 토큰은 upstream에 바인딩하지 않습니다.
- `BRIDGE_ADMIN_ORIGIN`은 실제 웹 관리자 HTTPS origin과 일치해야 합니다. 다른 원격 SSH 서버를 쓸 때는 config의 두 profile을 같은 서버·계정으로 지정하고 공개 호스트 키를 검증해 pin합니다. 파일 helper와 private remote staging은 해당 서버에도 설치해야 합니다.
- Portal 일반 도구 모드에서 server ID `ssh-approval-bridge`를 유지합니다. 도구 alias를 바꾸면 `BRIDGE_UI_TOOL_PREFIX` 및 UI 도구 매핑을 점검하세요. GPT에서 기존 SSH Approval Portal 도구를 새로고침하고 Claude에는 같은 본인 전용 Portal URL을 연결합니다.
- `show-ui-probe`를 호출합니다. 카드에 private marker가 보이고 모델 응답·컨텍스트에는 나타나지 않는지 GPT/Claude 각각 확인합니다. UI resource, `_meta`, app-only 도구 전달도 확인해야 합니다.
- `BRIDGE_UI_ENABLED=false`가 기본값입니다. 위 시험과 독립 감사 후 root env에서 true로 바꾸고 서비스를 재시작합니다. 확인하지 않은 플랫폼에 UI 승인을 활성화하지 마세요.
- 관리자 시크릿은 `/etc/ssh-mcp-approval-bridge.env`(0600)에 있습니다. 값은 채팅이나 명령 출력으로 보내지 마세요. 실제 키·토큰은 패키지에 들어 있지 않습니다.

## Docker Compose 배포

운영 대상은 Ubuntu 22.04/24.04의 Docker Engine과 Compose v2입니다. 중계기는 비 root 사용자, 읽기 전용 root filesystem, capability 제거로 실행합니다. SSH 계정과 sudo·파일 helper는 대상 서버에 준비하며 컨테이너에 `--privileged`나 Docker socket을 주지 않습니다.

```sh
sudo bash scripts/prepare-docker.sh --admin-origin https://ssh-approve.example.com --grant-sudo-all
sudo docker compose --env-file /etc/ssh-approval-portal/compose.env -f docker/compose.yaml build
sudo docker compose --env-file /etc/ssh-approval-portal/compose.env -f docker/compose.yaml up -d --wait
```

현재 서버를 옮길 때는 대기·실행 요청을 정리하고 `ssh-approval-bridge.service`를 먼저 중지하세요. helper 버전이 다르면 검증된 네이티브 업데이트를 먼저 적용합니다. 새 Compose 서비스가 건강한 것을 확인한 뒤 기존 native unit을 자동 시작 해제합니다. 같은 서버에서 두 방식을 동시에 실행하면 39124/39125 포트가 충돌합니다. 원본 `ssh-mcp.service`는 어느 방식에서도 설치하지 않습니다.

이미지 파일을 제공받은 경우 `sudo docker load -i IMAGE.tar`를 실행하면 빌드 대신 사용합니다. 이미지에는 Node 24.21.0과 잠긴 의존성 및 UI가 포함됩니다. amd64·arm64 이미지를 구분하며 ARM64 에뮬레이션 시험은 native ARM 하드웨어 시험으로 표현하지 않습니다.

토큰은 Compose 환경변수가 아니라 `/run/secrets/bridge_config` 파일로 바인딩합니다. 호스트의 원본은 `/etc/ssh-approval-portal/docker-secrets.env`이며 서비스 계정만 읽을 수 있습니다. SSH 키·설정은 읽기 전용 마운트, audit와 전송 임시 저장은 별도 쓰기 마운트입니다. Linux host network로 기존 localhost SSH·Cloudflare 터널 경로를 유지합니다.

업데이트할 이미지를 먼저 준비한 뒤 `sudo bash scripts/compose-update.sh IMAGE_TAG_OR_DIGEST`를 실행하세요. 새 실행을 차단하는 유지보수 예약을 잡은 뒤 전환하며 시작 검사 실패 시 이전 이미지 ID로 되돌립니다. 출력에 기록된 이전 이미지 ID를 같은 스크립트에 넘기면 복원할 수 있습니다. 이미지·전송 임시 저장과 시크릿은 `docker compose down -v`로 무조건 삭제하지 마세요.

## 파일과 승인

일반 조회와 일반 다운로드는 즉시 처리합니다. 기타 모든 명령, upload/overwrite 및 sudo 전송은 승인 후 한 번만 실행합니다. 업로드는 카드에서 PC 파일을 고르고 path/overwrite/sudo를 정한 뒤 전송합니다. 받은 바이트의 SHA와 설정을 고정한 요청이 생성됩니다. 서버 대상 파일은 승인 전 변경되지 않습니다.

단일 파일 64 MiB, staging 총 512 MiB가 기본값입니다. `BRIDGE_TRANSFER_MAX_BYTES`는 64 MiB 이하로, `BRIDGE_TRANSFER_BUDGET_BYTES`는 그 이상으로 조절할 수 있습니다. 디렉터리·링크·장치 파일은 거부하며 폴더는 ZIP으로 전송합니다. snapshot/download는 바이트를 마스킹하지 않습니다. 다운로드 링크는 10분·1회용이며 저장 실패 시 카드에서 재발급합니다.

기존 파일의 소유권·모드·확장 속성을 보존할 수 없는 경우 overwrite를 완료로 보고하지 않습니다. 새 파일은 0600이며 sudo 업로드는 root 소유입니다. 요청·파일·서버 변경, 만료, 재시작 유실은 새 요청이 필요합니다. 연결 실패나 불명확한 publish 결과를 자동 재실행하지 않습니다.

## 검증 및 상태

`npm ci --ignore-scripts && npm test`, `python3 test/test_helper.py`, `sudo bash scripts/status.sh`를 사용합니다. UI 빌드는 별도 `ui` 의존성으로 하며 서버 SDK를 업그레이드하지 않습니다. `test/docker-tests.ps1`은 합성 데이터의 isolated Ubuntu containers를 생성·정리합니다. 실제 client UI 및 arm64 native 시험은 실행된 근거가 있을 때만 완료로 보고합니다.

릴리스의 `release-manifest.json`과 `dist/SHA256SUMS`를 검증하세요. package에는 node_modules, 실제 설정, 토큰, 개인키, 사용자 세션이 없습니다. 테스트 결과와 현재 검증 공백은 제공된 검증 기록을 기준으로 확인하세요. 공개 게시와 Cloudflare 설정 변경은 자동 수행하지 않습니다.
