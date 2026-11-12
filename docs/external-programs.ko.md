# 외부 프로그램

[English](external-programs.en.md) · [README](../README.ko.md)

3.0.0은 Java 25와 Spring Boot로 구현한다. Java로 할 수 있는 일은 Java로 하고 외부 프로그램에 맡기지 않는 것이 원칙이다. 이 문서는 남기는 외부 프로그램을 나열하고, 프로그램마다 어디서 실행하는지와 왜 Java로 대체하기 어려운지를 적는다. 이 문서에 없는 프로그램은 사용하지 않는다. 이 프로그램을 띄우거나 대상으로 보내는 Java 클래스에도 같은 이유를 클래스 설명에 적는다.

목록의 근거는 `java/docs/migration/`의 외부 프로그램·설치에 대한 이전 결정, 기능 지도(Q9, Q10, Q12 항목), 3단계 설계(2.3, 2.4, 6.2, 7.3절)이다. 「예정」으로 표시한 프로그램과 클래스는 이후 이전 단계에 속하며 아직 소스에 없다.

## 외부 프로그램이 아닌 것

다음은 Java로 처리하며 보조 프로그램을 쓰지 않는다. 대상에서의 파일 전송과 원자적 교체(Apache MINA SSHD의 SFTP, 대상에는 아무것도 설치하지 않는다. POSIX 대상의 상승 전송도 `sudo -n`이 띄운 SFTP 서버 위의 SFTP이며 아래에 적었다), 명령 감독(SSH exec 채널), RFB·PNG 처리, 세션 관리, 환경 편집기, 설치·갱신 논리, 클라이언트 명령줄이다.

## 로컬 프로그램(포털 호스트)

| 프로그램 | 어디서 실행하는가 | 왜 Java로 대체하기 어려운가 | 코드 위치 |
| --- | --- | --- | --- |
| `xfreerdp3`(X11 입력 패치를 적용한 FreeRDP 클라이언트) | 포털 호스트(Linux 전용). RDP 데스크톱 세션의 중계에 쓴다. | JDK에는 RDP 클라이언트가 없다. 이 릴리스는 RDP 클라이언트 프로토콜(자격 위임·그래픽·채널)을 Java로 구현하지 않으며, 입력 패치는 FreeRDP에 대한 네이티브 C 코드이다. Windows 서버 판은 데스크톱 기능을 미지원으로 표시한다. | `portal-desktop`의 `process.LocalDesktopProcess`(예정, 5단계). 로컬 프로그램을 시작하는 `portal-desktop`의 클래스는 이 이유와 함께 ArchUnit 규칙 A-PROCESS 허용 목록(`PortalRules.PROCESS_ALLOWED`)에 오른다. |
| `Xvnc`(VNC 전면을 가진 X 서버) | 포털 호스트(중계 백엔드)와 원격 Linux 대상(VNC 백엔드, 아래 원격 표 참조). Linux 전용. | X 서버는 네이티브 프로그램이며 JDK에는 X 서버 API가 없다. | 로컬의 경우 위와 같다. `portal-desktop`의 `session.LinuxDesktopSession`(예정, 5단계). |
| `openbox`, `xterm`, `xdpyinfo`, `xwininfo`, `xprop` | `Xvnc`로 띄운 관리형 X 화면 안에서 실행한다. 창 관리자, 제품이 여는 응용 프로그램, X11 상태의 읽기 전용 조회이다. | 모두 X11 프로그램이며 JDK에는 창 관리나 화면 조회를 위한 표준 X11 클라이언트 API가 없다. | `portal-desktop`의 `session.LinuxDesktopSession`(예정, 5단계). |

위에 적은 클래스만 운영체제 프로세스를 시작할 수 있다. ArchUnit 규칙 A-PROCESS는 다른 클래스가 시작하면 빌드를 실패시키고, 규칙 A-NO-LOCAL-PROCESS는 `portal-ssh` 모듈 전체에서 `ProcessBuilder`와 `Runtime.exec`를 금지한다.

## 원격 대상에서 실행하는 프로그램과 고정 명령

포털이 이 프로그램을 실행하는 것이 아니다. SSH 채널로 대상에 보내면 대상이 실행한다. 대상에는 JVM이 없으며, 승인된 명령을 대상에서 실행하는 것이 제품의 기능이다. 포털 호스트의 Java 클래스는 문장을 만들어 보낼 수 있을 뿐이다. 그래서 이 절의 프로그램은 어느 것도 Java로 대체할 수 없고, 포털 호스트에서 시작하지도 않는다.

