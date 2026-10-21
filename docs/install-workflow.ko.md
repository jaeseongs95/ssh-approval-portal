# 설치·연결·검증·복구 진입점

Ubuntu 22.04/24.04의 네이티브 설치를 `python3 scripts/portal.py`에서 진행합니다. 기존 설치·잠금·백업·복구 스크립트를 사용하며 정책을 자동으로 켜지 않습니다. Docker/Compose 호스트 설치는 기존 전용 도구를 사용합니다.

먼저 실행 계획을 확인합니다. `--dry-run`은 관리자 권한이나 설치된 서버 없이 사용할 수 있으며 파일·서비스·네트워크를 변경하지 않습니다. JSON의 `argv`는 실제 실행할 인자 배열입니다. Windows에서 확인한 경로는 Windows 경로이므로 실제 설치할 Ubuntu에서도 계획을 확인하세요.

```bash
python3 scripts/portal.py install --admin-origin https://approve.example.com --dry-run
sudo python3 scripts/portal.py install --admin-origin https://approve.example.com
```

최초 설치에만 `--grant-sudo-all`을 명시적으로 선택할 수 있습니다. 이 옵션은 MCP 계정에 비밀번호 없는 전체 sudo를 부여합니다. 지정하지 않으면 부여하지 않습니다. 갱신에는 이 옵션이나 새 origin을 전달할 수 없고 기존 ENV·정책·키를 유지합니다.

```bash
python3 scripts/portal.py update --dry-run
sudo python3 scripts/portal.py update
```

필요한 연결 기능을 선택합니다. `access`는 기존 Cloudflare 소유자 인증 설정, `upload-sources`는 업로드 원본 허용 호스트 설정이며 관리자 터미널에서 대화식으로 입력합니다. 키나 토큰을 명령행 인자에 넣지 않습니다. `env-editor`는 ENV 관리 소켓을 설치합니다. 각 단계 뒤에 패키지와 서비스 health를 검사합니다. 외부 DNS·터널·OAuth 제공자 등록은 이 CLI가 생성하지 않으며 실제 로그인은 별도 확인해야 합니다.

```bash
sudo python3 scripts/portal.py connect access
sudo python3 scripts/portal.py connect upload-sources
sudo python3 scripts/portal.py connect env-editor
```

개발 중인 `python3 scripts/portal.py connect cloudflare --config connection.json --dry-run`은 DNS·터널·Access·MCP·OAuth 연결 계획만 표시합니다. `--dry-run`을 빼면 터미널에서 API 토큰을 숨김 입력으로 받아 계정·zone·조직과 기존 이름의 충돌을 읽기 검사합니다. 두 경로 모두 외부 자원이나 서버 설정을 변경하지 않으며, 검사 성공도 자원 생성·로그인 완료를 뜻하지 않습니다. `--config`를 생략하면 공개 설정을 대화형으로 입력합니다. JSON에는 `accountId`, `zoneId`, `zoneName`, `name`, `adminHostname`, `originHostname`, `portalHostname`, `ownerEmails`, `redirectUris`, `adminPort`, `mcpPort`만 넣고 비밀값은 넣지 않습니다.

신규 자원 생성과 부분 실패 정리는 개발 중입니다. Linux 대화형 터미널에서 `--apply --state-dir 새폴더`를 명시하면 쓰기 권한의 API 토큰과 기존 MCP bearer 토큰을 숨김 입력으로 받습니다. 실행 폴더는 새로 만들고 소유자만 읽고 쓸 수 있게 하며 기존 폴더를 생성 재시도에 사용하지 않습니다. 관리자 Access 정책을 먼저 만든 뒤 터널·DNS·서버별 정책·MCP·포털 OAuth를 구성합니다. 서버 ENV·정책 파일이나 기존 Cloudflare 자원을 갱신하지 않습니다.

```bash
python3 scripts/portal.py connect cloudflare --config connection.json --apply --state-dir /private/new-connection
python3 scripts/portal.py connect cloudflare --cleanup --state-dir /private/new-connection
```

포털 생성 API가 Access 앱을 함께 만들지 않으면 계획에 표시된 전용 앱을 별도로 만듭니다. 자동 생성된 앱이 있으면 기존 목록에 없던 정확한 포털 주소의 앱 한 개만 확인하며, 다른 앱이나 와일드카드와 겹치면 중단합니다. 포털 ID는 후속 앱 조회 전에 실행 기록에 저장합니다.

