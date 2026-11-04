# 실제 GUI 데스크톱

사용 주체는 에이전트다. `targets`의 `gui`를 확인한 뒤 `desktop-open` → `desktop-observe` → `desktop-input` → 결과 재관측 → `desktop-close` 순서로 사용한다. 실제 PNG 이미지와 같은 프레임의 metadata를 반환한다. 사용자가 PC의 RDP 창을 유지하거나 별도 GUI 서비스를 활성화할 필요는 없다. 클라이언트 벤더를 권한 판단에 사용하지 않는다.

## 준비 조건

- 관리자 소유 대상 설정의 `desktop.enabled:true`와 backend를 선택한다. 기본값은 비활성이다. 현재 agent 실행은 해당 대상의 TEST 우회 정책과 비밀 설정으로 권한을 확인하며, 관리자 호출은 인증된 owner 권한을 사용한다.
- Linux `xvnc`: 대상 SSH 계정으로 전용 Xvnc·Openbox·xterm과 수명 관리 helper를 시작한다. Python3, TigerVNC, Openbox, xterm과 X11 도구가 필요하다. 별도 X11 세션이며 기존 Wayland 화면 공유 기능은 아니다.
- Windows `rdp`: Linux 중계기에서 전용 Xvnc와 네이티브 FreeRDP 클라이언트를 실행하고 기존 pinned SSH를 통해 같은 Windows 호스트의 `127.0.0.1:3389`에 접속한다. Windows의 RDP 지원과 정상 GUI 로그온 자격이 필요하다. SSH 공개키가 GUI 로그온을 대체하지 않는다.
- Windows 입력은 배포본의 전용 FreeRDP 런타임을 사용한다. 실행 파일·라이브러리의 manifest와 해시, 고정 upstream·패치와 입력 프로토콜을 확인하며 시스템에 설치된 다른 FreeRDP로 대체하지 않는다. 런타임이 없거나 맞지 않으면 원인을 구분한 `DESKTOP_RDP_NATIVE_*` 오류를 반환한다.
- RDP 자격은 기존 비밀 저장소의 `credentialRef`로 읽는다. 저장값은 `{"username":"...","domain":"","password":"..."}` JSON이다. 모델·일반 로그·argv·환경변수에 넣지 않고 비공개 stdin으로 전달한다. RDP TLS는 유지하며 서버 식별은 실제 검증한 같은 호스트의 pinned SSH에 위임한다. 일반 네트워크 RDP로 전환하지 않는다.
- `rfb`는 기존 세션 공유다. 대상 loopback의 RFB3.8/None security가 필요하다. 같은 OS의 다른 로컬 사용자를 인증하지 않으므로 신뢰된 대상에서만 사용한다. OS 로그인·SAS·UAC를 자동 우회하거나 기존 세션을 생성·로그아웃하지 않는다.

대상별 설정 예:

```json
{"enabled":true,"backend":"xvnc","width":1280,"height":720}
{"enabled":true,"backend":"rdp","credentialRef":"secret://local-file/windows-gui"}
{"enabled":true,"backend":"rfb","port":5901}
```

관리 backend의 포트·실행 명령은 제품이 정한다. `configured`는 실제 로그온 성공을 뜻하지 않고 `backend_unavailable`은 필요한 네이티브 기능이 없다는 뜻이다. Windows 세션 결속을 확인하기 전에는 `desktop_ready`로 광고하지 않는다. 같은 Windows 계정의 재접속은 기존 사람 세션에 영향을 줄 수 있으므로 전용 시험 계정·서버를 사용한다.

### Windows 입력과 결과 확인

화면은 RFB로 관측하고 텍스트·키·포인터·release·close는 인증 stdin과 분리된 단일 네이티브 입력 채널로 보낸다. 숫자 필드는 BE로 직렬화하고 UTF-8을 UTF-16으로 엄격히 변환한다. ASCII·한글·surrogate pair를 보존하며 LF와 Tab은 각각 Return·Tab 입력으로 보낸다. NUL·CR·나머지 제어 문자와 modifier를 누른 상태의 텍스트는 전송 전에 거부한다. 클립보드는 사용하지 않는다.

네이티브 ACK의 `nativeSend`는 호출 순서와 전송 결과를 확인한 것이며 Windows 앱의 문자 소비나 파일 저장 성공을 뜻하지 않는다. 입력 후 화면이나 앱 결과를 다시 관측한다. 부분 실패·ACK 유실은 결과 불명으로 보존하고 자동 재전송하지 않는다. 정상 close는 native release·detach 확인 뒤 소유한 중계기 프로세스를 정리한다. 입력 detach와 프로세스 정리 결과는 구분하며 Windows 계정에서 로그아웃하지 않는다.

### Windows 전용 계정 준비

