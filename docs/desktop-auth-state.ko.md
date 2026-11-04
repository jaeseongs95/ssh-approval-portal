# RDP 상시 연결 없는 Windows GUI 인증 경로

기존 SSH→loopback RFB 전송에 owner 전용 일회성 입력과 Ctrl+Alt+Delete 요청을 연결했다. 실제 로그인·SAS·agent fixture 입력은 아직 실행하지 않았다. SSH 공개키 인증이 Windows 로그인을 대신한다고 주장하지 않으며, 자율 GUI 완료 판정도 아니다.

## 제품 경로

관리 포털에서 데스크톱을 열고 로그인 화면과 대상 서버를 확인한다. Windows 로그인 입력란을 직접 선택한 뒤 확인란을 체크하고 비밀번호 형식 입력란의 값을 한 번 보낸다. 값은 전송 전에 화면에서 지운다. Enter는 자동 전송하지 않으며 화면 확인 후 직접 누른다. Ctrl+Alt+Delete 버튼도 같은 프레임·순서 검사를 거쳐 기존 RFB key event를 한 번 전송한다. `sent`는 Windows의 SAS 수락이나 로그인 성공을 의미하지 않는다.

`/api/desktop/authenticate`는 기존 관리자 인증·Origin·owner/epoch/target revision·프레임·geometry·sequence 검사를 사용한다. MCP 인증 도구는 추가하지 않는다. 물리 리소스의 단일 lease 때문에 모델은 owner lease 화면을 가져갈 수 없다. 모델 lease를 먼저 닫으면 owner가 포털에서 열 수 있다. lease 종료는 OS 로그아웃이 아니다.

입력값을 파일·설정·작업·장부·감사 payload·브라우저 저장소에 넣지 않는다. 최신 입력 영수증에는 값이나 값의 digest를 남기지 않고 인증 요청은 재전송하지 않는다. 처리 후 요청 buffer를 덮고 객체의 값 참조를 제거한다. JavaScript 문자열의 물리 메모리 즉시 소거까지 보장하지는 않는다. 기존 포털 TLS 경로가 필요하며 프록시의 별도 요청 본문 기록 여부는 미확인이다.

## 상태와 세션 결속의 한계

`desktop-status`와 lease 응답은 `transport_ready`, `auth_required`, `desktop_ready`, `capture_unavailable`를 구분한다. 고정된 Windows 읽기 명령은 부팅 세대, console session ID, WTS 상태와 잠금만 조회한다. 계정 이름·자격 파일·정책을 읽지 않는다.

`osSessionId`는 관측한 console ID이며 RFB 캡처 세션이라는 뜻이 아니다. 현재 어댑터는 세션·display·입력 검증을 모두 false로 반환하므로 `desktop_ready`를 만들어 내지 않는다. WTS 상태 generation이 바뀌면 과거 프레임을 폐기한다. 이 검사는 WTS와 캡처의 원자적 결속이나 두 관측 사이의 전환 방지를 보장하지 않는다. 관계없는 세션 변화도 프레임을 만료시킬 수 있다.

일반 로그인 화면은 모델도 볼 수 있다. 모든 조회 세션이 잠겼거나 세션이 없을 때 `auth_required`를 진단값으로 표시하며, console 잠금 하나로 다른 정상 세션을 인증 필요로 판단하지 않는다. 미검증 WTS 정보나 조회 실패만으로 별개 RFB 화면의 기존 입력 경로를 차단하지 않는다. 조회 실패는 `transport_ready`와 query blocker로 표시하며 캡처 실패라고 단정하지 않는다.

## TEST 인계: 미실행

로컬 제품 시험·로그인·서비스 변경은 하지 않았다. 로컬에서는 구문 검사만 허용된다. 생성된 `web/dist` 번들도 재빌드하지 않았으므로 TEST 후보 빌드로 최신 소스를 반영해야 한다.

1. TEST/CI에서 `node --test test/desktop-state.test.mjs test/desktop-service.test.mjs test/desktop-http.test.mjs test/mcp-contracts.test.mjs test/mcp180-bytes.test.mjs`를 실행한다. 회귀 소스는 일반 로그인 관측, owner 인증, 값 비반환·비재전송, SAS 순서와 기존 GUI 입력을 다룬다.
2. SAS 정책 단일 값·tvnserver 서비스 계정과 PID를 읽고 기존 SSH/RFB 어댑터로 잠긴 화면을 입력 없이 확인한다. 정책 허용과 SAS 실제 성공은 별개다. VNC 레지스트리 전체를 읽지 않는다.
3. 현재 TEST 포털의 desktop 설정은 `enabled:false`라고 전달받았다. 설정 변경은 이번 소스 구현에 포함되지 않는다. 이 상태에서는 새 UI로도 포털을 열 수 없다.
4. root가 승인한 TEST 후보에서 owner가 RDP 없이 화면 확인→필요한 SAS 한 번→일회성 자격 입력→직접 Enter→일반 데스크톱 확인을 수행한다. 비밀은 모델·결과물에 노출하지 않는다. 재부팅 후 인증은 기존 로그인 세션 유지와 구분한다.
5. owner lease를 닫고 agent가 새 fixture의 고유 화면을 관측한 뒤 고정 클릭·키 입력을 한 번 수행한다. fixture PID·실제 WTS session·WinSta0/Default·ready nonce와 전후 프레임·입력 결과를 연결한다. 예전 r14 결과나 session2를 재사용하지 않는다.

남은 판별 대상은 secure desktop 캡처, TightVNC SAS 수락, 로그인 입력 수락, 인증 후 캡처 세션, agent fixture 입력이다. 이를 하나의 ‘RDP 필요’ 오류로 묶지 않는다. 실제 session/display 결속의 호스트 증거도 미확인이다.

공식 근거: [Microsoft SendSAS](https://learn.microsoft.com/en-us/windows/win32/api/sas/nf-sas-sendsas)는 서비스/uiAccess와 SAS 정책 조건을 설명한다. [TightVNC Windows 서비스 설명](https://www.tightvnc.com/doc/win/TightVNC_for_Windows-Installation_and_Getting_Started.pdf)은 미로그인 접근과 Ctrl+Alt+Delete 정책을 다루지만 실제 2.8.90 설치의 성공 증거는 아니다. [Microsoft OpenSSH 키 인증 설명](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement)은 SSH 키 세션에 사용자 자격이 연결되지 않음을 설명한다.