`--cleanup`은 이번 실행이 만든 자원만 현재 설정과 대조한 뒤 역순으로 정리합니다. 기존 자원을 가져와 관리하지 않으며 실행 기록은 직접 생성한 폴더만 사용하세요. 명확히 거절된 요청은 생성된 앞 단계들을 정리할 수 있습니다. 생성 응답이 끊기거나 완료 기록 전에 프로세스가 종료되면 자동 재전송·삭제를 중단하고 확인을 요구합니다. 삭제 응답이 불명확한 경우에는 같은 DELETE를 다시 보내지 않고, 정확한 자원 조회와 성공한 전체 목록에서 삭제 상태를 함께 확인한 경우에만 계속합니다. 조회 실패·목록 잔존·새 포털 관련 앱 발견 시에는 중단합니다. `ACTION_REQUIRED`의 `code`와 보호된 `state.json`에서 멈춘 단계를 확인하세요. 정상 생성 결과도 `RESOURCES_CREATED_CONNECTION_REQUIRED`이며 connector 설치·ENV 연결·실제 로그인을 마쳤다는 뜻이 아닙니다. 실계정 설치 전체 흐름과 로그인 검증은 아직 완료하지 않았습니다.

실행 기록에는 요청에 없던 추가 설정까지 감지하도록 읽기 가능한 구성도 저장합니다. 알려진 생성 시각 등 부가 정보와 계산된 MCP 상태·capability는 비교에서 제외하되, 모르는 설정 필드는 비교합니다. 터널 생성 응답의 문서화된 `token`·`credentials_file`은 저장하거나 해시하지 않고 버리며 공개 ID·설정만 기록합니다. 터널의 `config_src=cloudflare`와 `remote_config=true`는 같은 관리 형태로 비교하고 모순된 응답은 거부합니다. 다른 비밀 필드나 입력한 토큰이 공개 구성에 포함되면 저장을 중단하며 write-only 비밀값 자체를 읽거나 비교하지 않습니다. 생성 폴더의 부모 항목도 첫 원격 쓰기 전에 동기화합니다. 기록의 소유자·권한·계획 결속 검사는 파일 내용 전체를 임의로 위조할 수 있는 동일 OS 사용자에 대한 인증 장치가 아닙니다.

전용 connector는 기존 cloudflared 서비스를 덮어쓰지 않고 새 unit을 만듭니다. 새 서버에서는 `--install-cloudflared`를 명시해 공식 2026.10.1 바이너리를 검증·설치할 수 있습니다. 이미 설치된 `cloudflared` 2025.4.0 이상을 쓸 때는 대신 `--cloudflared /usr/bin/cloudflared`를 지정하세요. 두 방식은 동시에 선택하지 않습니다. 실행파일은 root 소유의 공용 경로에 있어야 하며 서비스에서 숨겨지는 `/root`·`/home`은 사용할 수 없습니다. 실제 계정·edge·로그인은 별도 검증입니다.

connector까지 이어갈 실행 기록은 처음부터 root로 생성하고 `/root`처럼 상위 경로도 root가 관리하는 위치에 보관하세요. 기존 관리 ENV의 관리자 origin·포트와 연결 설정이 일치하고 로컬 health·인증 거부 검사를 통과해야 합니다.

```bash
sudo python3 scripts/portal.py connect cloudflare --config connection.json --apply --state-dir /root/new-connection
sudo python3 scripts/portal.py connect cloudflare --connector --state-dir /root/new-connection --install-cloudflared
sudo python3 scripts/portal.py connect cloudflare --link-environment --state-dir /root/new-connection
sudo python3 scripts/portal.py connect cloudflare --sync-server --state-dir /root/new-connection
sudo python3 scripts/portal.py connect cloudflare --restore-environment --state-dir /root/new-connection
sudo python3 scripts/portal.py connect cloudflare --remove-connector --state-dir /root/new-connection
sudo python3 scripts/portal.py connect cloudflare --cleanup --state-dir /root/new-connection
```

