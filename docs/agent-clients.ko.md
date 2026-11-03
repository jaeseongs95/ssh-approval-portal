# 표준 MCP 클라이언트 사용

1.8 공개 계약은 AI 공급자와 무관한 JSON 입력과 응답을 사용합니다. 이미 연결된 원격 MCP에서 명령·Python 원문·파일 업로드와 다운로드를 처리합니다. 별도 CLI·stdio 전달기·파일 카드·클라이언트 설정 질의는 필수 조건이 아닙니다. 실제 지원 대상과 한도는 `targets`로 확인합니다.

응답은 `contractVersion`, `ok`, `data`, `error`를 갖습니다. `content[0].text`를 JSON으로 해석한 값과 `structuredContent`가 같습니다. text만 제공하는 클라이언트도 같은 상태·페이지 오프셋·해시를 읽을 수 있습니다. 자세한 필드는 [MCP 도구 계약](mcp-tools.ko.md)에 있습니다.

## 작업 제출과 관찰

`submit`은 `kind`에 따라 `command`, `source`, `download`를 받습니다. 서로 다른 종류의 입력을 한 요청에 섞지 않습니다. 부작용이 있는 요청에는 고유한 `operationKey`를 정하고, 응답을 잃으면 같은 키로 `observe`합니다. `target`을 생략하면 등록된 기본 대상만 사용합니다. `expectedTargetRevision`을 함께 전달하면 확인한 대상 설정에 요청을 고정합니다.

```json
{"kind":"command","operationKey":"example-command-0001","target":"default","command":"printf hello","context":"테스트 서버의 표준 출력을 확인합니다."}
```

명령은 정확한 원문을 전달합니다. LF·CRLF·탭과 여러 줄 명령을 보존하며 UTF-8 32768바이트를 넘으면 거부합니다. 원문을 자르거나 나누어 검토를 피하지 않습니다. `context`와 `displayContext`는 선택적인 사실 설명이며 영어 작성이나 특정 산문 형식을 요구하지 않습니다. 설명이나 `operationKey`는 실행 권한을 만들지 않습니다. 전체 명령에 적용되는 서버 정책·필요한 위험 평가·소유자 승인은 계속 적용합니다.

Python은 셸 문자열로 우회하지 않고 명시적 원문 계약을 사용합니다. 대상이 `pythonSource`를 지원해야 하며, 원문·인수·절대 작업 디렉터리를 고정합니다.

```json
{"kind":"source","operationKey":"example-source-0001","target":"default","source":"print('hello')","argv":[],"cwd":"/tmp","elevate":false}
```

`submit`이 반환한 `data.id`는 작업 접수 식별자입니다. 접수가 성공해도 원격 실행 성공을 뜻하지 않습니다. 같은 ID의 `observe`로 상태를 확인합니다.

```json
{"id":"반환된48자리작업ID","waitMs":25000}
```

`pending`은 소유자 결정 대기, `evaluating`은 정책 평가, `queued`는 실행 순서 대기입니다. `starting`·`running`·`terminating`에는 실행이 남아 있을 수 있습니다. `completed`·`failed`·`cancelled`·`denied`·`expired`·`unknown`을 구별합니다. 관찰의 `waitTimedOut:true`는 실행 제한 시간 초과나 취소가 아닙니다. 같은 ID로 관찰을 이어갑니다. 연결 종료도 해당 관찰만 중단합니다.

기본 관찰에는 명령 출력 본문을 포함하지 않습니다. 필요한 경우에만 `includeOutput:true`로 저장된 정제 출력의 페이지를 읽습니다. 응답의 `outputPage.nextCursor`를 다음 입력의 `cursor`로 사용합니다.

```json
{"id":"같은48자리작업ID","includeOutput":true,"cursor":0,"maxBytes":4096}
```

출력 누락·만료·불명확한 결과는 재실행의 근거가 아닙니다. `cancel`은 같은 ID에 취소를 요청하며, 반환된 실제 상태로 결과를 판단합니다. `terminating`은 종료 완료가 아닙니다.

## 원격 MCP만으로 파일 전달

업로드하는 클라이언트는 이미 허용된 방법으로 실제 파일 바이트를 읽을 수 있어야 합니다. 원격 서버는 사용자 PC의 경로를 읽지 않습니다. `targets`의 대상 ID와 `revision`, 정확한 파일 크기·SHA-256·목적지를 `artifact-begin`에 보냅니다.

```json
{"operationKey":"example-upload-0001","target":"default","expectedTargetRevision":"targets에서받은64자리revision","fileName":"example.bin","size":3,"sha256":"전체파일의64자리sha256","remotePath":"/tmp/example.bin","overwrite":false,"elevate":false}
```

반환된 `data.id`를 전송 ID로 보관합니다. `artifact-chunk`에는 정규 base64와 0부터 시작하는 순번을 보냅니다. 청크 하나는 디코딩 후 1~262144바이트입니다. 빈 파일은 청크 없이 finish합니다.

