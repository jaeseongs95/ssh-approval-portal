# MCP 2.0 공개 도구 계약

2.0.0 통합 후보의 공개 계약이다. UUID `files` 경로의 구현·최종 시험·배포는 별도 실행 근거로 확인한다.

`src/adapters/mcp/public-contract.mjs`의 Zod 객체가 입력 검증·MCP 도구 스키마·결과 검증의 원본입니다. 공개 객체는 명시된 필드만 받습니다. 도구 응답의 `content[0].text` JSON과 `structuredContent`는 동일한 객체입니다.

```json
{"contractVersion":"2.0","ok":true,"data":{},"error":null}
```

업무 거절은 `ok:false`, `data:null`, `error:{code,retryable,executionAttempted}`입니다. `executionAttempted`는 확인된 `true`·`false` 또는 `"unknown"`입니다. MCP 입력 스키마를 위반한 호출은 프로토콜 검증 오류로 거절될 수 있습니다.

| 도구 | 입력과 동작 |
| --- | --- |
| `targets` | 입력 `{}`. 대상 ID·revision·플랫폼·capability·파일 정책·관측 시각·한도·소유자 페이지를 조회합니다. |
| `submit` | 필수 `kind`,`operationKey`. 선택 `target`,`expectedTargetRevision`. `command`는 정확한 `command`, `source`는 `source`,`cwd`와 선택 `argv`,`elevate`, `download`는 `remotePath`와 선택 `elevate`. 명령·원문은 선택적인 `context`,`displayContext`를 받습니다. |
| `observe` | `id` 또는 `operationKey` 하나. 선택 `waitMs` 0~60000, `includeOutput` 기본 false, `cursor` 기본 0, `maxBytes` 기본 4096·최대 16384. |
| `cancel` | 기존 작업 `id`. 실제 상태를 반환합니다. 취소 요청만으로 종료를 선언하지 않습니다. |
| `files` | `action`과 `uuid`. `stat`·`copy`·`move`·`remove`를 처리하며 copy/move의 대상·안정키·목적지 필드는 아래 UUID 계약을 따릅니다. |
| `artifact-begin` | `operationKey`, 대상과 `expectedTargetRevision`, `fileName`,`size`,`sha256`,`remotePath`, 선택 `overwrite`,`elevate`. |
| `artifact-chunk` | 전송 `id`,`sequence`, 정규 base64 `data`. 디코딩 후 최대 262144바이트. |
| `artifact-status` | 같은 전송 `id`. staging metadata 또는 이미 제출된 작업을 조회합니다. |
| `artifact-finish` | 같은 전송 `id`. 크기·해시 검증 뒤 기존 파일 승인 정책으로 제출합니다. |
| `artifact-read` | 다운로드 **작업** `id`, 선택 `offsetBytes` 기본 0, `maxBytes` 1~262144·기본 65536. |
| `desktop-open` | `target`,`expectedTargetRevision`. 실제 설정된 OS 그래픽데스크톱 세션을 엽니다. |
| `desktop-status` | `sessionId`,`epoch`. 화면 픽셀 없이 GUI 준비 상태와 인증 필요 상태를 조회합니다. |
| `desktop-observe` | `sessionId`,`epoch`. PNG 이미지 `content[1]`과 같은 프레임의 JSON metadata를 반환합니다. |
| `desktop-input` | 같은 세션·epoch·`frameId`·`geometryRevision`, 증가하는 `sequence`, 고유 `requestKey`, 명시적 `actions`. |
| `desktop-close` | `sessionId`,`epoch`. lease·입력 상태·연결을 해제하며 OS 로그아웃은 하지 않습니다. |

데스크톱 도구는 실제 desktop application port가 연결됐을 때 등록합니다. 포트 연결과 원격 백엔드 설치·접근 성공은 별개입니다. `targets`의 capability와 실제 호출 결과로 지원 여부를 확인합니다.

