# 외부 프로그램

[English](external-programs.en.md) · [README](../README.ko.md)

3.0.0은 Java 25와 Spring Boot로 구현한다. Java로 할 수 있는 일은 Java로 하고 외부 프로그램에 맡기지 않는 것이 원칙이다. 이 문서는 남기는 외부 프로그램을 나열하고, 프로그램마다 어디서 실행하는지와 왜 Java로 대체하기 어려운지를 적는다. 이 문서에 없는 프로그램은 사용하지 않는다. 이 프로그램을 띄우거나 대상으로 보내는 Java 클래스에도 같은 이유를 클래스 설명에 적는다.

목록의 근거는 `java/docs/migration/`의 외부 프로그램·설치에 대한 이전 결정, 기능 지도(Q9, Q10, Q12 항목), 3단계 설계(2.3, 2.4, 6.2, 7.3절)이다. 「예정」으로 표시한 프로그램과 클래스는 이후 이전 단계에 속하며 아직 소스에 없다.

## 외부 프로그램이 아닌 것

다음은 Java로 처리하며 보조 프로그램을 쓰지 않는다. 대상에서의 파일 전송과 원자적 교체(Apache MINA SSHD의 SFTP, 대상에는 아무것도 설치하지 않는다. 아래에 적은 POSIX 대상의 상승 전송만 예외이다), 명령 감독(SSH exec 채널), RFB·PNG 처리, 세션 관리, 환경 편집기, 설치·갱신 논리, 클라이언트 명령줄이다.

## 로컬 프로그램(포털 호스트)

| 프로그램 | 어디서 실행하는가 | 왜 Java로 대체하기 어려운가 | 코드 위치 |
| --- | --- | --- | --- |
| `xfreerdp3`(X11 입력 패치를 적용한 FreeRDP 클라이언트) | 포털 호스트(Linux 전용). RDP 데스크톱 세션의 중계에 쓴다. | JDK에는 RDP 클라이언트가 없다. 이 릴리스는 RDP 클라이언트 프로토콜(자격 위임·그래픽·채널)을 Java로 구현하지 않으며, 입력 패치는 FreeRDP에 대한 네이티브 C 코드이다. Windows 서버 판은 데스크톱 기능을 미지원으로 표시한다. | `portal-desktop`의 `process.LocalDesktopProcess`(예정, 5단계). 로컬 프로그램을 시작하는 `portal-desktop`의 클래스는 이 이유와 함께 ArchUnit 규칙 A-PROCESS 허용 목록(`PortalRules.PROCESS_ALLOWED`)에 오른다. |
| `Xvnc`(VNC 전면을 가진 X 서버) | 포털 호스트(중계 백엔드)와 원격 Linux 대상(VNC 백엔드, 아래 원격 표 참조). Linux 전용. | X 서버는 네이티브 프로그램이며 JDK에는 X 서버 API가 없다. | 로컬의 경우 위와 같다. `portal-desktop`의 `session.LinuxDesktopSession`(예정, 5단계). |
| `openbox`, `xterm`, `xdpyinfo`, `xwininfo`, `xprop` | `Xvnc`로 띄운 관리형 X 화면 안에서 실행한다. 창 관리자, 제품이 여는 응용 프로그램, X11 상태의 읽기 전용 조회이다. | 모두 X11 프로그램이며 JDK에는 창 관리나 화면 조회를 위한 표준 X11 클라이언트 API가 없다. | `portal-desktop`의 `session.LinuxDesktopSession`(예정, 5단계). |

위에 적은 클래스만 운영체제 프로세스를 시작할 수 있다. ArchUnit 규칙 A-PROCESS는 다른 클래스가 시작하면 빌드를 실패시키고, 규칙 A-NO-LOCAL-PROCESS는 `portal-ssh` 모듈 전체에서 `ProcessBuilder`와 `Runtime.exec`를 금지한다.

## 원격 대상에서 실행하는 프로그램과 고정 명령

포털이 이 프로그램을 실행하는 것이 아니다. SSH 채널로 대상에 보내면 대상이 실행한다. 대상에는 JVM이 없으며, 승인된 명령을 대상에서 실행하는 것이 제품의 기능이다. 포털 호스트의 Java 클래스는 문장을 만들어 보낼 수 있을 뿐이다. 그래서 이 절의 프로그램은 어느 것도 Java로 대체할 수 없고, 포털 호스트에서 시작하지도 않는다.

이 절의 명령은 사용자가 제출한 명령과 원문을 제외하면 모두 고정 문장이다. 고정 명령에 넣는 값은 검증을 마친 값(경로, 다이제스트, 크기, 권한 모드, 에이전트 CLI 릴리스의 구성 요소)뿐이며, 각 값은 대상 셸에 맞게 따옴표로 감싼다. 고정 명령에는 호출자의 자유 문장이 들어가지 않는다.