`scripts/provision-gui-account.mjs`는 등록된 Windows 대상의 SSH 관리자 권한으로 새 GUI 전용 계정을 준비한다. 기본 실행은 읽기 전용 점검이며, `--apply`를 명시한 경우에만 계정과 자격을 생성한다. 현재 `targets`에서 얻은 revision과 같은 대상을 지정해야 한다.

```sh
node scripts/provision-gui-account.mjs --target windows --expected-revision <현재64자리revision> --username ssh-gui-agent --secret-ref secret://local-file/windows-gui-agent
# 점검 결과와 대상 확인 후, 같은 명령에 --apply를 추가한다.
```

실행 주체는 중계기 서비스 계정이며 기존 서비스의 환경 설정을 사용한다. `BRIDGE_SECRET_STORE_DIR`가 설정되어 있어야 한다. 실행 계정이 읽을 수 없는 환경 파일의 권한을 넓히지 말고, 기존 서비스 관리자가 사용하는 EnvironmentFile 주입 경로를 사용한다.

새 계정은 Remote Desktop Users 그룹에만 추가한다. 기존 계정·같은 비밀 참조가 있으면 중단하며, 관리자 그룹·SAS·NLA·GPO·자동 로그온·기존 세션은 변경하지 않는다. 비밀번호는 무작위로 만들고 메모리와 비공개 stdin으로 전달한다. 모델·argv·환경 변수·일반 로그로 출력하지 않는다.

`local-file`은 서비스 계정 소유의 디렉터리 `0700`, JSON 파일 `0600`으로 접근을 제한하는 로컬 저장소다. 암호화 금고나 Windows 자격 증명 관리자를 뜻하지 않는다. 같은 UID 또는 root가 탈취된 상황까지 격리하지 않는다. 공개 응답은 `secret://local-file/<이름>` 참조와 operation ID·진행 상태만 제공한다.

원격 생성 결과가 불명확하거나 그룹·게시 단계에서 실패하면 비공개 자격과 상태를 남기고 멈춘다. 자동 재시도·기존 계정 삭제·비밀번호 초기화는 하지 않는다. 같은 인자에 `--status <operation ID>`를 추가해 보존된 상태를 조회하고 실제 계정·저장소 상태와 대조한다.