```json
{"id":"전송ID","sequence":0,"data":"AP8B"}
```

`artifact-status`에서 같은 전송 ID의 `received`·`sequence` 또는 이미 제출된 작업을 확인합니다. `artifact-finish`는 정확한 크기와 해시를 검증하고 업로드를 파일 승인 정책에 제출합니다. 원격 반영 여부는 반환된 작업 ID를 `observe`하여 확인합니다. 청크 응답이나 finish 응답이 불명확하면 같은 전송 ID를 조회합니다. 새 전송을 자동으로 만들지 않습니다. 업로드 staging 복구는 실제 보존된 전송 상태로 확인하며, 누락된 기록을 성공으로 해석하지 않습니다.

다운로드는 같은 공개 제출 도구를 사용합니다.

```json
{"kind":"download","operationKey":"example-download-0001","target":"default","remotePath":"/tmp/example.bin","elevate":false}
```

작업이 `completed`가 되면 **같은 작업 ID**로 `artifact-read`를 호출합니다. 소유자용 다운로드 티켓이나 URL은 필요하지 않습니다.

```json
{"id":"다운로드작업ID","offsetBytes":0,"maxBytes":65536}
```

응답의 `data`를 base64로 디코딩해 수신 바이트에 이어 붙이고, `nextOffset`으로 계속 읽습니다. `eof:true` 뒤 전체 수신 크기와 SHA-256이 `totalBytes`·`sha256`과 일치해야 수신을 확인할 수 있습니다. 이는 승인된 다운로드 스냅샷을 읽으며 임의 서버 파일 경로나 변경된 대상의 다른 파일을 읽는 API가 아닙니다. 서버의 `completed`만으로 PC 저장·에이전트 수신을 완료했다고 표시하지 않습니다.

## 데스크톱과 승인 경계

`desktop-open`·`desktop-observe`·`desktop-input`·`desktop-close`는 실제 연결된 OS 그래픽데스크톱을 다룹니다. 웹터미널이나 텍스트 명령 실행과 구별합니다. 대상의 실제 `desktop` capability를 확인합니다. `desktop-observe`는 실제 PNG 이미지와 화면 크기·frame ID·geometry revision·다음 입력 순서를 반환합니다. 입력은 같은 세션의 `epoch`와 최신 frame/geometry, 순번, 고유 `requestKey`에 묶습니다. 키·포인터·텍스트 입력을 자동 재생하지 않으며, `desktop-close`의 자원 해제는 OS 로그아웃을 뜻하지 않습니다. 미설치·미지원·권한 거절을 성공으로 표시하지 않습니다.

Windows 일반 모드는 도우미에 설정된 허용 루트 밖을 `PATH_OUTSIDE_ALLOWED_ROOT`로 거부합니다. 실제 `allowedRoot`는 도구 응답과 관측 시각으로 확인합니다. 테스트 모드에서도 실제 OS 권한·경로 안전성·소유자와 쓰기 권한의 신뢰 검사는 유지합니다. Linux는 기존 SSH 계정 권한을 따릅니다. `elevate:true`는 명시적으로 요청한 기존 권한만 사용하며 ACL 변경·새 자격 증명·UAC 우회를 만들지 않습니다.

`PERMISSION_DENIED`에서는 `diagnostic.origin`의 `policy`와 `os`를 구별합니다. 진단이 없으면 OS 쓰기를 실제 시도했다고 추정하지 않습니다. `PATH_POLICY_UNSUPPORTED`는 설치된 도우미 지원을 확인해야 하는 상태입니다. 실패를 다른 경로나 도구로 자동 재제출하지 않습니다.

소유자 승인이 필요하면 `targets`의 `approval.ownerUrl`과 기존 작업 ID를 안내하고 `observe`합니다. `show-*`·`ui-*`는 소유자 화면 내부 도구이며 일반 에이전트의 자기 승인 경로가 아닙니다. 파일 전송에는 전용 artifact 도구를 권장합니다. 셸을 통한 전송을 일괄 금지하지는 않으며, 호출자가 인코딩과 이스케이프 후에도 정확한 바이트를 보존하고 필요한 승인을 받으며 인증정보와 파일 내용의 무단 노출을 방지해야 합니다. 서버 정책과 기존 승인 경계는 그대로 적용됩니다.

로컬 CLI와 stdio 파일 전달기는 이미 허용·설치된 환경에서 선택적으로 사용할 수 있습니다. 별도 설치·연결·로컬 파일 접근이 검증되지 않았다면 이용 가능하다고 단정하지 않습니다. 실제 클라이언트 연결, Linux/Windows 바이트 왕복, 데스크톱 화면·입력은 각각의 시험 근거가 있어야 지원 완료로 보고합니다.
