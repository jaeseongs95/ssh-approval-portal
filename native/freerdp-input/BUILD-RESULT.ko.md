# TEST native 입력 빌드 결과

2026-11-04, FreeRDP `3.32.1` / `bf217a504e54cc719880c228e82353382cd7d4fa`에 대한 X11 전용 패치를 TEST Ubuntu24.04 x86_64에서 빌드했다. 설치·전역 라이브러리 교체·Windows 로그오프는 수행하지 않았다.

| 항목 | 확인값 |
|---|---|
| patch SHA256 | `ee8819a551c955ad425d084a2b207e5f8ebda60276ab0849c9ba6f47ffb5e2ab` |
| 실행파일 SHA256 | `469a39e0421b5947c84a1d4602069d69c81a05517cb5053ae806bcb2e59e49d3` |
| vendor bundle SHA256 | `91ae43e00d67bbf7581950043b167232061857bae4a75b093a74b7702d01a578` |
| 압축 / 확장 일반파일 합계 | 17,694,051 / 29,078,654 bytes |
| runtime 일반파일 | manifest 제외 11개, 17,607,870 bytes |
| 원시 근거 archive SHA256 | `31bc7520b804c1d1db9bda2a41a57c3560ed7d8ba5dca032e74820a43863ae2b` |

전용 컨테이너 `ags-native-input-child78-r1`은 CPU1 / RAM2GiB / pids512로 제한했다. 최종 실행은 컨테이너 안에서 다음 명령으로 진행했고 `build-r3.exit`는 `0`이다.

```sh
python3 scripts/build-freerdp-input.py --archive /work/build-r1/upstream.tar.gz --output /work/build-r3
```

CMake/Ninja는 `cmake --build build --parallel 1 --target xfreerdp`를 실행했다. protocol runner는 GCC13의 ASan+UBSan과 `--wrap=send`를 사용하여 partial header/body, strict UTF8, BE oracle, short/EAGAIN ACK, native guards, callback FALSE, 순서, 소유 release, sequence/EOF와 noReplay를 검사했다. **110 cases PASS / exit0**이다. 같은 테스트를 격리 사본에서 BE writer→LE 변이로 실행한 red는 oracle assertion으로 **exit134**, 원본 green은 **exit0**이다. 계획·후보·동일 runner의 로컬 consistency 검사는 `CONSISTENT`이며 독립 감사는 아니다.

첫 빌드는 upstream의 XInput 설정과 `WITH_CHANNELS=OFF` 조합에서 `rdpClientContext.rdpei` 컴파일 오류로 exit1이었다. 원시 로그를 보존했고 client channels 활성화로 원인을 수정했다. r2와 최종 r3 빌드는 각각 exit0이다. 실패를 sanitizer PASS로 바꾸어 집계하지 않았다.

실제 TEST 호스트에서 DISPLAY·자격 없이 `/ags-input-capabilities`를 실행해 protocol `ags-native-input/1`, upstream/patch digest 일치를 확인했다(exit0). 호스트 `ldd`도 exit0이며 세 FreeRDP/WinPR family는 bundle private `lib/`를 사용하고 `not found`가 없었다. bundle의 모든 manifest size/SHA와 일반파일 조건을 검사했다. 전용 컨테이너만 `docker rm -f`로 정리했고 exit0, 같은 이름의 후속 조회는 exit0/잔존 없음이었다.

원시 근거는 `/tmp/ags-native-input-child78-r1/evidence-r3.tgz`, 로컬 보관본은 `D:/codex/build/ssh-gui-rdp-input-20261104/evidence/evidence-r3.tgz`와 `final-r3/`다. 최종 build/proof/host probe 영수증은 `72a762c219f8e997101fdc4c5fe966599d2cc6f249e3c59a`, cleanup 영수증은 `f1a41b2273f44443cb9d400c096967e683389989e0cf28cd`다. candidate C 소스와 test는 proof의 SHA로 결속되어 있다.

배포 archive의 최상위는 `runtime/`와 `source/`다. `runtime/manifest.json`의 files는 runtime 상대 경로 `bin/`, `lib/`, `licenses/`의 일반파일만 나열하며 자신은 제외한다. SONAME은 일반파일로 복사했다. `source/`는 upstream archive, license, 적용 patch, overlay, build script/options/cache 및 compiler/packages/protocol 로그를 포함하며 별도 manifest 없이 outer archive SHA로 결속된다.

ACK는 native callback의 전송 결과일 뿐 Windows 앱의 소비를 증명하지 않는다. 실제 Windows의 긴 혼합 문자열 저장 SHA, 시스템키·포인터 순서 및 종료 통합시험은 이 작업에서 실행하지 않았으며 root 통합 검증 범위다. apt 저장소 snapshot은 고정하지 않아 bit-for-bit 재빌드를 주장하지 않는다.
