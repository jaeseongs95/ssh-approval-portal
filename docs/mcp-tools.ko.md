# MCP 1.8 공개 도구 계약

`src/adapters/mcp/public-contract.mjs`의 Zod 객체가 입력 검증·MCP 도구 스키마·결과 검증의 원본입니다. 공개 객체는 명시된 필드만 받습니다. 도구 응답의 `content[0].text` JSON과 `structuredContent`는 동일한 객체입니다.

```json
{"contractVersion":"1.8","ok":true,"data":{},"error":null}
```

업무 거절은 `ok:false`, `data:null`, `error:{code,retryable,executionAttempted}`입니다. `executionAttempted`는 확인된 `true`·`false` 또는 `"unknown"`입니다. MCP 입력 스키마를 위반한 호출은 프로토콜 검증 오류로 거절될 수 있습니다.

| 도구 | 입력과 동작 |
| --- | --- |
| `targets` | 입력 `{}`. 대상 ID·revision·플랫폼·capability·파일 정책·관측 시각·한도·소유자 페이지를 조회합니다. |
| `submit` | 필수 `kind`,`operationKey`. 선택 `target`,`expectedTargetRevision`. `command`는 정확한 `command`, `source`는 `source`,`cwd`와 선택 `argv`,`elevate`, `download`는 `remotePath`와 선택 `elevate`. 명령·원문은 선택적인 `context`,`displayContext`를 받습니다. |
| `observe` | `id` 또는 `operationKey` 하나. 선택 `waitMs` 0~60000, `includeOutput` 기본 false, `cursor` 기본 0, `maxBytes` 기본 4096·최대 16384. |
| `cancel` | 기존 작업 `id`. 실제 상태를 반환합니다. 취소 요청만으로 종료를 선언하지 않습니다. |
| `artifact-begin` | `operationKey`, 대상과 `expectedTargetRevision`, `fileName`,`size`,`sha256`,`remotePath`, 선택 `overwrite`,`elevate`. |
| `artifact-chunk` | 전송 `id`,`sequence`, 정규 base64 `data`. 디코딩 후 최대 262144바이트. |
| `artifact-status` | 같은 전송 `id`. staging metadata 또는 이미 제출된 작업을 조회합니다. |
| `artifact-finish` | 같은 전송 `id`. 크기·해시 검증 뒤 기존 파일 승인 정책으로 제출합니다. |
| `artifact-read` | 다운로드 **작업** `id`, 선택 `offsetBytes` 기본 0, `maxBytes` 1~262144·기본 65536. |
| `desktop-open` | `target`,`expectedTargetRevision`. 실제 설정된 OS 그래픽데스크톱 세션을 엽니다. |
| `desktop-observe` | `sessionId`,`epoch`. PNG 이미지 `content[1]`과 같은 프레임의 JSON metadata를 반환합니다. |
| `desktop-input` | 같은 세션·epoch·`frameId`·`geometryRevision`, 증가하는 `sequence`, 고유 `requestKey`, 명시적 `actions`. |
| `desktop-close` | `sessionId`,`epoch`. lease·입력 상태·연결을 해제하며 OS 로그아웃은 하지 않습니다. |

데스크톱 도구는 실제 desktop application port가 연결됐을 때 등록합니다. 포트 연결과 원격 백엔드 설치·접근 성공은 별개입니다. `targets`의 capability와 실제 호출 결과로 지원 여부를 확인합니다.

작업 응답은 `id`,`operationKey`,`kind`,`state`,`targetId`,`targetRevision`,`approvalMode`,`createdAt`,`expiresAt`,`finishedAt`와 결과 descriptor를 사용합니다. 값이 없으면 `null`입니다. 기본 상태 조회에는 출력 본문과 owner ticket을 포함하지 않습니다. `outputPage`는 `includeOutput:true`일 때만 읽습니다. `cursor`,`nextCursor`,`bytes`,`totalBytes`,`sha256`,`eof`,`expiresAt`로 범위와 무결성을 확인합니다.

상태는 `accepted`,`pending`,`evaluating`,`queued`,`starting`,`running`,`terminating`,`completed`,`failed`,`cancelled`,`denied`,`expired`,`unknown`입니다. `waitTimedOut`는 관찰 제한 시간만 나타냅니다. 실행 제한 시간과 별개이며 관찰 종료가 작업을 취소하지 않습니다. 재접속 시 원래 ID나 키를 사용합니다.

현재 공개 `streamPage`는 항상 `null`입니다. 실행 중 raw stdout/stderr spool은 내부 보존용이며 MCP로 공개하지 않습니다. 종료·실패·실행 시간 초과 뒤 정제해 보존한 출력은 준비된 `outputPage`로 명시적으로 읽습니다. 실행 중 raw 출력의 즉시 관측을 지원한다고 해석하지 않습니다.

출력 descriptor는 `captureSource:"redacted-adapter-outcome"`,`sshCompleteness:"unknown"`을 표시합니다. 페이지의 해시는 저장된 정제 결과의 무결성을 확인하며 원격 프로그램 출력 전체의 완전성을 증명하지 않습니다.

`artifact-read` 데이터는 `id`,`artifactId`,`fileName`,`encoding:"base64"`,`data`,`offsetBytes`,`bytes`,`nextOffset`,`totalBytes`,`sha256`,`eof`,`expiresAt`입니다. `nextOffset`으로 페이지를 이어 붙인 뒤 전체 크기와 해시를 검증합니다. 임의 서버 경로나 소유자 티켓을 읽는 API가 아닙니다. 만료·대상 revision 불일치·불완전 작업은 거부합니다.

업로드 staging 상태는 `staging`,`ready`,`expired`,`submitted`입니다. 제출 전에는 `transfer`, 제출 뒤에는 `request`가 있고 다른 쪽은 `null`입니다. 동일한 `operationKey`의 동일 입력은 기존 전송을 복구하고, 다른 입력은 충돌로 거부합니다. 누락된 보존 기록이나 불명확한 결과를 새 전송의 근거로 삼지 않습니다.

데스크톱 세션은 UUID `sessionId`, 양의 정수 `epoch`, 대상 revision과 만료에 고정됩니다. 프레임은 `frameId`,`width`,`height`,`geometryRevision`,`coordinateSpace:"physical-pixels"`,`nextInputSequence`,`mimeType:"image/png"`,`imageContentIndex:1`을 갖습니다. 화면 바이트는 실제 MCP image content로 전달합니다. owner identity는 공개 입력·출력에 넣지 않습니다.

입력 action은 `{type:"key",keysym,down}`, `{type:"pointer",x,y,buttons}`, `{type:"text",text}`입니다. 한 호출에 1~128개 action을 받으며 실제 이벤트 한도와 화면 범위는 서비스에서도 검증합니다. 최신 동일 입력 재호출은 기존 receipt만 반환하며 자동 재전송하지 않습니다. `desktop-close`의 `releaseSent`·`cleanupError`로 정리 결과를 구별합니다.

소유자용 `show-*`·`ui-*` 도구는 `_meta.ui.visibility:["app"]`로 격리합니다. 이 선언만으로 모든 호스트의 실제 필터 동작이 검증됐다고 주장하지 않습니다. 공통 공개 도구에는 공급자별 파일 입력 계약·설치·인증·소유자 결정을 넣지 않습니다.
