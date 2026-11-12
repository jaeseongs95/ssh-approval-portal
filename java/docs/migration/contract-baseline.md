# 계약 기준본 (Contract Baseline) — ssh-approval-portal 2.4.2 -> Java 3.0.0

- 대상 소스: `D:/codex/build/ssh-portal-v300-prep` (브랜치 `feature/v300-prep`, HEAD `a44c4d145ca1a3b2fa68701a5b7f5cd92ff15967`, package.json version `2.4.2`).
- 결정: 「계약 유지」 (MCP 도구 이름·입력 스키마·응답 봉투 Contract 2.0, 관리자 HTTP API, 완료 hook 형식, 설정 키).
- 용도: JUnit 계약 시험이 Java 서버의 실제 출력을 이 기준본과 비교한다. 기준본은 `java/portal-web/src/test/resources/contract/` 아래에 있다.
- 작성 방식: 소스를 읽어 옮겼다. Node·Gradle·Python은 실행하지 않았다(지시). 설명 문장은 한 글자도 다듬거나 번역하지 않고 소스 문자열 그대로 두었다(아래 4.3의 grep 대조로 확인).

## 1. 산출물과 출처

기준본 루트: `D:/codex/build/ssh-portal-v300-prep/java/portal-web/src/test/resources/contract/`

| 산출물 | 내용 | 출처(file:line, HEAD a44c4d1) |
| --- | --- | --- |
| `mcp/tools/<이름>.json` 24개 | 도구별 name, description, inputSchema, outputSchema, annotations, `_meta`(UI 도구), visibility | 아래 2절 표 |
| `mcp/server.json` | serverInfo 출처, instructions 원문, 리소스, contractVersion, 도구 분류, 전송 방식 | `src/adapters/mcp/server.mjs:15,17,19,20,23`; `public-contract.mjs:5`; `src/adapters/http/protocol.mjs:101-102`; `package.json:2-3,22,25` |
| `mcp/envelope.schema.json` | 응답 봉투 JSON Schema, 봉투 규칙, error.code 어휘 | `public-contract.mjs:73-75,145-148,149-161,162-168`; 코드 어휘는 `src/**/*.mjs` grep |
| `http/admin-routes.json` | MCP 포트 2건 + 관리자 포트 49건 항목(합계 51건) | `src/adapters/http/protocol.mjs:87-310`, `file-api.mjs`, `opaque-file-api.mjs`, `src/adapters/security/admin-policy.mjs:4-37`, `bridge.mjs:16-17` |
| `hooks/claude-code.json`, `codex.json`, `antigravity.json` | hook 정의 | `hooks/*.json` |
| `hooks/claude-plugin.json`, `hooks/codex-plugin.json` | 두 plugin.json (이름 충돌 때문에 접두어를 붙임) | `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` |
| `settings/settings-contract.json` | 설정 계약 | `config/settings-contract.json` |

참고만 한 문서: `docs/mcp-tools.ko.md` (도구 입력 요약·raw owner API 요약이 소스와 어긋나지 않음을 제목·표 수준에서 확인).

### 바이트 복사에 관한 사실

- 6개 복사본(hooks 3, plugin 2, settings 1)은 `git show HEAD:<원본경로>`의 출력과 `cmp`로 바이트 동일함을 확인했다(종료 코드 0, 6건 모두 OK).
- 작업 사본(working tree)의 원본 파일은 CRLF이고 git 인덱스(blob)는 LF이다(`git ls-files --eol`: `i/lf w/crlf`). 복사본은 blob(LF)과 같다. 작업 사본 CRLF 바이트와는 다르다. 의도: 저장소 정본은 blob이고 CRLF는 autocrlf 변환 결과이다.
- 복사는 Write 도구로 했다(공통 규칙의 Bash `cp` 금지와 부모의 Bash 쓰기 차단을 지킴).

## 2. 도구 목록 (24개)

접두어 없는 upstream 이름. 포털이 `BRIDGE_UI_TOOL_PREFIX`(기본 `ssh-approval-bridge_`)를 붙인다(`config/settings-contract.json` defaults).

| # | 도구 | 구분(visibility) | 소스(등록·스키마·설명) |
| --- | --- | --- | --- |
| 1 | targets | public | `public-contract.mjs:78,96,185-197`; 설명 :197 |
| 2 | submit | public | :79-83,96,198-199,103-110 |
| 3 | observe | public | :84-85,96,200-205 |
| 4 | cancel | public | :86,96,206-207 |
| 5 | files | public | :87-88,97,208-224 |
| 6 | artifact-begin | public | :89-90,98,225-228 |
| 7 | artifact-chunk | public | :91,98,229-230 |
| 8 | artifact-status | public | :92,98,231-235 |
| 9 | artifact-finish | public | :92,99,236-237 |
| 10 | artifact-read | public | :93,99,238-241 |
| 11 | desktop-open | public (desktop 서비스가 있을 때만 등록, :242) | :267,275,285-286 |
| 12 | desktop-status | public | :268,276,287-288 |
| 13 | desktop-observe | public | :269,275,289-294 |
| 14 | desktop-input | public | :270-271,277,295-296 |
| 15 | desktop-close | public | :272,278,297-300 |
| 16 | show-ui-probe | public(모델·앱 모두 보임, `_meta.ui.visibility ["model","app"]`) | `server.mjs:25,43` |
| 17 | show-approval | public(위와 동일) | `server.mjs:26,44-47` |
| 18 | show-file-transfer | public(위와 동일) | `server.mjs:27,48-60` |
| 19 | ui-decide-request | appOnly(`_meta.ui.visibility ["app"]`) | `server.mjs:28,61-65` |
| 20 | ui-upload-begin | appOnly | `server.mjs:29,66-70` |
| 21 | ui-upload-chunk | appOnly | `server.mjs:30,71-74` |
| 22 | ui-upload-finish | appOnly | `server.mjs:31,75-79` |
| 23 | ui-download-link | appOnly | `server.mjs:32,80-84` |
| 24 | ui-read-command-output | appOnly (설명은 `toolDescriptions`가 아니라 호출 옵션 `description`으로 덮어씀, 그래서 문구가 다른 ui 도구와 달리 'Owner UI only:'로 시작하지 않음) | `server.mjs:33(미사용),85-93` |

