# 에이전트 파일 업로드

`request-upload`는 지원되는 클라이언트가 전달한 파일을 중계기에 임시 저장하고, 실측 크기와 SHA-256을 확정해 업로드 승인 대기에 등록합니다. 에이전트가 파일 선택 단계를 대신할 수 있지만 서버 경로에 반영하려면 소유자의 카드 또는 웹 승인이 필요합니다. 파일 실행과 ZIP 압축 해제는 하지 않습니다.

현재 구현은 ChatGPT의 공식 `openai/fileParams` 계약을 사용합니다. 필수 필드는 `download_url`·`file_id`, 선택 필드는 `mime_type`·`file_name`입니다. 실제 ChatGPT 파일 입력은 `upload-source-not-configured`와 공급자 hostname 반환까지 도달했지만 공급자 파일 가져오기·승인·SSH 왕복은 아직 확인되지 않았습니다. [공식 파일 입력 계약](https://developers.openai.com/plugins/reference#file-apis)

실제 Claude 시험에서는 `file_uuid`와 빈 `download_url`을 보내 입력 검증에 실패했습니다. `file_uuid`를 다운로드 주소로 바꾸거나 Anthropic Files API의 `file_id`로 간주하지 않습니다. 같은 Claude 샌드박스의 대상 HTTPS 연결은 proxy CONNECT 403으로 차단됐습니다. 이 원격 파일 입력을 통한 Claude 자동 업로드 경로는 제공하지 않으며 기존 카드의 PC 파일 선택을 사용합니다.

Claude Team·Enterprise의 조직 소유자는 `Organization settings > Capabilities`에서 코드 실행의 특정 도메인 접근을 설정할 수 있습니다. 개인 Free·Pro·Max에서 임의 도메인 추가가 가능하다고 보장하지 않습니다. MCP 연결 성공은 샌드박스 egress 허용을 뜻하지 않습니다. 도메인 접근과 실제 원본 바이트 전송이 별도로 입증되기 전에는 샌드박스 push 경로를 지원으로 표시하지 않습니다. [Claude 파일 생성과 네트워크 설정](https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude)

## 첫 연결

1. 설치한 후보의 파일 검증을 마친 뒤 Cloudflare Portal의 서버 기능을 동기화하고 ChatGPT 연결의 도구를 새로고침합니다.
2. ChatGPT에서 파일을 만들거나 첨부하고, “이 파일을 `request-upload`로 `/home/mcpops/reviewed-script.py`에 업로드 승인 요청해 줘”라고 요청합니다. 클라이언트가 파일 참조를 전달해야 하며, 임의 URL이나 쿠키를 직접 입력하지 않습니다.
3. 초기 허용 목록은 비어 있습니다. 이때 `upload-source-not-configured`와 파일 제공자의 hostname만 반환하며, 파일을 가져오거나 승인 요청을 만들지 않습니다. hostname이 실제 파일 제공자의 주소인지 관리자가 확인합니다. 서명된 전체 URL은 채팅이나 로그에 복사하지 않습니다.
4. 네이티브 서버의 관리자 터미널에서 아래 설정 도구를 실행하고 확인한 **정확한 hostname 또는 앞에 `*.`가 붙은 domain 패턴**을 `BRIDGE_UPLOAD_SOURCE_HOSTS`에 입력합니다. 예를 들어 `files.example.test,*.downloads.example.test`처럼 한 목록에 쉼표로 구분해 함께 입력할 수 있습니다. 이 주소들은 가상 예시입니다. 빈 입력은 이 경로를 비활성화합니다.

```sh
sudo bash /var/lib/ssh-mcp/app/approval-bridge/scripts/configure-upload-sources.sh
```

도구는 설치 파일과 설정을 확인하고, 유지보수를 예약한 뒤 기존 시크릿·SSH 키·인증 설정을 보존해 허용 목록만 변경합니다. 설정을 백업하며 시작 검사 실패 시 복원을 시도합니다. 대기 요청·실행·전송이 있으면 먼저 끝내거나 거부해야 합니다.

앞에 `*.`가 붙은 패턴은 한 단계 이상의 모든 깊이 하위 도메인에 일치하고 기준 domain 자체는 제외합니다. `*.example.com`은 `a.example.com`과 `a.b.example.com`에 일치하지만 `example.com`이나 `badexample.com`에는 일치하지 않습니다. 점 경계를 기준으로 비교하며, 단독 `*`, 다른 위치의 wildcard, URL·IP 주소·포트는 거부합니다. 관리자가 wildcard를 선택하면 포함되는 모든 하위 호스트를 신뢰 범위로 정하는 것입니다. 그 범위를 확인한 뒤 설정하고, 공유 CDN을 넓게 허용하는 패턴을 자동 권장하거나 미리 등록된 값으로 간주하지 않습니다.

5. 같은 파일을 새 파일 입력으로 다시 전달합니다. 성공 응답의 상태는 `pending`입니다. 카드에서 파일명·크기·SHA-256·목적지·덮어쓰기·sudo 설정을 확인한 뒤 승인합니다. 내려받은 파일과 원본의 해시까지 비교해야 왕복 시험이 완료됩니다.

`chatgpt.com/api/library/.../download` 같은 로그인용 원본 링크만으로는 이 기능을 대신할 수 없습니다. 클라이언트가 인증된 임시 파일 입력을 전달하지 못하거나 Library 다운로드 자체가 실패하면 업로드 완료로 보고하지 않습니다. 쿠키 전달, 임의 주소 허용, 파일 바이트를 대화에 붙이는 방법으로 우회하지 않습니다.

## 로컬 CLI에서 PC 파일 전송

설치된 Node CLI에 `--cloudflared 절대실행경로`를 지정하면 해당 앱의 기존 Cloudflare 사용자 로그인 캐시를 읽어 owner 인증에 사용합니다. 토큰은 자식 프로세스의 비공개 출력으로만 받고 인수·환경변수·화면에 출력하지 않습니다. 기존 `--access-token-stdin`과 함께 지정할 수 없습니다. 캐시 조회는 30초와 16,386바이트로 제한하며, 실패하면 `ACCESS_CREDENTIAL_UNAVAILABLE`로 종료합니다. 자동 로그인이나 요청 재시도는 하지 않습니다. [cloudflared 2026.10.3의 캐시 조회 구현](https://github.com/cloudflare/cloudflared/blob/2026.10.3/cmd/cloudflared/access/cmd.go#L379-L409)

아래는 PowerShell 예시입니다. 관리자 origin, cloudflared 경로, 로컬·서버 경로와 요청 ID를 실제 값으로 바꾸고 패키지 루트에서 실행합니다. 로그인이 필요하면 사용자가 먼저 `cloudflared access login 관리자origin | Out-Null`을 실행합니다. 토큰·비밀번호·인증코드를 대화에 붙이지 않습니다.

```powershell
$portalArgs = @('scripts/portal-client.mjs', '--origin', 'https://approve.example.test', '--cloudflared', 'C:\tools\cloudflared.exe')
node @portalArgs targets
node @portalArgs upload 'C:\work\original.bin' '/home/mcpops/new-file.bin' --target default
node @portalArgs status REQUEST_ID
node @portalArgs approve REQUEST_ID --confirm
node @portalArgs request-download '/home/mcpops/new-file.bin' --target default
node @portalArgs save DOWNLOAD_REQUEST_ID 'C:\work\saved-new.bin'
```

`pending`이면 대상·경로·파일 크기·SHA-256을 확인한 뒤 해당 요청만 승인하거나 `deny REQUEST_ID --confirm`으로 거절합니다. 자동 정책으로 완료됐거나 이미 결정된 요청은 상태를 확인합니다. 서버의 `completed`는 다운로드 준비 상태이며, PC 파일이 크기·해시 검사를 통과해 `saved`로 반환돼야 저장 완료입니다. 기존 PC 파일은 덮어쓰지 않습니다.

업로드 결과가 불명확하면 출력된 같은 전송 ID를 조회하고, 원본 파일·대상·원격 경로·플래그가 동일할 때만 `resume-upload TRANSFER_ID 절대로컬경로 원격경로`를 명시적으로 사용합니다. 새 업로드나 승인을 반복해 결과를 알아내지 않습니다. 로그인 캐시가 만료되면 본인이 다시 인증한 뒤 같은 ID부터 조회합니다.

전송할 파일의 바이트를 미리 지정하려면 `upload`에 `--expect-size 바이트 --expect-sha256 소문자SHA256`을 함께 사용합니다. 예를 들어 크기와 해시를 확인한 파일에 두 옵션을 지정하면, CLI가 캡처한 불변 스냅샷과 일치할 때만 원격 업로드를 시작합니다. 불일치는 `UPLOAD_SOURCE_MISMATCH`로 중지하며 새 전송을 만들지 않습니다. `resume-upload`는 기존 전송의 크기·해시와 원래 대상을 대조하므로 이 옵션을 받지 않습니다.

Claude Code에서는 허용된 로컬 명령 실행 도구로 이 CLI를 호출하고 PC 파일의 절대경로를 전달할 수 있습니다. 파일 바이트는 CLI가 직접 전송합니다. 실제 Claude Code 클라이언트의 업로드·PC 저장 실증은 별도 수용 검증이 필요하며, 이 옵션의 로컬 테스트만으로 플랫폼 전체 지원을 확정하지 않습니다.

## 파일 API의 대상 버전 결속

관리자 파일 API에서 특정 대상 버전에 결속하려면 `/api/targets`의 해당 대상 `revision`을 확인하고, 업로드 시작 또는 다운로드 요청에 명시적인 `target`과 `expectedTargetRevision`을 함께 보냅니다. 버전이 다르거나 대상이 비활성화됐으면 새 파일 할당이나 요청 생성 전에 거절합니다. 이 값은 순서를 비교하는 번호가 아닌 같은 설정인지 확인하는 해시입니다.

이 방식으로 생성한 파일 작업은 서버가 확인한 대상 정보를 전송 데이터와 승인 대상에 함께 보관합니다. 대상 정보가 달라진 업로드나 다운로드 티켓은 거절하며, 기존 단일 서버 모드에서도 같은 검사를 적용합니다. 이 옵션을 보내지 않은 기존 전송과 명령은 기존 동작을 유지합니다. 서버 파일 준비와 PC 저장 완료는 별개이며, 로컬 MCP의 파일 선택·재시작 후 중복 방지와 실제 Claude 전송 검증은 후속 단계입니다.

## CLI 명령 실행 결과 읽기

`status 실행요청ID`는 상태와 출력 참조만 반환합니다. 저장된 본문이 필요할 때 같은 **실행 요청 ID**로 `output`을 명시적으로 호출합니다. CLI가 해당 요청의 출력 ID를 확인해 기존 owner API로 읽으므로 출력 ID를 별도로 입력하지 않습니다.

```powershell
node @portalArgs output REQUEST_ID
node @portalArgs output REQUEST_ID --offset 0 --limit 4096 --format text
node @portalArgs output REQUEST_ID --offset NEXT_OFFSET --limit 16384 --format json
```

한 호출은 JSON으로 감싼 한 페이지를 반환합니다. 실제 본문은 `text`에 있고 `bytes`, `nextOffset`, `eof`, `totalBytes`, `sha256`이 함께 있습니다. 기본 offset은 0, limit은 4096이며 limit은 4~16384바이트입니다. UTF-8 문자 경계 때문에 실제 페이지가 limit보다 짧을 수 있으므로 다음 조회에는 반환된 `nextOffset`을 사용합니다. 페이지를 자동으로 반복 조회하지 않습니다.

`sha256`은 선택한 **전체 포맷**의 해시입니다. 실행 결과의 출력 참조에 있는 해시는 JSON snapshot의 해시이므로 text 포맷 해시와 다를 수 있습니다. `wholeSha256Verified`는 offset 0부터 EOF까지 한 페이지로 읽어 실제 전체 해시를 확인한 경우에만 true입니다. 여러 페이지로 읽으면 합친 본문의 크기·해시를 별도로 확인해야 합니다. `sshCompleteness: unknown`은 그대로 유지하며 저장된 본문의 EOF가 SSH 원본 전체 수신을 증명하지는 않습니다.

완료되거나 실패한 명령에 준비된 출력이 있으면 읽을 수 있습니다. 대기·거절·만료·결과 불명, 잘못된 출력 결속이나 세션 철회에서는 본문을 반환하지 않습니다. 만료된 출력을 되찾으려고 명령이나 승인을 다시 실행하지 않습니다. 출력 읽기가 실패하면 반환된 같은 실행·출력 ID와 상태부터 확인합니다.

## 한도와 취소

- 파일 하나당 최대 64 MiB, 중계기 총량은 기본 512 MiB입니다. 가져오기 하나가 시작 전에 최대 파일 크기를 예약하고, 완료 후 실측 크기만 유지합니다. 외부 가져오기는 최대 두 개까지 동시에 처리합니다.
- HTTPS/443, 설정한 exact 이름 또는 앞에 wildcard가 붙은 패턴과 일치하는 hostname, 공개 DNS 주소만 사용합니다. TLS는 요청한 hostname을 계속 검증합니다. 모든 DNS 응답을 검사하고 검증한 IP에 연결을 고정합니다. redirect와 압축 응답은 거부합니다.
- 기본 전체 가져오기 제한은 60초, 유휴 제한은 15초입니다. 연결 종료·서비스 종료·오류·한도 초과 시 임시 파일과 예약 용량을 정리합니다. OS가 이미 시작한 DNS 조회 자체는 취소하지 못하지만 늦은 DNS 결과로 연결하지 않습니다.
- 이 서버는 stateless MCP를 사용하므로 별도 POST로 들어오는 논리적 취소 알림이 실행 중 요청을 찾는다고 보장하지 않습니다. 실제 HTTP 연결 종료, 서비스 종료와 시간 제한은 별도로 적용합니다.
- 승인 대기는 생성 시점부터 1시간입니다. 자동화 OFF의 메모리 큐와 ON의 명령 저널 모두 같은 만료를 사용하며, 업로드 도중 staging 제한시간은 기존 10분입니다. 재시작한 요청을 자동 복원하거나 다시 실행하지 않습니다.

## Docker 설정

컨테이너에서도 같은 `BRIDGE_UPLOAD_SOURCE_HOSTS` 설정을 읽으며 기본값은 비어 있습니다. 관리자가 보호된 `/etc/ssh-approval-portal/docker-secrets.env`를 백업하고 같은 쉼표 구분 목록에 확인한 정확한 hostname 또는 앞에 wildcard가 붙은 패턴을 설정한 뒤, 기존 유지보수·Compose 업데이트 절차로 컨테이너를 다시 생성합니다. 컨테이너에 Docker socket이나 추가 권한을 주지 않습니다.

exact 목록만 지원하는 이전 버전으로 복원하기 전에는 wildcard를 확인된 정확한 hostname으로 바꾸거나 해당 버전에 맞는 보호된 설정 백업을 복원합니다. `BRIDGE_UPLOAD_SOURCE_HOSTS` 키를 해석하는 이전 버전도 wildcard 값은 거부할 수 있습니다. 키 자체를 모르는 이미지로 돌아갈 때도 호환되는 보호된 설정 백업을 복원합니다. 네이티브 전용 설정 스크립트를 실행해 Docker 서비스를 변경하지 않습니다.

## 검증 범위

로컬 시험은 파일 입력 스키마, 네트워크 정책, 실제 HTTPS 가져오기, 임시 파일 정리, 승인 전 실행 없음과 승인 후 한 번 실행을 구분해 확인합니다. 실제 플랫폼 임시 주소·Library·Portal 메타데이터 전달과 각 클라이언트의 사용자 승인·파일 저장은 해당 환경에서 성공한 근거가 있어야 완료로 기록합니다. 모의 네트워크 시험이나 공개 문서 다운로드를 플랫폼 파일 업로드 성공으로 표현하지 않습니다.


## PC 파일 ID 전용 로컬 MCP

로컬 stdio 전달기는 PC 사용자가 미리 고정한 파일 의도를 실행합니다. 모델 도구에는 파일 ID만 전달하며 PC 경로, 서버 경로, 대상, 명령, 승인, 덮어쓰기 옵션을 인수로 받지 않습니다. 기존 포털 승인 정책은 그대로 적용됩니다.

먼저 현재 서버의 CLI `targets` 조회에서 사용할 대상의 `id`와 `revision`을 확인합니다. 파일별 대상 버전 결속을 지원하는 서버가 필요합니다. revision이 없거나 다르면 첫 파일 전송을 거절합니다. PC 사용자가 관리하는 설정 파일에 실제 값으로 다음 항목을 지정합니다.

```json
{
  "version": 1,
  "origin": "https://관리자호스트",
  "capabilities": [
    {
      "id": "111111111111111111111111111111111111111111111111",
      "publicName": "선택한 입력.bin",
      "direction": "upload",
      "source": "C:/work/input.bin",
      "target": "default",
      "targetRevision": "0000000000000000000000000000000000000000000000000000000000000000",
      "remotePath": "/tmp/selected-input.bin",
      "size": 0,
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "expiresAt": 1792800000000,
      "elevate": false,
      "overwrite": false
    },
    {
      "id": "222222222222222222222222222222222222222222222222",
      "publicName": "선택한 결과.bin",
      "direction": "download",
      "destination": "C:/work/result.bin",
      "target": "default",
      "targetRevision": "0000000000000000000000000000000000000000000000000000000000000000",
      "remotePath": "/tmp/selected-input.bin",
      "size": 0,
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "expiresAt": 1792800000000,
      "elevate": false
    }
  ]
}
```

예제는 빈 파일 기준입니다. origin, 실제 대상 revision, 경로, 바이트 크기·SHA256, 미래 만료 시각(epoch 밀리초)을 교체합니다. 각 ID는 서로 다른 소문자 16진수 48자이며, 같은 ID의 의도를 바꾸면 기존 기록과 일치하지 않아 실행을 거절합니다. 입력 경로는 절대 일반 파일이어야 하고 저장 대상의 부모 폴더는 이미 있어야 합니다. 저장 대상은 덮어쓰지 않습니다.

설정 파일과 기존 전용 기록 폴더는 PC 사용자만 관리합니다. POSIX에서는 파일 0600·폴더 0700을 사용합니다. Windows에서는 해당 사용자의 비공개 폴더를 사용하며 이 프로그램이 Windows ACL을 설정하거나 검증하지는 않습니다. 같은 OS 사용자나 관리자 권한에 대한 샌드박스 기능은 아닙니다.

```text
node scripts/portal-file-mcp.mjs --manifest 절대설정경로 --journal 기존전용기록폴더 --cloudflared 기존실행경로
```

이 명령을 로컬 MCP 클라이언트의 stdio 서버로 등록합니다. 인증은 기존 cloudflared 로그인 캐시를 공식 실행 파일로 조회하며, 토큰을 모델·명령 인수·로그에 전달하지 않습니다. 새 로그인이나 관리자 승인을 자동으로 수행하지 않습니다. 도구 호출마다 별도 관리자 앱 세션을 열고 닫으며 파일 의도의 만료 시각으로 네트워크 deadline을 제한합니다.

도구는 `file_capabilities`, `file_upload`, `file_download_request`, `file_status`, `file_upload_resume`, `file_save`입니다. 목록 조회는 빈 객체를, 나머지는 `{"capabilityId":"고정된48자ID"}`만 받습니다. 추가 인수는 거절합니다. 승인 대기 `pending`, 서버 준비 `prepared`, 검증된 PC 저장 `saved`는 서로 다릅니다.

시작 기록은 원격 파일 작업 전에 배타 생성·동기화됩니다. 알려진 전송·요청 ID와 성공 저장 영수증은 별도 기록합니다. 프로세스 재시작이나 응답 유실은 새 작업을 시작할 권한이 아닙니다. 전송 ID가 알려져 있으면 `file_upload_resume`으로 같은 바이트·대상·경로만 명시적으로 재개할 수 있습니다. ID를 받지 못한 `unknown`은 새 업로드로 자동 대체하지 않습니다.

저장은 같은 요청의 고정 대상·경로·크기·SHA256을 메타데이터 조회 안에서 확인한 후 시작합니다. PC 파일 발행 후 기록에 실패하면 `save-unknown`이며, 이미 존재하는 파일이 같다는 이유로 저장 성공을 추정하거나 다시 저장하지 않습니다. `savedReceipt`는 과거 검증 저장의 지속 기록이며 이후 사용자의 파일 이동·삭제까지 보증하지 않습니다. 불명확한 기록을 지워 같은 ID를 재실행하지 마세요.

로컬 파일 동기화와 프로세스 재시작 검증은 시스템 전원 상실·파일시스템 전체 복구 또는 외부 효과의 exactly-once 보장이 아닙니다. 이 기능의 로컬·합성 검증과 실제 Claude/SSH 환경의 수용 검증은 별개입니다.
