# 구조와 호환성

[English](architecture.en.md) · [README](../README.ko.md)

이 문서는 2.0.0 후보 소스의 책임 경계와 공개 계약을 설명한다. 구현된 계약, 실제 시험 결과, 실제 클라이언트·운영 배포의 확인 범위는 구분한다. 기능이 존재한다는 사실만으로 릴리스 또는 배포 검증이 끝났다고 판단하지 않는다.

## 계층과 조립 지점

| 위치 | 책임 | 경계 |
| --- | --- | --- |
| `src/domain/` | 승인·실행 상태 전이, 스케줄링, 용량·입력·데스크톱 lease 불변 조건 | filesystem·HTTP·환경변수·호스트 SDK를 직접 사용하지 않는다. |
| `src/application/` | 명령·소스·파일·이력·실행 한도·데스크톱·종료 사용 사례 | 주입된 저장소·실행기·공급자를 호출한다. MCP 응답과 HTTP 상태는 어댑터가 만든다. |
| `src/adapters/` | MCP·HTTP·설정·인증·감사·SQLite·artifact·SSH·RFB I/O | 외부 표현을 변환하고 자원을 획득·해제한다. |
| `src/contracts/ports.mjs` | 중립 결과·포트와 공통 한도 | `OperationOutcome`의 기본 필드는 `{failed,texts,data?,output?}`다. |
| `app.mjs`·`bridge.mjs` | 의존성 조립, 대상별 서비스 구성, 자산 로딩·기동 | 도메인 규칙과 전송별 라우트를 중복 구현하지 않는다. |

SSH vendor 내부 import는 `src/adapters/ssh/vendor.mjs`에 모으고 `ssh-mcp` 2.18.0 계약을 확인한다. 도메인과 애플리케이션은 MCP SDK나 vendor 프로필 객체를 공개 결과로 반환하지 않는다.

## 중립 도구와 승인 경계

`src/adapters/mcp/public-contract.mjs`가 `contractVersion: "2.0"`의 입력·출력 스키마와 응답 검증을 소유한다. 공개 도구와 2.0 UUID 파일 계약은 다음과 같다.

| 도구 | 계약 |
| --- | --- |
| `targets` | 대상 revision·실제 capability·파일 정책·한도 조회 |
| `submit` | `command`, 명시적 Python `source`, `download`를 안정된 `operationKey`로 제출 |
| `observe` | 같은 ID 또는 키로 상태 조회, 요청한 경우에만 출력 페이지 반환 |
| `cancel` | 같은 작업의 취소 요청; 반환 상태로 취소 완료 여부 확인 |
| `artifact-begin`·`artifact-chunk`·`artifact-status`·`artifact-finish` | 이미 접근 권한이 있는 바이트를 크기·SHA-256·대상 revision에 묶어 업로드 준비·제출 |
| `files` | UUID stat·대상 copy/move·임시 원본 remove; 최종 통합·검증은 별도 |
| `artifact-read` | 완료된 다운로드의 검증된 snapshot을 제한된 base64 페이지로 읽기 |

데스크톱 서비스가 조립되면 `desktop-open`, `desktop-status`, `desktop-observe`, `desktop-input`, `desktop-close` 5개를 추가 등록한다. 등록 여부와 별개로 대상 가용성은 capability·준비 상태·현재 정책으로 확인한다. `show-*` 3개는 모델과 앱에 보이는 카드 열기 도구이며 렌더링 resource가 있다. 소유자용 `ui-*` 6개만 app 전용이며 렌더링 resource 없이 비공개 metadata를 사용한다. 공개 스키마에 승인·다운로드 ticket이나 호스트 내부 객체를 넣지 않는다.

