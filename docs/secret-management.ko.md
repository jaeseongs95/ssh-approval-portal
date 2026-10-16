# 벤더 독립 시크릿 관리

시크릿 공급은 `resolve(secret://provider/name)` 포트로 분리한다. 앱은 읽기용 포트를 주입받고, 저장소는 모델 URL·SDK·SSH 승인 정책을 알지 못한다. 현재 제공하는 backend는 POSIX 로컬 파일이며 다른 저장소는 같은 포트의 어댑터로 추가할 수 있다. 외부 비밀 저장소 연동을 구현했다고 표시하지 않는다.

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

## 저장·실패 경계

저장소와 직접 상위 디렉터리는 현재 effective UID 소유의 canonical 0700 경로여야 하고 record는 0600 일반 파일이어야 한다. 루트부터 모든 조상은 root 또는 현재 UID 소유의 실제 디렉터리여야 한다. group/other 쓰기 권한은 sticky 디렉터리에서만 허용한다(`/tmp`의 소유 항목 보호). symlink·추가 hardlink·다른 UID·느슨한 권한은 거부한다. 첫 backend의 권한 보장은 POSIX 환경을 대상으로 하며 Windows에서는 이 backend를 활성화하지 않는다.

쓰기·삭제는 `.write-lock`으로 직렬화한다. 새 파일을 fsync하고 rename한 뒤 디렉터리를 fsync한다. 독자는 이전 또는 새 완전한 record를 읽는다. rename/삭제 이후 동기화 실패 또는 성공한 작업의 lock 정리 실패는 `commit_uncertain`이므로 자동 재시도하지 말고 `status`로 revision을 확인한다. 작업 오류와 정리 오류가 함께 나면 원래 작업 오류를 보존한다. 실패·프로세스 강제 종료 뒤 lock이나 `.pending-` 파일이 남을 수 있다. 자동으로 잠금을 우회하지 않으며 관리자만 활성 writer가 없음을 확인한 후 해당 잔류 파일을 정리한다.

이 backend는 OS 권한으로 보호하는 로컬 저장소이며 디스크 암호화·암호화된 백업·secure erase·동일 UID/root 침해 격리·JavaScript 메모리 zeroization을 제공하지 않는다. 백업·복원은 운영자의 비밀 관리 정책에 따른다. 기본 `.gitignore`는 저장소 내용을 일반적인 Git 추가에서 제외하고, 패키저는 `secret-record` JSON을 발견하면 거부한다. 권한 있는 사용자의 강제 추가·다른 형식 복사를 막는 통제는 아니다. Cloud 네트워크 시크릿 placeholder를 이 저장소로 복사하지 않는다.

공급자 장애나 없는 키는 Jev 미설정으로 처리한다. 새 실행 권한이나 owner 승인 우회는 생기지 않으며, 키 등록 성공·코드 설치·실제 모델 호출·모델 품질 검증은 각각 별도로 확인한다.