- annotations: 공개 도구(1~15)는 `{readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly}` (`public-contract.mjs:171-174`). 읽기 전용은 targets, observe, artifact-status, artifact-read, desktop-observe 5개. show/ui 도구(16~24)는 `{readOnlyHint, destructiveHint: !readOnly}`만 가진다(`server.mjs:35-38`, idempotentHint 없음). 읽기 전용은 show-ui-probe, show-approval, show-file-transfer, ui-download-link, ui-read-command-output.
- `_meta`: 공개 도구 1~15에는 `_meta`가 없다. 16~18은 `{ui:{resourceUri, visibility:["model","app"]}}`, 19~24는 `{ui:{visibility:["app"]}}` (`server.mjs:38`). `resourceUri`는 `ui://ssh-approval/card-${sha256(uiHtml)}.html`로 실행 때 계산된다(`server.mjs:15`, `src/domain/validation.mjs:5`). 파일에는 템플릿 문자열로 적었다.
- title: 소스에 도구 title 지정이 없어 모든 도구 파일에 `title`이 없다.
- 응답 봉투: 공개 도구 1~15만 Contract 2.0 봉투를 쓴다. show-*·ui-* 도구는 봉투 없이 `structuredContent`와 `_meta.sshApproval`(예: show-ui-probe `server.mjs:43`)을 쓴다(각 도구 파일 최상위 `portalRules.outputSchema`에 적음).
- 실패 응답: 공개 도구는 `isError: true` + 봉투(`ok:false`) (`public-contract.mjs:167`). show-*·ui-* 도구는 `results.mjs:105-130`의 `refused()` 형식(일반 문구 'Request refused or failed. Check authentication, state, limits and permissions.' 또는 context/source/read 거절 JSON/문구)이다. 이 `refused()` 본문 문구는 기준본에 도구 파일로 옮기지 않았다(봉투 아님). Java가 같은 문구를 내야 하는지 여부는 확인이 필요하다(미확인 항목 참조).

## 3. Zod -> JSON Schema 대응 규칙 (판단이 들어간 곳)

Zod 4.4.3, `@modelcontextprotocol/sdk` 1.32.1 (`package.json:22,25`). 소스에는 Zod 정의만 있으므로, 실서버가 내보내는 JSON Schema(세션에 노출된 draft-07 스키마)를 길잡이로 삼아 아래 규칙으로 옮겼다. 규칙의 근거가 실서버 관찰인 것은 그렇게 표시한다.

