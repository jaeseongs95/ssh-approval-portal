# 검증 연결

승인 코어: 사용자 클릭 전 0회, audit 저장 후 예약, 중복 클릭 1회, ticket kind/id/hash/target/flags/expiry 결속. oracle는 실제 executor 호출 횟수와 상태이며 Node test runner를 사용한다.

파일 staging: 원시 binary/빈 파일 바이트와 SHA 일치, 청크 중복/오순서/해시불일치/기한/파일한도/저장총량. 실제 임시 파일을 읽어서 비교한다.

HTTP/MCP: 실제 loopback StreamableHTTP 연결, Bearer 확인, 웹 Origin, UI 기본비활성화, 일반 결과에 private metadata 비포함. 이 테스트는 GPT/Claude 모델 전달 계약을 검증하지 않으며 해당 시험은 NOT_RUN 상태로 별도 유지한다.

파일 helper: Linux 임시 디렉터리의 실제 바이너리·빈 파일 업다운로드, overwritefalse와 mode, SHA불일치 기존파일 보존, symlink/FIFO/디렉터리 거부. root/sudo 경계는 Docker 시험에서 따로 검사한다.

환경 차이 episode: Windows에서 upload finish의 읽기전용 fd fsync는 EPERM. 검증용 파일 fd를 writable로 열어 fsync하도록 변경하며 Windows/Ubuntu 결과를 별도로 확인한다. 이전 Node raw 결과 6/7, Python helper 3/3; 변경후 다시 실행한다. 단순 변환 테스트를 전체 제품 완료 근거로 사용하지 않는다.

설치 패키지: Ubuntu22.04/24.04 isolated containers의 fresh/update/reinstall/failed-start/rollback, 실제 SSH 파일 roundtrip. ARM64 native boot와 실제 사용자 host UI 시험은 수행한 경우에만 PASS 기록.
