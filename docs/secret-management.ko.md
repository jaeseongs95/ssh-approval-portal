# 벤더 독립 시크릿 관리

시크릿 공급은 `resolve(secret://provider/name)` 포트로 분리한다. 앱은 읽기용 포트를 주입받고, 저장소는 모델 URL·SDK·SSH 승인 정책을 알지 못한다. POSIX 로컬 파일과 읽기 전용 Vault KV v2 어댑터를 제공한다.

관리 기능은 서버 관리자 CLI에 있다. HTTP/MCP에 원문 조회·등록 도구를 추가하지 않는다. 키 값은 관리자 터미널의 숨김 입력으로만 등록하며, 명령 인자·파이프 입력·파일 전송 카드로 받지 않는다. `list/status/set/delete` 출력은 참조와 revision·상태만 포함한다. 원문을 출력하는 `get` 명령은 없다. 참조명 자체는 공개 메타데이터이므로 이름에 비밀을 넣지 않는다.

## 네이티브 서버 사용

설치된 서비스 계정 `mcpbridge`의 기존 private parent 안에 저장소를 만든다. 아래 명령은 참조명만 포함한다. 키 입력과 확인은 사용자가 자신의 인증된 관리자 터미널에서 수행한다.

```sh
sudo -u mcpbridge /opt/ssh-approval/node/bin/node /var/lib/ssh-mcp/app/approval-bridge/scripts/manage-secrets.mjs --store /var/lib/ssh-mcp/.local/share/ssh-mcp/secrets init
sudo -u mcpbridge /opt/ssh-approval/node/bin/node /var/lib/ssh-mcp/app/approval-bridge/scripts/manage-secrets.mjs --store /var/lib/ssh-mcp/.local/share/ssh-mcp/secrets set secret://local-file/model-safety-api-key
```

root가 관리하는 `/etc/ssh-mcp-approval-bridge.env`에는 비밀 값 대신 아래 참조 설정을 넣는다. 활성화와 재시작은 서버 owner 절차에 따라 실행한다. 기존 `JEV_API_KEY`가 있으면 호환 경로가 우선하므로 참조로 전환할 때 기존 값의 보관·폐기는 관리자가 별도로 확인한다.

```dotenv
BRIDGE_SECRET_STORE_DIR=/var/lib/ssh-mcp/.local/share/ssh-mcp/secrets
BRIDGE_JEV_KEY_REF=secret://local-file/model-safety-api-key
BRIDGE_JEV_ENABLED=true
BRIDGE_JEV_MAX_CALLS=100
```

관리 명령의 마지막 부분을 `status secret://local-file/model-safety-api-key`, `list`, `delete secret://local-file/model-safety-api-key`로 바꿔 상태 확인·목록·삭제를 수행한다. 같은 참조의 `set`은 새 revision으로 교체한다. 앱은 시작 시 값을 읽으므로 교체와 삭제 후 서비스를 재시작해야 한다. 실행 중인 프로세스의 이전 값이나 공급자 쪽 키는 이 CLI가 자동 폐기하지 않는다. 원문을 채팅이나 도구 출력으로 확인하지 않는다.

## Vault KV v2 사용

Vault 관리자가 KV v2의 `secret/data/model-safety-api-key` 한 경로에 `read`만 허용한 토큰을 준비한다. 서비스에는 키 쓰기·삭제·토큰 관리 권한을 주지 않는다. KV 데이터는 `{"value":"관리자가 등록한 모델 키"}` 형식이다. 실제 값은 자신의 Vault 관리 도구로 등록하며 채팅에 보내지 않는다.

앞의 숨김 입력 CLI에서 참조를 `secret://local-file/vault-reader-token`으로 바꿔 Vault 토큰을 등록한다. ENV에는 다음 공개 설정만 추가한다. 기존 `JEV_API_KEY`가 있으면 그 값이 우선한다.

```dotenv
BRIDGE_SECRET_STORE_DIR=/var/lib/ssh-mcp/.local/share/ssh-mcp/secrets
BRIDGE_VAULT_URL=https://vault.example.test
BRIDGE_VAULT_MOUNT=secret
BRIDGE_VAULT_TOKEN_REF=secret://local-file/vault-reader-token
BRIDGE_JEV_KEY_REF=secret://vault/model-safety-api-key
BRIDGE_JEV_ENABLED=true
```