| Zod (소스) | JSON Schema (기준본) | 비고 |
| --- | --- | --- |
| `z.object(fields).strict()` (`public-contract.mjs:6`) | `type: object`, `properties`, `additionalProperties: false` | 실서버 입력 스키마와 일치 |
| `z.object(...)` 비strict (`server.mjs:66` 중첩 transfer; `results.mjs` 출력 스키마들) | `additionalProperties` 생략 | Zod 기본은 모르는 키를 제거(strip)한다. 실서버의 렌더링은 ui 도구가 노출되지 않아 확인 못 함(미확인) |
| `.passthrough()` (`results.mjs:36,41`, `server.mjs:86`) | `additionalProperties: true` | |
| `z.string().regex(/…/)` | `pattern` (정규식 원문 그대로, JSON 문자열 이스케이프만) | `(?![\s\S])`는 ECMAScript 문법; Java `Pattern`도 지원 |
| `.min(n)` / `.max(n)` (string) | `minLength` / `maxLength` | UTF-16 코드 단위 기준 |
| `.optional()` | `required`에서 제외 | |
| `.default(x)` | `default: x` 추가, 입력 스키마의 `required`에서 제외 | 실서버와 일치 |
| `.nullable()` | `type: [T, "null"]` 또는 `enum`에 `null` 포함 또는 `anyOf [ref, null]` | 키는 `required`에 남는다(값만 null 허용) |
| `z.number().int()` | `type: integer` + 안전 정수 경계 `maximum: 9007199254740991` (하한은 `.nonnegative()` -> `minimum: 0`, `.positive()` -> `exclusiveMinimum: 0`) | 실서버 스키마에서 `sequence`·`epoch` 등에 이 경계가 붙어 있는 것을 확인함. 출력 정수 `exitCode`는 `minimum -9007199254740991`도 붙임(Zod 4 `.int()` 동작에서 유추, 실서버 미노출) |
| `z.number().int().max(MAX_BYTES)` | `maximum: 67108864` | `MAX_BYTES = 64*1024*1024` (`src/contracts/ports.mjs:2`) |
| `z.number()` (`results.mjs` createdAt 등) | `type: number` | |
| `z.literal(x)` | `const: x` (입력에서는 실서버가 `type`도 같이 내므로 문자열 const에는 `type: string`을 붙임) | |
| `z.enum([...])` | `enum: [...]` (+ 입력은 `type: string`, 실서버와 일치) | |
| `z.discriminatedUnion('type', [...])` (`public-contract.mjs:261`) | `oneOf: [...]` | 실서버와 일치 |
| `z.union([z.boolean(), z.literal('unknown')])` | `anyOf: [{type: boolean}, {const: "unknown"}]` | |
| `z.string().url()` (`public-contract.mjs:60`) | `format: uri` | 정확한 URL 검증 규칙은 Zod 내부 정규식이라 옮기지 않음 |
| `z.string().uuid()` (`public-contract.mjs:245`) | `format: uuid` + 실서버가 내보낸 `pattern` | `pattern` 값은 소스에 없고 Zod 4.4.3 내부 정규식이다. 실서버 스키마에서 그대로 옮김 |
| `z.array(x).max(n)` / `.min(n)` | `maxItems` / `minItems` | |
| `object.extend({...})` (`public-contract.mjs:63,258`) | 필드를 합쳐 풀어 씀 | |
| `responseSchema(data)` + `.refine(ok ? data!==null && error===null : data===null && error!==null)` (`public-contract.mjs:74-75`) | outputSchema에는 표현하지 않음 | Zod `.refine`은 SDK 공개 JSON Schema에 나타나지 않으므로 outputSchema에 `if/then/else`를 넣지 않는다. 규칙 원문은 최상위 `portalRules.outputSchema`에만 기록 |
| `.refine(...)` 그 외 | 표현하지 못함 -> 입력·출력 모두 도구 파일 최상위 `portalRules`에 원문 코드와 함께 기록 | 아래 3.1 |

출력 스키마(`outputSchema`) 표현: Zod 출력 객체는 `.optional()`이 아니면 키가 항상 존재하므로 `required`에 넣었다. `$defs`는 도구 파일마다 자기완결로 중복해 넣었다(JSON Schema 검증기가 파일 간 `$ref`를 풀 필요가 없게). `operationData` 블록은 submit·observe·cancel·artifact-finish·files·artifact-status 6개 파일에 동일하게 들어 있다.

`inputSchema`는 실서버가 내는 그대로 `"$schema": "http://json-schema.org/draft-07/schema#"`(`@modelcontextprotocol/sdk` 1.32.1, ssh-test 노출본에서 확인)로 적었고, `x-portal-rule` 같은 확장 키는 `inputSchema` 안에 두지 않는다. 비교 규칙 때문에 inputSchema는 노출본과 키·값이 같아야 하기 때문이다(키 순서 차이는 무시). 입력 쪽 설명은 도구 파일 최상위 `portalRules` 객체로 옮겼다(키는 `inputSchema`, `inputSchema.properties.<이름>` 같은 경로 문자열). `outputSchema`는 소스에서 옮긴 값 그대로이고 `"$schema": "http://json-schema.org/draft-07/schema#"`를 갖는다. `x-portal-rule`과 `.refine`을 대신하려던 `if/then/else`는 outputSchema에서 모두 지웠고(Zod `.refine`은 SDK 공개 JSON Schema에 나타나지 않는다), 그 규칙은 최상위 `portalRules`(`outputSchema`, `outputSchema.$defs.executionData`, `_meta` 키)에만 남겼다. Zod 타입에서 나오는 구조(union -> anyOf, nullable 등)는 outputSchema에 그대로 있다. outputSchema `$schema` = draft-07, 근거 `test/mcp-contracts.test.mjs:244`(2.x 시험 단언), 노출본 대조 불가(7절 12번). 이는 「소스 기준, 노출본 대조 불가」이며 실서버 출력 스키마의 방언은 확인하지 못했다.

### 3.1 JSON Schema로 옮기지 못한 규칙 (모두 도구 파일 최상위 `portalRules`에 원문 기록)

아래 표의 '기록 위치' 열에서 입력 규칙(submit, observe, files, artifact-chunk, desktop-input의 text, ui-upload-begin, ui-upload-chunk, ui-read-command-output, show-file-transfer)은 해당 도구 파일 최상위 `portalRules`로 읽는다. 출력 쪽 규칙(봉투 refine, presentExecution, desktop-observe 이미지, show/ui 도구의 결과 형식)은 `portalRules.outputSchema`, `portalRules."outputSchema.$defs.executionData"`, `portalRules._meta`에 있다.

