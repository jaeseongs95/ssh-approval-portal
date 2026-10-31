# Windows SSH 대상 등록

기존 중계기에 Windows OpenSSH 서버를 등록합니다. 중계기 자체의 설치 환경을 Windows로 바꾸는 기능은 아닙니다. 기존 Linux 대상과 관리자 인증·대상별 승인·감사·전송 한도를 함께 사용합니다. 아래 주소·계정은 예시입니다. 실제 운영 주소나 자격을 공개 설정에 넣지 마세요.

## 지원 범위

| 기능 | Windows 대상 |
| --- | --- |
| 일반 명령 | Windows PowerShell 5.1에서 실행. 모델 평가 또는 소유자 승인 정책 적용 |
| 읽기 명령 | 인자 없는 `Microsoft.PowerShell.Utility\Get-Date`, `Microsoft.PowerShell.Management\Get-Location`만 읽기 전용으로 분류. 나머지는 일반 명령 흐름 사용 |
| 파일 업로드·다운로드 | 같은 SSH 계정과 전용 도우미로 일반 파일 전송 |
| 파일 자동승인·테스트 서버 설정 | 기존 소유자 정책 적용. 미지원 기능·경로·크기 제한 유지 |
| 명령 이름 사전승인 | 미지원. POSIX 이름 목록으로 PowerShell 명령 평가·승인을 건너뛰지 않음 |
| `sudo`, 권한 상승 파일 전송 | 미지원. `elevate:true` 거부 |
| `python-source-v1` 코드 제출·실행 | 미지원 |
| 서버 에이전트 CLI 설치·로그인 상태 진단 | 미지원 |

명령은 UTF-16LE로 인코딩한 `-EncodedCommand`를 통해 실행합니다. 인코딩과 실행 래퍼를 포함한 최종 명령은 8,000자 이하여야 하며 초과 요청은 접수 전에 거부합니다. 원문 8,000자를 허용한다는 뜻이 아닙니다. 자동 분할·잘라내기·다른 셸로의 우회 실행은 하지 않습니다. 개행·제어 문자가 없는 한 줄 PowerShell 명령을 사용하세요. PowerShell 프로필은 읽지 않습니다.

`테스트 서버`는 기존에 허용된 전체 심사 생략 권한입니다. Windows에서도 일반 명령과 파일 전송에 적용되지만 코드 제출이나 권한 상승 같은 미지원 기능을 허용하지 않습니다. 모델 평가·정보 전송·소유자 승인·요청 만료의 나머지 조건은 기존 정책을 따릅니다.

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

기존 SSH 설정에 읽기·쓰기 프로필 쌍을 추가합니다. Windows 프로필에는 POSIX 작업 폴더인 `workdir`를 넣지 않습니다. 아래 키 경로는 중계기 측 경로입니다.

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
BRIDGE_TARGETS=[{"id":"windows","displayName":"Windows 시험 서버","platform":"windows","readProfile":"windows-read","writeProfile":"windows-write","credentialRevision":"v1"}]
BRIDGE_DEFAULT_TARGET=windows
```

대상 설정 변경은 중계기 재시작 후 적용됩니다. 두 프로필의 host·port·user·인증 참조·경유 서버·호스트 키는 일치해야 합니다. 대상끼리 같은 프로필이나 host/port·호스트 키를 공유할 수 없습니다. 전체 등록·revision 규칙은 [여러 대상 관리](multi-targets.ko.md)를 따릅니다.

`list-targets`와 관리자 대상 목록은 `platform`과 `capabilities`를 제공합니다. 관리자 화면에서는 Windows 대상을 구분하고 미지원 기능 설정과 명령 이름 등록을 사용할 수 없게 표시합니다. 모델 평가·일반 파일 자동승인 정책은 계속 대상별로 편집합니다.

## 파일 경로와 보안 제약

파일 요청에는 `C:/portal-files/report.txt`처럼 드라이브를 포함한 절대 경로를 사용합니다. 역슬래시 경로도 허용하지만 JSON에서는 `C:\\portal-files\\report.txt`처럼 이스케이프해야 합니다. 파일 루트 외부, 상대 경로, UNC·장치 경로, 대체 데이터 스트림, 예약 장치명, `.`·`..`, 끝의 공백·마침표, 재분석 지점·하드링크 등 안전 조건을 만족하지 않는 경로는 거부합니다. 파일 루트와 임시 수신 폴더에 다른 계정의 쓰기 권한을 추가하지 마세요.

업로드는 SFTP로 임시 수신한 뒤 도우미가 크기·해시·경로·접근 권한을 확인해 반영합니다. 다운로드도 도우미가 준비한 일반 파일만 수신합니다. 파일당 64 MiB, 전체 임시 저장 예산과 대상별 실행 제한은 Linux 대상과 공유합니다. 승인된 요청의 대상·revision·파일 정보와 실제 전송이 일치해야 하며, 실패하거나 결과가 불명확하면 자동 재실행하지 않습니다.

일반 명령은 SSH 계정 권한으로 동작합니다. 관리자 계정으로 연결하면 해당 계정 권한을 신뢰하는 것이며 별도 격리·권한 축소를 제공하지 않습니다. 전용 최소 권한 계정과 파일 루트를 준비하고 승인 대상·명령·파일 경로를 확인하세요. 등록 성공이나 관리자 화면 연결 표시만으로 실제 SSH·SFTP 왕복 시험이 통과한 것은 아닙니다.