이 절의 명령은 사용자가 제출한 명령과 원문을 제외하면 모두 고정 문장이다. 고정 명령에 넣는 값은 검증을 마친 값(고정 목록에서 고른 SFTP 서버 프로그램의 경로, 에이전트 CLI 릴리스의 구성 요소, 숨은 링크 검사에서는 스크립트가 해독만 하고 실행하지 않는 base64 데이터인 전송 경로)뿐이며, 각 값은 대상 셸에 맞게 적는다. 고정 명령에는 호출자의 자유 문장이 들어가지 않는다.

### 승인된 요청의 실행

| 프로그램 | 어디서 실행하는가 | 왜 Java로 대체하기 어려운가 | 코드 위치 |
| --- | --- | --- | --- |
| 사용자 명령, `source` 요청의 Python 원문: POSIX 대상은 `/usr/bin/python3 -I -B -S -X utf8 -c <수신기>`, Windows 대상은 관리자가 대상에 설정한 `python.exe`(PowerShell 실행기가 시작한다) | 승인 뒤 원격 대상. | 사용자가 승인한 명령을 대상에서 실행하는 것이 제품 기능이다. 명령과 해석기는 포털이 아니라 대상 시스템의 것이다. 수신기는 요청과 함께 보내는 Python 문장이며, 표준 입력을 끝까지 읽고 길이와 SHA-256을 확인한 뒤 컴파일한다. 잘렸거나 바뀐 원문은 효과가 생기기 전에 종료 코드 125로 거절하고, UTF-8이 아니거나 컴파일되지 않으면 126으로 거절한다. 전송 무결성 확인이며 샌드박스가 아니다. | `portal-ssh`의 `exec`(`MinaRemoteExecutor`), `platform.LinuxTargetPlatform`·`platform.WindowsTargetPlatform`·`platform.PythonSourceReceiver`, `src/main/resources/ssh/remote/`의 수신기 원문 `python-receiver-posix.py`·`python-receiver-windows.py`와 실행기 원문 `windows-source-launcher.ps1`·`windows-source-bootstrap.ps1`. |
| Windows 대상의 PowerShell 래퍼: `powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden ... -EncodedCommand <base64>`(오류 보고, 진행 기록과 CLIXML 억제, Windows 명령줄 8000자 한도) | 원격 Windows 대상(기본 셸은 `cmd.exe`). | 래퍼는 대상의 해석기에 보내는 데이터이다. 해석은 대상이 하고, Java는 문장을 만들어 보낼 뿐이다. | `portal-ssh`의 `platform.WindowsCommandWrapper`, 리소스 파일 `src/main/resources/ssh/remote/*.ps1`. 시험 S3-TP-04(`RemoteScriptsTest`)가 리소스 파일 12개의 SHA-256을 고정한다. |
| Windows 대상의 관리자 연결 확인: Windows 신원(`WindowsPrincipal.IsInRole(Administrator)`)을 묻는 읽기 전용 PowerShell 질의이며 위 래퍼로 보낸다. 연결이 관리자의 것이면 종료 코드 0으로 끝난다 | 원격 Windows 대상, 상승한 파일 작업 전. | 연결 토큰이 관리자 그룹에 속하는지는 대상의 운영체제만 안다. | `portal-ssh`의 `platform.WindowsTargetPlatform`(상승 계획)과 `sftp.ElevationProbe`. |
| Windows 대상으로 가는 파일 전송 경로의 숨은 링크 검사: 고정된 읽기 전용 PowerShell 명령 하나이며 위 래퍼로 보낸다. 드라이브부터 경로의 구성요소마다 따라가지 않고 `[IO.File]::GetAttributes`로 본다. 경로는 base64 데이터로만 넘긴다. reparse point를 만나면 3, 하나도 없으면 0(없는 구성요소를 만나면 걷기가 끝난다), 구성요소를 볼 수 없거나 경로가 드라이브 형식이 아니면 4로 끝난다 | 원격 Windows 대상. 업로드, 다운로드, 권한 변경(상승한 요청 포함)에서 경로 정책 다음, SFTP 세션을 쓰기 전에 실행한다. POSIX 대상은 이렇게 검사하지 않는다. SFTP 서버가 링크를 보여 주고 경로 검사가 거절한다. | 정보가 대상의 파일 시스템에만 있다. Win32-OpenSSH의 SFTP 서버(SFTP v3 속성)는 심볼릭 링크만 링크로 보고하고, junction(mount point reparse point)은 `stat`, `lstat`, `readlink`에서 모두 일반 디렉터리로 보이므로 어떤 SFTP 요청으로도 찾을 수 없다. | `portal-ssh`의 `platform.WindowsReparseProbe`(이유는 `sftp.HiddenLinkProbe`에 적었다). 링크를 찾으면 `UNSAFE_PATH`, 답을 읽을 수 없으면(코드 4) `INVALID_REQUEST`, 명령이 실행되지 못하면 보내지 않은 것으로 끝난다. |
| 원격 Linux 대상에서 `Xvnc`와 보조 프로그램의 기동 | 원격 Linux 대상. | 대상 시스템의 명령이다. | `portal-desktop`의 원격 Linux 데스크톱 기동기(예정, 5단계). |

