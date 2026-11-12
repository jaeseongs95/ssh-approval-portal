# 외부 프로그램

[English](external-programs.en.md) · [README](../README.ko.md)

3.0.0은 Java 25와 Spring Boot로 구현한다. Java로 할 수 있는 일은 Java로 하고 외부 프로그램에 맡기지 않는 것이 원칙이다. 이 문서는 남기는 외부 프로그램을 나열하고, 프로그램마다 어디서 실행하는지와 왜 Java로 대체하기 어려운지를 적는다. 이 문서에 없는 프로그램은 사용하지 않는다. 이 프로그램을 띄우거나 대상으로 보내는 Java 클래스에도 같은 이유를 클래스 설명에 적는다.

목록의 근거는 `java/docs/migration/`의 외부 프로그램·설치에 대한 이전 결정, 기능 지도(Q9, Q10, Q12 항목), 3단계 설계(2.3, 2.4, 6.2, 7.3절)이다. 「예정」으로 표시한 프로그램과 클래스는 이후 이전 단계에 속하며 아직 소스에 없다.

## 외부 프로그램이 아닌 것

다음은 Java로 처리하며 보조 프로그램을 쓰지 않는다. 대상에서의 파일 전송과 원자적 교체(Apache MINA SSHD의 SFTP, 대상에는 아무것도 설치하지 않는다), 명령 감독(SSH exec 채널), RFB·PNG 처리, 세션 관리, 환경 편집기, 설치·갱신 논리, 클라이언트 명령줄이다.

## 로컬 프로그램(포털 호스트)

| 프로그램 | 어디서 실행하는가 | 왜 Java로 대체하기 어려운가 | 코드 위치 |
| --- | --- | --- | --- |
| `xfreerdp3`(X11 입력 패치를 적용한 FreeRDP 클라이언트) | 포털 호스트(Linux 전용). RDP 데스크톱 세션의 중계에 쓴다. | JDK에는 RDP 클라이언트가 없다. 이 릴리스는 RDP 클라이언트 프로토콜(자격 위임·그래픽·채널)을 Java로 구현하지 않으며, 입력 패치는 FreeRDP에 대한 네이티브 C 코드이다. Windows 서버 판은 데스크톱 기능을 미지원으로 표시한다. | `portal-desktop`의 `process.LocalDesktopProcess`(예정, 5단계). 로컬 프로그램을 시작하는 `portal-desktop`의 클래스는 이 이유와 함께 ArchUnit 규칙 A-PROCESS 허용 목록(`PortalRules.PROCESS_ALLOWED`)에 오른다. |
| `Xvnc`(VNC 전면을 가진 X 서버) | 포털 호스트(중계 백엔드)와 원격 Linux 대상(VNC 백엔드, 아래 원격 표 참조). Linux 전용. | X 서버는 네이티브 프로그램이며 JDK에는 X 서버 API가 없다. | 로컬의 경우 위와 같다. `portal-desktop`의 `session.LinuxDesktopSession`(예정, 5단계). |
| `openbox`, `xterm`, `xdpyinfo`, `xwininfo`, `xprop` | `Xvnc`로 띄운 관리형 X 화면 안에서 실행한다. 창 관리자, 제품이 여는 응용 프로그램, X11 상태의 읽기 전용 조회이다. | 모두 X11 프로그램이며 JDK에는 창 관리나 화면 조회를 위한 표준 X11 클라이언트 API가 없다. | `portal-desktop`의 `session.LinuxDesktopSession`(예정, 5단계). |

위에 적은 클래스만 운영체제 프로세스를 시작할 수 있다. ArchUnit 규칙 A-PROCESS는 다른 클래스가 시작하면 빌드를 실패시키고, 규칙 A-NO-LOCAL-PROCESS는 `portal-ssh` 모듈 전체에서 `ProcessBuilder`와 `Runtime.exec`를 금지한다.

## 원격 대상에서 실행하는 프로그램

포털이 이 프로그램을 실행하는 것이 아니다. SSH 채널로 대상에 보내면 대상이 실행한다. 대상에는 JVM이 없으며, 승인된 명령을 대상에서 실행하는 것이 제품의 기능이다.

