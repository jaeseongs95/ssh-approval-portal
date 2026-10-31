# Windows SSH 대상 등록

기존 중계기에 Windows OpenSSH 서버를 등록합니다. Windows 대상에서 명령·파일 전송·이름 정책·Python 코드 제출·서버 CLI를 사용할 수 있습니다. 중계기 자체의 Windows 호스팅은 후속 릴리스 범위이며 이 문서의 지원 대상이 아닙니다. 기존 Linux 대상과 관리자 인증·대상별 승인·감사·전송 한도를 함께 사용합니다. 아래 주소·계정은 예시입니다. 실제 운영 주소나 자격을 공개 설정에 넣지 마세요.

## 지원 범위

| 기능 | Windows 대상 |
| --- | --- |
| 일반 명령 | Windows PowerShell 5.1에서 실행. 모델 평가 또는 소유자 승인 정책 적용 |
| 읽기 명령 | 인자 없는 `Microsoft.PowerShell.Utility\Get-Date`, `Microsoft.PowerShell.Management\Get-Location`만 읽기 전용으로 분류. 나머지는 일반 명령 흐름 사용 |
| 파일 업로드·다운로드 | 같은 SSH 계정과 전용 도우미로 일반 파일 전송 |
| 파일 자동승인·테스트 서버 설정 | 기존 소유자 정책 적용. 미지원 기능·경로·크기 제한 유지 |
| 명령 이름 사전승인 | 명시 실행 파일·모듈 한정 명령·절대 실행 경로의 리터럴 구문을 보수적으로 인식. 대소문자 구분 없음 |
| 권한 상승 파일 전송·코드 실행 | 기존 SSH 연결의 실제 관리자 토큰을 실행 전에 확인. 새 자격 취득·사용자 계정 컨트롤 우회 없음 |
| `python-source-v1` 코드 제출·실행 | 수동 설치한 Python의 절대 실행 경로를 대상에 등록한 경우 지원 |
| 서버 에이전트 CLI 설치·로그인 상태 진단 | 지원. 관리 설치·업데이트에는 신뢰할 수 있는 Node.js 22 이상과 npm 필요 |

명령 원문은 최대 32 KiB(32,768 UTF-8 바이트)이며 고정 수신기의 표준 입력으로 그대로 보냅니다. 수신기는 원문 길이·해시·입력 종료를 확인한 뒤 실행합니다. `-EncodedCommand`에 넣는 고정 실행기만 8,000자 이내로 제한하므로 긴 원문을 명령행 인자로 밀어 넣지 않습니다. 초과 원문은 거부하며 자동 분할·잘라내기·다른 셸로의 우회 실행은 하지 않습니다. 개행·제어 문자가 없는 한 줄 PowerShell 명령을 사용하세요. PowerShell 프로필은 읽지 않습니다.

`테스트 서버`는 기존에 허용된 전체 심사 생략 권한입니다. Windows에서도 일반 명령·코드 제출·파일 전송에 적용되지만 Python 경로, 실제 계정 권한, 경로·크기 제한을 생략하지 않습니다. 모델 평가·정보 전송·소유자 승인·요청 만료의 나머지 조건은 기존 정책을 따릅니다.

## SSH·키 준비

Windows OpenSSH 서버가 이미 동작하고 중계기에서 공개키 인증·명령 실행·SFTP 모두 가능해야 합니다. 이 기능과 설치기는 `sshd_config`, 기본 셸, 방화벽, 계정, 인증키를 수정하지 않습니다. SFTP 전용 계정으로 명령 실행이 막혀 있다면 도우미를 호출할 수 없습니다. 서버의 셸·SFTP 설정은 [Microsoft OpenSSH 구성 안내](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration)를 확인하세요.

중계기 전용 키의 공개키만 Windows 서버에 등록하고 개인키는 중계기의 보호된 경로에 둡니다. 일반 계정과 관리자 그룹 계정은 인증키 파일 위치가 다를 수 있으며, 기본 관리자 그룹 설정은 `C:\ProgramData\ssh\administrators_authorized_keys`를 사용합니다. 기존 설정을 보존하면서 [Microsoft 공개키 관리 안내](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement)에 따라 위치와 접근 권한을 관리하세요.