| 규칙 | 소스 | 기록 위치 |
| --- | --- | --- |
| `textBytes(limit)`: `.refine(value => utf8WithinLimit(value, limit), 'Maximum ${limit} UTF-8 bytes')` — UTF-8 바이트 길이 <= limit, 잘 짜인 UTF-16 (`utf8WithinLimit`: `src/contracts/ports.mjs:11-12`). `command`(limit 32768), `source`(limit 16384)에 적용 | `public-contract.mjs:14,80` | tools/submit.json `command`, `source` |
| `text.refine(value => value.isWellFormed(), 'Well-formed text required')` | `public-contract.mjs:264` | tools/desktop-input.json actions[text].text |
| `validateSubmit`: kind별 허용 필드 집합, kind별 필수 필드 (오류 `OPERATION_INPUT_CONFLICT`, `OPERATION_INPUT_REQUIRED`) | `public-contract.mjs:103-110,198` | tools/submit.json 최상위 `portalRules` |
| observe 핸들러 규칙: id/operationKey 정확히 하나 (`OPERATION_LOOKUP_REQUIRED`), includeOutput=false이면 cursor 0·maxBytes 4096 (`OUTPUT_READ_NOT_REQUESTED`) | `public-contract.mjs:201-202` | tools/observe.json |
| files 핸들러 규칙: copy/move 필수 필드와 stat/remove 허용 필드 (`FILE_ACTION_INPUT_CONFLICT`, `FILE_ACTION_INPUT_REQUIRED`) | `public-contract.mjs:208-213` | tools/files.json |
| `decodeArtifactChunk`: 정규 base64, 1..262144바이트, 재인코딩 일치 (`ARTIFACT_INVALID_CHUNK`) | `public-contract.mjs:111-116,229` | tools/artifact-chunk.json, ui-upload-chunk.json |
| `presentExecution`: 필드별 `safeParse` 실패 시 null로 대체, 객체가 아니면 execution 전체 null | `public-contract.mjs:34-40` | tools/submit.json 등 `executionData` |
| `desktop-observe` 결과의 `content[1]` PNG 이미지, `imageContentIndex: 1`, 프레임이 PNG가 아니면 `DESKTOP_INVALID_FRAME` | `public-contract.mjs:145-148,180,289-294` | tools/desktop-observe.json |
| 서버 옵션 `maxToolInputElements = 7 + 128*5 = 647` | `server.mjs:19` | tools/desktop-input.json, mcp/server.json |
| show-file-transfer의 `remotePath()`/`windowsRemotePath()` 문법 검증 | `server.mjs:51`, `src/domain/validation.mjs` | tools/show-file-transfer.json (문법 자체는 옮기지 않음) |
| ui-read-command-output의 원본 요청·outputId 결속 검사 | `server.mjs:90` | tools/ui-read-command-output.json |
| 봉투 `error.code`: 임의 던짐 오류의 `.code`가 정규식과 맞을 때만 그 값, 아니면 메시지 매핑, 아니면 `REQUEST_REFUSED`; `retryable`, `executionAttempted` 산식 | `public-contract.mjs:162-168` | mcp/envelope.schema.json `x-portal-wire` |

핸들러 동작 중 스키마 밖이지만 Java가 같아야 할 사항(기준본 파일에는 넣지 않고 여기에만 기록):

- targets 응답 조립: `platform` 기본 `'linux'`; `commandShell`은 windows이면 `'windows-powershell-5.1'`, 아니면 `'posix'`; 능력 값은 `=== true`일 때만 true; `gui`는 desktop 서비스에 `capabilities` 함수가 있을 때만 포함; `limits` 값은 commandBytes 32768, sourceBytes 16384, chunkBytes 262144, outputPageBytes 16384, maxWaitMs 60000 고정, artifactBytes는 `min(settings.maxBytes ?? 67108864, 67108864)`; `approval.ownerUrl`은 `settings.adminOrigin`, `agentSelfApproval`은 false (`public-contract.mjs:185-196`).
- `presentOperation` 매핑(상태·kind·output 만료 판정 등): `public-contract.mjs:119-143`. `kind`는 `job.operation.sourceContract`가 있으면 `'source'`.
- artifact-begin 응답의 `maxChunkBytes`는 항상 262144(`public-contract.mjs:63,227`).

## 4. 실서버 노출본 대조

방법: 이 세션의 도구 목록에서 `ToolSearch "+ssh-test"`(최대 30)로 `mcp__ssh-test-mcp__ssh-test_*` 도구 정의(설명·입력 스키마)를 불러와 위 JSON과 비교했다. 도구는 호출하지 않았다(스키마만 봄). 포털 접두어 `ssh-test_`는 차이로 세지 않았다. 함께 노출된 `portal_list_servers`, `portal_toggle_servers`, `portal_toggle_single_server`는 포털 자체 도구라 upstream 계약 밖이며 비교 대상이 아니다.

### 4.1 대조 결과 표

설명은 실서버 설명 문자열을 `grep -F`로 기준본 JSON의 `"description"` 값과 정확히 대조했다(18건 모두 1건 일치). 입력 스키마는 속성 이름, `required`, 각 속성의 type·pattern·minLength·maxLength·minimum·maximum·exclusiveMinimum·enum·default·maxItems·minItems·format·const·oneOf, `additionalProperties`를 하나씩 대조했다.