작업 응답은 `id`,`operationKey`,`kind`,`state`,`targetId`,`targetRevision`,`approvalMode`,`createdAt`,`expiresAt`,`finishedAt`와 결과 descriptor를 사용합니다. 값이 없으면 `null`입니다. 기본 상태 조회에는 출력 본문과 owner ticket을 포함하지 않습니다. `outputPage`는 `includeOutput:true`일 때만 읽습니다. `cursor`,`nextCursor`,`bytes`,`totalBytes`,`sha256`,`eof`,`expiresAt`로 범위와 무결성을 확인합니다.

상태는 `accepted`,`pending`,`evaluating`,`queued`,`starting`,`running`,`terminating`,`completed`,`failed`,`cancelled`,`denied`,`expired`,`unknown`입니다. `waitTimedOut`는 관찰 제한 시간만 나타냅니다. 실행 제한 시간과 별개이며 관찰 종료가 작업을 취소하지 않습니다. 재접속 시 원래 ID나 키를 사용합니다.

`auditFailure:true`는 종료 감사 기록의 영속화 실패를 뜻하며 원격 실행 결과인 `state`·`failed`와 구별합니다. 성공한 원격 실행도 감사 기록 실패가 있으면 별도 확인이 필요합니다. 감사 오류 원문은 공개하지 않습니다.

`execution`은 실행 감독기가 보존한 제한된 metadata입니다. `reason`은 `exit`,`deadline`,`cancel`,`transport_lost`,`channel_open_failed`,`input_failed`, `remoteState`는 `not_dispatched`,`exited`,`unknown`을 구별합니다. `exitCode`,`signal`,`cleanupComplete`,`requiresReconciliation`,`automaticReplay:false`,`timeoutMs`,`outputState`,`captureFailed`와 stdout/stderr 바이트 수·cursor·잘림 여부를 포함합니다. 확인되지 않은 필드는 `null`이며, raw 출력·오류 원문은 넣지 않습니다. 관찰 제한 시간 초과와 실행의 `reason:"deadline"`은 별개입니다.

현재 공개 `streamPage`는 항상 `null`입니다. 실행 중 raw stdout/stderr spool은 내부 보존용이며 MCP로 공개하지 않습니다. 종료·실패·실행 시간 초과 뒤 정제해 보존한 출력은 준비된 `outputPage`로 명시적으로 읽습니다. 실행 중 raw 출력의 즉시 관측을 지원한다고 해석하지 않습니다.

출력 descriptor는 `captureSource:"redacted-adapter-outcome"`,`sshCompleteness:"unknown"`을 표시합니다. 페이지의 해시는 저장된 정제 결과의 무결성을 확인하며 원격 프로그램 출력 전체의 완전성을 증명하지 않습니다.

`artifact-read` 데이터는 `id`,`artifactId`,`fileName`,`encoding:"base64"`,`data`,`offsetBytes`,`bytes`,`nextOffset`,`totalBytes`,`sha256`,`eof`,`expiresAt`입니다. `nextOffset`으로 페이지를 이어 붙인 뒤 전체 크기와 해시를 검증합니다. 임의 서버 경로나 소유자 티켓을 읽는 API가 아닙니다. 만료·대상 revision 불일치·불완전 작업은 거부합니다.

업로드 staging 상태는 `staging`,`ready`,`expired`,`submitted`입니다. 제출 전에는 `transfer`, 제출 뒤에는 `request`가 있고 다른 쪽은 `null`입니다. 동일한 `operationKey`의 동일 입력은 기존 전송을 복구하고, 다른 입력은 충돌로 거부합니다. 누락된 보존 기록이나 불명확한 결과를 새 전송의 근거로 삼지 않습니다.

## 모델 밖 파일 전송과 UUID files 계약

배포본의 `scripts/portal-files.mjs`가 로컬 경로를 읽어 owner 인증 HTTP로 바이트를 직접 전송한다. 성공 stdout은 `{"uuid":"..."}` 하나다. 모델은 UUID만 받아 원격 MCP의 `files`를 호출한다. 특정 벤더의 첨부파일 ID나 두 번째 로컬 MCP 서버를 요구하지 않는다. 원격 MCP는 PC 경로를 직접 열 수 없다. 인증 준비·CLI 옵션은 [파일 클라이언트 안내](client-files.ko.md)를 참고한다.