서버 호스트 키 지문은 별도 신뢰 경로로 확인해 두 프로필의 `trustedHostKey`에 고정합니다. 키·비밀번호를 바꾸면 `credentialRevision`도 올리고 중계기를 재시작합니다. 개인키·비밀번호·토큰을 채팅이나 `BRIDGE_TARGETS`에 넣지 않습니다.

## 전용 파일 도우미 준비

Windows 대상에 저장소의 `scripts/install-windows-helper.ps1`, `scripts/windows-file-helper.ps1`, `scripts/windows-file-native.cs`를 같은 폴더에 준비합니다. 관리자는 실제 SSH 계정의 보안 식별자를 `AccountSid`에 넣어 관리자 권한으로 한 번 실행합니다.

```powershell
powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File .\scripts\install-windows-helper.ps1 -AccountSid S-1-5-21-111111111-222222222-333333333-1001 -FileRoot C:/portal-files
```

설치기는 전용 새 폴더만 만들며 기존 경로를 덮어쓰지 않습니다. 각 루트는 서로 포함되지 않아야 합니다. 사용자 지정 경로의 상위 폴더는 먼저 준비돼 있어야 합니다. 실패 후 남은 폴더를 임의로 재사용하거나 기존 업무 폴더의 권한을 일괄 변경하지 마세요. `-InstallRoot`와 `-StageRoot`는 선택 인자입니다.

| 용도 | 기본 경로 |
| --- | --- |
| 도우미 | `C:/ProgramData/ssh-approval-portal/windows-file-helper.ps1` |
| 설치 파일·설정 | `C:/ProgramData/ssh-approval-portal` |
| SFTP 임시 수신 | `C:/ProgramData/ssh-approval-transfer/incoming` |

현재 중계기의 기본 전송 경로를 사용할 때는 기본 설치·임시 경로를 유지합니다. 설치 인자만 바꾸면 중계기 호출 경로가 자동 변경되지는 않습니다. 도우미·설정에는 관리자·시스템의 관리 권한과 지정 SSH 계정의 읽기·실행 권한을, 파일 루트·임시 수신 루트에는 지정 계정의 변경 권한을 설정합니다. 일반 파일 전송은 설치 때 고정한 파일 루트 내부로 제한됩니다. 이 경계는 파일 도우미에만 적용되며 일반 PowerShell 명령의 파일 접근을 격리하지 않습니다.

## 중계기 대상 등록

기존 SSH 설정에 읽기·쓰기 프로필 쌍을 추가합니다. Windows 프로필에는 POSIX 작업 폴더인 `workdir`를 넣지 않습니다. Windows 작업 폴더는 아래 대상 등록의 `workdir`로 설정합니다. 아래 키 경로는 중계기 측 경로입니다.

```toml
[[profiles]]
name = "windows-read"
host = "192.0.2.40"
port = 22
user = "portal-user"
auth = "key"
keyRef = "/var/lib/ssh-mcp/.ssh/windows_ed25519"
trustedHostKey = "VERIFIED_HOST_KEY_FINGERPRINT"
readOnly = true
announceAgent = false

[[profiles]]
name = "windows-write"
host = "192.0.2.40"
port = 22
user = "portal-user"
auth = "key"
keyRef = "/var/lib/ssh-mcp/.ssh/windows_ed25519"
trustedHostKey = "VERIFIED_HOST_KEY_FINGERPRINT"
readOnly = false
announceAgent = false
```

보호된 환경 설정의 `BRIDGE_TARGETS` 배열에 `platform:"windows"`를 명시합니다. 생략하면 기존 Linux 동작을 사용하므로 Windows 대상에서 생략하지 마세요. 기존 대상이 있으면 같은 배열에 보존합니다.