`--connector --dry-run`은 파일이나 계정을 조회하지 않는 계획 표시입니다. 실제 설치는 해당 터널의 토큰만 숨김 API 인증으로 받아 root 전용 파일에 쓰며, 명령줄·JSON 기록·토큰 해시에 넣지 않습니다. 서비스는 `LoadCredential`과 `--token-file`을 사용합니다. `CONNECTOR_ACTIVE`의 `edgeConnected`는 별도 API 관측값이며 ENV나 로그인 완료를 뜻하지 않습니다. 연결은 전용 터널 연결 API의 전체 페이지에서 확인합니다. 응답이 불완전하거나 조회가 실패하면 실행 중인 서비스를 유지하고 연결 미확인으로 남기며, 원격 정리는 연결 부재를 확인하기 전까지 거부합니다. 시작 결과가 불명확하면 설치를 재전송하지 말고 명시적 제거로 상태를 확인하세요. 제거는 Cloudflare API 토큰을 요구하지 않으며 이번 unit·토큰 파일의 소유 정보와 변경 여부를 확인합니다. 파일 생성 후 소유 기록이 확정되기 전에 중단되면 자동 삭제하지 않고 확인을 요구합니다. connector 제거가 끝나기 전에는 원격 자원을 정리할 수 없습니다.

`--install-cloudflared`는 완료된 생성 기록·로컬 서비스·현재 원격 구성을 먼저 확인합니다. 공식 GitHub 릴리스의 amd64/arm64 파일을 크기·고정 SHA-256·버전과 대조한 뒤 `/opt/ssh-approval/cloudflared`에 게시합니다. HTTPS와 GitHub 공식 배포 host만 허용하며 API 토큰은 다운로드 요청에 전달하지 않습니다. 기존 파일은 덮어쓰지 않고, 같은 고정 버전이면 다시 검증해 재사용합니다. 다른 파일이나 권한·링크가 발견되면 중단합니다. apt 저장소·keyring·패키지나 기존 서비스를 변경하지 않습니다. 공용 바이너리 cache는 다른 connector도 재사용할 수 있어 connector 제거 후에도 남습니다. 도중에 강제 종료돼 임시 파일이나 링크가 남은 경우에는 자동 삭제하거나 덮어쓰지 말고 관리자가 경로와 소유 정보를 확인하세요.

터널 연결 전에 등록된 MCP 서버의 도구가 없거나 초기 동기화가 실패했다면, 연결 후 `--sync-server`로 이번 서버의 기능 목록만 한 번 갱신합니다. root 전용 실행 기록·실행 중인 전용 connector·로컬 인증·현재 원격 구성을 먼저 확인하며, API 토큰은 터미널에서 숨김 입력합니다. ENV·정책·인증키는 바꾸지 않습니다. `SERVER_SYNCED`는 서버 상태가 ready이고 도구가 발견됐다는 뜻이며 사용자 로그인 성공은 별도로 확인해야 합니다. `SERVER_SYNC_PENDING`이면 아직 준비되지 않은 상태입니다. 같은 실행 기록으로 다시 호출하면 조회만 하며, 응답이나 후속 검사가 불명확하면 자동 재전송하지 않고 `ACTION_REQUIRED`를 표시합니다.

ENV 연결·복원도 개발 중입니다. `--link-environment`는 같은 서버에서 실행 중인 전용 connector와 이번 관리자 Access 앱을 확인한 뒤 조직 issuer·앱 AUD·정확한 owner를 기존 관리자 인증 설정 도구에 전달합니다. Node 런타임과 설치된 패키지는 root가 관리하고 있어야 합니다. 관리자 인증 네 항목만 바꾸며 나머지 ENV는 보존합니다. 원본과 적용 예정 ENV는 실행 폴더의 root 전용 0600 파일로 보관하고, 공개 JSON·명령줄·출력·비밀 해시에는 넣지 않습니다. 저장·백업·유지보수 예약·재시작·실패 복구는 기존 도구를 재사용합니다.

`--restore-environment`는 API 토큰 없이 원래 ENV의 항목 존재·빈 값·줄바꿈까지 복원합니다. 현재 ENV가 연결 직후의 예상 파일과 다르면 이후 관리자 변경을 덮어쓰지 않고 중단합니다. 변경 요청 후 종료 상태가 불명확하면 같은 작업을 재실행하거나 자동 복원하지 말고 보호된 실행 기록을 먼저 확인하세요. ENV 연결을 복원하기 전에는 connector 제거와 원격 자원 정리를 거부합니다. `ENVIRONMENT_LINKED`는 로컬 설정 결과이며 실제 Cloudflare 로그인 완료를 뜻하지 않습니다.