명령·관측·데스크톱 같은 원격 MCP 호출에 별도 로컬 서버나 카드는 필요하지 않다. PC 파일은 배포본의 `scripts/portal-files.mjs`가 owner 인증 HTTP로 직접 전송하고 UUID만 돌려준다. 기존 원격 MCP의 `files`가 UUID를 처리하므로 두 번째 로컬 stdio 서버는 선택 사항이다. 원격 서버는 PC 경로를 직접 읽지 않는다. 이미 확보한 소량 바이트용 `artifact-*`는 유지하지만 큰 파일을 모델 인자로 다시 쓰는 경로로 권장하지 않는다. [파일 클라이언트 안내](client-files.ko.md)를 따른다. 관리자의 에이전트 CLI 설치·로그인·업데이트는 별도 사용 사례다.

서버 정책과 유효한 소유자 승인이 실행 권한을 결정한다. 요청 ID는 접수 증거이며 실행 성공 증거가 아니다. 같은 키와 같은 불변 입력은 같은 작업을 조회하고 충돌 입력은 거부한다. 관측의 대기 시간 만료나 연결 해제는 작업을 취소하지 않는다. 불명확한 결과를 새 키로 재제출하지 않는다. `terminating`은 실행 자원이 남은 상태이고 `unknown`은 확인이 필요한 결과다.

## 영구 journal과 실행 큐

`src/adapters/storage/operation-store.mjs`의 `operations.sqlite`는 요청 키·불변 실행 계약·대상 revision·상태 version·이벤트를 저장한다. SQLite transaction과 version 비교로 접수·claim·결과 저장을 보호하며 외부 실행 전에 `starting`을 영구 기록한다. 같은 journal에 대한 두 번째 bridge의 동시 실행 권한은 거부한다. 저장소 자체는 SSH 명령을 실행하지 않는다.

`src/domain/operation-scheduler.mjs`는 준비된 대상 간 순환 순서와 전역·대상별 대기 및 실행 한도를 적용한다. `starting`, `running`, `terminating`을 실행 중으로 센다. 재시작 시 이 세 상태는 `unknown`으로 전환하고 자동 재실행하지 않는다. `unknown`과 충돌 자원은 별도 제한을 받는다. 영구 대기 작업도 현재 대상 revision·정책·만료·유지보수 조건을 다시 확인한다. 오래된 이력이 새 실행 권한을 만들지 않는다.

설치 기본값은 `os.availableParallelism()`의 가용 CPU 수를 `N`으로 하여 `queueCapacity=N*10`, `maxConcurrency=N`이다. `BRIDGE_QUEUE_CAPACITY`·`BRIDGE_MAX_CONCURRENCY`는 양의 safe integer로 지정한다. `BRIDGE_TARGETS`의 두 필드는 숫자 또는 `null`이며 누락·`null`은 전역값 상속이다. `requestCapacity`는 승인 요청 보관 한도로 실행 대기열 한도와 구분한다.

실행 중 관리자 변경은 `src/application/runtime-capacity.mjs`와 별도 `capacity.sqlite`가 소유한다. GET `/api/capacity`는 revision·가용 CPU·설정값·대상별 실효값·대기/실행 현황을 반환한다. POST는 `expectedRevision`을 요구하고 영구 compare-and-set 뒤 스케줄러에 반영한다. 설치 환경값은 초기값이며 저장된 실행 한도를 자동으로 덮어쓰지 않는다. 전역과 대상 한도를 함께 적용하고, 축소해도 실행 중인 작업을 강제 종료하지 않는다. 저장 응답을 잃은 관리 화면은 재저장 전에 명시적으로 다시 조회한다.

## SSH 연결과 파일 수명

SSH registry가 인증된 연결의 재사용·호스트 키·ProxyJump를 소유한다. 각 실행은 별도 exec/SFTP channel을 열며 다른 작업의 shell 상태를 이어 쓰지 않는다. channel 열기 거부가 누적되어 연결을 폐기 대상으로 표시해도 진행 중인 다른 channel을 끊지 않는다. 사용 중인 자원이 없을 때 뒤이은 별도 승인 작업이 새 연결을 획득한다. 명령 종료 코드·시간 초과·불명확한 원격 결과를 연결 복구 근거로 삼아 해당 작업을 재생하지 않는다.