### 상승한 파일 작업(POSIX 대상)

POSIX 대상에서 상승한 파일 작업은 SFTP로 한다. 외부 프로그램은 `sudo -n` 하나이며, exec 채널에서 대상의 SFTP 서버 프로그램을 띄운다(`sudo -n <sftp-server>`). 그 채널 위에서 MINA SFTP 클라이언트가 말한다(`sftp.SudoSftpChannels`, `sftp.ExecSftpClient`). 서버 프로그램은 일반 SFTP 채널에서 `stat`으로 고정 목록(`/usr/lib/openssh/sftp-server`, `/usr/libexec/openssh/sftp-server`, `/usr/lib/ssh/sftp-server`, `/usr/libexec/sftp-server`)에서 찾는다. 업로드, 교체, 경로 검사, 다운로드는 일반 전송과 같은 Java 코드이며, 덮어쓴 파일의 소유자·그룹은 되돌린다. 서버 프로그램이 없으면(`INVALID_REQUEST`), `sudo -n`이 띄우기를 거부하면(`PERMISSION_DENIED`) 아무것도 쓰기 전에 요청을 거절한다. Windows 대상에는 이런 프로그램이 없다. 관리자 확인(위 표) 뒤에는 일반 SFTP로 전송한다.

| 명령 | 용도 | 왜 Java로 대체하기 어려운가 |
| --- | --- | --- |
| `sudo -n <sftp-server>` | 비밀번호를 묻지 않고 SFTP 서버 프로그램을 상승한 권한으로 띄운다. 들어가는 값은 고정 목록의 경로뿐이다. | 권한 상승은 대상이 계정에 권한을 주는 수단이다. 대상의 운영체제가 수행하고, 포털 호스트는 요청할 수 있을 뿐이다. |
| `sudo -n true` | 상승 계획의 점검이다. 계정이 비밀번호 없이 `sudo -n`을 쓸 수 있으면 0으로 끝난다(`sftp.ElevationProbe`, `platform.LinuxTargetPlatform`). | 위와 같다. |

### 에이전트 CLI 설치기의 고정 명령

설치기는 패키지를 Java로 검증하고(소유자가 승인한 릴리스에 대한 SHA-512) SFTP로 올린다. 그 밖의 일은 모두 SFTP와 Java가 한다. 디렉터리 만들기, 현재 릴리스 읽기, 패키지의 `package/package.json`에서 버전 읽기(Jackson), `current` 전환, 정리이다. 전환은 심볼릭 링크 `current.next`를 만들어 `posix-rename@openssh.com`으로 `current`를 교체한다. 서버가 이를 광고하지 않으면 옛 링크를 지운 뒤 새 링크의 이름을 바꾼다. 심볼릭 링크를 거절하는 서버(Win32-OpenSSH)는 같은 값을 포인터 파일 `current.txt`에 두고 같은 방식으로 교체한다(`cli.CurrentLink`, `cli.AgentCliInstaller`). 명령은 하나만 남는다. 로그인 계정의 홈 디렉터리 아래에서 패키지를 푸는 것이다(`platform.AgentCliStep.UNPACK`, `LinuxTargetPlatform.agentCliPlan`과 `WindowsTargetPlatform.agentCliPlan`이 만든다). 설치된 것은 실행하지 않는다.

| 명령 | 어디서 실행하고 무엇에 쓰는가 | 왜 Java로 대체하기 어려운가 |
| --- | --- | --- |
| `tar`(`cd <partial 디렉터리> && tar -xzf package.tgz`) | POSIX 대상. 검증한 패키지를 푼다. | 대상이 압축 전체를 한 번에 풀고 파일의 모드를 보존한다. Java가 하면 파일 수천 개를 SFTP로 하나씩 올려야 한다. |
| `tar.exe`(인코딩한 `powershell.exe` 명령 안에서 `Set-Location ...;tar.exe -xzf package.tgz;exit $LASTEXITCODE`) | Windows 대상(Windows 10 버전 1803 이후, 대상 자체의 프로그램). 검증한 패키지를 푼다. | 위와 같다. 대상의 기본 셸이 `cmd.exe`이므로 위의 PowerShell 래퍼를 거친다. |