| 도구 | description | inputSchema | 차이 내용 |
| --- | --- | --- | --- |
| targets | 일치 | 일치 (속성 없음, additionalProperties false) | 없음 |
| submit | 일치 | 일치 (kind enum 3, operationKey·target·expectedTargetRevision pattern, command 1..32768, source 1..16384, argv maxItems 16·items maxLength 512, cwd 1..512, remotePath 1..4096, elevate, context·displayContext maxLength 8192; required kind·operationKey) | 없음 |
| observe | 일치 | 일치 (waitMs default 0 max 60000, includeOutput default false, cursor default 0, maxBytes default 4096 4..16384; required 없음) | 없음 |
| cancel | 일치 | 일치 (id pattern) | 없음 |
| files | 일치 | 일치 (action enum 4, uuid pattern, operationKey, target, expectedTargetRevision, remotePath 1..4096, overwrite, elevate; required action·uuid) | 없음 |
| artifact-begin | 일치 | 일치 (size 0..67108864, overwrite·elevate default false; required 7개) | 없음 |
| artifact-chunk | 일치 | 일치 (data 1..349528, sequence 0..9007199254740991) | 없음 |
| artifact-status | 일치 | 일치 | 없음 |
| artifact-finish | 일치 | 일치 | 없음 |
| artifact-read | 일치 | 일치 (offsetBytes default 0, maxBytes default 65536 1..262144) | 없음 |
| desktop-open | 일치 | 일치 (requestKey pattern; required target·expectedTargetRevision) | 없음 |
| desktop-status | 일치 | 일치 (sessionId format uuid + pattern, epoch exclusiveMinimum 0) | 없음 |
| desktop-observe | 일치 | 일치 | 없음 |
| desktop-input | 일치 | 일치 (actions 1..128 oneOf key/pointer/text, 각 variant additionalProperties false, keysym 1..536870911, buttons 0..255, text 1..2048, requestKey pattern) | 없음 |
| desktop-close | 일치 | 일치 | 없음 |
| show-ui-probe | 일치 | 일치 (속성 없음) | 없음 |
| show-approval | 일치 | 일치 | 없음 |
| show-file-transfer | 일치 | 일치 (direction enum, remotePath maxLength 4096, elevate·overwrite default false; required direction·remotePath) | 없음 |

요약: 대조 가능한 18개 도구 중 설명 18/18 일치, 입력 스키마 18/18 일치, 내용 차이 0건.

재대조(wire 보정 후): 24개 도구 파일의 `inputSchema.$schema`를 `http://json-schema.org/draft-07/schema#`로 바꾸고, `inputSchema` 안의 `x-portal-rule`을 모두 최상위 `portalRules`로 옮겼다(`visibility`는 처음부터 최상위). PowerShell로 24개 파일을 파싱해 `inputSchema` 안에 `x-portal` 문자열이 없음을 확인했고(24/24), 노출된 18개 도구의 `inputSchema`를 컴팩트 JSON으로 다시 뽑아 세션의 노출본과 속성 이름·`required`·모든 제약 키워드·`default`·`additionalProperties`·`$schema`까지 하나씩 대조했다. 18/18이 키·값이 같다(재대조 결과: 일치 18, 차이 0).

차이로 세지 않는 사항: 키 순서는 비교에서 무시한다(JSON 객체). 이전 판에서 차이로 적었던 `$schema` 방언과 `x-portal-rule` 확장 필드는 위 보정으로 inputSchema에서 사라졌다. 도구 파일 최상위의 `portalRules`, `visibility`, `outputSchema`, `annotations`는 inputSchema 밖이라 이 비교의 대상이 아니다.

도구 집합 차이:
- 기준본 24개 중 6개(ui-decide-request, ui-upload-begin, ui-upload-chunk, ui-upload-finish, ui-download-link, ui-read-command-output)는 실서버 노출 목록에 없다. appOnly 도구이고 instructions가 'private ui-* is not for agents'라고 밝히므로 예상된 부재이다. 이 6개의 입력 스키마·설명은 소스(`server.mjs`)만 근거이고 실서버 대조는 하지 못했다(미검증).
- 실서버에 노출된 18개는 기준본 public 15 + show-* 3과 정확히 같은 이름 집합이다(접두어 제외).

대조하지 못한 항목(노출본에 없음): outputSchema, annotations, `_meta`, serverInfo(name/version), 리소스 목록. 이들은 소스에서 옮긴 값 그대로 두었고 「소스 기준, 노출본 대조 불가」이다(`mcp/server.json`의 `provenance`에도 표시). 소스에 값이 없어 옮기지 못한 것은 7절 미확인 목록에 적었다. instructions는 세션의 MCP 안내문(ssh-test-mcp)과 소스 `server.mjs:20`의 문자열이 같음을 확인했고, `server.json`의 instructions를 소스와 `grep -F`로 대조했다(1건 일치).
실서버 판본: 서버가 알리는 버전이 이 세션에 보이지 않아, 시험 서버가 HEAD a44c4d1과 같은 판본인지는 확인하지 못했다. 위 일치는 "지금 도는 서버의 노출 스키마가 이 소스에서 옮긴 기준본과 같다"는 뜻이지 판본 동일성의 증명은 아니다.

### 4.2 소스 대조(기준본 파일 vs 소스)