`src/adapters/storage/artifacts.mjs`는 staging 바이트·예약량·manifest·완료·해제를 소유한다. 바이트와 manifest를 동기화하여 재시작 후 확인된 chunk만 복원하며, 확인되지 않은 꼬리는 되돌리고 metadata 없는 파일은 격리·진단한다. 영구 저장은 SSH 업로드 재실행 권한을 뜻하지 않는다. 업로드 승인은 파일명·크기·SHA-256·목적지·덮어쓰기·상승 권한·대상 revision에 묶인다.

파일당 최대 64 MiB, 기본 staging 총량 512 MiB, 승인 대기 1시간, staging·다운로드 링크 기본 10분을 적용한다. command output은 별도 저장소의 보존 시각과 출력 참조를 따르며 기본 TTL은 1시간이다. 공개 출력 페이지는 정제된 adapter 결과이고 원격 stdout/stderr 전체 수집을 보장하지 않는다. 만료·삭제된 바이트를 명령 재실행으로 복원하지 않는다. 구형 이력 이전과 재배포·복구는 [배포·구형 이력 이전 안내](deployment-180.ko.md)를 따른다.


2.0 UUID 경로는 owner API `POST /api/artifacts`로 수신을 예약하고 `PUT /api/artifacts/:uuid/chunks/:sequence`의 `application/octet-stream`과 `X-Chunk-SHA256`으로 바이트를 전송한다. `POST /api/artifacts/:uuid/complete`는 임시 저장 완료만 확인하고 `GET /api/artifacts/:uuid`는 공개 metadata를 읽는다. 내부 임시 경로를 응답에 넣지 않는다. owner 인증·Origin·만료 검사를 재사용하며 UUID 소지를 승인으로 취급하지 않는다.

UUID 원본과 대상 배치용 artifact를 분리한다. 서버 내부 스트림으로 기존 target-bound upload artifact를 만들고 기존 승인·Transfers·원격 helper를 사용한다. copy는 원본을 유지하며 move는 성공한 publication의 영구 근거를 확인한 뒤 원본을 소비한다. unknown 배치는 재실행하거나 원본 삭제 성공으로 처리하지 않는다. UUID mapping·청크 ACK·요청 provenance는 기존 manifest/journal 복구 경계를 따르며 신규 서버·클라이언트의 최종 통합·재시작 회귀는 별도 근거가 필요하다.

## 실제 OS 데스크톱

`src/application/desktop.mjs`는 owner·대상 revision·epoch에 묶인 배타적 lease와 frame·입력 순서를 관리한다. GUI lease를 작업 큐나 다른 소유자에게 재할당하지 않는다. 현재 MCP 공유 principal은 대상의 명시적 TEST bypass 권한을 요구한다. 관리자 HTTP 경로는 인증된 browser principal을 서버가 삽입한다. 대상에 `desktop: {enabled:true,port:...}`가 설정되고 backend가 연결되어야 열 수 있다.

전송 경로는 관리자 화면 또는 MCP → desktop 서비스 → RFB adapter → SSH `direct-tcpip` channel → 대상 loopback의 VNC 서버다. `direct-tcpip`는 인증된 SSH 안의 forwarding channel이다. 브라우저가 대상 VNC TCP 포트에 직접 접속하지 않는다. `src/adapters/desktop/rfb.mjs`는 RFB 3.8의 Raw·DesktopSize와 명시적으로 허용한 None security만 지원한다. SSH가 전송을 인증하지만 대상의 다른 로컬 사용자를 인증하지는 않는다. VNC 설치·OS 로그인·화면 세션 생성은 이 adapter의 책임이 아니다. PTY·터미널 출력으로 GUI 화면을 대신하지 않는다.