Windows 대상에서는 서버가 권한 없이 심볼릭 링크를 만들지 않으므로 `current` 전환에 포인터 파일 `current.txt`를 쓴다. 설치기는 설치 완료를 보고하기 전에 `current`를 다시 읽어 확인한다. 실제 Windows 서버에서는 아직 확인하지 않았다(시험 S3-RW). 릴리스 카탈로그 어댑터가 구현되기 전(4단계)에는 조립이 「받을 패키지가 없다」고 답하며, 이때 설치는 대상에 아무것도 보내지 않는다.

고정 명령은 코드(`LinuxTargetPlatform`, `WindowsTargetPlatform`, `SudoSftpChannels`, `ElevationProbe`)에, 고정 문장은 `src/main/resources/ssh/remote/`의 리소스에 둔다. 모델이나 대상에 보내는 문장은 고정이며, 사용자가 제출하고 소유자가 승인한 명령과 원문을 제외하면 사용자 입력으로 만들지 않는다.

## 설치·빌드·지속적 통합

| 프로그램 | 어디서 실행하는가 | 왜 Java로 대체하기 어려운가 | 코드 위치 |
| --- | --- | --- | --- |
| 설치 스크립트: `install.sh`(Linux, `.tar.gz` 묶음)와 `install.cmd`(Windows, `.zip` 묶음) | 서버나 PC 클라이언트를 설치하는 컴퓨터(설치·갱신·제거 때마다 한 번). | 스크립트는 동봉한 Java 런타임을 찾아 Java 설치 명령(`java -jar ... install`, `upgrade`, `uninstall`)을 부른다. 설치를 시작할 때는 Java가 아직 실행되지 않았고, 운영체제 서비스의 등록(Linux `systemctl`, Windows 서비스 래퍼)과 운영체제 계정(`useradd`, `apt-get`, sshd 활성화, `visudo -c`로 sudoers 파일 검증)에는 JDK API가 없기 때문이다. 그 밖의 일은 모두 Java가 한다. 설정, 디렉터리·권한, hook 등록, 2.x 이전, sudoers 파일의 내용이다. | `packaging/`(예정, 7단계). |
| CI 준비 스크립트: `java/ci/openssh-linux.sh`, `java/ci/openssh-windows.cmd` | 일회용 GitHub 실행기. Gradle 작업 `:portal-ssh:realOpenSshTest` 전에 실행한다. | 임시 운영체제 계정, sudoers 규칙, 두 번째 `sshd`를 만든다(Windows는 OpenSSH Server 기능을 설치하고 예약 작업으로 SYSTEM 권한 `sshd`를 띄운다). 운영체제 계정·서비스·`sshd`에는 JDK API가 없다. 서버를 쓰는 시험은 Java이다. | `java/ci/`, `.github/workflows/java-openssh.yml`(3단계). |
| Gradle 래퍼: `gradlew`, `gradlew.bat` | 개발 컴퓨터와 CI 실행기. | 래퍼는 Gradle을 내려받아 시작하므로 어떤 Java 빌드 도구보다 먼저 실행된다. | `java/gradlew`, `java/gradlew.bat`. CI 명령은 `./gradlew`를 부른다. |
| 패치한 FreeRDP 클라이언트 빌드: `git apply`, `cmake`, `ninja`, 프로토콜 시험 `test_agni.c`용 C 컴파일러 | 빌드 때의 빌더 컨테이너. 제품 런타임에는 없다. | 패치한 클라이언트는 C 코드이다. 고정 소스 묶음을 내려받아 SHA-256을 검증하고 manifest를 쓰는 일은 Java로 작성한 Gradle 작업이 하며, 패치는 커밋된 `freerdp-input.patch` 파일이다. | `native/freerdp-input/`(기존 빌더 `Dockerfile`과 커밋된 패치)와 Gradle 작업(예정, 7단계). |

## 확인하는 방법

- ArchUnit 규칙 A-PROCESS는 `ProcessBuilder`와 `Runtime.exec`를 허용 목록의 클래스로만 제한하고, 규칙 A-NO-LOCAL-PROCESS는 `portal-ssh`가 그 목록에 오르지 못하게 한다.
- 시험 S3-AG-10(`AgentCliPlansTest`)은 각 플랫폼의 에이전트 CLI 계획의 원격 명령을 고정한다. 패키지 풀기 하나뿐이고, 검증한 릴리스 구성 요소로만 만들며, 설치된 프로그램을 실행하는 단계가 없다. 시험 S3-TP-04(`RemoteScriptsTest`)는 `src/main/resources/ssh/remote/`의 고정 문장의 SHA-256을 고정한다.
- 프로그램을 시작하는 코드를 더하는 변경에서는 같은 변경으로 이 문서에 그 프로그램과 Java로 대체하기 어려운 이유를 더한다.