- 설명 24개: 각 JSON의 `description` 값이 `public-contract.mjs`/`server.mjs`에 문자열로 그대로 들어 있는지 `grep -F`로 확인(24건 모두 1건 일치).
- `server.json` instructions: `server.mjs:20`과 `grep -F` 일치(1건).
- hooks·plugin·settings 6건: `cmp`로 git blob과 바이트 동일(1절).

## 5. 관리자 HTTP API 요약

상세는 `http/admin-routes.json`(항목별 `source`, `auth`, `requestShape`, `responseShape`). 이 절은 인증 모델과 판단만 적는다.

- 바인딩: 두 포트 모두 `127.0.0.1`, 포트는 `BRIDGE_MCP_PORT`(기본 39124), `BRIDGE_ADMIN_PORT`(기본 39125) (`bridge.mjs:16-17`, settings-contract defaults).
- MCP 포트 인증: `Authorization: Bearer <BRIDGE_MCP_TOKEN>` (`src/adapters/security/tickets.mjs:9`). `/health`만 인증 없이 응답한다.
- 관리자 포트 인증 모델(`admin-policy.mjs:4-37`): routeKind가 maintenance(6개 경로)이면 모든 모드에서 Bearer `BRIDGE_ADMIN_TOKEN`. 그 밖에는 `adminAccess.mode`가 `access`/`oidc`이면 검증된 신원이 필요하고(api·download는 브라우저 세션도 필요, `/api/session/start`·`/logout` 제외), `token`이면 api routeKind만 Bearer `BRIDGE_ADMIN_TOKEN`이 필요하며 static·session·download는 관리자 토큰이 필요 없다. 추가로 api·maintenance 경로는 허용 목록에 있는 GET이 아니면 POST + `Origin == adminOrigin`이어야 한다(`/api/operations/by-key` 예외). artifact 경로는 읽기·쓰기 모두 `Origin == adminOrigin`과 principal이 필요하다(token 모드는 고정 subject `portal-token-owner`).
- 판단: 응답 본문 필드는 소스에서 직접 보이는 것만 적고, 하위 서비스(commandPolicy, environmentEditor, agentCli, capacity, desktop, lifecycle 등)가 돌려주는 필드는 "미확인"으로 두었다.
- 판단: maintenance 경로는 핸들러가 메서드를 검사하지 않아 `method: "*"`로 적었다. 인증 정책상 실제로는 POST만 통과한다.
- 판단: `/api/{id}/(approve|deny|download)`도 핸들러가 메서드를 검사하지 않으나 같은 이유로 POST로 적었다.
- 판단: 조건부 등록 경로(`/api/capacity`, `/api/desktop/*`, `/api/agent-cli/*`, `/api/automation-metrics`, `/api/environment*`, `/api/command-policy*`)는 해당 서비스가 없으면 등록되지 않고 404로 떨어진다. 각 항목 `auth`/`source`에 "Registered only when..."로 적었다.

### 5.1 hooks 비교 규칙 (3.0에서 hook command만 Java 런처로 바뀜)

규칙: **비교 대상 = `command`를 제외한 모든 필드.** 3.0 계획(메인 확정)상 이벤트 이름·`type`·`timeout`·`async`·`asyncRewake`·`rewakeMessage`·`rewakeSummary`·`enabled`·`description`·구조(이벤트 -> hooks 배열 순서와 개수)는 그대로이고 호출 명령(`node scripts/portal-files.mjs …`)만 Java 런처로 바뀐다. 판단: 명령줄을 담는 같은 성격의 필드는 함께 제외한다. 즉 `codex.json`의 `commandWindows`, `claude-code.json`에서 `command: "node"`와 짝을 이루는 `args`의 첫 원소(스크립트 경로)가 그렇다. `args`의 나머지(`--host`, `--wait` 플래그)와 antigravity·codex `command` 문자열 안의 플래그(`--host`, `--event`)는 런처가 받는 인자이므로 의미 필드로 보고, 런처가 같은 인자를 받는지는 Java 런처 쪽 시험이 확인한다(이 기준본은 인자 목록만 고정). 플러그인 `plugin.json` 두 개는 변경 없이 전 필드 비교(`hooks` 경로 필드는 hook 파일 위치이므로 유지).

hook에서 `portal-files.mjs`가 받는 하위 명령·인자 (hooks JSON에서 읽음). `portal-files.mjs`에 하위 명령은 없다. 호출은 모두 플래그 인자만 쓴다: `--host <claude-code|codex|antigravity>`, `--wait`(claude-code 전용), `--event <이벤트 이름>`(antigravity 전용).