관측은 PNG와 `frameId`, 물리 화면 크기, `geometryRevision`, 다음 입력 순번을 반환한다. MCP는 PNG를 `content[1]`의 image로, frame metadata를 JSON으로 전달하며 관리자 HTTP는 PNG base64를 반환한다. 입력은 같은 session·epoch·관측 geometry에 단조 증가 sequence와 안정된 requestKey를 묶는다. 가장 최근의 동일 입력 재조회는 receipt만 반환하고 wire 입력을 재생하지 않는다. 불명확한 입력은 새 키로 자동 재입력하지 않는다. 닫기는 눌린 키·버튼 해제와 해당 channel 정리를 시도하며 `releaseSent`·`cleanupError`로 결과를 구분한다. OS 로그아웃이나 공유 SSH transport 종료는 하지 않는다.

관리자 뷰어는 클릭·단축키·텍스트를 지원하며 드래그는 지원하지 않는다. CSS에서 물리 framebuffer 좌표로 한 번만 변환하고 Tab은 브라우저 초점 이동으로 유지한다. 페이지 이동과 앱 로그아웃 때 닫기를 기다리고 서버 로그아웃은 해당 owner의 남은 lease만 정리한다.

## 관리자 화면·인증·다국어

관리자 인증 기본은 `token`이다. `access` 모드의 소유자 로그인, 파일 다운로드 자격, 유지보수 토큰의 경계를 유지한다. `config/settings-contract.json`은 공통 설정 계약이며 기본 두 포트는 39124/39125, 허용 범위는 1–65535다. origin 판정은 Node 24의 WHATWG URL을 기준으로 JavaScript·Python에서 일치시킨다.

화면의 파일 선택·초안·진행 상태는 현재 화면에 속한다. 이전 비동기 결과가 새 화면을 덮어쓰거나 주기 갱신이 초점·선택·스크롤을 지우지 않도록 관리한다. 로그아웃 동시 요청은 하나로 합치며 응답 손실 뒤 사용자가 명시적으로 다시 요청할 때만 세션 종료를 재시도한다.

`web/src/locale.js`는 BCP 47 locale을 정규화하고 ko/en 카탈로그·영어 폴백·이름 있는 자리표시자 문법을 검사한다. 한국어 원문 키를 유지하며 키의 언어 자체를 번역 결함으로 취급하지 않는다. 유효한 미지원 locale은 영어 메시지와 해당 locale의 `Intl` 숫자·날짜 형식을 사용한다. 명령·출력·정책·사용자 입력은 번역하지 않는다. 상세 규격은 [다국어 처리](i18n.ko.md)를 따른다.

## 검증 범위

소스 경계 시험, 실제 SSH 실행, 실제 OS GUI, 관리자 브라우저, 플랫폼 MCP 클라이언트, 패키지·설치·배포는 각각 별도 근거가 필요하다. 명령과 환경은 [검증 계획](../test/PLAN.md)을 따른다. 제품 시험은 승인된 TEST 서버·CI에서 실행한다. 아래 브라우저 결과는 과거 작업의 기록이며 이번 2.0 문서 수정에서 제품 시험을 실행하지 않았다.

2026-11-03 브라우저 검증은 기존 회귀의 중복 제거한 245개 사례와 신규 capacity·desktop 6개 사례를 여러 고정 commit·부분 실행으로 확인한 범위다. 단일 최종 SHA 전체 suite 통과를 뜻하지 않는다. 신규 6개는 실제 관리자 DOM 행동과 fixture API로 상속·CAS·응답 손실·입력 순번·닫기·로그아웃을 확인했으며 실제 VNC 서버·OS 입력의 증거가 아니다. 실제 CLI 공급자 설치·로그인·업데이트, Linux·Windows OS GUI, ChatGPT·Claude 카드·파일 입력, 외부 로그인, 실제 ARM 장비와 운영 배포는 해당 환경의 실행 기록으로 각각 판단해야 한다. 문서 갱신으로 미확인 범위를 완료로 바꾸지 않는다.
