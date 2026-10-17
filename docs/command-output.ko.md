# SSH 실행 결과 보관과 필요할 때 읽기

명령 실행 응답과 상태 조회에는 원문 대신 `output` 참조가 들어갑니다. 원문이 필요하면 `read-command-output`을 호출합니다. 같은 참조를 다시 읽어도 SSH 명령은 실행하지 않습니다. 만료되거나 파일이 없어져도 명령을 자동으로 재실행하지 마세요.

```json
{"outputId":"반환된 48자리 ID","offsetBytes":0,"maxBytes":4096,"format":"text"}
```

`content`에 요청한 부분만 나오며 `structuredContent`에는 범위·다음 위치·EOF·크기·해시가 들어갑니다. 기본 4KiB, 최대 16KiB의 UTF-8 바이트를 읽습니다. 다음 부분은 `nextOffset`을 사용합니다. 문자 중간 offset은 거절합니다. JSON escaping을 포함한 응답도 제한된 크기이며 최악의 본문 직렬화는 약 96KiB에 메타데이터를 더한 크기입니다. 무제한 read-all 도구는 없습니다.

`text`는 기존 화면처럼 text block을 줄바꿈으로 잇고 data가 있으면 JSON을 덧붙인 표시용 표현입니다. `json`은 adapter의 `failed`, `texts` 순서·빈 문자열·줄바꿈, `data`를 보존한 snapshot입니다. JSON 페이지를 이어 붙여 파싱하면 snapshot을 복원할 수 있습니다. `sha256`은 선택한 표현의 해시입니다. 기본 참조의 해시는 JSON snapshot의 해시입니다.

카드와 관리자 페이지의 **출력 보기**를 눌러도 제한된 부분만 표시합니다. 카드 본문은 UI 전용 메타데이터로 받으며 모델 완료 알림에 복사하지 않습니다. 화면이 교체되면 늦게 온 출력 응답을 버립니다. 같은 카드 controller 안에서는 최근 200개까지 요청 ID·대상 revision·완료 상태·출력 참조가 같은 완료 알림을 중복 전송하지 않습니다. 호스트 전체의 정확히 한 번 전달을 보장하지는 않습니다.

## 보관 범위와 제한

저장 대상은 기존 SSH adapter가 마스킹하고 stdout/stderr를 병합해 반환한 결과입니다. `captureSource=redacted-adapter-outcome`, `sshCompleteness=unknown`이 이를 나타냅니다. 현재 upstream 라이브러리는 출력 제한과 청크 문자 변환 때문에 일부 내용을 잃을 수 있으며, 파일화가 이 손실을 복구하지 않습니다. **SSH 전체 원출력 보존을 보장하지 않습니다.**

기존 transfer root 아래의 서비스 전용 `command-outputs`에 payload와 별도 SQLite manifest를 둡니다. 한 출력의 JSON·text 표현 합계 상한은 16MiB, 전체 payload 예약 상한은 128MiB, 항목 상한은 1,000개입니다. manifest는 항목별 256KiB 상한과 payload에 비례한 청크 목록으로 제한합니다. 전송 staging 예산은 별도이며 기본 512MiB입니다. 디스크 사전 검사는 최소 출력 예약량+1MiB를 요구하지만 파일시스템의 다른 사용자가 나중에 디스크를 채우는 것은 막지 못합니다.

완료부터 1시간 보관하고 만료된 출력만 정리합니다. 파일 삭제가 실패하면 항목과 용량 계산을 유지합니다. 출력 만료와 승인 대기 만료, durable requestKey 기록은 별도입니다. 출력 정리는 command journal이나 실행 replay 보호를 삭제하지 않습니다. 파일 권한은 POSIX에서 서비스 소유·비공개·regular·단일 링크로 검사합니다. Windows에서는 기존 private transfer root의 ACL 상속을 전제로 하며 ACL 자체를 검사하는 기능은 추가하지 않았습니다.