| 호스트(파일) | 이벤트 | 인자 | timeout | 기타 의미 필드 | 소스 |
| --- | --- | --- | --- | --- | --- |
| claude-code (`hooks/claude-code.json`) | SessionStart (1번째) | `--host claude-code` | 10 | - | claude-code.json:5 |
| claude-code | SessionStart (2번째) | `--host claude-code --wait` | 86400 | `async: true`, `asyncRewake: true`, `rewakeMessage: "[SSH Approval Portal completion notice]"`, `rewakeSummary: "SSH completion notification"` | claude-code.json:6 |
| claude-code | UserPromptSubmit | `--host claude-code` | 10 | - | claude-code.json:9 |
| claude-code | PostToolUse | `--host claude-code` | 10 | - | claude-code.json:12 |
| claude-code | Stop | `--host claude-code --wait` | 86400 | `async: true`, `asyncRewake: true`, 위와 같은 rewakeMessage·rewakeSummary | claude-code.json:15 |
| claude-code | SessionEnd | `--host claude-code` | 10 | - | claude-code.json:18 |
| codex (`hooks/codex.json`) | SessionStart | `--host codex` | 10 | `commandWindows`(PowerShell용 같은 호출, 비교 제외) | codex.json:5-14 |
| codex | UserPromptSubmit | `--host codex` | 10 | 위와 같음 | codex.json:17-26 |
| codex | PostToolUse | `--host codex` | 10 | 위와 같음 | codex.json:29-38 |
| codex | Stop | `--host codex` | 10 | 위와 같음 | codex.json:41-50 |
| antigravity (`hooks/antigravity.json`, 최상위 키 `ssh-completion-inbox`, `enabled: true`) | SessionStart | `--host antigravity --event SessionStart` | 10 | `type: command` | antigravity.json:5-9 |
| antigravity | PreInvocation | `--host antigravity --event PreInvocation` | 10 | 위와 같음 | antigravity.json:12-16 |
| antigravity | PostToolUse | `--host antigravity --event PostToolUse` | 10 | 위와 같음 | antigravity.json:19-23 |
| antigravity | PostInvocation | `--host antigravity --event PostInvocation` | 10 | 위와 같음 | antigravity.json:26-30 |
| antigravity | Stop | `--host antigravity --event Stop` | 10 | 위와 같음 | antigravity.json:33-37 |

- 세 hook 파일 어디에도 `matcher` 필드는 없다(matcher 없음 = 이벤트 전체에 적용). 줄 번호는 LF 기준 복사본 `contract/hooks/*.json`의 줄이다.
- `--wait`는 claude-code의 SessionStart 2번째 항목과 Stop에서만 쓰이고 `async`/`asyncRewake`와 짝이다(대기형). 이 인자의 런처 쪽 동작은 이 기준본이 정하지 않는다.
- 원본 소스의 hook 파일들은 `node`로 `${CLAUDE_PLUGIN_ROOT}`/`${PLUGIN_ROOT}`/`./scripts/portal-files.mjs`를 부르므로, 이 기준본의 복사본은 2.x 원문(참고용)이고 3.0 hook 파일은 `command`만 다르다는 전제로 비교한다.

## 6. error.code 어휘

`mcp/envelope.schema.json`의 `x-portal-errorCodes`.

- 계약의 본체는 정규식 `^[A-Z][A-Z0-9_]{1,95}$` (`public-contract.mjs:73`)이다.
- `confirmedPublicContract`: `public-contract.mjs`가 직접 내는 코드 12개(failure 호출) + `REQUEST_REFUSED` + 메시지->코드 매핑 24행(고유 코드 20개). 이것들은 봉투에 확실히 도달한다.
- `serverLayerCandidates`: `src/**/*.mjs`(adapters/cli 제외)의 따옴표 친 UPPER_SNAKE 리터럴을 grep으로 모은 관측 어휘. 층별(sharedWithHttp, application, domain, adaptersStorage, adaptersSsh, adaptersDesktop)로 나눴고 출처는 첫 발견 file:line이다. 코드마다 실제로 MCP 봉투에 도달하는지는 개별 검증하지 않았다.
- `excludedStrings`: 같은 grep에 걸렸지만 서버 오류 코드가 아니라고 판단해 뺀 문자열과 이유.
- HTTP 전용 응답 문자열(`INVALID_ARTIFACT_ROUTE`, `METHOD_NOT_ALLOWED`, `JSON_REQUIRED`, `HISTORY_UNAVAILABLE` 등)은 `http/admin-routes.json`에 기록했다.

## 7. 확인하지 못한 것 / 한계