```dotenv
BRIDGE_TARGETS=[{"id":"windows","displayName":"Windows 시험 서버","platform":"windows","readProfile":"windows-read","writeProfile":"windows-write","credentialRevision":"v1","workdir":"C:/portal-files","pythonExecutable":"C:/Python313/python.exe"}]
BRIDGE_DEFAULT_TARGET=windows
```

`workdir`는 일반 명령의 기본 작업 폴더를 지정하는 선택 설정입니다. 드라이브를 포함한 실제 절대 경로를 사용합니다. `pythonExecutable`은 미리 수동 설치한 Python 실행 파일의 절대 경로입니다. 생략하면 이 대상의 `pythonSource` 기능은 꺼지고 코드 제출은 거부됩니다. Python을 자동으로 설치하거나 다른 실행 파일로 대체하지 않습니다. 코드 제출의 `cwd`는 요청마다 별도로 명시합니다.

대상 설정 변경은 중계기 재시작 후 적용됩니다. 두 프로필의 host·port·user·인증 참조·경유 서버·호스트 키는 일치해야 합니다. 대상끼리 같은 프로필이나 host/port·호스트 키를 공유할 수 없습니다. 전체 등록·revision 규칙은 [여러 대상 관리](multi-targets.ko.md)를 따릅니다.

`list-targets`와 관리자 대상 목록은 `platform`과 `capabilities`를 제공합니다. 관리자 화면은 운영체제 이름만으로 기능을 차단하지 않고 실제 기능 정보를 사용합니다. Python 경로가 없는 대상의 코드 제출 설정만 비활성화되며 이름 정책·모델 평가·일반 파일·권한 상승 정책·CLI를 대상별로 편집합니다.

## 명령 이름 정책과 코드 실행

Windows 이름 정책에는 `whoami.exe`, `Microsoft.PowerShell.Management\Get-Location`, `C:\Tools\tool.exe`처럼 실행 파일 확장자가 있는 이름, 모듈 한정 명령, 절대 실행 경로를 등록합니다. 이름은 최대 512 UTF-8 바이트이며 대소문자를 구분하지 않습니다. `Get-Location`, `ls`, 변수 호출처럼 대상이 불명확한 표현과 동적 구문은 이름만으로 승인하지 않고 전체 명령 평가로 보냅니다. 이름을 등록하면 리터럴로 판별된 명령의 인자까지 허용하므로 인자 제한으로 취급하지 마세요.

제출한 Python 원문은 최대 16 KiB이며 등록한 실행 파일로 `-I -B -S -X utf8` 옵션을 사용해 실행합니다. 원문과 인자를 평가한 뒤 같은 실행 계획을 사용합니다. `argv[0]`는 합성 이름이고 `__file__`은 없으며 표준 입력에는 검증된 원문 뒤 입력 종료가 제공됩니다. Windows 필수 시스템·사용자 환경 키만 보존하고 검색 경로는 Python 실행 폴더와 Windows 시스템 폴더로 제한합니다. 의존성·파일·실행 환경의 실제 상태를 증명하거나 격리하는 기능은 아닙니다.

## 서버 CLI

설치·업데이트 전에 해당 Windows 계정에서 신뢰할 수 있는 Node.js 22 이상과 npm을 준비합니다. 런타임을 자동 설치하지 않습니다. 기존 네이티브 실행 파일의 버전·로그인 상태 진단에는 Node가 필요하지 않을 수 있지만, 자바스크립트 실행 파일과 관리 설치에는 필요합니다.

관리 설치는 `%USERPROFILE%\.ssh-approval-cli\{provider}` 아래에 두며 `current.json`의 `active`와 해당 버전의 `package.json` 실행 파일 정보를 사용합니다. 고정된 `current\bin` 경로를 가정하지 않습니다. 관리자 화면의 로그인 안내를 따라 같은 SSH 계정의 터미널에서 로그인합니다. Codex는 `login`, Claude는 `auth login`을 사용하며 키·인증 코드를 포털에 입력하지 않습니다. 설치만으로 자동심사나 대체 평가가 활성화되지는 않습니다.

## 파일 경로와 보안 제약