| 시점·상태 | 처리 |
| --- | --- |
| 실행 전 용량·작은 쓰기·manifest 기록 실패 | SSH 호출 전 거절 |
| 실행 후 JSON 직렬화·상한·write/sync/rename/manifest 갱신 실패 | 알려진 실행 성공/실패는 유지, 출력 unavailable. 원문 fallback·자동 재시도 없음 |
| pending 상태로 프로세스 중단 | 재시작 시 출력 unavailable. 실행 성공으로 추정하거나 SSH 재실행하지 않음 |
| 예약 파일 생성 뒤 manifest 기록 전 중단 | 대상 권한이 없는 unavailable 항목으로 격리·용량 반영. 서비스는 계속 시작하며 만료 후 정리 |
| payload 게시 뒤 journal 결과 저장 전 중단 | 파일은 보관하며 command journal의 unknown 처리와 분리. 파일 존재만으로 실행 성공을 만들지 않음 |
| 기존 command journal 원문 | snapshot 게시 뒤에만 참조로 교체. 실패하면 DB 원본 보존, 외부 원문 차단, 재시작 때 재시도 가능 |
| 만료·파일 부재·변조 | 명시적 조회 거절, 과거 실행과 replay 기록은 유지 |

manifest는 SQLite의 private 저장소에 결속된 형식·범위·전체/청크 해시를 보관합니다. 읽을 때는 실제 반환 범위와 겹치는 16KiB 청크만 읽고 그 버퍼의 해시를 검사합니다. 페이지마다 전체 payload를 다시 스캔하지 않습니다. 서비스 계정이나 관리자까지 장악한 공격자가 payload와 manifest를 함께 바꾸는 상황은 방어 범위 밖입니다. 재시작은 전송용 `.part` 수명과 구분하며 게시되지 않은 출력 파일을 임의로 재실행해 복구하지 않습니다.

## 권한과 캐싱

출력 ID나 해시는 권한이 아닙니다. MCP는 기존 서비스 bearer, 웹은 기존 관리자 인증을 요구합니다. 매 읽기에서 원래 target/profile/revision·활성화 상태·만료를 확인합니다. 현재 공통 bearer는 사용자 대화별 격리를 제공하지 않습니다. HTTP 응답의 `no-store`는 유지합니다.

첫 구현은 불변 파일과 OS 파일캐시를 사용합니다. RAM·Redis·상태 응답 캐시를 추가하지 않았습니다. 명령 문자열이 같아도 다른 실행에는 다른 출력 ID를 발급하며 실행·Jev 평가·승인 권한을 재사용하지 않습니다. 기본 메타데이터에는 매번 변하는 readAt/cacheHit를 넣지 않습니다.

Prompt cache는 별개입니다. 플러그인이 현재 호스트의 모델 요청 설정을 제어하거나 cache hit·구독 차감을 보장하지 않습니다. 실제 효과는 기본 응답의 직렬화 bytes와 명시적 조회 bytes·SSH 호출 수로 측정하며 모델 token 절감과 구분합니다.

## AIK 관측 계약

기존 `run`과 `status`의 요청 결속·receipt 흐름을 유지합니다. 새 `output(requestId, range)`에는 trusted authority의 `revalidateObservation(authorization, observation)` capability가 필요합니다. 이 함수는 실행 lease와 별도로 원 요청에 대한 **현재 관측 권한**을 검사해야 합니다. capability가 없으면 출력 조회를 거절하며 실행 권한을 대신 사용하지 않습니다.

adapter는 lookupRequest 후, status 조회 전, 출력 조회 전, 바이트 반환 전에 관측권한을 확인합니다. observation에는 원 requestId와 조회로 확인한 outputId/targetId/revision이 들어갑니다. 호스트는 이를 원 요청의 trusted binding과 대조해야 합니다. MCP 응답의 주장만 권한으로 사용하면 안 됩니다. `read-command-output`의 MCP port는 본문을 잃지 않도록 전체 CallToolResult(`content`+`structuredContent`)를 반환해야 합니다. 세션·비직렬화 권한 객체는 MCP로 보내지 않습니다.