1. 실서버 outputSchema·annotations·`_meta`·serverInfo·리소스: 세션 도구 목록에 노출되지 않아 대조하지 못했다. 기준본 값은 소스에서만 옮겼다.
2. ui-* 6개 도구: 실서버에 노출되지 않아 대조하지 못했다. 중첩 객체(`ui-upload-begin.transfer`)가 실서버 JSON Schema에서 `additionalProperties`를 어떻게 내는지 확인하지 못했다.
3. 실서버 판본: 시험 서버의 판본이 HEAD a44c4d1(2.4.2)과 같은지 확인하지 못했다.
4. 관리자 HTTP 응답·요청 본문 중 하위 서비스가 정하는 필드(`responseShape`/`requestShape`에 "미확인" 표기). 특히 history, capacity, desktop, agent-cli, environment, command-policy, maintenance preservation compare/status, `/api/targets`, `/api/outputs`.
5. error.code 후보 각각의 봉투 도달 여부, `operationData.failureCode`(문자열, 스키마 제약 없음)의 전체 어휘(`ssh/transfers.mjs`의 파일 실패 코드와 `domain/execution-failure.mjs`·`dispatch-failure.mjs` 계열), 따옴표 리터럴이 아닌 방식으로 조립되는 코드, 밑줄 없는 한 단어 코드(`MAINTENANCE`만 수집).
6. `src/adapters/cli/**`(포장된 클라이언트)의 코드는 수집하지 않았다.
7. show-*·ui-* 도구의 거절 응답 문구(`results.mjs:105-130`)와 `_meta.sshApproval` 내부(`capabilities.view(job)` 필드)는 옮기지 않았다.
8. `remotePath`/`windowsRemotePath` 문법(`src/domain/validation.mjs`), 승인·정책 평가 로직, 명령 정책 JSON(`src/domain/command-risks.json` 등)은 계약 기준본 범위 밖으로 보고 옮기지 않았다.
9. `scripts/portal-files.mjs`의 내부 동작(hook이 읽는 출력 형식, receipt·ACK, `--wait` 대기 의미, `portal-files upload --file` CLI)은 읽지 않았다. 메인 확정(3.0 계획)에 따라 hook의 `command`만 Java 런처로 바뀌고 나머지 의미 필드는 유지되므로, hook 비교는 5.1절의 규칙(「비교 대상 = command를 제외한 모든 필드」)으로 정리한다. 스크립트 내부 동작은 hook 계약 파일 비교의 대상이 아니라 Java 런처 구현 요구사항이며 이 기준본 범위 밖이다.
12. outputSchema `$schema` = draft-07, 근거 `test/mcp-contracts.test.mjs:244`(2.x 시험 단언), 노출본 대조 불가. 그 시험(`test/mcp-contracts.test.mjs:238-251`)은 `listTools()`가 돌려주는 모든 도구의 `inputSchema`·`outputSchema`를 순회해 `published.$schema === 'http://json-schema.org/draft-07/schema#'`를 단언하고 Ajv(draft-07)와 Ajv2020으로 컴파일한다(`compiled === tools.length * 2`). 시험이 쓰는 `fixture()`(:24-52)는 `desktop` 서비스를 주지 않으므로 대상은 공개 10 + show-* 3 + ui-* 6 = 19개 도구이다. ui-* 6개는 포함된다(같은 시험 파일 :195-196이 `listTools()`에 ui-* 6개가 나옴을 단언함). desktop-* 5개는 이 시험의 순회 대상이 아니다(desktop 미주입). 같은 등록 경로를 쓰므로 draft-07일 것으로 추정하지만 시험으로 확인된 것은 아니다.
13. annotations·`_meta`·serverInfo·리소스는 소스 값 그대로이며 노출본이 없어 대조하지 못했다. 소스에 값이 없는 것: 도구 `title`(소스에 지정 없음 -> 모든 도구 파일에 `title` 없음), MCP `capabilities` 광고 내용(SDK가 만드는 값이라 소스에 없음 -> `server.json`에 옮기지 못함), `tools/list`의 도구 `execution` 등 SDK가 덧붙일 수 있는 필드.
10. 이번 작업 중 scratchpad(`C:\Users\Lenovo\AppData\Local\Temp\claude\...\scratchpad\codes_all.txt`)에 error.code grep 중간 결과를 임시로 썼다(지시의 쓰기 경로 두 곳 밖이지만 세션 임시 폴더). 산출물은 아니며 저장소에는 없다.
11. 영문판 문서: 프로젝트 문서 규칙은 영문판·한글판을 모두 요구하나, 지시된 산출물은 이 한글 문서 하나라서 영문판은 만들지 않았다.

## 8. JUnit 계약 시험이 알아야 할 점

- 입력 스키마(`inputSchema`)는 노출본과 키·값이 같아야 하고 키 순서만 무시한다(draft-07 `$schema` 포함, 확장 키 없음). 입력 쪽 부가 규칙은 최상위 `portalRules`에 있다.
- 서버가 알리는 `serverInfo.version`은 비교하지 않는다(`server.json`에 사유 기록).
- `resourceUri`는 카드 HTML의 SHA-256에 따라 변하므로 패턴(`^ui://ssh-approval/card-[a-f0-9]{64}\.html$`)으로 비교한다.
- 봉투의 `ok`/`data`/`error` 관계(`.refine`)는 outputSchema가 아니라 `portalRules.outputSchema`와 `mcp/envelope.schema.json`(독립 봉투 스키마, SDK 공개본이 아님)으로 검증하고, `error.code` 정규식도 거기서 검증한다.

### 8.1 비교 규칙 (JUnit 계약 시험)

- **inputSchema**: 노출본(실서버·SDK 공개본)과 키·값이 같은지 비교한다. 키 순서만 무시한다. 확장 키는 inputSchema 안에 없다.
- **outputSchema**: 소스에서 유도한 것이고 정확한 wire 형태는 대조할 수 없다(노출본에 없음, ui-*·desktop-* 포함). 따라서 `properties`, `required`, `type`, `enum`, `additionalProperties`의 구조 비교로만 판정한다(`$ref`/`$defs`는 풀어서 비교). 정확한 wire 형태(예: Zod 4가 정수 경계·nullable·union을 내보내는 정확한 모양)는 8단계 E2E에서 확인한다.
- **portalRules**: 비교 대상이 아니다(서버 동작 요구사항 목록이며, 각 항목은 별도 동작 시험으로 확인한다).