| 프로그램 | 어디서 실행하는가 | 왜 Java로 대체하기 어려운가 | 코드 위치 |
| --- | --- | --- | --- |
| 사용자 명령, `source` 요청의 Python 원문(`/usr/bin/python3 -I -B -S -X utf8`) | 승인 뒤 원격 대상. | 사용자가 승인한 명령을 대상에서 실행하는 것이 제품 기능이다. 명령과 해석기는 포털이 아니라 대상 시스템의 것이다. | `portal-ssh`의 `exec`(`MinaRemoteExecutor`), `platform.LinuxTargetPlatform`·`platform.WindowsTargetPlatform`(클래스 설명), `src/main/resources/ssh/remote/**`의 고정 수신기 원문. |
| Windows 대상의 PowerShell 래퍼(인코딩한 명령을 받는 `powershell`, CLIXML 억제, Windows 명령줄 8000자 한도) | 원격 Windows 대상(기본 셸은 `cmd.exe`). | 래퍼는 대상의 해석기에 보내는 데이터이다. 해석은 대상이 하고, Java는 문장을 만들어 보낼 뿐이다. | `portal-ssh`의 `platform.WindowsCommandWrapper`(3단계), 리소스 파일 `src/main/resources/ssh/remote/*.ps1`. 이 파일의 해시를 고정하는 시험은 3단계에 포함한다. |
| 에이전트 CLI 설치기의 대상 고정 명령: `tar`(검증한 패키지 해제), `ln -sfn` 또는 이름 변경(`current` 링크 전환), 설치된 CLI의 버전 질의(읽기 전용, 신뢰할 수 없는 경로는 실행하지 않음), `test -x`(`sftp-server` 위치 확인) | 원격 대상. | 대상에는 JVM이 없고, 대상에서 압축을 풀고 링크를 바꾸는 도구는 대상의 도구이다. 패키지는 Java가 내려받아 검증(sha512)하고 올린다. 원격에서는 이 몇 개의 명령만 실행한다. | `portal-ssh`의 `cli.AgentCliInstaller`와 `AgentCliPlan`의 상수 리소스(3단계). 시험 S3-AG-10이 보낸 명령을 이 목록과 대조한다. |
| `sudo -n`(권한 상승 요청: exec 채널에서 `sudo -n <sftp-server>`, 또는 `sudo -n`으로 실행하는 고정 대체 명령 `cat`·`tee`·`mv`) | 원격 Linux 대상. | 대상에서의 권한 상승은 대상의 운영체제가 한다. | `portal-ssh`의 `sftp`(3단계, 방식은 상승 계획이 고른다). |
| 대상에서의 읽기 전용 점검: Windows 대상의 관리자 확인, 원격 Linux 대상에서 `Xvnc`와 보조 프로그램의 기동 | 원격 대상. | 대상 시스템의 명령이다. | `portal-ssh`(`platform`, 3단계), `portal-desktop`의 원격 Linux 데스크톱 기동기(예정, 5단계). |

고정 명령 목록은 코드의 리소스로 두며 이 절의 목록과 같다. 모델이나 대상에 보내는 문장은 고정이며 사용자 입력으로 만들지 않는다.

## 설치·빌드·지속적 통합

| 프로그램 | 어디서 실행하는가 | 왜 Java로 대체하기 어려운가 | 코드 위치 |
| --- | --- | --- | --- |
| 설치 스크립트: `install.sh`(Linux, `.tar.gz` 묶음)와 `install.cmd`(Windows, `.zip` 묶음) | 서버나 PC 클라이언트를 설치하는 컴퓨터(설치·갱신·제거 때마다 한 번). | 스크립트는 동봉한 Java 런타임을 찾아 Java 설치 명령(`java -jar ... install`, `upgrade`, `uninstall`)을 부른다. 설치를 시작할 때는 Java가 아직 실행되지 않았고, 운영체제 서비스의 등록(Linux `systemctl`, Windows 서비스 래퍼)과 운영체제 계정(`useradd`, `apt-get`, sshd 활성화, `visudo -c`로 sudoers 파일 검증)에는 JDK API가 없기 때문이다. 그 밖의 일은 모두 Java가 한다. 설정, 디렉터리·권한, hook 등록, 2.x 이전, sudoers 파일의 내용이다. | `packaging/`(예정, 7단계). |
| CI 준비 스크립트: `java/ci/openssh-linux.sh`, `java/ci/openssh-windows.cmd` | 일회용 GitHub 실행기. Gradle 작업 `:portal-ssh:realOpenSshTest` 전에 실행한다. | 임시 운영체제 계정, sudoers 규칙, 두 번째 `sshd`를 만든다(Windows는 OpenSSH Server 기능을 설치하고 예약 작업으로 SYSTEM 권한 `sshd`를 띄운다). 운영체제 계정·서비스·`sshd`에는 JDK API가 없다. 서버를 쓰는 시험은 Java이다. | `java/ci/`, `.github/workflows/java-openssh.yml`(3단계). |
| Gradle 래퍼: `gradlew`, `gradlew.bat` | 개발 컴퓨터와 CI 실행기. | 래퍼는 Gradle을 내려받아 시작하므로 어떤 Java 빌드 도구보다 먼저 실행된다. | `java/gradlew`, `java/gradlew.bat`. CI 명령은 `./gradlew`를 부른다. |
| 패치한 FreeRDP 클라이언트 빌드: `git apply`, `cmake`, `ninja`, 프로토콜 시험 `test_agni.c`용 C 컴파일러 | 빌드 때의 빌더 컨테이너. 제품 런타임에는 없다. | 패치한 클라이언트는 C 코드이다. 고정 소스 묶음을 내려받아 SHA-256을 검증하고 manifest를 쓰는 일은 Java로 작성한 Gradle 작업이 하며, 패치는 커밋된 `freerdp-input.patch` 파일이다. | `native/freerdp-input/`(기존 빌더 `Dockerfile`과 커밋된 패치)와 Gradle 작업(예정, 7단계). |

## 확인하는 방법

- ArchUnit 규칙 A-PROCESS는 `ProcessBuilder`와 `Runtime.exec`를 허용 목록의 클래스로만 제한하고, 규칙 A-NO-LOCAL-PROCESS는 `portal-ssh`가 그 목록에 오르지 못하게 한다.
- 시험 S3-AG-10은 에이전트 CLI 설치기가 보낸 명령을 이 문서의 목록과 대조한다.
- 프로그램을 시작하는 코드를 더하는 변경에서는 같은 변경으로 이 문서에 그 프로그램과 Java로 대체하기 어려운 이유를 더한다.
