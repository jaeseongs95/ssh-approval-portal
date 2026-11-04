# FreeRDP 전용 입력 경계

FreeRDP 3.32.1 upstream `bf217a504e54cc719880c228e82353382cd7d4fa`의 X11 client만 패치한다. 공개 FreeRDP/WinPR ABI와 RDP wire 형식은 바꾸지 않는다. 기존 X11 모드는 유지하고 `/ags-input-fd:<n>` 모드에서만 X11 키·포인터·focus 동기화를 차단한다. 렌더링과 MappingNotify는 유지한다. clipboard와 자동 재접속은 꺼진다.

`agni.c`는 같은 RDP mainloop에서만 호출한다. 별도 입력 스레드나 로컬 listener를 만들지 않는다. 상속 AF_UNIX SOCK_STREAM fd를 nonblocking/CLOEXEC로 바꾸고, payload를 완전히 검증한 뒤 최대 32 native calls씩 처리한다. frame/ACK deadline은 5초, 한 배치 dispatch deadline은 10초다. mainloop는 managed mode에서 최대 10ms마다 제어 채널을 진행한다. EOF/취소 때 미전송 입력을 버리고 자신이 누른 key/button만 best effort release한다. 세션 로그오프는 하지 않는다.

ACK scope는 **nativeSend**다. active·SuspendInput·disconnect·필요 callback·협상 Unicode/포인터 capability를 검사한 뒤 실제 native callback 결과를 센다. skip 조건에도 TRUE를 반환하는 일반 wrapper를 성공 판정에 사용하지 않는다. TRUE는 Windows 앱이 문자를 소비했다는 증명이 아니다. FALSE인 call은 effect unknown이며 자동 재전송하지 않는다.

## 고정 wire v1

모든 정수는 unsigned BE이며 메모리 구조체를 wire에 복사하지 않는다.

| header offset | 형식 | 값 |
|---|---|---|
| 0 | 4B | `AGNI` |
| 4 | U8 | version1 |
| 5 | U8 | 1 HELLO / 2 INPUT / 3 ACK / 4 CLOSE |
| 6 | U16 | flags0 |
| 8 | U32 | body bytes, 최대9856 |
| 12 | U64 | HELLO0, INPUT/CLOSE1부터 증가, ACK는 요청 seq |

한 fd당 미확정 INPUT은 하나다. duplicate/gap/wrap은 종료한다. ACK 유실 시 unknown으로 종료하며 replay하지 않는다. 별도 BARRIER는 없다.

HELLO body88B: capabilities U32=0x1f, maxPayload U32=9856, maxActions U16=128, maxHeld U16=256, maxTextUnits U32=2048, maxPublicCost U32=4096, maxNativeCalls U32=9344, scope U8=1+reserved3, version U16 세 개(3,32,1)+reservedU16, upstream SHA1 raw20B, patchSHA256 raw32B.

INPUT은 1..128 TLV이며 TLV header는 typeU8/flagsU8=0/reservedU16=0/valueLengthU32다. type1 TEXT는 strictUTF8 1..6144B/1..2048UTF16 units, type2 KEY는 keysymU32+downU8, type3 POINTER는 xU16+yU16+RFBbuttonsU8, type4 내부 RELEASE는 byte01 하나이며 유일한 TLV여야 한다. TEXT는 한글·surrogate pair를 보존하고 LF/Tab을 각 Return/Tab scancode down/up으로 보낸다. NUL/CR/기타 C0·C1 control은 전송 전에 error19로 거절한다. modifier held 상태의 exact TEXT는 error14로 거절한다. horizontal wheel은 이 버전에서 협상 capability를 확인할 수 없어 error9로 거절한다.

ACK body24B: statusU8(0native/1notStarted/2partialUnknown), scopeU8=1, errorU16, callsSucceededU32, callsAttemptedU32, actionIndexU16, elementIndexU16, phaseU8(0validate/1down/2up/3move/4edge/5release/6complete), resultFlagsU8(bit0failedEffectUnknown/bit1released/bit2close), ownedHeldKeysU16, ownedButtonsU8, reserved3. 성공 indices는0xffff다. error codes는1header/2kind/3length/4sequence/5TLV/6UTF8/7limit/8key/9pointer/10inactive/11suspended/12callback/13send/14modifier/15truncated/16cancel/17internal/18deadline/19control/20unicode다. 신뢰할 수 없는 header·불완전 frame·EOF는 ACK 없이 종료할 수 있다.

CLOSE body는 byte01(release-owned-and-detach)이며 성공 flags=6이다. RELEASE 성공 flags=2다. TEXT element는 UTF16 unit index, KEY는0, POINTER는0move와1..8bit, RELEASE는 고정 역순 key index와256..263button bit다. cursor는 진단용이며 resume 위치가 아니다.

공유 oracle: TEXT A seq1 frame=`41474e4901020000000000090000000000000001010000000000000141`. 정상 ACK=`41474e4901030000000000180000000000000001000100000000000200000002ffffffff0600000000000000`.

## TEST/Cloud 빌드와 배포용 산출물

로컬 제품 시험·로컬 Docker는 실행하지 않는다. TEST Ubuntu24.04 x86_64의 고유 source/output 디렉터리만 bind한다. 다음 명령은 TEST에서 실행한다.

```sh
docker build -t ags-freerdp-input-build -f native/freerdp-input/Dockerfile .
docker run --rm --cpus=1 --memory=2g --pids-limit=512 \
  --mount type=bind,src="$PWD",dst=/repo,readonly \
  --mount type=bind,src="$OUT",dst=/work \
  ags-freerdp-input-build --output /work/result
```

실행 전체에 외부 timeout을 둔다. compiler/deps 설치는 컨테이너 안에만 한다. 스크립트는 SHA가 고정된 공개 archive를 받고 deterministic source patch를 만든다. patch SHA는 별도 generated header로 넣어 자기 hash 순환을 피한다. upstream/license/patch/build 명령·옵션·CMake cache는 bundle `source/`에 보존한다. apt package 버전 목록과 compiler 출력·이미지 digest는 실행 영수증에도 보존해야 한다. base image와 upstream은 고정되지만 apt repository는 시점 의존이므로 별도 snapshot 없이 bit-for-bit 빌드를 보장하지 않는다.

bundle `runtime/`에는 `bin/xfreerdp3`, private `lib/` 세 library family, `manifest.json`이 있다. SONAME 링크는 같은 이름의 일반 파일 내용복사로 평탄화하며 symlink를 포함하지 않는다. manifest format은 `portal.freerdp-native.v1`, 각 일반 파일은 path/size/sha256/숫자 mode를 갖는다. `$ORIGIN` RUNPATH와 ldd를 검사한다. X11/OpenSSL/ICU/glibc 등 호스트 library ABI는 실제 배치 호스트에서도 별도로 검사한다. `/ags-input-capabilities`는 DISPLAY·인증 없이 protocol/upstreamCommit/patchDigest를 출력한다.

빌드 성공·protocol PASS는 실제 Windows 소비 검증을 대체하지 않는다. root 통합에서 긴 혼합 문자열 GUI 저장 SHA, Win+R·Ctrl+S·Alt+F4·pointer 순서, 자기 PID/fd 정리를 검증해야 한다. 이 파일은 설치·전역 바이너리 교체를 수행하지 않는다.