### 승인된 요청의 실행

| 프로그램 | 어디서 실행하는가 | 왜 Java로 대체하기 어려운가 | 코드 위치 |
| --- | --- | --- | --- |
| 사용자 명령, `source` 요청의 Python 원문: POSIX 대상은 `/usr/bin/python3 -I -B -S -X utf8 -c <수신기>`, Windows 대상은 관리자가 대상에 설정한 `python.exe`(PowerShell 실행기가 시작한다) | 승인 뒤 원격 대상. | 사용자가 승인한 명령을 대상에서 실행하는 것이 제품 기능이다. 명령과 해석기는 포털이 아니라 대상 시스템의 것이다. 수신기는 요청과 함께 보내는 Python 문장이며, 표준 입력을 끝까지 읽고 길이와 SHA-256을 확인한 뒤 컴파일한다. 잘렸거나 바뀐 원문은 효과가 생기기 전에 종료 코드 125로 거절하고, UTF-8이 아니거나 컴파일되지 않으면 126으로 거절한다. 전송 무결성 확인이며 샌드박스가 아니다. | `portal-ssh`의 `exec`(`MinaRemoteExecutor`), `platform.LinuxTargetPlatform`·`platform.WindowsTargetPlatform`·`platform.PythonSourceReceiver`, `src/main/resources/ssh/remote/`의 수신기 원문 `python-receiver-posix.py`·`python-receiver-windows.py`와 실행기 원문 `windows-source-launcher.ps1`·`windows-source-bootstrap.ps1`. |
| Windows 대상의 PowerShell 래퍼: `powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden ... -EncodedCommand <base64>`(오류 보고, 진행 기록과 CLIXML 억제, Windows 명령줄 8000자 한도) | 원격 Windows 대상(기본 셸은 `cmd.exe`). | 래퍼는 대상의 해석기에 보내는 데이터이다. 해석은 대상이 하고, Java는 문장을 만들어 보낼 뿐이다. | `portal-ssh`의 `platform.WindowsCommandWrapper`, 리소스 파일 `src/main/resources/ssh/remote/*.ps1`. 시험 S3-TP-04(`RemoteScriptsTest`)가 리소스 파일 12개의 SHA-256을 고정한다. |
| Windows 대상의 관리자 연결 확인: Windows 신원(`WindowsPrincipal.IsInRole(Administrator)`)을 묻는 읽기 전용 PowerShell 질의이며 위 래퍼로 보낸다. 연결이 관리자의 것이면 종료 코드 0으로 끝난다 | 원격 Windows 대상, 상승한 파일 작업 전. | 연결 토큰이 관리자 그룹에 속하는지는 대상의 운영체제만 안다. | `portal-ssh`의 `platform.WindowsTargetPlatform`(상승 계획)과 `sftp.ElevationProbe`. |
| 원격 Linux 대상에서 `Xvnc`와 보조 프로그램의 기동 | 원격 Linux 대상. | 대상 시스템의 명령이다. | `portal-desktop`의 원격 Linux 데스크톱 기동기(예정, 5단계). |

### 권한 상승 대체 경로의 고정 명령(POSIX 대상)

POSIX 대상에서 상승한 파일 작업은 아래 명령으로 한다(클래스 `sftp.ElevatedExecTransfer`, 점검은 `sftp.ElevationProbe`가 실행). 다른 방식인 「exec 채널에서 `sudo -n`으로 띄운 SFTP 서버」는 실제 서버 시험(S3-RO-02)이 동작을 보인 뒤에만 더한다. 모든 명령은 비밀번호를 묻지 않는 `sudo -n` 뒤에서 실행하며, 점검 `sudo -n true`가 실패하면 아무것도 쓰기 전에 파일 작업을 거절한다. 이 경로의 한계는 다음과 같다. 파일은 전송 상한(64MiB) 이하이고, 보내는 동안 파일 전체를 메모리에 올리며, 덮어쓴 파일의 소유자·그룹을 보존하지 않는다(새 파일은 상승한 계정의 것이 된다). 각 명령은 대상 운영체제의 프로그램이며 상승한 계정으로 대상에서 실행한다. 대상에는 JVM이 없으므로 Java가 어느 것도 대신할 수 없다.