파일 요청에는 `C:/portal-files/report.txt`처럼 드라이브를 포함한 절대 경로를 사용합니다. 역슬래시 경로도 허용하지만 JSON에서는 `C:\\portal-files\\report.txt`처럼 이스케이프해야 합니다. 파일 루트 외부, 상대 경로, UNC·장치 경로, 대체 데이터 스트림, 예약 장치명, `.`·`..`, 끝의 공백·마침표, 재분석 지점·하드링크 등 안전 조건을 만족하지 않는 경로는 거부합니다. 파일 루트와 임시 수신 폴더에 다른 계정의 쓰기 권한을 추가하지 마세요.

업로드는 SFTP로 임시 수신한 뒤 도우미가 크기·해시·경로·접근 권한을 확인해 반영합니다. 다운로드도 도우미가 준비한 일반 파일만 수신합니다. 파일당 64 MiB, 전체 임시 저장 예산과 대상별 실행 제한은 Linux 대상과 공유합니다. 승인된 요청의 대상·revision·파일 정보와 실제 전송이 일치해야 하며, 실패하거나 결과가 불명확하면 자동 재실행하지 않습니다.

일반 명령은 SSH 계정 권한으로 동작합니다. 관리자 계정으로 연결하면 해당 계정 권한을 신뢰하는 것이며 별도 격리·권한 축소를 제공하지 않습니다. 전용 최소 권한 계정과 파일 루트를 준비하고 승인 대상·명령·파일 경로를 확인하세요. 등록 성공이나 관리자 화면 연결 표시만으로 실제 SSH·SFTP 왕복 시험이 통과한 것은 아닙니다.
## 지원 환경

원격 파일 전송의 최소 전제는 Windows 10 1809 이상 또는 Windows Server 2019 이상, NTFS, PowerShell 5.1입니다. 자동 시험 환경은 Windows Server 2025이며 PowerShell 5.1과 7을 각각 시험합니다. 그보다 오래된 운영체제에서의 실제 동작까지 검증했다는 뜻은 아닙니다. 파일시스템 또는 원자적 교체 기능이 지원되지 않으면 작업을 거부하며, 보호 핸들을 해제한 우회 교체를 하지 않습니다.

## 실행 결과와 권한의 범위

PowerShell 오류는 실패로 처리하고 마지막 네이티브 프로그램의 종료 코드를 반환합니다. 임의 스크립트 안의 모든 이전 프로그램이 성공했다는 보장은 아닙니다. 프로그램마다 성공을 확인해야 한다면 해당 스크립트에서 각각의 종료 코드를 검사하세요. 네이티브 프로그램 자체의 출력 문자 인코딩까지 강제하지는 않습니다.

시간 초과나 SSH 연결 단절은 원격 프로세스 및 그 자식의 종료를 증명하지 않습니다. 상태가 불명확하면 결과를 확인하며 자동 재실행하지 않습니다. 파일 교체 후 응답이 유실된 경우에도 목적지가 변경됐을 수 있습니다. `overwrite=true`는 해당 경로의 파일을 교체한다는 뜻이며, 승인 시점의 특정 파일 판본과 원자적으로 비교한다는 뜻이 아닙니다.

Windows 덮어쓰기는 기존 파일의 소유자·접근 제어 목록(DACL)·생성 시간·마지막 접근 시간·마지막 수정 시간을 보존하며, 보존 또는 원자적 교체에 실패하면 완료로 보고하지 않습니다. 감사 접근 제어 목록(SACL), 대체 데이터 스트림(ADS), 기타 확장 메타데이터의 완전한 보존은 보장하지 않습니다. 이러한 메타데이터까지 필요한 파일에는 이 덮어쓰기 기능을 사용하지 마세요.

파일 보조프로그램의 루트 제한은 파일 전송 API의 검증 경계입니다. 같은 SSH 계정으로 임의 명령이나 직접 SFTP를 실행하는 사람까지 가두는 운영체제 격리는 아닙니다. 특히 관리자 계정은 보호 설정을 바꿀 수 있으므로 신뢰하는 운영자에게만 연결 권한을 부여해야 합니다.