로컬 검사는 실제 파일과 Node CLI, 셸의 백업·저장·오류·종료 후 복구를 확인합니다. 서비스 관리자와 bridge HTTP 응답을 흉내 낸 검사, 합성 토큰을 사용한 실제 systemd 검사, 공식 cloudflared 실행파일 검사와 실제 계정·edge·로그인 검증은 각각 구분합니다. 공용 바이너리 설치도 실제 서버·계정에 연결하기 전 별도 검증이 필요합니다.

네이티브 설치 도구는 Node를 실행하기 전에 부모 경로와 런타임 전체의 root 소유·쓰기 권한·파일 종류·내부 링크를 검사합니다. 공식 archive의 원래 UID를 가져오지 않도록 압축을 풀며, 비신뢰 런타임은 실행하거나 단순히 소유권만 바꾸지 않습니다. 새 다운로드의 checksum·파일·버전을 확인한 뒤 교체하고, 이전 런타임은 `/opt/ssh-approval/.node-previous.*/node`의 private 백업으로 보존합니다. 새 파일의 검증 실패 시 기존 경로를 유지하며, 최종 이동 실패 시 이전 경로로 되돌립니다. ENV·정책·키·데이터는 이 런타임 처리에서 변경하지 않습니다. 실제 서버의 런타임 교체와 운영 복구는 별도 실행 검증이 필요합니다.

정책 설정은 아래 명령으로 관리자 설정 주소를 확인하고, 해당 화면에서 대상·명령·sudo·전송·모델 허용 범위를 검토한 뒤 저장합니다. CLI는 `ACTION_REQUIRED`와 종료 코드 3을 반환합니다. 이는 정책이 저장됐다는 뜻이 아닙니다. 브라우저에서 기존 소유자 인증과 검토·저장 절차를 따릅니다.

Cloudflare 없이 OIDC 프록시를 준비한 서버에서는 `python3 scripts/portal.py connect oidc --dry-run`으로 계획을 확인한 뒤 `sudo python3 scripts/portal.py connect oidc`를 실행합니다. 공개 issuer·JWKS·client ID·owner만 입력받으며 기존 관리자 설정의 백업·충돌 검사·유지보수 예약·재시작·실패 복구를 재사용합니다. client secret과 프록시·인증서 설치는 이 명령의 대상이 아닙니다. Google 설정과 실제 로그인 검증 범위는 [OIDC 안내](oidc-https.ko.md)를 따릅니다. 이 명령은 명령·sudo·전송·모델 정책을 활성화하지 않습니다.

```bash
python3 scripts/portal.py policy --admin-origin https://approve.example.com
sudo python3 scripts/portal.py status
sudo python3 scripts/portal.py verify
```

갱신 실패의 복구는 기존 설치 스크립트가 담당합니다. CLI는 실패한 단계를 표시하고 추가 단계나 자동 재시도를 실행하지 않습니다. 성공했던 앞선 설정 작업까지 일괄 취소하지 않으므로 실패 결과를 확인한 뒤 다음 작업을 정하세요.

직접 복구할 때는 설치 결과에 표시된 정확한 백업 경로를 지정합니다. 백업은 관리되는 `backups` 바로 아래 폴더여야 합니다. 복구 뒤에는 복원된 서비스의 health를 확인하며 현재 소스가 복원된 이전 코드라고 가정하지 않습니다.

```bash
python3 scripts/portal.py rollback /var/lib/ssh-mcp/app/backups/백업이름 --dry-run
sudo python3 scripts/portal.py rollback /var/lib/ssh-mcp/app/backups/백업이름
```

로컬 검사는 `python3 -B test/test_portal_setup.py`로 인자·dry run·실패 중단·정책 미승인 동작을 확인합니다. `test/portal-container-test.sh`는 기존 native 설치 fixture의 합성 데이터·설정 보존·실제 SSH·복구 판정을 유지하면서 통합 CLI로 설치·갱신·재설치·실패 복구를 실행하는 격리 Linux 컨테이너용 driver입니다. 실제 실행 결과가 없으면 로드맵에서 완료로 표시하지 않습니다.