TigerVNC의 [공식 Xvnc 문서](https://tigervnc.org/doc/Xvnc.html)는 `-localhost`, `-rfbport`, `-SecurityTypes`, `-geometry`를 설명한다. 예를 들어 승인된 격리 시험에서 `Xtigervnc :99 -localhost yes -rfbport 5900 -SecurityTypes None -geometry 1280x720 -depth 24 -AcceptCutText=0 -SendCutText=0`로 새 X11 framebuffer를 만들 수 있다. 설치된 실행 파일·desktop 프로그램·실행 계정·DISPLAY·X 인증은 시험 담당자가 확인해야 한다. 이 명령은 서버에서 실행 완료된 증거가 아니다.

## 서비스 계약

`createRfbDesktopAdapter({openChannel, port: 5900, allowNoneSecurity: true})`의 채널 함수는 다음 구조다.

```js
openChannel({ binding, host: '127.0.0.1', port, signal })
// -> Promise<{ stream: Duplex, close: () => void | Promise<void> }>
```

SSH 연결·프로필 검증은 채널 제공자의 책임이다. 실행 어댑터의 `runtime.openDesktopChannel(profile, {host, port, beforeDispatch, signal})`와 연결할 때 `beforeDispatch`는 같은 target revision과 승인 상태를 다시 확인해야 한다. 채널 종료는 공유 SSH 연결을 종료하지 않는다. SSH lifecycle은 `forwardOut` 채널도 사용 중인 자원으로 추적해야 한다.

`createDesktopService`는 비동기 `authorize(binding)`의 결과가 true이고 `verifyTarget(binding) === true`일 것을 요구한다. binding은 `{ownerId,targetId,targetRevision,epoch}`이며 서버가 인증된 principal·승인·현재 대상에서 구성한다. 요청 본문의 ownerId나 epoch를 그대로 권한으로 신뢰하지 않는다.

`targets.gui.openRequest`의 서버 발급 `requestKey`를 `desktop-open`에 전달한다. 응답을 잃으면 같은 키로 같은 세션을 회수하며 새 세션을 만들지 않는다. 키의 만료·서버 재시작 뒤에는 명시적으로 거부한다. 만료된 복구 기록은 임시 수용량에서 제거되므로 누적 사용 횟수 제한은 없다.

| 메서드 | 입력 | 주요 결과 |
| --- | --- | --- |
| `open` | binding | `sessionId`, binding, TTL, `kind: desktop` |
| `observe` | `ownerId, sessionId, epoch` | PNG `data` base64, `frameId`, 물리 `width/height`, `geometryRevision`, `nextInputSequence` |
| `input` | 동일 identity + `frameId, geometryRevision, sequence, requestKey, actions` | `state: sent`, 입력 sequence·requestKey |
| `close` | 동일 identity | `closed`, `releaseSent`, `logout: false`, 선택적 `cleanupError` |

동일 lease에서 입력 sequence는 1부터 1씩 증가한다. requestKey는 요청별로 새 ASCII 식별자(1~128자)를 사용한다. 최신 sequence의 같은 key·payload 재조회는 저장된 영수증을 반환하고 입력을 재전송하지 않는다. 같은 sequence의 다른 payload·key와 건너뛴 sequence는 거절한다. 이전 sequence 전체 기록은 보관하지 않는다. transport 실패 후 불명확한 입력을 자동 재시도하지 않고 lease를 닫는다. `sent`는 RFB 채널에 전송한 상태이며 원격 앱의 처리 완료 증거가 아니다. 결과 화면을 다시 관측한다.

actions는 `{type:'key',keysym,down}`, `{type:'pointer',x,y,buttons}`, `{type:'text',text}`다. key는 X11 keysym이며 pointer 버튼 bitmask는 RFB 정의를 따른다. 좌표는 `coordinateSpace: physical-pixels`의 framebuffer 픽셀이다. UI는 CSS 위치에 framebuffer/표시크기 비율을 적용하며 devicePixelRatio를 중복 적용하지 않는다. 최근 관측 frame은 연속 입력에 재사용할 수 있다. 입력 직전 화면을 다시 읽고 geometry가 달라졌으면 `DESKTOP_STALE_FRAME`으로 거절한다. 새 관측 후 새 frame과 geometry를 사용한다.

서버 구성은 시작 시 `maxConcurrency`를 전체·owner별 GUI lease 한도로 주입한다. GUI lease는 명령 worker와 별도 자원이며 pending open도 예약에 포함한다. Linux 전용 화면은 분리되지만 같은 기존 RFB 화면과 Windows 호스트의 RDP는 동시에 공유하지 않는다. lease 최대 수명은 15분, idle TTL은 2분이다. 같은 lease의 I/O는 직렬화하며 pending 요청은 16개까지만 받는다. 다른 owner에게 desktop이나 화면을 재할당하지 않는다.

close·TTL은 보유 key/button 해제를 전송한다. RFB는 기존 세션을 보존하고 Linux managed backend는 자신이 생성·관리하는 자손의 종료를 확인한다. 외부 사용자 서비스까지 회수한다고 보장하지 않는다. Windows 연결 해제는 OS 로그오프가 아니다. 정리 관측이 부족하면 `unknown`으로 보고한다. `releaseSent:true`는 해제 이벤트 전송 여부이며 OS 적용 보장이 아니다. `onClose`로 TTL 정리 영수증도 수집할 수 있다.

서버의 앱 logout 경로에서는 인증된 principal의 `closeOwner(ownerId)`를 호출해 open 응답 유실로 클라이언트가 ID를 모르는 lease도 정리한다. 이 메서드는 해당 owner만 닫고 다른 owner의 GUI를 유지한다. 앱 전체 종료용 `closeAll()`과 구분한다. 브라우저 비정상 종료·네트워크 단절로 logout이 도착하지 않으면 idle TTL이 정리한다.

## 자원 상한과 검증

기본·최대 framebuffer는 4,194,304픽셀이다. 수신 wire buffer는 `maxPixels * 8 + 65536`바이트·8,192 chunk 이내이며 한 observe의 raw rectangle 합은 `maxPixels * 2`픽셀 이내다. rectangle 좌표, desktop 이름 4KiB, clipboard 64KiB, 메시지 256개, rectangle 4,096개를 검사한다. handshake와 observe는 각각 기본 10초 기한을 갖는다. PNG 생성 시 framebuffer·수신 buffer 외에 scanline·압축·base64 사본이 생기므로 GUI quota를 메모리에 맞게 정한다.

RFB 세부는 [RFC 6143](https://www.rfc-editor.org/rfc/rfc6143.html)의 Raw encoding, DesktopSize, KeyEvent, PointerEvent를 따른다. clipboard는 전달하지 않고 수신 길이를 제한해 버린다. 화면·입력 원문·VNC server name·비밀을 로그로 남기지 않는다.

시험 파일은 `test/desktop-service.test.mjs`, `test/desktop-rfb.test.mjs`다. 허용된 테스트 서버에서 `node --test test/desktop-service.test.mjs test/desktop-rfb.test.mjs`로 실행한다. 실제 Linux·Windows desktop 각각에서 PNG 수신, 비민감 창에 키·포인터 입력, 화면 변화, 해상도 변경 후 이전 geometry 거절, graceful close·TTL·연결 단절의 held input 해제를 확인해야 한다. mock 시험과 구문 검사만으로 실제 두 OS GUI 지원 완료를 보고하지 않는다.