| 명령 | 용도 | 왜 Java로 대체하기 어려운가 |
| --- | --- | --- |
| `sudo -n` | 아래 모든 명령의 접두. `sudo -n true`가 점검이다. | 권한 상승은 sudo가 지정한 계정으로 대상의 운영체제가 수행한다. 포털 호스트는 요청할 수 있을 뿐이다. |
| `sh` | 고정 명령의 본문(`umask 077`, `set -C`, 종류 확인, 다이제스트 확인 뒤 배치)을 한 명령으로 실행한다. | 확인과 배치가 대상에서 함께 실행되어야 연결이 끊겨도 확인하지 않은 단계가 남지 않으며, 대상에 있다고 알려진 해석기는 셸뿐이다. |
| `cat` | 표준 입력을 목적지 옆의 새 임시 파일에 쓰고(파일이 없어야 하며 모드 0600), 내려받을 파일을 표준 출력에 쓴다. | 상승한 계정으로 실행되는 대상의 프로세스만 그 파일을 만들거나 읽을 수 있다. |
| `mv` | 확인한 임시 파일을 제자리에 둔다(`mv -f`). | 교체는 상승한 계정이 대상 파일 시스템에서 하는 이름 변경이다. |
| `ln` | 목적지를 교체하면 안 될 때 확인한 임시 파일을 제자리에 둔다(목적지가 있으면 실패한다). | 링크는 상승한 계정으로 대상의 파일 시스템이 만든다. |
| `rm` | 거절된 뒤나 링크를 만든 뒤 임시 파일을 지운다. | 임시 파일은 대상에서 상승한 계정의 것이다. |
| `sha256sum`, `cut` | `sha256sum`이 임시 파일의 다이제스트를 계산하고, `cut`이 그 첫 필드를 취한다. | 다이제스트는 파일이 있는 곳에서 읽을 권한이 있는 계정으로 계산해야 한다. |
| `wc` | 임시 파일과 내려받을 파일의 바이트 수를 센다(`wc -c`). | 크기는 파일이 있는 곳에서 읽을 권한이 있는 계정으로 읽어야 한다. |
| `stat` | `chmod` 뒤 권한 비트를 다시 읽는다(`stat -c %a`). | 권한 비트는 대상의 파일 시스템에서 읽는다. |
| `chmod` | 권한 비트를 설정한다. | 권한 비트는 상승한 계정으로 대상의 파일 시스템에 설정한다. |

### 에이전트 CLI 설치기의 고정 명령

설치기는 패키지를 Java로 검증하고(소유자가 승인한 릴리스에 대한 SHA-512) SFTP로 올린 뒤, 계획의 명령을 단계마다 하나씩 실행한다(`AgentCliPlan`, `LinuxTargetPlatform.agentCliPlan`과 `WindowsTargetPlatform.agentCliPlan`이 만든다). 설치된 것은 실행하지 않는다. 버전은 메타데이터 파일 `package.json`에서 읽는다. 패키지는 로그인 계정의 홈 디렉터리 아래에 푼다. 한 단계의 명령은 다른 모든 단계의 명령과 다르며, 시험 S3-AG-10(`AgentCliPlansTest`)이 이를 고정한다. 대상에는 JVM이 없으므로 Java가 이 프로그램을 대신할 수 없다.

| 명령 | 어디서 실행하고 무엇에 쓰는가 | 왜 Java로 대체하기 어려운가 |
| --- | --- | --- |
| `printf`, `readlink` | POSIX 대상. `printf`는 릴리스의 고정 경로를 출력하고, `readlink`는 전환 전후의 `current` 링크를 읽는다. | 링크는 대상의 파일 시스템에서 읽는다. |
| `mkdir` | POSIX 대상. 릴리스의 임시(partial) 디렉터리를 만든다. | 디렉터리는 대상의 파일 시스템에 만든다. |
| `tar` | POSIX 대상. 검증한 패키지를 푼다(`tar -xzf`). | 압축은 파일이 놓일 곳에서 풀며, 푸는 도구는 대상의 것이다. |
| `grep`, `head`, `sed` | POSIX 대상. `package.json`의 첫 `version` 필드를 읽는다(파일은 여러 줄이거나 한 줄일 수 있다). | 파일이 대상에 있고, 계획은 설치된 것을 실행하지 않고 읽는다. |
| `cp`, `ln`, `mv`, `rm` | POSIX 대상. `cp -P`는 이전 `current` 링크를 보존한다. `ln -sfn`과 `mv -Tf`는 `current` 링크를 전환한다(새 링크를 만들어 옛 링크 위로 이름을 바꾼다). `mv`는 푼 디렉터리도 제자리에 둔다. `rm`은 패키지, 이전 링크, 임시 디렉터리를 지운다. | 전환은 대상의 파일 시스템에서 하는 이름 변경이다. |
| 인코딩한 명령을 받는 `powershell.exe` | Windows 대상. 계획의 모든 단계를 실행한다. `New-Item`(디렉터리와 `current` junction), `Set-Location`, `Move-Item`, `Remove-Item`, `Get-Item`, `Test-Path`, `Join-Path`, `Get-Content`, `Set-Content`, `ConvertFrom-Json`(버전)이다. | 대상의 기본 셸은 `cmd.exe`이며, 이 작업은 대상의 PowerShell이 수행한다. |
| `tar.exe` | Windows 대상(Windows 10 버전 1803 이후, 대상 자체의 프로그램). 검증한 패키지를 푼다. | 압축은 파일이 놓일 곳에서 대상의 도구로 푼다. |