| raw owner API | 의미 |
| --- | --- |
| `POST /api/artifacts` | JSON `{operationKey,fileName,size,sha256}`로 임시 수신 예약, `{uuid}` 반환 |
| `PUT /api/artifacts/:uuid/chunks/:sequence` | `application/octet-stream`, `X-Chunk-SHA256`로 최대 262144바이트 전송 |
| `POST /api/artifacts/:uuid/complete` | JSON `{}`. 크기·SHA-256 검증 후 `{uuid}` 반환; 대상 배치 없음 |
| `GET /api/artifacts/:uuid` | 상태·크기·해시·만료·수신 진행 및 연결된 작업 metadata 조회 |

기존 `/api/files/uploads`나 MCP `artifact-finish`의 자동 제출 의미와 다르다. owner 인증·Origin 검사 뒤 body 수신 후에도 권한을 재확인한다. 응답·오류에는 임시 경로나 파일 본문을 넣지 않는다.

`files`의 action은 `stat`, `copy`, `move`, `remove`다. UUID 입력 필드는 `uuid`다. `copy`·`move`는 안정된 `operationKey`와 대상·`expectedTargetRevision`·`remotePath`, 선택 `overwrite`·`elevate`로 기존 대상 upload 정책에 연결한다. 결과 `requestId`를 기존 `observe`로 조회한다. `stat`는 metadata만 읽고 `remove`는 해당 임시 원본만 소비한다. copy는 원본을 유지하고 move는 publication 성공을 확인한 뒤 원본을 소비한다. UUID가 승인이나 OS 권한을 부여하지 않는다.

같은 키·같은 입력은 기존 UUID/작업을 회수하고 다른 입력은 충돌로 거절한다. 응답 유실·admission 불명·unknown publication은 새 키로 재실행하지 않는다. 원래 UUID·request ID·상태를 조회한다. 임시 원본 만료·소비·대상 배치·PC 저장은 구분한다. 최종 허용 필드와 응답은 통합된 공개 스키마를 기준으로 한다.

데스크톱 세션은 UUID `sessionId`, 양의 정수 `epoch`, 대상 revision과 만료에 고정됩니다. 프레임은 `frameId`,`width`,`height`,`geometryRevision`,`coordinateSpace:"physical-pixels"`,`nextInputSequence`,`mimeType:"image/png"`,`imageContentIndex:1`을 갖습니다. 화면 바이트는 실제 MCP image content로 전달합니다. owner identity는 공개 입력·출력에 넣지 않습니다.

입력 action은 `{type:"key",keysym,down}`, `{type:"pointer",x,y,buttons}`, `{type:"text",text}`입니다. 한 호출에 1~128개 action을 받으며 실제 이벤트 한도와 화면 범위는 서비스에서도 검증합니다. 최신 동일 입력 재호출은 기존 receipt만 반환하며 자동 재전송하지 않습니다. `desktop-close`의 `releaseSent`·`cleanupError`로 정리 결과를 구별합니다.

카드를 여는 `show-ui-probe`·`show-approval`·`show-file-transfer` 3개는 `_meta.ui.visibility:["model","app"]`로 모델과 앱에 노출하며 `resourceUri`로 카드를 렌더링합니다. 소유자용 `ui-decide-request`·`ui-upload-begin`·`ui-upload-chunk`·`ui-upload-finish`·`ui-download-link`·`ui-read-command-output` 6개는 `_meta.ui.visibility:["app"]`로 격리하며 렌더링 `resourceUri`를 붙이지 않습니다. owner ticket과 UI 전용 본문은 비공개 metadata에 둡니다. 이 선언만으로 모든 호스트의 실제 필터·렌더링 동작이 검증됐다고 주장하지 않습니다. 공통 공개 도구에는 공급자별 파일 입력 계약·설치·인증·소유자 결정을 넣지 않습니다.
