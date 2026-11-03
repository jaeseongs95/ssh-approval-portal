# 실제 GUI 데스크톱

데스크톱 기능은 SSH로 대상의 loopback VNC 서버에 연결해 실제 OS framebuffer를 PNG로 관측하고 키·포인터를 보낸다. `src/adapters/desktop/rfb.mjs`가 RFB 프로토콜을, `src/application/desktop.mjs`가 승인·대상 binding·lease·GUI 전용 quota를 담당한다. PTY 화면이나 텍스트 요약을 GUI 화면으로 반환하지 않는다.

## 준비 조건

- 관리자 설정에서 대상별 GUI를 명시적으로 활성화하고 `allowNoneSecurity: true`를 지정한다. 기본값은 비활성이다.
- 대상에서 RFB 3.8과 None security를 제공하는 VNC 서버가 **loopback으로만** 실행되어야 한다. VNC 외부 포트와 HTTP viewer는 열지 않는다. SSH의 기존 계정·host key 검증을 유지한다. None security는 같은 OS의 다른 로컬 사용자에 대한 인증을 제공하지 않으므로 해당 대상의 신뢰·접근 정책이 이를 허용해야 한다.
- Linux는 실제 X11 desktop 또는 Wayland compositor가 내보내는 호환 framebuffer가 필요하다. Xvnc는 별도 X11 desktop을 생성하며 기존 Wayland 화면 공유와 다르다. Windows는 VNC 서버가 접근 가능한 interactive desktop session이 필요하다. SSH의 session 0에 접속했다는 사실만으로 interactive desktop이 준비된 것은 아니다.
- 이 어댑터는 VNC 비밀번호·OS 로그인·잠금 해제·SAS·UAC 보안 desktop·권한 승격을 처리하지 않는다. 지원하지 않는 RFB 버전이나 인증 방식은 별도 오류로 거절한다.
- 설치·설정 변경·로그인은 기존 승인 범위에 따라 담당자가 별도로 수행한다. 서비스 시작이 VNC 서버를 설치하거나 desktop에 로그인하지 않는다.