URL은 경로·계정·쿼리 없는 HTTPS origin이며 mount와 참조 이름은 한 단계 이름만 허용한다. 토큰 참조는 반드시 `local-file`이어야 한다. TLS는 Node의 CA·호스트명 검증을 사용한다. 사설 CA는 운영자가 서비스의 Node 신뢰 설정으로 관리하며 인증서 검증을 끄지 않는다. 이 연결 설정은 관리자 ENV 편집 화면의 지원 필드와 별개인 서버 초기 설정이다.

시작할 때 최신 KV 버전만 읽는다. 모델 키 교체·삭제·destroy 또는 Vault 토큰 취소 뒤에는 서비스를 재시작해야 실행 중인 앱의 이전 모델 키가 사라진다. soft delete된 최신 버전 대신 과거 버전을 읽지 않는다. Vault 토큰 취소는 Vault 읽기를 막는 조치이며, 이미 읽은 모델 키를 Jev에서 폐기하는 조치와 다르다. 즉시 차단이 필요하면 모델 키 발급처에서도 키를 폐기하고 서비스를 재시작한다. JavaScript 메모리의 secure erase를 보장하지 않는다.

읽기는 redirect·재시도 없이 한 origin으로 제한하며 네트워크 전체 기한 5초, 헤더 16 KiB·본문 64 KiB·모델 키 16 KiB 상한을 적용한다. 장애·권한 거절·잘못된 응답·누락 키는 모델 미설정으로 처리하고 원문 응답이나 토큰을 오류에 넣지 않는다. 모델에 의존하는 자동승인은 권한을 얻지 못하지만, 사용자가 명시적으로 등록한 사전승인은 기존 규칙대로 처리한다.

전환 전에 기존 ENV와 시크릿 참조를 운영자의 보호된 백업에 보관한다. Vault를 지원하지 않는 이전 코드로 되돌릴 때는 `BRIDGE_VAULT_*` 설정과 `BRIDGE_JEV_KEY_REF`도 그 코드가 지원하는 기존 설정으로 복원해야 한다. 이전 버전의 설정 파서는 새 항목을 거부할 수 있으므로 코드만 되돌리는 것으로 설정 호환성을 보장하지 않는다. 이 어댑터는 ENV·모델 키·Vault 데이터의 복구나 삭제를 자동 실행하지 않는다.

## 로컬 파일 저장·실패 경계

저장소와 직접 상위 디렉터리는 현재 effective UID 소유의 canonical 0700 경로여야 하고 record는 0600 일반 파일이어야 한다. 루트부터 모든 조상은 root 또는 현재 UID 소유의 실제 디렉터리여야 한다. group/other 쓰기 권한은 sticky 디렉터리에서만 허용한다(`/tmp`의 소유 항목 보호). symlink·추가 hardlink·다른 UID·느슨한 권한은 거부한다. 첫 backend의 권한 보장은 POSIX 환경을 대상으로 하며 Windows에서는 이 backend를 활성화하지 않는다.

쓰기·삭제는 `.write-lock`으로 직렬화한다. 새 파일을 fsync하고 rename한 뒤 디렉터리를 fsync한다. 독자는 이전 또는 새 완전한 record를 읽는다. rename/삭제 이후 동기화 실패 또는 성공한 작업의 lock 정리 실패는 `commit_uncertain`이므로 자동 재시도하지 말고 `status`로 revision을 확인한다. 작업 오류와 정리 오류가 함께 나면 원래 작업 오류를 보존한다. 실패·프로세스 강제 종료 뒤 lock이나 `.pending-` 파일이 남을 수 있다. 자동으로 잠금을 우회하지 않으며 관리자만 활성 writer가 없음을 확인한 후 해당 잔류 파일을 정리한다.

이 backend는 OS 권한으로 보호하는 로컬 저장소이며 디스크 암호화·암호화된 백업·secure erase·동일 UID/root 침해 격리·JavaScript 메모리 zeroization을 제공하지 않는다. 백업·복원은 운영자의 비밀 관리 정책에 따른다. 기본 `.gitignore`는 저장소 내용을 일반적인 Git 추가에서 제외하고, 패키저는 `secret-record` JSON을 발견하면 거부한다. 권한 있는 사용자의 강제 추가·다른 형식 복사를 막는 통제는 아니다. Cloud 네트워크 시크릿 placeholder를 이 저장소로 복사하지 않는다.

공급자 장애나 없는 키는 Jev 미설정으로 처리한다. 새 실행 권한이나 owner 승인 우회는 생기지 않으며, 키 등록 성공·코드 설치·실제 모델 호출·모델 품질 검증은 각각 별도로 확인한다.