Windows 대상에서는 `current` junction을 지우고 다시 만들므로 전환이 원자적이지 않다. 설치기는 설치 완료를 보고하기 전에 이를 다시 읽어 확인한다. 실제 Windows 서버에서는 아직 확인하지 않았다(시험 S3-RW).

고정 명령은 코드(`LinuxTargetPlatform`, `WindowsTargetPlatform`, `ElevatedExecTransfer`, `ElevationProbe`)에, 고정 문장은 `src/main/resources/ssh/remote/`의 리소스에 둔다. 모델이나 대상에 보내는 문장은 고정이며, 사용자가 제출하고 소유자가 승인한 명령과 원문을 제외하면 사용자 입력으로 만들지 않는다.

## 설치·빌드·지속적 통합

| 프로그램 | 어디서 실행하는가 | 왜 Java로 대체하기 어려운가 | 코드 위치 |
| --- | --- | --- | --- |
| 설치 스크립트: `install.sh`(Linux, `.tar.gz` 묶음)와 `install.cmd`(Windows, `.zip` 묶음) | 서버나 PC 클라이언트를 설치하는 컴퓨터(설치·갱신·제거 때마다 한 번). | 스크립트는 동봉한 Java 런타임을 찾아 Java 설치 명령(`java -jar ... install`, `upgrade`, `uninstall`)을 부른다. 설치를 시작할 때는 Java가 아직 실행되지 않았고, 운영체제 서비스의 등록(Linux `systemctl`, Windows 서비스 래퍼)과 운영체제 계정(`useradd`, `apt-get`, sshd 활성화, `visudo -c`로 sudoers 파일 검증)에는 JDK API가 없기 때문이다. 그 밖의 일은 모두 Java가 한다. 설정, 디렉터리·권한, hook 등록, 2.x 이전, sudoers 파일의 내용이다. | `packaging/`(예정, 7단계). |
| CI 준비 스크립트: `java/ci/openssh-linux.sh`, `java/ci/openssh-windows.cmd` | 일회용 GitHub 실행기. Gradle 작업 `:portal-ssh:realOpenSshTest` 전에 실행한다. | 임시 운영체제 계정, sudoers 규칙, 두 번째 `sshd`를 만든다(Windows는 OpenSSH Server 기능을 설치하고 예약 작업으로 SYSTEM 권한 `sshd`를 띄운다). 운영체제 계정·서비스·`sshd`에는 JDK API가 없다. 서버를 쓰는 시험은 Java이다. | `java/ci/`, `.github/workflows/java-openssh.yml`(3단계). |
| Gradle 래퍼: `gradlew`, `gradlew.bat` | 개발 컴퓨터와 CI 실행기. | 래퍼는 Gradle을 내려받아 시작하므로 어떤 Java 빌드 도구보다 먼저 실행된다. | `java/gradlew`, `java/gradlew.bat`. CI 명령은 `./gradlew`를 부른다. |
| 패치한 FreeRDP 클라이언트 빌드: `git apply`, `cmake`, `ninja`, 프로토콜 시험 `test_agni.c`용 C 컴파일러 | 빌드 때의 빌더 컨테이너. 제품 런타임에는 없다. | 패치한 클라이언트는 C 코드이다. 고정 소스 묶음을 내려받아 SHA-256을 검증하고 manifest를 쓰는 일은 Java로 작성한 Gradle 작업이 하며, 패치는 커밋된 `freerdp-input.patch` 파일이다. | `native/freerdp-input/`(기존 빌더 `Dockerfile`과 커밋된 패치)와 Gradle 작업(예정, 7단계). |

## 확인하는 방법

- ArchUnit 규칙 A-PROCESS는 `ProcessBuilder`와 `Runtime.exec`를 허용 목록의 클래스로만 제한하고, 규칙 A-NO-LOCAL-PROCESS는 `portal-ssh`가 그 목록에 오르지 못하게 한다.
- 시험 S3-AG-10(`AgentCliPlansTest`)은 각 플랫폼의 에이전트 CLI 계획의 명령을 고정한다. 단계마다 명령이 하나이고, 검증한 릴리스 구성 요소로만 만들며, 설치된 프로그램을 실행하는 단계가 없다. 시험 S3-TP-04(`RemoteScriptsTest`)는 `src/main/resources/ssh/remote/`의 고정 문장의 SHA-256을 고정한다.
- 프로그램을 시작하는 코드를 더하는 변경에서는 같은 변경으로 이 문서에 그 프로그램과 Java로 대체하기 어려운 이유를 더한다.