TigerVNC의 [공식 Xvnc 문서](https://tigervnc.org/doc/Xvnc.html)는 `-localhost`, `-rfbport`, `-SecurityTypes`, `-geometry`를 설명한다. 예를 들어 승인된 격리 시험에서 `Xtigervnc :99 -localhost yes -rfbport 5900 -SecurityTypes None -geometry 1280x720 -depth 24 -AcceptCutText=0 -SendCutText=0`로 새 X11 framebuffer를 만들 수 있다. 설치된 실행 파일·desktop 프로그램·실행 계정·DISPLAY·X 인증은 시험 담당자가 확인해야 한다. 이 명령은 서버에서 실행 완료된 증거가 아니다.

## 서비스 계약

`createRfbDesktopAdapter({openChannel, port: 5900, allowNoneSecurity: true})`의 채널 함수는 다음 구조다.

```js
openChannel({ binding, host: '127.0.0.1', port, signal })
// -> Promise<{ stream: Duplex, close: () => void | Promise<void> }>
```

SSH 연결·프로필 검증은 채널 제공자의 책임이다. 실행 어댑터의 `runtime.openDesktopChannel(profile, {host, port, beforeDispatch, signal})`와 연결할 때 `beforeDispatch`는 같은 target revision과 승인 상태를 다시 확인해야 한다. 채널 종료는 공유 SSH 연결을 종료하지 않는다. SSH lifecycle은 `forwardOut` 채널도 사용 중인 자원으로 추적해야 한다.

`createDesktopService`는 동기 `authorize(binding) === true`와 `verifyTarget(binding) === true`를 요구한다. binding은 `{ownerId,targetId,targetRevision,epoch}`이며 서버가 인증된 principal·승인·현재 대상에서 구성한다. 요청 본문의 ownerId나 epoch를 그대로 권한으로 신뢰하지 않는다.

| 메서드 | 입력 | 주요 결과 |
| --- | --- | --- |
| `open` | binding | `sessionId`, binding, TTL, `kind: desktop` |
| `observe` | `ownerId, sessionId, epoch` | PNG `data` base64, `frameId`, 물리 `width/height`, `geometryRevision`, `nextInputSequence` |
| `input` | 동일 identity + `frameId, geometryRevision, sequence, requestKey, actions` | `state: sent`, 입력 sequence·requestKey |
| `close` | 동일 identity | `closed`, `releaseSent`, `logout: false`, 선택적 `cleanupError` |

동일 lease에서 입력 sequence는 1부터 1씩 증가한다. requestKey는 요청별로 새 ASCII 식별자(1~128자)를 사용한다. 최신 sequence의 같은 key·payload 재조회는 저장된 영수증을 반환하고 입력을 재전송하지 않는다. 같은 sequence의 다른 payload·key와 건너뛴 sequence는 거절한다. 이전 sequence 전체 기록은 보관하지 않는다. transport 실패 후 불명확한 입력을 자동 재시도하지 않고 lease를 닫는다. `sent`는 RFB 채널에 전송한 상태이며 원격 앱의 처리 완료 증거가 아니다. 결과 화면을 다시 관측한다.

actions는 `{type:'key',keysym,down}`, `{type:'pointer',x,y,buttons}`, `{type:'text',text}`다. key는 X11 keysym이며 pointer 버튼 bitmask는 RFB 정의를 따른다. 좌표는 `coordinateSpace: physical-pixels`의 framebuffer 픽셀이다. UI는 CSS 위치에 framebuffer/표시크기 비율을 적용하며 devicePixelRatio를 중복 적용하지 않는다. 최근 관측 frame은 연속 입력에 재사용할 수 있다. 입력 직전 화면을 다시 읽고 geometry가 달라졌으면 `DESKTOP_STALE_FRAME`으로 거절한다. 새 관측 후 새 frame과 geometry를 사용한다.

기본 quota는 전체 GUI lease 2개·owner당 1개이며 SSH 명령 worker quota와 별개다. pending open도 예약에 포함한다. lease 최대 수명은 15분, idle TTL은 2분이다. 같은 lease의 I/O는 직렬화하며 pending 요청은 16개까지만 받는다. 다른 owner에게 desktop이나 화면을 재할당하지 않는다.

close·TTL은 보유 key/button 해제를 전송하고 채널을 detach한다. OS logout은 하지 않는다. `releaseSent: true`는 해제 이벤트 전송 여부이며 OS 적용 보장은 아니다. 이미 끊긴 TCP 연결에서는 key-up을 보낼 수 없어 `false`가 될 수 있다. 사용하는 VNC 서버가 연결 단절 때 실제 held input을 해제하는지 별도 시험한다. `onClose` 콜백으로 TTL 정리 영수증도 수집할 수 있다.

서버의 앱 logout 경로에서는 인증된 principal의 `closeOwner(ownerId)`를 호출해 open 응답 유실로 클라이언트가 ID를 모르는 lease도 정리한다. 이 메서드는 해당 owner만 닫고 다른 owner의 GUI를 유지한다. 앱 전체 종료용 `closeAll()`과 구분한다. 브라우저 비정상 종료·네트워크 단절로 logout이 도착하지 않으면 idle TTL이 정리한다.

## 자원 상한과 검증

기본·최대 framebuffer는 4,194,304픽셀이다. 수신 wire buffer는 `maxPixels * 8 + 65536`바이트·8,192 chunk 이내이며 한 observe의 raw rectangle 합은 `maxPixels * 2`픽셀 이내다. rectangle 좌표, desktop 이름 4KiB, clipboard 64KiB, 메시지 256개, rectangle 4,096개를 검사한다. handshake와 observe는 각각 기본 10초 기한을 갖는다. PNG 생성 시 framebuffer·수신 buffer 외에 scanline·압축·base64 사본이 생기므로 GUI quota를 메모리에 맞게 정한다.

RFB 세부는 [RFC 6143](https://www.rfc-editor.org/rfc/rfc6143.html)의 Raw encoding, DesktopSize, KeyEvent, PointerEvent를 따른다. clipboard는 전달하지 않고 수신 길이를 제한해 버린다. 화면·입력 원문·VNC server name·비밀을 로그로 남기지 않는다.

시험 파일은 `test/desktop-service.test.mjs`, `test/desktop-rfb.test.mjs`다. 허용된 테스트 서버에서 `node --test test/desktop-service.test.mjs test/desktop-rfb.test.mjs`로 실행한다. 실제 Linux·Windows desktop 각각에서 PNG 수신, 비민감 창에 키·포인터 입력, 화면 변화, 해상도 변경 후 이전 geometry 거절, graceful close·TTL·연결 단절의 held input 해제를 확인해야 한다. mock 시험과 구문 검사만으로 실제 두 OS GUI 지원 완료를 보고하지 않는다.
