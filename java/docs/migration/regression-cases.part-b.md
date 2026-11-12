# 회귀 사례표 B범위 (regression-cases.part-b)

## 1. 머리말

- 목적: ssh-approval-portal v2.4.2(Node·Python)의 기존 시험 행동을 Java 25·Spring Boot 3.0.0 JUnit 회귀 사례로 옮기기 위한 기준표(B범위)다. 메인이 Java 구현 담당에게 「이 사례를 모두 JUnit으로 고정하라」고 줄 때 쓴다. 빠진 원 시험은 0이어야 한다.
- 기준 저장소: `D:/codex/build/ssh-portal-v300-prep` (브랜치 feature/v300-prep, HEAD a44c4d1 기반). 원자료: `java/docs/migration/test-inventory.raw.md`.
- B범위: (1) mjs 표에서 `test/` 다음 첫 글자가 `m`~`z`인 파일 (2) 파이썬 표 `test/test_*.py` 전체 (3) PowerShell·셸 표 전체. a~l mjs는 다른 담당(part-a)이 한다.
- B범위 원자료 행 수: **1,088** = mjs 611(raw 1222~1832행) + py 335(raw 1840~2174행) + ps1·sh 142(raw 2184~2325행).
- 묶음: 원자료 행 범위별로 11개 묶음(G01~G11)으로 나누어 작성했다. 각 묶음은 아래 4개 절(사례 표·삭제 표·대응표·결함 연결)에 자기 소절을 가진다. 묶음 사이에서 같은 행동이 겹치면 사례가 묶음별로 따로 있을 수 있다(통합 단계에서 대조).
- 사례 ID는 `RC-B-001`부터이며 묶음별 번호 대역을 쓴다(G01 001~090, G02 091~180, G03 181~270, G04 271~360, G05 361~450, G06 451~540, G07 541~630, G08 631~720, G09 721~810, G10 811~900, G11 901~990). 대역 안에서는 연속 번호이고, 대역 끝의 빈 번호는 결번이다.
- 사용 규칙: (a) 사례 하나를 JUnit 시험 하나 이상으로 옮긴다. 「판정 방법」이 assert 대상이다. (b) 「(추정)」 표시는 원 시험 assert에서 직접 확인하지 못한 값이므로 구현 담당이 원 시험을 다시 읽고 확정한다. (c) 「3.0 모듈」은 portal-domain·portal-app·portal-store·portal-ssh·portal-desktop·portal-web·portal-server·portal-client·portal-migrate·packaging 중 하나다. (d) 「삭제」는 3.0에서 없어지는 구성요소의 고유 구현 세부만이며, 행동이 3.0에도 필요하면 삭제하지 않고 사례로 옮겼다. (e) 대응표 셀에 사례 ID가 여러 개이면 그 원 시험 행이 여러 사례에 걸친다는 뜻이다(해당 원 시험의 assert가 둘 이상 행동을 확인). 구현 담당은 나열된 모든 사례에서 이 원 시험을 고정해야 한다.
- 메인 판정(담당 보고에서 모은 미결 사항에 대한 결정. 이 판정을 사례 표·삭제 표·대응표에 반영했다):
  1. 대상 호스트 agent CLI 설치기(`manage-agent-cli.py`, `check-agent-cli-login.py`, Windows `manage-agent-cli-windows.ps1`)는 유지한다. 제품 기능이며 원격 명령 실행은 제품의 일이다. RC-B-631~682와 Windows CLI 사례(RC-B-541~549·618 등)도 유지한다. [3단계 정정] 이 판정은 3단계 Q3(원격 PowerShell·Python helper 폐지, 설치기는 MINA SFTP·고정 명령으로 구현)로 일부 바뀌었다. 결정 D3-16(3단계 설계 11.1절)으로 helper 내부 사례 38건(RC-B-541~549, 553~557, 644~648, 657, 661, 672~682, 902, 904, 905, 914, 916, 917)을 삭제 표로 옮겼고 RC-B-646~648·661은 시범 P3-6 결과가 나올 때까지 「보류」다. 대체 행동은 새 사례 S3-AG-01~10·S3-RW-05가 고정한다.
  2. 관리자 인증 token·Access JWT·OIDC는 유지한다. compose 배포도 유지한다(Caddy·oauth2-proxy 동반 구성 포함). env-editor는 행동을 유지하되 3.0에서는 Java가 처리한다(root broker·Python 없음). 이 유지 여부에 붙였던 「(추정)」 표시는 지웠고, 기대값에 대한 「(추정)」은 그대로 둔다. `connect access`(관리자 Access JWT 설정)는 유지한다. PC 클라이언트가 cloudflared·Access로 인증하는 사례(`portal-client-cloudflared.test.mjs:56`·`:120`, `portal-client-discovery.test.mjs`의 doctor·소유자 세션 9건(:178·:198·:216·:247·:262·:337·:353·:374·:391)과 이미 삭제한 helper 탐색 6건, `portal-client.test.mjs:261`, 사례 RC-B-250·252·258·259·260·262~267·299)는 삭제 표로 옮겼다. 사유는 「사용자 결정 5: 기기 등록 토큰으로 대체, cloudflared 제거」다.
  3. RC-B-022는 그대로 둔다. outputSchema `$schema`도 draft-07로 확정했다(이 시험이 근거다).
  4. web-session 등 브라우저 JS 모듈 시험(RC-B-528~537)은 Playwright for Java로 실제 브라우저 페이지에서 모듈을 불러 실행한다. 「3.0 모듈」 열은 `portal-web(브라우저·Playwright Java)`로 적었다.
  5. RC-B-258~267 판정(원 시험 `portal-client-discovery.test.mjs`를 다시 읽고 행마다 판단): 258(:178 helper·Access 자격 증명 doctor ready)·259(:198 helper 미발견·자격 증명 시간 초과·형식 오류)·260(:216 Access 세션 재인증·`ACCESS_MODE_REQUIRED`)·262(:247 Access 세션 logout unknown)·263(:262 `PORTAL_CLOUDFLARED` 환경과 `cf-access-token` 세션)·264(:337 Access 헤더 `/api/session/start` 쿠키 logout)·265(:353)·266(:374)·267(:391 `Set-Cookie` 검증)은 PC 클라이언트가 Access 쿠키·cloudflared로 인증하는 흐름이므로 삭제했다. RC-B-299(`portal-client.test.mjs:261`)도 같은 이유로 삭제했다. 261(:231)은 targets 응답 검증이라 인증과 무관하므로 유지했다(Access 단계는 빼고 응답 검증만 적음). RC-B-250·252(`portal-client-cloudflared.test.mjs:56`·`:120`)는 Access 자격 증명 입력·형식 검증이라 삭제했다. RC-B-098(관리자 인증 정책)은 유지한다.
  6. `test-mode-file-path-policy.test.mjs:107·209`는 삭제를 철회하고 portal-ssh SFTP 경로 정책 사례로 되살렸다(RC-B-538·RC-B-539). 근거: `:107`(TM-PATH-04)은 줄 108~118에서 TEST 모드 우회가 확인되지 않은 응답(echo 없음·`configured-root`·true·`TEST-SERVER-BYPASS`)을 거절 코드 `{errorCode:'PATH_POLICY_UNSUPPORTED'}`와 호출 순서·재시도 없음·진단 원문 비노출로 확인한다(TEST 모드 예외 결과·거절 코드 assert). `:209`(TM-PATH-10)는 줄 210~224에서 정책 응답의 적용 정책 식별자·`allowedRoot`(`/not-windows`) 불일치를 SFTP 전송 전에 같은 거절 코드로 막음을 확인한다(허용 루트·거절 코드 assert). 이식하지 않는 부분은 helper 전송 형식인 `file-path-policy-v0`·`{ok:true}` 입력뿐이다.
  7. 교차 검증(아래 절 끝의 「교차 검증 결과」): 사례 표의 원 시험 집합과 대응표 사례 행 집합, 대응표 삭제 행 집합과 삭제 표 집합이 같음을 Grep 결과로 확인했다.
  8. `windows-file-helper.tests.ps1` 원자료는 여러 줄 `Assert-True`를 표에 담지 않았다. 담당이 Grep으로 15개(279, 288, 307, 372, 400, 403, 420, 449, 453, 486, 660, 738, 771, 805, 833줄)를 찾아 해당 사례의 판정 방법에 반영했다(행 수에는 포함하지 않음).
  9. 묶음 사이 중복: 유지보수 reserve·release(RC-B-005~010), 명령 정책 review·save, 아티팩트 업로드·다운로드, hook 수신함·ACK(RC-B-319~325와 part-a), 오프라인 보존·재시작 보존, 2.x→3.0 이전 사례(RC-B-136~163, RC-B-335)는 같은 행동을 확인하는 사례가 묶음별로 따로 있을 수 있다. part-a와 병합할 때 대조한다.
  10. 대역 끝의 빈 번호(결번)는 의도된 것이다. 병합 시 번호를 다시 매길 필요가 있으면 메인이 정한다.

## 2. 사례 표

### G01 (원자료 1222~1296: maintenance-client ~ oidc-access, mjs 75행)

| 사례 ID | 대상 기능 | 입력·조건 | 기대 결과 | 판정 방법 | 3.0 모듈 | 원 시험 | 연결 결함 |
|---|---|---|---|---|---|---|---|
| RC-B-001 | 유지보수 클라이언트: 변경 전 durable 능력 확인과 호출 순서·owner 전달 | 관리자 API 대역 서버. owner 토큰 'a'x64를 stdin으로 전달해 reserve 실행(서버는 `/api/maintenance/capabilities`가 404인 구형). 이어 서버를 durable-v1로 바꿔 reserve, capture, compare, release를 차례로 실행 | 구형 서버: reserve 종료 코드 != 0, 호출 경로는 `/api/maintenance/capabilities` 하나뿐(변경 호출 없음). durable 서버: 각 동작 종료 코드 0, 호출 경로 순서 = capabilities, reserve, capabilities, preservation/capture, capabilities, preservation/compare, capabilities, release. 모든 호출의 `X-Maintenance-Owner` 헤더 = 같은 owner. 출력(stdout·stderr)에 owner 문자열이 없음 | 종료 코드, 서버가 기록한 경로 배열 deepEqual, 헤더 전수 일치, 출력에 owner 부재 | packaging, portal-web | test/maintenance-client.test.mjs:11 | - |
| RC-B-002 | 유지보수 클라이언트: compare 결과 FAIL·PARTIAL 처리 | 서버가 compare에 status 'FAIL'로 응답, 다음으로 status 'PARTIAL'(outputsUnavailable 1, commandRequestsChecked 1, outputsChecked 1, outputPayloadsVerified 1)로 응답 | 두 경우 모두 종료 코드 != 0이고 owner가 출력에 없음. 호출 경로 = capabilities, preservation/compare. PARTIAL은 출력이 /complete payload preservation was not verified/ 와 일치. (PASS 응답은 RC-B-001에서 종료 코드 0) | 종료 코드, 경로 배열, 출력 메시지 정규식 | packaging, portal-web | test/maintenance-client.test.mjs:11 | - |
| RC-B-003 | 설치 유지보수 helper: 남아 있는 활성 owner 토큰 복구와 디렉터리 정리 | owners 기준 디렉터리 아래 `job.retained/owner` 파일(내용 'c'x64, 0600)이 남은 상태에서 복구 함수(maintenance_recover_retained 동치)를 실행. 가짜 maintenance 명령은 `status`에 'reserved' 출력, `release`에 종료 0, 그 밖의 동작은 종료 1 | 종료 코드 0. 즉 `status`와 `release`가 각각 저장된 토큰을 stdin으로 받아 호출되고 다른 동작은 호출되지 않음. 복구 뒤 retained 디렉터리 정리(시험 이름 기준; assert는 종료 코드 0만 확인하므로 정리 확인은 (추정)) | 종료 코드 0, 호출 기록에 'status:토큰', 'release:토큰'만 존재(기록 확인은 추정) | packaging | test/maintenance-client.test.mjs:55 | D-0047(후보) |
| RC-B-004 | 유지보수 중 출력 정리: 보호 장치 실패 시 만료 출력 보존 (MAINT-OUTPUT) | (a) 출력 저장소(ttl 50, now 100)에 출력 1건 저장, 정리 허용 판정 함수가 'maintenance unavailable' 예외를 던지게 하고 reap 호출. (b) 같은 저장소를 닫고 유지보수 상태 저장소 파일에 'invalid sqlite'(손상 내용)를 쓴 뒤 now=151(만료 후)에서 애플리케이션 열기 | (a) reap이 'maintenance unavailable' 예외로 실패하고 출력 파일 바이트가 처음과 동일. (b) 애플리케이션 열기가 reject되고 만료된 출력 파일 바이트가 그대로 보존됨(내구 예약 초기화 실패 시 출력 정리 금지) | 예외 메시지, 출력 파일 바이트 deepEqual, 열기 reject | portal-store, portal-app | test/maintenance-durable.test.mjs:21 | D-0019(후보) |
| RC-B-005 | 유지보수 예약의 owner 결속과 baseline 포착(capture) | 관리자 인증·Origin 헤더로 `/api/maintenance/*` POST. 빈 owner reserve, capabilities, reserve, 같은 owner reserve 재호출, 다른 owner('b'x64)의 reserve·release·preservation/capture, 정상 owner capture 2회, 같은 인스턴스에서 compare | 빈 owner reserve 409. capabilities 200. reserve 응답 JSON = `{reserved:true, ownership:'durable-v1'}`. 같은 owner reserve 다시 200. 다른 owner reserve·release·capture 모두 409. 정상 capture 200, 두 번째 capture도 200(응답 유실 복구, baseline 교체 없음). 같은 인스턴스 compare는 409 | HTTP 상태·본문 | portal-web, portal-app | test/maintenance-durable.test.mjs:39 | - |
| RC-B-006 | 재시작 뒤 유지보수 상태 유지와 새 인스턴스 compare | RC-B-005 상태에서 애플리케이션 종료 후 같은 저장소로 다시 열기 | queue.maintenance true, 큐 submit이 /Maintenance/ 예외. 다른 owner release 409, 새 인스턴스 capture 409(고정 baseline 교체 불가). compare 200이고 report.status 'PASS', 보고서 문자열에 owner 없음. status 200이고 본문 status 'reserved' | 상태 코드, report.status, 보고서에 owner 부재, queue.maintenance | portal-store, portal-app, portal-web | test/maintenance-durable.test.mjs:39 | D-0031(후보) |
| RC-B-007 | 검증 release와 재시작 뒤 보존 증거 무효화 | RC-B-006 이후 다시 재시작: `X-Maintenance-Compare-Required:1`로 release(compare 전), compare PASS 뒤 같은 release. 이후 release 재시도, 해제된 owner로 reserve. 다시 재시작해 status·release, 다른 owner reserve, 구 owner release, 새 owner 일반 release | compare 전 검증 release 409이고 queue.maintenance 유지. compare 'PASS' 뒤 release 200, queue.maintenance false, status 'released'. release 재시도 200(응답 유실 재시도). 해제된 owner reserve 409. 재시작 뒤 status 'unknown', release 409. 다른 owner reserve 200 뒤 status 'unknown', 구 owner release 409, maintenance true. 새 owner 일반 release 200이나 status(새 owner·구 owner) 모두 'unknown'(비교 없는 release는 보존 증거 아님) | 상태 코드·status 값 순서, queue.maintenance | portal-store, portal-app, portal-web | test/maintenance-durable.test.mjs:39 | D-0031(후보) |
| RC-B-008 | 활성 owner의 프로세스 간 독점과 비정상 종료 owner 복구 | 첫 프로세스가 유지보수 상태 저장소를 열어 보유한 채 두 번째 프로세스가 reserve('a'x64) 시도. 보유를 닫은 뒤 별도 프로세스가 reserve하고 해제 없이 종료(exit 0). 이후 새 상태 열기 | 보유 중 두 번째 프로세스는 reserve/초기화에 실패(종료 코드 != 0). 보유 해제 후 reserve 프로세스는 종료 코드 0. 복구 상태에서 occupied() true, owns(owner) true, 다른 owner release는 예외, 정상 owner release 성공 | 종료 코드, occupied/owns, 예외 | portal-store | test/maintenance-durable.test.mjs:88 | D-0047(후보) |
| RC-B-009 | 유지보수 예약이 pending·running 작업을 원자적으로 배제 | 큐에 'sudo id' submit(pending) 뒤 reserve, start(running) 뒤 reserve, 완료 뒤 두 owner('a'x64,'b'x64)가 동시에 reserve | pending 중 reserve 409, running 중 reserve 409. 완료 후 동시 reserve 상태 정렬 결과 = [200, 409](정확히 하나만 성공) | HTTP 상태 배열 정렬 비교 | portal-app, portal-web | test/maintenance.test.mjs:8 | - |
| RC-B-010 | 유지보수 중 신규 실행 차단, owner별 release, 미완료 업로드 보존 | reserve 성공 상태에서 `queue.submit('sudo new')`, `submitOperation({kind:'download',remotePath:'/tmp/x',elevate:false})`. 패자 owner release, 승자 owner release. 이후 업로드 스테이징(`store.begin`, size 0, 빈 파일 sha256 e3b0c442…b855) 중 새 owner('c'x64) reserve, 스테이징 제거 후 다시 reserve | 두 submit 모두 예외, queue.maintenance true. 패자 release 409, 승자 release 200. 미완료 업로드가 있으면 reserve 409('completed/expired 전까지 보존'), 제거 후 reserve 200 | 예외, 상태 코드 | portal-app, portal-store, portal-web | test/maintenance.test.mjs:8 | - |
| RC-B-011 | 소유자 완료 관찰: 인증된 GET 재사용과 본문 비노출 | `GET /api/{id}?observe=1&waitMs=25000`을 인증 없이, 이어 관리자 Bearer로. 같은 경로의 쿼리 없는 GET. 잘못된 쿼리 `observe=1&waitMs=60001`, `waitMs=-1`, `waitMs=2&waitMs=3`, `observe=1&extra=1` | 인증 없음 401. 인증 200, 본문 contractVersion '2.0', ok true, data.id = 요청 id, 운영 계층 observe 호출 인자 = `[{id, waitMs:25000}]`. 본문에 'sudo id'·'frozen-job'·관리자 토큰 없음. 쿼리 없는 GET은 구형 JSON(id 필드). 잘못된 쿼리 4종 모두 400이고 observe는 추가 호출되지 않음(총 1회) | 상태 코드, 본문 필드, 호출 기록, 정규식 부재 | portal-web | test/mcp-contracts.test.mjs:54 | - |
| RC-B-012 | 소유자 완료 관찰: 대기 후 인가 재확인 | observe=1&waitMs=1 GET. 인가 함수가 첫 호출만 allowed=true, 이후 {allowed:false,status:401} | 응답 401, 인가 함수 호출 2회(대기 전·후), 본문 error 'OWNER_REAUTH_REQUIRED' | 상태 코드, 호출 횟수, error 코드 | portal-web | test/mcp-contracts.test.mjs:73 | - |
| RC-B-013 | MCP initialize 안내문: 원격 호출과 모델 외부 로컬 파일 전송의 구분 | MCP 클라이언트 연결 후 서버 instructions 조회 | 안내문이 /Contract 2\.0/, 'portal-files client reads and transmits bytes outside the model and returns a UUID', 'One remote MCP connection is sufficient', 'remote server cannot read a path on the caller computer', 'Do not transcribe large file bytes into model tool arguments', 'second local MCP server is optional'를 포함하고 'No local CLI, stdio server, client setup or UI is required'는 포함하지 않음 | 안내문 문자열 포함·미포함 | portal-web | test/mcp-contracts.test.mjs:83 | - |
| RC-B-014 | `files` 도구: UUID 메타데이터 투영과 원 queued 배치 관찰 | 불투명 파일 대역(stat이 내부 경로 'internalPath' 포함 메타 반환). `files{action:'stat',uuid}`, `files{action:'copy',uuid,operationKey,target:'default',expectedTargetRevision,remotePath:'/home/operator/sample.bin'}` | stat·copy 결과가 도구 outputSchema로 검증 통과. stat: data.file.uuid = uuid, data.request null, 응답에 'private/never-disclose'·'internalPath' 없음. copy: data.request.id = 요청 id, copy가 정확히 1회 호출되고 입력 = action을 뺀 나머지, options.signal은 AbortSignal. observe가 `[{id:요청 id}]`로 호출됨 | 스키마 검증, 필드·호출 기록, 정규식 부재 | portal-web | test/mcp-contracts.test.mjs:98 | D-0006(후보) |
| RC-B-015 | `files` 도구: 잘못된 입력 거절 | `{action:'stat',uuid,target:'default'}`, `{action:'copy',uuid,operationKey}`(필수값 누락), `{action:'stat',uuid:'a'x48}`(UUID 아님), uuid 또는 operationKey 끝에 '\n', '\r', '\r\n'을 붙인 입력 | 모두 isError true. copy 호출 총 1회 유지(거절 입력은 전달되지 않음) | isError, 호출 횟수 | portal-web | test/mcp-contracts.test.mjs:98 | - |
| RC-B-016 | `files` move: admission 미확인 상태 보존 | opaque move가 `{state:'admission-unconfirmed'}` 반환, stat은 operations[0].state 'admission-unconfirmed' | 결과 isError 없음, data.request null, data.file.operations[0].state 'admission-unconfirmed', observe 호출 0회(관찰 가능 작업을 만들어내지 않음) | 필드 값, 호출 횟수 | portal-web | test/mcp-contracts.test.mjs:134 | - |
| RC-B-017 | submit: 5 KiB·32 KiB 명령 원문 보존과 이중 언어 경로 문맥 | kind 'command', 명령 길이 5025·32768 바이트('printf '+'x' 반복), context(영문, .env·/etc/shadow·id_ed25519 경로 언급), displayContext(한국어). 별도로 context 'a'x8192, displayContext '가'x8192 | 운영 계층에 전달된 입력이 호출 입력과 정확히 동일(명령 바이트 수 5025·32768 유지). 응답 data.id = 요청 id, 응답에 'id_ed25519'·'shadow'·'printf' 없음. 8192자 문맥 두 개도 isError 없이 동일 보존. 전달 총 3회 | deepEqual, Buffer.byteLength, 응답 정규식 부재 | portal-web, portal-app | test/mcp-contracts.test.mjs:149 | - |
| RC-B-018 | submit: 잘못된 또는 비밀 포함 설명(context·displayContext) 거절 | context와 displayContext 각각에 'password=synthetic-private-marker', 'Bearer synthetic-private-marker', 'PEM 시작줄+marker', 'a'x8193, 'marker\0invalid', false 값 | 모두 isError true, 응답 어디에도 'synthetic-private-marker' 없음. 운영 계층 submit 호출 0회 | isError, 응답 문자열 정규식, 호출 횟수 | portal-web, portal-domain | test/mcp-contracts.test.mjs:165 | - |
| RC-B-019 | submit 실패 원인 비노출과 유지보수 중 MAINTENANCE_ACTIVE 구분 | (a) 운영 계층 submit이 'untrusted-error synthetic-private-marker' 예외. (b) 실제 ApprovalQueue를 maintenance=true로 두고 submit | (a) structuredContent.error.code 'REQUEST_REFUSED', 응답에 marker 없음. (b) isError true, error 정확히 `{code:'MAINTENANCE_ACTIVE', retryable:true, executionAttempted:false}` | error 객체 deepEqual | portal-web, portal-domain | test/mcp-contracts.test.mjs:165 | D-0047 |
| RC-B-020 | 공개 MCP 표면: 모델용 도구·카드 도구·앱 전용 UI 도구 가시성, 결과 envelope | tools/list, resources/list, resource 읽기, `submit{kind:'command',command:'sudo id',operationKey}` | 모델 가시 도구(desktop- 제외) 이름 = targets, submit, observe, cancel, files, artifact-begin, artifact-chunk, artifact-status, artifact-finish, artifact-read, show-ui-probe, show-approval, show-file-transfer(순서 일치). desktop 도구가 있으면 desktop-open, desktop-status, desktop-observe, desktop-input, desktop-close. 비공개 도구 = ui-decide-request, ui-upload-begin, ui-upload-chunk, ui-upload-finish, ui-download-link, ui-read-command-output, 모두 `_meta.ui.visibility ['app']`, resourceUri·`openai/outputTemplate` 없음. widget 렌더 도구는 show 3종뿐(visibility ['model','app'], resourceUri = 유일 리소스 uri). 리소스 1개, mimeType 'text/html;profile=mcp-app', 본문 '<html>fixture</html>'. 구형 도구 get-client-capabilities, get-client-setup, run-command, read-command, run-python-source, request-upload, read-command-output 없음. submit 결과: content[0].text의 JSON = structuredContent, 키 집합 = contractVersion, data, error, ok. contractVersion '2.0', ok true, error null, _meta 없음 | 도구 이름 목록 deepEqual, 메타 필드, 리소스 | portal-web | test/mcp-contracts.test.mjs:188 | D-0008(후보) |
| RC-B-021 | targets: 카드 없는 읽기 전용 탐색, 한도·소유자 권한 노출 (UI 설정 true·false 모두) | UI 활성 false·true 각각 targets 호출과 instructions 조회 | 도구 annotations readOnlyHint true, destructiveHint false. content[0].text JSON = structuredContent. limits.commandBytes 32768, sourceBytes 16384, artifactBytes 64(설정 maxBytes), chunkBytes 262144. approval.agentSelfApproval false, approval.ownerUrl = 관리자 origin. 응답에 MCP 토큰·관리자 토큰·approvalTicket·bootstrapTicket·downloadUrl 없음. submit·append·import 호출 0회. instructions가 /stable operationKey/, /One remote MCP connection is sufficient/, /portal-files client reads and transmits bytes outside the model/ 포함 | 필드 값, 정규식, 호출 횟수 | portal-web | test/mcp-contracts.test.mjs:222 | - |
| RC-B-022 | 공개 MCP 스키마의 draft-07·2020-12 호환 | 모든 도구의 inputSchema·outputSchema를 draft-07 검증기와 2020-12 검증기(`$schema` 치환)로 컴파일 | 모든 스키마 존재, `$schema` = 'http://json-schema.org/draft-07/schema#', 컴파일 예외 없음, 컴파일 개수 = 도구 수 x 2 (두 방언 각각) | 컴파일 성공 횟수 | portal-web | test/mcp-contracts.test.mjs:238 | D-0006(후보) |
| RC-B-023 | submit 입력 엄격 검증(거절)과 정상 kind별 수락 | 거절: command에 autoApprove, command에 remotePath, command 페이로드 없음, source kind에 source 있으나 operationKey만, download에 remotePath 없음, upload 페이로드 없음, operationKey 'short', operationKey 숫자 123, target '../escape'. 수락: source `'print("한글")\r\n'`+cwd '/tmp'+argv ['one'], download remotePath '/tmp/file', download에 context·displayContext 포함, expectedTargetRevision 유무 두 경우 | 거절 9종 모두 isError true이고 운영 계층 submit 0회. 수락: structuredContent.ok true, 전달된 source가 원문(CRLF 포함) 그대로, download 입력(context·displayContext·expectedTargetRevision)이 전달 입력과 동일 | isError, deepEqual | portal-web | test/mcp-contracts.test.mjs:253 | - |
| RC-B-024 | observe: 단일 안정 조회 키, 명시적 출력 읽기, timeout이 취소·재제출을 하지 않음 | 잘못된 입력 `{}`, `{id,operationKey}`, `{id,cursor:4}`, `{id,maxBytes:8}`, `{id,waitMs:60001}`. 이어 observe 대역이 `{job(pending), waitTimedOut:true}` 반환 시 `{operationKey,waitMs:1}`. 그리고 cancel `{id}` | 잘못된 입력 5종 isError true, observe 호출 0회. 정상: data.state 'pending', data.waitTimedOut true, cancel·submit 호출 0회. cancel 결과 data.state 'cancelled', cancel 인자 `[{id}]` | isError, 필드, 호출 기록 | portal-web, portal-app | test/mcp-contracts.test.mjs:268 | D-0033(후보) |
| RC-B-025 | 텍스트 전용 MCP 클라이언트의 UTF-8 출력 페이지 재구성과 digest | 완료 작업 출력 '가\n나'(7바이트, sha256). `observe{id}` 후 `observe{id,includeOutput:true,cursor,maxBytes:4}`를 cursor 0, 이후 nextCursor로 반복 | includeOutput 없는 상태 응답에 출력 문자열 없음, outputPage null. 페이지 1: text '가\n', cursor 0, nextCursor 4, bytes 4, totalBytes 7, eof false. 페이지 2: text '나', cursor 4, nextCursor 7, bytes 3, eof true. 각 페이지 sha256 = 전체 digest, expiresAt 100, bytes = text UTF-8 바이트 수, nextCursor > cursor. 재구성 = 원문, 페이지 2개, 재구성 sha256 = digest, submit 0회 | 페이지 필드, 재구성 비교 | portal-web, portal-app | test/mcp-contracts.test.mjs:278 | D-0036(후보) |
| RC-B-026 | observe의 signalDelivery 투영: 취소 요청이 원격 종료 증거로 바뀌지 않음 | 작업 state 'unknown', execution {phase 'settled', reason 'cancel', remoteState 'unknown', exitCode null, cleanupComplete false, requiresReconciliation true, automaticReplay false}에서 signalDelivery를 'requested', 'unsupported', 'claimed-terminated', undefined로 바꿔 observe. observe 도구 description 조회 | 투영 값 = 'requested'→'requested', 'unsupported'→'unsupported', 'claimed-terminated'→null, undefined→null. 모든 경우 ok true, data.state 'unknown', execution.remoteState 'unknown', cleanupComplete false, requiresReconciliation true, automaticReplay false. description이 /signalDelivery=requested.*not that remote termination was confirmed/ 와 일치 | 필드 값, 정규식 | portal-web, portal-domain | test/mcp-contracts.test.mjs:292 | D-0010(후보) |
| RC-B-027 | submit 명령·source UTF-8 한도: 정확 한도 수락, 초과 거절 | submit 입력 스키마의 command.maxLength 32768, source.maxLength 16384. 명령 정확히 32768 바이트('printf '+'x'x(32768-15)+'END_TAIL') 수락. 거절: 32769바이트(+1), 'printf '+'가'x11000, 'printf \ud800'(홀로 서러게이트) | 스키마 한도값 일치. 정확 한도 명령은 ok true이고 전달 command 동일. 거절 3종 isError true이고 운영 계층 호출은 총 1회 | 스키마 값, isError, 호출 횟수 | portal-web, portal-domain | test/mcp-contracts.test.mjs:310 | - |
| RC-B-028 | 앱 전용 ui-upload-chunk의 canonical base64 검증 | show-file-transfer(direction 'upload', remotePath '/tmp/input.bin')로 bootstrap 티켓, ui-upload-begin(fileName 'input.bin', size 3, sha256 'd'x64)로 업로드 티켓. 청크 data '', 'AB==', 'AA=', 'AA==\n', '_w==', 'AAAA=' 그리고 'AP8B' | 앞 6종 모두 isError true이고 append 0회. 'AP8B': structuredContent = `{sequence:1, received:3}`, 애플리케이션이 받은 바이트 = [0,255,1] | isError, deepEqual, 바이트 | portal-web | test/mcp-contracts.test.mjs:319 | - |
| RC-B-029 | health 콜백 예외의 통제된 503과 서버 지속 | lifecycle.snapshot이 예외 'PRIVATE-AUDIT-FAILURE'를 던지는 동안 `GET /health`, 이후 정상 복구 후 `GET /health`, 이어 show-ui-probe | 예외 중 503 본문 `{error:'Health check unavailable'}`(내부 문구 비노출). 복구 후 200, healthy true. show-ui-probe의 structuredContent.probe = 'SSH_UI_PUBLIC_PROBE' | 상태·본문 | portal-web | test/mcp-contracts.test.mjs:337 | - |
| RC-B-030 | 관리자 approve가 구형 JSON 형식으로 중립 결과를 표시하고 완료를 기다림 | `POST /api/{id}/approve`(관리자 Bearer, 정상 Origin) 및 Origin 'https://evil.test' | 정상: 200, state 'completed', result = `{content:[], structuredContent:{output:{state:'unavailable'}}}`, result에 'texts'·'data' 키 없음. 잘못된 Origin 403 | 상태·본문 deepEqual | portal-web | test/mcp-contracts.test.mjs:349 | - |
| RC-B-031 | 다운로드 준비: 공개 응답에는 파일 이름만, 갱신 URL은 비공개 메타 | 완료된 download 작업(artifactId, fileName 'download.bin', sha256 'f'x64, 결과 texts ['ready']). show-approval 카드, ui-download-link(viewTicket) | 카드 structuredContent.result.content = `[{type:'text',text:'ready'}]`. ui-download-link structuredContent = `{ready:true, fileName:'download.bin'}`. `_meta.sshApproval.downloadUrl`이 /^https:\/\/example\.test\/downloads\// 와 일치. content·structuredContent 직렬화에 'ticket=' 없음 | deepEqual, 정규식 | portal-web | test/mcp-contracts.test.mjs:362 | - |
| RC-B-032 | health·MCP initialize가 실제 제품 버전을 보고 | `GET /health` 및 MCP initialize 응답 serverInfo | health JSON version = 빌드 버전, initialize serverInfo.version = 같은 값(3.0은 Gradle project.version) | 두 값 일치 | portal-web, portal-server | test/mcp-contracts.test.mjs:83, test/mcp-contracts.test.mjs:381 | - |
| RC-B-033 | MCP HTTP 본문 1 MiB 한도(도구 호출·initialize·batch, chunked 포함) | 본문 한도 1048576 바이트. tools/call(targets), initialize, batch 배열을 공백으로 정확히 1048576바이트로 채워 전송. 한도+1 바이트를 chunked와 Content-Length 두 방식으로 전송. 'x'x(한도+1) 인증 있음·없음. 이후 targets 호출 | 정확 한도: tools/call·initialize 200, batch는 400이고 JSON-RPC error.code -32600, error.data = `{error_code:'MCP_BATCH_NOT_SUPPORTED', executionAttempted:false, requestSubmitted:false}`. 한도+1: chunked 여부 무관 413, 본문에 '1048576 bytes' 포함, 본문 길이 < 256. 'x'x(한도+1)은 인증 시 413, 인증 없음 401. 이후 targets 정상. submits·chunks·waits·desktop 호출 0 | 상태 코드, 본문, 호출 기록 | portal-web | test/mcp-input-limits.test.mjs:61 | - |
| RC-B-034 | MCP 집계 한도(647 요소)가 모든 스키마보다 먼저, batch 거절 | tools/list로 도구 이름(targets, submit, observe, artifact-begin, artifact-chunk, artifact-read, desktop-input 포함, 'run-command' 없음). 각 도구에 `{overflow:Array(647)}`; targets에 Array(646); submit에 깊이 648 중첩 context, context.claims 647개, 'constructor' 키 647개, argv 16384개; `{"__proto__": 647개}`. JSON-RPC 요청 submit(argv 647개, id 1)과 targets(id 2). batch: [그 두 요청], [submit(never-dispatch), observe], 101개짜리 targets 배열 | 647개 입력은 모든 도구에서 isError true, 메시지 /maximum of 647 elements/, 응답 길이 < 512. Array(646)은 isError이나 메시지에 'maximum of 647 elements' 없음(스키마 거절). 중첩·claims·constructor·argv 입력은 isError, 메시지 동일. `__proto__` 입력 isError, 응답 길이 < 4096. 단건 submit은 id 1에 result.isError true, targets는 id 2에 정상. 세 batch 모두 400 MCP_BATCH_NOT_SUPPORTED(RC-B-033과 동일 error.data). 거절된 입력은 어떤 호출도 만들지 않음 | isError, 메시지 정규식, 응답 길이, 호출 기록 | portal-web | test/mcp-input-limits.test.mjs:79 | - |
| RC-B-035 | desktop-input 128 동작 수락과 129 거절 | desktop-input 입력(sessionId UUID, epoch 1, frameId, geometryRevision 1, sequence 1, requestKey 'input', actions 128개 pointer{x 0,y 0,buttons 0}) 그리고 actions 129개 | 128개: data.state 'sent', 데스크톱 포트에 입력이 정확히 동일하게 1회 전달. 129개: isError true, 전달 횟수 1 유지 | deepEqual, isError | portal-web, portal-desktop | test/mcp-input-limits.test.mjs:79 | - |
| RC-B-036 | submit 네이티브 JSON: 정확한 command·source 바이트, 인자 16개, 충돌 거절 | command 'x'x32768, context 'Synthetic test context', displayContext '합성 시험입니다.'. command를 'ssh-request-v1:{"command":"id"}' 문자열로. source kind(target 'fixture', source 'x'x16384, argv 16개(각 '번호: literal; $HOME '+'x'x480), cwd '/tmp', elevate false). 거절: command+1바이트, '가'x10923, source+1, '가'x5462, argv 17개, argv 항목 513자, operationKey 'too-short'. 그리고 같은 operationKey·command에 remotePath '/tmp/conflict' 추가 | 정상 3건 모두 전달 입력이 호출 입력과 deepEqual(구형 envelope처럼 보이는 문자열도 단순 명령 데이터). 거절 7종 isError true, 전달 총 3회 유지. 충돌 입력은 structuredContent.error.code 'OPERATION_INPUT_CONFLICT'이고 전달 3회 유지 | deepEqual, isError, error.code | portal-web, portal-app | test/mcp-input-limits.test.mjs:110 | - |
| RC-B-037 | artifact-chunk 전체 청크 한도, 잘못된 인코딩 거절, observe waitMs 한도 | artifact-begin(target 'fixture', 정상 revision, size = CHUNK_BYTES(262144), sha256 'c'x64, remotePath '/tmp/fixture.bin'). artifact-chunk(sequence 0, 0xff x 262144 base64). 잘못된 data '!!!!', 'AB==', 262145바이트 base64. observe `{id,waitMs:60000}`, `{id,waitMs:60001}` | begin.maxChunkBytes 262144. 청크 결과 `{sequence:1, received:262144}`, 전달 바이트 동일. 잘못된 3종 isError true, 전달 청크 1건 유지. observe waitMs 60000: data.waitTimedOut true이고 전달 인자 waitMs 60000·id 일치. 60001: isError true, 전달 1회 유지 | deepEqual, isError | portal-web, portal-app | test/mcp-input-limits.test.mjs:110 | - |
| RC-B-038 | MCP 1.8 상태 매핑, 만료 출력, 명시 출력 읽기와 신뢰 경계 | operationState 열거 값 전부 job(state)로 presentOperation → state 동일. 출력 ref `{state:'ready', expiresAt:1}`인 완료 작업. observe 대역(상태 'starting', 결과에 texts 'PRIVATE_BODY'와 approvalTicket 'PRIVATE_TICKET', outputPage, streamPage 'PRIVATE_RAW_STREAM', event 'timeout')에 `observe{id}`, `observe{id,includeOutput:true}`, `observe{id,operationKey}` | 열거 값 전부 그대로 유지. 만료 시각 지난 ready 출력의 output.state 'expired'. 일반 observe: data.waitTimedOut true, outputPage null, 응답에 'PRIVATE_'·'explicit output' 없음. includeOutput: outputPage.text = 'explicit output', streamPage null, 'PRIVATE_RAW_STREAM' 없음. id+operationKey 동시 지정은 error.code 'OPERATION_LOOKUP_REQUIRED' | 필드 값, 정규식 | portal-web, portal-domain | test/mcp180-bytes.test.mjs:26 | D-0006(후보) |
| RC-B-039 | 파일 진단: 정책 거절과 OS 원시 실패를 구분 | upload 실패 결과 data.errorCode 'PERMISSION_DENIED', allowedRoot 'C:/files', diagnostic ① `{origin:'policy', policyReason:'UNTRUSTED_WRITER'}` ② `{origin:'os', nativeStep:'open', nativeError:32}` | 두 경우 failureCode 'PERMISSION_DENIED', allowedRoot 'C:/files'. ① diagnostic.origin 'policy', policyReason 'UNTRUSTED_WRITER', nativeError null. ② origin 'os', nativeError 32, policyReason null | 필드 값 | portal-domain, portal-web | test/mcp180-bytes.test.mjs:45 | D-0034(후보) |
| RC-B-040 | 감사 저장 실패가 원격 실행 성공과 구분됨 | 완료 작업(result.failed false)에 auditError 'PRIVATE_AUDIT_DETAIL' | state 'completed', failed false, auditFailure true, failureCode null, 직렬화에 'PRIVATE_AUDIT_DETAIL' 없음 | 필드 값, 정규식 | portal-domain, portal-web | test/mcp180-bytes.test.mjs:58 | - |
| RC-B-041 | 유형화된 deadline·transport·cancel·exit 증거 보존, 원시 출력 비노출 | execution reason/remoteState/cleanupComplete 조합 ('deadline','unknown',false), ('transport_lost','unknown',true), ('cancel','exited',true, signal 'TERM'), ('exit','exited',true, exitCode 0, state completed). phase 'settled', timeoutMs 120000, outputState 'partial', stdout {receivedBytes 12, retainedBytes 8, cursor 8, truncated true}, rawOutput 'PRIVATE_EXECUTION_BODY' | 각 경우 execution.reason, remoteState, cleanupComplete 일치, automaticReplay false, exitCode = exit이면 0 아니면 null, signal = cancel이면 'TERM' 아니면 null, stdout.cursor 8. 직렬화에 'PRIVATE_EXECUTION_BODY'·'rawOutput' 없음 | 필드 값, 정규식 | portal-domain, portal-web | test/mcp180-bytes.test.mjs:67 | D-0010(후보) |
| RC-B-042 | 바이너리 업로드 계약: UI·URL·셸 없이 바이트 전달 (default Linux 경로·windows 경로 두 대상) | 대상 ('default','/tmp/bytes.bin'), ('windows','C:/files/bytes.bin'). 원본 = 0..255 바이트 + '가\0\r\n'. artifact-begin(operationKey, expectedTargetRevision, fileName 'bytes.bin', size, sha256, remotePath). 잘못된 청크 'AB==', 'AA==\n', '_w=='. 31바이트씩 artifact-chunk, artifact-finish, artifact-status | begin data.id 일치. 잘못된 청크 3종 error.code 'ARTIFACT_INVALID_CHUNK'이고 append 0회. 순차 청크 후 finish 시 수신 길이 = size, sha256 일치, 요청 제출. status data.request.id = 업로드 요청 id | error.code, append 횟수, finish 시 검증 | portal-web, portal-app | test/mcp180-bytes.test.mjs:83 | D-0007(후보) |
| RC-B-043 | 바이너리 다운로드 계약: artifact-read 페이지로 바이트 재구성 | RC-B-042의 두 대상에서 submit(kind 'download'), artifact-read(id, offsetBytes, maxBytes 7)를 eof까지 반복 | 각 페이지 bytes = base64 디코드 길이, nextOffset = offsetBytes + bytes, sha256 = 원본 sha256, 응답에 'ticket'·'downloadUrl'·'ownerId' 없음, eof 전 페이지는 bytes > 0(전진). 재구성 바이트 = 원본 | deepEqual, 정규식 | portal-web, portal-app | test/mcp180-bytes.test.mjs:83 | D-0007(후보) |
| RC-B-044 | 데스크톱 관찰: 실제 이미지 content 반환, 소유자 신원 비노출 | desktop-open(target 'windows'), desktop-observe(sessionId, epoch 1). 대역 관찰 결과에 PNG(1x1) base64, ownerId 'PRIVATE_OWNER' | structuredContent.data.imageContentIndex 1, content[1] = `{type:'image', mimeType:'image/png', data:png}`. structuredContent에 'PRIVATE_OWNER'·'ownerId' 없음 | deepEqual, 정규식 | portal-web, portal-desktop | test/mcp180-bytes.test.mjs:134 | - |
| RC-B-045 | Jev 평가기: 선택된 고정 모델 버전이 API에 전달, 별칭은 권한 이동 불가 | questionVersion 'ssh-command-risk-v5'. forModel('jev-1.13.0'), forModel('jev-1.14.0')로 assess. forModel('jev-latest'). 응답 model이 요청과 다른('jev-1.13.0' 응답) 평가기 | 요청 본문 model이 각각 'jev-1.13.0','jev-1.14.0'(seen = 두 값 순서대로), selected.questionVersion 유지, 결과 model 일치. 기본 assessor.model 'jev-1.14.0'. forModel('jev-latest') undefined. 응답 model 불일치 시 assess reason 'invalid_response' | 요청 본문, 결과 필드 | portal-web | test/model-selection.test.mjs:8 | - |
| RC-B-046 | Jev 동시 호출 한도가 모델 버전 전환으로 우회되지 않음 | assessor.assess 호출이 응답 대기 중일 때 forModel('jev-1.13.0').assess | 두 번째 결과 reason 'busy'. 첫 호출 완료 후 외부 호출 총 1회 | reason, 호출 횟수 | portal-web | test/model-selection.test.mjs:16 | - |
| RC-B-047 | 모델 카탈로그: 호출 합치기, 일일 갱신, 실패 1시간 유지, 명령 미평가 | catalog.get()을 동시에 2회. 반환 사본의 jev.models를 비운 뒤 재조회. 시계 +86400001 후 listModels 실패('private provider error') 조회·재조회. 이어 +3600001 후 조회 | 동시 호출은 listModels 1회로 합쳐지고 결과 동일. jev.models에 'jev-1.16.0' 포함, 'jev-latest' 제외, jev.defaultModel 'jev-1.14.0', luna.models ['host-luna'], sonnet.configured false. 반환 사본 변형은 캐시에 영향 없음(재조회 시 models 유지, 호출 1회). 하루 경과 후 실패하면 status 'unavailable'이고 재조회해도 호출 2회 유지(실패 1시간 유지). 1시간 경과 후 재시도로 호출 3회 | 호출 횟수, 필드 값 | portal-web, portal-app | test/model-selection.test.mjs:21 | - |
| RC-B-048 | 모델 메타데이터 조회: 고정 계정 endpoint, 별칭·알 수 없는 필드 제외 | listModels 호출(대역 응답 models: ['jev-1.14.0'+secret 필드, 'jev-latest']) | 요청 URL 정확히 'https://api.typesafe.ai/v1/models', redirect 'error' 옵션. 결과 ['jev-1.14.0']. 외부 호출 1회 | URL·옵션, 결과 | portal-web | test/model-selection.test.mjs:31 | - |
| RC-B-049 | 명령 정책 저장: 다른 대상의 review/save에서 변경 없는 규칙의 생존, CAS, 정확한 digest (대상 상태 disabled·stale·removed 세 변형) | 대상 alpha·beta에 규칙 commands ['id'] 저장 후, alpha를 ①enabled:false ②credentialRevision 'v2' ③목록에서 제거로 재기동. 정책 조회로 제안 생성, alpha 규칙 키 순서를 뒤집고 beta commands에 'pwd' 추가해 review. 같은 reviewToken으로 beta에 'ls'까지 추가한 변경본 저장. 원 제안 저장. 오래된 제안으로 review | review 200. 변경본 저장 409. 원 제안 저장 200. 저장 후 alpha 규칙이 저장 전과 deepEqual(키 순서는 권한 변경 아님). 이전 expectedRevision 제안 review 409(전체 정책 CAS) | 상태 코드, 규칙 deepEqual | portal-app, portal-store, portal-web | test/multi-admin.test.mjs:34 | - |
| RC-B-050 | 명령 정책: 잘못된 바인딩 변경 거절, 삭제도 검토된 제안 (세 변형 동일) | RC-B-049 저장 이후 상태에서 ①alpha commands에 'ls' 추가 ②alpha에 automaticSudo=false(부재와 명시 false는 다름) ③beta의 targetRevision을 'f'x64 또는 profile을 'wrong'으로 변경 ④alpha 규칙을 제거한 삭제 제안을 review 후 save | ①②③ review 모두 409. executions 0. ④ 저장 200이고 정책 조회 targets ID = ['beta'] (삭제는 핫 업데이트가 아닌 검토된 제안) | 상태 코드, 대상 ID 목록 | portal-app, portal-web | test/multi-admin.test.mjs:34 | - |
| RC-B-051 | 대상 비활성화는 대상을 중단, 동일 재활성화는 같은 바인딩·정책 복원 | 저장된 정책 조회. alpha enabled:false로 재기동 후 targets.select('alpha'). 원래 구성으로 재기동 | 비활성 중 select('alpha') 예외. 재활성화 후 policy.targets가 이전과 deepEqual, bindings[0].targetRevision 동일, select('alpha').enabled true, 실행 횟수 0 | 예외, deepEqual | portal-app, portal-store | test/multi-admin.test.mjs:63 | - |
| RC-B-052 | 저장 출력이 SSH 재실행 없이 현재 활성·revision을 다시 확인 | alpha 'id' 읽기로 출력 생성(state 'ready'). `GET /api/outputs/{id}?offset=0`. alpha 비활성화 재기동, 재활성화, alpha credentialRevision 'v2' 재기동 각각 같은 GET | ready 상태 200 → 비활성 409 → 재활성 200 → revision 변경 409. 실행 횟수 1 유지(SSH 재실행 없음) | 상태 코드, 실행 횟수 | portal-web, portal-app | test/multi-admin.test.mjs:73 | - |
| RC-B-053 | 요청 소유자가 모호하면 대상을 호출하지 않고 모든 라우팅 거절 | 두 대상 런타임이 같은 요청 ID 'duplicate'를 가짐(대상 큐 함수는 호출 카운터). router.queue의 get, subject, approve, deny, start, wait 호출. 한쪽에서 ID 제거 후 router.jobOwner('duplicate'), jobOwner('missing') | 6개 동작 모두 /Ambiguous request/ 예외, 대상 큐 호출 0회. 제거 후 jobOwner('duplicate').id 'alpha'. jobOwner('missing') /Unknown request/ 예외 | 예외 메시지, 호출 횟수 | portal-app | test/multi-admin.test.mjs:83 | - |
| RC-B-054 | 대상 구성 파싱: 선택적·고정 기본값·불변·개수 | BRIDGE_TARGETS 없는 설정. 기존 단일 프로파일 레지스트리로 resolve. BRIDGE_DEFAULT_TARGET만 지정. 대상 33개. BRIDGE_TARGETS 2개+BRIDGE_DEFAULT_TARGET 'beta'. BRIDGE_TARGETS 1개만 | 설정 targets null. 구형 레지스트리 resolve 예외 없음. 대상 없이 DEFAULT_TARGET 지정은 예외. 33개 파싱 성공(길이 33). 기본 'beta'이고 targets와 항목이 불변(frozen). DEFAULT_TARGET 없으면 defaultTarget undefined | 예외, 길이, 불변성 | portal-server, portal-domain | test/multi-target-config.test.mjs:10 | - |
| RC-B-055 | 대상 구성 잘못된 입력 거절 | 'null', '{}', '[]', '[', 공백 65537자, 중복 ID 2개. 항목 변형: id '../escape', '__proto__', 'https://unregistered.example', displayName에 U+202E 포함, displayName 81자, enabled:'true'(문자열), credentialRevision '', readProfile=writeProfile='aws-local', privateKey 필드. 허용: 서로 다른 대상이 같은 writeProfile 공유. 기본 대상이 enabled:false, 기본 대상이 목록에 없음 | 위 거절 입력 모두 예외. 서로 다른 대상이 같은 writeProfile을 공유하는 구성은 예외 없음. enabled:false 대상을 기본으로 지정 예외, 알 수 없는 기본 대상 예외 | 예외 여부 | portal-server, portal-domain | test/multi-target-config.test.mjs:10 | - |
| RC-B-056 | 대상 별칭의 프로파일 짝, 별도 revision 펜스, 공유 SSH 신원 | 대상 alpha·beta(레지스트리: 호스트 'alpha.example.test' 등, read는 readOnly true, trustedHostKey 'SHA256:alpha' 등). credentialRevision 'v2'로 재계산. alpha-read의 trustedHostKey 제거, readOnly false, host 'wrong.example'. 모든 프로파일이 같은 trustedHostKey 또는 같은 host. 해결 후 alpha-write host 변경 뒤 verify | alpha.revision != beta.revision, identity.targetId 'alpha', target 'fixture@alpha.example.test:22', credentialRevision 변경 시 revision 변경. read 프로파일의 키 제거·readOnly false·host 불일치는 예외. 공유 hostKey·공유 host는 예외 없음. 해결 후 alpha-write host 변경하면 alpha.verify() 예외, beta.verify() 정상 | 예외, revision 비교 | portal-server, portal-domain | test/multi-target-config.test.mjs:28 | - |
| RC-B-057 | 독립된 고정 SSH 서버 2대가 선택된 read/write 프로파일만 수신 (실제 loopback SSH 서버) | 비밀번호 없는 가짜 SSH 서버 alpha·beta(각자 호스트 키 고정), 대상 alpha·beta(read/write 프로파일 4개, 모두 hostKey pin). beta에 read 'id -un'. alpha·beta에 'sudo id -u' 실행 요청 후 두 요청 동시 승인 | read: output.state 'ready', execution.remoteState 'exited', exitCode 0, cleanupComplete true, alpha 수신 0, beta 수신 1. 쓰기 요청 생성 단계는 수신 증가 없음. 동시 승인 뒤 alpha 1·beta 2, 두 요청 state 'completed', execution.reason 'exit', remoteState 'exited', exitCode 0, cleanupComplete true, 두 출력 state 'ready'이고 출력 id가 서로 다름 | 서버 수신 명령 기록, execution 필드 | portal-ssh, portal-app | test/multi-target-ssh.test.mjs:36 | - |
| RC-B-058 | 변경된 기대 호스트 키는 SSH exec 전에 거절 | RC-B-057 상태에서 alpha-read 프로파일의 trustedHostKey를 beta의 것으로 변경 후 alpha 읽기, 레지스트리 getOrCreate('alpha-read'), 이어 beta 읽기 | alpha 읽기 failed true, execution.remoteState 'not_dispatched', cleanupComplete true, alpha 서버 수신 1 유지. getOrCreate reject. beta 읽기는 여전히 output.state 'ready' | execution 필드, 수신 횟수 | portal-ssh | test/multi-target-ssh.test.mjs:36 | - |
| RC-B-059 | MCP 대상 라우팅: 명시·기본 대상, 거절, 고정 신원 | 4개 대상(alpha·beta·gamma, offline은 비활성), 기본 'alpha'. targets, submit target 'unknown','offline','127.0.0.1','__proto__'. beta 'id' 읽기, 기본 대상 'sudo same', beta 'sudo same'. 별도로 기본 대상 미설정 서버에서 target 없는 submit과 beta 읽기 | defaultTarget 'alpha', targets 4개, 응답에 'readProfile'·'SHA256' 없음. 잘못된 target 4종 isError true. beta 읽기는 targetId 'beta'이고 출력 text 'beta-read'. 기본은 targetId 'alpha', 명시는 'beta', targetRevision = targets 목록의 revision. 기본 대상 없음: error.code 'TARGET_UNAVAILABLE', 실행 0회, beta 읽기는 completed | 필드 값, 실행 기록 | portal-app, portal-web | test/multi-target.test.mjs:49 | - |
| RC-B-060 | 소유자 HTTP의 대상 필터링과 교차 대상 승인 거절 | `GET /api/targets` 인증 없이. `GET /api/requests?target=beta`, `?target=unknown`. alpha 요청을 `POST /api/{id}/approve?target=beta` | 인증 없음 401. beta 목록 ID = [read.id, b.id]이고 전부 targetId 'beta'. target=unknown 409. 교차 대상 approve 409이고 실행 기록 수 1 유지(읽기 1회뿐) | 상태 코드, 목록 | portal-web, portal-app | test/multi-target.test.mjs:49 | - |
| RC-B-061 | 승인 티켓의 대상·요청 결속과 1회 사용 | show-approval(a), show-approval(b). b에 a의 approvalTicket으로 ui-decide-request. a 티켓으로 approve를 동시 2회. b를 관리자 HTTP로 승인. observe(b) | card b의 targetDisplayName '이름 beta'. 교차 티켓은 isError true. 동시 2회 중 isError 정확히 1건이고 alpha-write 실행 1회. beta 승인 후 beta-write 실행 1회. observe(b).targetId 'beta' | isError 개수, 실행 횟수 | portal-web, portal-app | test/multi-target.test.mjs:49 | - |
| RC-B-062 | 파일 bootstrap·스테이징 바이트·티켓이 대상에 소유됨 | alpha·beta 각각 show-file-transfer→ui-upload-begin(fileName 'same.bin', size 4, sha256). 교차: beta transfer에 alpha bootstrap 티켓, b.id에 a 업로드 티켓으로 chunk·finish. 정상 업로드 바이트 [0,255,13,10]와 승인 | 교차 3건 isError true, 다른 대상 store.get/remove는 예외. 각 대상 finish 결과 targetId 일치, 업로드 실행기가 읽은 바이트 = [0,255,13,10], 실행 기록 artifactId = [a.id, b.id], 승인 뒤 완료 | isError, 예외, 바이트 deepEqual | portal-web, portal-store | test/multi-target.test.mjs:72 | - |
| RC-B-063 | 아티팩트 정리 뒤 내구 저장소 파일 위생과 전역 전송 예산 | 위 업로드 완료 후 reap, 저장소 루트 목록 조회. 이어 전송 예산 128, 항목 최대 64로 alpha·beta·gamma 순 beginUpload(size 64)와 제거 | reserved 0. 남은 항목은 command-outputs 디렉터리와 maintenance·operations·capacity 저장소(및 관측된 보조 파일)뿐이며 모두 일반 파일, 심볼릭 링크 아님, 링크 수 1, (비 Windows) 모드 & 0o077 == 0 이고 소유 uid = 프로세스 uid. 예약 2건 후 reserved 128, 세 번째(gamma) reject 및 store.size 2. alpha 제거 후 gamma 예약 성공, 전부 제거 시 reserved 0 | 디렉터리 목록, 파일 속성, reserved | portal-store | test/multi-target.test.mjs:72 | - |
| RC-B-064 | 네이티브 업로드 revision 결속: 스테이징·제출 상태·실행이 대상에 소유됨 | artifact-begin(target 'alpha', expectedTargetRevision = beta의 revision), 이후 alpha·beta 각각 정상 revision으로 begin, status, chunk, finish, finish 재호출, status, 관리자 승인 | 잘못된 revision: error.code 'ARTIFACT_STALE_TARGET', reserved 0. 정상: data.targetId·targetRevision 일치, 첫 status 'staging', finish 결과 state 'pending'·targetId 일치, 재호출 finish는 같은 job.id, status state 'submitted'·request.id = job.id, 승인 후 observe 'completed'. 교차 store.get 예외, 실행 artifactId 순서 = 스테이징 순서, reap 후 reserved 0 | error.code, 상태 값, 예외 | portal-web, portal-store, portal-app | test/multi-target.test.mjs:107 | - |
| RC-B-065 | 전역 내구 슬롯: 읽기 대기열화, 대상별 직렬화, 최대 동시 2 | 동시성 2. alpha 읽기·beta 읽기(대기), alpha 읽기 추가·gamma 읽기, gamma download submit, gamma 'sudo id'(owner 승인 모드) start, 유지보수 reserve. alpha 해제 | 처음 2건만 실행(calls 2), 나머지 observe state 'queued'. download submit 'pending', 목록에 있고 start 시 state 'queued'. sudo 요청 start 'queued', approvalMode 'owner'. 최대 동시 active 2(peak 2), downloads 0, gamma-write 실행 0. 실행 중 유지보수 reserve 409. alpha 해제 후 a, a2, g, download 모두 'completed', gamma-write 1회, downloads 1, peak 2 | state 값, peak, 호출 횟수 | portal-app | test/multi-target.test.mjs:129 | D-0004 |
| RC-B-066 | 종료(close)는 진행 중 작업을 드레인 | RC-B-065 상태에서 app.close() 호출 중 beta 읽기·gamma-write가 미완료 | close 중 레지스트리 closeAll 미호출(closed false), queue.maintenance true. beta·write 해제 후 close 완료, closed true, peak 2 유지, active 0, 추가 실행 없음(downloads 1, gamma-write 1회) | closed, maintenance, active | portal-app, portal-server | test/multi-target.test.mjs:129 | - |
| RC-B-067 | 감사 실패와 구성 변경 펜스 | 감사 함수가 action 'approved' & targetId 'alpha'에서 예외. alpha 'sudo id' 요청 start. beta 읽기 출력. beta 'sudo id' 요청 생성 뒤 beta-write 호스트를 'changed.example'로 변경 후 start | alpha: state 'failed', 실행 0회. beta 읽기 출력 state 'ready', outputPage.text 'beta-read'. beta: 호스트 변경 시 state 'failed'이고 실행 총 1회(추가 디스패치 없음) | state, calls 길이 | portal-app, portal-ssh | test/multi-target.test.mjs:129 | - |
| RC-B-068 | 전역 import·quota 예약이 대상 간 실패와 유지보수 경합에서 유지 | 원본 열기를 게이트로 지연. alpha·beta requestUpload 동시, gamma requestUpload. 유지보수 reserve. queue.maintenance=true 후 게이트 해제. 이후 maintenance=false, gamma 요청, deny, reap, reserve, 유지보수 중 submit, release | opened 2에서 gamma reject, reserved 128. 유지보수 reserve 409. 게이트 해제 후 alpha·beta 둘 다 reject, reserved 0, queue.listAll() 비어 있음. gamma 수락 시 job.targetId 'gamma'. deny·reap 뒤 reserved 0, reserve 200, 유지보수 중 submit isError true | 상태, reserved, 목록 | portal-store, portal-app | test/multi-target.test.mjs:155 | - |
| RC-B-069 | 대상 revision 변경은 이전 bootstrap·네이티브 입장을 거절 | revision 'v1' 앱에서 발급한 bootstrap 티켓·targets revision을 credentialRevision 'v2' 앱에 사용: ui-upload-begin, artifact-begin, submit(command, expectedTargetRevision 옛 값) | 세 입력 모두 거절: ui-upload-begin isError true, artifact-begin error.code 'ARTIFACT_STALE_TARGET', submit error.code 'TARGET_REVISION_CONFLICT'이고 실행 0회 | isError, error.code | portal-web, portal-app | test/multi-target.test.mjs:169 | - |
| RC-B-070 | download 읽기가 대상을 넘지 못함 | alpha 요청의 download 결과 artifactId가 beta 소유 아티팩트. `POST /api/{id}/download`, artifact-read(id) | download 409, artifact-read isError true, error.code 'REQUEST_REFUSED' | 상태 코드, error.code | portal-web, portal-store | test/multi-target.test.mjs:169 | - |
| RC-B-071 | 소유 대상의 download: 페이지 읽기, SSH 재실행 없는 재읽기, 1회성 URL | alpha 소유 아티팩트(바이트 [0,255,13,10]). artifact-read(maxBytes 2), 이어 offsetBytes = nextOffset. 첫 페이지 재읽기. `POST /api/{id}/download`로 URL. URL의 아티팩트 ID를 beta 것으로 바꾼 GET, HEAD, GET, 두 번째 GET | 첫 페이지 eof false, 둘째 eof true, totalBytes 4, sha256 일치, 합친 바이트 = 원본. 재읽기 data 동일(SSH 재실행 없음). 교차 ID URL 409, HEAD 200, GET 본문 = 원본 바이트, 같은 URL 두 번째 GET 409(1회성) | 바이트 deepEqual, 상태 코드 | portal-web, portal-store | test/multi-target.test.mjs:169 | - |
| RC-B-072 | 여러 줄 명령 입력 수용: LF·CRLF·heredoc 탭, classifier 입력 불변 (ML-INPUT) | Linux 4종(quoted heredoc, unquoted heredoc, `<<-` 탭 제거, 파이프 heredoc), Windows 3종(here-string, 큰따옴표 here-string CRLF, 탭+CRLF), 'printf\tfixture', 'printf first\r\nprintf second\r\n'. validateCommand, validateWindowsCommand, `ssh-request-v1:`+JSON 요청 | 모두 예외 없음. classifier가 받은 값 = 원문 그대로. 요청 파싱 결과 command = 원문, sha256 동일 | 예외 여부, 값 동일 | portal-domain | test/multiline-commands.test.mjs:44 | D-0005 |
| RC-B-073 | 여러 줄 명령의 신원: 개행·탭·앞뒤 공백이 다른 digest 주체 (ML-IDENTITY) | 5종 'printf first\nprintf second\n', CRLF 변형, 앞 공백, 마지막 개행 없음, 탭 변형. commandDigest(command, 'a'x64, 'synthetic', context). Windows prepareWindowsCommand | digest 5개 모두 서로 다름. digest = sha256(JSON `{command, targetRevision, profile, context}` 필드 순서 그대로). prepareWindowsCommand(command).stdin = 원문 | digest 비교, stdin 동일 | portal-domain | test/multiline-commands.test.mjs:56 | D-0005 |
| RC-B-074 | 여러 줄 명령 32 KiB 경계와 금지 제어 문자 (ML-BOUND) | atom 'x','가','😀'로 `cat <<'EOF'\n\t...\nEOF\n` 정확히 32768 바이트. +1 바이트. 제어 문자 '\0','\r','\x01','\x08','\x0b','\x0c','\x1b','\x1f','\x7f','\x85','\u202e','\u2066', 서러게이트 '\ud800','\udc00'를 'printf first\n'와 'printf second' 사이에. 빈 명령 '', ' \n\t\r\n'. 원격 경로에 '\n','\r','\t' | 32768바이트 수락(두 검증기). +1 바이트 거절이며 classifier 호출 0. 제어 문자 14종은 거절, classifier 호출 0. 빈·공백 명령 거절. 경로 /tmp/first+제어+second 와 Windows 경로는 거절 | 예외, classifier 호출 수 | portal-domain | test/multiline-commands.test.mjs:69 | D-0005 |
| RC-B-075 | 여러 줄 구문은 부분 이름 승인·읽기 승인을 만들지 못함 (ML-NAMES, ML-READ) | commandLineNames/explicitUserApproval: Linux 4종+'ls\nid','ls\r\nid','ls\n','\nls','ls\nrm synthetic'; Windows 3종+'whoami.exe\nwhoami.exe','Microsoft.PowerShell.Utility\\Get-Date\n','\r\nMicrosoft.PowerShell.Management\\Get-Location'. classifyForTarget(windows, read-only 대역). 읽기 도구: Linux 'ls\nid', Windows 'Microsoft.PowerShell.Utility\\Get-Date\n'를 자동화 비활성 앱에서 read, run | 이름 해석 complete false, explicit false. Windows 분류는 class != 'read-only'. read는 code 'READ_COMMAND_REQUIRES_APPROVAL'로 reject, run은 state 'pending', command 원문, 실행 0회 | complete·explicit 값, 에러 코드 | portal-domain, portal-app | test/multiline-commands.test.mjs:99, test/multiline-commands.test.mjs:182 | D-0005 |
| RC-B-076 | 여러 줄 명령의 승인 경로: 전체 검토 필요, owner·모델·TEST 경로 보존 (ML-AUTH, Linux·Windows 두 플랫폼) | 대상 platform linux/windows. 명령 Linux = `cat <<-'EOF'\n\t한글\n\tEOF\n`, Windows = here-string+개행+`Microsoft.PowerShell.Utility\Write-Output 'synthetic tail'`. 정책: 자동 sudo, 외부 공개 true, 모델 실행 false. 같은 requestKey 두 번, CRLF로 바꾼 같은 키. owner 승인. 정책 modelExecution true+임계값(jev). deniedCommands(Linux 'cat', Windows 'Microsoft.PowerShell.Utility\Write-Output'). testServer true | pending: state 'pending', command=operation.command=원문, decision.reasonCode 'observation_only', 평가 입력 1회(command 원문, userApproval.explicit false), 실행 0. 같은 키 → 같은 id, CRLF 변형은 /conflict/i 로 reject. 승인 시 completed, 실행 1회, profile = writeProfile, Windows는 stdin·Linux는 command가 원문, 감사 'approved' 이벤트의 command = 원문. 모델 경로: state 'completed', reasonCode 'model_passed', 평가 입력 1. 거부: state 'denied', reasonCode 'policy_denied', 평가 0, 실행 2 유지. testServer: state 'completed', reasonCode 'test_server_bypass', 평가 0, 실행 3, 모든 실행의 입력 = 원문 | state, reasonCode, 실행 기록 | portal-domain, portal-app | test/multiline-commands.test.mjs:149 | D-0005 |
| RC-B-077 | 실제 Linux 셸에서 heredoc 실행 (ML-SH, Linux 전용) | 명령 4종을 /bin/sh -c로 실행(제한 2초, 버퍼 32768) | stdout = '한글 $HOME `literal`\n', 'expanded\n', '한글\n', 'HELLO\ndone'(순서대로), stderr 빈 문자열. 사전에 validateCommand 통과 | 프로세스 stdout·stderr | portal-domain | test/multiline-commands.test.mjs:191 | D-0005 |
| RC-B-078 | 네이티브 릴리스 설치: 모드 정리 뒤 고정 런타임 준비, 재사용 릴리스에도 준비 | 설치 스크립트(3.0 install.sh/install.cmd). 신규 스테이지: 파일 권한 일괄 정리(chmod 0640) → xfreerdp3 런타임 준비 → 스테이지를 release로 게시. 기존 릴리스 재사용 경로 | 준비 함수 존재. 순서: 권한 정리 < 런타임 준비 < 게시. 기존 릴리스 경로에서도 준비 함수가 release 대상으로 호출됨. (xfreerdp3는 Java로 대체 불가한 외부 프로그램이므로 준비 단계가 유지됨) | 설치 단계 순서 검사 | packaging | test/native-install-paths.test.mjs:15 | D-0014(후보) |
| RC-B-079 | Docker 이미지: 런타임 ABI 패키지 제공과 이미지 구성 | docker/Dockerfile(3.0 이미지 정의): 런타임 단계 패키지 libx11-6 libxext6 libxinerama1 libxcursor1 libxi6 libxrender1 libxrandr2 libxfixes3 libxkbfile1 libssl3t64 libicu74, amd64 아키텍처 검사, 빌드 결과 복사 | 런타임 단계가 위 11개 패키지명을 모두 포함, `dpkg --print-architecture` = amd64 검사, `COPY --from=build /app /opt/portal` 구성(3.0 경로는 동치). 빌드 단계의 node verify.mjs, python3 prepare-freerdp-input.py, check-package-imports.mjs 호출 순서는 Node·Python 고유라 이식하지 않음(원 시험 일부) | 이미지 정의 문자열 검사 | packaging | test/native-install-paths.test.mjs:24 | - |
| RC-B-080 | 실제 런타임 준비: 실행 모드 보존, 의존성 해결 시 apt 미사용, 재사용 | (Linux) 릴리스 임시 디렉터리에 vendored freerdp-input 아카이브와 release-manifest(size·sha256), 'all dependencies resolved'를 출력하는 ldd 대역과 apt-get 기록 대역. 준비 1회, 그리고 연속 2회 | 종료 0, `native/freerdp-input/runtime/bin/xfreerdp3` 모드 0755, apt-get 호출 기록 없음(빈 문자열), stdout JSON status 'prepared'. 2회 연속이면 status 목록 = ['prepared','reused']이고 모드 0755 유지 | 종료 코드, 모드, apt 기록, status | packaging | test/native-install-paths.test.mjs:58, test/native-install-paths.test.mjs:73 | D-0014(후보) |
| RC-B-081 | 선택적 GUI 패키지 설치: 실패 무시, Ubuntu 22.04 건너뜀, 24.04 고정 패키지만 | (Linux) ldd 대역이 'libX11.so.6 => not found' 출력. ①24.04, apt-get 종료 42. ②22.04 ③24.04 apt-get 정상 | ① 종료 0, apt 기록 'update'뿐, stderr가 /bridge installation continues/ 와 일치. ② 종료 0, apt 호출 없음(비호환 GUI 라이브러리 미설치). ③ 종료 0, apt 기록에 11개 패키지 모두 포함, 'freerdp3-x11'·'tigervnc' 미포함 | 종료 코드, apt 기록, stderr | packaging | test/native-install-paths.test.mjs:66, test/native-install-paths.test.mjs:79, test/native-install-paths.test.mjs:85 | - |
| RC-B-082 | 오프라인 보존 baseline: 기존 DB 불변, 첫 후보 기동 검증 | 완료 명령 요청 1건(id '1'x48)과 출력 1건('private result')이 있는 저장소. prepareOfflinePreservationBaseline(commandEnabled true, cliEnabled false) 후 애플리케이션 열기, preservation/compare, release | 준비 결과 `{status:'PREPARED', commandEnabled:true, cliEnabled:false}`. 준비 전후 command-automation DB와 command-outputs manifest의 sha256 동일. compare 200, report.status 'PASS', commandRequestsChecked 1, outputPayloadsVerified 1, 보고서에 'private result' 없음. release 200 | 해시 비교, report 필드 | portal-migrate, portal-store, portal-app | test/offline-preservation.test.mjs:19 | D-0031(후보) |
| RC-B-083 | 오프라인 baseline이 휴면(commandEnabled false) 명령 journal도 포함 | 완료 명령 요청 1건이 있고 commandEnabled false, cliEnabled false로 baseline 준비 후 열기, compare | compare 200, commandRequestsChecked 1 | 상태 코드, 필드 | portal-migrate, portal-store | test/offline-preservation.test.mjs:46 | D-0031(후보) |
| RC-B-084 | 오프라인 준비 거절: 사용 중 DB 소유자, 중단된 요청, 이후 데이터 변경 탐지 | (a) command 상태·출력 저장소를 열어 둔 채 준비. (b) state 'pending' 요청이 있는 저장소에서 준비 → 그 요청 state를 completed로 바꾼 뒤 준비 → 요청 digest를 '5'x64로 변경 → 애플리케이션 열기·compare | (a) 예외이고 유지보수 상태 파일(maintenance.sqlite 동치)이 생기지 않음. (b) 예외 메시지 /Nonterminal/, 예약 파일 없음. completed 후 준비 성공. digest 변경 후 compare는 200이 아님(실패)이고 응답 본문에 요청 id 없음 | 예외, 파일 부재, 상태 코드, 본문 | portal-migrate, portal-store, portal-app | test/offline-preservation.test.mjs:37, test/offline-preservation.test.mjs:59 | D-0031(후보) |
| RC-B-085 | OIDC 구성: HTTPS issuer·독립 JWKS·client·정확한 owner 고정 | env: mode oidc, issuer·JWKS URL https, client 'portal-client', owner 'Owner@example.test'. issuer·JWKS 각각 '', 'http://…', 'https://owner@…', '?key=1', '#x', 대문자 호스트, '/a/../b', 끝 개행. owner '', 'wild*@example.test', 'owner@example.test,', '@example.test', 'x\n@example.test'. client '', 개행 포함, 513자 | 정상 구성 mode 'oidc'. 비정상 입력 전부 예외 | 예외 여부 | portal-web | test/oidc-access.test.mjs:12 | - |
| RC-B-086 | OIDC 토큰 검증: 서명·issuer·audience/azp·인간 owner·시간 클레임 | RS256 토큰. 정상, aud ['portal-client','other']+azp 'portal-client'. 거절: iss 다름, aud 'other', aud 복수(azp 없음), azp 'other', exp 1, iat +600초, nbf +600초, sub '', email 다른 owner, email_verified false, email_verified 'true'(문자열), email null. 다른 키 서명, payload 교체, 'malformed', 16385자. 헤더: 관리자 토큰 Bearer, cf-access-jwt-assertion, x-auth-request-email, authorization 배열, Basic | 정상 2건 true. 거절 항목 전부 false(authenticated). 관리자 토큰·프록시 헤더 대체·배열·Basic 스킴 모두 false | authenticated 결과 | portal-web | test/oidc-access.test.mjs:19 | - |
| RC-B-087 | OIDC 필수 클레임과 알고리즘 대체 거절, ES256 지원 | RS256 서명 토큰에서 exp, iat, sub, email, email_verified 하나씩 제거. HS256(32바이트 0 키) 서명. 별도로 ES256 키 쌍의 key set과 ES256 서명 토큰 | 필수 클레임 5종 제거 각각 false. HS256 대체 false. ES256 토큰은 구성된 key set으로 검증되어 true | authenticated 결과 | portal-web | test/oidc-access.test.mjs:30, test/oidc-access.test.mjs:44 | - |
| RC-B-088 | OIDC 경로 보호: 관리자 Bearer fallback 거절, 정적·다운로드 경로 보호, 세션 쿠키 | authorizeAdminRequest: '/', '/api/session', '/api/requests', '/downloads/{48자}/{32자}'를 관리자 Bearer로. 유효 OIDC Bearer로 '/api/requests'. 브라우저 세션 시작 후 쿠키로 같은 경로 | 관리자 Bearer: 4개 경로 모두 allowed false. OIDC Bearer 단독도 allowed false. 브라우저 세션 쿠키를 발급받은 요청은 allowed true | allowed 값 | portal-web | test/oidc-access.test.mjs:37 | - |

### G02 (원자료 1297~1370: opaque-artifacts ~ operation-migration-retained-budget, mjs 74행)

| 사례 ID | 대상 기능 | 입력·조건 | 기대 결과 | 판정 방법 | 3.0 모듈 | 원 시험 | 연결 결함 |
|---|---|---|---|---|---|---|---|
| RC-B-091 | staged 파일 UUID 할당(소유자 결속·operationKey 멱등) | store.beginStaged(ownerId='verified-owner', operationKey='opaque-upload-key-0001', fileName='한글😀.bin', size=4, sha256=hash([0,255,13,10])). 동일 입력 재호출, fileName만 다른 호출, 다른 ownerId 호출, 반환 객체 변조 | publicUUID는 `^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`(UUIDv4). remotePath·targetId는 undefined(대상·경로 없음). 같은 키·같은 입력은 같은 publicUUID. fileName만 다르면 `/conflicts/` 오류(OPERATION_KEY_CONFLICT 계열). 다른 소유자로 staged(uuid,'other-owner') 조회는 `/unavailable/` 오류. 다른 소유자의 같은 키는 다른 UUID. get() 반환 actions 배열을 변조해도 저장본의 actions는 `[]` | publicUUID 형식 정규식, undefined 필드, 동일 UUID 재사용, 충돌·타 소유자 예외, 방어적 복사(actions deepEqual []) | portal-store | test/opaque-artifacts.test.mjs:19 | - |
| RC-B-092 | staged 식별자·해시의 CR/LF 접미사 거부(저장소 경계) | operationKey='valid-operation-key'+suffix, sha256=hash+suffix, suffix는 `\r`, `\n`, `\r\n` 각각. 정상 등록 후 staged(publicUUID+suffix,'verified-owner') | operationKey는 code `INVALID_OPERATION_KEY`, sha256은 `INVALID_FILE_HASH`로 거절(trim·정규화 없음), 거절 뒤 저장소 size 0. UUID+접미사 조회는 code `ARTIFACT_NOT_FOUND`, 정상 UUID 조회는 같은 id 반환 | 접미사 3종 × 오류 code, store.size 0, 정상 조회 id 일치 | portal-store | test/opaque-artifacts.test.mjs:33 | - |
| RC-B-093 | raw 이진 청크 재시작 복구·변조 재시도 거부·멱등 완료 | 크기 CHUNK_BYTES+3(0x97 채움, 끝 3바이트 `0,0xff,0x0a`) 파일. 첫 청크 append(id,0,first) 뒤 `.part` 끝에 'unacknowledged crash tail' 추가하고 저장소 재오픈. 이후 같은 청크 재전송·다른 내용 같은 순번·CHUNK_BYTES+1 크기 청크·꼬리 청크 | 첫 append 응답 `{sequence:1,received:CHUNK_BYTES}`. 재오픈 뒤 `.part` 크기는 CHUNK_BYTES(확인되지 않은 꼬리 절삭). 같은 청크 재전송은 같은 응답, 다른 내용은 `/mismatch/`, 크기 초과는 `/Invalid chunk/`. 꼬리 append 뒤 finish는 pinned=false·state='ready'. 완료 뒤 첫 청크 재전송은 `{sequence:2,received:bytes.length}`. 재오픈 뒤 finish도 같은 publicUUID, `.part` 내용은 원본 바이트와 동일 | 응답 deepEqual, `.part` 크기·내용 바이트 비교, 예외 메시지 패턴, finish 멱등 | portal-store | test/opaque-artifacts.test.mjs:45 | - |
| RC-B-094 | 빈 파일·최종 해시 불일치·staged TTL·쿼터 | maxBytes=4, budget=4, now 주입. size 4 파일 begin 뒤 다른 키로 size 1 begin. 4바이트 append·finish 뒤 now=expiresAt에서 finish. reap. 빈 파일(Buffer.alloc(0)) begin·finish. sha256=hash('no')인 'bad' 파일 append 뒤 finish | 두 번째 begin은 code `ARTIFACT_QUOTA`. 만료 시 finish는 `/expired/`, reap 뒤 reserved 0. 빈 파일 finish 뒤 reserved 1. 해시 불일치 finish는 `/hash mismatch/`, 이후 store.has(bad.id)=false | code·메시지 패턴, reserved 값(0, 1), has=false | portal-store | test/opaque-artifacts.test.mjs:66 | D-0012(후보) |
| RC-B-095 | 소비(consume) tombstone의 재시작 안전성·중복 제거 단일 과금 | ready 파일의 manifest를 state='consuming', consumeReason='moved'로 고쳐 쓰고 재오픈. 이후 consumeStaged(uuid,owner,'moved') 재호출·재오픈 조회. 새 파일은 같은 consumeStaged(...,'removed')를 Promise.all로 2회 동시 호출 | 재오픈 뒤 staged()는 state='consumed', consumeReason='moved', 원래 size·sha256 유지, reserved 1, `.part`는 ENOENT. 재호출·재오픈 뒤에도 state='consumed'. 동시 중복 제거 뒤 reserved 2(tombstone은 한 번만 과금) | state·consumeReason·size·sha256, reserved 값(1, 2), `.part` ENOENT | portal-store | test/opaque-artifacts.test.mjs:83 | - |
| RC-B-096 | HTTP 파일 업로드 create/raw chunks/complete의 공개 필드 | POST /api/artifacts(operationKey='http-opaque-upload-001', fileName='한글😀.bin', size=6, sha256) 후 PUT /api/artifacts/{uuid}/chunks/0(content-type application/octet-stream, x-chunk-sha256, 본문 2조각), complete, GET, 내용을 바꾼 청크 재전송 | create는 status 200, value 키는 `['uuid']`만. 같은 요청 재호출은 같은 `{uuid}`. 청크는 `{uuid,sequence:1,received:6}`(반복 호출·완료 뒤 호출도 동일), complete는 `{uuid}`(멱등). GET은 state='ready', received=6, sequence=1, 키 집합 정확히 `uuid,state,fileName,size,sha256,expiresAt,received,sequence`. 다른 내용 청크는 `{routed:true,status:409,value:{error:'ARTIFACT_CHUNK_CONFLICT'}}` | status·value deepEqual, 키 집합, 409 오류 코드 | portal-web | test/opaque-file-api.test.mjs:31 | - |
| RC-B-097 | 파일 API 경로의 검증된 주체 요구·본문 I/O 뒤 재인가 | 권한 없음(null)·`{allowed:true}`(주체 없음)·`{allowed:false,status:401}`·subject '' 인 `allowed:true`로 POST /api/artifacts. 본문 읽은 뒤 reauthorize가 `{allowed:false,status:401}`·`{allowed:true}`·다른 subject를 반환하는 경우. 무관한 경로 '/unrelated' | 모든 경우 status 401 또는 403이고 저장소 size 0(할당 없음). '/unrelated'는 routed=false | status ∈ {401,403}, store.size 0, routed=false | portal-web | test/opaque-file-api.test.mjs:53 | - |
| RC-B-098 | 파일 API 정책: 모든 지원 method에 검증된 소유자와 정확한 Origin 요구 | 경로 POST /api/artifacts, GET /api/artifacts/{uuid}, POST .../complete, PUT .../chunks/0 각각 × 모드 token/access/oidc. 정상 Bearer+Origin, 다른 Origin, Origin 없음, 인증 정보 없음(token 모드는 authorization 제거, 그 외는 identity가 null 반환) | 정상 요청은 allowed=true, principal.subject는 token 모드에서 'portal-token-owner', access/oidc에서는 identity의 subject. 다른 Origin·Origin 없음은 allowed=false. 인증 정보 없음은 allowed=false, status 401. (관리자 인증 token·Access JWT·OIDC 세 모드는 3.0에서도 유지: 메인 판정 2) | allowed·principal.subject·status 단언, 모드×route 순회 | portal-web | test/opaque-files-application.test.mjs:81 | - |
| RC-B-099 | 스테이징 필드 엄격 검증(대상·경로·소유자 입력 금지) | POST /api/artifacts에 추가 필드 `remotePath:'/tmp/forbidden'`, `target:'alpha'`, `ownerId:'client'`, `publicUUID:'client'`, `overwrite:true` 각각. complete 본문에 `{remotePath:'/tmp/no'}`, GET에 `?path=bad`, GET /api/artifacts/not-a-uuid | 모두 status 400, 거절된 생성 시도 뒤 store.size 0 | 5개 추가 필드·complete 본문·쿼리·UUID 형식 각각 status 400, store.size 0 | portal-web | test/opaque-file-api.test.mjs:67 | - |
| RC-B-100 | 이진 요청 한계·청크 다이제스트·method/content 승인(진행 불변) | PUT chunks/0: 본문 CHUNK_BYTES+1바이트, 빈 본문, content-encoding gzip, POST method, 경로 chunks/01, chunks/9007199254740992, x-chunk-sha256=hash('wrong'). POST /api/artifacts에 본문 `[0xff]` | 413, 400, 415, 405, 400, 400 순. 잘못된 청크 해시는 `{routed:true,status:422,value:{error:'CHUNK_HASH_MISMATCH'}}`이고 stat().received는 0. 잘못된 UTF-8 JSON 본문은 400 | 각 status 단언, 422 값 deepEqual, received 0 | portal-web | test/opaque-file-api.test.mjs:79 | - |
| RC-B-101 | 공개 API 오류 구분: 쿼터·없는 UUID·전체 해시 불일치·서비스 없음 | maxBytes=4,budget=4에서 4바이트 업로드 후 다른 키로 size 1 요청. 없는 UUID·다른 소유자 UUID GET. 청크 sha256은 맞지만 전체 sha256이 다른 파일 complete. 서비스 undefined로 GET, permission null | 쿼터: `{routed:true,status:507,value:{error:'ARTIFACT_QUOTA'}}`, store.size 1·reserved 4 유지. 없는 UUID·타 소유자 UUID는 둘 다 `{status:404,value:{error:'ARTIFACT_NOT_FOUND'}}`(구분 불가). 전체 해시 불일치 complete는 `{status:422,value:{error:'ARTIFACT_HASH_MISMATCH'}}`(CHUNK_HASH_MISMATCH와 다른 코드). 서비스 없음은 `{status:503,value:{error:'OPAQUE_FILES_UNAVAILABLE'}}`, 서비스 없고 권한 null이면 인가가 먼저라 403 | 4개 하위 시나리오별 status·error 코드 deepEqual, 쿼터 뒤 store.size·reserved | portal-web | test/opaque-file-api.test.mjs:95 | D-0012(후보) |
| RC-B-102 | 파일 API 저장소 오류의 안전한 분류(권한·공간·I/O) | store.beginStaged가 동기 throw 또는 Promise.reject로 내는 오류: code EACCES/EPERM, ENOSPC/EDQUOT, EIO(메시지·path·provenance에 개인 경로 `/srv/private/data.part` 포함) | EACCES·EPERM은 403 `ARTIFACT_PERMISSION_DENIED`, ENOSPC·EDQUOT는 507 `ARTIFACT_STORAGE_FULL`, EIO는 500 `ARTIFACT_STORAGE_IO_ERROR`. 동기/비동기 모두 `{routed:true,status,value:{error:code}}`이며 값에 경로·소유자 정보 없음. (3.0은 errno 대신 Java IOException 하위 유형·SQLState 등으로 같은 3분류를 구현) | 3분류 × 동기/비동기, status·error deepEqual(유출 문자열 부재) | portal-web | test/opaque-file-api.test.mjs:95 | D-0034(후보) |
| RC-B-103 | 공개 오류 경계: 허용 목록 typed code와 정확한 레거시 문구만 노출 | service.stat이 던지는 오류 6종: code ARTIFACT_QUOTA(메시지에 개인 경로), 메시지 정확히 'Staged file unavailable', 같은 문구에 경로가 붙은 메시지, code ENOENT+path+provenance, 메시지 'An unrelated service denied its operation'+code EACCES, 임의 code 'ARBITRARY_PRIVATE_ERROR' | 순서대로 507 `ARTIFACT_QUOTA`, 404 `ARTIFACT_NOT_FOUND`, 500 `ARTIFACT_INTERNAL_ERROR`, 500 `ARTIFACT_INTERNAL_ERROR`, 500 `ARTIFACT_INTERNAL_ERROR`, 500 `ARTIFACT_INTERNAL_ERROR` (개인 경로·스택·자격 증명 문자열 비노출) | 6개 시나리오 status·error deepEqual | portal-web | test/opaque-file-api.test.mjs:137 | - |
| RC-B-104 | HTTP 식별자·해시 필드의 CR/LF 접미사 거부(공개 API 경계) | POST /api/artifacts의 operationKey+suffix, sha256+suffix(suffix `\r`,`\n`,`\r\n`). 정상 UUID에 대해 GET 경로 UUID+suffix(URL 인코딩), PUT chunks/0의 x-chunk-sha256 헤더+suffix | operationKey 접미사는 `{status:400,value:{error:'INVALID_OPERATION_KEY'}}`, sha256 접미사는 `{status:400,value:{error:'INVALID_FILE_HASH'}}`, 거절 뒤 store.size 0. UUID 접미사 GET·헤더 접미사 PUT는 400, 이후 stat().received는 0 | 접미사 3종 × 400과 error 코드, store.size 0, received 0 | portal-web | test/opaque-file-api.test.mjs:152 | - |
| RC-B-105 | 조립된 소유자 HTTP 스테이징과 MCP copy/move의 내구 승인·정확한 바이트 공유 | 394240바이트(0xa7) 파일을 262144 단위 청크 2개로 업로드 후 complete. 이어서 MCP files 도구 action copy, move(uuid, operationKey 'composed-placement-{action}', target 'default', expectedTargetRevision, remotePath '/tmp/{action}.bin'). 승인(POST /api/{id}/approve) 후 observe(waitMs 10000), stat, 같은 입력 재호출 | create는 200이고 키 `['uuid']`; 청크 ack는 sequence=seq+1, received=offset+chunk.length; complete는 같은 `{uuid}`; GET state='ready'. files 요청 직후 request.state='pending'이고 업로드 효과는 copy 0건, move 1건(문자 그대로 단언)이며 응답 JSON에 `artifactId`·`sourceUUID`·`portal-owner-v1`·`.part` 없음. 승인은 200 또는 202, observe 결과 state='completed'·failed=false. stat은 copy 뒤 'ready', move 뒤 'moved'. 같은 입력 재호출은 같은 request.id(재실행 없음, 효과 누적 copy 1/move 2), 업로드된 바이트는 원본과 동일 | 단계별 status·키·state, 효과 건수, 응답 본문 비노출 정규식, 바이트 동일 | portal-app | test/opaque-files-application.test.mjs:48 | - |
| RC-B-106 | PC 클라이언트 opaque 업로드: 385KiB를 한도 내 raw 바이트로 전송하고 UUID만 반환 | 385*1024바이트(i%256) 파일, 정상 서버 모의. upload(file, key='opaque-client-fixture-20261104', progress 콜백). 모든 요청은 redirect 'error', 인증 자격(3.0은 기기 등록 토큰)·Origin 포함 | 반환 `{uuid}`, progress는 `[{uuid,phase:'staging'}]` 한 건, 청크 길이는 `[262144,132096]`이고 이어붙이면 원본과 동일(각 청크 ≤262144, content-type application/octet-stream, x-chunk-sha256=청크 해시, PUT, 순번은 현재 sequence). begin 본문 키는 정확히 `fileName,operationKey,sha256,size`(fileName은 'synthetic.bin' 기본 이름). begin 1회·complete 1회(본문 '{}'), 최종 state 'ready' | 반환값·진행·청크 길이 배열·바이트 동일·요청 횟수, begin 본문 키 | portal-client | test/opaque-files-client.test.mjs:71 | - |
| RC-B-107 | 클라이언트 세션: 서버 원인 코드를 typed로 보존하되 기존 거절 코드는 불변 | 서버가 (ARTIFACT_QUOTA,507), (ARTIFACT_NOT_FOUND,404), (CHUNK_HASH_MISMATCH,422), (ARTIFACT_HASH_MISMATCH,422)로 `{error:code}` JSON 응답 | 오류 code는 `PORTAL_REQUEST_REFUSED`, status는 응답 status, serverCode는 서버 코드, message는 'PORTAL_REQUEST_REFUSED'. 해당 경로 요청은 정확히 1회(재시도 없음) | 4쌍 순회, error 필드 단언·요청 횟수 1 | portal-client | test/opaque-files-client.test.mjs:96 | - |
| RC-B-108 | 비JSON·잘못된 JSON 오류 응답은 원래 거절만 유지 | status 409에 본문 `{"error":`(application/json), `{"error":"ARTIFACT_QUOTA"}`(text/plain), `<html>private path /home/private and token</html>`(text/html) | code `PORTAL_REQUEST_REFUSED`, status 409, serverCode 속성 없음, message에 'private' 없음 | 3본문 순회, hasOwn(serverCode)=false, message 비노출 | portal-client | test/opaque-files-client.test.mjs:104 | - |
| RC-B-109 | 서버 원인 코드는 3~64자 대문자 ASCII 코드만 보존 | `error` 값이 'ab', 'A'×65, 'ERR\n', 'ERR\r', 'ERR\r\n', '/home/private/token', 'PASSWORD=private-marker', 'LOWER_case', 객체 `{code:'ARTIFACT_QUOTA'}`, 배열, null (status 409). 유효 값 'ERR', 'A'×64, 'CODE_200'. UUID+CR/LF 3종, 16자 키+CR/LF 3종 검증 함수 | 부적합 값은 모두 `PORTAL_REQUEST_REFUSED`이고 serverCode 속성 없음. 유효 3종은 serverCode가 그대로 보존. opaqueUuidValid(uuid+suffix)=false, opaqueOperationKeyValid('a'×16+suffix)=false | 부적합 11종 serverCode 부재, 유효 3종 일치, CR/LF 검증 함수 false | portal-client | test/opaque-files-client.test.mjs:111 | - |
| RC-B-110 | 오류 응답 본문의 1MiB JSON 한도가 선택적 원인 코드도 제한 | status 507, application/json, 256KiB 조각을 최대 32개 스트리밍(조각 'x') | 오류 code `PORTAL_REQUEST_REFUSED`, status 507, serverCode 없음. 스트림은 32조각 전에 중단(produced<32)되고 cancel 호출됨 | 오류 필드, produced<32, cancelled=true | portal-client | test/opaque-files-client.test.mjs:126 | - |
| RC-B-111 | 401은 항상 소유자 재인증 요구이며 모순되는 서버 원인을 받지 않음 | status 401, 본문 `{"error":"ARTIFACT_QUOTA"}` 스트림 | 오류 code `OWNER_REAUTH_REQUIRED`, status 401, serverCode 속성 없음, 본문 스트림 cancel됨 | 오류 필드, hasOwn(serverCode)=false, cancelled=true | portal-client | test/opaque-files-client.test.mjs:136 | - |
| RC-B-112 | 네트워크 불확실성은 읽기/쓰기를 구분하고 원인을 만들지 않음 | fetch가 개인 경로를 담은 오류를 throw. json('/api/refused', {})(쓰기)와 json('/api/refused')(읽기) | 쓰기는 code `PORTAL_RESULT_UNKNOWN`, 읽기는 `PORTAL_READ_FAILED`, 둘 다 serverCode 없음, 각 호출 1회씩 총 2회 | code 구분, serverCode 부재, 호출 횟수 2 | portal-client | test/opaque-files-client.test.mjs:145 | - |
| RC-B-113 | opaque 업로드·CLI stderr가 안전한 청크 원인과 같은 UUID만 유지 | 서버가 chunks 요청에 422 `{error:'CHUNK_HASH_MISMATCH'}`. CLI main(['--origin',origin,...,'upload','--file',f,'--operation-key',key]) | 종료 코드 1, stdout '', stderr 마지막 줄 JSON 정확히 `{error:'PORTAL_REQUEST_REFUSED',serverCode:'CHUNK_HASH_MISMATCH',uuid,phase:'chunks',state:'staging',received:0,sequence:0}`. stderr에 'synthetic.bin'·자격 증명·내부 마커 없음. 청크 요청 1회, complete 0회. (3.0은 `--cloudflared` 인자 제거, 기기 토큰으로 대체) | 종료 코드, stdout 빈 문자열, 마지막 줄 deepEqual, 정규식 부재, 요청 횟수 | portal-client | test/opaque-files-client.test.mjs:152 | - |
| RC-B-114 | opaque status 투영: 선언된 상태 전반에 같은 UUID의 안전한 메타데이터 | 상태 staging, ready(received=size), expired, consuming, moved, removed 각각 client.status(uuid). 'a'×48 UUID. sha256+CR/LF 3종 | 결과 키는 정확히 `uuid,state,size,sha256,expiresAt,received,sequence`(fileName·operations·내부 마커 제외), uuid·state 일치. 잘못된 UUID는 code `INVALID_ARTIFACT_UUID`, sha256 접미사 응답은 `INVALID_ARTIFACT_RESPONSE` | 6상태 순회 키 deepEqual, 정규식 부재, 두 오류 code | portal-client | test/opaque-files-client.test.mjs:165 | - |
| RC-B-115 | 이미 ready인 artifact는 청크·complete 재전송 없이 UUID 반환 | 서버 상태 initialState 'ready', received=385KiB, sequence=2 | upload 결과 `{uuid}`, 청크 0건, complete 요청 0건 | 결과 deepEqual, 청크·complete 횟수 0 | portal-client | test/opaque-files-client.test.mjs:182 | - |
| RC-B-116 | 0바이트 파일은 가공 청크 없이 완료 | size 0 파일 upload | 결과 `{uuid}`, 청크 0건, received 0, sequence 0, complete 1회 | 결과·청크 0·received/sequence 0·complete 1 | portal-client | test/opaque-files-client.test.mjs:188 | - |
| RC-B-117 | 소유자 거절·비정상 진행 메타데이터는 청크를 보내지 않음 | begin이 status 403(본문 없음). 별도로 서버 received=size+1 | 403이면 code `PORTAL_REQUEST_REFUSED`, 청크 0건. received>size이면 code `INVALID_ARTIFACT_RESPONSE`, 청크 0건 | 두 시나리오 오류 code, 청크 0 | portal-client | test/opaque-files-client.test.mjs:195 | - |
| RC-B-118 | 기존 부분 artifact는 관찰만 하고 조용히 재개하지 않음 | 서버 상태 received=1, sequence=1 | upload 오류 code `ARTIFACT_ALREADY_STAGING`, error.uuid=uuid, progress.received=1. 청크 0건, begin 요청 1회 | 오류 필드, 청크 0, begin 1회 | portal-client | test/opaque-files-client.test.mjs:202 | - |
| RC-B-119 | begin 응답 유실은 불확실성을 보존하고 대체 할당을 하지 않음 | begin 요청이 응답 대신 오류 throw(개인 마커 포함) | 오류 code `PORTAL_RESULT_UNKNOWN`, phase 'begin', uuid undefined. begin 요청 1회, 청크 0건 | 오류 필드, begin 횟수 1, 청크 0 | portal-client | test/opaque-files-client.test.mjs:208 | - |
| RC-B-120 | 청크 응답 유실은 같은 UUID를 관찰하고 재시도·complete를 보내지 않음 | 첫 청크 서버 반영 후 응답 throw | 오류 code `PORTAL_RESULT_UNKNOWN`, uuid 일치, progress.received=262144, progress.sequence=1. 청크 1건, complete 0, begin 1회 | 오류 필드, 청크 1, complete 0, begin 1 | portal-client | test/opaque-files-client.test.mjs:214 | - |
| RC-B-121 | complete 응답 유실은 같은 ready UUID를 진행 상태로 보고하고 재실행·거짓 성공 없음 | complete 반영 후 응답 throw | 오류 code `PORTAL_RESULT_UNKNOWN`, uuid 일치, progress.state='ready'. 청크 2건, complete 1회 | 오류 필드, 청크 2, complete 1 | portal-client | test/opaque-files-client.test.mjs:221 | - |
| RC-B-122 | 잘못된 ack은 완료 UUID를 만들지 못하고 바이트 구간을 건너뛰지 못함 | 서버가 청크 ack의 sequence를 +1 부풀려 반환 | 오류 code `INVALID_ARTIFACT_ACK`, 청크 1건 전송으로 중단, complete 0 | 오류 code, 청크 1, complete 0 | portal-client | test/opaque-files-client.test.mjs:227 | - |
| RC-B-123 | 잘못된 UUID 응답·전체 해시 불일치는 청크 전송 전 실패 | begin이 'a'×48 UUID 반환. 별도로 서버 artifact.sha256='0'×64 | 앞은 code `INVALID_ARTIFACT_RESPONSE`, 뒤는 `ARTIFACT_SOURCE_MISMATCH`, 둘 다 청크 0건 | 두 오류 code, 청크 0 | portal-client | test/opaque-files-client.test.mjs:233 | - |
| RC-B-124 | CLI 업로드: 단일 UUID JSON 줄만 출력하고 원본 바이트·파일명·자격 증명 비출력 | main(['--origin',origin,...,'upload','--file',f,'--operation-key',key]) 정상 서버 | 종료 코드 0, stdout 정확히 `{"uuid":"..."}\n`, 자격 증명 공급 함수 호출 1회, stdout+stderr에 'synthetic.bin'·자격 증명·내부 마커·'base64' 없음, stderr는 `{uuid,phase:'staging'}` | 종료 코드, stdout 정확 문자열, 호출 횟수, 정규식 부재, stderr deepEqual | portal-client | test/opaque-files-client.test.mjs:240 | - |
| RC-B-125 | CLI 응답 유실: 성공 stdout 없음, 같은 UUID의 한정된 진행만 stderr | 청크 응답 유실 상태로 CLI upload | 종료 코드 1, stdout '', stderr 마지막 줄 `{error:'PORTAL_RESULT_UNKNOWN',uuid,phase:'chunks',state:'staging',received:262144,sequence:1}`, stderr에 'private marker'·파일명·자격 증명 없음, 청크 1건 | 종료 코드·stdout·마지막 줄 deepEqual·정규식 부재·청크 1 | portal-client | test/opaque-files-client.test.mjs:250 | - |
| RC-B-126 | CLI는 안정 키 누락·잘못된 UUID를 자격 증명·네트워크 접근 전에 거절 | 인자 `upload --file f`(키 없음), `--operation-key`가 15자, `status` 'a'×48 | 각각 종료 코드 1, stdout '', stderr가 `INVALID_ARGUMENTS`·`INVALID_ARTIFACT_UUID`·`INVALID_OPERATION_KEY` 중 하나와 일치, 자격 증명 공급 함수 호출 0회 | 3인자 조합 순회, 종료 코드·stdout·stderr 패턴·호출 횟수 0 | portal-client | test/opaque-files-client.test.mjs:262 | - |
| RC-B-127 | operation key 문법: 공개 16~128 ASCII 계약의 양 경계 | 유효 'a'×16, 'a'×128, '_'×16, '.:-_'×4. 무효 '', 'a'×15, 'a'×129, '가'×16, 'a'×16+'\n', 'a'×15+'/', null | 유효값은 true, 무효값은 모두 false | 값 목록 순회 불리언 단언 | portal-client | test/opaque-files-client.test.mjs:272 | - |
| RC-B-128 | PC 클라이언트 배포 묶음: 아카이브 검증된 원본·외부 의존성 없이 실행 | 클라이언트 패키징 산출물(3.0은 jlink 동봉 런타임 압축본; 원 시험은 tar.gz·zip). 매니페스트의 files 항목 | 매니페스트 version이 제품 버전과 같고, 각 파일의 size·sha256이 실제 내용과 일치, 아카이브 항목 수는 매니페스트 files+1(매니페스트 자신), 모든 항목은 버전 접두 디렉터리 아래이고 경로 탈출(`..`) 없음. .env·서버 앱 파일·node_modules 계열(3.0은 서버 전용 산출물) 미포함. 압축 형식이 둘이면 내용 동일. 풀어서 `--help` 실행 시 stdout에 'file client' + 버전, stderr 빈 문자열(외부 의존성 설치 없이). (원 시험의 python·Node engines `>=24.2.0 <25` 단언은 3.0에 없음) | 매니페스트 대조, 경로 안전, 아카이브 간 동일성, --help 출력 | packaging | test/opaque-files-client.test.mjs:277 | - |
| RC-B-129 | opaque copy: 대상 결속 fd 복제와 유실 응답·재시작 뒤 단일 내구 요청 복구 | 4바이트 staged 파일, 같은 인자 copy(target 'alpha', expectedTargetRevision 'a'×64, remotePath '/tmp/opaque.bin') 2건 병렬. 같은 키 다른 remotePath. 재오픈 뒤 같은 copy. 다른 revision | 두 응답 같은 requestId, 업로드 admission 1회. 복제본(provenance 있음)은 원본과 id가 다르고 targetId 'alpha', 원본 targetId undefined, sha256 동일, provenance.sourceUUID=uuid. 다른 remotePath는 code `OPERATION_KEY_CONFLICT`. 재오픈 뒤 같은 requestId·admission 1회. stat은 state 'ready', operations[0].requestId 일치, 응답에 id/ownerId/path/targetId/remotePath 키 없음. 다른 revision은 code `TARGET_REVISION_CONFLICT` | requestId 동일, admission 횟수, 복제 필드, 오류 code, stat 비노출 키 | portal-app | test/opaque-files.test.mjs:53 | - |
| RC-B-130 | opaque move: 불확실 결과는 원본 유지, 게시 확인 뒤 한 번만 소비 | move 요청 뒤 저널을 state 'unknown'(requiresReconciliation)로 갱신하고 onTerminal. 이어 remove, 같은 move, 다른 키 move. 이후 저널 outcome(success: published true·size 4·sha256 일치·execution settled/exit/exitCode 0/cleanupComplete true)로 확정 후 onTerminal, 재오픈·reconcile, 소비 뒤 copy | unknown 동안 stat state 'ready', 원본 `.part` 크기 4. remove는 `/busy/`. 같은 move는 같은 requestId(admission 1회). 다른 키 move는 code `OPAQUE_ACTION_RECONCILIATION_REQUIRED`. 성공 확정 뒤 state 'moved', operations[0].requestId 일치, `.part` ENOENT. 재오픈·reconcile 뒤에도 'moved'이며 같은 move는 같은 requestId(admission 1회). 소비 뒤 copy는 code `STAGED_FILE_CONSUMED` | state 추이, `.part` 크기/ENOENT, 오류 code, 요청 횟수 | portal-app | test/opaque-files.test.mjs:69 | - |
| RC-B-131 | 게시 확인 없는 completed는 move 원본을 소비하지 않음 | move 요청 뒤 저널 queued→starting→outcome(성공이되 data `{}`) | stat state 'ready', 같은 move는 같은 requestId, admission 1회 | state, requestId, 횟수 | portal-app | test/opaque-files.test.mjs:90 | - |
| RC-B-132 | 게시 검사: 원본 바이트·감사 상태·선택적 실행 메타데이터 결속 | 저널 completed result 변형 5종: 실행 메타 없음, size+1, sha256 '0'×64, 큐 항목 auditError='Final audit write failed', execution.cleanupComplete=false | 실행 메타 없음만 state 'moved', 나머지 4종은 'ready'(소비 안 함). 각 경우 admission 1회 | 5시나리오 stat state, admission 1 | portal-app | test/opaque-files.test.mjs:98 | - |
| RC-B-133 | 복구: 수락되지 않았음이 증명된 복제 provenance만 제거, 저널 없는 큐 identity는 보존 | reserveStagedAction 후 importFile로 복제만 만들고(수락 전 크래시) 재오픈, 큐에는 requestId는 있고 저널은 없는 상태로 reconcile, 그 뒤 큐 정상화 후 reconcile | 첫 reconcile은 code `OPAQUE_ACTION_RECONCILIATION_REQUIRED`, 복제본 유지, 원본 pinned=true. 정상화 뒤 reconcile은 복제본 삭제, actions[0].state='refused', pinned=false, admission 0 | 오류 code, has(clone) 추이, actions state, pinned | portal-app | test/opaque-files.test.mjs:117 | - |
| RC-B-134 | unknown·저널 누락 copy는 새 move를 막되 원래 영수증은 보존 | copy 후 (a) 저널 unknown+재오픈+reconcile (b) 저널 get/find가 해당 id만 null (c) 정상 대기(pending). 이후 다른 키 move, remove, 같은 copy | (a)(b): move는 code `OPAQUE_ACTION_RECONCILIATION_REQUIRED`, remove는 code `ARTIFACT_BUSY`, 같은 copy는 같은 requestId(admission 1회). (c): 다른 키 move는 다른 requestId로 수락, admission 2회(독립 복제 계약). 세 경우 모두 원본 `.part` 크기 4 | 3시나리오 오류 code, requestId, admission 횟수, `.part` 크기 | portal-app | test/opaque-files.test.mjs:138 | - |
| RC-B-135 | 시작 시 고아 정리: 다른 작업의 큐 참조·저널 읽기 실패·불완전 읽기는 보존 | 수락 전 복제본 + (queue-reference) 큐 listAll이 복제 artifactId를 참조 / (journal-read-failed) journal.list가 code SQLITE_ERROR throw / (journal-truncated) journal.list가 [] 반환. 이후 원상복구 reconcile | 큐 참조·저널 잘림은 code `OPAQUE_ACTION_RECONCILIATION_REQUIRED`, 읽기 실패는 원래 오류 code 그대로(3.0은 H2/JDBC 예외를 그대로 전파) 거절. 거절 동안 복제본 유지, actions[0].state='reserved', pinned=true, admission 0. 복구 뒤 reconcile은 복제본 삭제 | 3시나리오 오류 code, 상태 불변, 복구 후 삭제 | portal-app | test/opaque-files.test.mjs:179 | - |
| RC-B-136 | 시작 참조 스캔은 일반 저널 행 한도를 넘는 보존 레거시 행도 포함 | 저널 maxRows=1에서 importLegacy 2건(둘째가 복제본 artifactId를 참조, source 'retained-upload-history') | usage().count=2, list().length=2. reconcile은 code `OPAQUE_ACTION_RECONCILIATION_REQUIRED`, 복제본 유지, pinned=true, admission 0 | 개수 2, 오류 code, 복제본 유지 | portal-app | test/opaque-files.test.mjs:195 | D-0017(후보) |
| RC-B-137 | 청크 해시 실패·타 소유자 UUID 접근은 수락된 바이트를 바꾸지 않음 | staged 파일에 append(bytes 'wrong', sha256=hash('different')). 다른 소유자로 store.staged. remove 2회 | append는 code `CHUNK_HASH_MISMATCH`, 이후 stat은 이전과 deepEqual. 타 소유자 조회는 `/unavailable/`. remove 결과 state 'removed'(2회 모두, 멱등) | 오류 code, stat 불변, remove 상태 | portal-app | test/opaque-files.test.mjs:206 | - |
| RC-B-138 | copy·move operationKey의 CR/LF 접미사를 admission 전에 거절 | action ∈ {copy, move} × suffix ∈ {`\r`,`\n`,`\r\n`}, operationKey='valid-operation-key'+suffix | 모두 code `INVALID_OPERATION_KEY`, admission 0회, stat().operations는 undefined | 6조합 오류 code, admission 0, operations undefined | portal-app | test/opaque-files.test.mjs:216 | - |
| RC-B-139 | 2.x 이력 이전: 정확한 이력·정책·원본 바이트 보존, 읽기 전용 보관, 레거시 작업 큐 미적재 | command-automation SQLite(requests 테이블)에 completed(output.id/expiresAt 포함)·running 두 작업과 policy. 이전 명령 실행 후 재실행 | receipt.imported=2, receipt.unknown=1, sources[0].sha256은 원본 파일 해시. completed의 legacy.original은 원본 JSON과 deepEqual, 원래 request_key로 find 가능, state 'completed'. running은 state 'unknown', requiresReconciliation=true. 'queued' 목록 0건. 재실행도 imported=2, 총 2건(중복 없음). 원본 파일 바이트 불변, 보관본 `command-automation.sqlite`도 같은 바이트(비Windows는 모드 0400). receipt.outputRetention.unavailable이 `/never replay/`와 일치 | receipt 필드, deepEqual 원본, 상태 unknown, 바이트·해시 일치, 보관 권한, 문구 패턴 | portal-migrate | test/operation-migration-180.test.mjs:32 | D-0016(후보) |
| RC-B-140 | 레거시 전역 request-key 충돌은 정규 행 추가·원본 변경 전에 실패 | command-automation.sqlite와 agent-cli.sqlite에 같은 requestKey 'shared-original-request-key'(서로 다른 id 'a'×48, 'b'×48) | code `OPERATION_KEY_CONFLICT`. find(requestKey) null, 두 id 조회 null(부분 기록 없음). 두 원본 파일 바이트 불변 | 예외 code, 조회 null 3건, 바이트 비교 | portal-migrate | test/operation-migration-180.test.mjs:57 | D-0018(후보), D-0039(후보) |
| RC-B-141 | 미지원·비정상 종료 구 스키마는 import 전 실패하고 구 DB를 변경하지 않음 | agent-cli.sqlite에 테이블 wrong_schema만 존재 → 이력 읽기. 별도로 `agent-cli.sqlite-journal`(내용 'interrupted') 파일 존재 상태에서 이전 | 스키마 불일치는 code `UNSUPPORTED_LEGACY_SCHEMA`이고 DB 바이트 불변. journal 파일이 있으면 code `LEGACY_NOT_QUIESCENT`이고 import 호출 없음. (3.0은 SQLite 핫 저널·사이드카 파일 존재를 같은 거절로 판정) | 두 오류 code, 바이트 불변, import 미호출 | portal-migrate | test/operation-migration-180.test.mjs:72 | - |
| RC-B-142 | 재배포 이전 재사용: 첫 import 보존(1.8.0·2.0.0 저널 복구 뒤)과 상충하는 원본 증거 감지 | 이전 릴리스 version ∈ {1.8.0, 2.0.0}. command 작업 2건(running, pending)과 agent-cli 작업 2건(queued, pending)을 구 상태 저장소에 삽입. 첫 이전 실행(generation a) → 영수증 기록(phase activated). 구 저장소를 다시 열어 상태 확인. 두 번째 이전(generation b, previousGeneration·previousRelease 지정). 영수증 전역 마커 삭제 뒤 세 번째(generation c). 저장된 evidence의 state를 'failed'로 갱신 시도 후, 저장소를 직접 변조해 네 번째(generation d) | 첫 이전 imported=4, unknown=4. 구 저장소는 [running→'unknown', pending→'expired']·[queued→'unknown', pending→'expired']. 두 번째는 reused=true, originalGeneration=a, 세 DB 파일(command-automation·agent-cli·operations) 바이트 불변, generation b 보관 디렉터리 생성 안 됨(ENOENT). 영수증이 있으면 마커 없이도 세 번째가 reused=true·originalGeneration=a. 정규 목록 4건, queued 0건, legacy.original은 원 작업과 deepEqual. 증거 갱신 시도는 code `OPERATION_CONTRACT_IMMUTABLE`. 변조 뒤 네 번째는 code `OPERATION_KEY_CONFLICT`이고 DB 바이트 불변 | 단계별 imported/unknown, reused·originalGeneration, 파일 바이트 비교, 보관 디렉터리 부재, 불변 오류, 충돌 오류 | portal-migrate | test/operation-migration-180.test.mjs:82 | D-0016(후보) |
| RC-B-143 | 기존 배포 이전은 권위 있는 완료 이전 증거를 요구하고 부분 상태에서 추측하지 않음 | 이전 릴리스 version ∈ {1.8.0, 2.0.0, 2.0.3}. 구 저장소에 running 작업 1건. 이전 영수증 없음, 그리고 phase 'migrating'(imported 0, sources 빈 배열)인 영수증 | 두 경우 모두 code `LEGACY_MIGRATION_RECEIPT_REQUIRED`, 구 DB 바이트 불변, `operations.sqlite` 생성되지 않음(ENOENT) | 3버전×2영수증 상태 오류 code, 바이트 불변, 신규 DB 부재 | portal-migrate | test/operation-migration-180.test.mjs:135 | D-0016(후보) |
| RC-B-144 | 이전 재사용은 보관본 심볼릭 링크를 대상 열기 전에 거절 | 첫 이전 후 보관된 `command-automation.sqlite`를 삭제하고 존재하지 않는 대상으로의 심볼릭 링크로 교체한 뒤 다음 generation 이전. (비Windows에서만 실행; Windows는 skip) | code `UNSAFE_LEGACY_FILE` | 오류 code | portal-migrate | test/operation-migration-180.test.mjs:150 | D-0016(후보) |
| RC-B-145 | 추가 이력이 있는 복원된 1.7 writer는 이전 마커를 조용히 재사용할 수 없음 | 1.7.6 이전 릴리스. 첫 이전 후, 변경 없는 재이전은 reused=true. 구 DB에 작업 1건(pending) 추가 후 재이전 | code `LEGACY_MIGRATION_SOURCE_CHANGED`. 구 DB·operations.sqlite·마커·보관본 바이트 불변, 새 generation 보관 디렉터리 생성 안 됨 | 오류 code, 4개 보호 파일 바이트 비교, 디렉터리 부재 | portal-migrate | test/operation-migration-180.test.mjs:161 | D-0016(후보) |
| RC-B-146 | 복구 장벽 지문: payload·신규 내구 저장소·SQLite 사이드카 포함, 미지의 이름은 거절 | operations.sqlite와 command-outputs/{48자}.out의 내용 변경. 새 디렉터리 new-store 추가. {command-automation, agent-cli, maintenance, operations, capacity}.sqlite 각각에 '', -journal, -wal, -shm 접미사 파일을 만들고 하나씩 변경. unknown.sqlite, unknown.sqlite-wal, capacity.sqlite.backup, capacity.sqlite-journal-extra | payload 내용이 바뀌면 지문 변화, 알려진 20개 파일 각각의 변경도 지문 변화(`capacity` 포함). 신규 디렉터리·알 수 없는 이름은 code `UNSUPPORTED_DURABLE_DATA`로 거절. (3.0은 H2 데이터 파일 구성에 맞춰 알려진 이름 집합을 정의하되 단언 구조 유지) | 지문 notEqual, 미지 이름 오류 code | portal-migrate | test/operation-migration-180.test.mjs:181, test/operation-migration-180.test.mjs:194 | D-0031(후보) |
| RC-B-147 | 새 쓰기가 있으면 자동 복구(다운마이그레이션)를 거절하고 후보 릴리스·데이터 유지 | activated 상태 배포 기록에 baseline 지문 저장 뒤 operations.sqlite를 'new-admission'으로 변경. 또는 capacity.sqlite·-journal·-wal·-shm 중 하나를 변경. runDeployment('recover'). (비Windows 전용) | code `DOWNMIGRATION_FORBIDDEN_AFTER_WRITES`. active 링크는 후보 릴리스 그대로, operations.sqlite는 'new-admission'(또는 변경 안 한 'unchanged-operations') 유지, 변경한 capacity 파일 내용도 그대로 | 오류 code, readlink 불변, 파일 내용 불변(4개 capacity 변형) | packaging | test/operation-migration-180.test.mjs:211, test/operation-migration-180.test.mjs:230 | D-0031(후보) |
| RC-B-148 | 8000행 합성 레거시 이력이 기존 60초 자식 프로세스 경계 안에서 이전되고 바이트 보존·멱등 재확인 | requests 8000행(2048바이트 본문, n%11==0이면 running, 키 'synthetic:'+n) command-automation.sqlite. 이전 자식 프로세스(60초 timeout) 실행 뒤 재확인 자식 실행 | 자식 종료 상태 0, 오류 없음. receipt.imported=8000, receipt.unknown=floor(8000/11). 원본·보관본 해시 일치(원본 불변). 저장소 usage().count=8000, find('synthetic:11').job.state='unknown', find('synthetic:8000').job.legacy.original은 원 작업과 deepEqual. 재확인(--migration-check)도 상태 0이고 원본 해시 불변 | 종료 상태 0, 시간 한도(60초) 내 완료, imported/unknown 수, 해시, deepEqual | portal-migrate | test/operation-migration-batch.test.mjs:27 | D-0017(후보) |
| RC-B-149 | 배치 실패는 앞선 import를 보존하고 보존/실행 바이트·행 예산을 재오픈 후에도 정확히 유지 | 저장소 maxRows=1, maxBytes=2048. 1건 import 후 [row2, 변조 digest의 row1] 배치, [row2,row3] 배치, [row4, 변조된 row2] 배치, [row1,row2,row3] 재배치, 첫 작업 result를 8192자로 갱신, legacy.source 갱신 시도, 재오픈, 실행 작업 2건 accept | 변조 배치는 code `OPERATION_KEY_CONFLICT`이고 usage·legacyUsage·기존 행 불변, 부분 기록(find('synthetic:2'), 'synthetic:4') null. [row2,row3] 성공 후 count 3. 같은 배치 재투입은 기존 행 그대로 반환(usage 불변). 결과 확대는 code `OPERATION_CAPACITY`, legacy 변경은 `OPERATION_CONTRACT_IMMUTABLE`. 재오픈 뒤 usage·legacyUsage 동일, list 3건(보존 행은 live maxRows로 절삭되지 않음). 실행 작업 1건 accept 시 count 4, 두 번째는 `OPERATION_CAPACITY` | 예외 code, usage/legacyUsage deepEqual, find null, 재오픈 비교 | portal-migrate | test/operation-migration-batch.test.mjs:60 | D-0039(후보), D-0017(후보) |
| RC-B-150 | 예산 도입 이전 부분 import가 크래시(트랜잭션 도중 프로세스 종료) 뒤에도 원본 이력을 잃지 않고 실행 허용량을 소비하지 않음 | 1건 import(이벤트 기록) 뒤 보존 예산 테이블을 제거한 상태에서, 다른 프로세스가 큰 UPDATE 트랜잭션 중 SIGKILL로 종료(미완료 트랜잭션 잔존) 후 저장소 재오픈. 같은 행 재배치 | get·events가 크래시 전과 deepEqual. legacyUsage().count=1, legacyUsage().bytes == usage().bytes. 같은 행 importLegacyBatch는 legacyUsage 불변. (3.0은 SQLite hot journal 대신 H2 트랜잭션 롤백·재오픈으로 같은 불변식을 확인; 예산 테이블 제거는 2.x 스키마 설정이므로 3.0 구현 담당이 동등한 "예산 기록 누락" 상태로 재현) | get/events deepEqual, 예산 count·bytes, 재배치 불변 | portal-migrate | test/operation-migration-batch.test.mjs:89 | D-0039(후보) |
| RC-B-151 | 수락된 원본 30MiB 이력이 64MiB를 넘게 확장돼도 별도 실행 예산을 소비하지 않음 | 5000행, 각 command 6000자('x'), 이전 자식 프로세스(60초 timeout) 실행 | 자식 상태 0, receipt.imported=5000, usage().bytes > 64MiB. legacyUsage count=5000, bytes == usage().bytes, sources[0].originalBytes < 64MiB. 이후 새 작업 accept 성공하고 legacyUsage 불변. 과거 unknown 작업은 claim이 null(실행 권한 없음). 원본 해시 불변 | 상태 0, 바이트 수 부등식, accept 성공, claim null, 해시 | portal-migrate | test/operation-migration-batch.test.mjs:107 | D-0017(후보) |
| RC-B-152 | 배치 검증은 누락·충돌 증거를 거절하고 행·이벤트를 추가하지 않음 | row1,row2 import 후 requireExisting 옵션으로 [row1,row3] / [state를 failed로 바꾼 row1] 검증, 129행 배치 | 누락은 code `LEGACY_MIGRATION_RECORD_MISSING`, 상태 불일치는 `OPERATION_KEY_CONFLICT`, 129행 배치는 `INVALID_LEGACY_BATCH`(배치 한도 128). 세 경우 usage·events 불변, row3 조회 null | 예외 code 3종, usage/events 불변 | portal-migrate | test/operation-migration-batch.test.mjs:134 | D-0039(후보) |
| RC-B-153 | 출처 간 request-key 충돌은 정규 쓰기 전에 전체 목록을 거절 | command-automation.sqlite와 agent-cli.sqlite가 같은 requestKey 'shared-original-key'(서로 다른 작업) | code `OPERATION_KEY_CONFLICT`, find·두 id 조회 null, usage·legacyUsage 불변, 보관 디렉터리 미생성(사전 검사가 보관보다 먼저), 원본 바이트 불변 | 오류 code, null 조회, usage 불변, 보관 디렉터리 부재 | portal-migrate | test/operation-migration-preflight.test.mjs:51 | D-0018(후보) |
| RC-B-154 | 명시 키가 다른 출처의 기본 레거시 키와 충돌하지 않음 | 출처 1은 requestKey 없음(기본 키 `legacy:command-automation.sqlite:{id}`), 출처 2는 그 기본 키를 명시 키로 사용 | code `OPERATION_KEY_CONFLICT`, find(기본 키) null, usage·legacyUsage 불변, 보관 디렉터리·원본 불변 | 오류 code, 조회 null, 불변 | portal-migrate | test/operation-migration-preflight.test.mjs:61 | D-0018(후보) |
| RC-B-155 | 출처 간 operation ID 충돌은 서로 다른 원본 키에서 부분 import 없이 거절 | 두 출처에 같은 job id, requestKey 'synthetic:1' vs 'different-original-key', digest 다름 | code `OPERATION_KEY_CONFLICT`, get(id)·find(두 키) null, usage 불변, 보관 디렉터리 부재 | 오류 code, null 조회, 불변 | portal-migrate | test/operation-migration-preflight.test.mjs:70 | D-0018(후보) |
| RC-B-156 | 뒤쪽 정규 충돌(key/id/original/digest/source)이 앞의 129행 출처를 커밋하지 못함 | 출처 1에 129행, 출처 2에 1행(id 1000). 기존 정규 저장소에 그 1행을 변형해 선 import: key(다른 id), id(다른 requestKey), original(result.text 다름), digest(다름), source(출처명 다름) 각각 | 5가지 모두 code `OPERATION_KEY_CONFLICT`. 129행 어느 것도 get·find로 조회되지 않음(null), usage·legacyUsage·기존 행·이벤트 불변, 보관 디렉터리 미생성, 원본 파일 불변, operations.sqlite 바이트 불변(사전 검사는 기존 정규 DB를 쓰지 않음) | 5변형 × 오류 code, 129행 null, 불변 비교, DB 바이트 | portal-migrate | test/operation-migration-preflight.test.mjs:82 | D-0039(확정), D-0018(후보) |
| RC-B-157 | 정확한 부분 import는 기존 증거를 바꾸거나 작업을 재실행하지 않고 재개 | 출처 1에 2행, 출처 2에 1행. 첫 행만 정규 저장소에 선 import. 이전 실행, 재실행 | 첫 실행 receipt.imported=3, count 3, 기존 행·이벤트 불변, queued 0건, 각 행 legacy.original이 원 작업과 deepEqual. 재실행은 이전 receipt와 deepEqual이고 usage·legacyUsage·이벤트 불변, 원본 파일 불변, 보관본이 원본 바이트와 동일 | receipt 동일, 불변 비교, 보관본 바이트 | portal-migrate | test/operation-migration-preflight.test.mjs:105 | D-0039(후보), D-0018(후보) |
| RC-B-158 | 유니코드 원본 키·증거가 정확하고 서로 구분된 채 사전 검사·재실행을 통과 | requestKey '문답:😀:é'(NFC)와 '문답:😀:é'(NFD), 본문에 '합성 이력 😀'·'보존 🚀' | 이전 imported=2. 각 키로 find 성공하고 job.requestKey가 원문 키와 같음, legacy.original이 원 작업과 deepEqual(정규화되지 않음). 재실행은 receipt deepEqual, usage·legacyUsage·이벤트 불변, 원본 불변 | 키 원문 일치(NFC≠NFD 구분), deepEqual, 재실행 불변 | portal-migrate | test/operation-migration-preflight.test.mjs:125 | D-0015(후보) |
| RC-B-159 | 수락된 10000행 출처 2개가 실행 작업과 나란히 보이고 실행·저장 슬롯을 소비하지 않음 | maxRows=1 저장소에 출처 2개(command-automation, agent-cli) 각 10000행을 128행 단위 배치로 import. 20001번째 행을 기존/제3 출처로 import. 실행 작업 'live-first' accept 후 queued로 갱신, claim(unknownBudget 1), 'live-second' accept, 재오픈 | list 20000건, legacyUsage().count=20000. 추가 import는 두 경우 모두 code `LEGACY_HISTORY_CAPACITY`, legacyUsage 불변. 실행 작업 1건 추가 후 list 20001, queued 1건, claim 성공(과거 unknown 행은 dispatch 권한 없음). 두 번째 실행 작업은 code `OPERATION_CAPACITY`. 재오픈 뒤 list 20001, legacyUsage 불변 | 개수, 오류 code 2종, claim 성공, 재오픈 비교 | portal-migrate | test/operation-migration-retained-budget.test.mjs:19 | D-0017(후보) |
| RC-B-160 | 정확히 256KiB인 레거시 항목이 확장된 본문·계약 저장을 견디고 불변 증거 유지 | 작업 JSON 크기가 정확히 262144바이트가 되도록 input.text 또는 result.text 채움, importLegacy(source command-automation). result 갱신, 다른 출처·다른 키·다른 id로 재import, 재오픈 | imported.legacy.original은 원 작업과 deepEqual. legacyUsage().sources[0].originalBytes는 input 필드일 때 256KiB, result까지 합쳐 512KiB. result 갱신 뒤에도 legacy.original 불변. 다른 출처 동일 키·같은 출처 다른 키·다른 id는 모두 code `OPERATION_KEY_CONFLICT`. 재오픈 뒤 legacyUsage 불변 | 크기 262144, originalBytes 합, 충돌 코드 3종, 재오픈 비교 | portal-migrate | test/operation-migration-retained-budget.test.mjs:38 | D-0017(후보) |
| RC-B-161 | 레거시 result 성장은 실행 바이트 예산을 정확히 과금하고 축소하면 복구, 예약은 확대되지 않음 | maxBytes=2048, now=100. 2048자 result 레거시 job import 후 result를 4096자로 갱신, 새 작업 accept, 원래 result로 되돌림, 다시 accept | usage().bytes 증가분은 정확히 2048, legacyUsage 불변. 성장 중 accept는 code `OPERATION_CAPACITY`. 되돌리면 usage·legacyUsage가 import 직후와 같고 accept 성공 | 바이트 증가분 2048, 오류 code, 복구 후 deepEqual, accept 성공 | portal-migrate | test/operation-migration-retained-budget.test.mjs:56 | D-0017(후보) |
| RC-B-162 | 레거시 축소가 다른 행을 지원하지 못하고 각 원본 기준선과 합산 실행 성장은 유지 | maxBytes=2048. result 8192자(a), 4096자(b) 레거시 import. a를 빈 result로 축소 후 3000자 input 작업 accept. a 복원, a를 9216자로, b를 5120자로 갱신, b를 5121자로 갱신, 재오픈, accept, a 복원 후 accept | 축소 후 accept는 code `OPERATION_CAPACITY`(이력 여유분으로 충당 불가). a 9216·b 5120 갱신은 성공, b 5121은 `OPERATION_CAPACITY`. legacyUsage는 처음 reserved와 같음(재오픈 뒤도). 재오픈 뒤 한도 상태에서 accept는 `OPERATION_CAPACITY`, a를 원래 크기로 복원하면 accept 성공 | 오류 code 시퀀스, legacyUsage deepEqual, 복원 후 accept | portal-migrate | test/operation-migration-retained-budget.test.mjs:70 | D-0017(후보) |
| RC-B-163 | 기존 예약 누락 시 변조된 import 투영을 무상 기준선으로 인정하지 않음 | 레거시 1건 import, 저장소 닫고 예산 테이블 제거, 저장된 본문을 'runtime expansion without an original reservation' result로 변조 후 저장소 열기. (3.0은 H2에서 동등한 "예약 기록 누락+본문 변조" 상태를 직접 구성) | 저장소 열기가 code `INVALID_LEGACY_IMPORT_BASELINE`로 실패. 변조 본문은 그대로 남고(read-only 확인) 예산 행 수는 0(자동 복구·자동 생성 없음) | 오류 code, 본문 불변, 예산 count 0 | portal-migrate | test/operation-migration-retained-budget.test.mjs:89 | D-0017(후보) |

### G03 (원자료 1371~1467: operation-observer-http ~ portal-client-discovery, mjs 97행)

| 사례 ID | 대상 기능 | 입력·조건 | 기대 결과 | 판정 방법 | 3.0 모듈 | 원 시험 | 연결 결함 |
|---|---|---|---|---|---|---|---|
| RC-B-181 | 관리자 HTTP operation 관찰: key·ID 조회 | 소유자 Bearer로 GET `/api/operations/by-key?operationKey=http-observe-stable-key-0001&waitMs=0` 및 `/api/{48자 id}?observe=1&waitMs=0`; operation 서비스는 주입(mutation 포트 호출 시 실패) | 둘 다 HTTP 200, body.ok=true, data.id·operationKey·targetId=`alpha`·targetRevision(64자)·state=`pending`, outputPage=null. 서비스 observe 호출은 정확히 `{operationKey,waitMs:0}`, `{id,waitMs:0}` 두 번 | 응답 코드·data 필드, observe 인자 deepEqual, queue·submit·cancel 미호출 | portal-web | test/operation-observer-http.test.mjs:42 | - |
| RC-B-182 | 관리자 HTTP operation 관찰: 잘못된 selector·인증·메서드 거절 | by-key에 대해 쿼리 없음, `operationKey=short`, key 뒤 `%0A`, operationKey 중복, `waitMs=60001`, waitMs 중복, operationKey+id 동시; Bearer wrong; POST(Origin 지정) | 쿼리 변형 7종 모두 400 `INVALID_OPERATION_OBSERVER`; 잘못된 토큰 401; POST 405; observe 호출 0회 | 상태 코드·error 코드, observe 호출 목록 빈 배열 | portal-web | test/operation-observer-http.test.mjs:54 | - |
| RC-B-183 | 관리자 HTTP key 장기 대기가 detached 예산을 사용 | `requestAdmission.admin {maxActive:1,maxQueued:1,maxDetached:1}`; 첫 by-key `waitMs=25000`이 observe 안에서 보류된 동안 같은 요청 한 번 더, 그리고 `/api/session` | 두 번째 by-key는 503 `REQUEST_WAIT_LIMIT`; `/api/session`은 200(소유자 제어 유지); observe 호출은 1회; 보류 해제 뒤 첫 요청 200 | 상태·오류 코드, 호출 횟수 | portal-web | test/operation-observer-http.test.mjs:66 | - |
| RC-B-184 | 관리자 HTTP 관찰 중 소유자 권한 만료 시 상태 은닉 | observe 도중 authorize가 `{allowed:false,status:401}`로 바뀜(observe 자체는 job 반환) | 응답은 정확히 `{status:401, body:{error:'OWNER_REAUTH_REQUIRED'}}`이고 job 상태가 본문에 없음; observe 호출 1회 | 응답 전체 deepEqual | portal-web | test/operation-observer-http.test.mjs:80 | - |
| RC-B-185 | 관리자 HTTP key 관찰의 거절 코드 보존 | observe가 `OPERATION_NOT_FOUND` 또는 `TARGET_REVISION_CONFLICT` 코드 오류(메시지 `private`)를 던짐 | 각각 404 `{error:'OPERATION_NOT_FOUND'}`, 409 `{error:'TARGET_REVISION_CONFLICT'}`; 내부 메시지 미노출; 대체 작업 제출 없음(observe 인자 `{operationKey,waitMs:0}` 1회, mutation 포트 호출 0) | 응답 deepEqual, 호출 목록 | portal-web | test/operation-observer-http.test.mjs:90 | - |
| RC-B-186 | 스케줄러: 준비된 target 링 공정성 | globalConcurrency=1; 요청 a1,a2,a3(alpha), b1(beta, kind upload), b2(beta), c1(gamma, kind cli) 순서로 enqueue 후 시작된 것부터 하나씩 완료 | 시작 순서는 정확히 `a1,b1,c1,a2,b2,a3`(target 간 라운드 로빈 + target 내 FIFO, kind 무관); 모두 최종 state=`completed` | 실행 시작 목록 deepEqual, 저장소 state | portal-app | test/operation-scheduler.test.mjs:26 | - |
| RC-B-187 | 스케줄러: 중복 enqueue와 키 충돌 | 같은 requestKey `same`을 두 번 enqueue, 같은 키에 input.command만 바꿔 enqueue, 완료 후 다시 enqueue | 동일 id 반환; 변경 입력은 `OPERATION_KEY_CONFLICT`를 던지고 실행 효과 전 거절; 완료 뒤 재enqueue도 같은 id; executor 시작은 `['same']` 1회 | id 비교, 오류 코드, 시작 목록 | portal-app | test/operation-scheduler.test.mjs:35 | - |
| RC-B-188 | 스케줄러: unknown이 한 conflictKey만 차단 | conflictKey=`install`인 `installer`가 `remoteState:'unknown', requiresReconciliation:true`로 끝남; 이후 같은 conflictKey `fenced`와 독립 `independent`(같은 target) enqueue | `fenced`는 state=`queued`로 대기하고 시작되지 않음; `independent`는 시작·`completed`; 시작 목록 `['installer','independent']`; unknown 작업 id를 다시 enqueue해도 state `unknown`이고 재실행 없음 | 시작 목록, 저장소 state | portal-app | test/operation-scheduler.test.mjs:43 | - |
| RC-B-189 | 스케줄러: 이전된 legacy unknown 33건이 허용·디스패치 용량을 소비하지 않음 | unknownBudget=32; 대기 작업 1건 + `importLegacy`로 state running 33건(같은 conflictKey `legacy-resource`)을 가져온 뒤 새 작업 enqueue; 핫패스의 `store.list`는 state/states 필터 없이 호출되면 실패 | snapshot.unknown=33; 가져온 job은 conflictKey가 비고 `legacy.original.conflictKey`에 원본 보존; 새 작업은 거절 없이 수락되고 선행 대기 작업 → 새 작업 순서로 실행; legacy id를 enqueue해도 `unknown` 유지(재실행 없음); 가져온 job·events는 불변 | 시작 목록, snapshot.unknown, job·events deepEqual | portal-app | test/operation-scheduler.test.mjs:54 | D-0017(후보) |
| RC-B-190 | 스케줄러: 살아있는 unknown은 공유 예산을 소진 | unknownBudget=2; legacy 33건 가져오기; `live-one`,`live-two`가 unknown(`cleanupComplete:false`)으로 종료; `still-queued`와 `over-live-budget` | snapshot.unknown=35(이력+라이브 합산 관측); `still-queued`는 `queued`로 대기(디스패치 중단); `over-live-budget` enqueue는 `OPERATION_RECONCILIATION_CAPACITY`, `accepted:false`이고 저장소에 없음(find=null); 시작 목록 `['live-one','live-two']` | 오류 코드·accepted 플래그, 저장 여부, 시작 목록 | portal-app | test/operation-scheduler.test.mjs:83 | D-0017(후보) |
| RC-B-191 | 스케줄러: 부분 legacy 표식은 live unknown 위험 면제를 주지 않음 | unknownBudget=1; live 작업에 (recoveryReason=`bridge_restart`+legacy.source 있음), (`legacy_import`+legacy.source=null), (`legacy_import`+legacy.original.id가 다른 값) 세 조합 각각 unknown으로 종료 후 다른 키 enqueue | 세 경우 모두 `OPERATION_RECONCILIATION_CAPACITY`, `accepted:false`, `blocked` 키 미저장, 시작 목록 `['live-marker']` | 조합별 오류 코드·저장 여부 | portal-app | test/operation-scheduler.test.mjs:102 | - |
| RC-B-192 | 스케줄러: 용량 축소 시 실행·수락 작업 보존과 과부하 거절 | globalConcurrency=2,targetConcurrency=2,queueCapacity=4; one,two 실행 중, three,four 대기; configure로 global=1,target=1,queueCapacity=1; overflow enqueue | 실행 중 작업의 signal은 abort 아님; overflow는 `OPERATION_QUEUE_FULL`, `accepted:false`, 저장 안 됨; one 종료 후에도 새 시작 없음(two가 아직 실행), two 종료 뒤 three 시작, four까지 순차 완료 | signal.aborted, 오류 코드, 시작 순서 | portal-app | test/operation-scheduler.test.mjs:117 | - |
| RC-B-193 | 스케줄러: 관찰 중단·시간 초과는 실행을 취소하지 않음, 대기 작업 명시 취소 | 실행 중 first 관찰을 AbortController로 중단; `timeoutMs:1` 관찰; queued를 cancel | 중단된 관찰은 `AbortError`로 거절되고 first의 signal.aborted=false; timeoutMs 1 관찰은 state `running` 반환; queued cancel은 `cancelled`이고 시작되지 않음(시작 목록 `['first']`) | 오류 이름, signal, state | portal-app | test/operation-scheduler.test.mjs:129 | - |
| RC-B-194 | 스케줄러: 실행 중 취소는 원격 정산 전까지 terminating | 실행 중 작업 cancel 후 executor가 `{failed:true, execution:{reason:'cancel', remoteState:'exited', cleanupComplete:true,...}}`로 반환 | cancel 직후 state=`terminating`, 실행 signal.aborted=true; 정산 뒤 observe 결과 state=`cancelled` | state 전이, signal | portal-app | test/operation-scheduler.test.mjs:139 | - |
| RC-B-195 | 스케줄러: 승인 단계 종료 전이가 관찰자를 깨우되 실행하지 않음 | store.accept된 작업을 observe 대기 중 transition `{state:'denied'}`(expectedVersion 지정) | 대기하던 observe가 state `denied`로 해소; executor 시작 0회 | observe 결과, 시작 목록 빈 배열 | portal-app | test/operation-scheduler.test.mjs:146 | - |
| RC-B-196 | 스케줄러: 대기 작업 만료 시 깨움, 점유 슬롯은 유지 | now 주입; `long` 실행 중, `expiring`(expiresAt=10) 대기, now=20 | expiring observe가 `expired`로 해소(timeoutMs 1000 이내); `long`은 계속 running, signal 미abort; 시작 목록 `['long']` | state, signal | portal-app | test/operation-scheduler.test.mjs:154 | - |
| RC-B-197 | 스케줄러: dispatch guard 중 만료되면 executor를 시작하지 않음 | `beforeDispatch`가 보류 중이어서 job state=`starting`; 그 사이 now가 expiresAt(10)을 지나고 guard 해제 | 최종 state `expired`; executor 시작 0회 | state, 시작 목록 빈 배열 | portal-app | test/operation-scheduler.test.mjs:163 | - |
| RC-B-198 | 스케줄러: 용량의 임의 상한 없음과 기본 위험 예산 | globalConcurrency=10001; configure globalConcurrency=20001,queueCapacity=50001; 이후 configure `unknownBudget:4, globalConcurrency:30001` | snapshot.globalConcurrency=10001, unknownBudget=10001(기본은 globalConcurrency 추종); 20001로 바꾸면 unknownBudget=20001; 명시한 unknownBudget=4는 global을 30001로 바꿔도 4 유지 | snapshot 값 | portal-app | test/operation-scheduler.test.mjs:172 | - |
| RC-B-199 | 스케줄러: guard 거절 작업은 디스패치되지 않고 알림 오류가 다음 작업을 막지 않음 | `beforeDispatch`가 requestKey `refused`에서 `policy changed`를 던짐; `onChange`는 항상 예외; refused, next를 enqueue | refused 최종 state `failed`, executor 미시작; next가 시작되어 `completed`; 시작 목록 `['next']` | state, 시작 목록 | portal-app | test/operation-scheduler.test.mjs:183 | - |
| RC-B-200 | 스케줄러: 재시작 시 대기 작업의 원 만료 검사와 실행 중 작업 재실행 금지 | 저장소에 queued `waiting`(expiresAt=100), claim된 `active`; 저장소 재오픈 후 now=101인 새 스케줄러 | waiting state `expired`; active state `unknown`; execute 호출 0회 | 저장소 state, effects 빈 배열 | portal-app | test/operation-scheduler.test.mjs:190 | - |
| RC-B-201 | operation 저장소: 동일 계약은 동일 identity, 변경은 충돌 | `accept(record('same'))` 후 원 객체의 input.command를 변경; 같은 계약 재accept; input 문자열 끝 공백 추가, owner=`other`, targetRevision=`rev2`, deadline=123 각각 재accept; 저장소 재오픈 | 저장본 input.command는 `printf ok` 유지(사본); 같은 계약은 같은 id; 변경 4종은 `OPERATION_KEY_CONFLICT`; 재오픈 후 `find('same').job.id` 동일; events state 목록 `['accepted']` | id 비교, 오류 코드, events | portal-store | test/operation-store.test.mjs:18 | - |
| RC-B-202 | operation 저장소: 낙관적 claim과 계약 불변 | accepted→queued(expectedVersion 1); expectedVersion 1로 claim(구버전), 올바른 version으로 claim 2회, 이전 version으로 update, 계약 필드(input, targetRevision, deadline, expiresAt) update | 구버전 claim=null; 올바른 claim은 state `starting`이며 즉시 영속; 같은 version 재claim=null; 옛 version update는 `OPERATION_VERSION_CONFLICT`; 계약 필드 변경 4종은 `OPERATION_CONTRACT_IMMUTABLE` | claim 반환, state, 오류 코드 | portal-store | test/operation-store.test.mjs:30 | - |
| RC-B-203 | operation 저장소: 재시작 시 queued 계약 보존, dispatch된 시도는 unknown | queued 작업(deadline 10000, policyRevision 7, approval {mode:'owner'})와 claim된 `active`; 저장소 재오픈 후 recover() | recover 결과는 active id만; queued 작업은 재시작 전과 deepEqual; active state `unknown`, claim=null; 두 번째 recover()는 빈 배열 | recover 목록, job deepEqual, state | portal-store | test/operation-store.test.mjs:44 | - |
| RC-B-204 | operation 저장소: typed 원격 증거로만 종료 상태 결정 | claim된 작업에 outcome: (정상 exit `exitCode:0`), (`{failed:false}` 증거 없음), (`remoteState:'unknown', requiresReconciliation:true`), (`failed:false`이나 `cleanupComplete:false`) | 각각 state `completed`, `unknown`, `unknown`, `unknown` | outcome 반환 state | portal-store | test/operation-store.test.mjs:59 | - |
| RC-B-205 | legacy 이력 가져오기: 원 identity·증거·출력 보존, 과거 queued 실행 금지 | `importLegacy`로 completed 행(id `old-completed`, createdAt 100, finishedAt 200, result.texts)을 source `commands`, requestKey `old-key`, digest `old-digest`로 가져오기; 같은 호출 반복; state만 `failed`로 바꿔 반복; queued 행을 source `cli`로 가져오기 | 상태 `completed`, 원 id 유지, `legacy.original` 원본 deepEqual, outputRef `{requestId:'old-completed'}`; 동일 재가져오기는 동일 결과(멱등); 내용 다른 재가져오기는 `OPERATION_KEY_CONFLICT`; 가져온 queued는 state `unknown`이고 claim=null | 반환 deepEqual, 오류 코드, claim | portal-migrate / portal-store | test/operation-store.test.mjs:69 | D-0016(후보), D-0018(후보) |
| RC-B-206 | operation 저장소: 명시 conflictKey 직렬화와 target revision별 격리 | conflictKey=`installer` 작업 first, second, revised(targetRevision `rev2`), conflictKey=`independent` 작업 other; first를 claim 후 `{failed:true}`로 종료 | first claim 성공 동안 second claim=null; first가 실패 종료해도 second claim=null(격리); other와 revised(다른 revision)는 claim 성공 | claim 반환값 | portal-store | test/operation-store.test.mjs:82 | - |
| RC-B-207 | operation 저장소: unknown 예산과 journal 용량 명시 거절 | `maxRows:3`, 작업 3건 queued; limits unknownBudget=1; 첫 claim 후 `{failed:false}` 종료; 새 record 추가 | 첫 claim 성공, 두 번째 claim=null(활성 시도가 예산 점유); 증거 없는 종료 뒤에도 두 번째 claim=null; 4번째 accept는 `OPERATION_CAPACITY`이고 `find('overflow')=null` | claim 반환값, 오류 코드, 저장 여부 | portal-store | test/operation-store.test.mjs:93 | - |
| RC-B-208 | watch CLI: 이미 완료된 operation은 업로드 없이 종료 코드 0 | 인자 `--origin https://owner.example.test watch {48자 id}`, watcher가 `{event:'operation.finished',id,state:'completed',failed:false,auditFailure:false}` 반환; 업로드 클라이언트는 호출 시 실패 | 종료 코드 0, stdout JSON이 이벤트와 deepEqual | 종료 코드, stdout | portal-client | test/operation-watch-cli.test.mjs:10 | - |
| RC-B-209 | watch CLI: 모델 입력 밖에서 대기하고 최종 이벤트 1회 출력 | watch가 완료까지 보류; 보류 중 독립 작업 수행 | 대기 중 연결은 완료되나 stdout 비어 있음; 완료 뒤 종료 코드 0, stdout은 이벤트 JSON 정확히 1줄; stderr의 JSON event=`operation.watch.started`; watcher 옵션 origin 일치, timeoutMs=600000; close 1회; 업로드 클라이언트 미사용 | stdout/stderr, 옵션, close 횟수 | portal-client | test/operation-watch-cli.test.mjs:17 | - |
| RC-B-210 | watch CLI: 실패·불확실 종료 상태는 종료 코드 1, 재실행 없음 | watcher가 state `failed`,`denied`,`cancelled`,`expired`,`unknown`(failed:true)을 반환 | 각각 종료 코드 1, stdout JSON의 state가 입력 상태와 같음, watch 읽기 1회, close 1회 | 종료 코드, state, 호출 횟수 | portal-client | test/operation-watch-cli.test.mjs:37 | - |
| RC-B-211 | watch CLI: 잘못된 id·deadline은 인증 전에 거절 | id 끝에 `\n`, `--timeout-ms 600001`, `--timeout-ms '100\n'` | 종료 코드 1, stdout 비어 있음, stderr JSON error가 `INVALID_`로 시작; 자격 증명 읽기·소유자 연결 0회 | 종료 코드, error 접두, 호출 0 | portal-client | test/operation-watch-cli.test.mjs:46 | - |
| RC-B-212 | watch CLI: 읽기 실패는 원 ID 보존, 세션 종료 | watch가 `OWNER_REAUTH_REQUIRED` 코드 오류(메시지 `private not printed`)를 던짐 | 종료 코드 1, stdout 비어 있음, close 1회; stderr 마지막 줄 `{error:'OWNER_REAUTH_REQUIRED', requestId:id}`; 내부 메시지·토큰 미노출 | stderr JSON, 비노출 정규식 | portal-client | test/operation-watch-cli.test.mjs:55 | - |
| RC-B-213 | watch CLI: key 관찰의 selector 결속과 기본 deadline | `--operation-key cli-watch-stable-key-0001 --target alpha --expected-target-revision {64자}` | watcher selector는 정확히 `{operationKey,target:'alpha',expectedTargetRevision}`; timeoutMs=600000; stderr `{event:'operation.watch.started',operationKey,timeoutMs:600000}`; stdout id는 학습한 operation id; 종료 코드 0 | selector deepEqual, stderr, stdout | portal-client | test/operation-watch-cli.test.mjs:98 | - |
| RC-B-214 | watch CLI: key와 ID 배타, 형식 오류는 인증 전 거절 | key+ID 동시, key `short`, key 끝 `\n`, `--target`만, `--expected-target-revision`만, target `Alpha`(대문자), revision 끝 `\n` | 7종 모두 종료 코드 1, stdout 비어 있음, error가 `INVALID_`로 시작; 자격 증명·연결 0회 | 종료 코드, error 접두 | portal-client | test/operation-watch-cli.test.mjs:110 | - |
| RC-B-215 | watch CLI: key 관찰 오류는 key와 학습한 ID를 보존 | watch가 `OPERATION_BINDING_CONFLICT` 코드와 requestId=id로 던짐 | 종료 코드 1, stderr 마지막 줄 `{error:'OPERATION_BINDING_CONFLICT', requestId:id, operationKey:key}`, stdout 비어 있음, close 1회 | stderr JSON | portal-client | test/operation-watch-cli.test.mjs:122 | - |
| RC-B-216 | watch CLI: ID 관찰도 expected target 결속 전달 | `watch {id} --target alpha --expected-target-revision {64자}` | watcher selector `{id,target:'alpha',expectedTargetRevision}`; 종료 코드 0 | selector deepEqual | portal-client | test/operation-watch-cli.test.mjs:130 | - |
| RC-B-217 | watcher: 이미 완료된 작업은 출력·명령 노출 없는 제한 이벤트 1건 | connect → `{connected:true,mode:'access'}`; 응답에 command, internalPath, output.text, result.texts, accessToken, unexpected 필드가 프라이빗 마커로 포함된 completed operation; watch(id) | 이벤트는 정확히 `{event:'operation.finished',id,state:'completed',targetId:'alpha',targetRevision,finishedAt:123,failed:false,auditFailure:false,failureCode:null,exitCode:0,reason:'exit',remoteOutcome:'completed',outputState:'ready'}`; 마커·토큰 미포함; 읽기 1회; close 시 logout 1회; GET 외 변경 호출 없음(세션 start/logout 제외); 요청은 redirect=error, 세션 쿠키 결속 | 이벤트 deepEqual, JSON 문자열 비포함, 호출 목록 | portal-client | test/operation-watcher.test.mjs:66 | - |
| RC-B-218 | watcher: 대기 중 longpoll은 독립 작업을 막지 않고 완료 시 1회만 해소 | 첫 읽기 pending, 두 번째 읽기가 보류 후 completed; 요청 쿼리는 `?observe=1&waitMs=25000` | 보류 동안 promise 미해소(settled=false), 독립 작업 완료 가능; 해제 후 completed 이벤트; 읽기 정확히 2회(종료 뒤 추가 읽기 없음); 변경 호출 없음 | settled 플래그, 읽기 횟수, 이벤트 | portal-client | test/operation-watcher.test.mjs:78 | - |
| RC-B-219 | watcher: failed·denied·unknown·cancelled·expired는 서로 구별되는 종료 결과 | 각 state에 failed:true, auditFailure:true, failureCode `SYNTHETIC_FAILURE`, remoteOutcome(unknown이면 `unknown` 아니면 `not_started`), execution(failed면 exitCode 7 아니면 null, cancelled면 reason `cancel` 아니면 `transport_lost`), output.state=`unavailable` | 이벤트가 state·failed:true·auditFailure:true·failureCode·remoteOutcome·exitCode·reason·outputState `unavailable`을 그대로 반영; 읽기 1회; 변경 호출 없음 | 이벤트 deepEqual(5상태) | portal-client | test/operation-watcher.test.mjs:94 | - |
| RC-B-220 | watcher: 외부 ID·잘못된 상태·계약 위반·거절은 요청 ID를 유지한 typed 오류 | 응답 변형: 다른 id(`c`x48), state `apparently_done`, contractVersion `1.0`, data null(+private 필드), `{ok:false,error:{code:'TARGET_REVISION_CONFLICT',detail:private}}` | 모두 reject; error.code는 `^[A-Z][A-Z0-9_]+$`, error.requestId=요청 id; 오류 문자열·JSON에 프라이빗 마커·액세스 토큰 미포함; 읽기 1회; 변경 호출 없음 | error.code 형식, requestId, 비노출 | portal-client | test/operation-watcher.test.mjs:106 | - |
| RC-B-221 | watcher: 초기 상태 뒤 target·revision이 바뀌면 완료를 낳지 않음 | 첫 읽기 pending, 두 번째 completed이나 targetId=`beta` 또는 targetRevision 변경 | watch가 typed 오류로 reject(requestId 유지, 마커 미노출); 읽기 2회; 변경 호출 없음 | reject, 읽기 횟수 | portal-client | test/operation-watcher.test.mjs:121 | - |
| RC-B-222 | watcher: 인증 거절·전송 실패의 typed 오류, 재시도 없음 | 읽기 응답 HTTP 401, 409(본문 error 프라이빗), 전송 예외(메시지에 마커+토큰) | 각각 code `OWNER_REAUTH_REQUIRED`, `PORTAL_REQUEST_REFUSED`, `PORTAL_READ_FAILED`; requestId 유지; 마커·토큰 미노출; 읽기 1회(재시도 없음) | error.code, 비노출, 읽기 횟수 | portal-client | test/operation-watcher.test.mjs:129 | - |
| RC-B-223 | watcher: close는 로컬 읽기만 중단하고 logout, 원격 작업 취소 없음 | 읽기가 abort까지 보류된 상태에서 close(); 이후 다시 watch | 보류 watch는 typed 오류로 reject; logout 1회; 변경 호출 없음; close 뒤 watch는 reject하고 추가 읽기 없음(읽기 총 1회) | reject, logout 횟수, 읽기 횟수 | portal-client | test/operation-watcher.test.mjs:140 | - |
| RC-B-224 | watcher: 외부 abort는 관찰만 멈추고 ID 보존, 원격 취소 없음 | watcher 생성 시 외부 AbortSignal 전달, 읽기 보류 중 abort | watch는 typed 오류로 reject(requestId 유지); 읽기 1회; 변경 호출 없음 | reject, 호출 목록 | portal-client | test/operation-watcher.test.mjs:149 | - |
| RC-B-225 | watcher: 잘못된 operation ID는 읽기 전에 거절 | watch(`bad`), `../api/requests`, id+`\n`, 대문자 48자 | 모두 reject, error.code는 문자열; operation 읽기 0회; 변경 호출 없음 | reject, 읽기 0 | portal-client | test/operation-watcher.test.mjs:158 | - |
| RC-B-226 | watcher: key만으로 관찰하며 반환 ID에 결속, unknown 보존 | `watch({operationKey,target:'alpha',expectedTargetRevision})`; 쿼리 `/api/operations/by-key?operationKey={인코딩}&waitMs=25000`; 첫 pending, 둘째 state `unknown`(failed:null, remoteOutcome `unknown`) | 이벤트에 operationKey 포함, state `unknown`, failed:null, remoteOutcome `unknown`; by-key 읽기 2회; 변경 호출 없음 | 이벤트 deepEqual, 호출 횟수 | portal-client | test/operation-watcher.test.mjs:174 | - |
| RC-B-227 | watcher: key 조회 시 key·ID·target·revision 변경·부재 거절 | 첫 pending 뒤 두 번째 completed 응답에서 operationKey 누락, 다른 operationKey, 다른 id, targetId `beta`, 다른 targetRevision 각각 | 5종 모두 typed 오류로 reject(requestId 유지, 마커 미노출); 변경 호출 없음 | reject 5종 | portal-client | test/operation-watcher.test.mjs:183 | - |
| RC-B-228 | watcher: 첫 종료 응답에도 expected target 결속 강제 | 첫 응답이 곧 completed; binding (target `beta`+올바른 revision) 또는 (target `alpha`+다른 revision) | 두 경우 code `OPERATION_BINDING_CONFLICT`로 reject(requestId 유지); 변경 호출 없음 | error.code | portal-client | test/operation-watcher.test.mjs:192 | - |
| RC-B-229 | watcher: 잘못된 selector·불완전 결속은 읽기 전 거절 | selector `{}`, operationKey `short`, key+`\n`, key+id 동시, key+target만, key+expectedTargetRevision만, null, `[]` | 8종 모두 reject, error.code `^INVALID_`; operation 읽기 0회 | error.code 접두, 읽기 0 | portal-client | test/operation-watcher.test.mjs:201 | - |
| RC-B-230 | watcher: 없는 key는 거절이며 대체 제출 없음 | by-key 응답 404 `{error:'OPERATION_NOT_FOUND'}` | reject: code `PORTAL_REQUEST_REFUSED`, serverCode `OPERATION_NOT_FOUND`, operationKey 보존, requestId undefined; by-key 읽기 1회; 변경 호출 없음 | error 필드, 호출 목록 | portal-client | test/operation-watcher.test.mjs:210 | - |
| RC-B-231 | watcher: ID 객체 selector도 첫 응답에서 expected 결속 강제 | `watch({id,target:'alpha',expectedTargetRevision})`이 성공한 뒤 `target:'beta'`로 재시도 | 첫 호출은 기본 completed 이벤트; 두 번째는 code `OPERATION_BINDING_CONFLICT` reject; 변경 호출 없음 | 이벤트, error.code | portal-client | test/operation-watcher.test.mjs:220 | - |
| RC-B-232 | watcher: requireInitialNonTerminal은 첫 폴에서 종료일 때만 alreadySettledOnFirstPoll 표시 | (a) 첫 응답이 completed (b) 첫 running 뒤 completed, 둘 다 `{id,requireInitialNonTerminal:true}` | (a) 이벤트에 `alreadySettledOnFirstPoll:true` 포함; (b) 해당 필드 없는 기본 completed 이벤트 | 이벤트 deepEqual | portal-client | test/operation-watcher.test.mjs:227 | - |
| RC-B-233 | operations 서비스: 같은 key 병렬 submit은 하나의 identity와 하나의 승인·실행 admission | 같은 operationKey·같은 command의 submit 2개를 admission 보류 중 연속 호출 후 해제, 이후 세 번째 submit | admission 포트 호출 1회, 보류 중 journal usage.count=0; 두 결과 id 동일, journal.find(key).job.id 일치, usage.count=1, queue.jobs.size=1, 실행 효과 1회; 세 번째 submit도 같은 id, admission 1회 유지 | id, 카운터 | portal-app | test/operations-180.test.mjs:66 | - |
| RC-B-234 | operations 서비스: 대기 후 target revision 재검사 | 실행 보류 중 observe `{id, waitMs:1000}`의 대기 경계를 보류하고 그 사이 target.revision을 바꾼 뒤 해제 | observe가 `TARGET_REVISION_CONFLICT`로 reject(상태를 전달하지 않음) | reject 코드 | portal-app | test/operations-180.test.mjs:77 | - |
| RC-B-235 | operations 서비스: 진행 중 key의 변경 바이트는 두 번째 포트 호출 전에 거절, 독립 key는 진행 | key A가 admission에서 보류 중 같은 key에 command만 `printf changed`로 submit; 독립 key B submit | 변경 submit은 `OPERATION_KEY_CONFLICT`; B는 정상 수락(operationKey 일치), admission 호출은 총 2회; A 해제 후 실행 효과 2회 | 오류 코드, admission·effects 수 | portal-app | test/operations-180.test.mjs:88 | - |
| RC-B-236 | operations 서비스: source·download admission도 같은 key guard, 가변 인자 스냅샷 | source submit(argv `['original']`)과 구조 복제본 동시 submit 후 원본 argv[0]을 변경; download(`/tmp/report.txt`) 동시 2회 | source 두 결과 id 동일, 저장된 `input.operation.argv`는 `['original']`; download 두 결과 id 동일이고 download admission 1회 | id, 저장 argv, admission 수 | portal-app | test/operations-180.test.mjs:98 | - |
| RC-B-237 | operations 서비스: download context 검증·보존과 key 결속 | download submit에 context=`Read the authorized test fixture.`, displayContext=`승인된 시험 파일을 내려받습니다.`, expectedTargetRevision 있음/없음 두 변형; 동일 재submit; context만 바꿔 재submit; context=`password=synthetic-private-marker` submit | 저장 input.operation에 context·displayContext 원문 보존, journal targetRevision=현재 target revision; 동일 재submit은 같은 id; 변경 context는 `OPERATION_KEY_CONFLICT`; 비밀 context는 `COMMAND_CONTEXT_CONTAINS_SECRET`으로 거절되고 journal 건수 불변 | 저장값, 오류 코드, count | portal-app | test/operations-180.test.mjs:110 | - |
| RC-B-238 | operations 서비스: 실패한 admission은 key를 해제, 수락된 작업은 재실행 안 함 | 첫 admission이 `PRE_ADMISSION_REFUSAL` 오류, 이후 같은 key 재submit | 첫 submit은 해당 코드로 reject, journal.find(key)=null, 효과 0; 재submit은 수락되어 journal.find(key).job.id==accepted.id, 효과 1회 | 오류 코드, find, effects | portal-app | test/operations-180.test.mjs:128 | - |
| RC-B-239 | operations 서비스: 다른 journal identity를 반환한 포트는 이 key를 확정 못함 | commands 포트가 `{type:'job',job:{id:'unrelated'}}` 반환; journal에는 id `unrelated`(requestKey 다름)가 이미 존재 | submit이 `OPERATION_KEY_CONFLICT`로 reject; journal.find(요청 key)=null; 효과 0 | 오류 코드, find, effects | portal-app | test/operations-180.test.mjs:137 | - |
| RC-B-240 | operations 서비스: 출력은 명시 요청 시만 읽고 target·revision·execution 결속 검증 | 완료 operation에 observe(기본), observe `{includeOutput:true,cursor:2,maxBytes:128}`, 출력 binding의 executionId를 `wrong-execution`으로 바꾼 observe, target.revision 변경 후 observe와 cancel | 기본 observe는 outputPage undefined, 출력 읽기 0회; 명시 요청은 outputPage.text=`redacted output`이고 읽기 인자 offsetBytes=2, maxBytes=128; 잘못된 binding은 `OUTPUT_BINDING_CONFLICT`; revision 변경 뒤 observe·cancel 모두 `TARGET_REVISION_CONFLICT` | outputPage, 읽기 인자, 오류 코드 | portal-app | test/operations-180.test.mjs:145 | - |
| RC-B-241 | operations 서비스: cancel은 원 operation을 대상으로 하며 대체 제출 없음 | 실행 보류 중 operation에 cancel | state `terminating`, 실행 signal.aborted=true, admission 총 1회; 해제 뒤 journal usage.count=1, 효과 1회 | state, signal, 카운터 | portal-app | test/operations-180.test.mjs:159 | - |
| RC-B-242 | operations 서비스: 기본 observe는 보류된 실행을 기다리지 않고 running 반환 | 실행이 보류된 operation에 `observe({id})`를 1000ms 타이머와 경주 | 타이머 전에 반환, result.job.id 일치, result.job.state=`running`, 효과 1회 | 반환 state, 타임아웃 미발생 | portal-app | test/operations-180.test.mjs:169 | D-0033(후보) |
| RC-B-243 | 클라이언트 guarded save: 고정 바이트·operation 불일치는 ticket 전 거절 | save(jobId,dest,expected)에서 expected의 size=0, sha256 `0`x64, target `other`, targetRevision `0`x64, remotePath `/tmp/other`, elevate=true 각각 | 6종 모두 `DOWNLOAD_EXPECTATION_MISMATCH`; ticket·다운로드 POST 등 파일 효과 0; 대상 파일 미생성(ENOENT) | 오류 코드, POST 목록, 파일 부재 | portal-client | test/portal-client-bound-files.test.mjs:35 | - |
| RC-B-244 | 클라이언트 guarded save: 정확한 바이너리·빈 파일 허용, 기존 호출 호환 | 바이트 `[0,255,17]`와 빈 파일 각각 expected 지정/미지정 save | 모두 state `saved`, sha256 일치, 저장 파일 바이트 동일 | 반환 state·sha256, 파일 내용 | portal-client | test/portal-client-bound-files.test.mjs:41 | - |
| RC-B-245 | 클라이언트 guarded save: 형식이 잘못된 expectation은 HTTP 전 거절 | expected로 null, `{}`, 추가 필드 `extra`, targetRevision `invalid`, size -1, remotePath `/tmp/../x` | 모두 `INVALID_DOWNLOAD_EXPECTATION`; HTTP 호출 수 불변 | 오류 코드, 호출 수 | portal-client | test/portal-client-bound-files.test.mjs:46 | - |
| RC-B-246 | 클라이언트 guarded save: 복사된 expectation도 자체 metadata 읽기에 결속 | 호출자가 넘긴 expectation(sha256 `0`x64)이 metadata 읽기 시점에 올바른 값으로 덮어써지는 조작 | `DOWNLOAD_EXPECTATION_MISMATCH`로 reject(호출 시점 값으로 판정), 파일 효과 0 | 오류 코드, POST 목록 | portal-client | test/portal-client-bound-files.test.mjs:51 | - |
| RC-B-247 | 클라이언트 bound resume: 원 revision·바이트로 같은 transfer ID 재개 | resumeUpload(transferId, source, uploadIntent{target,expectedTargetRevision,remotePath,elevate:false,overwrite:false}, {size,sha256}) | 결과 operation.artifactId=transferId, fileTargetRevision=원 revision; 새 업로드 생성(`POST /api/files/uploads`) 없음; 파일 효과 POST 정확히 2건(chunk, finish) | 반환 필드, 호출 목록 | portal-client | test/portal-client-bound-files.test.mjs:55 | - |
| RC-B-248 | 클라이언트 bound resume: 현재 epoch·기록된 결속 불일치는 변경 없이 거절 | (listed target revision이 `0`x64로 변경), (transfer 기록 targetRevision 변경), (기록이 transfer 없이 job.operation.fileTargetRevision `0`x64) 각각 resume | 3종 모두 `RESUME_INTENT_MISMATCH`; 파일 효과 POST 0 | 오류 코드, POST 목록 | portal-client | test/portal-client-bound-files.test.mjs:59 | - |
| RC-B-249 | 클라이언트 resume: 기존 호출에서도 선언된 원본 바이트를 chunk 전에 검사 | intent는 `{remotePath}`만; 선언 `{size:0, sha256:빈 바이트 해시}`이나 실제 원본은 3바이트 | `RESUME_SOURCE_MISMATCH`로 reject; 파일 효과 POST 0 | 오류 코드, POST 목록 | portal-client | test/portal-client-bound-files.test.mjs:67 | - |
| RC-B-251 | 클라이언트 CLI: 잘못된 origin·경로·옵션은 자격 증명·포털 접근 전 거절 | origin `http://...`(비 HTTPS), `targets --confirm`, `status bad-id`, `transfer`(47자 id), `approve`/`deny` 하위 명령, 상대 경로 upload/save/resume-upload, `request-download /home/../bad.bin`, `--target bad!`, NUL 포함 경로 (win32: `:stream` 대체 스트림 경로) | 모두 종료 코드 1, stdout 비어 있음, 자격 증명 접근 0회, 포털 HTTP 요청 0건. (원 시험의 `--cloudflared` 모드 미지정·모드 중복·상대 경로·`con.exe` 입력은 cloudflared 제거(사용자 결정 5)로 이식하지 않음) | 종료 코드, stdout, 요청 수 | portal-client | test/portal-client-cloudflared.test.mjs:80 | - |
| RC-B-253 | 클라이언트 CLI: 대기 중 명령 status는 pending 유지, 승인 변경 없음 | `status {id}` 응답 `{id,state:'pending'}` | 종료 코드 0, stdout state=`pending`, `/approve`·`/deny` 요청 0건 | 종료 코드, state, 요청 목록 | portal-client | test/portal-client-cloudflared.test.mjs:130 | - |
| RC-B-254 | 클라이언트 CLI: 업로드 응답 유실 시 같은 transferId 보존, begin·chunk 재전송 없음 | upload 시작은 `{transferId}` 응답, 첫 chunk 호출이 전송 예외(메시지에 토큰) | 종료 코드 1, stderr 마지막 줄 `{error:'UPLOAD_RESULT_UNKNOWN', transferId}`; `/api/files/uploads` 1회, chunk 1회, finish 없음; 토큰 미노출 | stderr JSON, 요청 횟수 | portal-client | test/portal-client-cloudflared.test.mjs:137 | - |
| RC-B-255 | 클라이언트 CLI: 업로드 바이트 보존과 pending ACK | 바이트 `[0,1,2,127,128,255,10]`, 한글 경로 원본; begin 본문 sha256=digest, chunk 본문 base64 복호 바이트 동일, finish 응답 state `pending` | 종료 코드 0, stdout state `pending`, finish 1회, `/approve` 요청 없음 | 요청 본문, 종료 코드 | portal-client | test/portal-client-cloudflared.test.mjs:152 | - |
| RC-B-256 | 클라이언트 CLI: save는 배타적 로컬 쓰기와 바이트·해시 검증 뒤에만 saved 보고 | completed 다운로드 job metadata(artifactId,size,sha256), `/api/{id}/download`가 `/downloads/{id}/{32자}?ticket=` URL 반환, 한글 대상 경로 | 종료 코드 0, stdout state=`saved`, sha256=metadata와 동일, 저장 파일 바이트 동일, 자격 증명 비노출 | 반환 JSON, 파일 내용 | portal-client | test/portal-client-cloudflared.test.mjs:165 | - |
| RC-B-257 | 클라이언트 CLI: output과 source-bound upload 옵션 혼용 거절 | `output {id}`에 `--expect-size`/`--expect-sha256`(단독·동시·`--help` 동반), upload에 `--offset`, `--limit 4096`, `--format text`(·`--help` 동반); 자격 증명 모드 두 가지 각각 | 모두 종료 코드 1, stdout 비어 있음, stderr JSON error는 `INVALID_UPLOAD_EXPECTATION` 또는 `CLI_REQUEST_FAILED`; 원본 경로가 stderr에 없음; 자격 증명 읽기·외부 도구·HTTP 0회 | 종료 코드, error 값, 호출 0 | portal-client | test/portal-client-combined.test.mjs:6 | - |
| RC-B-261 | 클라이언트 targets 응답 검증: 잘못되거나 과대한 응답은 ready 불가(Access 자격 증명·cloudflared 단계는 이식하지 않고 응답 검증만 유지; 메인 판정 5) | targets 응답이 undefined, `{}`, `[{id:'bad!',enabled:true}]`, `[{id:'default'}]`, `[null]`, 257개 배열 | 모두 state `blocked`, 마지막 check `{stage:'targets',state:'blocked',error:'INVALID_PORTAL_RESPONSE'}`; 호출 순서 `open,connect,targets,close`(3.0 연결 단계는 기기 등록 토큰 연결로 대응) | check deepEqual, 호출 순서 | portal-client | test/portal-client-discovery.test.mjs:231 | - |

### G04 (원자료 1468~1569: portal-client-output ~ read-command-refusals, mjs 102행)

| 사례 ID | 대상 기능 | 입력·조건 | 기대 결과 | 판정 방법 | 3.0 모듈 | 원 시험 | 연결 결함 |
|---|---|---|---|---|---|---|---|
| RC-B-271 | PC 클라이언트 `output` 명령: 저장 출력 전체 읽기 | 완료된 command 작업(id 48자), output ref `ready`(스냅샷 JSON `{failed:false,texts:['한글🙂\n']}`, ref.sha256은 JSON 스냅샷 해시). `output <id> --format text`, `output <id> --format json` 각각 실행. 서버 page 응답에는 알 수 없는 필드 `unexpectedPrivateField`(토큰 값)가 섞여 있음 | 각 호출 exit 0. text 형식은 `text`='한글🙂\n', json 형식은 `text`=스냅샷 JSON 문자열. `outputId`·`executionId` 일치, `bytes`=UTF-8 바이트 수, `sha256`=해당 형식 전체 본문의 SHA-256, `wholeSha256Verified=true`, `sshCompleteness='unknown'`. 인증(토큰 읽기) 호출 호출당 1회. ref.sha256은 text 본문 해시와 다름(JSON 스냅샷 해시). 서버로 간 page 요청 2건, 비-GET 변경 요청(session start/logout 제외) 0건. stdout·stderr에 토큰 없음 | 반환 JSON 필드 값 assert, page 요청 수·변경 요청 수 집계, 출력에 토큰 문자열 부재 | portal-client | test/portal-client-output.test.mjs:51 | SSH_PORTAL-D-0036(후보) |
| RC-B-272 | `output` 명령: UTF-8 페이지 커서와 부분 형식 전체 해시 미주장 | `output <id> --limit 7`, 서버가 첫 페이지로 '한글'(6바이트) 반환 | exit 0, `text`='한글', `bytes`=6, `nextOffset`=6, `eof=false`, `wholeSha256Verified=false`(부분 페이지는 전체 해시 검증을 주장하지 않음). page 요청 1건, 변경 요청 0건 | 반환 값 assert, 요청 수 집계 | portal-client | test/portal-client-output.test.mjs:64 | - |
| RC-B-273 | `output` 명령: 후속 페이지와 빈 실패 출력 | (a) `output <id> --offset 6 --limit 7`, 서버가 '🙂\n' 반환. (b) 작업 state `failed`, ref.bytes=0, page text '' totalBytes 0 sha256=SHA-256('') 이고 `--access-token-stdin` 방식으로 호출 | (a) exit 0, `nextOffset`=11, `eof=true`, `wholeSha256Verified=false`. (b) exit 0, `text`='', `wholeSha256Verified=true`, 외부 토큰 헬퍼 호출 0회(stdin 입력만 사용), 변경 요청 0건(재실행 없음) | 반환 값 assert, 헬퍼 호출 카운터, 변경 요청 집계 | portal-client | test/portal-client-output.test.mjs:71 | - |
| RC-B-274 | `output` 명령·내장 클라이언트: 잘못된 식별자·범위·형식·옵션은 인증 전에 거절 | CLI 인자: `output bad`, `--offset -1`, `--offset 1.5`, `--offset ''`, `--offset 9007199254740992`, `--limit 3`, `--limit OUTPUT_PAGE_BYTES+1`, `--format yaml`, `--confirm`, `--target default`, `--help`, `status <id> --offset 0`. 내장 클라이언트 `client.output(id, options)`에 options = null, [], {offsetBytes:-1}, {maxBytes:3}, {format:'yaml'}, {extra:true} | CLI: 모두 exit 1, stdout 빈 문자열, 인증 호출 0회, HTTP 요청 0건. 내장 클라이언트: 모두 `INVALID_OUTPUT_OPTIONS`로 거절, `/api/outputs/*` 요청 0건이고 작업 조회(`/api/<id>`)도 0건 | exit 코드·stdout·호출 수 assert, 오류 code assert | portal-client | test/portal-client-output.test.mjs:80, test/portal-client-output.test.mjs:118 | - |
| RC-B-275 | `output` 명령: 준비되지 않았거나 낡았거나 불일치한 출력 참조는 본문을 가져오지 않음 | 작업/ref 변형 12종: job.state `pending`/`denied`/`unknown`, job.kind `upload`, ref.executionId 다른 값, ref.id 'bad', ref.state `expired`, ref.expiresAt 1, ref.version 2, ref.captureSource `raw-ssh`, ref.snapshotBytes -1, ref.sha256 배열 | 모두 exit 1, stdout 빈 문자열, `/api/outputs/*` page 요청 0건, 변경 요청 0건. stderr JSON의 `requestId`=작업 id | exit 코드·요청 수·stderr JSON assert | portal-client | test/portal-client-output.test.mjs:90 | - |
| RC-B-276 | `output` 명령: 형식 오류·타 작업 소속·불일치 page는 본문 거절하고 검증된 ID 유지 | page 변형 14종: outputId 다름, executionId 다름, format 'json'(text 요청에), offsetBytes 1, bytes 1, nextOffset 1, totalBytes 100, eof false, expiresAt 1, sha256 '0'×64, text 'REFUSED_BODY_MUST_NOT_ESCAPE', text '\ud800'(짝 없는 서로게이트), version 2, sshCompleteness 'complete'. 추가: `--limit 7`, 부분 페이지 '한글', page.sha256이 문자열이 아니라 배열 | 모두 exit 1, stdout 빈 문자열, stderr에 'REFUSED_BODY_MUST_NOT_ESCAPE' 없음, stderr JSON `requestId`=작업 id·`outputId`=ref id 유지, page 요청 정확히 1건, 변경 요청 0건. 부분 페이지의 해시 값이 문자열이 아니면 전체 해시를 계산할 수 없어도 본문 거절 | 반환 코드·stderr JSON·요청 수 assert | portal-client | test/portal-client-output.test.mjs:100, test/portal-client-output.test.mjs:129 | - |
| RC-B-277 | `output` 명령: 세션 철회·거절·읽기 실패는 공개 오류만 노출하고 재시도 안 함 | page 요청 응답을 HTTP 401, HTTP 409, 네트워크 예외(메시지에 토큰·본문 문구 포함)로 바꿈 | 각각 exit 1, stdout 빈 문자열, stderr에 본문 문구('REFUSED_BODY_MUST_NOT_ESCAPE')와 토큰 없음, page 요청 정확히 1건(재시도 없음), 변경 요청 0건, stderr JSON `requestId`·`outputId` 유지 | exit 코드·stderr 내용·요청 수 assert | portal-client | test/portal-client-output.test.mjs:110 | - |
| RC-B-278 | PC 클라이언트 프로세스: 검증된 TLS·비공개 stdin 입력으로 승인과 정확한 로컬 파일 왕복 | 실제 클라이언트 프로세스를 자식 프로세스로 기동(자체 서명 CA는 자식 프로세스에만 신뢰 등록, TLS 우회 금지), 토큰은 stdin으로만 전달. 순서: `targets` → `upload`(CHUNK_BYTES+9 바이트, i%251 패턴, 한글 파일명) → `transfer <artifactId>` → `pending` → `approve`(--confirm 없음) → `approve --confirm` ×2 → `request-download` → `save`(승인 전) → 승인 → `status` → `save` ×2 → 빈 파일 업로드/다운로드 → `deny` | `targets.defaultTarget='default'`. upload: state `pending`, operation.sha256=원본 해시, 원격 효과 []. `transfer`가 upload job id 반환, `pending`에 id 포함. `approve`(확인 없음) exit 1이며 stderr에 `EXPLICIT_OWNER_DECISION_REQUIRED`, 효과 []. `--confirm` 승인 시 state `completed`, 원격 바이트=원본, 효과 ['upload']. 같은 승인 재호출은 `completed`를 반환하되 서버 `/approve` 호출 수 불변. request-download state `pending`, 승인 전 `save`는 exit 1이고 효과 불변. 승인 후 효과 ['upload','download'], `status` `completed`, `save`는 state `saved`·sha256 일치·파일 바이트 일치. 같은 경로 재저장은 exit 1, stderr에 `EEXIST`, 파일 불변, 효과 불변. 빈 파일 업로드·다운로드 sha256=SHA-256(빈값), 저장 파일 길이 0. `deny --confirm`은 `denied`, 효과 목록에 추가 없음(upload·download 각 2회). 다른 세션 쿠키로 `/api/pending`이 200. stdout·stderr 어디에도 토큰·`__Host-ssh_admin_session=`·`ticket=` 없음 | 자식 프로세스 exit 코드·JSON stdout·stderr 문자열, 원격 저장소 바이트, 효과 목록, 승인 호출 수 | portal-client | test/portal-client-process.test.mjs:130 | - |
| RC-B-279 | PC 클라이언트 프로세스: 미신뢰 TLS·소유자 아닌 신원 거절 | (a) CA를 신뢰하지 않은 자식 프로세스로 `targets`. (b) 소유자가 아닌 신원의 토큰으로 `request-download /tmp/native.bin` (3.0에서는 소유자 등록 기기가 아닌 토큰, 추정) | (a) exit 1, stdout 빈 문자열, stderr에 `PORTAL_READ_FAILED`, 서버에 도달한 요청 수 불변. (b) exit 1, stdout 빈 문자열, stderr에 `OWNER_REAUTH_REQUIRED`, 큐의 작업 수 불변, 원격 효과 [] | exit 코드·stderr·큐 크기·효과 목록 assert | portal-client | test/portal-client-process.test.mjs:165 | - |
| RC-B-280 | PC 클라이언트 프로세스: 수락된 chunk 응답이 유실된 뒤 새 프로세스가 같은 전송 재개 | CHUNK_BYTES+7 바이트 파일 업로드 중 첫 chunk 응답만 연결 종료로 유실. 이어서 새 프로세스로 `resume-upload <transferId> <source> <remote>`, `approve --confirm`, `resume-upload` 재호출 | 첫 `upload` exit 1, stdout 빈 문자열, stderr 마지막 JSON 줄의 `transferId`가 `^[a-f0-9]{48}$`이고 서버 저장소 received=CHUNK_BYTES. `resume-upload` exit 0, state `pending`, operation.artifactId=transferId, `POST /api/files/uploads`(begin) 횟수 불변, 원격 효과 []. 승인 후 원격 바이트=원본, 효과 ['upload']. 재호출한 `resume-upload`는 같은 job id·state `completed`를 반환하고 `/api/files/*` POST 횟수 불변, 효과 불변 | 자식 프로세스 결과, begin/변경 POST 횟수, 서버 저장소 상태, 원격 바이트 | portal-client | test/portal-client-process.test.mjs:175 | - |
| RC-B-281 | PC 클라이언트 프로세스: 저장 출력 UTF-8 text/JSON 페이지 읽기와 세션 철회 시 재실행 없이 중단 | 승인된 `hostname` 작업의 출력 본문='OUTPUT_BODY_SENTINEL\n'+'한글🙂'×3300. 승인 전 `output`, 승인 후 `status`, `output --offset N --limit OUTPUT_PAGE_BYTES-1 --format text`/`json`을 eof까지(8페이지 이내) 반복, 다른 신원 토큰 `output`, 다음 output 요청 직전에 같은 세션 철회 | 승인 전 `status` state `pending`, `output` exit 1·stdout 빈 문자열·실행 [] . 승인 후 실행 ['hostname'], `status` JSON에 'OUTPUT_BODY_SENTINEL' 없음. 각 페이지: executionId=작업 id, outputId=ref id, offsetBytes=요청 offset, bytes=UTF-8 바이트 수 ≤ OUTPUT_PAGE_BYTES-1, text에 U+FFFD 없음(멀티바이트 경계 보존), `wholeSha256Verified=false`, `sshCompleteness='unknown'`, 페이지 간 sha256 동일. 이어붙인 text 형식 본문=원문, json 형식=`JSON.stringify(outcome)`이며 각각 sha256과 일치. 다른 신원 `output`은 exit 1. 철회 뒤 `output`은 exit 1, stdout 빈 문자열, stderr JSON `error='OWNER_REAUTH_REQUIRED'`·`requestId`=작업 id·`outputId`=ref id, 추가 page 요청 정확히 1건. 명령 실행 목록은 끝까지 ['hostname'](재실행 없음), 원격 파일 효과 [] | 페이지 이어붙임 비교, 해시, 요청 수, 실행 목록 | portal-client | test/portal-client-process.test.mjs:193 | - |
| RC-B-282 | PC 클라이언트 프로세스: 선언한 원본 바이트를 begin 전에 결속하고 유효한 이진·빈 업로드는 보존 | `upload <src> <remote> --expect-size N --expect-sha256 H`. (a) size 일치+sha 불일치, (b) size+1+sha 일치, (c) 둘 다 일치(CHUNK_BYTES+9 이진), (d) 원본을 빈 파일로 바꾼 뒤 size 0·빈 해시, (e) 같은 옵션에 `--help` 추가 | (a)(b) exit 1, stdout 빈 문자열, stderr에 `UPLOAD_SOURCE_MISMATCH`, 큐 작업 0건, 스테이징 디렉터리에 `ssh-approval-upload-*` 잔존 0, `/api/files/*` POST 0건. (c) exit 0, state `pending`, operation.size·sha256 일치, 승인 후 원격 바이트=원본. (d) exit 0, 승인 후 원격 길이 0. (e) exit 1이고 서버 호출 수 불변(help는 연결하지 않음). begin POST는 총 2건, 효과 ['upload','upload'] | 자식 프로세스 결과, 스테이징 디렉터리 목록, 서버 호출 집계 | portal-client | test/portal-client-process.test.mjs:231 | - |
| RC-B-283 | 업로드 원본 기대값 검증과 API 선검증 | `validateUploadExpectation`: undefined → undefined; {size:0 또는 MAX_BYTES, sha256:'a'×64}는 통과 후 입력을 바꿔도 불변인 동결 복사본 반환; 거절 14종: null, [], '', {}, {size:0}만, {sha256}만, size -1, size MAX_BYTES+1, size '0', size 1.5, sha256 대문자, sha256 배열, 추가 필드, 프로토타입 상속 필드. API: 없는 원본 경로 + 잘못된 기대값 {size:'0'} 업로드 | 거절 값은 모두 code `INVALID_UPLOAD_EXPECTATION`. 통과 값은 `{size,sha256}`와 deepEqual, `Object.isFrozen`=true(Java는 불변 record). API 업로드는 없는 원본을 읽기 전에 `INVALID_UPLOAD_EXPECTATION`으로 거절하고 begin 요청 0건 | 예외 code, 반환 동등성·불변성, begin 요청 수 | portal-client | test/portal-client-source-binding.test.mjs:49, test/portal-client-source-binding.test.mjs:98 | - |
| RC-B-284 | 선언된 이진·빈 스냅샷은 정확한 바이트를 올리고 기대값 필드를 와이어에 싣지 않음 | 원본 이진(CHUNK_BYTES+9, i%251) 및 빈 파일, 각각 올바른 `{size,sha256}` 기대값으로 업로드 | 결과 id=requestId, begin 요청 1건, 전송된 chunk 이어붙임=원본 바이트, begin 본문 키 집합이 정확히 {fileName,size,sha256,remotePath,elevate,overwrite}(기대값 필드 `expectSize`류 없음) | 요청 본문 키 집합·바이트 비교 | portal-client | test/portal-client-source-binding.test.mjs:64 | - |
| RC-B-285 | 원본 크기·SHA 불일치는 원격 begin·진행 콜백·바이트 전송 전에 거절 | 원본 'declared source'(15바이트)에 기대값 {size:999,정상 sha}, {size:15,다른 sha} | 각각 code `UPLOAD_SOURCE_MISMATCH`, `error.transferId` 없음, 메시지에 원본 경로 문자열 없음. begin 요청 0건, 진행 콜백 0회, chunk 0건 | 예외 필드·호출 수 | portal-client | test/portal-client-source-binding.test.mjs:74 | - |
| RC-B-286 | 비동기 스냅샷 캡처 중 호출자 기대값 변경·원본 경로 변경이 스냅샷 신원을 바꾸지 못함 | (a) 기대값 {size:정상, sha:다른 값}으로 업로드 시작 직후 호출자가 같은 객체를 정상 sha로 변경. (b) 스냅샷 후 begin 직전에 원본 경로 파일을 다른 내용으로 교체 | (a) 거절 `UPLOAD_SOURCE_MISMATCH`, begin 0건. (b) 전송된 chunk 이어붙임=원래 스냅샷 바이트이고 디스크 파일은 교체본 그대로 | 예외 code, 전송 바이트 비교 | portal-client | test/portal-client-source-binding.test.mjs:84, test/portal-client-source-binding.test.mjs:91 | - |
| RC-B-287 | 결속 업로드의 begin 응답 불명 시 모호성 유지, 재시도·원시 진단 노출 없음 | begin 요청이 예외('PRIVATE_RAW_DIAGNOSTIC' 포함)로 실패 | code `UPLOAD_RESULT_UNKNOWN`, 메시지에 'PRIVATE' 없음, begin 요청 정확히 1건(재시도 없음), chunk 0건 | 예외 code·메시지·요청 수 | portal-client | test/portal-client-source-binding.test.mjs:104 | - |
| RC-B-288 | CLI 인자 오류는 헬퍼·stdin·HTTP 이전에 거절 | 접두 `--origin <o> --cloudflared <path>`(3.0은 기기 토큰 설정으로 대체)와 인자 변형: `--expect-size`만, `--expect-sha256`만, size가 '-1'/'01'/'1.0'/'NaN'/MAX_BYTES+1/'9007199254740992', sha 대문자, `targets`에 기대값, `resume-upload`에 기대값, `upload ... --help`. 추가로 인자 없음 `[]`은 거절, `--help`는 stdin을 읽지 않고 사용법 출력(옵션 `--access-token-stdin` 안내 포함) | 변형은 모두 exit 1, stdout 빈 문자열, stderr에 토큰 없음. `--access-token-stdin`과 `--expect-size`만 준 경우 exit 1이고 헬퍼 호출 0, stdin 소비 0, HTTP 0. `[]` 호출: exit 1, stdin 소비 0, stdout 빈 문자열. `--help`: exit 0, stdin 소비 0, stdout에 `--access-token-stdin` 안내, stderr 빈 문자열(3.0 옵션명은 구현이 정함, 추정) | 반환 코드·소비 카운터·출력 내용 | portal-client | test/portal-client-source-binding.test.mjs:112, test/portal-client.test.mjs:251 | - |
| RC-B-289 | CLI가 유효한 기대값을 같은 업로드 스냅샷에 전달하고 낡은 바이트는 거절 | CLI `upload <src> <remote> --expect-size <size> --expect-sha256 <sha>`: sha=낡은 값, 이어 정확한 값 | 낡은 값: exit 1, begin 0건, stdout 빈 문자열, stderr `UPLOAD_SOURCE_MISMATCH`. 정확한 값: exit 0, begin 1건, stdout JSON id=requestId, 인증 헬퍼 호출 2회(=호출당 1회), 출력에 토큰 없음 | 반환 코드·begin 수·출력 문자열 | portal-client | test/portal-client-source-binding.test.mjs:134 | - |
| RC-B-290 | 소유자 CLI가 명시 승인 뒤에만 다중 chunk·빈 바이트를 옮기고 준비된 다운로드를 저장 | 클라이언트 API로 `targets`, `upload`(CHUNK_BYTES+9), `transfer`, `decide(approve,false)`, `decide(approve,true)` ×2, `requestDownload`, `save`(미승인), 승인, `save` ×2, 빈 파일 업로드·승인. 다운로드 링크는 `downloadLink`로 대상 불일치(`targetId` 다름, `targetRevision` 다름) 시도 | 업로드 pending, operation.size·sha256 일치, 효과 []. `decide(...,false)`는 `EXPLICIT_OWNER_DECISION_REQUIRED`. 승인 시 `completed`, 2번째 승인은 `/approve` 호출 수 불변. 원격 바이트=원본, 효과 1. 다운로드 `pending`, `save`는 `DOWNLOAD_NOT_READY`이고 효과 불변. 승인 후 효과 2. 레거시 비결속 artifact는 `targetId` 속성 없음 유지. 다운로드 링크 경로는 `/downloads/<artifactId>/`로 시작, `targetId`·`targetRevision` 불일치는 `Download belongs to another target`로 거절되며 티켓 발급 1회뿐(불일치 시 발급 0). `save`는 `saved`·파일 바이트 일치, 재저장은 `EEXIST`이고 파일·효과 불변. 빈 업로드 후 원격 길이 0. up/down/감사 이벤트 JSON에 토큰·`__Host-ssh_admin_session`·`ticket=` 없음 | 반환 상태·예외 code, 원격 바이트, 효과 수, 티켓 발급 횟수, 직렬화 문자열 부재 | portal-client | test/portal-client.test.mjs:71 | - |
| RC-B-291 | 신규 파일 경로는 유효한 소유자 증명·그 증명의 자기 세션·변경 Origin을 모두 요구 | POST `/api/files/uploads`: 증명 없음, 세션 쿠키 + 증명 빈 값, 증명 다른 이메일, 증명 같은 이메일이나 다른 subject(bob), Origin `https://evil.test`. 별도로 브라우저 세션 로그아웃 뒤 독립 시작된 CLI 세션의 `targets`, 만료된 증명(exp=현재-30초)으로 connect (3.0에서 증명은 기기 등록 토큰, 추정) | 증명 없음 401, 빈 증명 401, 다른 이메일 401, 다른 subject 401, 잘못된 Origin 403. 브라우저 로그아웃이 CLI 세션을 철회하지 않아 `targets`가 `defaultTarget='default'`. 만료 증명은 `OWNER_REAUTH_REQUIRED`. 원격 효과 0, 큐 0 | HTTP 상태 코드·예외 code·큐/효과 수 | portal-web | test/portal-client.test.mjs:108 | - |
| RC-B-292 | 소유자 파일 API 경계: 잘못된 필드·chunk·대상 거절과 기존 스테이징 순서 규칙 재사용 | begin 본문 거절(HTTP 409): 추가 필드, elevate 'true'(문자열), target 'missing', size -1, sha256 'bad'. chunk 본문 거절(409): {sequence:0,data:'eA'}(패딩 없음), {sequence:2}(건너뜀), {sequence:0,data:'',extra}. 정상 chunk {sequence:0,data:'eA=='}를 2회 전송 후 상태 조회, 쿼리스트링 붙은 조회, finish 2회 | 위 거절은 모두 409. 같은 chunk 2회는 모두 `{sequence:1,received:1}`(멱등). 상태 조회: received=1, sequence=1, 응답에 `path` 속성 없음. `?x=1` 조회는 409. 1번째 finish는 state `pending`, 2번째 finish는 409. 큐 작업 1건, 원격 효과 0 | HTTP 상태·응답 본문 deepEqual, 큐/효과 수 | portal-web | test/portal-client.test.mjs:124 | - |
| RC-B-293 | 레거시 finish가 중복·누락·모호·불일치 제출 결속을 새 요청 없이 거절 | 업로드 job 존재 상태에서 `finishUpload(artifactId)` 재호출, 내부 operation의 fileTargetId/fileTargetRevision 변조, job.targetId 변조, 같은 artifact를 가리키는 중복 job 추가, 원 job 없는 고아 제출 기록 | 재호출은 `/already submitted/`, 변조는 `/does not match original/`(두 경우), 중복은 `/Ambiguous upload request/`, 고아는 `/Original upload request unavailable; do not replay/`. 큐 작업 수 1 유지, 효과 [], 스테이징 `.part` 바이트는 모두 원본 그대로 보존 | 예외 메시지 정규식, 큐 크기, 스테이징 파일 바이트 | portal-app | test/portal-client.test.mjs:144 | - |
| RC-B-294 | 저장소 await를 가로지르는 동시 레거시 finish 두 건은 승인 1건·원격 효과 1건만 제출 | 같은 artifact에 `finishUpload`를 동시 2회, 두 호출이 `store.finish`를 모두 통과할 때까지 장벽으로 정렬, 이어 승인 | 두 호출이 `finish` 모두 통과(2회), `submitOperation` 호출 1회. 결과는 fulfilled 1건·rejected 1건(메시지 `/already submitted/`). 큐 작업 1건, 승인 전 효과 [], 승인 후 `completed`, 효과 [{kind:'upload',path:'/tmp/race.bin'}], 원격 바이트=원본 | 결과 상태 배열, 호출 카운터, 효과 목록 | portal-app | test/portal-client.test.mjs:169 | - |
| RC-B-295 | finish·승인 ACK가 유실돼도 알려진 핸들을 반환하고 POST·원격 효과를 반복하지 않음 | 첫 finish 응답을 서버 처리 후 폐기(예외), 첫 approve 응답도 같은 방식으로 폐기 | upload는 `UPLOAD_RESULT_UNKNOWN`이고 `transferId`가 `^[a-f0-9]{48}$`. `transfer(transferId)`의 job state `pending`, 큐 1건, finish POST 1건, 효과 0. 승인 호출은 `PORTAL_RESULT_UNKNOWN`이며 `requestId`=job id. `status`는 `completed`, 승인 재호출도 `completed`, `/approve` POST 총 1건, 효과 1 | 예외 code·필드, 요청 수·효과 수 | portal-client | test/portal-client.test.mjs:194 | - |
| RC-B-296 | 리다이렉트로 소유자 자격이 다른 리스너에 전달되지 않고 다른 origin 다운로드 URL은 거절 | (a) 인증 요청이 302 → 다른 포트 리스너로 이동하는 서버. (b) 다운로드 준비 응답의 `downloadUrl`이 다른 origin(`?ticket=synthetic`)을 가리킴 | (a) 리스너가 받은 요청 0건, `connect` 오류 code `PORTAL_READ_FAILED`. (b) `save`는 `UNTRUSTED_DOWNLOAD_URL`, 리스너 수신 0건, 효과는 승인 시점 1건 | 예외 code, 리스너 수신 카운터, 효과 수 | portal-client | test/portal-client.test.mjs:213 | - |
| RC-B-297 | 잘린 다운로드는 게시되지 않고, 같은 준비 artifact 재저장은 SSH를 다시 실행하지 않음 | 첫 다운로드 응답 본문을 앞 2바이트로 절단, 같은 job을 다시 `save` | 첫 `save`는 `DOWNLOAD_INTEGRITY_MISMATCH`, 대상 경로 파일 미생성, 효과 1. 두 번째 `save`는 `saved`, sha256=SHA-256('snapshot'), 파일 내용 'snapshot', 효과 여전히 1 | 예외 code, 파일 존재·내용, 효과 수 | portal-client | test/portal-client.test.mjs:229 | - |
| RC-B-298 | 알려진 업로드 할당 뒤 취소는 원격 승인 이전에 멈추고 대체 요청을 만들지 않음 | 업로드 핸들 콜백에서 AbortSignal 취소 | `UPLOAD_RESULT_UNKNOWN`, `error.transferId`=콜백으로 받은 핸들. begin POST 1건, chunk 0건, 큐 작업 0건, 효과 0 | 예외 필드·요청 수·큐 크기 | portal-client | test/portal-client.test.mjs:243 | - |
| RC-B-300 | 본문 수신이 지연돼 로그아웃·만료를 넘기면 같은 세션 재검사로 신규 파일 입장 거절, 재개 중 철회도 chunk 차단 | (a) action 5종(begin, chunk, finish, download, expiry): 요청 본문 첫 1바이트만 보내고 서버가 본문을 읽기 시작한 뒤 세션을 로그아웃(expiry는 실제 토큰·세션 만료 시각까지 대기)하고 나머지 전송. (b) `resumeUpload` 중 스테이징 조회(GET) 직후 같은 세션 로그아웃 | (a) 모두 HTTP 401, 저장소 목록 변경 없음(늦은 할당·append·finish 없음), 큐 작업 수·효과 수 불변. (b) `OWNER_REAUTH_REQUIRED`와 `transferId`, 스테이징 기록 deepEqual 불변, 큐 0건, 효과 [] | HTTP 상태, 저장소·큐·효과 전후 비교, 예외 필드 | portal-web | test/portal-client.test.mjs:276, test/portal-client.test.mjs:479 | - |
| RC-B-301 | 업로드 재개: chunk ACK 유실 뒤 남은 바이트만 같은 전송으로 전송(정렬 안 된 접두 포함) | 중단 지점 offset=3(큰 chunk), offset=3(1바이트 chunk 3개 수락 뒤 응답 유실), offset=CHUNK_BYTES. 이름이 다른 동일 바이트 파일 경로 + intent {remotePath}로 `resumeUpload(id, alias, intent)` | 중단 직후 저장소 received=offset, sequence=(tiny ? 3 : 1). 재개 결과 state `pending`, operation.artifactId=id, fileName='original.bin'(원래 이름), 첫 chunk의 sequence=저장소 sequence, 새로 보낸 바이트 합=전체-offset, begin POST 총 1건, 효과 []. 승인 후 원격 바이트=원본, 효과 1 | chunk 요청 sequence·바이트 합 집계, 상태·원격 바이트 assert | portal-client | test/portal-client.test.mjs:358 | - |
| RC-B-302 | 재개: finish ACK 유실 조정과 모든 알려진 job 상태를 추가 변경 없이 관측 | finish 응답 유실 상태. `resumeUpload` 후 승인, 서버가 스테이징 조회 응답의 job.state를 pending/evaluating/running/completed/failed/denied/expired/unknown으로 바꿔 줄 때, 대상 `enabled=false` 상태 | 최초: 기존 job id 그대로, state `pending`, `/api/files/*` 및 `/approve` POST 수 불변. 승인 후 효과 1. 각 상태 값은 그대로 결과 state에 반영되고 변경 호출 불변, 효과 1 유지. 비활성 대상 이력: 같은 job id·`completed` 관측 가능하며 변경 호출 불변, 효과 1 | 반환 id·state, 변경 POST 수 비교 | portal-client | test/portal-client.test.mjs:378 | - |
| RC-B-303 | 재개 거절: 원본·의도 불일치, 비정상·준비됨·만료·사라진 스테이징은 변경 전에 거절 | (a) 바뀐 바이트 파일, 더 긴 파일, intent remotePath 다름, overwrite true, elevate true, target 'other', target null, overwrite 1, 추가 필드. (b) 스테이징 조회 응답 변형: received -1, received>size, sequence 0/4/1.5, expiresAt 0, state `ready`, id 다름, targetId null. (c) 스테이징 삭제 후 재개 | (a) code: 파일 2건 `RESUME_SOURCE_MISMATCH`, remotePath/overwrite/elevate 불일치 `RESUME_INTENT_MISMATCH`, target·null·overwrite 1·추가 필드 `INVALID_RESUME_INTENT`, 모든 오류에 `transferId`=id, 변경 호출 불변. (b) code ∈ {`UPLOAD_NOT_RESUMABLE`,`RESUME_INTENT_MISMATCH`}, 변경 호출 불변. (c) `PORTAL_REQUEST_REFUSED`와 `transferId`, 변경 호출 불변. 전체적으로 큐 0건·효과 [] | 예외 code·필드, 변경 POST 수, 큐/효과 | portal-client | test/portal-client.test.mjs:407, test/portal-client.test.mjs:424 | SSH_PORTAL-D-0030(후보) |
| RC-B-304 | 같은 스테이징 커서를 동시에 재개하는 소유자 클라이언트 둘은 업로드 job을 최대 1건만 생성 | 중단된 업로드(offset=CHUNK_BYTES), 두 클라이언트가 스테이징 조회(GET) 응답을 모두 읽을 때까지 장벽 정렬 후 동시 `resumeUpload`, 이어 승인 | 스테이징 조회 2회 수행. 큐의 해당 artifact upload job 정확히 1건, 성공한 결과의 id는 그 job id, begin POST 총 1건, 승인 전 효과 [], 승인 후 원격 바이트=원본, 효과 1 | 큐 job 수, 결과 id, 효과 수 | portal-app | test/portal-client.test.mjs:443 | - |
| RC-B-305 | 할당만 된 빈 파일 재개: chunk·재할당 없이 job 생성 | 빈 파일 업로드 begin 직후 중단(핸들 콜백에서 예외), 새 클라이언트로 `resumeUpload(id, source, {remotePath})`, 승인 | operation.artifactId=id, size 0, sha256=SHA-256(빈값), chunk 요청 수 불변, begin POST 총 1건, 승인 전 효과 [], 승인 후 원격 길이 0, 효과 1 | 반환 operation, 요청 수, 원격 바이트 | portal-client | test/portal-client.test.mjs:465 | - |
| RC-B-306 | 파일 전달기: 엄격한 사람 매니페스트·능력 인자는 추가 권한을 헬퍼 전에 거절 | `validateFileManifest`: 최상위 추가 키, capability에 `command:'id'`, targetRevision 'invalid', capability 중복. `invoke('upload', ...)`에 {capabilityId,path}, {capabilityId:'z'×48}, {}. 미등록 capabilityId 'f'×48 | 매니페스트 4종 `INVALID_FILE_MANIFEST`. 인자 3종 `INVALID_CAPABILITY_ARGUMENTS`. 미등록 id는 `CAPABILITY_UNAVAILABLE`. 클라이언트 open 0회. `list()` 결과 JSON에 'PRIVATE-'(원본 경로·원격 경로) 없음 | 예외 code, open 카운터, 직렬화 부재 | portal-client | test/portal-file-forwarder.test.mjs:36 | - |
| RC-B-307 | 파일 전달기: 배타적 영속 최초 claim으로 경쟁 인스턴스 간 효과 1회 | 같은 저널에 인스턴스 2개가 동시에 `upload`, 이후 세 번째 인스턴스가 `upload` | 클라이언트 upload 호출 1회, 결과 중 `requestId`=고정 요청 id. 세 번째 인스턴스도 같은 `requestId`를 반환하고 upload 호출은 여전히 1회. 클라이언트 open 횟수=close 횟수 | 호출 카운터, 반환 requestId | portal-client | test/portal-file-forwarder.test.mjs:42 | - |
| RC-B-308 | 파일 전달기: 최초 응답이 불명하면 재시작 후에도 대체 요청·개인 오류 없이 유지 | 핸들 수신 전에 업로드가 'PRIVATE-source-and-token-a.b.c' 예외로 실패, 이후 새 인스턴스에서 `upload`·`resume-upload` | 첫 결과 state `unknown`, 직렬화에 'PRIVATE-' 없음. 새 인스턴스: `upload` state `unknown`, `resume-upload` state `unknown`. upload 호출 총 1회, resume 0회, 클라이언트 open 총 1회 | 반환 state·호출 카운터 | portal-client | test/portal-file-forwarder.test.mjs:47 | - |
| RC-B-309 | 파일 전달기: 알려진 전송은 명시적 같은 ID 재개만 허용하고 status는 읽기 전용 | 핸들 수신 뒤 업로드 실패 상태에서 새 인스턴스: `status`, `resume-upload`, 다시 `resume-upload` | `status` state `staging`이며 resume 호출 0. `resume-upload`는 `requestId`=고정 요청 id. 재호출 후에도 resume 호출 총 1회, upload 호출 총 1회 | 반환 state, 호출 카운터 | portal-client | test/portal-file-forwarder.test.mjs:51 | - |
| RC-B-310 | 파일 전달기: 부분 저널·매니페스트 변경·만료는 최초 효과 없이 fail closed | (a) 빈 `<capId>.claim.json`이 이미 존재. (b) claim 후 매니페스트의 publicName 변경. (c) capability.expiresAt=현재-1 | (a) `upload` state `unknown`, 클라이언트 open 0. (b) state `unknown`, upload 호출 총 1회. (c) state `unknown`, open 0, claim 파일이 생성되지 않음(ENOENT) | 반환 state, open 카운터, 파일 존재 | portal-client | test/portal-file-forwarder.test.mjs:56 | - |
| RC-B-311 | 파일 전달기: 대기·준비 다운로드와 검증된 이진·빈 저장 영수증을 구분 | 다운로드 능력, 바이트 [0,255,19] 및 빈 값: `request-download`, `save`(job pending), job을 completed로 바꾼 뒤 `status`, `save`, 새 인스턴스 `save` | `request-download` state `pending`. 미완료 `save` state `pending`, save 호출 0, `<capId>.save-claim.json` 없음. 완료 후 `status` `prepared`, `save` `saved`이고 목적지 바이트 일치. 새 인스턴스 `save`도 `saved`, save 호출 총 1회, download 호출 총 1회 | 반환 state, 파일 바이트·존재, 호출 카운터 | portal-client | test/portal-file-forwarder.test.mjs:61 | - |
| RC-B-312 | 파일 전달기: 목적지 충돌은 저장 시도를 소비하되 덮어쓰기·재시도 없음 | 완료된 다운로드, 목적지에 'existing' 파일, `save` 후 새 인스턴스 `save` | 첫 `save` state `save-unknown`, 파일 내용 'existing' 불변, 새 인스턴스 `save` 뒤에도 save 호출 총 1회 | 반환 state, 파일 내용, 호출 카운터 | portal-client | test/portal-file-forwarder.test.mjs:68 | - |
| RC-B-313 | 파일 전달기: 게시 후 저널 영수증 기록 실패는 unknown이며 saved로 추정하지 않음 | 저장 직후 저널 영수증 경로(`<capId>.saved.json`)를 디렉터리로 선점해 기록 실패 유도 | `save` state `save-unknown`, 목적지에는 원본 바이트 존재. 새 인스턴스 `save`도 `save-unknown`, save 호출 총 1회 | 반환 state, 파일 바이트, 호출 카운터 | portal-client | test/portal-file-forwarder.test.mjs:72 | - |
| RC-B-314 | 파일 전달기: 광고된 대상 리비전이 없음·낡음·비활성이면 최초 변경 거절 | 대상 목록의 revision=undefined, revision='0'×64, enabled=false 각각 `upload` | 결과 `error='CAPABILITY_TARGET_UNAVAILABLE'`, 클라이언트 upload 호출 0회 | 반환 error·호출 카운터 | portal-client | test/portal-file-forwarder.test.mjs:78 | - |
| RC-B-315 | 파일 MCP(stdio) 도구: 엄격한 불투명 스키마, 추가 권한 거절 | 실제 stdio MCP 프로세스(전용 클라이언트 SDK)로 `listTools`, `file_capabilities`, `file_upload`에 {capabilityId,path}, {origin}, {approve:true}, 미등록 id | 도구 7개. `file_capabilities` 결과의 capabilities[0].capabilityId=고정 id, 직렬화에 'PRIVATE-' 없음. 추가 인자·미등록 id 호출은 오류(isError=true 또는 거절)이며 업로드 효과 0. 모든 도구 inputSchema `additionalProperties=false`, 속성 키 집합은 `file_capabilities`·`file_runtime`은 [], 나머지는 ['capabilityId']. 효과 로그 없음, 저널 디렉터리 비어 있음, 프로세스 stderr에 'PRIVATE-' 없음 | 도구 목록·스키마 assert, 효과 로그, 저널 디렉터리 | portal-client | test/portal-file-mcp-process.test.mjs:33 | - |
| RC-B-316 | 파일 MCP: 새 프로세스들이 영속 claim을 경쟁하고 재시작 뒤 관측 | 프로세스 2개가 동시에 `file_upload`, 둘 다 종료 후 새 프로세스가 `file_upload` | 결과 중 `structuredContent.requestId`='c'×48. 업로드 효과 로그 정확히 1건. 재시작 뒤에도 같은 requestId, 효과 1건 유지 | 반환 requestId, 효과 로그 수 | portal-client | test/portal-file-mcp-process.test.mjs:43 | - |
| RC-B-317 | 파일 MCP: 효과 후·핸들 전 실제 프로세스 중단이 대체 업로드를 만들지 않음 | 서버를 `crash` 모드로 기동해 `file_upload`(프로세스 강제 종료), 새 프로세스에서 `file_upload`, `file_upload_resume` | 첫 호출은 거절/오류. 새 프로세스: `file_upload`·`file_upload_resume` 모두 state `unknown`. 업로드 효과 로그 총 1건 | 반환 state, 효과 로그 수 | portal-client | test/portal-file-mcp-process.test.mjs:49 | - |
| RC-B-318 | 파일 MCP 운영 stdio 진입: 검증된 TLS·실제 소유자 앱으로 이진·빈 PC 왕복 | 운영 진입점에 `--manifest`·`--journal` 지정(원본 CHUNK_BYTES+9, 빈 파일 두 쌍의 업로드/다운로드 능력), 자체 서명 CA는 자식 환경에만 신뢰. 쌍마다 `file_upload` → 소유자 API로 승인 → `file_download_request` → `file_save` → 승인 → `file_status` → `file_save` ×2 | 업로드 state `pending`이고 승인 전 원격 없음. 소유자 승인 뒤 원격 바이트=원본. 다운로드 요청 `pending`, 미승인 `file_save`는 `pending`이며 목적지 파일 없음. 승인 후 `file_status` `prepared`, `file_save` `saved`·바이트 일치, 재호출도 `saved`. 효과 ['upload','download','upload','download']. 엣지 호출 중 MCP 측 `/approve`·`/deny` 0건, `POST /api/files/uploads` 2건, `POST /api/files/downloads` 2건. 도구 결과·stderr에 토큰·'PRIVATE-' 없음. 도구 호출은 isError 없음 | 도구 결과 structuredContent, 원격 바이트, 엣지 호출 집계, 효과 목록 | portal-client | test/portal-file-mcp-process.test.mjs:56 | - |
| RC-B-319 | 완료 훅 `watch`: wake 전에 inbox 커밋·종료, ACK 없음, 개인 추가 필드 제거 | 등록된 (host `codex`, session) 바인딩, 종결 이벤트에 `command`·`output` 추가 필드를 섞어 `watch <id> --notify-hook --host --session --inbox` 실행 (3.0에서 wake는 hook 전용이므로 wake 호출 단계는 `deferred` 결과로 대체, 추정) | exit 0. 인증(토큰 읽기) 1회이며 그 시점에 사전점검용 inbox는 이미 닫힘(close 1회). 커밋 뒤 다시 닫혀 close 총 2회. 결과 state `completed`, `notification.state='queued'`. 대기 건수 {pending:1,claimed:0,acknowledged:0}. claim한 항목의 `receiptId`=결과 `notification.receiptId`, `event`는 기본 이벤트와 deepEqual(추가 필드 제거). ACK는 수행되지 않음 | 반환 JSON, close 카운터, inbox 상태·claim 내용 | portal-client | test/portal-files-hook.test.mjs:55 | SSH_PORTAL-D-0046(후보) |
| RC-B-320 | 완료 훅: 없는·다른 세션 바인딩과 불완전·혼합·잘못된 명령·상대 경로 옵션은 부작용 전에 거절 | (a) 등록과 다른 session id로 `watch --notify-hook`. (b) 옵션 변형 12종: `--notify-hook`만, `--host`만, `--session`만, `--inbox`만, `--wake-executable`만, `--notify-codex ... --thread ...` 혼합, `--thread`만, 알 수 없는 host, 상대 경로 inbox, 상대 경로 wake 실행 파일, `doctor` 명령에 훅 옵션, `status`에 `--inbox` | (a) exit 1, stdout 빈 문자열, inbox close 1회, stderr JSON `error='COMPLETION_BINDING_NOT_FOUND'`, 인증·wake 호출 0, 다른 세션 바인딩이 새로 등록되지 않음(findBinding null). (b) 모두 exit 1, stdout 빈 문자열, stderr JSON `error='INVALID_COMPLETION_TARGET'`, 인증·inbox 열기·wake 모두 0회 | exit 코드·stderr JSON·호출 카운터, inbox 바인딩 조회 | portal-client | test/portal-files-hook.test.mjs:77, test/portal-files-hook.test.mjs:91 | - |
| RC-B-321 | 완료 훅: 실패·불확실 종결 이벤트가 원래 의미를 유지 | 종결 state `failed`/`denied`/`expired`/`cancelled`/`unknown` (failed=true, remoteOutcome 'unknown', exitCode null) | 각각 exit 1, 결과 `state`=해당 state, `failed=true`, claim한 이벤트가 종결 이벤트와 deepEqual | exit 코드, 반환 JSON, claim 내용 | portal-client | test/portal-files-hook.test.mjs:122 | - |
| RC-B-322 | 완료 훅: enqueue 실패·감시자 실패의 정리와 무배달 | (a) enqueue가 `COMPLETION_INBOX_STORAGE_FAILED`('private error detail' 메시지 포함)로 실패. (b) 감시자 `watch`가 `OWNER_REAUTH_REQUIRED`로 실패, 사전점검 inbox는 이미 닫힌 상태에서 connect | (a) exit 1, inbox close 총 2회, enqueue 1회, 결과 state `completed`, `notification.state='unknown'`, stderr에 `COMPLETION_INBOX_STORAGE_FAILED`, 'private error detail' 없음, wake 0. (b) exit 1, stdout 빈 문자열, inbox close 1회(connect 시점에 이미 닫힘), 감시자 close 1회, stderr 마지막 JSON 줄 `error='OWNER_REAUTH_REQUIRED'`, enqueue·wake 0 | exit 코드, 호출 카운터, stderr | portal-client | test/portal-files-hook.test.mjs:131, test/portal-files-hook.test.mjs:141 | - |
| RC-B-323 | 완료 훅: 명시적 중복 전달은 영속 영수증 1개를 유지하고 ACK하지 않음 | 같은 대상·이벤트에 `deliverCompletion`을 2회 | 두 호출의 `receiptId` 동일, 1번째 `duplicate=false`, 2번째 `duplicate=true`. 대기 건수 {pending:1,claimed:0,acknowledged:0} | 반환 값, inbox 상태 | portal-client | test/portal-files-hook.test.mjs:151 | SSH_PORTAL-D-0046(후보) |
| RC-B-324 | 완료 inbox 기본 경로: 프로필 상태 기준 디렉터리 + 고정 비공개 leaf | 환경 {LOCALAPPDATA, XDG_STATE_HOME, HOME}=base. Linux만: {HOME:base}. 환경이 빈 객체 | Windows·Linux 모두 `base/ssh-mcp-completion/completion.sqlite`(leaf 이름은 3.0 저장소에 맞게 정의, 추정). Linux는 HOME만 있을 때 `base/.local/state/ssh-mcp-completion/...`. 기준 환경이 전혀 없으면 오류 code `COMPLETION_INBOX_INVALID_PATH`. 세션에서 유도한 경로는 사용하지 않음 | 반환 경로 문자열·예외 code | portal-client | test/portal-files-hook.test.mjs:161 | - |
| RC-B-325 | 네이티브 Claude 훅 지연(deferral)은 소켓 자격·영수증 claim 없이 큐 성공으로 처리 | host `claude-code`, 종결 state `completed`/`failed`/`unknown`, 환경 객체의 `CLAUDE_CODE_MESSAGING_SOCKET`·`CLAUDE_CODE_MESSAGING_TOKEN` 접근 시 테스트 실패(읽으면 안 됨) | 인증 호출은 원 소유자 감시자용 1회뿐. exit 코드는 `completed`면 0, 그 외 1. 결과 state=입력 state, `notification.state='queued'`, `notification.wake={state:'deferred',reasonCode:'CLAUDE_NATIVE_HOOK_WAITING'}`, `automaticRetry=false`. stderr에 `COMPLETION_WAKE_UNCONFIRMED`·`COMPLETION_NOTIFICATION_FAILED` 없음. claude-code 바인딩 대기 {pending:1,claimed:0,acknowledged:0}, 같은 session의 codex 바인딩은 {pending:0,...} | 반환 JSON, 환경 접근 감시, inbox 건수 | portal-client | test/portal-files-hook.test.mjs:182 | SSH_PORTAL-D-0046(후보) |
| RC-B-326 | 유지보수 baseline 모드: unavailable 행을 보존하되 부분 증거를 strict 해제로 승격하지 않음 | 재시작을 거친 reserve+capture 상태(ready 출력 1건, unavailable 출력 1건). 순서: `capabilities`, `release`(baseline+verified 헤더), strict `preservation/compare`, `release`(verified만, baseline+verified), baseline `preservation/compare`, 다른 owner로 `release`, baseline만으로 `release`, baseline+verified `release` ×2, `release`(verified만) | `capabilities.baselineComparison='baseline-preservation-v1'`. 비교 전 해제는 409. strict 비교 `status='PARTIAL'`, `outputsUnavailable=1`, `baselinePreserved=true`이고 이후 verified 해제와 baseline+verified 해제는 모두 409(strict 비교가 baseline 승인으로 승격되지 않음). baseline 비교 HTTP 200, `comparisonContract`='baseline-preservation-v1', `status='PARTIAL'`, `baselinePreserved=true`, 응답에 'PRIVATE_PAYLOAD_SENTINEL' 없음. verified만·다른 owner·baseline만 해제는 409. baseline+verified 해제는 200이며 `comparisonContract` 반환, 유지보수 플래그 false. 같은 모드·같은 인스턴스의 해제 재호출은 200(응답 유실 조정), verified만 해제는 409 | HTTP 상태·응답 JSON assert, 유지보수 플래그 | portal-web | test/preservation-baseline.test.mjs:39 | - |
| RC-B-327 | baseline PASS는 strict 해제를 허용하지 않고 strict PASS는 baseline 해제를 허용하지 않음 | unavailable 출력이 없는 baseline. baseline 비교 → verified 해제, strict 비교 → baseline+verified 해제, verified 해제 | baseline 비교 `status='PASS'`지만 verified 해제 409. strict 비교 `PASS`이나 baseline+verified 해제 409. strict 비교 뒤 verified 해제 200 | HTTP 상태 | portal-web | test/preservation-baseline.test.mjs:64 | - |
| RC-B-328 | MAINT-OUTPUT 영속 예약이 주기 정리·재시작 동안 만료 baseline을 보존하고 verified 해제 뒤 정리 재개 | 시계를 TTL(3,600,000ms)+1 앞당기고 앱 정리 타이머(30초) 1회 실행, baseline 비교, 재시작, 다시 비교, baseline+verified 해제, 타이머 1회 실행 | 타이머 후 비교: `baselinePreserved=true`, `expiredOutputsRemoved=0`, 출력 페이로드 파일 바이트 불변. 재시작 뒤: 응답 200, `baselinePreserved=true`(출력 생성자의 정리보다 영속 예약이 먼저 열림), `expiredOutputsRemoved=0`, `outputPayloadsVerified=1`, 파일 불변. baseline+verified 해제 200. 해제 뒤 타이머 실행 시 만료 출력 파일이 삭제됨(ENOENT). (시계·타이머는 주입 가능한 Clock/Scheduler로 대체) | 파일 바이트·존재, 응답 JSON, 가짜 시계 | portal-app | test/preservation-baseline.test.mjs:75 | SSH_PORTAL-D-0019 |
| RC-B-329 | 실패하거나 알 수 없는 모드의 재비교가 같은 인스턴스의 이전 검증을 철회 | 모드(strict, baseline) × 실패(출력 페이로드 변조, 계약 헤더 'unknown'): 1차 비교 200 후 변조 또는 알 수 없는 계약으로 재비교, 이어 두 종류 해제 | 재비교 409. baseline+verified 해제 409, verified 해제 409, 유지보수 플래그 true 유지 | HTTP 상태, 유지보수 플래그 | portal-web | test/preservation-baseline.test.mjs:103 | - |
| RC-B-330 | 새로 추가된 ready·unavailable 출력은 baseline 불변의 증거가 아님 | 서비스 정지 중 새 출력 1건을 ready 또는 unavailable로 저장 후 재시작, baseline 비교, baseline+verified 해제 | 비교 200, `status='PARTIAL'`, `outputsAdded=1`, `baselinePreserved=false`, 응답에 'NEW_PRIVATE_PAYLOAD' 없음. 해제 409, 유지보수 플래그 true | 응답 JSON, 해제 상태 | portal-web | test/preservation-baseline.test.mjs:117 | - |
| RC-B-331 | verified 해제는 비교 뒤 페이로드를 재검사하고 재시작은 검증을 재사용할 수 없음 | (a) 모드(strict, baseline): 비교 200 후 페이로드 변조, verified 해제. (b) baseline 비교 200 후 서비스 재시작, baseline+verified 해제 | (a) 해제 409, 유지보수 플래그 true. (b) 해제 409, 유지보수 플래그 true | HTTP 상태, 플래그 | portal-web | test/preservation-baseline.test.mjs:138 | - |
| RC-B-332 | 유지보수 클라이언트(baseline): 서버 능력·정확한 계약·모호하지 않은 증거 요구 | 가짜 유지보수 서버에 `compare-baseline`, `release-baseline-verified`, `reserve`, `capture`, `status`, `compare` 명령. 능력 미지원/지원, 서버 응답 변형(비교 결과 필드 8종, 해제 응답에 계약 누락, canonical 필드 유효/무효 조합) | 미지원 서버: baseline 두 명령은 비0 종료이며 호출 경로는 `/api/maintenance/capabilities` 단 1건. 레거시 `reserve`/`capture`/`status`와 strict PASS `compare`는 exit 0, strict `compare`가 baseline PARTIAL 응답을 받으면 비0. 지원 서버: `compare-baseline` exit 0, 출력에 'complete payload preservation was not verified', 소유자 토큰 문자열 없음, 요약 JSON이 서버 값과 deepEqual, canonical 미포함 시 'Canonical preservation was not verified'. canonical 필드(`baselineScope='legacy-and-canonical'`, `canonicalCoverage='verified'`, 건수 필드)가 유효하면 수용하고 위 문구 없음. 무효 조합(canonicalOperationsChecked 누락, canonicalEventsAdded -1, canonicalCoverage 'invented', baselineScope 'legacy-only'와 모순) 비0. `legacy-only/not-in-baseline/0건`은 수용하며 canonical 문구 출력. 요청 헤더 `X-Maintenance-Preservation-Contract`='baseline-preservation-v1'. 응답 변형 comparisonContract 'other', baselinePreserved undefined/'true', expiredOutputsRemoved 1, outputsAdded 1, outputsChecked 2, status 'unknown', outputPayloadsVerified -1은 모두 비0이며 출력에 'confirmed'나 JSON 요약이 없음. 해제 응답에 `comparisonContract`가 없으면 비0, 있으면 exit 0이고 요청 헤더 `X-Maintenance-Compare-Required`='1'·계약 헤더 전송 | 종료 코드·출력 문자열, 서버가 받은 경로·헤더 | portal-server | test/preservation-baseline.test.mjs:157 | - |
| RC-B-333 | 영속 baseline이 서비스 교체 중 실제 journal 변경을 감지 | command journal에 완료 요청 1건(digest '2'×64), reserve+capture, 'b'×64 owner로 `release` 시도, 서비스 종료, DB에서 해당 요청 digest를 '3'×64로 직접 변경, 재기동 후 `preservation/compare` | 비교 전 해제는 409. 비교 HTTP 상태는 200이 아님. 응답 본문에 요청 id가 없음. (2.x SQLite journal은 H2 테이블 digest 변경으로 적응, 추정) | HTTP 상태·본문 문자열 부재 | portal-web | test/preservation-integration.test.mjs:18 | - |
| RC-B-334 | 자동화 설정 토글과 최초 활성화 시 기존 journal 보존 | 요청 1건 존재(`BRIDGE_COMMAND_AUTOMATION` true→false, false→true 각각): reserve+capture → 재기동(반대 설정) → `preservation/compare` → `release`. 별도: 자동화 false로 reserve+capture 후 true로 재기동 | 토글 2종: 비교 200, `commandRequestsChecked=1`, 해제 200. 최초 활성화: 비교 200, `status='PASS'`, 해제 200 | HTTP 상태, 응답 JSON | portal-app | test/preservation-integration.test.mjs:41, test/preservation-integration.test.mjs:60 | - |
| RC-B-335 | 예약된 시작은 레거시 출력 변환을 미루고 strict baseline 행·페이로드를 보존 | 레거시 요청 2건(완료 상태, 비밀 결과 포함 1건과 이미 저장된 출력 1건), 자동화 없는 서비스로 reserve+capture, 종료 후 DB 행·페이로드 바이트 기록, 자동화 켠 채 재기동, 비교, 조회, 해제, 종료, 일반 재기동 | 예약 시작 직후 `queue.maintenance=true`. 비교 200 `status='PASS'`, `commandRequestsChecked=2`, `outputPayloadsVerified=1`. 복원된 레거시 요청: state `completed`, operation·expiresAt 동일, `result.output.state='unavailable'`, `result.texts=[]`, 직렬화에 'LEGACY_PRIVATE_SENTINEL' 없음, `/api/requests` 응답에도 없음. 해제 200. 종료 후 모든 원본 행이 바이트 불변, 페이로드 불변. 이후 일반(비예약) 시작에서 비로소 `result.output.state='ready'`로 변환, id·request_key·digest 불변, body.operation 동일, 페이로드 불변. (2.x 레거시 journal 변환은 portal-migrate 이전 단계로 적응, 추정) | 응답 JSON, DB 행 deepEqual, 페이로드 바이트 | portal-migrate | test/preservation-integration.test.mjs:75 | - |
| RC-B-336 | canonical 보존이 서비스 교체 중 12종 변경을 모두 거절 | canonical operation(소스 kind, 취소 상태)과 legacy 이력 1건이 있는 저장소에 reserve+capture, 종료 후 직접 변경 12종: operation 삭제, body 변경, request_key 변경, contract 변경, digest 변경, target 변경, target revision 변경, state 변경, event(version 1) 삭제, event 시각 변경, legacy budget `reserved_bytes+1`, 스키마에 인덱스 추가. 재기동 후 `preservation/compare`, 이어 `X-Maintenance-Compare-Required` 해제 | 각 변경마다 비교 HTTP 409(PASS 불가), 응답 본문에 'PRIVATE_SENTINEL'·'changed-key'·'changed-target'·'operations.sqlite'·'fixture-owner' 없음, 유지보수 플래그 true, 이어서 verified 해제 409 | HTTP 상태, 본문 정규식 부재, 플래그 | portal-store | test/preservation-integration.test.mjs:133 | SSH_PORTAL-D-0031 |
| RC-B-337 | canonical 보존이 유지된 행·event 접두를 정당한 새 이력과 구분해 계수 | canonical operation 1건(+ legacy 1건) 상태로 reserve+capture, baseline 내용에 평문 비밀 없음 확인, 서비스 종료 중 canonical operation 1건 추가, 재기동 후 `preservation/compare` | baseline 저장 문자열에 'PRIVATE_SENTINEL'·'fixture-key'·'fixture-owner'·'fixture-only-target' 없음(해시만). 비교 200, `status='PASS'`, `baselineScope='legacy-and-canonical'`, `canonicalCoverage='verified'`, `canonicalOperationsChecked=2`, `canonicalOperationsAdded=1`, `canonicalEventsChecked=4`, `canonicalEventsAdded=2`, `canonicalLegacyBudgetChecked=1`, `canonicalLegacyBudgetAdded=0`. 응답에 비밀·'operations.sqlite' 없음 | 응답 JSON 필드, 저장 baseline 문자열 | portal-store | test/preservation-integration.test.mjs:152 | SSH_PORTAL-D-0031 |
| RC-B-338 | 실제 journal 비교: 재시작 뒤 이전 행·페이로드 비교, 만료·신규 요청 허용 | command·CLI journal 요청 각 1건, 출력 1건(TTL 100, 시계 1000)으로 snapshot 캡처 → 모든 저장소 닫고 재오픈 → 재캡처 비교, 요청 추가, 요청 상태 변경(command, CLI 각각), snapshot 객체에서 요청/출력 행 삭제, 페이로드 1비트 변조, 시계 1101로 만료 정리, 대기 출력 예약 상태 캡처 | 재오픈 비교 결과 deepEqual {status:'PASS', commandRequestsChecked:1, cliRequestsChecked:1, outputsChecked:1, outputPayloadsVerified:1, outputsUnavailable:0, expiredOutputsRemoved:0, comparisonContract:'baseline-preservation-v1', baselinePreserved:true, outputsAdded:0, baselineScope:'legacy-and-canonical', canonicalCoverage:'verified', canonical*Checked/Added 6개 필드 모두 0}. 결과 JSON에 'private output' 없음. 새 요청 추가 후에도 PASS. 요청 상태 변경은 `/request changed/` 예외(command, CLI 각각), 요청 행 삭제는 `/request changed/`, 출력 행 삭제는 `/Unexpired output/`, 페이로드 변조는 `/output changed/i`. 만료 정리 후 `expiredOutputsRemoved=1`, `status='PARTIAL'`. 대기 출력이 있으면 캡처가 `/Pending or invalid output/`로 실패, 폐기 후 캡처 비교는 `PARTIAL`·`outputsUnavailable=1` | 반환 객체 deepEqual, 예외 메시지 정규식 | portal-store | test/preservation-verification.test.mjs:13 | - |
| RC-B-339 | baseline 보존이 불변 unavailable 본문과 만료·추가·실제 손실을 구분 | snapshot(ready 1건 payload 해시, unavailable 1건 payload null, command 요청 1건) 자기 자신과 비교, 변형 9종: ready payload null, ready payload 다른 해시, unavailable row 변경, unavailable payload 해시 부여, ready 행 삭제, output schema 변경, command policy 변경, command schema 변경, command 요청 삭제. 시각 1200에서 ready 만료 삭제, 새 출력 추가, `baselinePreservationAccepted`에 변형된 결과 6종 | 자기 비교: `baselineScope='legacy-only'`, `canonicalCoverage='not-in-baseline'`, `status='PARTIAL'`, `outputsUnavailable=1`, `baselinePreserved=true`, 수용 판정 true. 변형 9종은 모두 예외. 만료: `status='PARTIAL'`, `expiredOutputsRemoved=1`, `baselinePreserved=false`, 수용 false. 추가: `PARTIAL`, `outputsAdded=1`, `baselinePreserved=false`, 수용 false. 수용 판정에 baselinePreserved 'true'(문자열), comparisonContract 'other', outputsChecked 3, status 'PASS', outputsAdded 1, expiredOutputsRemoved 1을 넣으면 모두 false | 예외 발생, 반환 필드, 판정 함수 결과 | portal-domain | test/preservation-verification.test.mjs:60 | - |
| RC-B-340 | 캡처는 진행 중 상태를 거절하고 policy·journal 삭제·시각 역행은 비교를 통과하지 못함 | 진행 중(state `running`) 요청이 있는 command 저장소 캡처, snapshot 변형: command.policy 변경, command를 null, observedAt 역행 | 캡처 `/Nonterminal/`로 실패. 비교: policy 변경 `/policy/`, command null `/presence/`, observedAt 역행 `/snapshots/` 예외 | 예외 메시지 정규식 | portal-domain | test/preservation-verification.test.mjs:94 | - |
| RC-B-341 | canonical 캡처: 기존 연결 필수, SELECT만 수행, 비공개 본문 비노출 | 소스 operation 1건(비밀 key/owner/source, 취소 상태)이 있는 저장소에서 캡처(실행된 SQL 기록, DB 파일 바이트 전후 비교), operationStore 없이 캡처 | snapshot `version=2`, `canonical.operations` 1건, `canonical.events.count=2`. 실행 SQL이 1건 이상이며 모두 `SELECT`로 시작, DB 파일 바이트 불변, snapshot 직렬화에 'PRIVATE_'·'private-target'·'operations.sqlite' 없음. operationStore 없이 호출하면 `/Canonical/` 예외 | 실행 SQL 집계, 파일 바이트, 예외 | portal-store | test/preservation-verification.test.mjs:108 | SSH_PORTAL-D-0031 |
| RC-B-342 | canonical 비교기: 예산 손실·event 접두 변조 감지, 구 baseline 범위를 명시 | canonical baseline에 legacyBudget ['a'×64] 후 [] 로 비교, event 접두(count=1, prefixCount=0, prefixDigest 변경), version 1 legacy baseline 대 canonical 현재, canonical 없는 불완전 baseline, 반대 방향 | 예산 손실 `/canonical record/`, event 접두 변조 `/event prefix/`. legacy baseline 비교: `status='PASS'`, `baselineScope='legacy-only'`, `canonicalCoverage='not-in-baseline'`, `canonicalOperationsChecked=0`, 수용 true. 불완전 baseline 비교 `/snapshots/`, canonical baseline 대 legacy 현재 `/presence/` 예외 | 예외 정규식, 반환 필드 | portal-domain | test/preservation-verification.test.mjs:124 | SSH_PORTAL-D-0031 |
| RC-B-343 | canonical 비종결 상태는 idle 보존 경계를 넘을 수 없음 | operation을 state `accepted`, `queued`, `starting`, `running`, `terminating` 각각으로 만들고 캡처 | 5종 모두 `PRESERVATION_NOT_IDLE` 예외 | 예외 코드 | portal-store | test/preservation-verification.test.mjs:143 | - |
| RC-B-344 | SSH 소스 실행 계획 보호: 프로필·계획 변조·결속 변경은 SSH exec 전에 거절 | 유효 계획 + 프로필 `tty:true`/`readOnly:true`/`workdir:'/tmp'`. 변조 계획 5종: stdin 변경, command 'id', planDigest 변경, manifest.sourceBytes 1, args ['-c','pass']. 검증 콜백이 다른 targetRevision 반환 | 프로필 3종은 `/requires/` 거절, SSH 전송 0. 변조 5종은 거절이며 연결 획득 0. 결속 변경은 `/binding changed/`, 연결 획득 0 | 예외 메시지, 전송·연결 획득 카운터 | portal-ssh | test/python-source-ssh.test.mjs:38 | - |
| RC-B-345 | 소스 실행: 연결 획득 후 비동기 대상·프로필 변경 재검사 | 연결 획득 중 targetRevision이 바뀜, 프로필 host가 'other'로 바뀜 | 리비전 변경 `/binding changed/`, 프로필 변경 `/profile changed/`, 둘 다 SSH 전송 0 | 예외 메시지, 전송 카운터 | portal-ssh | test/python-source-ssh.test.mjs:53 | - |
| RC-B-346 | 소스 실행: 승인된 계획은 불변 스냅샷, 전송 예외는 재실행·소스 노출 없음 | 제출 사본의 manifest.targetId·stdin을 연결 획득 중 변경. 별도로 전송이 'private-body-marker' 예외 | 변경과 무관하게 실행 성공(`failed=false`), 전송 1회, 전송된 command·stdin이 원본 계획 값. 예외 경우 `failed=true`, `execution.remoteState='unknown'`, `execution.automaticReplay=false`, 결과 JSON에 'private-body-marker' 없음, 전송 1회 | 반환 필드, 전송 인자 비교, 호출 수 | portal-ssh | test/python-source-ssh.test.mjs:62 | - |
| RC-B-347 | 고정 호스트 키 실제 loopback SSH: UTF-8 바이트 보존, 깨끗한 환경, 짧은·틀린 전달은 효과 차단 | 실제 SSH 서버(MINA SSHD 테스트 서버, 호스트 키 SHA256 고정, exec 명령은 계획의 receiver 명령과 정확히 일치 요구)에 소스 'import os,json,sys ... print(json.dumps(dict(os.environ)))\n# 한글 exact UTF-8' 실행. 이어 서버가 전달을 `short`(소스 본문 `print(` 이전까지 절단), `wrong`(첫 바이트 반전)으로 훼손하고 소스는 marker 파일을 쓰는 코드 | 정상: `failed=false`, 원격 프로세스 환경 JSON이 {LANG:'C.UTF-8', LC_ALL:'C.UTF-8', PATH:'/usr/bin:/bin'}과 정확히 같음(서버 쪽 `JEV_SYNTHETIC_ENV_MARKER` 유입 없음), 서버가 받은 바이트 수·SHA-256이 manifest.sourceBytes·sourceSha256과 같고 `manifest.environmentRevision`이 환경 리비전 상수. 훼손 2종: `failed=true`, 출력에 `exit 125`(receiver 거부 종료 코드, 3.0에서 receiver 구현이 바뀌어도 같은 거부 계약 유지, 추정), marker 파일 미생성, 수신 바이트·해시는 항상 manifest와 일치. 서버가 받은 소스 전송 총 3회(재전송 없음), 고정 서버 내부 오류 없음 | 반환 필드, 서버가 기록한 수신 바이트·해시·명령, marker 파일 존재 | portal-ssh | test/python-source-ssh.test.mjs:81 | - |
| RC-B-348 | 소스 receiver: 유효한 절단 접두·틀린 바이트·후행 데이터·UTF-8 절단은 효과 전에 거절 | 계획(marker 파일을 쓰는 코드 + print('완료'))의 전달 바이트를 (a) 접두만, (b) 한 바이트 변경, (c) 후행 'x' 추가, (d) 마지막 5바이트 절단, (e) 빈 입력으로 변경해 receiver 실행. (f) 길이·해시는 유효하나 UTF-8이 아닌 바이트 [0xff×4] 와 그에 맞는 해시 | (a)~(e) receiver 종료 코드 125(거부), marker 파일 생성되지 않음. (f) 종료 코드 126, stderr에 'xff'·'Traceback' 없음. (Python receiver 구현 세부는 삭제하되 길이·해시 결속 거부·UTF-8 거부 계약은 Java receiver/전달 검증으로 이식. 종료 코드 값은 3.0에서 계약 유지 여부 확인 필요, 추정) | 종료 코드, marker 존재, stderr 문자열 | portal-ssh | test/python-source.test.mjs:21 | - |
| RC-B-349 | 소스 실행 계약: 정확한 본문, 리터럴 argv, 모듈 계약, EOF stdin | 소스가 `__file__` 부재, stdin 전체 읽기가 b''(EOF), marker 파일을 'changed'로 쓰고 읽고 'restored'로 복원, `[argv0, argv2, cwd, __name__]`을 JSON 출력. argv로 [marker경로, "한글 ' $(touch ignored) ; &"] | 종료 0, `argv0='<ssh-python-source-v1>'`, `argv2`가 리터럴 그대로(셸 확장 없음, 'ignored' 파일 미생성), `__name__='__main__'`, cwd가 '/'로 끝남, marker 최종 내용 'restored' | 종료 코드, 출력 JSON, 파일 내용 | portal-ssh | test/python-source.test.mjs:46 | - |
| RC-B-350 | 소스 실행: 완전한 바이트가 있어도 EOF 전에는 실행 보류, EOF 뒤 1회 실행 | 계획 바이트를 stdin에 쓰되 닫지 않고 200ms 대기, 이후 stdin 종료 | 대기 중 marker 파일 없음·프로세스 미종료. 종료 후 exit 0, signal 없음, marker 내용 'once'(정확히 1회 실행) | 파일 존재 시점, 종료 코드 | portal-ssh | test/python-source.test.mjs:57 | - |
| RC-B-351 | 소스 계획 manifest는 평탄·소스 비노출, 비공개 입력은 불변, 모든 결속이 계획 digest를 변경 | 소스 "print('private-source-marker')", argv ['literal'](생성 후 원본 배열 변경), 계획 재생성 비교: source 끝에 개행, argv 다름, cwd '/tmp', targetId 다름, targetRevision 다름, profile 다름, elevate true | manifest.argvJson='["literal"]'(원본 배열 변경 영향 없음), 계획·manifest·args 불변(동결), manifest JSON에 'private-source-marker' 없음, manifest 값은 모두 number/string/boolean, sourceBytes=UTF-8 바이트 길이, 같은 입력은 같은 planDigest, 위 7가지 변경 각각 planDigest가 달라짐 | 필드 값·불변성·digest 비교 | portal-ssh | test/python-source.test.mjs:73 | - |
| RC-B-352 | 소스 계획의 크기·인자·결속 검증과 리터럴 셸 인용 | 소스 5종 거절: 빈 값, 짝 없는 서로게이트, NUL 포함, 최대+1 바이트, 한글로 최대 바이트 초과. 변형 12종 거절: argv에 NUL, 개행, 17개, 513자, cwd 상대경로, cwd 개행, targetId '../bad', targetRevision 'wrong', environmentRevision 빈 값/다른 64자, profile 'bad;id', profile 1. 정확히 최대 바이트 소스 허용. argv ["a'b", '$(id); &'], elevate true/'true', argv 512자×3. 구문 오류 소스 | 위 거절 항목 모두 예외(argv 합계 초과는 `/too large/i`, elevate 문자열은 `/elevation/`). 최대 바이트 소스는 manifest.sourceBytes=PYTHON_SOURCE_MAX_BYTES. command 문자열은 각 토큰을 `'`로 감싸고 내부 `'`는 `'\''`로 이스케이프(예 `'/usr/bin/python3'` + args), 길이 ≤2000, elevate true면 `'sudo' '-n' '--' '/usr/bin/python3'`로 시작. 구문 오류 소스는 종료 코드 126, stdout 빈 문자열, stderr에 첫 줄 출력 'first'·'Traceback' 없음. (이 행의 `preparePythonHelper` 본문 한도·receiverSha256 비교 부분은 Python helper 고유라 SFTP 대체로 삭제) | 예외 발생·메시지, command 문자열 정확 비교, 종료 코드·출력 | portal-ssh | test/python-source.test.mjs:87 | - |
| RC-B-353 | 통합 명령 접수: 읽기 아닌 명령은 자기 승인 없이 pending 유지 | MCP `submit` kind command(실제 표준 클라이언트·출력 스키마 캐시 확보 후), 명령 5종: 복합 `stat ...;sha256sum ...;free -m;ps -ef`, `sha256sum /tmp/PRIVATE_COMMAND_CANARY`, `rm /tmp/PRIVATE_COMMAND_CANARY`, `rm -rf /`, `sudo id` | 모두 isError 없음, `data.state='pending'`, `data.approvalMode=null`. 큐 비운 뒤 실행 0건, 큐 작업 5건 | 응답 필드, 실행 카운터, 큐 크기 | portal-web | test/read-command-refusals.test.mjs:54 | SSH_PORTAL-D-0006(후보) |
| RC-B-354 | 유지보수 중 접수 거절과 해제 후 접수 복구 | 유지보수 예약 상태에서 `submit`, 해제 후 `submit id`와 `observe` 대기 | 예약 중: isError=true, `structuredContent.ok=false`, `error.code`가 `^[A-Z][A-Z0-9_]+$`, 응답 전체에 'PRIVATE_COMMAND_CANARY' 등 비공개 문구 없음, 실행 0건, 큐 0건. 해제 후 `id` 명령은 `completed`로 끝나고 실행 1건 | 오류 구조·정규식, 실행·큐 수 | portal-web | test/read-command-refusals.test.mjs:63 | SSH_PORTAL-D-0047(후보) |
| RC-B-355 | 접수 감사 실패는 비공개 오류이며 작업을 시작하지 않음 | `submitted` 감사 이벤트에서 'PRIVATE_AUDIT_CANARY' 예외 | 거절 응답(오류 구조 동일, 비공개 문구 없음), 큐 드레인 후 실행 0건, 큐 0건 | 오류 구조, 실행·큐 수 | portal-web | test/read-command-refusals.test.mjs:71 | - |
| RC-B-356 | 잘못된 명령·대상·분류기 오류가 비공개 예외 정보를 노출하지 않음 | 명령에 NUL('cat /tmp/x\0'), 미등록 target 'not-registered', 분류기가 'PRIVATE_EXCEPTION_CANARY' 예외 | 3종 모두 거절 응답(isError, ok=false, 대문자 오류 코드, 비공개 문구 없음). 실행 0건, 큐 0건 | 오류 구조, 실행·큐 수 | portal-domain | test/read-command-refusals.test.mjs:77 | - |
| RC-B-357 | 완료·중립 명령 실패는 참조와 명시적 제한 출력만 노출 | 실행기가 `{failed:false,texts:['합성 출력']}`, 이어 `{failed:true,...}`를 반환. `observe`로 완료까지 대기 후 `observe {includeOutput:true,maxBytes:64}` | state `completed`(failed=false)와 `failed`(failed=true) 각각 `output.state='ready'`, 일반 응답 JSON에 '합성 출력' 없음. 명시적 `includeOutput` 읽기의 `outputPage.text`='합성 출력'. 실행 총 2건 | 응답 필드, 직렬화 부재, 실행 수 | portal-web | test/read-command-refusals.test.mjs:85 | - |
| RC-B-358 | 시작 보호 실패가 실행 용량을 반납하고 이후 작업이 완료 | `policy-execution-started` 감사에서 예외, 첫 `id` 제출·관측, 감사 정상화 후 `id` 재제출 | 첫 작업 state `failed`, 실행 0건. 이후 작업은 `completed`, 실행 1건(용량이 반납됨) | state, 실행 수 | portal-app | test/read-command-refusals.test.mjs:98 | - |
| RC-B-359 | 불확실한 실행 결과는 같은 키로 관측하고 재실행하지 않음 | 실행기가 'PRIVATE_EXCEPTION_CANARY' 예외, `operationKey='read-unknown-stable-0001'`로 `submit` 후 관측, 같은 키로 `submit` 재호출, `observe {operationKey}` | 최초 state `unknown`, 실행 1건. 재제출은 같은 operation id 반환, `observe`(키)도 `unknown`, 실행 총 1건(재실행 없음). 응답 JSON에 'PRIVATE_EXCEPTION_CANARY' 없음 | 반환 id·state, 실행 수, 직렬화 부재 | portal-app | test/read-command-refusals.test.mjs:107 | - |

### G05 (원자료 1570~1664: release-version ~ solid-regressions, mjs 95행)

| 사례 ID | 대상 기능 | 입력·조건 | 기대 결과 | 판정 방법 | 3.0 모듈 | 원 시험 | 연결 결함 |
|---|---|---|---|---|---|---|---|
| RC-B-361 | 릴리스 ID 산출 | release-manifest.json 내용 `{"fixture":"public"}\n`과 버전 `1.2.0`, `2.0.0-preview.1`; 이어서 버전 `../escape` | 릴리스 ID = `<version>-<manifest SHA-256 hex 앞 16자>`로 종료 코드 0; `../escape`는 종료 코드 0이 아님(거절) | 버전 2개에 대해 문자열 일치, 경로 이탈 버전은 실패 | packaging | test/release-version.test.mjs:9 | - |
| RC-B-362 | 배포 산출물 버전 일관성 | 프로젝트 현재 버전(3.0.0 계열)과 Docker·compose·env 예시·README(영문·한글) | Dockerfile `ARG PACKAGE_ARCHIVE`가 `dist/ssh-approval-portal-<version>.tar.gz`(3.0은 해당 배포 산출물 이름)를 가리키고, build context 제외 파일에서 그 산출물만 허용, compose `BRIDGE_IMAGE` 기본값과 `config/docker.example.env`의 이미지 태그가 현재 버전, README.md·README.ko.md 첫 줄이 `# SSH Approval Portal <version>`이고 산출물 이름을 포함 | 파일 내용 대조(CRLF 정규화 후) | packaging | test/release-version.test.mjs:25 | D-0042 |
| RC-B-363 | 원격 MCP JSON 업로드 도구 스키마 | UI 활성/비활성 두 서버에서 tools/list | artifact-begin·chunk·status·finish 모두 노출, inputSchema.additionalProperties=false, `_meta.ui.visibility`가 `['app']`이 아님, `_meta['openai/fileParams']` 없음; begin required = operationKey,target,expectedTargetRevision,fileName,remotePath,size,sha256, properties = 위 + overwrite,elevate, size.maximum=MAX_BYTES; 빈 파일 begin 후 같은 입력 재호출은 같은 id, 같은 operationKey에 다른 remotePath는 isError; begin 응답 키 = id,received,sequence,size,sha256,expiresAt,targetId,targetRevision,maxChunkBytes(=CHUNK_BYTES, sequence 0, received 0); status.state='staging', transfer 키 8개; 부수 효과 0, upload job 0 | 도구 목록·응답 키 집합·부수 효과 카운터 assert | portal-web | test/remote-mcp-upload.test.mjs:72 | D-0007(후보) |
| RC-B-364 | 원격 MCP JSON 업로드 정상 흐름 | linux/windows 대상에 바이너리(CHUNK_BYTES+17바이트), 빈 파일, `[0,255,128,13,10]`, 빈 파일(`C:\\upload\\empty.bin`)을 begin→chunk→finish | id 48자리 hex, begin 응답 targetId·targetRevision 일치, 저장 항목 uploadProtocol=`mcp-json-v1`·fileTargetBound=true; chunk ACK = `{sequence:n+1, received:min(offset+CHUNK_BYTES,len)}`; 스테이징 바이트 일치, 소유자 승인 전 SSH 부수 효과 0·upload job 0; finish 응답 state=pending·kind=upload, operation의 artifactId·fileTargetId·fileTargetRevision·uploadProtocol·overwrite=false·elevate=false 결속; status 'submitted'→승인 후 completed, 원격 게시 바이트·경로 일치; 아티팩트 만료 후에도 status가 completed 요청을 그대로 반환하고 finish가 같은 pending id를 돌려주며 job·게시·효과 수 불변, 예약 byte 0 | 바이트·상태·효과 목록 assert | portal-web, portal-app | test/remote-mcp-upload.test.mjs:95 | D-0012(후보), D-0030(후보) |
| RC-B-365 | 원격 MCP JSON 업로드 begin 입력 거절 | 크기 한도 16바이트 서버; 잘못된 expectedTargetRevision(`f`*64)→`ARTIFACT_STALE_TARGET`; operationKey·target·expectedTargetRevision 누락, 비활성 대상(offline), 없는 대상, size=-1·MAX_BYTES+1·17, sha256 `INVALID`, fileName `../unsafe`, 대상 OS와 안 맞는 remotePath(`C:/wrong-platform.bin`), 상대 경로, overwrite·elevate가 문자열 `'true'`, 추가 필드 `approve:true`; chunk·status·finish에 id `z`*48 및 추가 필드 | 모두 isError=true, 저장 항목 수 0·예약 byte 0, upload job 0, SSH 효과 0 | 거절 코드·store.size·reserved assert | portal-web, portal-app | test/remote-mcp-upload.test.mjs:128 | - |
| RC-B-366 | 원격 MCP JSON 업로드 chunk 규칙 | 바이트 `[0,255,128,65]`; data `''`,`AA`,`AA==\n`,`__8=`,`Zh==`, 비밀 표식 문자열, CHUNK_BYTES+1바이트 base64; sequence -1·0.5·1(0 기대 시점); 같은 chunk 재전송; sequence 0에 다른 데이터, sequence 3, sequence 1에 길이 불일치, 추가 필드 | 비정규 base64·초과는 isError이고 스테이징은 빈 상태 유지; 같은 chunk 재전송은 `{sequence:1,received:2}` 중복 ACK; 충돌·건너뜀·추가 필드는 isError이고 이미 받은 2바이트 보존; status transfer.received=2·sequence=1; 나머지 chunk 후 finish=pending, job 1, 효과 0 | 거절 여부와 스테이징 바이트 assert | portal-web, portal-app | test/remote-mcp-upload.test.mjs:144 | - |
| RC-B-367 | 원격 MCP JSON 업로드 불완전·해시 불일치 finish | 4바이트 중 2바이트만 올린 뒤 finish; 선언 sha256이 다른 데이터를 모두 올린 뒤 finish | 불완전: `ARTIFACT_INCOMPLETE_OR_EXPIRED`, status는 staging·received=2 유지; 해시 불일치: `ARTIFACT_HASH_MISMATCH`, 저장 항목 제거되고 status는 `ARTIFACT_UNKNOWN`; upload job 0, 효과 0, 예약 byte는 남은 불완전 항목(4)만 | 오류 코드·store 상태·reserved assert | portal-web, portal-app | test/remote-mcp-upload.test.mjs:162 | - |
| RC-B-368 | 원격 MCP JSON 업로드 동시 finish·응답 유실 복구 | overwrite=true·elevate=true로 begin 후 완전 업로드, finish 2건 동시 호출, 이후 status·finish 재호출 | 두 호출 모두 성공하고 같은 job id, state=pending, operation.overwrite·elevate=true; upload job은 1개; status.request.id와 재호출 finish id가 같음; 효과 0 | job 수·id 일치 assert | portal-app | test/remote-mcp-upload.test.mjs:176 | - |
| RC-B-369 | 원격 MCP JSON 업로드 ready 복구·타 프로토콜·대상 변경 | (a) 구형 beginUpload로 만든 항목에 status·finish·chunk (b) begin+chunk 후 저장소에서 직접 finish(ready)한 뒤 finish·status (c) begin 후 대상 프로필 host를 변경하고 status·finish·chunk | (a) 모두 `ARTIFACT_WRONG_PROTOCOL`, received 0, job 0; (b) status.state='ready', finish는 pending 요청 1개(artifactId 결속), 재호출 finish·status가 같은 id, job 1; (c) 모두 `ARTIFACT_STALE_TARGET`, received 0, 효과 0, job 수 증가 없음 | 오류 코드·job 수 assert | portal-web, portal-app | test/remote-mcp-upload.test.mjs:186 | - |
| RC-B-370 | 원격 MCP JSON 업로드 인증·공개 실패 불투명 | Authorization 없는 POST tools/call; 없는 id(`a`*48)의 status·finish; beginAgentUpload가 비밀 표식·내부 경로를 담은 예외를 던짐 | 401; `ARTIFACT_UNKNOWN`; `REQUEST_REFUSED`이고 응답에 내부 경로·표식 없음; 저장 항목 0, job 0, 효과 0; 모든 응답에 비밀 토큰·approvalTicket·uploadTicket 문자열 없음 | HTTP 상태·오류 코드·응답 정규식 부재 assert | portal-web | test/remote-mcp-upload.test.mjs:209 | - |
| RC-B-371 | 파일 서비스 아티팩트 만료 | 시계를 주입한 저장소(maxBytes 16, budget 32), beginAgentUpload 후 시계를 expiresAt로 이동 | 만료 전 status='staging', 이동 후 'expired'; append·finish는 거절(throw); received 0 유지; reap 후 저장 항목 0·예약 0; 쓰기·제출 없음 | 상태 문자열·거절·store 카운터 assert | portal-app, portal-store | test/remote-mcp-upload.test.mjs:220 | - |
| RC-B-372 | 요청 입장 제한 기본값·설정 검증 | 기본 생성; 잘못된 한도 `{maxActive:0}`,`1.5`,`Infinity`,`{maxQueued:-1}`,`NaN`,`'2'`,`{maxDetached:-1}`,`MAX_SAFE_INTEGER+1`,`{maxWaitMs:0}`,`2147483648`,`null` | 기본 snapshot = active 0, queued 0, detached 0, closed false, maxActive 8, maxQueued 32, maxDetached 64, maxWaitMs 5000; 잘못된 값은 모두 `Invalid request admission limits` 예외 | snapshot deepEqual, 예외 메시지 | portal-app | test/request-admission.test.mjs:13 | - |
| RC-B-373 | 요청 입장 FIFO | maxActive 1, maxQueued 2; 첫 요청 보유 중 2·3번째 대기, 4번째 요청 | 4번째는 `REQUEST_QUEUE_FULL`; 첫 요청 release 2회(멱등) 뒤 새로 온 요청이 대기자를 앞지르지 않아 부여 순서 second→third→fourth; 중간 snapshot active 1·queued 2, 종료 후 0·0 | 부여 순서 배열 assert | portal-app | test/request-admission.test.mjs:26 | - |
| RC-B-374 | 요청 입장 취소 | (a) 대기 중 요청 취소, 이미 취소된 신호로 acquire, 활성 요청 취소 (b) 대기하던 요청이 부여된 직후 취소 | (a) 대기 요청은 `REQUEST_ABORTED`(메시지 `Request was aborted`, 사유 비공개)로 대기열에서 제거, 이미 취소된 신호도 `REQUEST_ABORTED`, 활성 요청 취소는 슬롯을 유지(active 1·queued 1), 취소 신호 리스너 해제 1회; (b) 부여된 대기자는 취소돼도 슬롯 소유(active 1)이고 release 2회는 멱등 → active 0 | snapshot·오류 코드 assert(Java 대응은 취소 토큰 정리 호출 횟수) | portal-app | test/request-admission.test.mjs:47, test/request-admission.test.mjs:68 | - |
| RC-B-375 | 요청 입장 대기 시간 초과 | (a) maxActive 1·maxWaitMs 5, 다른 요청이 슬롯 보유 중 acquire (b) maxWaitMs 2에서 타이머 콜백이 지연된 상태로 release 후 새 acquire | (a) `REQUEST_QUEUE_TIMEOUT`, 취소 신호 리스너 해제 1회, 대기열 0, 슬롯 보유자는 active 1 유지; (b) 만료된 대기자는 부여되지 않고 `REQUEST_QUEUE_TIMEOUT`, 새 acquire가 슬롯을 받아 active 1 | 오류 코드·snapshot assert(데드라인은 시계 기준 판정) | portal-app | test/request-admission.test.mjs:84, test/request-admission.test.mjs:98 | - |
| RC-B-376 | 요청 입장 detach | maxActive 1·maxQueued 1·maxDetached 1; 첫 요청 detach 2회; 두 번째 요청 detach; 첫 요청 release 2회 후 두 번째 detach | 첫 detach로 detached 1·active 1(승격된 대기자)·queued 0, detach 재호출 멱등; 두 번째 detach는 `REQUEST_WAIT_LIMIT`이고 active 1 유지; 첫 release 후 detached 0; 이후 두 번째 detach 성공(active 0·detached 1), release로 detached 0 | snapshot assert | portal-app | test/request-admission.test.mjs:114 | - |
| RC-B-377 | 요청 입장 close | maxActive 1·maxDetached 1; detach된 요청 1, 활성 요청 1, 대기 acquire 1건 후 close 2회 | 대기자는 `REQUEST_QUEUE_CLOSED`, 이후 acquire도 같은 오류, 활성 요청의 detach는 `REQUEST_QUEUE_CLOSED`; 소유자는 active 1·detached 1·queued 0을 유지하다 release 후 0·0; closed=true | 오류 코드·snapshot assert | portal-app | test/request-admission.test.mjs:138 | - |
| RC-B-378 | 요청 입장 대기·detach 용량 0 | maxActive 2·maxQueued 0·maxDetached 0 | 3번째 acquire는 즉시 `REQUEST_QUEUE_FULL`, detach는 `REQUEST_WAIT_LIMIT`, active 2 유지, release 후 1→0 | 오류 코드·snapshot assert | portal-app | test/request-admission.test.mjs:159 | - |
| RC-B-379 | 요청 용량(requestCapacity) 설정·큐 생성자 검증 | `BRIDGE_REQUEST_CAPACITY` 미설정; `101`(secret 텍스트 경유); `1,99,100,101,1000,1001,9007199254740991`; 잘못된 값 `''`,`0`,`-100`,`1e3`,`100.0`,`0100`,` 100`,`100 `,`100\n`,`Infinity`,`NaN`,`9007199254740992`, 숫자 100; 승인 큐 생성자에 1,99,1001,MAX_SAFE_INTEGER / 0,-1,MAX+1,100.5,Infinity,NaN,`'100'`,null | 기본 100, 정규 양의 안전 정수는 그 값 그대로, 잘못된 값은 모두 `request capacity` 메시지로 거절; 큐 생성자도 같은 규칙(허용 4건 통과, 거절 8건 예외) | 설정 파서·큐 생성자 assert | portal-app, portal-server | test/request-capacity.test.mjs:15 | - |
| RC-B-380 | 요청 용량의 대상별 독립 적용 | 용량 101로 레거시(default) 대상 1개와 명시 대상 alpha·beta·gamma 3개 각각 | 각 대상에 거절(deny)된 요청 101개까지 저장되고 다음 submit은 `Queue full`로 거절; 대상별 jobs.size 101; SSH 실행 없음 | 대상별 큐 크기·예외 assert | portal-app, portal-server | test/request-capacity.test.mjs:26 | - |
| RC-B-381 | 기본 용량 포화 | 기본 용량 100에서 100건 승인·완료 후 101번째 submit | 101번째는 `Queue full`로 거절되며 ID는 100개만 발급, 저장 100건 모두 completed이고 결과 텍스트 `preserved` 보존 | 큐 크기·ID 발급 횟수·결과 assert | portal-app | test/request-capacity.test.mjs:47 | - |
| RC-B-382 | 사용자 지정 용량·종료 요청 보존 1시간 | 용량 1000, 실행 중 1건 + 거부 999건, 시계 이동 | 1000건 상태에서 1001번째는 `Queue full`; 시계 3,600,000ms에서 reap해도 1000 유지, +1ms에서 종료 요청만 제거되어 1건(실행 중)만 남고 state='running'; 완료 후 3,600,000ms까지는 결과 보존, +1ms에서 제거(get=null), 이후 submit은 pending | reap 경계값 assert | portal-app | test/request-capacity.test.mjs:60 | - |
| RC-B-383 | 큰 요청 용량에서도 공통 스케줄러 직렬화 | 용량 101, 요청 2건(`sudo first`,`sudo second`) 모두 start | 둘 다 'queued'로 접수, 실행기는 `sudo first`만 호출(둘째는 대기); 첫 완료 후 둘째 실행; 상태 queued→running→completed 순서, 종료 후 busy=false | 실행 호출 순서·상태 assert | portal-app | test/request-capacity.test.mjs:79 | D-0004(후보) |
| RC-B-384 | MCP 요청 안전성 평가: 인증·소유자 동의 | 인증 없는 POST /mcp; 도구 목록; 소유자 정책 externalDisclosure=false에서 `externalDisclosureApproved:true`를 호출자가 위조해 submit; 같은 정책에서 위조 없이 submit 후 observe | 인증 없음 401; 도구에 `assess-request-risk` 없음; 위조 필드가 있는 submit은 isError, 평가 호출 0; 위조 없는 submit은 성공하고 observe 결과 state='pending'·outputPage=null, 결정 reasonCode=`disclosure_not_enabled`, 평가 호출 0 | HTTP 상태·결정 reasonCode·호출 수 assert | portal-web, portal-app | test/request-safety-http.test.mjs:54 | - |
| RC-B-385 | MCP 요청 안전성 평가: 소유자 동의 후 관찰 전용 | externalDisclosure=true 저장 후 Jev 활성/비활성 각각 command `sudo id`(context 포함) submit·observe·같은 인자 재submit | 두 경우 모두 state='pending'(승인 전), targetId·targetRevision은 바인딩 값; 결정 decision='review', reasonCode = 활성 `observation_only`(assessment.label=`low_risk`) / 비활성 `evaluation_unavailable`(assessment 없음); 재submit은 같은 id; 평가기 호출은 활성 1회·비활성 0회, 평가기에 전달된 input.target='default'·command='sudo id' | 결정·호출 횟수 assert | portal-web, portal-app | test/request-safety-http.test.mjs:54 | - |
| RC-B-386 | 요청 위험 평가: 서버 신원 고정·동시 호출 공유 | 같은 pending 요청에 `first synthetic context`, `later context`로 동시 assess 2건 후 재호출 | 평가기 1회만 호출, 전송 입력 = command `sudo id`·target `test`·environment `시험`, context JSON에 callerSituation='first synthetic context'·serverFacts.sshTarget·profile 포함; 두 결과 assessment 동일·객체는 다름, provenance.cached false/true, 둘째는 additionalContextApplied=false·inputStatus='input_changed_not_reassessed'; subject·targetId·targetRevision 일치, automaticExecutionEnabled=false, 응답의 추가 필드(injectedSecret) 제거; 요청 state는 pending 유지, 재호출해도 1회 | 호출 횟수·전송 payload·provenance assert | portal-app | test/request-safety.test.mjs:13 | - |
| RC-B-387 | 요청 위험 평가: 공급자 실패 | 평가기가 `secret provider diagnostic` 예외 | assessment.reason='request_failed', 재호출 결과 동일(캐시, provenance.cached true·inputStatus 'same_input'), 호출 1회(재시도 없음), 결과에 내부 메시지 없음, 요청 state pending | 예외 은닉·호출 횟수 assert | portal-app | test/request-safety.test.mjs:42 | - |
| RC-B-388 | 요청 위험 평가: 호출 예산 | maxCalls 1; 요청 a를 2회, 요청 b 1회 | a 재호출은 캐시(호출 0), b는 assessment.reason='budget_exhausted', 총 호출 1 | 호출 수 assert | portal-app | test/request-safety.test.mjs:52 | - |
| RC-B-389 | 요청 위험 평가: 호출하지 않는 경우 | 평가기 없음; 알 수 없는 id; 파일(download) 작업; 거부(deny)된 요청 | 평가기 미구성은 assessment.reason='not_configured'; 알 수 없는 id·파일 작업은 `command request` 포함 오류; 거부된 요청은 `pending` 포함 오류; 평가기는 호출되지 않음 | 예외 메시지·호출 부재 assert | portal-app | test/request-safety.test.mjs:59 | - |
| RC-B-390 | Jev 사용 설정값 검증 | `BRIDGE_JEV_ENABLED` 미설정/`true`, `BRIDGE_JEV_MAX_CALLS` 미설정/`3`; 잘못된 값 `TRUE`,`1`,`yes` 및 MAX_CALLS `0`,`1.5`,`1e2`,`10001`,`''` | 기본 jevEnabled=false, jevMaxCalls=100, `true`·`3`은 그대로 반영, 잘못된 값은 모두 설정 오류 | 설정 파서 assert | portal-server | test/request-safety.test.mjs:69 | - |
| RC-B-391 | 요청 위험 평가: 완료 요청의 이력 출처 | 평가 후 요청 deny, 시계 100→900, 새 context로 재평가 | 첫 결과 provenance.assessedAt=100·requestState='pending'·storedContextProvided=true; 재평가는 assessedAt 100 유지, historical=true, additionalContextApplied=false, 호출 1회(유료 재시도 없음), assessment 동일 | provenance·호출 수 assert | portal-app | test/request-safety.test.mjs:78 | - |
| RC-B-392 | 보관 이력: 오래된 명령 기간 조회 | 장부 저장 명령 1건(createdAt 1000, 결과 텍스트·data에 비밀 표식) 조회 `from=0&to=86400000` | items[0].id 일치, history.stateSource='journal'·storage='command', result.content=[], 응답에 비밀 표식 없음, coverage.snapshot=false, coverage.fileHistory='memory-only', 응답에 `total` 필드 없음 | 응답 필드·정규식 부재 assert | portal-app, portal-store, portal-web | test/retained-history.test.mjs:28 | D-0017(후보) |
| RC-B-394 | 보관 이력: 같은 생성시각 페이지 순회 | 생성시각 같은 41건, 한 페이지 기본 20건, 첫 조회 뒤 새 항목(createdAt 3000) 추가·시계 5000, nextCursor로 이어서 조회 | 1페이지 id = id(41)…id(22) 내림차순 20건, 2페이지 id(21)…id(2) 20건, 3페이지 id(1) 1건·nextCursor=null, 41건 중복 없이 방문, 2페이지 asOf=2000·observedAt=5000(새 항목 미포함) | 페이지 id 순서·asOf assert | portal-app | test/retained-history.test.mjs:50 | - |
| RC-B-395 | 보관 이력: 기간 경계·입력 검증 | createdAt 999/1000/2000 3건 `from=1000&to=2000`; 21건 커서에 `q=changed` 추가; `from=1.5`·`9007199254740992`·`from=2&to=2`; `target=alpha&target=alpha`, `limit=100`; 커서 `''`,`a=`,2049자,`{}` base64url; 검색어 `가`*201 / `😀`*200; `state=running` | 포함 하한·제외 상한(id(2)만); 조건 변경 커서 `HISTORY_INVALID_CURSOR`; 범위 오류 `HISTORY_INVALID_RANGE`; 중복 필드·알 수 없는 필드 `HISTORY_INVALID_FIELDS`; 비정규 커서 `HISTORY_INVALID_CURSOR`; 검색어 201자 `HISTORY_SEARCH_TOO_LARGE`, 이모지 200개는 허용(결과 빔); `state=running` `HISTORY_INVALID_FILTER`; 모두 HTTP 400 | 오류 historyCode·status assert | portal-app, portal-web | test/retained-history.test.mjs:65, test/retained-history.test.mjs:73 | - |
| RC-B-396 | 보관 이력: 대상 결속 표시 | 대상 revision 변경(`b`*64)·미등록 대상(removed)·사용 중지 대상 | 미등록 대상 항목 제외(id(1)만), 항목 targetRevision은 기록 당시 값, history.targetStatus='changed', coverage.registeredTargetsOnly=true; 사용 중지 대상은 targetStatus='disabled' | 항목·표시 assert | portal-app | test/retained-history.test.mjs:82 | - |
| RC-B-397 | 보관 이력: 도구(CLI) 장부 범위 | CLI 장부 5건(정상, 연결 revision 불일치, 프로필 불일치, 알 수 없는 공급자, 미등록 대상); verifyCliTarget이 통과/예외 | 현재 활성 대상·연결 revision·프로필·공급자가 모두 맞는 id(1)만 노출, history.storage='cli', 검증 호출 1회, coverage.cliCurrentBindingOnly=true; 대상 비활성이면 빈 결과; verify가 예외를 던지면 빈 결과·coverage.metadataIncomplete=true | 항목·coverage assert | portal-app | test/retained-history.test.mjs:95 | - |
| RC-B-399 | 보관 이력: 응답 바이트 상한 | 9000자 한글 명령 20건; command에 `HISTORY_RESPONSE_BYTES` 크기 extra를 가진 1건 | 각 페이지 JSON UTF-8 바이트 ≤ `HISTORY_RESPONSE_BYTES`, 페이지당 1건 이상 20건 미만, 커서로 전체 20건을 중복 없이 id(20)…id(1) 순회; 단일 거대 행은 `HISTORY_ENTRY_TOO_LARGE` HTTP 413 | 바이트 수·순회 id assert | portal-app | test/retained-history.test.mjs:119 | - |
| RC-B-402 | 관리자 이력 경로 인증·정적 경로 분류 | 토큰 모드: `/api/history` 인증 없음, Bearer 정상, Bearer+다른 Origin; access 모드: 세션 없음; 정적 경로 `/settings`,`/bridge`,`/preferences`,`/servers` | 인증 없음 401, 정상 allowed=true, 다른 Origin 403, access 모드 세션 없음 401; 정적 경로는 `{allowed:true, routeKind:'static'}` | 인가 결과 deepEqual | portal-web | test/retained-history.test.mjs:181 | - |
| RC-B-403 | 이력·요청 조회 읽기 전용 및 동시 승인 | 보관 요청 N건(100·1000·10000) 복원 + pending 1건; `/api/requests`와 `/api/history` 번갈아 7회 조회; 조회와 동시에 `/api/<id>/approve`(Prefer: respond-async) | 조회는 감사·실행 0회, 보관 행 해시·DB 파일 해시·파일 목록 불변; `/api/requests`는 N+1건, `/api/history`는 20건·바이트 ≤ HISTORY_RESPONSE_BYTES·coverage.snapshot=false; 승인은 HTTP 202·state='queued'·targetRevision 일치, 이어서 실행 1회·running→completed, 승인당 감사 순서 `execution-queued`,`approved`,`completed`(3회); 조회와 승인 요청의 시간 구간이 겹침; 지연 수치는 진단만 기록(임계 assert 없음) | 응답 상태·감사 목록·해시 assert | portal-web, portal-app, portal-store | test/retained-history.test.mjs:218 | D-0017(후보) |
| RC-B-404 | 롤백 스크립트의 정지된 설치 거절 | 서비스가 `is-active` 종료 코드 3(정지)인 상태에서 rollback 스크립트에 백업 디렉터리 지정 | 스크립트가 0이 아닌 종료 코드, 출력에 `independently verified offline rollback is required`, systemctl 다른 호출 없음(trace 없음), app 파일 교체·approval-bridge 생성 없음, 원본 마커 유지 | 종료 코드·출력·파일 상태 assert | packaging | test/rollback-stopped.test.mjs:6 | - |
| RC-B-405 | 런타임 용량 저장·상속·축소 | 설정 `{queueCapacity:40,maxConcurrency:4,alpha 7}` 또는 `{20, 2, windows maxConcurrency 1}`; 전역 1·1로 축소하고 alpha를 null(상속)로; 저장 후 재기동; 전역 3·1·windows null 후 충돌 호출 | 초기 effective alpha = {queueCapacity 7, maxConcurrency 4}; 축소 결과 status={queued 3, running 2}, effective={1,1}, 스케줄러 구성 = `{queueCapacity:1, globalConcurrency:1, targetQueueCapacity:{alpha:1,beta:1}, targetConcurrency:{alpha:1,beta:1}}`, 기존 작업 취소 없음; 재기동해도 revision·settings·target 값이 유지(다른 전역 설정이 와도 저장값 우선, alpha.queueCapacity=null); 오래된 revision의 set은 `CAPACITY_REVISION_CONFLICT`이고 windows 동시성 1 유지 | 저장값·스케줄러 구성 deepEqual | portal-app, portal-store | test/runtime-capacity-180.test.mjs:20, test/runtime-capacity.test.mjs:26 | - |
| RC-B-406 | 런타임 용량 CAS·유지보수·검증·감사 실패 | 같은 저장소를 쓰는 두 핸들; 같은 revision으로 연속 set; 유지보수 중 set; 잘못된 패치 `{queueCapacity:0}`,`{targets:[null]}`,`{id:'missing'}`; 감사가 예외 | 오래된 revision은 두 핸들 모두 `CAPACITY_REVISION_CONFLICT`이고 두 번째 스케줄러는 구성 변경 없음; 유지보수 중 `MAINTENANCE_ACTIVE`; 검증 실패는 예외; 감사 실패(`fixture audit failure`)면 값이 바뀌지 않고(get이 저장본과 동일) 스케줄러 구성 횟수 2 유지, 저장소 revision은 저장본 | 예외 코드·상태 불변 assert | portal-app, portal-store | test/runtime-capacity-180.test.mjs:38 | - |
| RC-B-407 | 저장된 용량 손상 시 상태 포트 정리 | 저장된 값이 `{}`, `{revision:'bad',...}`, targets:[null], target queueCapacity 0 | 생성이 예외, 상태 포트 close 호출됨, 스케줄러 구성 0회 | 예외·close 플래그 assert | portal-app, portal-store | test/runtime-capacity-180.test.mjs:64 | - |
| RC-B-408 | 용량 저장소 손상 JSON·비공개 아님 | 저장 행에 `{invalid` | 생성·read가 구문 오류로 실패하고 저장 내용은 교체되지 않음; 원 시험은 POSIX에서 파일 모드 0644이면 `UNSAFE_CAPACITY_STORE`로 거절(3.0은 H2 파일 사용이므로 모드 검사 유지 여부는 메인 판단, 손상 값 거절은 필수) | 예외 종류 assert | portal-store | test/runtime-capacity-180.test.mjs:74 | - |
| RC-B-409 | 구성에서 제거된 대상의 용량 보존 | 대상 windows에 queueCapacity 7 저장 후 대상 목록에서 제거하고 기동; 없는 대상 `absent` set; 재기동 | 기동 성공, 목록은 linux만; linux 전역 set 성공; `absent`는 `UNKNOWN_CAPACITY_TARGET`; windows를 다시 구성하면 queueCapacity 7이 남아 있음 | 목록·값 assert | portal-app, portal-store | test/runtime-capacity.test.mjs:38 | - |
| RC-B-410 | 용량 축소 시 작업 불변·잘못된 설정·유지보수 쓰기 | 실행 1·대기 1 작업 상태에서 전역 1·1로 축소; settings `[]`,`3`,`true`,`'bad'`,`null`,`{maxConcurrency:0}`; 유지보수 중 set | 작업 목록 불변, 스케줄러 globalConcurrency 1; 잘못된 settings는 모두 예외·저장본 불변; 유지보수 중 `MAINTENANCE_ACTIVE`·저장본 불변 | 작업·저장본 deepEqual | portal-app | test/runtime-capacity.test.mjs:50 | - |
| RC-B-411 | Jev 요청 형식 | 평가 입력 `{command:'id -u', target:'fixture-a', environment:'synthetic Linux', context:'uid inspection'}` + 추가 필드(expected,privateNote,preapprovedCommands,userApproval); 독립 고정 요청 서버가 GET 405, 다른 경로 404, 잘못된 Bearer 401, content-type text/plain 415, 깨진 JSON 400, model `jev-latest`·state.expected·question type `noul`·추가 질문·criteria 추가(needed, uncertain) 422 | 요청은 POST·JEV_ENDPOINT·redirect error·`Authorization: Bearer <key>`, 본문 = `{model:'jev-1.14.0', state:{command,target,environment,context}, questions:{risk:SAFETY_QUESTION}}`, 비밀 키·expected·privateNote 본문 없음, 응답 파싱 결과 = `{status:'assessed',model:'jev-1.14.0',label:'low_risk',confidence:1,probabilities:{low_risk:1,high_risk:0},inputTokens:20,outputTokens:4}`, 호출 1회; 고정 서버는 위 변형 11건을 해당 상태로 거절하고 정상 요청만 유효 기록 1건 | 요청 본문 deepEqual·고정 서버 상태 코드 | portal-web | test/safety.test.mjs:20, test/safety-http.test.mjs:15 | - |
| RC-B-412 | Jev 명령 정책 평가: 명시 승인·등록 제안 전송 | question=AUTOMATION_QUESTION·inputKind execution에 preapprovedCommands `['id','sudo']`와 일치하는 userApproval, threshold·ownerToken; 미일치 명령 집합; 위조 statement·`id;rm`·중복·userApproval 누락; 등록(COMMAND_SET_QUESTION)에 proposedCommands | 일치 시 state에 preapprovedCommands·userApproval.explicit=true·statement=`The user has explicitly approved this command.`, threshold·ownerToken은 전송 안 함; 미일치는 explicit=false; 위조·형식 오류·중복·누락은 reason='invalid_input'(전송 없음, 총 전송 2건); 등록 전송은 proposedCommands `['sudo','rm']`만, userApproval·preapprovedCommands 없음 | 전송 본문 assert | portal-web, portal-domain | test/safety.test.mjs:35 | - |
| RC-B-413 | Jev 키 없음·잘못된 입력은 전송 0 | apiKey 없음; 입력 null, `{}`, command `''`, context 12289자 | 키 없음 reason='not_configured', 나머지 reason='invalid_input', 외부 호출 0 | 호출 수 assert | portal-web | test/safety.test.mjs:56 | - |
| RC-B-414 | Jev 응답 검증(비정상 응답은 assessed 불가) | 응답 변형: model `jev-latest`·model 없음·answers.risk.type `noul`·추가 answers·choice `safe`/`uncertain`·confidence `'1'`/1.01·probabilities 음수·합 불일치(0.1+0 / 0.1+0.9)·추가·누락 키·usage 소수·음수·누락; 정상 응답이 조각(분할 전송)으로 도착; model `jev-1.13.0`·추가 answers 키·잘못된 answer type | 모든 변형은 status='unavailable'·reason='invalid_response'; 고정 서버 경유 시 진단 `MODEL_MISMATCH`,`ANSWER_KEYS`,`ANSWER_TYPE`가 각각 `{status:'unavailable',reason:'invalid_response',diagnostic}`; 분할 전송 정상 응답은 assessed로 복호; 이어서 정상 요청이 복구; 서버 기록 5건 | 결과 deepEqual | portal-web | test/safety.test.mjs:64, test/safety-http.test.mjs:57 | D-0037(후보) |
| RC-B-415 | Jev HTTP 오류·리다이렉트: 단일 시도·본문 비공개 | 상태 401·429·500·529(본문 `synthetic-secret`/`private-error-body`); fetch가 예외(`synthetic-secret`); 307 + Location | 각각 `{status:'unavailable', reason:'http_error'}`(호출 1회, 재시도 없음), 예외는 `reason:'request_failed'`, 리다이렉트는 따라가지 않고 `request_failed`(대상 접속 0, 서버 기록 1건·경로 `/v1/systemone`); 오류 본문·키·헤더는 결과에 없음 | 결과 deepEqual·호출 수 | portal-web | test/safety.test.mjs:81, test/safety-http.test.mjs:72, test/safety-http.test.mjs:81 | - |
| RC-B-416 | Jev 응답 크기·형식 한도 | content-type 없는 `{}`; 깨진 JSON; 잘못된 UTF-8 바이트 `[255]`; 65537바이트 본문; 청크 응답 32768+32769바이트 이후 다음 요청 | 각각 reason `invalid_response`, `request_failed`, `request_failed`, `response_too_large`; 64KiB 초과 청크 응답은 `response_too_large`이고 다음 요청은 정상 assessed(서버 기록 2건) | reason assert | portal-web | test/safety.test.mjs:91, test/safety-http.test.mjs:89 | - |
| RC-B-417 | Jev 동시 호출 거절·호출자 변조 격리 | 첫 요청이 전송 중일 때 입력 객체의 command를 `rm -rf /`로 변조하고 둘째 요청 | 둘째는 즉시 reason='busy', 전송된 본문 state.command는 `id -u` 유지, 첫 요청은 assessed, 이후 요청도 assessed | reason·본문 assert | portal-web | test/safety.test.mjs:101 | - |
| RC-B-418 | Jev 시간 초과·응답 닫기·복구 | timeoutMs 15: 헤더 대기 중단, 본문 일부만 전송 후 중단; 고정 서버 timeoutMs 500에서 hold=headers/body | reason='timeout', 요청 신호 abort됨, 중단된 호출이 끝나기 전까지 둘째 호출은 reason='busy'(호출 1회); 본문 스트림 cancel 호출됨; 서버 보유 응답 1건이 닫히고 대기열에 중복 요청이 쌓이지 않으며(서버 기록 1) 이후 요청은 assessed(기록 2) | reason·cancel·서버 기록 assert | portal-web | test/safety.test.mjs:111, test/safety.test.mjs:122, test/safety-http.test.mjs:98 | - |
| RC-B-419 | Jev 후보 임계값 판정 | valid 평가(label low_risk, confidence 1); confidence 0.989; probabilities {0.998,0.002}; label high_risk; confidence NaN; inputTokens Infinity | candidateMatch는 정상만 true, 나머지 false; validateAssessment(Infinity)=null; SAFETY_PROTOCOL.automaticExecutionEnabled=false·thresholdStatus='unvalidated' | 불리언·상수 assert | portal-domain | test/safety.test.mjs:131 | - |
| RC-B-422 | 안전성 평가 주입 전송 경로 | mode live + apiKey + 주입 fetch(모든 응답 low_risk 고정) 20사례; 임시 고정 서버 경유 | 호출 20회, 전송 state 키 = command,target,environment,context(근거·expected·id 없음), correct 6·incorrect 14·falseCandidates 14, usage {400, 80}, source='simulated'(주입 전송은 실모델 평가로 보고 안 함), modelQualityStatus='NOT_MEASURED', transport='injected', stage5Ready=false, protocol.automaticExecutionEnabled=false, 보고서에 키·명령 없음 | 호출 수·수치 assert | portal-app, portal-web | test/safety.test.mjs:173, test/safety-http.test.mjs:42 | - |
| RC-B-424 | 비밀 CLI TTY 등록·교체·취소(Linux) | 실제 의사 터미널에서 `set secret://local-file/model-key`를 값 입력 후 Enter, 다른 값으로 교체, 취소(Ctrl-C), status | 등록 시 출력에 `"stored":true`·값 에코 없음·종료 0; 교체 후 revision이 달라짐; 취소는 종료 1·`input_cancelled`이고 직전 값·파일 내용 보존; status는 present=true, 출력에 `synthetic-` 값 없음 | PTY 출력·저장 파일 assert(Linux 전용) | portal-server | test/secret-cli-pty.test.mjs:6 | - |
| RC-B-425 | 비밀 참조 해석: Jev 키 성공 경로 | 모드 reference(`BRIDGE_JEV_KEY_REF=secret://another-vendor/model-key`)·environment(`JEV_API_KEY` 환경 변수); 소유자 externalDisclosure=true; submit 후 observe | 도구 이름에 secret 없음; reference는 해석기 1회 호출·환경 변수 모드는 0회; 외부 호출 1회에 `Authorization: Bearer <값>`; 결정 decision='review'·reasonCode='observation_only'·assessment.label='low_risk', 요청 state pending; 결과·결정·감사 어디에도 비밀 값 없음 | 호출 수·결정·정규식 부재 assert | portal-web, portal-app | test/secret-integration.test.mjs:52 | - |
| RC-B-426 | 비밀 참조 해석: 실패 닫힘 | 모드 missing(해석기가 비밀 표식 예외)·disabled(`BRIDGE_JEV_ENABLED=false`) | missing은 해석기 1회·외부 호출 0, disabled는 해석기 0·외부 호출 0; 결정 reasonCode='evaluation_unavailable'·assessment 없음, 요청 state pending; 결과·결정·감사에 비밀 표식 없음 | 호출 수·reasonCode assert | portal-web, portal-app | test/secret-integration.test.mjs:52 | - |
| RC-B-427 | 로컬 비밀 저장소: 신뢰할 수 없는 쓰기 가능 상위 디렉터리 | 상위 디렉터리를 0777으로 변경(루트 실행 시 다른 소유자로 chown) 후 init·read·put·remove | 모두 `unsafe_store`로 거절, 권한 복원 후 기존 값 `synthetic-old` 보존, 디렉터리 목록 = `.gitignore`, `key.json` (POSIX 전용) | 오류 코드·파일 목록 assert | portal-server | test/secret-io-failures.test.mjs:24 | - |
| RC-B-428 | 로컬 비밀 저장소: 커밋 전 실패(write·file-sync·rename) | put 중 임시 파일 write 실패(일부 기록 후 EIO)·sync 실패·rename 실패 | 각각 `EIO`로 거절, 기존 값·revision 불변(describe 동일), 디렉터리에 임시(.pending-*) 파일 없음 (POSIX 전용) | 오류 코드·값·목록 assert | portal-server | test/secret-io-failures.test.mjs:45 | - |
| RC-B-429 | 로컬 비밀 저장소: 커밋 후 디렉터리 sync 실패 | put·remove 중 디렉터리 sync가 EIO; put 중 디렉터리 sync 실패에 쓰기 잠금 해제도 실패 | `commit_uncertain`으로 거절하되 결과는 반영(put은 새 값·revision 변경, remove는 값 없음); 잠금 정리 성공 시 .pending·.write-lock 없음; 잠금 정리 실패 시에도 `commit_uncertain`이 가려지지 않고 이후 put은 `store_busy` | 오류 코드·값·목록 assert | portal-server | test/secret-io-failures.test.mjs:61, test/secret-io-failures.test.mjs:91 | - |
| RC-B-430 | 로컬 비밀 저장소: 정리 오류와 주 오류 | rename 실패(EIO)이고 임시·잠금 unlink도 EACCES; 이후 고정 정리 뒤 커밋 성공이지만 정리 실패 | 첫 put은 주 오류 `EIO` 유지·기존 값 보존·.pending 파일 잔존; 다음 put은 `store_busy`; 정리 후 커밋 성공이지만 정리 실패면 `commit_uncertain`이고 새 값 읽힘; 이후 remove는 `store_busy` | 오류 코드·값 assert | portal-server | test/secret-io-failures.test.mjs:74 | - |
| RC-B-431 | 로컬 비밀 저장소: 쓰기 프로세스 강제 종료 | 별도 프로세스가 스테이징 후 SIGKILL | 기존 완전한 레코드 `synthetic-old`·revision 보존, .pending- 파일 1개(모드 0600), 이후 put·remove는 `store_busy`(오래된 잠금), 자식 출력에 비밀 값 없음 (POSIX 전용) | 값·파일 모드·오류 코드 assert | portal-server | test/secret-io-failures.test.mjs:103 | - |
| RC-B-432 | 비밀 참조 파싱·공급자 선택 | `secret://local-file/model-safety`, `secret://another-vendor/model-safety`, 공급자 미등록 `secret://unknown/key`; 잘못된 참조 `https://example.test/key`, `secret://local-file/../key`, `%2e%2e`, `?query`, `/key/child`, `secret://LOCAL/key`, 이름 65자 | 등록 공급자는 `synthetic-model-safety` 반환(공급자별 가정 없음), 미등록은 `provider_unavailable`, 잘못된 참조는 모두 `invalid_reference` | 반환값·오류 코드 assert | portal-app | test/secret-service.test.mjs:9 | - |
| RC-B-433 | 숨김 입력 | 터미널 입력으로 `synthetic-DO-NOT-ECHO` Enter 또는 Ctrl-C; 터미널 아님; 입력 EOF·출력 오류 | 출력은 프롬프트 `Secret: `와 개행만, raw 모드 켜기 후 끄기 보장; 정상은 값 반환, Ctrl-C는 `input_cancelled`; 터미널 아님 `terminal_required`; EOF·출력 오류도 `input_cancelled`이고 터미널 상태 복원 | 출력 문자열·모드 호출 assert | portal-server | test/secret-service.test.mjs:19 | - |
| RC-B-434 | 비밀 CLI는 파이프·값 인수를 거절 | `set secret://local-file/model-key`에 표준입력으로 값 주입; `--value <값>` 인수 | 종료 코드 1, 출력에 값 없음, stderr에 `terminal_required` 또는 `invalid_arguments` | 종료 코드·stderr assert | portal-server | test/secret-service.test.mjs:42 | - |
| RC-B-435 | Compose 비밀 파일 설정 결속 | 파일에 주석·`BRIDGE_ADMIN_TOKEN="synthetic-only"`·`BRIDGE_UI_ENABLED=false`·`SSH_MCP_AWS_LOCAL_PASSPHRASE=...`; 이어서 `NODE_OPTIONS=--inspect` | 따옴표 제거한 값으로 서버 설정에 결속(셸 평가 없음), 허용 목록 밖 키(`NODE_OPTIONS` 등)가 있으면 로드 실패 (3.0은 허용되지 않는 키 거절로 이식) | 설정 값·예외 assert | portal-server | test/secrets.test.mjs:7 | - |
| RC-B-436 | 종료: 미완료 HTTP 본문 | 관리자 POST `/api/environment`가 Content-Length 1000인데 `{`만 보내고 중단, close 호출 | close가 7초 안에 끝나고(클라이언트 완료를 기다리지 않음), close 재호출은 같은 진행 약속, 연결 레지스트리 정리됨 | 시간 상한·정리 플래그 assert | portal-server | test/shutdown.test.mjs:26 | - |
| RC-B-437 | 종료: 정상 진행 응답 유예 | 환경 조회 응답이 처리 중일 때 close, 이후 처리 완료 | close 중에도 연결 정리는 응답 완료 전에는 일어나지 않고, 응답은 HTTP 200·marker `response-preserved`, 완료 후 정리됨 | 응답·정리 시점 assert | portal-server | test/shutdown.test.mjs:43 | - |
| RC-B-438 | 모듈 경계 규칙(구조 검사) | 소스 구조 검사: 안쪽 계층(domain·application) 소스 | 안쪽 계층은 바깥 어댑터·인프라에 의존하지 않고(허용: 계약·domain, application은 application; 암호 해시용 표준 라이브러리 예외 지정 클래스만), 전송 DTO(structuredContent·_meta·download_url·file_id·statusCode)나 저장소 내부(store.items·reserved·pinned·state)를 노출·조작하지 않음 → 3.0은 portal-domain·portal-app이 portal-web·portal-store·portal-ssh·Spring Web에 의존하지 않는 ArchUnit(또는 Gradle 의존 검사)와 호스트 DTO 비노출 검사로 이식 | ArchUnit 규칙 위반 0 | portal-domain, portal-app | test/solid-architecture.test.mjs:38 | - |
| RC-B-440 | 업로드 스테이징 기본 예산 | 기본 저장소: 건당 최대 64MiB·예산 512MiB, 64MiB 항목 8개 begin 후 9번째 | maxBytes=67108864·budget=536870912, 8개 예약 시 reserved=budget·size 8(내용 할당 없음), 9번째는 `Staging budget exhausted`로 거절·상태 불변, 전부 제거 후 reserved 0·size 0·활성 작업 없음 | 숫자·예외 assert | portal-app, portal-store | test/solid-architecture.test.mjs:99 | - |
| RC-B-441 | 공개 경계 회귀 AP-01: 만료 감사 실패에도 서비스 유지 | submit(command `printf fixture-never-execute`, operationKey `solid-expiry-key-0001`) 후 시계 +3,600,001ms, 만료 감사가 예외 | `/health` 200·pending 0, 만료 감사 시도 정확히 1회(재시도 안 함), 큐 항목 auditError에 `must not be retried`; observe state='expired'·auditFailure=true; 응답에 감사 예외 메시지 없음; 관리자 approve는 409, 실행 0 | HTTP 상태·상태 문자열 assert | portal-web, portal-app | test/solid-regressions.test.mjs:14 | - |
| RC-B-442 | 공개 경계 회귀 AP-02: 읽기 명령 실행기 예외 | maxConcurrency 1, `id fail-read` 실행기가 예외, 조회 키 id·operationKey 각각; 이후 `id recovered` | 상태 'unknown'·failed=true·failureCode='OPERATION_FAILED'·remoteOutcome='unknown', 비공개 예외 문자열 응답에 없음, 감사 순서 `submitted`,`execution-queued`,`policy-execution-started`,`unknown`; 같은 operationKey 재제출은 같은 id·state 'unknown'이고 실행기를 다시 호출하지 않음; health.busy=false; 후속 `id recovered`는 completed·outputPage.text='read-ok' | 상태·감사 목록·실행 횟수 assert | portal-web, portal-app | test/solid-regressions.test.mjs:14 | - |
| RC-B-443 | 공개 경계 회귀 AUTH-01: 관리자 origin 정규형 | BRIDGE_ADMIN_ORIGIN = `https://example.test?mode=1`, `#fragment`, `https://user@example.test`, `https://EXAMPLE.test`, `https://example.test:443`; 정상 `https://example.test:4443` | 비정규 origin 5건은 기동 단계에서 거절, 사용자 지정 포트 origin은 기동 성공 | 기동 예외 assert | portal-server | test/solid-regressions.test.mjs:14 | - |
| RC-B-444 | 공개 경계 회귀 DELIVERY-01: 유지보수 CLI의 관리자 포트 사용 | 설정 파일의 BRIDGE_ADMIN_PORT를 임시 서버로 지정하고 `maintenance reserve`에 소유자 토큰(`a`*64) 표준입력 | 순서대로 POST `/api/maintenance/capabilities`, `/api/maintenance/reserve` 2회만 호출, Origin·`Authorization: Bearer`·`X-Maintenance-Owner` 헤더 일치, 종료 코드 0, 다른 목적지 접속 없음 | 서버 수신 요청·종료 코드 assert | packaging, portal-server | test/solid-regressions.test.mjs:14 | - |
| RC-B-445 | 공개 경계 회귀 DELIVERY-02: 설치된 의존성 전체 고지문 | 같은 이름의 다른 버전이 중첩된 의존성 5개(alpha 1.0.0, @fixture/shared 1.0.0·2.0.0·3.0.0, ui-alpha 1.0.0)와 LICENSE | 고지문 생성기가 종료 0이고 출력 JSON의 `name@version` 집합이 설치된 5개와 정확히 일치(중첩 버전 모두 포함) (3.0은 Gradle 해석 의존성 전체에 대한 고지문으로 이식) | 이름@버전 집합 deepEqual | packaging | test/solid-regressions.test.mjs:14 | - |
| RC-B-446 | 공개 경계 회귀 DELIVERY-03: compose env의 UID/GID 갱신 보존 | CRLF 파일: 주석 `# owner-selected image`, BRIDGE_UID=11, BRIDGE_GID=12, BRIDGE_IMAGE=`fixture-image@sha256:`+`a`*64, EXTRA_SETTING=keep-this-value; 인수 UID 10001·GID 10002 | 종료 0, UID·GID만 10001·10002로 바뀌고 이미지·주석·추가 설정·CRLF 줄바꿈이 그대로 보존 (3.0은 설치 도우미에서 Java로 이식) | 파일 바이트 비교 | packaging | test/solid-regressions.test.mjs:14 | - |

### G06 (원자료 1665~1776: source-automation ~ web-session, mjs 112행)

| 사례 ID | 대상 기능 | 입력·조건 | 기대 결과 | 판정 방법 | 3.0 모듈 | 원 시험 | 연결 결함 |
|---|---|---|---|---|---|---|---|
| RC-B-451 | MCP submit(kind:source) 자동 승인 경로: Jev HTTP 어댑터 1회 호출 후 동일 바인딩 실행기로 1회 실행, 원문의 공개·영속 사본 없음 | 정책: commands [python3, sudo], automaticSudo true, sourceExecutionContract 'python-source-v1', externalDisclosure true, modelExecution true, thresholds.jev.minLowRisk 0.7. 실제 MCP 클라이언트가 submit {kind:'source', source:"# PRIVATE_BODY_SOURCE_32\nprint('한글 literal source')\n", argv:['literal 한글'], cwd:'/tmp', elevate:true, context, displayContext:'합성 시험 · 원문 출력만 확인', operationKey:'source-mcp-once-0001'} 호출. Jev 응답은 가짜 HTTP로 {model:'jev-1.14.0', label low_risk, confidence 0.1, probabilities low_risk 0.8/high_risk 0.2} | isError 없음. 작업 state 'completed', approvalMode 'automatic', decision.reasonCode 'model_passed', decision.threshold.minLowRisk 0.7. 모델 호출 1회·실행 1회. 모델 payload.state.context(JSON).submittedSource.source == 원문, .manifest == 실행 plan.manifest, .planDigest == plan.planDigest. plan.stdin == 원문, plan.manifest.elevate true, plan.command이 `'sudo' '-n' '--' '/usr/bin/python3'`로 시작. payload.state.userApproval.explicit false, preapprovedCommands [], payload에 displayContext('합성 시험') 없음. 같은 operationKey·인수로 submit 재호출하면 같은 id, 모델 호출은 계속 1회. submit·observe·감사 이벤트·GET /api/requests 직렬화에 'PRIVATE_BODY_SOURCE_32' 없음. 영속 저장소 파일에 원문 바이트 없음. GET /api/{id}/source는 409. GET /api/outputs/{output.id}의 text 'synthetic output'. 출력 저장소 행(binding.executionId == job.id)의 binding.operationDigest == plan.planDigest | 위 값 전부 assert(JSON 직렬화 문자열 부재 검사 포함). 저장소 파일 부재 검사는 H2 파일·테이블 덤프에서 원문 부재로 대체 | portal-web, portal-app, portal-domain, portal-store | test/source-automation.test.mjs:66 | - |
| RC-B-452 | source 실행 opt-in 단계: 승인된 python3/sudo 명령명·외부 공개 동의와 별개로 sourceExecutionContract가 필요 | 정책 sourceExecutionContract를 undefined 또는 null로 저장 후 runSource, 이어서 externalDisclosure false로 저장 후 runSource. 정책에 sourceExecutionContract 'unknown'을 담아 review 호출 | 계약 undefined/null: 작업 state 'pending', decision.reasonCode 'source_execution_not_enabled'. externalDisclosure false: decision.reasonCode 'disclosure_not_enabled'. 두 경우 모두 모델 입력 0건·실행 0건. 알 수 없는 sourceExecutionContract 'unknown'의 review는 HTTP 409 | state·reasonCode·모델/실행 호출 수·HTTP 409 assert | portal-domain, portal-app, portal-web | test/source-automation.test.mjs:101 | - |
| RC-B-453 | source 자동 실행의 sudo·거부 정책 우회 방지 | (a) automaticSudo false, elevate 기본 source (b) deniedCommands ['rm'] 정책에서 평범한 source (c) 같은 정책에서 source "import subprocess\nsubprocess.run(['rm','/tmp/example'])\n" | (a) decision.reasonCode 'source_privilege_policy_review' (b) 'source_command_policy_review' (c) state 'denied', reasonCode 'policy_denied'. 모델 입력 0·실행 0. denied 작업의 GET /api/{id}/source는 409 | 세 reasonCode·state·호출 수·409 assert | portal-domain, portal-app, portal-web | test/source-automation.test.mjs:114 | - |
| RC-B-454 | 대기 중 source 검토 원문 보호: 소유자 승인 시 방출 | sourceExecutionContract null 정책으로 pending source 1건 생성. 요청 안전성 관찰자(assess)로 평가 시도. GET /api/{id}/source를 토큰 없음·MCP 토큰·소유자 토큰으로 호출. 이어서 소유자 approve | 관찰자 평가는 /recorded source evaluation/ 오류로 거절되고 모델 호출 0. 토큰 없음·MCP 토큰은 401. 소유자는 200, body.source == 원문, Cache-Control 'no-store'. 응용 계층 source(id)도 원문 반환. approve 200 후 approvalMode 'owner', 실행 1회, 이후 GET /api/{id}/source는 409 | HTTP 코드·헤더·본문·실행 수 assert | portal-web, portal-app, portal-domain | test/source-automation.test.mjs:124 | - |
| RC-B-455 | source 확률 임계값은 사용자별 유지, 비호의 유효 응답은 fallback으로 재시도하지 않음 | jev 평가 응답은 항상 low_risk 확률 0.8. fallback 'luna'(호출되면 카운트) 설정. 임계값 jev.minLowRisk를 0.8, 0.9, 0.7로 차례 저장하고 매번 runSource | 0.8 → state 'completed', 0.9 → 'pending', 0.7 → 'completed'. 매번 decision.threshold.minLowRisk == 저장한 값. fallback(luna) 호출 0회. 실행 총 2회 | state·threshold·호출 수 assert | portal-domain, portal-app | test/source-automation.test.mjs:138 | - |
| RC-B-456 | source 요청 키 충돌 결속과 재시작 후 비밀 원문 미복원·재실행 금지 | sourceExecutionContract null 정책, requestKey 'source-pending-key-0001'로 pending 생성. 같은 키에 source에 '\n' 추가, argv ['different'], cwd '/', elevate true, context에 '.' 추가 각각 재요청. 같은 인수 재요청. 서버(앱) 재시작 후 이전 commands.source(id), 같은 키 재요청, GET /api/{id}/source, POST /api/{id}/approve | 변경 5종 모두 /conflict/ 오류. 같은 인수는 같은 id. 재시작 전 보관한 commands.source(id)는 /unavailable/ 예외. 재시작 후 재요청은 같은 id·state 'expired'. GET source와 approve 모두 409. 실행 0회 | 오류 메시지·id·state·HTTP 409·실행 수 assert | portal-app, portal-store, portal-web | test/source-automation.test.mjs:148 | - |
| RC-B-457 | 비동기 평가·선택 중 정책 변경·철회가 디스패치와 fallback 공개를 막음, 연결 대기 뒤 철회된 grant 거절 | (a) 평가가 지연된 runSource 중 state 'evaluating'에서 sourceExecutionContract null로 저장 후 평가 완료(low) (b) 실행기가 연결 대기(verify 지연) 중 정책에서 계약 null 저장 후 해제 (c) 기본 평가가 pending인 동안 fallback 'luna' 설정 상태에서 externalDisclosure false 또는 sourceExecutionContract null로 저장 후 기본 평가 응답 null | (a) decision.reasonCode 'policy_changed', 실행 0. (b) state 'failed', 실제 dispatch 0, result.execution.remoteState 'not_dispatched'. (c) fallback 호출 0, 실행 0, state 'pending', reasonCode 'policy_changed', GET /api/{id}/source의 source == 원문, deny 후 같은 조회는 409 | state·reasonCode·remoteState·호출 수·409 assert | portal-app, portal-domain, portal-ssh | test/source-automation.test.mjs:159, test/source-automation.test.mjs:249 | - |
| RC-B-458 | source 전송 모호성은 unknown, 안정 요청 키는 재실행하지 않음 | 실행기가 'PRIVATE_BODY_SOURCE_32 transport ambiguous' 오류를 던지도록 하고 requestKey 'source-unknown-key-0001'로 runSource. 같은 키 재요청, 앱 재시작 후 재요청 | state 'unknown'. 직렬화한 job에 'PRIVATE_BODY_SOURCE_32' 없음. 재요청은 같은 id, 재시작 후에도 state 'unknown'. 실행기 호출 총 1회 | state·직렬화 부재·호출 수 assert | portal-app, portal-store, portal-ssh | test/source-automation.test.mjs:179 | - |
| RC-B-459 | source 입력 사전 거절(인증정보·민감 인수·민감 cwd)과 증거 크기 경계 | 정책 허용 상태에서 source "x='Bearer synthetic-only'\n", "api_key='synthetic-only'\n", argv ['api_key=synthetic'], argv ['.env'], cwd '/tmp/.env' 각각 runSource. 이어서 source '# '+'x'*15500+'\npass\n' (길이 15508), context '"'*8192, source 'x'*16385 | 앞 5종은 /Sensitive/ 오류이고 큐 등록 0건. 15508자 source는 state 'completed', 모델 입력 1건, 실행 1건, 모델 context의 submittedSource.source.length 15508. context 8192개 따옴표는 state 'pending', reasonCode 'source_evidence_too_large', 모델 호출 추가 없음(총 1), GET source의 source == 기본 원문. source 16385자는 /Invalid Python source/ 오류 | 오류·큐 수·state·길이 assert | portal-domain, portal-app | test/source-automation.test.mjs:187 | - |
| RC-B-460 | 민감 경로 가드 목록을 담은 12712바이트 source가 평가기·실행기에 정확히 전달 | source = 머리 "# SYNTHETIC_ADMISSION_BODY_15 .env /etc/shadow /home/operator/.ssh/id_ed25519 /secrets/service\n# " + '가'*447 + 'x' 채움 + '\npass\n' (길이 11818자, 12712바이트), context 길이 1277, requestKey 'source-full-admission-15'. 실제 Jev 어댑터(가짜 HTTP) | state 'completed', 모델 호출 1회, 실행 1회. 모델 wire state.context 길이 > 12288, submittedSource.source == 원문, callerSituation == context. 실행 plan.stdin == 원문. job·감사·GET /api/requests에 'SYNTHETIC_ADMISSION_BODY_15' 없음, 영속 저장소에 원문 바이트 없음, GET source 409 | 길이·바이트·동일성·부재 assert | portal-domain, portal-app, portal-web, portal-store | test/source-automation.test.mjs:200 | - |
| RC-B-461 | source 개인 보관 바이트 예산: 거부·만료·저널 실패 시 해제, 실행 능력 부재는 접수 전 실패 | (a) sourceExecutionContract null 정책에서 '# '+'x'*16000+'\npass\n' pending 65건 생성 후 66번째 (b) 첫 건 deny 후 재시도 (c) 큐 시계를 +3,700,000ms로 진행해 만료 후 재시도, 시계 복원 후 재시도 (d) 실행기(executePythonSource) 없는 앱에서 runSource (e) 접수 저널 insert가 예외, 종료 저장(save)이 예외인 두 경우의 예산 | (a) 66번째 /memory limit/ 오류 (b) deny 후 새 요청은 state 'pending' (c) 만료 회수 후 'pending', 만료된 jobs[1]의 GET source는 409, 복원 후 'pending' (d) /unavailable/ 오류, 큐 등록 0건 (e) insert 예외는 /journal/ 오류이며 예산 {bytes:0,count:0}, 큐의 모든 job에 source(id)가 /pending/ 예외. save 예외 후 작업 state 'unknown', 예산 {bytes:0,count:0} | 오류·state·예산 객체 assert | portal-app, portal-domain, portal-store | test/source-automation.test.mjs:223, test/source-automation.test.mjs:236 | - |
| RC-B-462 | 연결 대기 뒤 새 고정 SSH 채널이 실제 소유자 정책·대상을 재검사 | 지연 장벽이 있는 SSH 서버 픽스처(MINA SSHD 서버로 대체)에서 runSource requestKey 'source-retry-once-0001'. 연결 확립 후 channel 열기 전 4모드: unchanged, 계약 null 저장(source-grant), externalDisclosure false 저장(disclosure), 대상 profile.user를 'changed-target'으로 변경(target) | unchanged: state 'completed', 세션 시도 1·수신 1, 수신 source == 원문, 수신 command == job.command, 같은 키 재요청은 같은 id이고 수신 증가 없음. 나머지 3모드: 세션 시도 0, 수신 0, state 'failed', result.execution.remoteState 'not_dispatched', cleanupComplete true, GET source 409; source-grant·disclosure 모드의 같은 키 재요청은 같은 job.id, 수신 0 | 서버 측 수신 카운터·state·execution 필드 assert | portal-ssh, portal-app, portal-domain | test/source-automation.test.mjs:303 | - |
| RC-B-463 | source 요청 키와 legacy 문자열(공개 plan digest와 동일) 키의 도메인 분리 | requestKey 'source-domain-key-0001', plan = preparePythonSource(...). sourceFirst true: source 제출 후 legacy run(plan.planDigest, requestKey 동일), false: 반대 순서 | 나중 제출이 /conflict/ 오류. 큐 총 1건 | 오류·큐 건수 assert | portal-app, portal-domain | test/source-automation.test.mjs:331 | - |
| RC-B-464 | test server 정책의 source 실행: 공개 동의·모델·opt-in·sudo opt-in 없이 실행, 철회 시 검토 복원 | testServer true, sourceExecutionContract null, automaticSudo false, deniedCommands ['python3'], externalDisclosure false, modelExecution false로 정책 review·저장. context '' elevate true로 runSource. 이후 testServer false로 저장 후 runSource | review.feedback[0].reason 'test_server_bypass', level 'high_risk'. 실행 작업 state 'completed', approvalMode 'automatic', reasonCode 'test_server_bypass', 실행 1회·모델 입력 0. 철회 후 새 요청 decision.reasonCode 'source_execution_not_enabled', 실행 추가 없음(총 1) | review feedback·state·reasonCode·호출 수 assert | portal-domain, portal-app, portal-web | test/source-automation.test.mjs:346 | - |
| RC-B-465 | test server source가 대기열에서 비공개 plan을 유지하고 정확한 바이트를 1회 실행 | testServer true. 첫 source('print("first")\n') 실행을 보류, 둘째 source(원문)·requestKey 'test-source-busy-key-0001' 제출. 보류 해제 | 둘째 job state 'queued', approvalMode 'automatic', decision.dispatchFailure undefined, 실행 목록은 ['print("first")\n']. 해제 후 둘째 state 'completed', 실행 목록 [첫째, 둘째 원문] 순서 총 2회. 같은 키 재제출은 같은 id이고 실행 수 증가 없음 | state 전이·실행 순서·dispatchFailure 부재 assert | portal-app, portal-domain | test/source-automation.test.mjs:359 | D-0004(후보) |
| RC-B-466 | MCP submit source 입력 거절(원문 인증정보)의 안전 사유와 비반사 오류 봉투 | 정책 testServer false. submit {kind:'source', source:...} 7종: api_key='FAKE_CREDENTIAL_CANARY_01', password='FAKE_CREDENTIAL_CANARY_02', token='FAKE_CREDENTIAL_CANARY_03', "value='-----BEGIN PRIVATE KEY----- FAKE_CREDENTIAL_CANARY_04'", "value='Bearer FAKE_CREDENTIAL_CANARY_05'", "api_key='synthetic-only'", "# secret=FAKE_CREDENTIAL_CANARY_06\npass\n" | 모두 isError true, structuredContent == {contractVersion:'2.0', ok:false, data:null, error:{code:'SOURCE_CREDENTIAL_MATERIAL', retryable:false, executionAttempted:'unknown'}}, content[0].text의 JSON도 동일. 응답·감사 이벤트 직렬화에 입력 원문과 /FAKE_CREDENTIAL_CANARY\|synthetic-only\|PRIVATE KEY/ 없음. 큐 0건·모델 입력 0·실행 0 | deepEqual 오류 봉투·부재 검사·큐/호출 수 | portal-web, portal-domain | test/source-input-refusals.test.mjs:76 | - |
| RC-B-467 | submit source 인수·작업 경로의 인증정보·민감 경로 사유 구분 | argv ['api_key=FAKE_ARGUMENT_CANARY'], argv ['/tmp/.env'], argv ['/etc/shadow','/home/test/.ssh/id_ed25519','/secrets/fixture'], cwd '/tmp/.env', cwd '/secrets/FAKE_WORKDIR_CANARY', cwd '/tmp/token=FAKE_WORKDIR_CANARY' | argv 3종은 error.code 'SOURCE_ARGUMENTS_SENSITIVE', cwd 3종은 'SOURCE_WORKDIR_SENSITIVE'(봉투 형식은 RC-B-466과 동일). 응답·감사 직렬화에 FAKE_ARGUMENT_CANARY, FAKE_WORKDIR_CANARY, .env, /etc/shadow, /secrets/ 없음. 큐·모델·실행 0 | 코드 구분·부재 검사·호출 수 | portal-web, portal-domain | test/source-input-refusals.test.mjs:96 | - |
| RC-B-468 | source 거절 내부 오류 코드·메시지와 source→argv→cwd 우선순위 | runSource 직접 호출 3조합: (source "token='FAKE_PRECEDENCE_CANARY'", argv ['.env'], cwd '/secrets/fixture'), (argv ['.env'], cwd '/secrets/fixture'), (cwd '/secrets/fixture'). 같은 입력을 MCP submit으로도 호출 | 내부 예외 message 'Sensitive source input refused', code는 각각 SOURCE_CREDENTIAL_MATERIAL, SOURCE_ARGUMENTS_SENSITIVE, SOURCE_WORKDIR_SENSITIVE. MCP 응답도 같은 코드의 오류 봉투. 매번 큐·모델·실행 0 | 예외 message·code·MCP 오류 코드 assert | portal-domain, portal-web | test/source-input-refusals.test.mjs:114 | - |
| RC-B-469 | TEST 우회 정책에서도 source 세 입력 거절을 건너뛰지 않음 | testServer true 정책. submit {context:'', elevate:true} 조합으로 source "secret='FAKE_TEST_CANARY'", argv ['.env'], cwd '/secrets/fixture' 각각. 이후 정상 인수 {context:''} 제출 | 3종 각각 SOURCE_CREDENTIAL_MATERIAL, SOURCE_ARGUMENTS_SENSITIVE, SOURCE_WORKDIR_SENSITIVE 오류 봉투, 큐 0. 정상 제출은 isError 없음, 작업 state 'completed', reasonCode 'test_server_bypass', 실행 1회, 모델 입력 0 | 오류 코드·state·reasonCode·호출 수 | portal-web, portal-domain, portal-app | test/source-input-refusals.test.mjs:129 | - |
| RC-B-470 | 정상 원문·유사 문자열·원문 속 민감 경로 설명은 거절하지 않음 | source "# .env /etc/shadow /home/test/.ssh/id_ed25519 /secrets/service\napi_keys = ['공개']\npassword_hint = '설명'\ntoken_count = 1\nprint('Bearerish')\n", argv ['.environment','/secretsish','token_count'], cwd '/tmp/fixture' | isError 없음. job state 'pending', reasonCode 'source_execution_not_enabled'. commands.source(id).source == 원문. 큐 1건·모델 0·실행 0. 응답·감사 직렬화에 원문 없음 | state·reasonCode·원문 일치·부재 검사 | portal-domain, portal-web | test/source-input-refusals.test.mjs:142 | - |
| RC-B-471 | 기존 context 거절 사유와 일반 예외 비반사 | submit context 'token=FAKE_CONTEXT_CANARY'; submit source '\0'; runSource가 Error('FAKE_EXCEPTION_CANARY')를 code undefined 또는 'UNKNOWN_SOURCE_REFUSAL'(cause·details에 FAKE_CAUSE_CANARY, FAKE_DETAILS_CANARY)로 던지는 경우; 세 SOURCE_* 코드를 가진 예외 | context: error.code 'COMMAND_CONTEXT_CONTAINS_SECRET', 응답에 FAKE_CONTEXT_CANARY 없음. source '\0': 'REQUEST_REFUSED'. code undefined → 'REQUEST_REFUSED', 알 수 없는 코드 'UNKNOWN_SOURCE_REFUSAL'은 그대로 코드로 반영하되 예외 message·cause·details는 응답에 미반영. SOURCE_* 코드 예외는 해당 거절 봉투. 큐 0 | 오류 코드·비반사 검사 | portal-web, portal-domain | test/source-input-refusals.test.mjs:154 | - |
| RC-B-472 | 공개 secret 참조 문자열은 원문 바이트와 일반 승인 경계를 유지하며 뒤의 인증정보를 가리지 못함 | reference = "reference = 'secret://local-file/windows-gui-agent'\n". (a) 정책 testServer false, source reference + "print(reference)\n"(원문 그대로) (b) testServer true에서 reference 뒤에 password='SYNTHETIC_LITERAL', token=, secret=, api_key=, value='Bearer SYNTHETIC_LITERAL', value='-----BEGIN PRIVATE KEY----- SYNTHETIC_LITERAL' 6종 (c) testServer true에서 reference+'print(reference)\n' | (a) isError 없음, state 'pending', reasonCode 'source_execution_not_enabled', commands.source(id).source == 원문, 모델 0·실행 0. (b) 6종 모두 SOURCE_CREDENTIAL_MATERIAL 오류 봉투, 큐 0. (c) state 'completed', reasonCode 'test_server_bypass', 실행 1회, 실행 plan.stdin == 제출 원문, 모델 0 | state·reasonCode·stdin 동일성·오류 코드 | portal-domain, portal-web, portal-app | test/source-input-refusals.test.mjs:175, test/source-input-refusals.test.mjs:189 | - |
| RC-B-473 | Linux 실제 OpenSSH/POSIX에서 source 계약, 권한 경계, 훼손 전달 거절, 재시작 재실행 금지(통합) | 전용 Linux 컨테이너(root 제어자, 합성 계정 mcpfixture uid 10002, OpenSSH 127.0.0.1:2222 StrictModes yes, /run 0755, 여유 공간 > 17MiB, SOURCE_LINUX_FIXTURE='synthetic-only'). 정책 python-source-v1·automaticSudo·모델 low 응답. (1) 일반 source(argv [remote/literal.txt, "literal ' ; $(printf shell-expanded) 한글"], cwd remote(공백·한글 경로), requestKey 'source-linux-normal-0001'). (2) 보호 파일 변경 source를 elevate 없이/있게. (3) 무결성: 같은 plan.command로 접두부만, 첫 바이트 변조, 뒤에 '# trailing\n' 추가한 stdin 전달. (4) 계약 null 저장 후 pending 생성, 소유자 승인. (5) 같은 키 재요청과 앱 재시작 후 재요청 | (1) completed·automatic, 출력 JSON == {uid:10002, cwd:remote, args:['<ssh-python-source-v1>', ...argv], env:{LANG:'C.UTF-8', LC_ALL:'C.UTF-8', PATH:'/usr/bin:/bin'}, utf8:1, fileProvided:false, stdin:''}; 임시 파일 삭제됨; 모델 context submittedSource.source == 원문; plan.manifest.sourceBytes == 바이트 길이, sourceSha256 == SHA-256; operation.sourcePlanDigest == plan.planDigest; 부모 env 센티널 미전달. (2) elevate 없음: state 'failed', 보호 파일 바이트 불변; elevate 있음: completed, 출력 {uid:0, restored:true}, 파일 원복, plan.command가 `'sudo' '-n' '--'`로 시작, manifest.elevate true. (3) 3종 모두 exitCode 125로 거절되고 접두부 실행 흔적(마커 파일) 없음; 온전한 전달은 성공(failed false, 출력에 'wire-complete 한글')이며 마커 'unexpected-prefix' 기록. (4) pending, GET source 200·no-store, MCP 토큰은 401, approve 후 completed·approvalMode 'owner', 이후 source 409. 총 plan 4건·모델 입력 3건. (5) 같은 키는 같은 id·plan 수 4 유지, 재시작 후에도 같은 id·plan 수 4. 감사 이벤트에 비공개 본문 표식 없음, 영속 저장소에 원문 없음, 출력 저장소 binding.operationDigest == plans[0].planDigest | 실 OpenSSH 컨테이너에서 위 값 assert. 3.0에서는 MINA SSHD 클라이언트 대 컨테이너 OpenSSH 통합 시험. 원 시험은 1.x 도구명(run-python-source)과 questionVersion 'ssh-command-risk-v4'를 사용하므로 Contract 2.0 submit(kind:'source')와 현행 questionVersion으로 이식 | portal-ssh, portal-app, portal-web, portal-domain, portal-store, packaging | test/source-linux-runtime.mjs:32 | - |
| RC-B-474 | SSH 연결 수명: SFTP 채널 열기 재시도 소진 시 1회 실패, 이후 요청은 새 연결 사용(재실행 없음) | 연결 객체의 SFTP 열기를 항상 실패시키고(upload, download 각각) 업로드/다운로드 호출. 이어서 별도 명령 executeCommand('successor') | 호출은 거절(reject). SFTP 열기 시도 정확히 3회, 원격 명령 효과 0, 이 시점 연결 end 호출 0. 이어지는 'successor' 명령은 성공(failed false), 현재 연결 객체가 이전과 다르고 이전 클라이언트 end 1회, 이전 클라이언트 열기 시도는 3회 그대로(실패 명령 재실행 없음), 새 클라이언트 effects == ['successor'] | 열기 횟수·end 횟수·연결 교체 assert. ssh2 Client 가짜는 MINA SessionHolder/ClientSession 가짜로 대체 | portal-ssh | test/ssh-connection-lifecycle.test.mjs:102 | D-0038(후보) |
| RC-B-475 | SSH 연결 수명: 불확실한 채널 열기는 1회 시도, 연결 보존 | exec 채널 열기를 실패시키고 command, source, cli(agent inspect), helper(session.call) 4포트 각각 호출 | 반환 execution.reason 'channel_open_failed', remoteState 'unknown', automaticReplay false. 열기 시도 1회, 원격 효과 0. 실패 해제 뒤 'successor' 명령은 성공하고 연결 객체는 동일(교체 없음), end 0, effects == ['successor'] | execution 필드·열기 횟수·연결 동일성 assert(4포트 반복) | portal-ssh, portal-app | test/ssh-connection-lifecycle.test.mjs:116 | D-0038(후보) |
| RC-B-476 | SSH 연결 수명: 일시적 열기 실패·원격 nonzero·SFTP 열린 뒤 파일 오류는 연결을 폐기하지 않음 | (a) 첫 exec 열기만 1회 거절 후 연속 3호출, 이어서 exit code 7 호출, exit 0 호출 (b) SFTP 열기는 성공하나 stat이 오류 코드 3(denied)를 반환하는 업로드 후 명령 호출 | (a) 첫 호출 failed true(열기 1회), 둘째 failed false(열기 누적 2), end 0. exit 7 호출은 failed true, 이후 exit 0은 failed false, 연결 객체 동일·end 0. (b) 업로드는 reject, 다음 명령 failed false, 연결 동일, end 0 | failed 값·열기 횟수·연결 동일성 assert | portal-ssh | test/ssh-connection-lifecycle.test.mjs:128, test/ssh-connection-lifecycle.test.mjs:142 | D-0038(후보) |
| RC-B-477 | SSH 연결 수명: 살아 있는 작업·응답 대기 중 열기 콜백이 있으면 연결을 폐기하지 않고, 해소 뒤 복구 허용 | (a) 'hold' 명령이 실행 중인 연결에서 SFTP 열기 실패 업로드 후 새 명령 'blocked' (b) 명령 'deferred'를 timeoutMs 20, stopGraceMs 10으로 실행하고 열기 콜백을 보류한 채 SFTP 실패 업로드·명령 시도, 이후 콜백에 오류 전달 | (a) 업로드 reject, 'blocked' 명령 reject, end 0, 실행 중 채널은 닫히지 않음, 'blocked'는 채널 열기 시도 없음. 실행 중 작업 완료 후 'after-drain' 성공, 이전 연결 end 1, 연결 교체됨. (b) 첫 명령 execution.reason 'deadline', remoteState 'unknown'; 명령 타임아웃만으로 end 0; SFTP 실패·명령 시도는 reject이고 end 0; 콜백이 늦게 오류 반환 후 'after-late-close' 성공, end 1 | 연결 end 횟수·교체·reason assert | portal-ssh | test/ssh-connection-lifecycle.test.mjs:151, test/ssh-connection-lifecycle.test.mjs:165 | D-0038(후보) |
| RC-B-478 | SSH 연결 수명: 정리(cleanup)는 원래 연결에 고정되어 새 연결로 대체되지 않음 | 정리 옵션 {platform:'linux', helper:'/synthetic/helper', id:48자리 hex}로 세션 연결 후 'first-stage' 호출. 이후 SFTP 실패 업로드, 'new-request' 명령, session.cleanup() | 'new-request'는 성공하고 현재 연결은 이전과 다름. session.cleanup()은 reject. 새 연결 effects == ['new-request'], 원 연결 effects == ['first-stage'] | 연결별 effects assert | portal-ssh | test/ssh-connection-lifecycle.test.mjs:180 | - |
| RC-B-479 | SSH 연결 수명: ProxyJump 재구성은 레지스트리 책임, 동시 후속 요청에도 이전 연결은 한 번만 닫힘 | profile.via 'synthetic-bastion', close 동기 모드. SFTP 열기 실패 업로드 후 'next-a','next-b' 동시 실행 | 두 명령 모두 failed false. 이전 클라이언트 end 1회, 연결 교체됨, 새 연결 profile.via == 'synthetic-bastion', 새 effects 정렬 == ['next-a','next-b'] | end 횟수·via·effects assert | portal-ssh | test/ssh-connection-lifecycle.test.mjs:192 | - |
| RC-B-480 | SSH 연결 수명: 지연된 close·늦은 error 이벤트가 교체 클라이언트를 닫지 않음 | close가 지연되는 모드. SFTP 실패 업로드 후 'after-bounded-close' 명령(성공). 이후 이전 클라이언트에 close, error('late synthetic event') 이벤트 방출 | 명령 failed false, 이전 클라이언트 end 1·destroy 1(제한된 대기 뒤 강제 종료). 교체 클라이언트 end 0·destroy 0, 연결 객체 교체됨 | end/destroy 카운터 assert | portal-ssh | test/ssh-connection-lifecycle.test.mjs:201 | - |
| RC-B-481 | 소유 실행 감독: 스트리밍 UTF-8 바이트·stderr·종료·정확한 커서 | 가짜 채널에 '가🙂' UTF-8 바이트를 2바이트 + 나머지로 쪼개 data 이벤트 2회, stderr 'warning', exit 0, close 0 | stdout '가🙂', stderr 'warning', execution.reason 'exit', remoteState 'exited', outputState 'complete', execution.timeoutMs == DEFAULT_RUN_TIMEOUT_MS(≥120000). stdout onOutput 이벤트 커서 [[0,2],[2,전체 바이트수]]. 채널 열기 1회, 전송 끊김 리스너 해제(0) | 필드 deepEqual·커서·리스너 수 assert | portal-ssh | test/ssh-supervisor.test.mjs:21 | D-0010(후보) |
| RC-B-482 | 소유 실행 감독: 마감 시한 도달 시 부분 출력 보존, 중지 요청 뒤 close를 기다림 | timeoutMs 5, stopGraceMs 100. data 'before' 수신 후 20ms 경과 | 20ms 시점에도 미정착(settled false), 채널에 보낸 첫 signal 'INT'. 이후 exit(null,'TERM')·close 수신 시 stdout 'before', execution.reason 'deadline', remoteState 'exited', cleanupComplete true, automaticReplay false, 열기 1회 | 정착 시점·signal 순서·필드 assert | portal-ssh | test/ssh-supervisor.test.mjs:34 | D-0010(후보) |
| RC-B-483 | 소유 실행 감독: 취소는 시한과 구분되고 신호가 프로세스를 죽였다고 주장하지 않음, 이미 취소된 작업은 디스패치 없음 | (a) stopGraceMs 15에서 stderr 'failure detail' 후 AbortController.abort() (b) 이미 abort된 signal로 시작 | (a) execution.reason 'cancel', stderr 'failure detail', remoteState 'unknown', cleanupComplete false, requiresReconciliation true, outputState 'partial', 채널 signal 순서 ['INT','TERM','KILL'], 열기 1회. (b) 채널 열기 0회, remoteState 'not_dispatched', reason 'cancel' | reason·remoteState·signal 순서·열기 횟수 assert | portal-ssh | test/ssh-supervisor.test.mjs:48, test/ssh-supervisor.test.mjs:59 | - |
| RC-B-484 | 취소 신호가 stdin EOF 이후에도 정확한 채널로 전달되고 원격 종료·정리까지 대기(source 실행) | source plan을 stdin으로 전송(EOF) 후 abort. 채널 id 91, 다른 채널 id 92 존재 | 취소 시 정확히 [{id:91, name:'INT'}]만 전송(EOF가 먼저 전송된 상태), 채널 92 무관. 전송된 stdin 바이트 == plan.transportStdin ?? plan.stdin. 결과 execution.reason 'cancel', signalDelivery 'requested', remoteState 'exited', cleanupComplete true, requiresReconciliation false. (ssh2 공개 메서드는 EOF 뒤 신호를 무시하는 벤더 고유 결함이므로 3.0은 MINA 채널 신호 API로 같은 행동을 검증) | 신호 대상 id·순서·결과 필드 assert | portal-ssh | test/ssh-supervisor.test.mjs:65 | - |
| RC-B-485 | 신호 전달 미지원은 명시되고 종료를 주장하지 않음 | 채널 signal이 Error('Unsupported transport')를 던지는 상태에서 stopGraceMs 15로 abort | execution.signalDelivery 'unsupported', remoteState 'unknown', cleanupComplete false, automaticReplay false | 필드 assert | portal-ssh | test/ssh-supervisor.test.mjs:107 | - |
| RC-B-486 | 전송(transport) 유실 시 바이트 보존, 로컬 정리 후에도 unknown | data 'before' 수신 후 전송 close 이벤트 | stdout 'before', execution.reason 'transport_lost', remoteState 'unknown', cleanupComplete true, requiresReconciliation true, 열기 1회 | 필드 assert | portal-ssh | test/ssh-supervisor.test.mjs:116 | - |
| RC-B-487 | 채널 열기 결과 처리: 늦은 콜백은 추가 디스패치 없이 중지, 거절된 열기는 not_dispatched·불확실 오류는 unknown, 재실행 없음 | (a) 열기 콜백 지연 + timeoutMs 5, stopGraceMs 10, 이후 콜백으로 채널 전달 (b) 거절 오류(reason 1) (c) 일반 Error('lost reply') | (a) reason 'deadline', remoteState 'unknown'; 콜백 이후 채널 signal == ['KILL'], close 1회, 열기 1회. (b) reason 'channel_open_failed', remoteState 'not_dispatched', 열기 1회 (c) reason 'channel_open_failed', remoteState 'unknown', 열기 1회 | reason·remoteState·signal·열기 횟수 assert | portal-ssh | test/ssh-supervisor.test.mjs:125, test/ssh-supervisor.test.mjs:132 | - |
| RC-B-488 | 출력 보존 상한: 두 스트림 각각 한도와 명시적 잘림 | maxOutputBytes 4. stdout 'abcdefgh'(8B), stderr '123456'(6B), close 7 | stdout 'abcd', stderr '1234', exitCode 7. execution.stdout == {receivedBytes:8, retainedBytes:4, cursor:4, truncated:true}, stderr == {receivedBytes:6, retainedBytes:4, cursor:4, truncated:true}, outputState 'partial'. onOutput로 전달된 바이트 합 8 | 필드 deepEqual·전달 합 assert | portal-ssh | test/ssh-supervisor.test.mjs:140 | - |
| RC-B-489 | 출력 싱크 실패·정지 시 포획 출력 보존, 정착 시 일시정지된 읽기 스트림을 비워 채널 해제 | (a) onOutput가 예외 / 영원히 pending인 두 경우, stopGraceMs 10, data 'evidence', close 0 (b) 동적: (reason 'exit', 싱크 정상), ('cancel', 정상), ('exit', 싱크 실패 'Synthetic durable sink failure'). onOutput가 내구 싱크 대기로 읽기·stderr를 일시정지시킨 뒤 exit 또는 abort 정착, stopGraceMs 30 | (a) stdout 'evidence', execution.captureFailed true, outputState 'partial', exitCode 0. (b) 일시정지 상태(channel.isPaused, stderr.isPaused true) 확인 뒤 정착: 채널 close가 완료(closed true: EOF를 흘려 SSH close가 채널을 해제), stdout 'evidence', reason == 입력 reason, remoteState 'exited'(exit)/'unknown'(cancel), outputState 'partial', captureFailed == 싱크 실패 여부, automaticReplay false, 열기 1·onOutput 호출 1·close 호출 1 | 필드·close 발생·호출 횟수 assert. 읽기 백프레셔 구현은 MINA 채널 스트림으로 바뀌지만 정착 시 채널 슬롯 해제 요건은 유지 | portal-ssh | test/ssh-supervisor.test.mjs:151, test/ssh-supervisor.test.mjs:161 | D-0040 |
| RC-B-490 | 입력 쓰기 실패는 유형화되고 정리까지 채널 슬롯 유지, exit만 있고 close 없는 경우 제한된 정리 | (a) 채널 write가 예외, stdin 'payload', stopGraceMs 10, close 코드 9 (b) exit 0 수신 후 close 없음, stopGraceMs 10 | (a) execution.reason 'input_failed', remoteState 'exited', cleanupComplete true, 채널 close 1회, 열기 1회. (b) reason 'exit', remoteState 'exited', cleanupComplete false, requiresReconciliation true, outputState 'partial' | 필드 assert | portal-ssh | test/ssh-supervisor.test.mjs:193, test/ssh-supervisor.test.mjs:200 | - |
| RC-B-491 | source 실행은 소유 채널 포트를 쓰고 stdin 재정의 옵션을 획득 전에 거절 | preparePythonSource plan으로 executePythonSource(성공 흐름), 이어서 옵션 {stdin:'changed'}로 재호출 | 성공: failed false, data.stdout 'ok', 채널 write == [plan.transportStdin ?? plan.stdin], remoteState 'exited', 연결 획득 1회, 라이브러리 Promise exec 미사용. stdin 재정의는 /Invalid command transport options/ 오류이며 연결 획득 횟수 증가 없음(1) | write 내용·획득 횟수·오류 메시지 assert | portal-ssh, portal-app | test/ssh-supervisor.test.mjs:208 | - |
| RC-B-492 | 데스크톱 포워드 취소는 자기 채널만 닫고 정확한 endpoint를 추적, 비허용 대상 거절 | openSshForward(profile, {host:'127.0.0.1', port:5900, signal})를 열고 abort. 이어서 host 'remote.example', port 5900 요청 | forwardOut 인수 [['127.0.0.1', 0, '127.0.0.1', 5900]], lease.stream == 열린 스트림. abort 후 스트림 destroyed true이며 공유 전송(client.end)은 호출되지 않음. remote.example 요청은 /Invalid desktop/ 오류 | 인수·destroyed·end 미호출·오류 assert | portal-ssh, portal-desktop | test/ssh-supervisor.test.mjs:223 | D-0021(후보) |
| RC-B-493 | 시작 시 종료 상태 command 이력 복원: operation 버전·이벤트·legacy 본문·감사를 다시 쓰지 않음 | 상태 {completed, failed, denied, expired, cancelled, unknown} 6건을 legacy 저장소와 operation 저장소에 시드(id 48자리 0 패딩 번호, result.texts ['retained result'], finishedAt 200). 저장소를 닫고 다시 열어 큐 restore 후 syncOperation(record,{restoring:true})과 syncOperation(record) | 각 job의 result 그대로, state 동일, finishedAt 200, 알림 1·completion resolve 1, wait(id).state 동일. 복원 전후 operation 레코드·이벤트·legacy preservationRows 불변, onTerminal 정리 호출 순서 == job id 목록, 저장 콜백 0회, 감사 0건, 복원 operation은 실행되지 않음 | 전후 deepEqual·카운터 assert | portal-app, portal-store, portal-domain | test/terminal-restore.test.mjs:40 | D-0031(후보) |
| RC-B-494 | 실시간 완료는 여전히 한 번만 저장·감사하고 알림·완료 해소·정리를 각 1회 수행 | 스케줄러가 있는 큐에서 command 'fixture live command' 제출, track, start, wait. 성공 outcome | state 'completed', 실행 1회. operation record.metadata.approval.state 'completed', legacy 저장소 job state 'completed', 저장 콜백의 completed 1회, 감사 action 'completed' 1회, operation 이벤트 중 state 'completed'가 2건(outcome + 저장된 approval view). syncOperation(record) 재호출은 레코드·이벤트 불변, 정리 [job.id], 알림 1·해소 1 | 횟수·deepEqual assert | portal-app, portal-store, portal-domain | test/terminal-restore.test.mjs:60 | - |
| RC-B-495 | 시작 시 종료된 upload 작업은 artifact를 한 번 해제하고 이력·감사는 그대로 | completed 상태 upload operation(artifactId 48자리 'b')을 restore. 파일 서비스 onTerminal(now 500) 연결 | 저장소 releaseUpload가 id == artifactId, 옵션 {expiresAt:500}로 정확히 1회 호출(핀 해제). 정리 [job.id], 알림 1·해소 1, 저장 콜백 0·감사 0. operation 레코드·이벤트·legacy 행 불변 | 호출 인수·횟수·불변 assert | portal-app, portal-store | test/terminal-restore.test.mjs:81 | D-0030(후보) |
| RC-B-496 | test-mode 파일 경로 정책 기본값: 위조 operation 필드와 비정상 정책값은 root 우회 권한을 만들지 않음 | Windows 대상. pathPolicy 미설정, {bypassRoot:false}, {bypassRoot:'true'}, {bypassRoot:1}. 업로드·다운로드 operation에 {bypassRoot:true, testServer:true, rootPolicyApplied:'test-server-bypass'} 위조 추가 | 두 전송 모두 failed false. 원격 쪽으로 전달되는 요청(3.0은 SFTP 경로 검사 호출)에 bypassRoot, testServer, rootPolicyApplied 필드·권한이 어디에도 없음. 동작 순서는 업로드 후 정리, 다운로드 후 정리 (원 시험 호출 순서 publish, cleanup, snapshot, cleanup) | 위조 필드 무효·실패 없음 assert. 호출 순서 검증은 helper 대신 SFTP 업로드/삭제 호출 순서로 이식 | portal-ssh, portal-app | test/test-mode-file-path-policy.test.mjs:57 | D-0002(후보) |
| RC-B-497 | 서버 정책의 명시적 boolean true만 root 우회를 허용하며 파일 변경 전에 우회 적용 가능성을 확인 | pathPolicy가 {bypassRoot:true} 반환(operation에 bypassRoot:false를 넣어도 무시). 업로드 후 다운로드. 대상 'windows', revision 'b'*64, remotePath 'C:/outside-configured-root/한글.bin' | 두 전송 failed false. 순서: 정책 조회 → SFTP 업로드 → 게시 → 정리, 다운로드는 정책 조회 → 스냅샷 → SFTP 다운로드 → 정리. 우회 요청 플래그는 정책 조회·게시·스냅샷에만 true, 승격(elevate) false, 명령에 runas, Start-Process, sudo 없음. 정책 조회 입력은 fileTargetId 'windows', fileTargetRevision, remotePath. 연결 profile 순서 ['writer','reader'] | 호출 순서·플래그·profile assert. 3.0은 helper 호출 대신 portal-ssh의 동일 정책 단계 | portal-ssh, portal-app | test/test-mode-file-path-policy.test.mjs:74 | D-0002 |
| RC-B-498 | Linux 파일 전송은 Windows root 우회를 적용하지 않음 | platform 'linux', pathPolicy {bypassRoot:true}. 업로드·다운로드 | 둘 다 failed false, 어떤 요청에도 bypassRoot 없음 | 요청 필드 부재 assert | portal-ssh | test/test-mode-file-path-policy.test.mjs:98 | - |
| RC-B-499 | root 제한 오류(PATH_OUTSIDE_ALLOWED_ROOT)는 검증된 allowedRoot만 공개하고 원문 진단은 버림 | (a) helper 응답 {errorCode:'PATH_OUTSIDE_ALLOWED_ROOT', allowedRoot:'C:/approved files' 또는 'D:\\승인 파일', error/message/diagnostics에 'RAW_REMOTE_DIAGNOSTIC credential=must-not-leak'} 다운로드 (b) allowedRoot가 undefined, null, true, {}, 'C:/', 'C:relative', '/private/root', '\\\\server\\share', 'C:/safe/../secret', 'C:/file:stream', 'C:/NUL', 'C:/hidden\u200b', 'C:/root\nRAW_REMOTE_DIAGNOSTIC', 'C:/'+'x'*4094 | (a) failed true, data == {errorCode:'PATH_OUTSIDE_ALLOWED_ROOT', allowedRoot}, texts에 'PATH_OUTSIDE_ALLOWED_ROOT' 포함, 직렬화에 RAW_REMOTE_DIAGNOSTIC·credential·must-not-leak·diagnostics 없음. (b) 14종 모두 failed true, data == {errorCode:'PATH_OUTSIDE_ALLOWED_ROOT'} (allowedRoot 키 없음), 직렬화에 RAW_REMOTE_DIAGNOSTIC·credential·must-not-leak·private·relative·file:stream 없음 | data deepEqual·부재 검사. 3.0의 allowedRoot 출처는 SFTP 경로 정책 설정이며 검증 규칙(절대 드라이브 경로, 부모 이동·스트림·예약명·제어/제로폭 문자·길이 상한)을 동일 적용 | portal-ssh, portal-web | test/test-mode-file-path-policy.test.mjs:127, test/test-mode-file-path-policy.test.mjs:141 | D-0034(후보) |
| RC-B-500 | 우회 모드에서도 SSH 권한 거부는 실패이며 승격·재시도 없음 | pathPolicy {bypassRoot:true}. helper 응답 {errorCode:'PERMISSION_DENIED', allowedRoot:'C:/secret', error:원문진단, rootPolicyApplied:'test-server-bypass'}, exit 1. upload와 download 각각 | failed true, data == {errorCode:'PERMISSION_DENIED'}, texts에 'PERMISSION_DENIED', 직렬화에 RAW_REMOTE_DIAGNOSTIC·credential·must-not-leak·C:/secret 없음. 호출 순서 [정책 조회, upload면 게시/download면 스냅샷, 정리]. 연결 profile upload는 ['writer'], download는 ['reader']. 모든 호출 elevate != true, runas·Start-Process·sudo 없음. download는 로컬 예약 0·저장 크기 0 | 순서·profile·부재·할당량 assert | portal-ssh, portal-app | test/test-mode-file-path-policy.test.mjs:154 | D-0002(후보) |
| RC-B-501 | 우회 정책은 명시된 승격 의도와 정리 권한을 바꾸지 않음 | pathPolicy {bypassRoot:true}, 업로드 operation elevate true | failed false. 순서 [정책 조회, 권한 확인(authorize), SFTP 업로드, 게시, 정리]. elevate 값 [true,true,true,false], bypassRoot 값 [true,true,true,undefined], 연결 profile ['writer'], 명령에 runas·Start-Process·sudo 없음 | 순서·플래그 배열 deepEqual | portal-ssh, portal-app | test/test-mode-file-path-policy.test.mjs:176 | D-0002(후보) |
| RC-B-502 | 연결에 고정된 정리는 정책을 다시 요청하거나 우회하지 않음 | 연결 객체가 cleanup()을 제공하는 상태. 업로드 후 다운로드, pathPolicy 호출 카운트 | 둘 다 failed false. 일반 호출 순서 [정책, 게시, 정책, 스냅샷](정리는 연결 고정 cleanup 호출 2회). 연결 옵션 cleanup 키 집합 == ['helper','id','platform'], platform 'windows', id는 /^[a-f0-9]{48}$/ (첫 연결은 operation.artifactId와 동일) | 키 집합·id 형식·cleanup 호출 수 assert. 3.0은 helper 경로 없이 연결 고정 SFTP 정리 | portal-ssh | test/test-mode-file-path-policy.test.mjs:189 | - |
| RC-B-503 | 일반 Windows/Linux 대상의 파일 정책과 실제 권한 경계 구분 | 기본 정책(testServer 없음). Windows 'windows', Linux 'linux' 대상. pathPolicy({bypassRoot:true, testServer:true}) 입력(위조) | Windows pathPolicy == {bypassRoot:false}, filePolicy() == {testServerConfigured:false, testServerActive:false, mode:'configured-root', allowedRoot:null, allowedRootObservedAt:null, osPermissionsEnforced:true, pathSafetyEnforced:true, elevationRequiresExplicitRequest:true}. Linux filePolicy mode 'ssh-account-permissions'(나머지 동일). listFilePolicies: defaultTarget 'windows', targets 3개, windows·linux filePolicy 위와 동일 | deepEqual | portal-app, portal-web | test/test-mode-file-policy-application.test.mjs:76 | D-0002(후보) |
| RC-B-504 | root 우회는 활성 testServer 정책과 유효 secret이 함께 있어야 허용(secret 캐시 금지) | windows 대상에 testServer true 정책 시드. secret 마커 64자 정상 값에서 pathPolicy({bypassRoot:false}). 마커를 undefined, '', 'invalid-marker'로 바꿔 호출. 다시 '2'*64 | 정상: pathPolicy == {bypassRoot:true}(입력 무관), filePolicy == mode 'test-server-bypass', testServerConfigured true, testServerActive true. 무효 마커 3종: pathPolicy는 /Test server capability unavailable/ 오류, filePolicy mode 'configured-root', configured true, active false. 마커 복구 후 pathPolicy() == {bypassRoot:true} | 마커별 결과 assert | portal-app, portal-domain | test/test-mode-file-policy-application.test.mjs:87 | D-0002 |
| RC-B-505 | 다른 대상의 testServer 정책·위조 클라이언트 필드·오래된 revision·다른 profile 정책은 현재 대상에 우회 권한을 주지 않음 | (a) 'other' 대상에만 testServer 정책. windows에서 pathPolicy({bypassRoot:true, testServer:true, fileTargetId:other.id, fileTargetRevision:other.revision, profile:other.writeProfile}) (b) windows 정책의 targetRevision '0'*64 또는 profile 'other-write' | (a) windows pathPolicy == {bypassRoot:false}, filePolicy 기본값(configured-root), other 대상 pathPolicy() == {bypassRoot:true}. (b) 두 경우 모두 pathPolicy == {bypassRoot:false}, filePolicy 기본값 | deepEqual | portal-app, portal-domain | test/test-mode-file-policy-application.test.mjs:100, test/test-mode-file-policy-application.test.mjs:109 | D-0002(후보) |
| RC-B-506 | secret 검사 중·SFTP 이후의 정책·secret 변경은 이전 우회 권한을 반환하지 않고 원래 연결 정리를 유지 | (a) pathPolicy 진행 중 secret 확인을 보류하고 정책을 testServer false로 저장 후 해제 (b) 업로드 중 SFTP 완료 직후 secret 마커를 제거 | (a) 보류된 호출은 dispatchFailureDetails == {dispatchFailureReason:'policy_changed', dispatchFailureStage:'policy_guard'}로 reject, 이후 pathPolicy() == {bypassRoot:false}. (b) 업로드는 /Test server capability unavailable/로 reject, 호출 순서 actions == ['policy'](게시 없음), effects == ['sftp-uploaded','cleanup'], 이후 filePolicy == 기본값 + testServerConfigured true, testServerActive false, allowedRoot 'C:/approved', allowedRootObservedAt == 관찰 시각 | 오류 세부·순서·effects assert | portal-app, portal-ssh, portal-domain | test/test-mode-file-policy-application.test.mjs:117, test/test-mode-file-policy-application.test.mjs:134 | D-0002(후보) |
| RC-B-507 | MCP targets 출력이 활성 파일 정책을 strict filePolicy 스키마로 공개 | testServer true 정책. MCP targets 호출. 이후 마커 제거 후 재호출. 응답의 filePolicy에 bypassRoot:true 필드를 덧붙여 스키마 검증 | targets 도구에 outputSchema 존재, isError 없음, 공개 스키마 parse 결과가 structuredContent와 동일. windows filePolicy == mode 'test-server-bypass', configured true, active true. 추가 필드(bypassRoot) 포함 시 safeParse 실패(strict). 마커 제거 후 mode 'configured-root', configured true, active false. 응답에 'synthetic-owner', 'secret://', 'windows-write', 'SHA256' 없음 | 스키마 검증·deepEqual·부재 assert | portal-web, portal-app | test/test-mode-file-policy-application.test.mjs:159 | D-0006(후보) |
| RC-B-508 | 실제 대상 설정(profile host) 변경은 policy 조회와 우회 권한을 모두 중단 | testServer 정책 시드 후 windows-write profile의 host를 'changed.example.test'로 변경. pathPolicy(), filePolicy() 호출 | 두 호출 모두 /configuration changed/ 오류로 reject | 오류 메시지 assert | portal-app, portal-domain | test/test-mode-file-policy-application.test.mjs:176 | D-0002(후보) |
| RC-B-509 | test server secret 검사: 닫힌 실패, 기존 resolver 사용, 능력 캐시 금지 | reference ''/undefined/'arbitrary'/'secret://local-file/../bad'는 resolver 호출 없이 available() false, require() /capability unavailable/. reference 'secret://local-file/test-server': 값 'a'*64 → available true; 값을 undefined, '', 'not-a-valid-marker', 1, null로 바꾸며 매번 available false, require reject; 'b'*64로 복구 시 require 성공. 'secret://vault/test-server' resolver가 Error('private provider details') 던지면 require | 잘못된 reference 4종: resolver 호출 총 0. 유효 reference: 값 변경이 즉시 반영(캐시 없음). resolver 예외 시 오류 message가 정확히 'Test server capability unavailable'(내부 메시지 비노출) | 호출 횟수·메시지 assert | portal-app, portal-domain | test/test-server-mode.test.mjs:5 | D-0002(후보) |
| RC-B-510 | 다운로드 예약 할당량 실패는 SSH 효과 전에 유형화된 not_started 실패, 연결 실패는 예약 해제 | (a) Artifacts(maxBytes 16, budget 16)에 size 16 활성 begin 1건 후 download {kind:'download', remotePath:'/tmp/input.bin', elevate:false} (b) Artifacts(maxBytes 32, budget 32), 연결 획득이 Error('synthetic disconnect')를 던지는 상태에서 download {remotePath:'/tmp/x', elevate:false} | (a) reject, executionFailureDetails == {stage:'operation', code:'ARTIFACT_QUOTA', remoteOutcome:'not_started', automaticReplay:false}, SSH 연결 시도 0, 기존 artifact 유지·reserved 16, 목록·디렉터리 파일 목록 불변. (b) reject, reserved 0, size 0 | 오류 세부·카운터·디렉터리 assert | portal-ssh, portal-store | test/transfer-failure.test.mjs:14, test/transfer-failure.test.mjs:30 | D-0012(후보) |
| RC-B-511 | 실패한 범위(scoped) 다운로드는 원 거절을 보존하고 소유 대상에게만 정리 확인 1회를 허용 | Artifacts(maxBytes 16, budget 32), 대상 owner(revision 'a'*64)·other('b'*64) 범위 view. owner/other가 각각 reserveDownload({fileName:'x', remotePath:'/tmp/x', elevate:false}). owner.receiveDownload가 Error('Original dispatch refusal') 던짐 | owner 수신은 같은 오류 객체로 reject. owner item은 저장소에서 제거(has false), other 항목 유지(has true). other.remove(ownerItemId)는 /Unknown transfer/. owner.remove(ownerItemId) 1회 성공 후 재호출은 /Unknown transfer/. owner.remove(foreign.id)는 /another target/. owner.receiveDownload(foreign.id,…)는 /another target/이며 쓰기 콜백 0회, foreign 유지, store.reserved == foreign size | 오류 동일성·메시지·상태 assert | portal-store, portal-app | test/transfer-failure.test.mjs:42 | - |
| RC-B-512 | 업로드 전송: 정확한 바이너리 스트림, 승인 메타 동결 검증, sudo 승격 게시 후 비승격 정리 | 저장소 begin({fileName:'binary.zip', remotePath:'/root/binary.zip', size 4, sha256, overwrite true, elevate true}) 바이트 [0,255,1,128] 업로드 완료. operation에서 overwrite를 false로 바꿔 호출, 이어서 원본 operation 호출 | 변경 operation은 /frozen/ 오류로 reject, 연결 0. 원본: 업로드된 바이트 == 원본, 연결 profile ['writer'], failed false, texts ['Upload completed'], content undefined. 호출 순서 ['publish','cleanup'], publish 명령은 'sudo -n '으로 시작, cleanup 명령은 sudo로 시작하지 않음, publish payload overwrite true, sha256 == 해시, maxBytes 16. 업로드 원격 경로는 /[a-f0-9]{48}\.part$/ 형식 스테이징 파일, bounds.maxBytes 16 | 호출 순서·명령 접두·payload·바이트 assert. 3.0은 helper 대신 MINA SFTP(스테이징) + sudo exec 게시로 이식 | portal-ssh, portal-app | test/transfer-failure.test.mjs:111 | - |
| RC-B-513 | 업로드 전송 실패는 1회 시도, 게시 없음, 정리는 시도 | 업로드 스트림이 Error('upload disconnected')를 던지고 정리도 Error('cleanup disconnected') | failed true, execution.remoteState 'unknown', cleanupComplete false, requiresReconciliation true, automaticReplay false, data.remoteCleanup 'unconfirmed'. 업로드한 바이트 == 원본, 읽기 핸들 close 1회, 호출 순서 ['cleanup'](게시 없음), profile ['writer'] | 필드·핸들 close·호출 순서 assert | portal-ssh, portal-app | test/transfer-failure.test.mjs:127 | - |
| RC-B-514 | 다운로드 전송: 권한 profile 선택, 정확한 바이너리 보관, 중립 메타 반환 | download {remotePath:'/tmp/한글.zip', elevate: false 및 true} | profile [elevate ? 'writer' : 'reader'], failed false, data.fileName '한글.zip', size 4, sha256 == hash([0,255,1,128]), structuredContent undefined. 저장 파일 바이트 == [0,255,1,128], store.reserved 4, hasActiveWork false. 호출 순서 ['snapshot','cleanup'], snapshot 명령이 'sudo -n '으로 시작함은 elevate true일 때만, cleanup은 sudo 아님 | profile·data·바이트·명령 접두 assert | portal-ssh, portal-store | test/transfer-failure.test.mjs:141 | - |
| RC-B-515 | 다운로드 전송·해시 실패는 로컬 할당량을 정리하고 원격 정리를 시도하되 재시도하지 않음 | (a) 다운로드 스트림이 Error('download disconnected') (b) snapshot sha256 '0'*64(불일치). download {remotePath:'/tmp/x', elevate:false} | 둘 다 reject. store.reserved 0, size 0, 루트 디렉터리 비어 있음. 호출 순서 ['snapshot','cleanup'], profile ['reader'] | 카운터·디렉터리·호출 순서 assert | portal-ssh, portal-store | test/transfer-failure.test.mjs:157 | - |
| RC-B-516 | 원격 상위 폴더 없음(PARENT_NOT_FOUND) 안내 보존, 정리 확인 실패 시 unknown이며 재실행 없음 | helper 응답 exit 1 {errorCode:'PARENT_NOT_FOUND', error:'/private/secret: denied', stack:'private stack'}. 승인 큐 경유 업로드(overwrite false). cleanupError false 및 true | 정리 성공: 작업 state 'failed', result.failed true, execution.cleanupComplete true·requiresReconciliation false, 공개 result.isError true, structuredContent == {errorCode:'PARENT_NOT_FOUND'}, content == [{type:'text', text:'PARENT_NOT_FOUND: 원격 상위 폴더가 없습니다. 관리자가 폴더를 준비한 뒤 새 전송을 요청하세요.'}]. 정리 실패: state 'unknown', execution.remoteState 'unknown', cleanupComplete false, requiresReconciliation true, structuredContent.errorCode 'OPERATION_FAILED', remoteCleanup 'unconfirmed', 본문에 '자동으로 재시도하지 않습니다' 포함. 공통: 직렬화에 private, secret, stack, diagnostics 없음, 같은 작업 재승인은 /not pending/, 호출 순서 ['publish','cleanup'], profile ['writer'], 읽기 핸들 close 1회, publish payload overwrite false·sudo 아님 | state·공개 결과 deepEqual·부재 assert | portal-ssh, portal-app, portal-web | test/transfer-failure.test.mjs:168 | D-0034(후보) |
| RC-B-517 | 알려진 파일 오류 코드는 다운로드 실패·할당량 해제·정리를 보존하며 재시도하지 않음 | helper(3.0은 SFTP 오류 매핑) 응답 exit 1 {errorCode: FILE_NOT_FOUND, PERMISSION_DENIED, DESTINATION_EXISTS, UNSAFE_PATH, STAGING_UNAVAILABLE, FILE_CHANGED, FILE_TOO_LARGE, INVALID_REQUEST 각각}. download {remotePath:'/tmp/x', elevate:false} | 코드별 failed true, data == {errorCode: code}, texts[0]이 /확인\|새 (전송\|요청)/ 일치(안내문 포함). store.reserved 0, size 0, 디렉터리 비어 있음, 호출 순서 ['snapshot','cleanup'], profile ['reader'] | 8종 반복 assert | portal-ssh, portal-store | test/transfer-failure.test.mjs:199 | D-0034(후보) |
| RC-B-518 | 구형·미지·비정상·신호 종료 helper 오류는 고정 fallback만 노출 | 업로드에 helper 응답 8종(stderr는 모두 '/private/credential=do-not-expose'): exit 1 {error:secret}, exit 1 {errorCode:secret, error:secret}, exit 1 본문 secret 문자열, exit 1 본문 'null', exit 1 {errorCode:'__proto__'}, exit 2 {errorCode:'PARENT_NOT_FOUND'}, exit 1 signal 'TERM' {errorCode:'PARENT_NOT_FOUND'}, exit 0 {errorCode:'PARENT_NOT_FOUND', error:secret} | outcome deepEqual {failed:true, texts:['OPERATION_FAILED: 파일 작업이 실패했습니다. 관리자가 보호된 서버 진단과 대상 상태를 확인하세요. 파일이 이미 반영됐을 수 있으므로 대상 상태를 확인하기 전 재전송하지 마세요. 자동으로 재시도하지 않습니다.'], data:{errorCode:'OPERATION_FAILED'}}. 직렬화에 private, credential, do-not-expose, __proto__ 없음. 호출 순서 ['publish','cleanup'], profile ['writer'], 읽기 핸들 close 1회 | 전체 deepEqual·부재 assert(8종 반복) | portal-ssh, portal-web | test/transfer-failure.test.mjs:212 | D-0034(후보) |
| RC-B-519 | Windows 정책 원점 진단: 명시된 bounded policyReason만 보존하고 승격·재시도 없음 | platform windows, 정책 우회 true. helper 응답 exit 1 {errorCode:'PERMISSION_DENIED', origin:'policy', policyReason: UNTRUSTED_OWNER, MISSING_DACL, UNSAFE_ANCESTOR, UNTRUSTED_WRITER, UNSUPPORTED_ACE, SECURITY_DESCRIPTOR_TOO_LARGE 각각, 임의 필드 'arbitrary':원문진단, error/message/stderr에 'RAW_HELPER credential=must-not-leak SDDL private-path'} × upload/download | 12조합 모두 failed true, data == {errorCode:'PERMISSION_DENIED', diagnostic:{origin:'policy', policyReason}} (arbitrary 제외). 직렬화에 RAW_HELPER·credential·must-not-leak·SDDL·private-path 없음. 호출 순서 [정책 조회, upload면 게시/download면 스냅샷, 정리], profile upload ['writer']·download ['reader'], 모든 호출 elevate != true·runas·Start-Process·sudo 없음. upload: 업로드 바이트 == 원본·읽기 핸들 close 1. download: reserved 0·size 0·디렉터리 비어 있음 | data deepEqual·부재·순서 assert. 3.0은 MINA SFTP 경로의 ACL/소유자 검사 결과를 같은 diagnostic 계약으로 표현 | portal-ssh, portal-web | test/transfer-failure.test.mjs:264 | D-0001(후보) |
| RC-B-520 | Windows OS 원점 진단: 검증한 단계명과 정수만 공개, 잠금 안내 조건, queue 실패 유지 | helper 응답 {errorCode:'PERMISSION_DENIED', origin:'os', nativeStep, nativeError}: (open,5), (read_security,32), (rename_new,33), (native,0), (write_security,2147483647) × upload/download. 추가: errorCode 'OPERATION_FAILED'+(os, open, 32). 마지막으로 승인 큐 경유 업로드(os, open, 5) | 5종×2: data == {errorCode:'PERMISSION_DENIED', diagnostic:{origin:'os', nativeStep, nativeError}}. nativeError 32·33일 때만 texts가 /공유·잠금 충돌.*대상.*상태.*자동으로 재시도하지 않습니다/ 일치, 그 외에는 '공유·잠금 충돌' 미포함. errorCode 'OPERATION_FAILED'이면 data.errorCode 'OPERATION_FAILED'이고 잠금 문구 없음. 큐 경유: state 'failed', execution.cleanupComplete true, requiresReconciliation false, 공개 result.isError true, structuredContent == {errorCode:'PERMISSION_DENIED', diagnostic:{origin:'os', nativeStep:'open', nativeError:5}}, 호출 순서 ['publish','cleanup'], 재승인은 /not pending/ | data·문구·큐 상태 assert | portal-ssh, portal-app, portal-web | test/transfer-failure.test.mjs:274 | D-0034(후보) |
| RC-B-521 | 누락·위조·부분 진단은 추론 없이 전체 제외, 진단은 Windows의 정상 helper 실패 protocol에서만 수용 | (a) helper 데이터 malformed 목록(각각 errorCode 'PERMISSION_DENIED' 포함, Windows): {}, {nativeStep:'open',nativeError:5}, {origin:'policy'}, {origin:'policy',policyReason:원문진단}, {origin:'policy',policyReason:true}, {origin:'other',policyReason:'UNTRUSTED_WRITER'}, {nativeStep:'verify_owner',nativeError:0}, {origin:'policy',policyReason:'UNTRUSTED_WRITER',nativeStep:'open'}, {origin:'policy',policyReason:'UNTRUSTED_WRITER',nativeError:5}, {origin:'os',nativeStep:'open',nativeError:5,policyReason:'UNTRUSTED_WRITER'}, {diagnostic:{...}}, nativeError가 undefined/null/'5'/true/-1/1.5/2147483648/4294967295, nativeStep이 undefined/null/true/원문진단/'OPEN'. (b) 유효 진단 {origin:'policy', policyReason:'UNTRUSTED_WRITER'}를 Linux 플랫폼 upload, exit 2, signal 'TERM', errorCode 'UNKNOWN_CODE', exit 0에 실어 호출 | (a) 전부 data == {errorCode:'PERMISSION_DENIED'} (diagnostic 없음). (b) Linux: data == {errorCode:'PERMISSION_DENIED'}. exit 2·signal 'TERM'·미지 코드·exit 0 4종: data == {errorCode:'OPERATION_FAILED'} | data deepEqual(입력 수만큼 반복) | portal-ssh, portal-web | test/transfer-failure.test.mjs:303, test/transfer-failure.test.mjs:319 | D-0034(후보) |
| RC-B-522 | 정적 UI 번들 계약: 웹 스크립트 경로는 추가 모듈 경로가 필요 없는 독립 스크립트 | 웹 UI 스크립트 리소스(원 위치 web/dist/app.js, 3.0은 portal-web 정적 리소스) 텍스트 검사 | 줄 시작이 `import `인 구문이 없음(정규식 /^\s*import\s/m 불일치). 정적 UI 리소스가 외부 모듈 경로 없이 단독으로 로드됨. 구문 검증(node --check)은 삭제 사유로 처리(RC 외) | 리소스 텍스트에 import 선언 부재 assert | portal-web | test/ui-bundle.test.mjs:23 | - |
| RC-B-523 | Vault 설정 계약: HTTPS origin·평면 mount·로컬 전용 토큰 참조 고정 | env 필수(BRIDGE_MCP_TOKEN, BRIDGE_ADMIN_TOKEN, BRIDGE_ADMIN_ORIGIN) 기본: vaultOrigin '', vaultMount 'secret', vaultTokenRef ''. 유효 입력 BRIDGE_VAULT_URL 'https://vault.example.test:8200', BRIDGE_VAULT_MOUNT 'kv-2', BRIDGE_VAULT_TOKEN_REF 'secret://local-file/vault-reader-token', BRIDGE_JEV_KEY_REF 'secret://vault/model-safety-api-key'. 거부 입력 목록 | 기본값 위와 동일. 유효 입력 파싱 성공, vaultMount 'kv-2'. 허용 키 목록에 BRIDGE_VAULT_URL, BRIDGE_VAULT_MOUNT, BRIDGE_VAULT_TOKEN_REF 포함. URL 거부: 'http://vault.example.test', 'https://vault.example.test/', 'https://user@vault.example.test', 'https://vault.example.test?token=x', 'https://vault.example.test:443'. MOUNT 거부: '', '../secret', 'secret/data', 'secret%2fdata', 'a'*65, 3(비문자열). TOKEN_REF 거부: 'secret://vault/token', 'secret://other/token', 'plain', 'secret://local-file/../token', 3 | 파싱 결과·예외 assert | portal-app, portal-server | test/vault-kv.test.mjs:6 | - |
| RC-B-524 | Vault 포트: 안전하지 않은 이름·잘못된 토큰·변경 요청을 연결 없이 거절 | createVaultSecretStore({origin:'https://127.0.0.1:1', getToken}). read(name) 이름 '../token','name/other','%2f','','a'*65,3,{toString:()=>'model-key'}; 토큰이 undefined,'','has space','ü','x'*4097; 토큰 제공자 예외 Error('synthetic-private-body'); put/remove | 이름 7종: {code:'invalid_reference', message:'Secret operation refused'}로 reject, getToken 호출 0. 토큰 5종: code 'credential_unavailable'. 토큰 제공자 예외: message 'Secret operation refused', code 'credential_unavailable', cause 없음(내부 메시지 비노출). put·remove: code 'read_only' | 오류 code·message·cause 부재 assert | portal-app, portal-server | test/vault-kv.test.mjs:18 | - |
| RC-B-525 | semver 파서·비교기: v 접두·prerelease | parseSemver('v2.4.0'), ('2.4.1-rc.1'), ('invalid'); compareSemver('2.5.0','2.4.0'), ('2.4.0','2.4.0'), ('2.3.9','2.4.0'), ('2.4.0','2.4.0-rc.1') | normalized '2.4.0', '2.4.1-rc.1', null. 비교 1, 0, -1, 1(정식이 prerelease보다 큼) | 반환값 assert | portal-domain | test/version-check.test.mjs:32 | - |
| RC-B-526 | 포털 릴리스 검사기: update_available/up_to_date/ahead, 10초 쿨다운 캐시, 네트워크 실패·비200 우아한 저하 | currentVersion '2.4.0'(3.0은 현행 버전). 응답 tag_name 'v2.5.0', html_url 'https://github.com/jaeseongs95/ssh-approval-portal/releases/tag/v2.5.0', published_at. 시계 now를 진행: +5000ms refresh, +15000ms refresh. 별도 검사기: tag 'v2.4.0'+html_url 'https://evil.example/phish'; tag 'v2.3.3'; HTTP 503 | 첫 check: status 'update_available', updateAvailable true, currentVersion '2.4.0', latestVersion '2.5.0', releaseUrl 원 URL, HTTP 1회. +5초 refresh는 캐시 재사용(HTTP 호출 1 유지). +15초 후 refresh는 재조회(2). 동일 버전: status 'up_to_date', updateAvailable false, 신뢰하지 않는 URL은 'https://github.com/jaeseongs95/ssh-approval-portal/releases'로 대체. 더 낮은 최신 버전: status 'ahead', updateAvailable false. 503: status 'unavailable', updateAvailable false, latestVersion null | 필드·HTTP 호출 횟수 assert(HTTP는 가짜 서버/RestClient 대체) | portal-app, portal-web | test/version-check.test.mjs:42, test/version-check.test.mjs:90 | - |
| RC-B-527 | GET /api/version은 관리자 인증 필요, 릴리스 상태 반환 | 앱에 포털 릴리스 검사기(현재 '2.4.0', 최신 응답 tag 'v2.5.1', html_url 릴리스 URL). 인증 없이, Authorization 'Bearer admin-secret'로 GET /api/version | 인증 없음 401. 인증 있음 200, body.status 'update_available', latestVersion '2.5.1', updateAvailable true | HTTP 코드·본문 필드 assert | portal-web, portal-app | test/version-check.test.mjs:101 | - |
| RC-B-528 | 웹 API 클라이언트: GET 마감·교체는 전송이 abort를 무시해도 정착, POST는 단일·무제한 | fetch가 영원히 pending인 가짜. (a) api('/read','GET',undefined,{signal}) 후 abort (b) 같은 GET에 timeoutMs 5 (c) api('/write','POST',{},{timeoutMs:1}) | (a) AbortError로 reject, fetch에 전달된 signal.aborted true. (b) TimeoutError로 reject. (c) 10ms 후에도 미완료(timeout 미적용), 해당 호출의 signal undefined, fetch 호출 총 3회, 응답을 풀면 완료 | 오류 name·signal·호출 수 assert. 정적 UI JS 모듈을 Playwright for Java로 실제 브라우저 페이지에서 불러 실행(메인 판정 4) | portal-web(브라우저·Playwright Java) | test/web-session.test.mjs:69 | - |
| RC-B-529 | 관리자 세션 부트스트랩·종료 API: 로그아웃은 부트스트랩을 기다리고 전역 로그아웃을 보내지 않음, 부트스트랩 실패는 조용한 재시도 없이 명시적 재연결 노출 | (a) accessMode, /api/session/start가 장벽에서 대기 중 beginAdminSession과 endAdminSession 동시 호출 (b) 실패 유형 http(ok false, 503, json 예외), network(fetch 예외), json(ok true, json 예외)에서 beginAdminSession 후 api('/api/requests') (c) 컨트롤러 reconnect() | (a) 장벽 해제 전 호출 목록 ['/api/session/start'], 해제 후 ['/api/session/start','/api/session/logout'] (전역 로그아웃 요청 없음). (b) beginAdminSession reject, 오류 메시지에 'SYNTHETIC_PRIVATE' 없음, unauthorized 표시 콜백 1회, 이후 api('/api/requests')도 reject, 호출 목록 == ['/api/session/start'](재시도 없음). (c) reconnect 후 호출 목록 ['/api/session/start','/api/session/logout'], 내비게이션 ['/'] | 호출 순서·메시지 부재·내비게이션 assert(실패 3유형 반복) | portal-web(브라우저·Playwright Java) | test/web-session.test.mjs:229, test/web-session.test.mjs:248 | D-0025(후보) |
| RC-B-530 | 웹 컨트롤러 폴링: 초기·일시적 읽기 실패는 폴링으로 복구, 인가 거부는 폴링 중단, POST 비재시도 | 읽기 api가 호출 1·3번째에 status 503, 5번째에 status 403, POST는 'response lost'로 실패. load(), 타이머 tick, load(), tick, decide('fixed-request','approve') | 초기 일시 실패 뒤에도 폴링 예약 유지(타이머 1개, state.polling != null), tick 후 render [[2]], 두 번째 일시 실패 뒤에도 유지·tick 후 render [[2],[4]]. decide: POST 1회, 응답 유실 시 읽기 1회(호출 총 5회, 5번째 403)로 조정, 403 이후 폴링 중단(clearInterval 호출, state.polling null), reloadState().blocked true | render 기록·타이머·카운터 assert | portal-web(브라우저·Playwright Java) | test/web-session.test.mjs:79 | - |
| RC-B-531 | 승인 결정 처리: 응답 유실 시 unknown 유지·재전송 금지, 비동기 수락, 결정 잠금 해제, 오래된 스냅샷 폐기 | (a) POST가 'accepted response lost'로 실패. decide('fixed','approve') 2회, load(true), 작업 상태를 'running'으로 변경 후 load(true) (b) POST를 지연시키는 가짜: 대기 2건(first, second)에서 load, 오래된 읽기 시작, decide('first','approve') 2회, accept, 오래된 읽기 해소, 새 읽기 해소 | (a) 첫 decide 후 reloadState().blocked true, 둘째 decide는 POST 재전송 없음(posts 1), load(true)에서 상태 'pending'이면 blocked true 유지, 'running'이면 blocked false, posts 1. (b) POST 정확히 1회, 세 번째 호출 옵션 == {preferAsync:true}, 수락 전 blocked true, 수락 후 blocked false·마지막 deciding 값 false, 수락된 작업이 즉시 'running'으로 렌더(마지막 render[0].state 'running'), 오래된 스냅샷 해소가 pending으로 되돌리지 않음, 새 읽기 해소 후 render[1].state 'pending' | blocked·호출 옵션·렌더 순서 assert | portal-web(브라우저·Playwright Java) | test/web-session.test.mjs:90, test/web-session.test.mjs:99 | - |
| RC-B-532 | 웹 UI 영어 라벨, 10초 자동 타이머, 수동·결정 후 즉시 갱신(진행 중 자동 GET 보존) | 언어 'en-US'. 불러오기 클릭, 요청 상세 열기, 불러오기 재클릭, 'Approve and run' 클릭, document.hidden true에서 타이머 실행. 결정(approve/deny) 중 자동 GET 보류, 토큰 입력칸 Enter | 타이머 주기 10000ms, connection-text 'Administrator connected', updated에 /Refreshes every 10 seconds/, 목록에 'View request details'와 'echo 한글 원문', 상세에 'Approve and run'. 수동 불러오기는 요청 정확히 1건 추가, 동작 클릭 후 마지막 두 요청 메서드 ['POST','GET'], 숨김 문서에서는 타이머가 요청을 추가하지 않음. 결정 갱신: 진행 중 GET을 취소하고 기다리지 않아 요청 4건, 메서드 ['GET','GET','POST','GET'], approve의 Prefer 헤더 'respond-async'(deny는 undefined), pending-count 0, 상세 상태 /Completed/(approve)·/Denied/(deny), 대기 동작 버튼 hidden true. Enter 수동 갱신은 진행 중 GET 뒤에 보존되어 메서드 ['GET','GET','GET'] | 텍스트·요청 기록·타이머 assert | portal-web(브라우저·Playwright Java) | test/web-session.test.mjs:118, test/web-session.test.mjs:135, test/web-session.test.mjs:150 | - |
| RC-B-533 | 브라우저 언어별 UI: 한국어 보존, 그 외는 영어 대체 | 언어 'ko-KR', 'ko', 'de-DE' 각각 불러오기 | connection-text 각각 '관리자 연결됨', '관리자 연결됨', 'Administrator connected'. 목록 텍스트에 'echo 한글 원문' 유지 | 텍스트 assert | portal-web(브라우저·Playwright Java) | test/web-session.test.mjs:129 | D-0023(후보) |
| RC-B-534 | Access 브라우저 자동 연결: 토큰 입력 숨김, bearer 자격 미전송 | accessMode 시작(언어 'ko-KR','en-US') | 토큰 입력 hidden true, 첫 요청 1건 헤더 Authorization undefined, credentials 'same-origin', 타이머 10000ms, auth-label이 ko-KR면 /본인/, en-US면 /account/ | 요청 헤더·라벨 assert | portal-web(브라우저·Playwright Java) | test/web-session.test.mjs:156 | - |
| RC-B-535 | 로그아웃 상태 정리: Access 로그아웃 현지화·내비게이션, 토큰 로그아웃은 자격 폐기 없이 페이지 초기화, 늦은 응답이 화면을 복원하지 못함 | (a) Access('ko-KR','en-US'): 상세 열고 자동 GET 보류 중 로그아웃, 해제 후 불러오기·타이머 (b) 토큰 모드: 토큰 입력 후 불러오기, 로그아웃 (c) 다운로드 완료 요청 상세 'Save file' POST 지연 중 로그아웃, access true/false | (a) 로그아웃 버튼 표시, 라벨 '로그아웃'/'Sign out', 내비게이션 ['/signed-out'], 폴링 clearInterval 호출, 이후 요청은 명시적 세션 로그아웃 1건만, 목록·이력 비어 있음, pending-count '0', 상세 hidden true·본문에 'echo 한글 원문' 없음, 불러오기 버튼 disabled true. (b) 시작 시 로그아웃 버튼 hidden true, 불러오기 후 표시, 로그아웃 후 token.value '', 내비게이션 ['/'], 요청 추가 없음, 목록 비어 있음, 상세 hidden·원문 없음. (c) 내비게이션 [access ? '/signed-out' : '/'], 이후 요청 증가는 access면 1(로그아웃)·아니면 0, history·jobs 비어 있고 상세 hidden·'fixture.bin' 없음 | DOM 상태·요청 수·내비게이션 assert | portal-web(브라우저·Playwright Java) | test/web-session.test.mjs:164, test/web-session.test.mjs:180, test/web-session.test.mjs:190 | D-0025(후보) |
| RC-B-536 | 관리자 로그아웃 응답 유실은 명시적 멱등 재시도 전까지 미확정 | endAdminSession이 첫 호출에 Error('SYNTHETIC_PRIVATE'), 이후 게이트 대기. controller.logout() 1회, 대기, 재시도 logout() 2회 동시, 게이트 해제. beforeLogout 훅(데스크톱 닫기) 카운터 | 첫 logout 후 state.signedOut true, 내비게이션 [], logoutRetry 표시 1회, 오류 문자열에 'SYNTHETIC_PRIVATE' 없음, 자동 재시도 없음(시도 1). 동시 명시 재시도는 하나의 진행 중 세션 취소 공유(시도 총 2), 해제 전 내비게이션 []. 해제 후 내비게이션 ['/signed-out'], 시도 2 유지, 데스크톱 닫기 훅 정확히 1회(재시도가 다시 열거나 닫지 않음), signedOut 화면 정리 1회 | 시도 수·훅 수·내비게이션 assert | portal-web(브라우저·Playwright Java) | test/web-session.test.mjs:234 | D-0025(후보) |
| RC-B-537 | 무관한 요청 변경은 기존 노드·선택된 이력 상세·출력 상태를 보존 | 토큰 모드, 대기 1건(command 'unchanged command')과 완료 1건(출력 'unchanged output', context 'unchanged caller context'). 이력 화면에서 완료 건 상세를 열고 details 펼침, 출력 scrollTop 42. load 재호출 후 무관한 running 요청 추가 후 load | 재load 후 pending 행·history 행 노드 객체가 동일. running 추가 후에도 두 노드 동일(대기 버튼 하위 트리 교체 없음), running 영역에 'unrelated change' 표시. 상세 본문 노드 동일·dataset.requestId 유지·hidden false, 출력 요소 동일·scrollTop 42·텍스트 'unchanged output', 펼침 details open true이고 'unchanged caller context' 포함 | 노드 동일성·scrollTop·open assert | portal-web(브라우저·Playwright Java) | test/web-session.test.mjs:205 | D-0024(후보) |
| RC-B-538 | TEST 모드 우회 적용 미확인 시 전송 거절: 적용 정책 식별자가 `test-server-bypass`가 아니면 성공 응답도 실패 처리하고 재시도하지 않음 (Windows 대상 helper 우회 echo 확인 시험을 portal-ssh SFTP 경로 정책 결과 확인으로 이식; 메인 판정 6) | 서버 정책이 bypassRoot true인 TEST 모드에서 Windows 대상(`C:/outside-configured-root/한글.bin`, 허용 루트 밖) 업로드·다운로드 각각 실행. 경로 정책 평가 결과의 적용 정책 식별자가 (없음), `configured-root`, 불리언 true, 대문자 `TEST-SERVER-BYPASS` 인 네 경우(원 시험은 helper 응답의 `rootPolicyApplied` 필드. 3.0은 helper가 없으므로 portal-ssh 정책 평가기가 돌려주는 값) | 전송은 실패(`failed`=true)이고 데이터는 정확히 `{errorCode:'PATH_POLICY_UNSUPPORTED'}`. 외부 진단 원문(`RAW_REMOTE_DIAGNOSTIC`·`credential`·`must-not-leak`)이 결과에 없음. 호출 순서는 정책 확인 → 게시(업로드) 또는 스냅샷(다운로드) → 정리이고 SSH 연결(프로필)은 1회뿐이라 재시도 없음. 다운로드 실패 때 SFTP 다운로드 0건, 아티팩트 저장소 reserved 0·size 0 | errorCode deepEqual, 진단 문자열 부재 정규식, 호출 순서 목록, 연결 횟수 1, 저장소 reserved·size 0 | portal-ssh | test/test-mode-file-path-policy.test.mjs:107 | D-0002(후보) |
| RC-B-539 | TEST 모드 정책 응답이 구형·불일치이면 파일 전송 전에 거절 | 서버 정책 bypassRoot true인 TEST 모드에서 업로드·다운로드 각각. 정책 확인 결과가 (a) 적용 정책 식별자 `configured-root`(우회 불일치), (b) allowedRoot가 Windows 경로가 아닌 `/not-windows`, (c) 정책 오류 `INVALID_REQUEST`/알 수 없는 형식 응답. 원 시험의 `file-path-policy-v0`(구형 프로토콜 버전)·`{ok:true}` 형식 응답 입력은 helper 전송 형식이므로 이식하지 않음(3.0은 정책 평가기 결과로 대체) | 전송은 실패(`failed`=true), 데이터는 정확히 `{errorCode:'PATH_POLICY_UNSUPPORTED'}`. 정책 확인 외 호출(게시·스냅샷)이 없고 SFTP 업로드·다운로드 0건, 연결은 1회. 진단 원문 비노출. 다운로드 때 저장소 reserved 0·size 0 | errorCode deepEqual, 정책 외 호출 없음 assert, 업로드·다운로드 목록 비어 있음, 연결 1회, 저장소 reserved·size 0 | portal-ssh | test/test-mode-file-path-policy.test.mjs:209 | D-0002(후보) |

### G07 (원자료 1777~1832: windows-agent-cli-helper ~ windows-target, mjs 56행)

| 사례 ID | 대상 기능 | 입력·조건 | 기대 결과 | 판정 방법 | 3.0 모듈 | 원 시험 | 연결 결함 |
|---|---|---|---|---|---|---|---|
| RC-B-550 | CI 한정 Windows 고정 CLI 패키지 설치 시험의 전제(격리 계정·Node 선택) | `AGS_WINDOWS_CLI_PACKAGE_SMOKE=1`, GITHUB_ACTIONS=true, fixture의 임시 계정(`agsci`+hex12, 비관리자, SID `S-1-5-21-…`), 절대경로 node.exe. 사용자 PATH 앞에 node 디렉터리 추가 | 프로필 user==임시 계정, host 127.0.0.1, tty false, readOnly false. 기존 로그인 자료(`.codex/auth.json`·`.claude/.credentials.json`·`.claude.json`) 없음, 두 provider inspect `installed==false`. 운영 NodeRuntime 선택(첫 후보)이 후보 우선순위와 일치하고 준비한 node가 후보에 포함, 버전 `v22+`. 종료 시 사용자 PATH 원복 | SSH 실행 결과 JSON 필드·정규식·PATH 복원 assert (CI 전용 조건 시험으로 이식, 일반 시험은 skip 표시) | portal-ssh | test/windows-agent-cli-smoke.test.mjs:63 | - |
| RC-B-551 | CI 한정 고정 npm 패키지(codex 0.166.0, claude 2.1.316) 설치·버전·로그인 진단 | provider별 고정 tarball URL·integrity로 install(계획 expected=inspect의 revision, 만료 +900초, 임의 operationId). 설치 전 PowerShell과 JS가 계산한 정규 인수 JSON·intentDigest 비교. 응답 유실 시 status만 허용 | 정규 JSON(`{action,expected,expires,integrity,provider,version}`)과 intentDigest가 PowerShell·Java 두 쪽에서 일치. install `completed`·version==고정 버전. inspect `managed==true`·같은 버전. login-status 상태 `signed_out`. 예외 시 재설치 없이 status만 호출 | 정규 JSON 문자열·digest·state·version assert (CI 전용) | portal-ssh | test/windows-agent-cli-smoke.test.mjs:63 | - |
| RC-B-552 | CLI 의도 해시 정규화 | install 계획(codex 1.2.3, expected `b`*64, expires 1900000000000) | `intentDigest`==SHA-256(`{"action":"install","expected":"<64b>","expires":1900000000000,"integrity":"<integrity>","provider":"codex","version":"1.2.3"}\n`) (expected가 expires 앞, 끝 LF) | 문자열 직접 구성해 SHA-256 비교 assert | portal-domain | test/windows-agent-cli.test.mjs:11 | - |
| RC-B-558 | Windows 명령 실행 래퍼: 모든 catch 경로가 원 ErrorRecord와 위치를 보고 | `throw 'deliberate-test-error-7f3a'`를 직접 래퍼·준비된 부트스트랩·gzip 수신기 세 경로로 생성 | 세 스크립트 모두 `[Console]::Error.WriteLine($_.ToString())`와 `InvocationInfo.PositionMessage`를 포함하고 일반 문구 `Windows command failed` WriteLine이 없음. 준비 결과 stdin==원문, 직접 래퍼에는 원문 포함. 직접·수신기에 `$ProgressPreference='SilentlyContinue'` 포함 | 스크립트 문자열 포함/미포함 assert (3.0에서도 대상에 전달되는 PowerShell 래퍼의 관측 가능한 계약) | portal-ssh | test/windows-command-execution.test.mjs:8 | D-0009 |
| RC-B-559 | CLIXML 진행 기록 제거: 표시에서만 제거하고 stderr 원문은 호출자 소유 | stderr `#< CLIXML\r\n<Objs …><Obj S="progress" …>…</Objs>`, 진행+`<S S="Error">deliberate-test-error-7f3a</S>` 혼합, 일반 `plain stderr\n` | 진행만 있으면 표시 결과 `''`(원문 raw에는 `progress` 남음). 혼합이면 오류 문구는 포함하고 `S="progress"`는 제외. 일반 stderr는 그대로 | presentStderr 반환 문자열 비교 assert | portal-app (표시 가공) | test/windows-command-execution.test.mjs:22 | D-0011 |
| RC-B-560 | WIN-STDIN 최대 32KiB 원문의 stdin 전송·수신기 결속 | 한글·이모지·셸 특수문자 접두를 가진 정확히 32768바이트 원문. 32769바이트 | stdin==원문(32768B), 시작 명령 길이<8000, 수신기에 원문 미포함·원문 SHA-256 포함. 수신기는 정확히 32768 바이트 읽기·32769 버퍼·UTF-8 엄격 디코딩(BOM 없음, 잘못된 바이트 거부)·`exit $LASTEXITCODE` 보존·`Exception.Message` 미노출. Windows 분류는 POSIX 분류 호출 없이 `safe`. 32769B는 예외 `Invalid Windows command` | 바이트 길이·해시 포함·정규식·assert.throws | portal-ssh | test/windows-command-line.test.mjs:22 | - |
| RC-B-561 | WIN-EOF 수신기: 실제 파이프 종료만 EOF, 준비 범위 격리 | 수신기 스크립트와 workdir `C:\`+작은따옴표 509개로 준비한 계획 | 표준입력은 GetStdHandle(-10) 핸들을 ReadFile로 읽고 `ERROR_BROKEN_PIPE(109)`만 EOF로 취급, 그 외 오류는 예외, 읽기 길이 0 성공은 계속(루프). 핸들 Dispose/CloseHandle·SetCurrentDirectory·모듈 자동 로딩 변경이 수신기에 없음. 모듈 준비는 `$PSHOME\Modules\Microsoft.PowerShell.Utility`를 지역 범위로 가져옴. 시작 명령<8000. 스크립트에서 stdin 읽기가 해시 계산 전, 길이 검사가 소스 생성 전 | 수신기 문자열 정규식·순서(indexOf) assert (스크립트 텍스트 관측이므로 Java 쪽은 같은 수신기 상수의 구조 시험으로 이식) | portal-ssh | test/windows-command-line.test.mjs:44 | - |
| RC-B-562 | WIN-EOF 실제 0바이트 쓰기는 EOF가 아님 (Windows CI 전용) | PowerShell에서 stdin 파이프를 만들고 0바이트 WriteFile 뒤 3바이트(UTF-8 `한`)를 쓰고 허용 후에만 파이프 종료 | `Read` 첫 반환 3바이트(0이 아님)·값 237,149,156. EOF 허용 뒤 `Read`는 0. stdout `ok`, stderr 빈 문자열. 기동 10초·기능 10초 상한 안에 종료 | 프로세스 stdout/stderr·단계 파일 assert (GITHUB_ACTIONS+win32 조건 시험) | portal-ssh | test/windows-command-line.test.mjs:64 | - |
| RC-B-563 | WIN-LIMIT 512바이트 경로·32KiB 원문의 시작 명령 8000자 상한 | 의사난수 94자 집합(금지문자 제외)으로 정확히 512바이트 workdir. 원문 3종(32768B, `Microsoft.PowerShell.Utility\Get-Date`, `Microsoft.PowerShell.Management\Get-Location`) | 모두 `command.length<=8000`, stdin==원문, 수신기에는 workdir의 UTF-8 base64 포함·workdir 평문 미포함 | 길이·포함 assert | portal-ssh | test/windows-command-line.test.mjs:195 | - |
| RC-B-564 | WIN-WORKDIR 관리자 경로를 데이터로 결속·읽기 전용 모듈 고정 보존 | workdir `C:\한글\owner's files`와 거부 목록 `C:relative`, `\\host\share`, `/tmp`, `C:\a\..\b`, `C:\a:stream`, `C:\a?`, `C:\a\n`, `C:\a.`, `C:\a"b`, 일반 `C:\work` | 수신기에 `$workdir=[Text.UTF8Encoding]::new($false,$true).GetString(base64)` 형태로 데이터 결속, 평문 미포함, `Set-Location -LiteralPath $workdir`·`SetCurrentDirectory($workdir)`·`$PSModuleAutoLoadingPreference='None'`(읽기 전용 모듈 경로) 포함. 거부 9건은 예외 `/working directory/`. 일반 명령 workdir는 모듈 자동 로딩을 바꾸지 않음. 509개 작은따옴표 workdir도 <8000 | 정규식·assert.throws | portal-ssh | test/windows-command-line.test.mjs:215 | - |
| RC-B-565 | SEC-WIN-001 관리자 경로의 따옴표 5종이 코드로 삽입되지 않음 | workdir `C:\한글\owner<q>; calc.exe; # files`, q ∈ {`'`,‘,’,“,”} | base64 데이터로 복원한 값이 원 경로와 같고 수신기에 평문 경로·`calc.exe` 없음. stdin==`whoami.exe` | base64 복원 비교·미포함 assert | portal-ssh | test/windows-command-line.test.mjs:232 | - |
| RC-B-566 | WIN-NAMES 정적 전체 명령 이름 인식·대소문자 정규화 | `WHOAMI.EXE /user`, `Microsoft.PowerShell.Utility\Get-Date -Format "yyyy-MM-dd"`, `& 'C:/Program Files/Tool.EXE' 'owner''s data'`, `whoami.exe \| Microsoft.PowerShell.Utility\Select-Object -First 1; hostname.exe`, `whoami.exe '$env:NAME; $(literal)'`, `whoami.exe;`. 비Windows 대상은 Linux 파서 | 각각 names `['whoami.exe']`, `['microsoft.powershell.utility\get-date']`, `['c:\program files\tool.exe']`, `['whoami.exe','microsoft.powershell.utility\select-object','hostname.exe']`, `['whoami.exe']`, `['whoami.exe']`, complete true, usesSudo false. 플랫폼 미지정은 Linux 파서 결과와 동일. `windowsPolicyName('C:/Program Files/Tool.EXE')`=`c:\program files\tool.exe`, 모듈 한정 이름은 소문자 | deepEqual·문자열 비교 | portal-domain | test/windows-command-line.test.mjs:245 | - |
| RC-B-567 | WIN-NAMES 불완전·위험 구문은 이름 승인 포기 | `ls`, `Get-Date`, `customFunction arg`, `$name arg`, `& $name`, `& {whoami.exe}`, `whoami.exe "$env:USER"`, `whoami.exe $(hostname.exe)`, 역따옴표, 리다이렉션 `> out.txt`, `--%`, `\|` 끝, `\|\|`, `&&`, 따옴표 경로 단독, `function x {…}; x`, `@args`, `# hidden`, `'closed'unquoted`, `C:\a\..\whoami.exe`, 끝 개행. 정책 이름 무효: `Get-Date`, ` git.exe`, `git.exe `, `C:\a:stream.exe`, `가`*171+`.exe`, null | 각 명령 `complete==false`. `windowsPolicyName`은 위 무효 값 모두 null | complete 플래그·null assert | portal-domain | test/windows-command-line.test.mjs:245 | - |
| RC-B-568 | WIN-CAPABILITIES Windows source 가능 여부는 관리자 인터프리터 설정에만 의존 | `{platform:'windows'}`, `+pythonExecutable:'C:\Python\python.exe'`, `pythonExecutable:' '`, `{platform:'linux'}` | pythonSource false / true / false / true | targetCapabilities().pythonSource | portal-domain | test/windows-command-line.test.mjs:274 | - |
| RC-B-569 | SEC-WIN-001 곡선 따옴표는 이름 승인 전체를 포기하고 원문은 보존 | `whoami.exe 'ok’; calc.exe; #'`, 곡선 따옴표 4종을 명령명·경로·인수·혼합 따옴표 안에 넣은 7개 형태, 정책 이름 `whoami<q>.exe` 등 | `{names:[],complete:false,usesSudo:false}`, `prepareWindowsCommand(raw).stdin==raw`(원문 변형 없음), `windowsPolicyName` null. 정상 `whoami.exe 'ok'; hostname.exe`는 complete true로 두 이름 | deepEqual·stdin 비교 | portal-domain | test/windows-command-line.test.mjs:281 | - |
| RC-B-570 | DISPATCH-BIND 비TEST 연결 대기 중 변경: 명령 흐름(소유자 승인 명령·이름 승인 명령) | flow {owner(`unlisted.exe`), names(`whoami.exe`)} × 대기 단계 {registry, connect} × 변경 {대상 호스트 변경, 연결 profile 사용자 변경, 정책 재저장, 권한(deniedCommands), 만료, 유지보수} | 각 변경에서 작업 state `failed`, 원격 효과 command/sftp/publish/snapshot/cleanup 모두 0, 같은 id 재시작은 예외. 변경을 되돌리고 정상 제출하면 `completed`, 명령 효과 1회, 출력 state `ready` | 효과 카운터 deepEqual·state·assert.throws (SSH 채널·SFTP를 결정적 대기 fake로 둔 통합 시험) | portal-app, portal-ssh | test/windows-dispatch-binding.test.mjs:165 | - |
| RC-B-571 | DISPATCH-BIND 비TEST 연결 대기 중 변경: 파일 업로드·다운로드 | flow {upload(registry, connect, retry 단계), download(registry, connect)} × 위 6개 변경(권한은 automaticUploads/Downloads=false) | `failed`, 원격 효과(명령·SFTP·publish·snapshot·cleanup) 0, `C:/approved/output.bin` 미생성, 재시작 예외. 정상 제출은 `completed`, upload는 sftp 1·publish 1, download는 sftp 1·snapshot 1. retry는 채널 거절(reason 1) 뒤 재연결 중 변경도 차단 | 효과 카운터·원격 fixture 맵 존재 assert. helper 호출(publish/snapshot/cleanup)은 3.0에서 SFTP 단계(스테이징 쓰기·확정 이동·읽기·정리)로 대응 | portal-app, portal-ssh | test/windows-dispatch-binding.test.mjs:165 | - |
| RC-B-572 | DISPATCH-BIND 마지막 await 뒤 대상·만료·유지보수 변경도 클라이언트 획득 전 거부 | flow {owner,names,upload,download} × 변경 {target, expiry, maintenance}를 큐 시작 hook의 두 번째 검사 직후 microtask로 주입 | state `failed`, 효과 5종 모두 0 | 효과 카운터 deepEqual | portal-app | test/windows-dispatch-binding.test.mjs:198 | - |
| RC-B-573 | DISPATCH-BIND TEST 비밀 확인 await 도중 정책·대상 변경도 미실행 | testServer 정책으로 `whoami.exe` 제출 후 비밀 확인 대기 중 대상 호스트 변경 또는 정책 재저장 | 효과 5종 모두 0 | 효과 카운터 deepEqual | portal-app | test/windows-dispatch-binding.test.mjs:213 | - |
| RC-B-574 | DISPATCH-BIND 큐 없는 읽기와 기존 수동 파일 승인은 유지 | 자동화 꺼진 상태에서 `Microsoft.PowerShell.Utility\Get-Date` read. upload·download 제출 후 수동 start | read는 `failed==false`·명령 효과 1. 파일은 제출 직후 `pending`, start 뒤 `completed`, upload는 publish 1, download는 snapshot 1 | state·효과 카운터 assert | portal-app | test/windows-dispatch-binding.test.mjs:224 | - |
| RC-B-575 | DISPATCH-BIND 원격 효과 뒤 응답 유실은 자동 재실행하지 않음 | 명령 실행 뒤 채널이 stdout 없이 close | state `unknown`, `execution.reason=='transport_lost'`, `remoteState=='unknown'`, `automaticReplay==false`, 명령 효과 1회, 재시작 시도는 예외이고 효과는 계속 1 | state·execution 필드·효과 카운터 assert | portal-app, portal-ssh | test/windows-dispatch-binding.test.mjs:235 | - |
| RC-B-576 | DISPATCH-CLEANUP 부분 전송 뒤 승인 철회: 게시·수신 차단·자기 part만 정리 | flow {upload,download} × 철회 {정책 재저장, 만료, 유지보수}를 스테이징 완료(`staged-upload/download`) 대기 중 적용. 다른 작업의 `incoming/<f*48>.part` 존재 | state `failed`, publish 0, `execution.reason=='input_failed'`, `remoteState=='exited'`, `exitCode==1`, `cleanupComplete==true`, `requiresReconciliation==false`, `data.remoteCleanup=='confirmed'`. cleanup 1회(자기 스테이징 파일 삭제), 다른 작업 part와 `C:/approved/input.bin` 원본 바이트 불변, output.bin 미생성, 재시작 예외 | execution/data 필드·원격 맵 바이트 비교 | portal-app, portal-ssh | test/windows-dispatch-binding.test.mjs:245 | - |
| RC-B-577 | DISPATCH-CLEANUP 원래 대상·연결이 달라지면 삭제하지 않고 잔존 확인 필요 | flow {upload,download} × 변경 {대상 호스트, 연결 사용자, host-key 변경, 연결 끊김, client 교체} (정책은 철회 상태) | state `unknown`, `data.remoteCleanup=='unconfirmed'`, `remoteState=='unknown'`, `cleanupComplete==false`, `requiresReconciliation==true`, `automaticReplay==false`, `data.transferId`==스테이징 파일 id(48 hex). 표시 `structuredContent.transferId` 동일, 문구 정규식 `/원래 대상.*확인/`. publish 0, cleanup 0(삭제하지 않음), 스테이징·타 작업 part 바이트 보존 | 필드·presentJob 출력·문구·원격 맵 비교 | portal-app, portal-web | test/windows-dispatch-binding.test.mjs:270 | - |
| RC-B-578 | DISPATCH-CLEANUP 정리 응답이 거부·불완전이면 성공 단정 안 함 | flow {upload,download} × 정리 응답 {exit 1+`OPERATION_FAILED`, exit 0이나 확인 필드 없음} | state `unknown`, `remoteCleanup=='unconfirmed'`, `remoteState=='unknown'`, `cleanupComplete==false`, `requiresReconciliation==true`, `automaticReplay==false`, 표시 transferId 일치, 문구 `/이미 반영됐거나.*남아 있을 수/`. 본 효과(publish 또는 snapshot) 1, sftp 1, cleanup 1, 스테이징 바이트 잔존, upload는 output.bin도 반영됨 | 필드·문구·원격 맵 비교 | portal-app, portal-ssh | test/windows-dispatch-binding.test.mjs:301 | - |
| RC-B-579 | DISPATCH-CLEANUP 파일 효과 뒤 응답 유실은 정리 효과가 있어도 unknown 보존 | flow {upload,download}에서 모든 helper 호출 응답이 close로 유실 | state `unknown`, `remoteState=='unknown'`, `requiresReconciliation==true`, `automaticReplay==false`, 본 효과 1·cleanup 1, upload는 sftp 1·output.bin 존재, download는 sftp 0, input.bin 불변, 재시작 예외이고 본 효과 카운터 계속 1 | 필드·효과 카운터·원격 맵 | portal-app, portal-ssh | test/windows-dispatch-binding.test.mjs:317 | D-0013(후보) |
| RC-B-580 | Windows 원격 경로 문법: 허용·거부·basename | 허용: `C:\승인 파일\한글.bin`, `d:/승인 파일/한글.bin`, `C:/files/single'quote.bin`. 거부 28종: undefined, `''`, `C:`, `C:relative.bin`, `C:/`, `/tmp/file`, UNC 2종, `\\?\C:\file`, `\\.\NUL`, `C:/file:stream`, `..`·`.` 구성요소, 중복 구분자, 끝 `/`·`.`·공백, 개행, U+200B, `? * " < \|`, 예약 이름 `CON`/`nul.txt`/`AUX/file`/`prn`/`COM1.log`/`lpt9`/`COM¹`/`LPT²`, 4097자 경로 | 허용 3건은 입력 그대로 반환(Windows·any 둘 다). 거부는 모두 예외. `remoteBasename(path,'windows')`=`한글.bin`, `C:/files/file.bin`→`file.bin`, 플랫폼 `unknown`은 예외 | 반환·assert.throws | portal-domain | test/windows-file-contracts.test.mjs:21 | - |
| RC-B-581 | 기존 POSIX 경로 문법·기본 basename 보존 | `/tmp/한글.bin`, `/tmp/back\slash.bin`, basename `/tmp/directory///`, `///`. Windows 경로를 POSIX 검증, `C:/NUL.txt`를 any 검증 | POSIX 둘 다 통과(any도 동일). basename `back\slash.bin`/`directory`/`''`. Windows 경로(POSIX 검증)와 `C:/NUL.txt`(any)는 예외 | 반환·assert.throws | portal-domain | test/windows-file-contracts.test.mjs:38 | - |
| RC-B-582 | 클라이언트 기대값·전달 명세가 Windows 경로와 기존 결속 필드 수용 | download 기대값 `{size,sha256,target:'windows',targetRevision,remotePath:'C:\승인 파일\한글.bin',elevate:false}`. 명세 `version 1`, capability(download, windows, 목적지 포함). remotePath `C:/NUL.txt`·`C:/file:stream`로 변조 | 기대값은 deepEqual로 통과, 명세 remotePath 보존. 변조는 오류 코드 `INVALID_DOWNLOAD_EXPECTATION` / `INVALID_FILE_MANIFEST` | deepEqual·assert.throws({code}) | portal-client | test/windows-file-contracts.test.mjs:49 | - |
| RC-B-583 | 공유 저장소(artifact)가 두 대상 문법 수용·메타데이터 결속 보존 | Windows·POSIX remotePath 각각 begin→append(5바이트 `0,255,13,10,128`)→finish. importFile(stream, 크기 5). 잘못된 `C:/file:stream` begin | ready의 remotePath·targetId `windows`·targetRevision·`fileTargetBound==true` 보존. import 시 close 1회, remotePath·sha256 일치. 잘못된 경로 begin은 거절되고 `reserved==0` | 저장소 상태 필드·reserved 카운터 assert | portal-store | test/windows-file-contracts.test.mjs:60 | - |
| RC-B-584 | 파일 서비스 대상 문법 검사·Windows 관리자 토큰 요청 보존 | windows 서비스에 `/tmp/file`, linux 서비스에 Windows 경로로 beginUpload/requestUpload/requestDownload. 올바른 경로+binding(targetId, revision)로 begin·requestDownload, `elevate:true` 변형 | 잘못된 문법은 모두 거절되고 store·queue·source 부수 효과 없음(effects `[]`). 정상: `fileTargetBound==true`, targetRevision 보존, 다운로드 job id `job`. elevate 요청은 `operation.elevate==true`, 큐 level `privileged`. 효과 순서 `begin,submit,begin,submit` | 거절 assert·효과 배열·operation 필드 | portal-app | test/windows-file-contracts.test.mjs:82 | - |
| RC-B-585 | Windows 파일 전송 왕복·결속·정리 (helper 호출 순서) | binding된 artifact(5바이트 이진)를 upload, 같은 경로 download. upload 때 fileTargetRevision만 `c`*64로 변경 | 변경된 revision은 예외 `/frozen/`이고 연결 시도 없음. 정상 upload `failed==false`·전송 바이트 동일. download 결과 fileName `한글.bin`, artifact targetId·revision 결속, 저장 바이트 동일. 연결 프로필 순서 `[writer, reader]`. 원격 호출 순서 publish→cleanup→snapshot→cleanup, publish payload remotePath·sha256 정확. 스테이징 경로 형식 `C:/ProgramData/ssh-approval-transfer/incoming/<48hex>.part` | 호출 목록·바이트 비교·정규식. 3.0에서는 helper JSON 명령이 아니라 MINA SFTP 단계(스테이징 쓰기→검증→게시→정리)로 같은 순서·경로·결속을 확인 | portal-ssh | test/windows-file-contracts.test.mjs:110 | - |
| RC-B-586 | Windows 전송의 대상 문법·스테이징 경로 정규화·플랫폼 거부는 연결 전에 수행 | `/tmp/file`로 upload/download 시도. 스테이징 경로 `C:\ProgramData\portal\incoming`. 플랫폼 `unknown` | 잘못된 경로는 거절되고 store·transport 부수 효과 0. 스테이징 경로는 `C:/ProgramData/portal/incoming`으로 정규화. 플랫폼 `unknown`은 예외. (원 시험의 helper 경로 삽입 4종 `C:/dir/helper.ps1" & calc.exe`·`%USERNAME%`·`$(calc)`·`..` 거부는 helper 스크립트 경로 옵션이 3.0에 없으므로 이식하지 않는다) | effects 빈 배열·정규화 문자열 assert | portal-ssh | test/windows-file-contracts.test.mjs:148 | - |
| RC-B-587 | Windows 관리자 토큰 확인을 업로드 전에 요구하고 승인된 특권 의도 유지 | elevate=true artifact upload: authorize가 PERMISSION_DENIED(exit 1) 상태에서, 이어 authorize 성공(authorized·elevated true) 상태에서. 같은 artifact를 elevate=false로 upload. elevate=true download | elevate 불일치 upload는 예외 `/frozen/`. 거부 시 결과 `data.errorCode=='PERMISSION_DENIED'`, 업로드 스트림 0, 호출 `['authorize']`만. 성공 시 호출 `['authorize','publish','cleanup']`, elevate 플래그 `[true,true,false]`, download 호출 `snapshot` elevate true. 모든 연결은 writer 프로필. 호출 명령에 `runas`·`Start-Process`·`sudo` 없음 | 호출 배열·플래그·정규식 assert. 3.0에서는 SSH 계정이 관리자 토큰인지 확인하는 단계(권한 오류와 정책 거절 구분)로 이식 | portal-ssh | test/windows-file-contracts.test.mjs:165 | - |
| RC-B-588 | Windows 런타임 설정(pythonExecutable·workdir)이 대상 revision에 결속, TTY·잘못된 값 거부 | 기본 vs `pythonExecutable C:/Python313/python.exe, workdir C:/work` vs `workdir C:/other`. 거부: linux+pythonExecutable, `python.exe`, `python.cmd`, `other.exe`, `workdir C:/work/../other`, `workdir C:/work\u202e`. 프로필 tty true | revision 3개 모두 서로 다름. 거부 6건 모두 예외. read/write 어느 프로필이든 tty true면 예외 `/non-TTY/` | revision 비교·assert.throws | portal-app, portal-domain | test/windows-full-application.test.mjs:19 | - |
| RC-B-589 | Windows 정책의 명령 이름은 플랫폼을 명시하고 정규화 중복 거부 | rule commands `Microsoft.PowerShell.Utility\Get-Date`, `C:/Program Files/tool.exe` 통과. 거부: `[WHOAMI.EXE, whoami.exe]`, `[C:/work/tool.exe, c:\work\tool.exe]`, `[Get-Date]`, `[$(evil)]`, `[tool.exe;Remove-Item]`, platform 필드 누락 rule | 정상 rule은 commands 그대로 반환. 거부 5개와 platform 누락 모두 예외 | validateCommandPolicy 반환·assert.throws | portal-domain | test/windows-full-application.test.mjs:31 | - |
| RC-B-590 | Windows source·CLI 고정 계획이 같은 SSH 검증 경계를 통과, 변조 시 미실행 | 정상 source(`print('한글')`, cwd `C:/`, python `C:/Python313/python.exe`)와 CLI inspect 실행. CLI stdin에 `# changed`, source manifest interpreter 변경, command에 `; altered`, launcherBootstrapSha256 0, transportStdin 추가·제거(undefined), linux source에 transportStdin 추가 | 정상 두 실행 `failed==false`, SSH 채널에 전달된 stdin==계획의 transportStdin/stdin, CLI 결과 `agentCli.installed==false`. 변조 7종은 예외(일부 `/plan changed/`), 채널 호출은 정상 2회에서 늘지 않음 | 호출 기록(stdin)·assert.rejects·호출 수 | portal-ssh | test/windows-full-application.test.mjs:39 | - |
| RC-B-591 | Windows 앱: 명시 Python 경로로 승인된 source 실행, CLI를 Python 설정과 분리 | pythonExecutable `C:/Python313/python.exe` 대상, testServer 정책, `runSource(print('한글'), cwd C:/)` 후 관리자 API `POST /api/agent-cli/login-status {targetId:'windows',provider:'codex'}` | source job `completed`, 실행 1회, `manifest.platform=='windows'`, `manifest.interpreter=='C:/Python313/python.exe'`. login-status HTTP 200, `body.state=='signed_out'`, CLI 호출 1회, `manifest.contract=='agent-cli-powershell-v1'` | job state·manifest 필드·HTTP 상태/본문 assert | portal-app, portal-web | test/windows-full-application.test.mjs:70 | - |
| RC-B-592 | WIN-JEV-NAMES Windows 이름 승인과 전체 명령 평가가 같은 문법·대소문자 계약 | 7개 (명령, 승인 이름, 기대 explicit, 기대 이름): `WHOAMI.EXE /user`/[whoami.exe]/true/`whoami.exe`; `Microsoft.PowerShell.Utility\Get-Date -Format o`/…/true/`microsoft.powershell.utility\get-date`; `& 'C:\Program Files\Tool\tool.exe' --version`/[`C:/Program Files/Tool/tool.exe`]/true/`c:\program files\tool\tool.exe`; `whoami.exe /user`/[other.exe]/false/null; `whoami.exe; & $next`·`whoami.exe $env:USERNAME`·`Get-Date`/…/false/null. 불완전 명령에 위조 explicit:true 입력 | approval.explicit·commandName 일치. 문장 `The user has explicitly approved this command.`(true) / `This PowerShell command did not match the complete approved Windows literal command-name grammar.`(false). 평가 status `assessed`, 전송 상태 `userApproval.explicit` 일치·`targetPlatform=='windows'`·`commandLanguage=='windows-powershell-5.1'`. 불완전 명령에 explicit 위조 시 `reason=='invalid_input'`이고 모델로 전송하지 않음(전송 횟수 불변) | 전송 본문(seen) 필드·반환 reason assert (Jev 응답은 확률합 1인 합성) | portal-web (Jev RestClient), portal-domain | test/windows-jev-contract.test.mjs:25 | - |
| RC-B-593 | WIN-JEV-BOUND 서버 옵션만 Windows 문법 선택, Linux payload·승인 문장 보존 | registration 평가: proposedCommands 2개와 서버 옵션 `{targetPlatform:'windows'}`. 호출 본문에 targetPlatform 포함, context에 serverFacts 위조, 옵션 platform `invalid`. Linux 입력에 `targetPlatform:'windows'` 본문 필드. `explicitUserApproval('id -u',['id'])`/`([])` | Windows 옵션: proposedCommands 그대로·질문 `WINDOWS_COMMAND_SET_QUESTION`. 본문 위조·`invalid` 옵션은 `invalid_input`이고 전송 없음. Linux는 본문이 정확히 `{model:'jev-1.14.0', state:<원 입력>, questions:{risk:COMMAND_SET_QUESTION}}`(Windows 필드 무시). 승인 객체 `{explicit:true,statement:'The user has explicitly approved this command.',scope:'command-name',commandName:'id'}` / `{explicit:false,statement:'This command does not match the preapproved command set.',…}` | deepEqual(전송 본문)·reason assert | portal-web, portal-domain | test/windows-jev-contract.test.mjs:50 | - |
| RC-B-594 | WIN-JEV-APP 등록·실행·관측이 실제 target 플랫폼에 결속, 플랫폼 위조 등록 거부 | windows(`pythonExecutable` 포함)·linux 대상 앱. 관리자 API로 Windows 정책 review(commands 2개, externalDisclosure true, source 계약 `python-source-v1`) 후 저장. linux 플랫폼/linux 대상 revision으로 위조한 rule review. MCP `targets`·`submit`(command `whoami.exe /user`, kind command)·`observe`(includeOutput) | review 200, feedback[0].reason `assessed`. 등록 전송 상태 targetPlatform `windows`, context.serverFacts.targetPlatform `windows`, callerSituation에 `active administrator token`이 있고 sudo/root-owned 없음, 경고에 `활성 관리자 토큰`이 있고 sudo/root 소유 없음. 위조 2건은 HTTP 409이며 모델 전송 없음. targets의 windows capabilities.commandShell `windows-powershell-5.1`. submit 후 state `pending`, `decision.reasonCode=='observation_only'`, 마지막 전송 상태 targetPlatform windows·userApproval.explicit false, 실행 0회. observe: targetId `windows`·targetRevision 일치·state `pending`·outputPage null, 모델 재전송 없음·실행 0회 | HTTP 상태·MCP structuredContent·전송 기록·실행 횟수 assert | portal-web, portal-app | test/windows-jev-contract.test.mjs:66 | - |
| RC-B-595 | Windows Python source 계획: 바이트·환경·argv·관리자 토큰 요구 결속 | source `print('한글 source stays on stdin')\r\n`, argv `['a"b','한글','C:\tail\',"a'b",'$(ignored); &']`, pythonExecutable `C:\Program Files\Python\python.exe`. 인자별 변형(source+`\n`, argv, cwd, 실행 파일, elevate, profile, targetRevision, targetId). hostedtoolcache 경로 2종 | `plan.stdin==source`, sourceBytes==UTF-8 길이, transportBytes==프레임 길이. 프레임=`<헤더 바이트수>\n`+JSON 헤더(`{sourceBytes,sourceSha256,argv,cwd,elevate:false}`)+원문 바이트. manifest platform `windows`·interpreter·environmentRevision(`WINDOWS_PYTHON_SOURCE_ENVIRONMENT_REVISION`). 명령 `powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "& (…)"`, 부트스트랩에 `" $ \` % \r \n` 없음, 길이<=8000. 모든 변형의 planDigest가 원본과 다름. 계획·args·manifest는 frozen. `C:\hostedtoolcache\windows\Python\3.12.10\x64\python.exe`·`C:/hostedtoolcache/.../3.13.9/.../python.exe` 허용 | 프레임 바이트 분해·planDigest 비교·정규식·Object.isFrozen | portal-ssh | test/windows-python-source.test.mjs:48 | - |
| RC-B-596 | Windows Python launcher: 원문·인자 비노출·관리자 확인 위치·따옴표 안전 | 같은 계획의 launcher(gzip 복원), 수신기, elevate 계획, 곡선 따옴표(‘’“”)·`’; calc.exe; }catch{};#` 인자 | 부트스트랩 SHA-256==launcherBootstrapSha256, launcher SHA-256==launcherSha256. launcher에 소스 본문·`StandardInput.Write(Line)`·`Console.OpenStandardInput` 없음, `$i.Write($b,0,$n)`를 `SshApproval.Stdin.Read` 루프로 전달하고 `finally{$i.Close()}`만 사용. manifest JSON에 소스 본문 없음. elevate 수신기는 `if v['elevate']:` 에서 `ctypes.windll.shell32.IsUserAnAdmin()`을 `compile(` 앞에서 검사, launcher에 RunAs·Verb·sudo 없음. 곡선 따옴표·calc.exe는 launcher 평문에 없고 파일명은 base64 복원식, 인수는 `$s.Arguments='…'` | 정규식·해시·indexOf 순서 assert | portal-ssh | test/windows-python-source.test.mjs:48 | - |
| RC-B-597 | Windows source 입력 거부 목록 | 거부: platform `unknown`, pythonExecutable 없음/`python.exe`/`C:python.exe`/UNC/`..`/`:stream`/`py.exe`/배열, cwd `/`·`C:relative`·`C:\a\..\b`, environmentRevision `0`*64, elevate 문자열 `'true'`, argv `['\n']`·lone surrogate·17개·513자·512자×8. 소스 `''`·lone surrogate·NUL·16385자 | 모두 예외 | assert.throws | portal-domain | test/windows-python-source.test.mjs:94 | - |
| RC-B-598 | Windows source 경계값: source 16384B, argv 4096B, 시작 명령 8000자 | source 16384자 정상. argv 8개(509×7+508)=JSON 4096B, elevate 포함. 마지막 인자 +1자. 512바이트 python 경로·512바이트 cwd 동시 최대 | source 16384바이트 수용(`sourceBytes==16384`). argv JSON 정확히 4096B이고 시작 명령<=8000(elevate도). 4097B는 예외. 최대 경로·cwd·argv·elevate 조합도 <=8000. (원 시험의 Python helper 65536바이트 상한·`preparePythonHelper` 분리 검증은 Python helper의 언어 고유 구현이므로 이식하지 않는다. 대상 파일 helper는 SFTP로 대체) | 길이·바이트 수 assert | portal-ssh | test/windows-python-source.test.mjs:94 | - |
| RC-B-599 | Windows PowerShell 5.1에서 source 바이트·인자 원문 전달(BOM·개행 변환 없음) — Windows CI 전용 | 고정 Python으로 source(CRLF, `sys.stdin`은 비어 있음, `__file__` 없음, `__name__=='__main__'`)와 인자 `['한글',"a'b",'a"b','C:\tail\','','‘’“”',<따옴표 주입 페이로드>`] 를 직접/cmd/powershell 셸 3경로로 실행. 최대 argv 4096B. 존재하지 않는 Python | 종료 0, 출력 JSON==[인자, cwd, `__main__`], 주입 marker 파일 미생성(ENOENT). 최대 argv 동일. 런타임 없음은 종료 127과 stderr `/Python executable unavailable/` | 프로세스 종료 코드·stdout JSON·marker 부재 assert (CI 전용) | portal-ssh | test/windows-python-source.test.mjs:180 | - |
| RC-B-600 | Windows source 잘림·변조·추가 바이트는 효과 전 거부, EOF까지 대기 — Windows CI 전용 | 정상 프레임에서 부분 원문, 첫 바이트 변조, 끝에 `\n` 추가, 빈 입력. 별도로 정상 프레임을 쓰고 1초간 stdin 미종료 후 종료 | 거부 4종 종료 코드 125, marker(`effect.txt`) 미생성. 지연 종료: 1초 동안 marker 없고 프로세스 미종료, stdin 종료 후 종료 코드 0·marker 내용 `once` | 종료 코드·파일 존재·내용 assert (CI 전용) | portal-ssh | test/windows-python-source.test.mjs:231 | - |
| RC-B-601 | 실제 Windows SSH Python 실행: 정상·승인 만료·비관리자 상승 거부 | 고정 Python 경로로 `print('원문 실행 성공')` 실행. beforeDispatch가 `승인 만료` 던짐. elevate=true 계획을 비관리자 계정에서 실행 | 정상 `failed==false`·texts `['원문 실행 성공\r\n']`. 승인 만료는 예외(`/승인 만료\|SSH execution unavailable before dispatch\|unknown/i`)이고 marker 미생성. 상승 거부는 `failed==true`, 텍스트에 `Administrator connection token required`, marker 미생성 | 결과 필드·marker 부재 assert (실제 SSH 통합 시험) | portal-ssh | test/windows-python-source.test.mjs:266 | - |
| RC-B-602 | 실제 Windows SSH Python: 원문 16384B·최대 인자 정확 전달, 계획 변조·프레임 훼손 거부 | 16384바이트 source(한글 포함)+인자 `['한글',`공백 ' "`,'‘’“”',주입 페이로드]`. 최대 argv(4096B). transportStdin에 `\n` 추가한 계획. 프레임 1바이트 잘림·1바이트 추가 | `manifest.sourceBytes==16384`·sourceSha256 일치. 종료 0, 출력 JSON==[인자, 작업 폴더], 주입 marker 미생성. 최대 argv 동일. 변조 계획은 예외 `/plan changed/`. 잘림·추가 프레임은 종료 125이고 marker 미생성 | 종료 코드·stdout JSON·예외 메시지·marker 부재 | portal-ssh | test/windows-python-source.test.mjs:266 | - |
| RC-B-603 | 실제 Windows SSH 관리자 계정에서 상승·최대 인자 Python 실행 | 관리자 SSH 설정으로 elevate=true, profile `admin-write`, 최대 argv, cwd=adminFileRoot, 소스가 argv JSON 4096B를 단언하고 `administrator token verified` 출력 | `failed==false`, texts `['administrator token verified\r\n']`. (원 시험의 helper 65536바이트 보조 소스 실행 부분은 Python helper 언어 고유이므로 이식하지 않는다) | 결과 필드 assert | portal-ssh | test/windows-python-source.test.mjs:266 | - |
| RC-B-604 | 실제 SSH: 한글·양쪽 따옴표·종료 코드와 stderr 원문 | `[Console]::Write('한글 공백 \'작은따옴표\' "큰따옴표"')`. `[Console]::Error.Write("예상 실패"); exit 7`을 직접 래퍼·압축 수신기(stdin 전달) 두 방식으로 | 첫 결과 `failed==false`·texts==[원문 마커]. 두 방식 모두 exitCode 7, stderr가 정확히 `예상 실패`(CLIXML 등 부가 기록 없음) | 결과 필드 deepEqual (실제 SSH 통합 시험) | portal-ssh | test/windows-ssh-integration.test.mjs:26 | D-0011(후보) |
| RC-B-605 | 실제 SSH: LF·CRLF here-string과 탭 포함 여러 줄 명령 실행 | here-string `@' … '@`(LF)과 `@" … "@`(CRLF)로 탭·한글·`$env:PATH`를 포함한 여러 줄 원문 | stdin==원문, 원문 해시 일치. 결과 `failed==false`, texts `["한글 $env:PATH 'literal'\|second"]`(작은따옴표 here-string은 비확장), `['expanded 한글\|second']` | 결과 texts deepEqual | portal-ssh | test/windows-ssh-integration.test.mjs:26 | D-0005(후보) |
| RC-B-606 | 실제 SSH: 정확한 기본 읽기 명령은 외부 모듈 검색 경로의 동명 합성 모듈을 불러오지 않음 | `PSModulePath`를 오염시킨 뒤 `Microsoft.PowerShell.Utility\Get-Date`, `Microsoft.PowerShell.Management\Get-Location`을 읽기 프로필로 실행 | `failed==false`, 정상 출력 비어 있지 않음, `untrusted module loaded` 없음, fixture 모듈 marker 파일 미생성 | 출력 정규식·marker 부재 | portal-ssh | test/windows-ssh-integration.test.mjs:26 | - |
| RC-B-607 | 실제 SSH: 연결 후 승인 검사 거부는 명령을 실행하지 않음 | beforeDispatch가 `승인 만료` 던지는 `Set-Content` 명령 | 예외 `/승인 만료\|SSH execution unavailable before dispatch/`, 대상 파일 미생성 | assert.rejects·파일 부재 | portal-ssh | test/windows-ssh-integration.test.mjs:26 | - |
| RC-B-608 | 실제 SSH: 전송 직전 승인 거부 시 원격 파일·임시 바이트 미생성 | upload 준비 후 transfer의 beforeDispatch가 `승인 만료` 던짐 | 예외 `승인 만료`, 대상 파일 없음, 스테이징 디렉터리 빈 목록 | 파일 부재·디렉터리 목록 | portal-ssh | test/windows-ssh-integration.test.mjs:26 | - |
| RC-B-609 | 실제 SSH: 시간 초과는 성공으로 취급되지 않음 | `Start-Sleep -Seconds 30`, timeoutMs 500 | 예외(`/timeout\|timed out\|시간/i`)이거나 결과 exitCode!=0 또는 signal. 15초 안에 반환 | 예외 메시지·경과 시간 assert | portal-ssh | test/windows-ssh-integration.test.mjs:26 | - |
| RC-B-610 | 실제 SSH: 32KiB 한글 명령을 stdin으로 전달하고 작업 폴더를 함께 적용 | 정확히 32768바이트(접두 `[Console]::Write('한글 작업 폴더:'+[IO.Directory]::GetCurrentDirectory());#`+한글 패딩) 원문, workdir=fixture.fileRoot | 시작 명령<8000, 종료 0, stdout==`한글 작업 폴더:`+fileRoot | 종료 코드·stdout | portal-ssh | test/windows-ssh-integration.test.mjs:26 | - |
| RC-B-611 | 실제 SSH: 곡선 따옴표는 실제 PowerShell 구문 분석과 이름 승인에서 보수적 | `whoami.exe 'ok’; calc.exe; #'` | 이름 승인은 `complete==false`. 실제 PowerShell AST의 CommandAst 이름은 `['whoami.exe','calc.exe']`(곡선 따옴표가 문자열을 닫지 않음을 확인) | 이름 판정 값·SSH로 얻은 AST 결과 | portal-domain, portal-ssh | test/windows-ssh-integration.test.mjs:26 | - |
| RC-B-612 | 실제 SSH: 한글·작은따옴표·네 곡선 따옴표가 든 작업 폴더가 데이터로 복원 | workdir `fileRoot\한글 owner's ‘왼쪽’ “오른쪽”` | 종료 0, stdout==`<cwd>\|<cwd>` (PowerShell 현재 위치와 .NET 현재 디렉터리가 모두 원 경로) | stdout 비교 | portal-ssh | test/windows-ssh-integration.test.mjs:26 | - |
| RC-B-613 | 실제 SSH: 명령 수신기는 입력 손상·추가·잘림을 거부하고 EOF 전에는 실행하지 않음 | `[IO.File]::WriteAllText(marker,'once');[Console]::Write('EOF 완료')`의 stdin을 첫 바이트 비트 변경·1바이트 잘림·`x` 추가로 각각 전송. 정상 입력은 쓰기만 하고 1.5초 대기 후 EOF | 변조 3종 exitCode 125, marker 미생성. 정상: EOF 전 1.5초 동안 marker 없음, EOF 후 종료 코드 0·signal 없음·stdout `EOF 완료`·stderr 빈 문자열·원격 stdout EOF 확인·marker 내용 `once`. 60초 안에 종료 | 종료 코드·stdout/stderr·marker 내용·이벤트 순서 assert | portal-ssh | test/windows-ssh-integration.test.mjs:26 | - |
| RC-B-614 | 실제 SSH: 대기·거부 요청은 파일을 만들지 않고 승인 요청은 정확한 바이트를 왕복 | 262161바이트(`i%256`) 이진 upload 제출→pending 확인→deny→approve, 다시 제출→approve→download | pending 동안 원격 파일 없음, deny 뒤 approve는 예외 `/not pending/`·파일 없음. 승인 제출은 `completed`, 원격 바이트==입력, download `sha256`·`size` 일치, 저장 바이트 동일, 다시 approve는 `/not pending/` | 상태·바이트 비교·예외 | portal-ssh, portal-app | test/windows-ssh-integration.test.mjs:26 | - |
| RC-B-615 | 실제 SSH: 빈 파일·명시 덮어쓰기는 성공, 묵시적 덮어쓰기는 `DESTINATION_EXISTS`로 보존 | 0바이트 업로드·다운로드, 같은 경로에 `거부` 바이트 overwrite=false, 같은 경로에 `승인된 교체` overwrite=true | 빈 파일 왕복 성공(download size 0, 저장 바이트 빈). overwrite=false는 `failed==true`·`data.errorCode=='DESTINATION_EXISTS'`이고 원격은 빈 파일 유지. overwrite=true는 성공하고 원격==`승인된 교체` | errorCode·원격 바이트 | portal-ssh | test/windows-ssh-integration.test.mjs:26 | D-0034(후보) |
| RC-B-616 | 실제 SSH: 파일 권한 상승은 비관리자에서 전송 전 거부, 관리자 토큰에서 왕복 | 비관리자 계정에서 elevate=true upload. 관리자 SSH 계정에서 같은 elevate=true upload·download(바이트 `0,255,128,32,13,10`) | 비관리자: `failed==true`·`errorCode=='PERMISSION_DENIED'`, 원격 파일 없음, 스테이징 빈 목록. 관리자: upload `failed==false`·원격 바이트 동일, download `failed==false`·sha256 일치·저장 바이트 동일 | errorCode·바이트·스테이징 목록 | portal-ssh | test/windows-ssh-integration.test.mjs:26 | D-0034(후보) |
| RC-B-617 | 실제 SSH: 고정 CLI 관리자는 inspect와 로그인 상태 반환 | codex inspect·login-status | 둘 다 `failed==false`, inspect `agentCli.action=='inspect'`·`installed`는 boolean, login `state`는 `signed_in/signed_out/not_installed/unavailable` 중 하나 | 결과 필드 | portal-ssh | test/windows-ssh-integration.test.mjs:26 | - |
| RC-B-618 | 실제 SSH: 고정 가짜 공급망으로 CLI 설치·갱신·보존·상태·실패 제한 전체 검증 | 가짜 npm fixture 스크립트(`cli-supply-fixture.ps1`)를 `-File`로 실행(120초) | 종료 0, stdout `ok`, stderr 빈 문자열. 검증하는 하위 행동은 RC-B-541~549(결정 D3-16으로 삭제 표로 이동, 대체 S3-AG-01~10)와 같다(같은 fixture를 실제 SSH 계정 권한에서 실행) | 종료 코드·stdout/stderr | portal-ssh | test/windows-ssh-integration.test.mjs:26 | - |
| RC-B-619 | 실제 SSH: WRITER-ACL IO-only 대 상속된 유효 쓰기 권한 구분, OS 거부 진단, ACL 불변 | fixture 디렉터리 2종(creator-owner IO-only ACE(flags&8), 사용자 상속 쓰기 ACE). 루트 정책 우회(`pathPolicy bypassRoot`)로 두 디렉터리에 이진 upload·download, 관리자 전용 디렉터리에 upload | IO-only/상속 ACL fixture 구조 확인(IO-only는 InheritOnly, 상속은 유효 생성+쓰기 mask&6==6). 두 디렉터리 upload 성공·바이트 동일, snapshot sha256 일치. 관리자 전용 디렉터리는 `failed==true`, `data=={errorCode:'PERMISSION_DENIED',diagnostic:{origin:'os',nativeStep:'open',nativeError:5}}`, 파일 미생성. 전송 전후 ACL SDDL SHA-256이 fixture 값과 동일, 스테이징 빈 목록 | 결과 data deepEqual·ACL 해시·바이트 비교. 3.0 MINA SFTP에서는 PERMISSION_DENIED(OS 거부)와 정책 거절을 구분해 보고하고 ACL을 변경하지 않음 | portal-ssh | test/windows-ssh-integration.test.mjs:26 | D-0034(후보), D-0003(후보) |
| RC-B-620 | 실제 SSH: 테스트 모드의 허용 루트 우회는 SSH 계정 권한을 유지 | helper `policy`(bypassRoot true): protocol `file-path-policy-v1`, allowedRoot=fileRoot, rootPolicyApplied `test-server-bypass`. 루트 밖 경로에 허용 루트 지정 publish→우회 publish→snapshot→관리자 전용 경로 publish(우회) | 일반 모드 루트 밖은 exit 1·`PATH_OUTSIDE_ALLOWED_ROOT`(allowedRoot 포함)·파일 없음. 우회 publish `published==true`·rootPolicyApplied `test-server-bypass`·바이트 동일, snapshot 성공. 관리자 전용 경로는 exit 1·`errorCode=='PERMISSION_DENIED'`·`nativeStep=='open'`·`nativeError==5`·`origin=='os'`·`policyReason` 없음·미게시. 정리 후 스테이징 빈 목록 | helper 응답 필드. 3.0에서는 같은 정책 사유(루트 정책 vs OS 권한)를 SFTP 호출 결과의 오류 코드로 이식 | portal-ssh | test/windows-ssh-integration.test.mjs:26 | D-0002 |
| RC-B-621 | 실제 SSH: 대상측 방어 경계는 위험 경로·상태 변경·크기 초과 거부 | snapshot 경로: `x:stream`, `//localhost/C$/outside.bin`, `//?/C:/Windows/win.ini`, `CON`, `NUL.txt`, `COM1.log`, `LPT9`, `../outside.bin`, 끝 `.`·공백, junction 경유, symlink. publish sha256 0 불일치. snapshot maxBytes 4 | 위험 경로 12종 모두 exit 1·`UNSAFE_PATH`. 해시 불일치 `FILE_CHANGED`·파일 미생성. 크기 초과 `FILE_TOO_LARGE`. 영역 밖 원본 파일 불변, 스테이징 빈 목록 | errorCode·파일 내용 assert. 3.0 SFTP 경로 정책이 같은 코드로 거부 | portal-ssh | test/windows-ssh-integration.test.mjs:26 | D-0003(후보) |
| RC-B-622 | 실제 SSH: 틀린 클라이언트 키·호스트 키는 인증을 통과하지 못함 | 잘못된 클라이언트 키 구성·잘못된 호스트 키 구성(strict)으로 명령 실행 | 두 경우 모두 실행 예외(명령 미실행) | assert.rejects | portal-ssh | test/windows-ssh-integration.test.mjs:26 | - |
| RC-B-623 | WIN-CONFIG 기존 Linux revision 보존·명시 플랫폼·Windows workdir 검증 | platform 없는 대상(기존 revision 해시 `sha256(JSON{entry:{…,enabled:true},reader,writer})`), legacy 단일 대상, `platform:'windows'`/`'linux'`, 잘못된 platform `Windows`·`win32`·`''`·null·true, 프로필 workdir `/tmp`, 구성 변경 | 기존 revision이 고정 baseline과 일치, 대상 정의에 platform 키 없음, platformOf `linux`, commandShell `posix`. legacy revision도 고정 해시·identity undefined. windows revision은 baseline·linux 명시 revision과 다름, `identity.targetRevision==revision`. 잘못된 platform 5종은 예외 `/target configuration/`. workdir `/tmp`는 예외 `/workdir/`. 호스트 변경 후 verify는 예외 `/configuration changed/` | revision 해시 비교·assert.throws | portal-app, portal-domain | test/windows-target.test.mjs:29 | - |
| RC-B-624 | WIN-ENCODE UTF-16LE 래퍼가 원문·셸 특수문자 보존, 제어문자 거부 | 한글·이모지·`"`·`%PATH%`·`!X!`·`$env:TEMP`·역따옴표·`exit 7` 원문. 거부: `''`,` `,NUL,CR,ESC,DEL,`\x85`, lone surrogate | 명령은 `powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -InputFormat Text -OutputFormat Text -EncodedCommand <base64>`, 복원 스크립트에 원문이 정확히 1회 포함, 바깥 명령에 원문 평문 없음, `[Console]::OutputEncoding=`·`exit $LASTEXITCODE` 포함. 거부 8종 예외 `Invalid Windows command` | 정규식·포함 횟수·assert.throws | portal-ssh | test/windows-target.test.mjs:63 | - |
| RC-B-625 | WIN-BOUND ASCII·한글·이모지 모두 인코딩 후 8000자 경계 적용, 자르지 않음 | 단위 `x`·`가`·`😀`의 반복 수를 이분 탐색(1~4096) | 한계 초과는 오류 코드 `WINDOWS_COMMAND_TOO_LARGE`. 최대 수용 명령 길이<=8000이고 >=7993(Base64 4자 묶음보다 큰 여유 없음), 복원 스크립트에 원문 전체 포함, 한계+1은 예외 | 길이·code assert | portal-ssh | test/windows-target.test.mjs:77 | - |
| RC-B-626 | WIN-CLASSIFY POSIX 분류를 우회하지 않고 모듈 한정 무인수 읽기 두 개만 read-only | 기본 대상(platform 미지정)과 windows 대상 분류기. 읽기: `Microsoft.PowerShell.Utility\Get-Date`, `Microsoft.PowerShell.Management\Get-Location`, 앞뒤 공백+소문자 변형. 비읽기: `Get-Date`, `Get-Location`, `Get-Command`, `hostname`, `ls`, `pwd`, `…Get-Date -Format o`, `…Get-Date; Remove-Item x`, `…Get-Location \| Set-Content x`, `& { Get-Date }`, `Write-Output $(Get-Date)` | 플랫폼 미지정은 POSIX 분류기를 그대로 사용. Windows는 읽기 3건 `read-only`, 비읽기 11건 `safe`. POSIX 분류기 호출 횟수 0 | class 값·호출 카운터 | portal-domain | test/windows-target.test.mjs:93 | - |
| RC-B-627 | WIN-APP safe 명령은 소유자 승인을 거치고 원문·출력 수명·실제 래퍼 보존 | Windows 대상(자동화 꺼짐)에서 `hostname` read, safe 명령 `Write-Output '한글 %PATH% !X! $env:TEMP'` 실행·승인, 출력 조회, 모듈 한정 `Get-Date` read, 32769자·U+202E 포함 명령 | `hostname` read는 오류 코드 `READ_COMMAND_REQUIRES_APPROVAL`. safe 명령은 `pending`·commandClass `safe`·원문 보존·실행 0. 승인 후 `completed`, 출력 state `ready`, 실행 프로필 write, stdin==원문, 래퍼 명령에 원문 평문 없음, 감사 이벤트 `approved`+원문. 관리자 API 출력 200·text `synthetic-outcome`·출력 조회로 재실행 없음. `Get-Date` read는 read 프로필, stdin==원문. 거부 입력 2종은 예외이고 큐 항목 수·실행 수 불변 | 상태·실행 기록·HTTP 응답 assert | portal-app, portal-web | test/windows-target.test.mjs:155 | - |
| RC-B-628 | WIN-POLICY 불명확한 이름은 전체 평가·리터럴 이름 승인·플랫폼 문맥·대소문자 거부 | 정책 commands `whoami.exe`: `Write-Output "synthetic"` 실행. commands `WHOAMI.EXE`: `whoami.exe /user`. 정책 `Microsoft.PowerShell.Management\Remove-Item` 거부 목록과 `rEmOvE-iTeM …`·`…\REMOVE-ITEM …` | 이름 불명확 명령은 `pending`·`decision.reasonCode=='observation_only'`, 실행 0, 평가 입력 1건(command 원문·userApproval.explicit false, serverFacts targetPlatform `windows`·commandLanguage `windows-powershell-5.1`·targetRevision 일치). 대소문자 다른 승인은 `completed`·`command_set`, 추가 평가 없음. 거부 이름은 두 표기 모두 state `denied`·`policy_denied`, 평가·실행 증가 없음 | state·decision.reasonCode·평가 입력 필드·카운터 | portal-app | test/windows-target.test.mjs:186 | - |
| RC-B-629 | WIN-CAPABILITY Windows CLI·이름승인·승격파일 표시, source는 명시 Python 없이 TEST에서도 거부 | 관리자 API `/api/targets`·`/api/agent-cli`, testServer {false,true} 정책에서 `runSource({print(1), cwd '/tmp'})`와 32769자 명령 | capabilities `{commandShell:'windows-powershell-5.1',fileTransfer:true,elevatedFileTransfer:true,pythonSource:false,agentCli:true,commandNameApproval:true,desktop:false}`. agent-cli binding platform `windows`·`supported true`. TEST 모드 일반 명령은 `completed`·`decision.reasonCode=='test_server_bypass'`. runSource는 오류 코드 `TARGET_CAPABILITY_UNSUPPORTED`, 거대 명령 거절, 큐 항목 수 불변. 비지원 경로(source·CLI) 실행 0, 정상 TEST 명령만 1회 실행 | 능력 객체 deepEqual·오류 코드·카운터 | portal-app, portal-web | test/windows-target.test.mjs:215 | - |


### G08 (원자료 1840~1941: test_agent_cli ~ test_cloudflare_connector, py 102행)

| 사례 ID | 대상 기능 | 입력·조건 | 기대 결과 | 판정 방법 | 3.0 모듈 | 원 시험 | 연결 결함 |
|---|---|---|---|---|---|---|---|
| RC-B-631 | 대상 호스트 agent CLI 설치기: 실행 주체·provider·home 경계 | (a) 유효 UID가 root(0)로 Installer 생성 (b) provider `constructor` (c) home 디렉터리 mode 0o777 | (a) `NON_ROOT_REQUIRED` (b) `UNSUPPORTED_PROVIDER` (c) `UNSAFE_HOME`. provider는 codex·claude만 허용 | 세 입력 각각 Refused 코드 assert | portal-ssh·portal-app | test/test_agent_cli.py:69 | - |
| RC-B-632 | agent CLI 설치 성공과 동일 요청 재생 | codex 1.2.3 install(operation `a`*48, 올바른 sha512 integrity, 현재 installationRevision, 미만료) 후 같은 요청 재실행 | 첫 결과 `state=completed`·`login=not_checked`, inspect().version=`1.2.3`, 설치기 호출 1회. 같은 요청 재실행은 첫 결과와 동일하고 설치기 호출 수가 1로 유지 | 결과 상태·login 필드, 두 번째 결과 동치, 설치 호출 횟수 | portal-ssh·portal-app | test/test_agent_cli.py:73 | - |
| RC-B-633 | 같은 버전 새 요청의 검증된 설치 재사용 | 1.2.3 설치 후 다른 operation(`b`*48)·갱신된 revision으로 같은 버전 install | `state=reused`, 설치기 호출 수 1 유지(재설치 없음) | 결과 상태, 호출 횟수 | portal-ssh·portal-app | test/test_agent_cli.py:77 | - |
| RC-B-634 | 관리 설치와 다른 릴리스 integrity 거절 | 1.2.3 관리 설치 후 같은 버전·다른 sha512 integrity(`sha512-`+0x00*64)로 새 요청 | `INSTALLED_RELEASE_CHANGED`, 설치 상태(inspect) 불변, 설치기 호출 수 1 유지 | 오류 코드, inspect 전후 동치 | portal-ssh·portal-app | test/test_agent_cli.py:80 | - |
| RC-B-635 | codex·claude provider 분리 | codex 1.2.3 설치 후 claude 2.3.4를 같은 home에 install | claude 결과 `completed`, claude.inspect().version=`2.3.4`, codex는 `1.2.3` 유지, claude 설치기 호출 1회 | provider별 버전·상태 | portal-ssh·portal-app | test/test_agent_cli.py:84 | - |
| RC-B-636 | 업데이트가 이전 버전과 인증 파일 보존 | 1.2.3 설치·`~/.codex/auth.json`(합성 비밀 바이트) 존재 후 1.2.4 update | active 버전 `1.2.4`, 이전 버전 디렉터리의 `bin/codex` 바이트 불변, auth.json 바이트 불변(읽지 않고 보존), 설치기 호출 1회 | 파일 바이트 비교, active 버전 | portal-ssh·portal-app | test/test_agent_cli.py:89 | - |
| RC-B-637 | 다운로드·무결성 실패 시 패키지 설치기 미호출 | (a) 다운로드 실패 (b) 내려받은 바이트가 integrity와 불일치 | (a) `DOWNLOAD_FAILED` (b) `PACKAGE_INTEGRITY_FAILED`. 두 경우 모두 설치기(npm) 호출 0회, installationRevision 불변 | 오류 코드, 호출 목록 빈 값, revision 동치 | portal-ssh·portal-app | test/test_agent_cli.py:96 | - |
| RC-B-638 | 설치기·버전·경로 이탈 실패 시 기존 active 보존 | 1.2.3 설치 후 1.2.4 update를 (1) 설치기 실패 (2) 버전 출력이 `not a version` (3) bin/codex가 `/usr/bin/printf` 심볼릭 링크로 이탈 | (1) `NPM_FAILED` (2) `VERSION_UNAVAILABLE` (3) `UNSAFE_EXECUTABLE`. 모든 경우 `current` 링크 대상 불변, inspect().version=`1.2.3` | 코드, current readlink, 버전 | portal-ssh·portal-app | test/test_agent_cli.py:101 | - |
| RC-B-639 | 저장 보존 정책(영수증 + active·직전 버전) | 1.2.3 설치 후 1.2.4·1.2.5 update, 이어서 1.2.6 update 설치기 실패 | 각 operations/`<op>` 디렉터리는 `receipt.json` 한 파일만, 첫 결과에 `cleanupFailures` 키 없음. versions 디렉터리는 `1.2.4`·`1.2.5`만(활성+직전, 더 오래된 것 제거). 실패 요청 status=`failed`, 활성 버전 `1.2.5` 유지 | 디렉터리 목록, status 상태 | portal-ssh·portal-app | test/test_agent_cli.py:107 | - |
| RC-B-640 | 정리(cleanup) 실패 기록과 영수증 검증 | (a) 임시 캐시 삭제 중 unlink EACCES·rmdir ENOTEMPTY를 주입한 성공 설치 (b) 패키지 파일 unlink가 EACCES인 실패 설치(`NPM_FAILED`) (c) 저장된 receipt의 `cleanupFailures`를 0, -1, true, `'1'`로 변조 | (a) `state=completed`·`cleanupFailures=1`, status도 `cleanupFailures=1`(연쇄 ENOTEMPTY 없음) (b) status `state=failed`·`cleanupFailures=1` (c) 네 값 모두 status가 `INVALID_STATE` | 영수증·status 필드, 변조 값별 코드 | portal-ssh·portal-app | test/test_agent_cli.py:117 | - |
| RC-B-641 | 계획 만료·낡은 스냅샷·요청 충돌 | (a) 만료 시각=현재 시각 (b) 설치 후 이전 revision으로 새 operation (c) 같은 operation에 다른 version(`1.2.4`) | (a) `PLAN_EXPIRED` (b) `STALE_INSTALLATION` (c) `REQUEST_CONFLICT`. 설치기 호출 수 1 유지 | 오류 코드 3종, 호출 수 | portal-ssh·portal-app | test/test_agent_cli.py:149 | - |
| RC-B-642 | integrity·식별자 형식 검증 | integrity `sha1-aaaa`, `sha512-YQ==`, 끝에 공백, 끝 3자를 `B==`로 변조 / operation `../unsafe` / version `1.2.3;id` | integrity 4종 모두 `INVALID_INTEGRITY`, operation·version 위반은 `INVALID_PLAN`. 거절 후 관리 루트 디렉터리가 만들어지지 않음 | 코드, 루트 부재 | portal-ssh·portal-app | test/test_agent_cli.py:154 | - |
| RC-B-643 | 심볼릭 링크 부모·current의 관리 트리 이탈 차단 | (a) home의 `.local`이 외부 디렉터리 심볼릭 링크 → inspect·install (b) 정상 초기화 후 `current`가 `/etc`를 가리킴 → inspect | (a) 둘 다 `UNSAFE_DIRECTORY`, 외부 디렉터리에 아무것도 생성되지 않음 (b) `UNSAFE_CURRENT` | 코드, 외부 디렉터리 비어 있음 | portal-ssh·portal-app | test/test_agent_cli.py:160 | - |
| RC-B-649 | 외부(foreign) 설치 재사용·비덮어쓰기 | `~/.local/bin/codex`가 `codex-cli 1.2.3`을 출력(관리 설치 아님)하는 상태에서 같은 버전 install | inspect: `installed=true`·`managed=false`. 결과 `state=reused`, 설치기 호출 0, 외부 바이너리 바이트 불변, `current` 링크 생성 안 됨 | inspect 필드, 바이트 동치, current 부재 | portal-ssh·portal-app | test/test_agent_cli.py:200 | SSH_PORTAL-D-0041(후보) |
| RC-B-650 | 외부 설치와 다른 버전의 관리 설치 병존(두 provider) | codex·claude 각각 외부 1.2.2 설치+인증 파일이 있을 때 1.2.4 install | 결과 `completed`, 관리 설치 `managed=true`·버전 `1.2.4`, 외부 바이너리 바이트·mode 불변, 인증 파일 `SYNTHETIC_AUTH_PRESERVE` 불변, 설치기 호출 1회 | provider별 상태·바이트·mode | portal-ssh·portal-app | test/test_agent_cli.py:206 | SSH_PORTAL-D-0041(후보) |
| RC-B-651 | 외부 설치 위 관리 설치 실패 시 원본·인증 보존 | 외부 codex 1.2.2 존재, 1.2.4 install을 (1) 설치기 실패 (2) 버전 불명 | (1) `NPM_FAILED` (2) `VERSION_UNAVAILABLE`. 외부 바이너리·인증 파일 불변, `current` 링크 없음, installationRevision 불변 | 코드, 바이트, revision | portal-ssh·portal-app | test/test_agent_cli.py:214 | - |
| RC-B-652 | 설치 중 외부 바이너리 변경 감지 | 설치 도중 외부 codex가 1.2.5로 바뀜 | `STALE_INSTALLATION`, 변경된 외부 바이너리(`1.2.5`) 보존, `current` 링크 발행 안 됨 | 코드, 바이트, 링크 부재 | portal-ssh·portal-app | test/test_agent_cli.py:220 | - |
| RC-B-653 | 완료 영수증 기록 실패 시 직전 관리 링크 복구 | 1.2.3 관리 설치 후 1.2.4 update 중 `completed` 영수증 쓰기가 OSError | `INSTALL_FAILED`, `current` 링크 대상이 이전 active 그대로, 이전 바이너리 바이트 불변, status `failed` | 코드, readlink, 바이트, status | portal-ssh·portal-app | test/test_agent_cli.py:227 | - |
| RC-B-654 | 첫 관리 설치 영수증 실패 시 외부 설치 복구 | 외부 설치 존재 상태에서 첫 관리 설치의 `completed` 영수증 쓰기 실패 | `INSTALL_FAILED`, `current` 링크·경로 모두 없음, installationRevision 원복, 외부 바이너리·인증 바이트 불변, status `failed` | 코드, 부재, revision, 바이트 | portal-ssh·portal-app | test/test_agent_cli.py:234 | - |
| RC-B-655 | 롤백이 외부에서 교체된 current 링크를 보존 | 완료 영수증 쓰기 실패 순간 다른 주체가 `current`를 `versions/foreign-link-not-owned`로 교체 | `RECOVERY_REQUIRED`, `current`는 교체된 대상 그대로, 이전 버전 바이너리 파일 존재 | 코드, readlink, 파일 존재 | portal-ssh·portal-app | test/test_agent_cli.py:241 | - |
| RC-B-656 | 외부 설치의 update는 별도 install 요구 | 외부 설치만 있을 때 action=`update` | `MANAGED_UPDATE_REQUIRED`, 외부 바이너리 불변, 설치기 호출 0 | 코드, 바이트, 호출 수 | portal-ssh·portal-app | test/test_agent_cli.py:249 | - |
| RC-B-658 | 강제 종료된 작업은 unknown, 재실행 금지 | 설치기 실행 중 작업 프로세스를 terminate | status `unknown`, 같은 요청 재실행 `RESULT_UNKNOWN`, 설치기 호출 0 | status, 코드, 호출 수 | portal-ssh·portal-app | test/test_agent_cli.py:268 | - |
| RC-B-659 | 설치 마감 시한: 느린 다운로드 중단 | 만료까지 250ms, 다운로드가 1.5초 걸리는 install | `INSTALL_TIMEOUT`이 1.0초 미만에 발생, 설치기 호출 0, `installed=false`, status `failed`, 프로세스 전역 타이머·핸들러 원복(3.0에서는 시한 취소 자원 해제) | 코드, 경과 시간, 호출 수, status | portal-ssh·portal-app | test/test_agent_cli.py:280 | - |
| RC-B-660 | 마감 시한 초과 시 직전 버전·인증 보존 | 1.2.3 설치·인증 파일 존재, 1.2.4 update에서 설치기가 1.5초 지연되고 만료 250ms | `INSTALL_TIMEOUT`, inspect 전후 동치, 이전 바이너리·인증 파일 바이트 불변 | 코드, inspect 동치, 바이트 | portal-ssh·portal-app | test/test_agent_cli.py:289 | - |
| RC-B-662 | 외부 설치 탐색의 비신뢰 경로 실행 금지 | `~/.local/bin/codex`가 실행 시 marker 파일을 만드는 스크립트이고 (a) 상위 디렉터리 0777 (b) 파일 0775 (c) 심볼릭 링크 대상이 0777 디렉터리 | 세 경우 모두 inspect가 `UNSAFE_EXECUTABLE`, marker 파일 미생성(버전 조회 프로세스 미실행) | 코드, marker 부재 | portal-ssh·portal-app | test/test_agent_cli.py:351, test/test_agent_cli.py:352, test/test_agent_cli.py:353 | SSH_PORTAL-D-0041(후보) |
| RC-B-663 | 소유자 신뢰 네이티브 심볼릭 링크·인증 보존 | `~/.local/bin/codex`가 0700 소유 `~/native/codex`로의 심볼릭 링크 | inspect: `installed=true`·`managed=false`·version `1.2.2`, 대상 바이트·인증 파일 불변, 링크 유지 | 필드, 바이트, 링크 유지 | portal-ssh·portal-app | test/test_agent_cli.py:354 | SSH_PORTAL-D-0041(후보) |
| RC-B-664 | 완료 영수증의 디렉터리 ACK 실패와 실패 영수증 사전 실패(관리 설치 update) | codex·claude 각각 1.2.3 관리 설치 후 1.2.4 update에서 completed 영수증 교체 뒤 디렉터리 fsync 실패, 이어 failed 영수증 교체 직전 실패 | `RESULT_UNKNOWN`. 사건 순서 `[completed-after-replace, failed-before-replace]`, 영수증 `completed`, active 버전 `1.2.4`(롤백된 current와 completed 불일치 없음), 이전 바이너리·사용자 파일 불변, 설치기 1회, status `completed`, 새 객체로 같은 요청 재실행 시 `completed`이고 다운로드·설치기 호출 0 | 사건 목록, 영수증·status, 재실행 무호출 | portal-ssh·portal-app | test/test_agent_cli.py:444 | SSH_PORTAL-D-0035(후보) |
| RC-B-665 | 첫 관리 설치(외부 설치 존재) 동일 이중 실패 | 외부 1.2.3 설치+인증·사용자 파일이 있는 provider별 첫 install `1.2.4`에서 RC-B-664와 같은 이중 ACK 실패 | RC-B-664와 같은 기대(`RESULT_UNKNOWN`, 영수증 `completed`, 버전 `1.2.4`, 외부 바이너리 `1.2.3` 출력·사용자 파일 보존, 재실행 `completed` 무호출) | RC-B-664와 동일 | portal-ssh·portal-app | test/test_agent_cli.py:445 | SSH_PORTAL-D-0035(후보) |
| RC-B-666 | 완료 영수증 ACK 실패 후 기록된 실패로 이전 current 복구 | 관리 설치 1.2.3→1.2.4 update, completed 영수증 디렉터리 ACK 실패 후 failed 영수증은 정상 기록 | `INSTALL_FAILED`, inspect가 update 전과 동일(active 이전 버전), 이전 바이너리·사용자 파일·버전 조회 `1.2.3` 유지, status `failed`, 같은 요청 재실행은 `RESULT_UNKNOWN`(설치기·다운로드 미호출), 설치기 호출 1회 | 코드, inspect 동치, status, 재실행 코드 | portal-ssh·portal-app | test/test_agent_cli.py:446 | SSH_PORTAL-D-0035(후보) |
| RC-B-667 | 실패 영수증 ACK 실패 시 롤백을 주장하지 않음 | completed·failed 영수증 모두 교체 뒤 디렉터리 ACK가 실패 | `RESULT_UNKNOWN`, 사건 순서 `[completed-after-replace, failed-after-replace]`, active 버전 `1.2.4` 유지(롤백 주장 없음), 이전 바이너리·사용자 파일 보존, status `failed`, 재실행 `RESULT_UNKNOWN` 무호출, 설치기 1회 | 사건 목록, 버전, status | portal-ssh·portal-app | test/test_agent_cli.py:455 | SSH_PORTAL-D-0035(후보) |
| RC-B-668 | 롤백 직후 작업 종료 시 stale completed 없음 | update 중 롤백(이전 대상으로 전환) 직후 작업 프로세스 terminate | 종료 전 보이는 영수증이 `failed`(stale completed 없음), active `1.2.3`, 이전 바이너리·사용자 파일 보존, status `failed`, 재실행 `RESULT_UNKNOWN`·설치기 0, 작업 프로세스 회수 | 영수증 상태, active, status, 회수 | portal-ssh·portal-app | test/test_agent_cli.py:484 | SSH_PORTAL-D-0035(후보) |
| RC-B-669 | failed 영수증 교체 뒤 작업 종료 시 실제 효과 보존 | failed 영수증 교체 후 디렉터리 ACK 대기 중 작업 terminate | 영수증 `failed`, active `1.2.4`, 이전 바이너리·사용자 파일 보존, status `failed`, 재실행 `RESULT_UNKNOWN`·설치기 0, 작업 프로세스 회수 | 영수증, active, status | portal-ssh·portal-app | test/test_agent_cli.py:485 | SSH_PORTAL-D-0035(후보) |
| RC-B-670 | 과거 completed·reused 기록은 이후 정상 update 뒤에도 유지 | 관리 설치 1.2.3(op a), update 1.2.4(op b), 같은 버전 update(op c, 결과 `reused`), 1.2.5 update(op d) | 최종 active `1.2.5`, status: a `completed`·b `completed`·c `reused`, b·c를 다른 객체로 재실행하면 각각 `completed`·`reused`이고 호출 0, 밀려난 1.2.3 바이너리는 제거(`SUPERSEDED_VERSION_NOT_PRUNED` 방지), 사용자 파일 불변 | status 3종, 재실행 무호출, 파일 부재 | portal-ssh·portal-app | test/test_agent_cli.py:486 | - |
| RC-B-671 | 외부 재사용 기록은 이후 관리 설치 뒤에도 유지 | 외부 1.2.3 존재, op e `reused`, 이어 1.2.4 관리 install | 버전 `1.2.4`, op e status `reused`, 같은 요청 재실행 `reused`·호출 0, 관리 설치기 1회·외부 바이너리·사용자 파일 보존 | status, 재실행 무호출 | portal-ssh·portal-app | test/test_agent_cli.py:502 | - |


### G09 (원자료 1942~2047: test_cloudflare_discovery ~ test_environment_helper, py 106행)

| 사례 ID | 대상 기능 | 입력·조건 | 기대 결과 | 판정 방법 | 3.0 모듈 | 원 시험 | 연결 결함 |
|---|---|---|---|---|---|---|---|
| RC-B-721 | 환경 편집기 snapshot 읽기(`action=read`) | bridge.env(0600)에 `# retain\r\nBRIDGE_ADMIN_TOKEN=synthetic-private\r\nBRIDGE_UI_ENABLED=false\r\n`가 있을 때 read를 두 번 호출 | 응답 JSON 문자열에 `synthetic-private`가 없다. `readOnlyKeys`에 `BRIDGE_ADMIN_TOKEN`이 있다. `revision`은 길이 64 문자열이고 두 번 읽어도 같다(파일 변경 없으면 불투명 해시 동일). `fields` 중 `key=='JEV_API_KEY'` 항목에 `value` 속성이 없다(비밀 필드는 write-only) | 응답 직렬화 문자열에 비밀 부재, readOnlyKeys 포함, revision 길이 64·재조회 동일, JEV_API_KEY 필드에 value 속성 없음 | portal-server | test/test_environment_helper.py:45 | - |
| RC-B-722 | 환경 편집기 읽기의 중복 키 해석 | 파일에 `BRIDGE_DISPLAY_NAME=first`, `BRIDGE_DISPLAY_NAME=last`, `JEV_API_KEY=synthetic-first`, `JEV_API_KEY=synthetic-last`(CRLF)가 중복으로 존재 | 읽기에서 `BRIDGE_DISPLAY_NAME`의 value는 `last`(마지막 값 우선). 응답에 `synthetic-last`가 없다(비밀 비노출). 항목 파서 `entries(original)['JEV_API_KEY']`는 `synthetic-last`. 읽기만으로 파일 바이트는 변하지 않는다 | fields의 DISPLAY_NAME 값 `last`, 응답에 비밀 부재, 파서 결과 `synthetic-last`, 읽기 전후 파일 바이트 동일 | portal-server | test/test_environment_helper.py:54 | SSH_PORTAL-D-0032 |
| RC-B-723 | 환경 편집기 저장 시 중복 키·미편집 바이트 보존 | 722의 중복 파일에서 (a) `{BRIDGE_UI_ENABLED:'true'}` 저장 (b) 이어서 `{JEV_API_KEY:'synthetic-replaced'}` 저장 | (a) 기존 `BRIDGE_UI_ENABLED=false` 줄만 제거되고 새 `BRIDGE_UI_ENABLED=true\r\n`이 파일 끝에 붙는다: 결과 바이트 = `# retain\r\nBRIDGE_ADMIN_TOKEN=synthetic-private\r\n` + 중복 줄 4개 원문 + `BRIDGE_UI_ENABLED=true\r\n`. `state/pending.env` 바이트 = 저장 전 원본. (b) `JEV_API_KEY=`는 정확히 1개만 남고(중복 병합) `BRIDGE_DISPLAY_NAME=first\r\nBRIDGE_DISPLAY_NAME=last\r\n`는 그대로. 파서 결과 `synthetic-replaced` | 저장 후 파일 전체 바이트 비교, pending.env 바이트 = 원본, `JEV_API_KEY=` 개수 1, 편집하지 않은 중복 키 줄 보존 | portal-server | test/test_environment_helper.py:54 | SSH_PORTAL-D-0032 |
| RC-B-724 | 환경 편집기 health 판정에서 중복 포트 해석 | `BRIDGE_MCP_PORT=39124\nBRIDGE_MCP_PORT=39125\n` 바이트와 health 응답 `{"healthy":true}`, 서비스 확인은 시험용 대역 | healthy=true. HTTP 호출은 마지막 값 포트로 `http://127.0.0.1:39125/health`, timeout 1초 1회만. 서비스 활성 확인은 `/usr/bin/systemctl is-active --quiet ssh-approval-bridge.service`로 정확히 1회(3.0은 서비스 활성 확인을 동등하게 수행하며, 실제 시스템 서비스 접근 없이 시험 대역으로 검증) | health URL이 마지막 중복 포트, timeout 1, 호출 1회, 서비스 활성 확인 인자 | portal-server | test/test_environment_helper.py:74 | SSH_PORTAL-D-0032 |
| RC-B-725 | 환경 편집기 재시작 시 baseline 보존 검증 순서 | 기본 Editor(재시작 대역·health=true)로 `restart`(acknowledged=true, maintenanceOwner=`a`x64)를 예약한 뒤 job 실행 | maintenance 동작 호출 순서가 정확히 `capture`, `compare-baseline`, `release-baseline-verified`이고 각 토큰은 owner 바이트. 최종 `state()['state']=='healthy'`. `owner-<job>` 파일이 남지 않는다 | 호출 순서 목록 3건 일치, 상태 healthy, owner 파일 부재 | portal-server | test/test_environment_helper.py:89 | SSH_PORTAL-D-0032 |
| RC-B-726 | 환경 편집기 저장의 백업·미지 키·CRLF·모드 보존 | `{BRIDGE_UI_ENABLED:'true', JEV_API_KEY:'synthetic-key'}` 저장 후 `{BRIDGE_JEV_ENABLED:'true'}` 저장 | 결과 `pendingRestart==true`, 응답에 `synthetic-key` 없음. `# retain\r\nBRIDGE_ADMIN_TOKEN=synthetic-private\r\n`이 그대로 존재(CRLF·미지 키 보존). `state/<backupId>` 바이트 = 원본. env 파일 모드 0600 유지. 두 번째 저장 뒤에도 `state/pending.env` 바이트 = 최초 원본(가장 이른 baseline) | 바이트 포함 비교, 백업 파일 = 원본, 모드 0600, pending.env 불변 | portal-server | test/test_environment_helper.py:103 | - |
| RC-B-727 | 환경 편집기 낙관적 잠금(revision 충돌) | (a) 오래된 revision으로 save (b) 파일 끝에 외부 줄(`# external administrator\r\n`) 추가 후 최신 읽은 revision이 아닌 stale 상태에서 save (c) 같은 상태에서 restart | 모두 `Refused`('conflict') 오류. 덮어쓰지 않는다 | 세 호출 모두 conflict 거절 메시지 | portal-server | test/test_environment_helper.py:113 | - |
| RC-B-728 | 환경 편집기 거절할 변경 값 | changes를 각각 `{NODE_OPTIONS:'--require=evil'}`, `{BRIDGE_CONFIG_PATH:'/tmp/evil'}`, `{JEV_API_KEY:'x\nINJECT=true'}`, `{BRIDGE_UI_ENABLED:'yes'}`, `{JEV_API_KEY:'x\\n'}`(역슬래시 n 문자), `{BRIDGE_DISPLAY_NAME:' leading'}`, `{BRIDGE_UI_ENABLED:true}`(불리언), `[]`(객체 아님)로 save | 8건 모두 Refused. 허용 목록 밖 키(경로·셸 옵션), 개행 주입, 불리언 키의 true/false 외 값, 값 앞 공백, 비문자열 값, 비객체 changes 거절. 파일 바이트는 원본과 동일 | 8건 각각 거절 예외, 최종 파일 바이트 = 원본 | portal-server | test/test_environment_helper.py:124 | - |
| RC-B-729 | 환경 편집기의 유니코드 줄바꿈·제어 문자 거절 | `JEV_API_KEY`에 `synthetic`+문자+`key`로 U+0085, U+2028, U+2029, U+200B, U+007F를 각각 save | 각 경우 Refused 메시지에 `invalid-value`. 파일 바이트 원본 그대로이고 이어서 read의 `available==true` | 5건 거절 코드 `invalid-value`, 파일 불변, read 가능 | portal-server | test/test_environment_helper.py:130 | - |
| RC-B-730 | 환경 편집기의 기존 비LF 구분자 보존·교체 | 파일에 `JEV_API_KEY=synthetic\u0085key\r\n`이 이미 있음(운영자가 쓴 값) | read `available==true`. 다른 키(`BRIDGE_UI_ENABLED`) 저장 뒤에도 해당 줄 원문 바이트 보존. `JEV_API_KEY`를 `synthetic-replaced`로 저장하면 U+0085 바이트가 파일에서 사라지고 파서 값 = `synthetic-replaced`(한 항목으로 교체). 기존 파일 문법은 LF 줄 기준(JS 로더 문법)이며 3.0도 같은 문법 | 저장 후 바이트 포함/미포함, 파서 결과 | portal-server | test/test_environment_helper.py:137 | - |
| RC-B-731 | 환경 편집기의 검증 실패 시 무변경 | validate 대역이 `Refused('validation-failed')`를 던지게 한 상태로 `{BRIDGE_UI_ENABLED:'true'}` 저장 | Refused. 파일 바이트 = 원본. `state/pending.env`가 생기지 않는다 | 예외, 파일 바이트, pending.env 부재 | portal-server | test/test_environment_helper.py:147 | - |
| RC-B-732 | 환경 편집기 검증 중 외부 편집 보존 | validate 대역이 실행 중 파일에 `# external during validation\r\n`을 덧붙임 | Refused('conflict'). 파일은 외부 편집된 바이트 그대로(덮어쓰지 않음). `pending.env` 없음 | 예외 메시지 conflict, 파일 = 외부 편집본, pending.env 부재 | portal-server | test/test_environment_helper.py:156 | - |
| RC-B-733 | 환경 편집기의 null 값 키 삭제와 비밀 비반환 | `{JEV_API_KEY:'synthetic-key'}` 저장 후 `{JEV_API_KEY:null}` 저장 | 파일에 `JEV_API_KEY=` 줄이 없다. 결과 `fields`의 JEV_API_KEY 항목 `configured==false` | 파일 바이트에 키 부재, configured false | portal-server | test/test_environment_helper.py:164 | - |
| RC-B-734 | 환경 파일 안전 검사 | (a) 모드 0644 (b) 하드링크 개수 2 (c) 심볼릭 링크로 교체 (d) FIFO(0600) 상태에서 read | (a) Refused (b) Refused (c) OSError(심볼릭 링크 따라가지 않음, O_NOFOLLOW 상당) (d) Refused. 3.0은 Windows ACL이 아닌 Linux 파일 기준(Windows 대상 처리는 별도 판단) | 4가지 조건별 예외 유형 | portal-server | test/test_environment_helper.py:170 | - |
| RC-B-735 | 환경 편집기 재시작 요청의 승인 확인과 예약 중 상호 배제 | (a) `acknowledged` 없이 restart (b) acknowledged restart 성공 후 두 번째 restart (c) restart 예약 후 save | (a) Refused. (b) 첫 호출은 job id를 반환하고 스케줄러에 `[job]` 전달. 두 번째는 Refused('restart-in-progress'). (c) save도 Refused('restart-in-progress') | 스케줄 목록 `[job]`, 두 거절 메시지 | portal-server | test/test_environment_helper.py:188 | - |
| RC-B-736 | 환경 편집기 재시작 성공과 중복 job 재실행 금지 | save 후 restart job을 실행(재시작 대역 1회, health=true) | 재시작 1회. release·capture·compare 모두 owner 바이트(`a`x64) 1회씩. `owner-<job>` 파일 삭제. 상태 `healthy`, `pendingRestart==false`. 같은 job을 다시 실행하면 Refused이고 재시작 호출은 여전히 1회 | 호출 횟수 [1], 각 콜백 인자, 상태·파일, 재실행 거절 | portal-server | test/test_environment_helper.py:198 | - |
| RC-B-737 | 환경 편집기 재시작 실패 시 가장 이른 env로 롤백 | 저장 2번(`BRIDGE_UI_ENABLED=true`, `JEV_API_KEY` 설정)으로 pending 상태에서 restart. health는 원본 바이트일 때만 true | 재시작 호출 2회(실패 후 복구 재시작). 파일 바이트 = 최초 원본. 상태 `rolled-back`, `pendingRestart==false` | 재시작 횟수 [1,1], 파일 = 원본, 상태 | portal-server | test/test_environment_helper.py:214 | - |
| RC-B-738 | 환경 편집기: 예약 후 외부 편집 시 재시작 중단 | restart 예약 뒤 외부가 `# external\r\n`을 덧붙임 후 job 실행 | 재시작 호출 없음. 파일은 외부 편집본 유지. 상태 `conflict` | 재시작 미호출, 파일 불변, 상태 conflict | portal-server | test/test_environment_helper.py:229 | - |
| RC-B-739 | 환경 편집기: 복구 실패 보고와 백업 보존 | restart 후 health가 계속 false | 상태 `recovery-failed`, `pendingRestart==true`. release 호출 없음. `owner-<job>` 파일 유지 | 상태, pendingRestart, release 목록 비어 있음, owner 파일 존재 | portal-server | test/test_environment_helper.py:239 | - |
| RC-B-740 | 환경 편집기: maintenance release 미확인 | release 대역이 `RuntimeError`('synthetic response lost')를 던짐 | 상태 `maintenance-release-unconfirmed`. `owner-<job>` 유지, `pendingRestart==true` | 상태 문자열, owner 파일, pendingRestart | portal-server | test/test_environment_helper.py:248 | - |
| RC-B-741 | 환경 편집기: baseline compare 미확인 | compare 대역이 `RuntimeError`를 던짐 | 상태 `preservation-compare-unconfirmed`. release 호출 없음. `owner-<job>` 유지, `pendingRestart==true` | 상태, release 목록 비어 있음, owner 파일, pendingRestart | portal-server | test/test_environment_helper.py:259 | - |
| RC-B-742 | 환경 편집기: capture 미확인 시 재시작·release 금지 | capture 대역이 `RuntimeError`를 던짐 | 상태 `preservation-capture-unconfirmed`. 재시작 호출 0회, release 0회. `owner-<job>` 유지 | 상태, 호출 목록 비어 있음, owner 파일 | portal-server | test/test_environment_helper.py:271 | - |
| RC-B-743 | BRIDGE_COMMAND_AUTOMATION 토글을 실제 편집기+애플리케이션으로 검증 | 실제 서버 프로세스(고정 fixture)를 `true`로 시작·종료해 journal을 만든 뒤, (owner `a`x64, true→false)와 (owner `b`x64, false→true) 두 방향 각각: 파일에 `BRIDGE_COMMAND_AUTOMATION=<이전>` 기록 후 서버 시작, `reserve` 호출 → save로 값 전환 → restart job → capture·compare·release를 서버의 `/api/maintenance/preservation/capture`, `preservation/compare`, `release`로 호출하고 재시작은 프로세스 교체 | reserve 응답 `reserved==true`, compare 응답 `status=='PASS'`, release 응답 `released==true`, 최종 상태 `healthy`, `pendingRestart==false`, 서버는 종료 코드 0. 유지보수 API 헤더: `Authorization: Bearer test-admin`, `Origin: https://example.test`, `X-Maintenance-Owner: <owner>` | 양방향 토글 전체 흐름의 각 응답 필드와 최종 상태, 프로세스 종료 코드 | portal-server | test/test_environment_helper.py:283 | SSH_PORTAL-D-0032(후보) |
| RC-B-744 | 환경 편집기: 일반 재시작 실패는 env 복구를 주장하지 않음 | 저장 없이 restart 후 health false | 상태 `failed`(`recovery-failed`·`rolled-back` 아님). 파일 바이트 = 원본 | 상태 문자열, 파일 바이트 | portal-server | test/test_environment_helper.py:335 | - |
| RC-B-745 | 환경 편집기: 스케줄러 실패 | 스케줄러 대역이 `RuntimeError('synthetic-private error')` | restart가 Refused('schedule-failed'). read의 `restart.state=='schedule-failed'`. 파일 = 원본. 원 예외 문구(`synthetic-private`)는 노출되지 않는다(추정: 메시지에 미포함) | 거절 메시지, 상태, 파일 바이트 | portal-server | test/test_environment_helper.py:341 | - |
| RC-B-746 | 환경 편집기: 상태 읽기가 재시작 mutation 잠금을 기다리지 않음 | `state/lock` 파일을 다른 쪽에서 배타 잠금(`LOCK_EX`)한 채 read | read가 막히지 않고 `available==true` 반환 | 잠금 보유 중 read가 즉시 반환, available true | portal-server | test/test_environment_helper.py:350 | - |
| RC-B-747 | 환경 편집기 root broker의 호출자(peer) 경계와 저장 | 격리 컨테이너(root)에서 소켓 호출자 uid `mcpbridge`로 read, 이어서 save(`JEV_API_KEY=synthetic-new-key`, `BRIDGE_UI_ENABLED=true`), 그리고 uid 0으로 read | read 종료 코드 0이며 원본 비밀 `synthetic-old-key`가 출력에 없다. save 결과 `saved==true`, 응답에 `synthetic-new-key` 없음, 파일에는 `JEV_API_KEY=synthetic-new-key`. uid 0(허용되지 않은 호출자) read는 종료 코드 != 0이고 출력이 비어 있다. 소켓·systemd unit(`ssh-approval-env.socket`, `ssh-approval-env@.service`)은 `systemd-analyze verify`를 통과(env-editor 행동은 3.0에서 유지하되 Java가 처리하므로 root broker·Python·소켓 unit 형식은 구현 담당이 정하고, 호출자 인증 경계와 저장·비밀 비노출 assert는 유지: 메인 판정 2) | 응답 바이트에 비밀 부재, saved, 파일 내용, uid 0 거절 | portal-server, packaging | test/test_environment_helper.py:361 | - |
| RC-B-748 | 환경 편집기 저장 값 검증(업로드 호스트·유니코드 줄바꿈) | 747과 같은 환경에서 `{BRIDGE_UPLOAD_SOURCE_HOSTS:'*'}` save, 이어서 `JEV_API_KEY`에 U+0085, U+2028, U+2029 포함 값 save | 첫 호출 응답 `{"error":"validation-failed"}`(런타임 검증기가 잘못된 업로드 호스트를 쓰기 전에 거절). 뒤 3건 응답 `{"error":"invalid-value"}`. 각 경우 파일 바이트가 변하지 않는다 | 응답 JSON 정확 일치, 파일 바이트 불변 | portal-server | test/test_environment_helper.py:361 | - |
| RC-B-749 | compose.env 준비: 지원 할당 스타일 보존 | 구분자 `=`, ` = `, `: ` × 줄바꿈 LF·CRLF 6조합. 입력: `BRIDGE_UID<sep>11 # uid note`, `BRIDGE_GID<sep>12`, `# administrator note`, `BRIDGE_IMAGE<sep>registry.example/portal@sha256:`+`a`x64, `COMPOSE_PROFILES=preserved`, `EXTRA="unchanged # text"`. 인자는 uid `10001`, gid `10002` | UID·GID 값만 `10001`, `10002`로 바뀐다(`# uid note` 주석·구분자·줄바꿈 보존). BRIDGE_IMAGE·COMPOSE_PROFILES·EXTRA·주석 줄 그대로. 종료 코드 0, 두 번째 실행에서도 파일이 같다(멱등) | 6조합 각 바이트 일치, 재실행 동일 | packaging | test/test_compose_env.py:31 | - |
| RC-B-750 | compose.env 준비: export·따옴표·중복 키 | 입력 ` export BRIDGE_UID = '11' # uid\nBRIDGE_UID: 11\n\tBRIDGE_GID = "12"\nexport BRIDGE_IMAGE = "registry.example/portal:pinned" # image note\n` | UID 줄 둘 다 `10001`(첫 줄은 따옴표 제거 `export BRIDGE_UID = 10001 # uid`, 앞 공백 유지), `BRIDGE_UID: 10001`, `\tBRIDGE_GID = 10002`. IMAGE 줄 불변. 멱등 | 출력 바이트 정확 일치, 재실행 동일 | packaging | test/test_compose_env.py:43 | - |
| RC-B-751 | compose.env 준비: 여러 줄 따옴표 값 안의 키를 설정으로 해석하지 않음 | `EXTRA='first\'`(또는 `"first\"`) 이어서 `BRIDGE_UID=77`, `BRIDGE_IMAGE=not-an-image`, `last'`(여러 줄 값) 뒤에 `BRIDGE_UID=11\nBRIDGE_GID=12` | 여러 줄 EXTRA 블록 불변. 그 뒤 실제 `BRIDGE_UID=10001`, `BRIDGE_GID=10002`. 이미지가 없으므로 `BRIDGE_IMAGE=ssh-approval-portal:<현재 버전>`이 끝에 추가된다(기본 이미지 태그는 제품 버전과 일치; 3.0은 3.x 버전 규칙으로 대체). 멱등 | 작은따옴표·큰따옴표 두 경우 결과 바이트 일치 | packaging | test/test_compose_env.py:48 | SSH_PORTAL-D-0042(후보) |
| RC-B-752 | compose.env 준비: 누락 키를 마지막 줄에 이어 붙이지 않고 추가 | (a) `EXTRA=kept`(끝 개행 없음) (b) `BRIDGE_UID=11\nBRIDGE_GID=12`(끝 개행 없음) | (a) `EXTRA=kept\nBRIDGE_UID=10001\nBRIDGE_GID=10002\nBRIDGE_IMAGE=<기본 이미지>\n` (b) `BRIDGE_UID=10001\nBRIDGE_GID=10002\nBRIDGE_IMAGE=<기본 이미지>\n` | 결과 바이트 정확 일치 | packaging | test/test_compose_env.py:55 | SSH_PORTAL-D-0042(후보) |
| RC-B-753 | compose.env 이미지 값 교체 | 선언 `BRIDGE_IMAGE=`, `BRIDGE_IMAGE = `, `BRIDGE_IMAGE: `, `export BRIDGE_IMAGE = ` 4가지에 `"registry.example/old:pinned" # image`(CRLF) 라인. `image <path> sha256:`+`a`x64 호출, 이어서 잘못된 값 `bad\nEXTRA=changed` | 첫 호출 종료 코드 0, 따옴표 포함 이전 값만 `sha256:aaaa…`로 교체(주석·EXTRA·CRLF 보존). 개행이 든 값은 종료 코드 != 0이고 파일은 직전 상태 그대로 | 4가지 선언 각 바이트 일치, 잘못된 값 거절과 파일 불변 | packaging | test/test_compose_env.py:60 | SSH_PORTAL-D-0042(후보) |
| RC-B-754 | compose.env 소유자·비공개 모드 보존 | `BRIDGE_IMAGE=registry.example/portal:pinned\n`인 기존 파일(root 실행이면 uid 12345·gid 12346). 준비 실행 | 종료 코드 0. uid·gid 변화 없음. 모드 0600. 디렉터리에는 원본 파일만 남는다(임시 파일 잔류 없음). Linux 전용 | uid·gid 비교, 모드 0600, 디렉터리 목록 = [파일] | packaging | test/test_compose_env.py:77 | - |
| RC-B-755 | 환경 편집기 설정(`connect env-editor`)의 공유 설치 잠금 | 격리 root Linux에서 `/var/lib/ssh-mcp/.portal-install.lock`을 `LOCK_EX\|LOCK_NB`로 보유한 채 `portal connect env-editor` 실행 | 종료 코드 != 0(설치 잠금 우회 불가). 헬퍼·소켓 unit·service unit(`/var/lib/ssh-approval-env`, `/usr/local/libexec/ssh-approval-environment-helper`, `/etc/systemd/system/ssh-approval-env.socket`, `ssh-approval-env@.service`)의 mtime·mode·SHA-256이 실행 전후 동일. stdout에 `ENV editor enabled` 없음. 3.0은 env-editor를 Java가 처리하므로(root broker·Python 없음) 같은 공유 설치 잠금을 Java 쪽과 설치 스크립트(install.sh/install.cmd)가 지키며, 보호 대상 경로 목록은 구현 담당이 정한다(메인 판정 2) | 종료 코드, 경로 4개의 mtime·mode·해시 스냅샷 동일, stdout 부재 문자열 | packaging | test/test_env_editor_lock.py:11 | - |

### G10 (원자료 2048~2174: test_helper ~ test_upload_sources, py 127행)

| 사례 ID | 대상 기능 | 입력·조건 | 기대 결과 | 판정 방법 | 3.0 모듈 | 원 시험 | 연결 결함 |
|---|---|---|---|---|---|---|---|
| RC-B-811 | 대상 파일 게시·덮어쓰기·snapshot(file-helper 행동을 MINA SSHD SFTP로 이식) | staging `<id 48자 'a'>.part`에 바이트 `00 ff 61 62 63`(크기·sha256 일치)를 두고 action=publish, remotePath=`<root>/한글.bin`(비ASCII 이름), overwrite=false. 이어 같은 요청 재실행, 대상 mode를 0640으로 바꾼 뒤 빈 바이트(크기 0)로 overwrite=true 재게시, action=cleanup, action=snapshot | 첫 게시 `published=true`, 대상 바이트 원문 일치·새 파일 mode 0600. 같은 요청 재실행은 `DESTINATION_EXISTS`. overwrite 빈 바이트 게시 후 대상 길이 0이고 기존 mode 0640 유지. cleanup 후 snapshot의 sha256은 빈 입력의 sha256(`e3b0c442...`) | 바이트 비교, `stat` mode(0600·0640), 오류 코드 `DESTINATION_EXISTS`, snapshot sha256 값 assert | portal-ssh | test/test_helper.py:36 | - |
| RC-B-812 | 해시 불일치 시 기존 파일 보존, 심볼릭 링크·상위 경로(`..`) 거부 | 기존 대상 `old`에 overwrite=true, sha256=`0`*64로 게시 → 해시 오류. 심볼릭 링크 leaf를 O_NOFOLLOW로 열면 ELOOP. 링크 경로로 action=snapshot. 요청 remotePath를 `<root>/../escape`로 바꿔 게시 | 해시 불일치는 값 오류(ValueError 상당)로 거절되고 대상 바이트는 `old` 그대로. 링크 leaf는 따라가지 않으며(ELOOP 상당) snapshot은 `UNSAFE_PATH`, 링크·대상 변경 없음. `..` 포함 경로는 값 오류로 거절 | 대상 바이트 `old` 유지, `UNSAFE_PATH` 코드, 링크가 여전히 심볼릭 링크, `..` 거절 assert | portal-ssh | test/test_helper.py:52 | D-0003(후보) |
| RC-B-813 | 상위 디렉터리 없음·원본 없음·staging 없음 구분 | (a) remotePath=`<root>/missing/x` 게시 (b) 없는 경로 `<root>/absent` snapshot (c) staging `.part` 삭제 후 게시 (d) staging 디렉터리 자체 삭제 후 게시. 실패는 main 경로로 실행해 stdout 응답 확인 | 종료 코드 1, 응답이 정확히 `{error:'File operation refused or failed; verify paths, permissions and approved metadata.', errorCode:<코드>}`(경로 미노출): (a) `PARENT_NOT_FOUND`(`missing` 디렉터리를 만들지 않음, `<root>`에는 stage만 남음, cleanup은 `cleaned=true`로 staging을 비움) (b) `FILE_NOT_FOUND` (c)(d) `STAGING_UNAVAILABLE`(PARENT_NOT_FOUND 아님) | 응답 JSON 전체 일치, 응답 문자열에 root 경로 없음, 디렉터리 미생성, cleanup 결과 assert | portal-ssh | test/test_helper.py:84, test/test_helper.py:92 | D-0034(후보) |
| RC-B-814 | 권한 오류를 errno로 분류하고 임의 문구 미노출 | 상위 디렉터리 `denied` 열기에서 EACCES(메시지 `/private/credential=do-not-expose`)를 던지게 하고 remotePath=`<root>/denied/x` 게시 | `errorCode=PERMISSION_DENIED`, 응답에 원 오류 문구·경로 없음, `denied` 디렉터리 미생성 | 오류 코드와 응답 전체 일치, 부재 assert | portal-ssh | test/test_helper.py:100 | D-0034(후보) |
| RC-B-815 | 기존 대상·링크 보존과 안전 오류 | 대상이 `original`로 이미 존재. (a) overwrite=false 게시 (b) 링크→대상에 overwrite=true 게시 (c) 상위가 심볼릭 링크인 `<root>/parent-link/child` (d) `<root>/../child` | (a) `DESTINATION_EXISTS` (b)(c)(d) `UNSAFE_PATH`. 대상 바이트는 `original` 유지, `<root>/child` 미생성 | 오류 코드 4건, 대상 바이트·부재 assert | portal-ssh | test/test_helper.py:111 | - |
| RC-B-816 | 실패 시 임시 파일 제거·자원 해제와 FILE_CHANGED·UNSAFE_PATH·계정 조회 실패 | 기존 대상 `original`에 overwrite=true, sha256=`0`*64 게시(FILE_CHANGED). remotePath를 staging 디렉터리로 지정(UNSAFE_PATH). 없는 상위(PARENT_NOT_FOUND). 계정 조회가 RuntimeError(`private account failure`)로 실패 | 각각 `FILE_CHANGED`, `UNSAFE_PATH`, `PARENT_NOT_FOUND`, `OPERATION_FAILED`(원 문구 미노출). 대상 바이트 `original`, `.ssh-approval-*.part` 임시 파일 없음, 각 시도 전후 열린 핸들 수 동일(자원 누수 없음; Java는 SFTP 채널·스트림 close를 assert) | 코드 4건, 임시 파일 glob 비어 있음, 열린 핸들 수 비교 | portal-ssh | test/test_helper.py:127 | - |
| RC-B-817 | 알 수 없는 실패는 일반 코드, 잘못된 요청과 크기 한도 | (a) 처리 중 ENOSPC(`/private/credential=do-not-expose`) (b) 요청 본문이 JSON 배열 `[]` (c) staging 파일을 snapshot하며 maxBytes=1 | (a) `OPERATION_FAILED` (b) `INVALID_REQUEST` (c) `FILE_TOO_LARGE`. 모두 안전 문구 고정, 원 오류 문구 미노출 | 코드 3건과 응답 전체 일치 | portal-ssh | test/test_helper.py:144 | D-0034(후보) |
| RC-B-818 | 게시 이후 실패는 권한 오류여도 결과 불명(OPERATION_FAILED) | 게시는 성공하되 상위 디렉터리 fsync만 EACCES로 실패하도록 주입 | `errorCode=OPERATION_FAILED`(PERMISSION_DENIED 아님), 대상은 이미 게시되어 바이트 `00 ff 61 62 63` 유지, `.ssh-approval-*.part` 임시 파일 없음 | 코드 assert, 대상 바이트, 임시 파일 부재 | portal-ssh | test/test_helper.py:151 | D-0035(후보) |
| RC-B-819 | 디렉터리·FIFO·크기 한도 초과 거부 | snapshot 대상이 디렉터리(staging), FIFO(`mkfifo`). 4바이트 업로드에 maxBytes=3 | 세 경우 모두 값 오류로 거절(디렉터리·FIFO는 일반 파일이 아님, 크기는 한도 초과) | 세 경우 거절 assert | portal-ssh | test/test_helper.py:163 | - |
| RC-B-820 | 원격 RDP 클라이언트 실행 파일 검증과 제어 fd 유지(linux-desktop-session 행동 이식) | 비공개 경로의 xfreerdp3(mode 0700, 매니페스트 sha256 일치, patch digest 64자)와 fd3에 Unix stream 소켓을 상속시켜 `validate_native_rdp` 호출 | 실행 파일 경로 문자열을 반환. fd3는 열려 있으나 상속 불가(`get_inheritable=false`). 상대에서 쓴 `x`를 fd3에서 읽을 수 있음 | 반환 경로, fd3 inheritable false, 읽기 `x` assert | portal-desktop | test/test_linux_desktop_session.py:56 | - |
| RC-B-821 | 잘못된 매니페스트·시스템 기본 경로는 bootstrap 전에 실패 | rdp_executable_sha256=`0`*64 / rdp_patch_digest=`bad` / rdp_executable=`/usr/bin/xfreerdp3` / rdp_executable=`<dir>/../bin/xfreerdp3` 각각으로 run 호출 | 모두 `DESKTOP_RDP_CLIENT_UNAVAILABLE`(오류 메시지가 이 코드와 정확히 일치), 자격 증명 부트스트랩 읽기 호출 0회 | 오류 코드 일치, bootstrap 미호출 assert(4 입력) | portal-desktop | test/test_linux_desktop_session.py:66 | - |
| RC-B-822 | 변조·부재·심볼릭 링크·실행 권한 없는 클라이언트 거절 | (a) 실행 파일 내용을 `changed`로 변경 (b) 파일 삭제 (c) 같은 내용의 파일로 가는 심볼릭 링크 (d) 같은 내용·mode 0600 | 네 경우 모두 `DESKTOP_RDP_CLIENT_UNAVAILABLE` | 코드 4건 | portal-desktop | test/test_linux_desktop_session.py:77 | - |
| RC-B-823 | 제어 채널 fd3가 Unix stream 연결이 아니면 bootstrap 전에 실패 | fd3 = 파이프 읽기 끝 / Unix datagram 소켓 / 미연결 Unix stream 소켓 / fd3 닫힘 | 모두 `DESKTOP_NATIVE_INVALID_CHANNEL`, bootstrap 읽기 호출 0회 | 코드와 bootstrap 미호출 assert(4 입력) | portal-desktop | test/test_linux_desktop_session.py:96 | - |
| RC-B-824 | 제어 fd는 네이티브 자식 프로세스만 상속, 자격 증명 기록 전 부모가 닫음 | 정상 RDP 세션(ssh-tunnel 인증서 모드, rdp_port 3389, 800x600)을 실행하되 프로세스 실행·명령 호출은 대체 | 프로세스 실행 3회, 마지막이 xfreerdp3. Xvnc 실행에는 fd3를 넘기지 않음. xfreerdp3는 `pass_fds=(3,)`이고 인자에 `/ags-input-fd:3`, `/kbd:unicode:on`(정확히 이 kbd 인자 1개), `-clipboard` 포함. 자격 증명은 부모에서 fd3가 이미 닫힌 상태(fstat 오류)에서 `test-user\n\ntest-only\n` 한 번만 기록 | 실행 횟수·인자·pass_fds, 자격 증명 기록 시점의 fd3 닫힘, 기록 바이트 일치 | portal-desktop | test/test_linux_desktop_session.py:117 | D-0020(후보) |
| RC-B-825 | 전체 기한(TTL) 만료는 어느 단계에서든 DESKTOP_EXPIRED | ttl_ms=1500에서 모드: global_window(창 조회 실패 중 전체 기한 만료), late_viewable·late_focus(viewable/focus가 기한 뒤), global_probe_timeout(조회 타임아웃 중 전체 기한 만료), display_global(display 대기 중 전체 기한 만료). 시계는 제어 | 모두 `DESKTOP_EXPIRED`. `ready` 보고 없음. `closed` 보고 정확히 1회(reason=`startup_failed`, sessionState=`terminated`, cleanupScope=`owned-descendants`, pids=띄운 모든 자식 pid 목록). stop이 시작한 자식 목록으로 1회 호출 | 오류 코드, ready 부재, closed 1회와 필드 값, stop 호출 인자 assert(5 모드) | portal-desktop | test/test_linux_desktop_session.py:249, test/test_linux_desktop_session.py:252, test/test_linux_desktop_session.py:257 | D-0022(후보) |
| RC-B-826 | 단계별 기한은 원래 오류 코드 유지 | ttl_ms=30000에서 window_phase(창 조회 0.4초 소모) / wm_phase(윈도 매니저 조회 0.4초 소모) / display_phase(display 대기 10초 소모) | 각각 `DESKTOP_WINDOW_NOT_READY`, `DESKTOP_WINDOW_MANAGER_NOT_READY`, `DESKTOP_START_TIMEOUT`(DESKTOP_EXPIRED로 바뀌지 않음). RC-B-825와 같은 closed·stop 보고 규칙(`ready` 없음, closed 1회 startup_failed, stop 1회) | 코드 3건, closed·stop 공통 assert | portal-desktop | test/test_linux_desktop_session.py:262 | D-0022(후보) |
| RC-B-827 | 쓰기 불가 /tmp에서 세션 루트 대체 후 DESKTOP_XVNC_START_FAILED | `/tmp` 임시 디렉터리 생성이 PermissionError(`unwritable /tmp`)이고 다른 위치는 생성 가능, 접근 검사(`access`)는 모두 False로 터미널 세션 run 호출 | `DESKTOP_XVNC_START_FAILED`(오류 메시지가 이 코드와 정확히 일치; 원시 오류 문구 비노출) | 오류 코드 정규식 일치 | portal-desktop | test/test_linux_desktop_session.py:269 | D-0048 |
| RC-B-828 | 기존 JVM 런타임 신뢰 검사(Node 런타임 설치 확인을 JVM 동봉 런타임 설치로 이식) | 기존 런타임이 (a) 소유자 비-root(uid 1001) → 실행하지 않고 `.previous.*`(mode 0700)로 보존 후 새 런타임 설치, 새 런타임 root 소유 (b) root 소유·신뢰 가능 → 다운로드 없이 재사용(실행됨) (c) 최상위가 심볼릭 링크 → 따라가지도 교체하지도 않고 실패, 다운로드 없음 (d) 탈출 링크·쓰기 가능 파일·쓰기 가능 디렉터리·mode 0700 루트·하드링크 → 실행하지 않고 `.previous.*` 1개로 보존 후 교체 (e) 부모 디렉터리 mode 0777 → 실행·다운로드 전에 실패 | (a) 이전 실행 마커 없음, 백업 mode 0700·바이트와 소유자(1001) 보존 (b) 재사용 시 다운로드 마커 없음·백업 없음 (c) 종료 코드 비정상, 링크 유지, 대상 디렉터리 비어 있음 (d) 실행 마커 없음 (e) 비정상 종료·실행·다운로드 없음. (JVM 런타임에서는 `bin/java` 대상으로 치환하며 다운로드 부분은 동봉 아카이브 검증으로 대체 — 추정) | 종료 코드, 마커 파일, 백업 개수·mode·소유자·바이트, 링크 보존 assert | packaging | test/test_node_runtime.py:93, test/test_node_runtime.py:105, test/test_node_runtime.py:131, test/test_node_runtime.py:139, test/test_node_runtime.py:155 | - |
| RC-B-829 | 런타임 교체 실패·중단 시 기존 런타임 복원 | 기존 런타임(비신뢰, uid 1001)이 있고 (a) 체크섬 불일치 (b) 새 주 버전이 25(기대 24) (c) 최종 rename이 실패(종료 28) (d) 두 rename 사이에 SIGTERM | 모두 비정상 종료. 기존 `bin/node` 바이트·소유자(1001) 보존, 기존 런타임 미실행(마커 없음). (a)에서는 `.previous.*`·`.stage.*` 잔재 없음, (b) 백업 없음. JVM 런타임 이식 시 동봉 아카이브 체크섬·주 버전 25 불일치로 치환 (추정) | 종료 코드, 바이트·소유자, 마커 부재, 잔재 glob | packaging | test/test_node_runtime.py:113, test/test_node_runtime.py:123, test/test_node_runtime.py:162, test/test_node_runtime.py:174 | - |
| RC-B-830 | 설치 잠금이 있으면 병렬 설치 차단 | `.node-runtime.lock`(mode 0600)을 다른 핸들이 배타 잠금한 상태에서 설치 실행 | 비정상 종료, 런타임 미생성, 다운로드 없음 | 종료 코드, 부재 assert | packaging | test/test_node_runtime.py:202 | - |
| RC-B-831 | OIDC 관리자 접근 설정의 환경 파일 트랜잭션 실패 복원 | 환경 파일 staging 뒤 공개 OIDC 검증이 실패하도록 한 상황 두 가지: `bad-oidc-session`(공개 OIDC 세션 응답이 잘못됨), `bad-oidc-requests`(공개 OIDC 요청이 잘못됨). 입력 환경값 `BRIDGE_OIDC_ISSUER=https://accounts.google.com`, `BRIDGE_OIDC_JWKS_URL=https://www.googleapis.com/oauth2/v3/certs`, `BRIDGE_OIDC_CLIENT_ID=synthetic.apps.googleusercontent.com`, `BRIDGE_OIDC_OWNER_EMAILS=owner@example.test` | `ENVIRONMENT_ACTION_FAILED_REVIEW_REQUIRED`(메시지에 `ACTION_FAILED` 포함). 환경 파일 바이트가 원본과 동일하게 복원, 서비스 재시작 호출 2회, 예약 이벤트는 `[('reserve',200),('release',200)]` 순서 | 오류 코드, 파일 바이트, 재시작 횟수, 이벤트 목록 assert(두 입력) | portal-app | test/test_oidc_environment.py:34, test/test_oidc_environment.py:43 | - |
| RC-B-832 | OIDC 프록시 설치 기본 CLI는 계획만 출력하고 비밀 포함 설정 거부 | 공개 설정(name=`synthetic-install`, adminHostname=`approve.example.com`, mcpHostname=`mcp.example.com`, issuer=`https://accounts.google.com`, clientId, owners)으로 기본 실행. 이어 설정에 `clientSecret`을 추가해 실행 | 첫 실행 종료 0, `status=INSTALLATION_PLAN`, `servicesWillUsePublicPorts=[80,443]`, `servicesInstalled`·`servicesStarted` 모두 false. 비밀 포함 설정은 종료 1이고 출력(stdout+stderr)에 비밀 값 없음 | JSON 필드 값, 종료 코드, 비밀 문자열 부재 | packaging | test/test_oidc_proxy_install.py:28 | - |
| RC-B-833 | OIDC 프록시 설치·제거·중복 설치 | 준비된 번들로 install 호출, 이어 같은 설정으로 재설치, remove 2회. 운영자 소유 `unrelated.service`가 함께 존재 | install `status=SERVICES_ACTIVE_LOGIN_UNVERIFIED`, `bridgeEnvironmentChanged`·`loginVerified`·`publicCertificateVerified` 모두 false, 활성 서비스 2개, 기록 `status=ACTIVE`·created 4개, 각 unit의 wants 링크가 해당 unit 경로. 재설치는 `RECORD_ALREADY_EXISTS`. remove `status=SERVICES_REMOVED`, `privateDataAndCertificatesPreserved`·`versionCachePreserved` true, 활성 서비스 0, 비밀 파일(client-secret·cookie-secret·owners·bundle.json)과 운영자 unit 바이트 불변, 두 번째 remove도 `SERVICES_REMOVED`. 중지 순서는 caddy 서비스가 먼저 | 반환 필드, 기록 JSON, 링크 대상, 중지 명령 순서, 파일 바이트 비교 | packaging | test/test_oidc_proxy_install.py:97 | - |
| RC-B-834 | 재구성 파일 위조·자격 증명 형식 오류·링크는 서비스 기록 전에 실패 | (a) `proxy.cfg`에 `request_logging=true`를 덧붙이고 수신증(bundle.json)의 해시도 맞춰 갱신 (b) cookie-secret을 31바이트로 변경 (c) cookie-secret을 client-secret으로의 심볼릭 링크로 변경 | (a) `CONFIGURATION_CHANGED`, 명령 실행 0회, 바이너리 준비 미호출, `installation.json` 미생성 (b) `CREDENTIAL_FORMAT_CHANGED` (c) OS 오류. (b)(c) 모두 시스템 명령 0회 | 오류 코드, 명령 목록 비어 있음, 파일 부재 assert | packaging | test/test_oidc_proxy_install.py:122, test/test_oidc_proxy_install.py:135 | - |
| RC-B-835 | 기존 서비스·drop-in은 덮어쓰거나 중지하지 않음 | `ssh-portal-oidc-synthetic-install-proxy.service`가 이미 존재(`existing`)하는 경우와, 파일은 없고 drop-in 재정의가 있는 경우 | 두 경우 모두 `SERVICE_ALREADY_EXISTS`, 기존 파일 바이트 `existing` 유지, 시스템 명령 0회 | 오류 코드, 바이트, 명령 목록 비어 있음 | packaging | test/test_oidc_proxy_install.py:146 | - |
| RC-B-836 | 시작 실패 시 소유 서비스 중지·소유 unit만 제거, 미기록 부분 unit은 수동 검토용 보존 | (a) 두 번째(caddy) 서비스 시작이 `SYNTHETIC_START_FAILURE`로 실패 (b) caddy unit 파일 게시 직후 닫기 오류(`OSError`)가 발생 | (a) 활성 서비스 0, 기록 `status=REMOVED`, `*.service` 파일 모두 제거, client-secret 보존 (b) OSError 전파, 기록 `status=FAILED_REVIEW_REQUIRED`, 해당 unit 파일 보존, 활성 서비스 0 | 오류, 기록 status, unit 파일 존재 여부, 활성 집합 assert | packaging | test/test_oidc_proxy_install.py:159, test/test_oidc_proxy_install.py:209 | - |
| RC-B-837 | 설치 후 소유 unit·시작 링크·drop-in 변경 시 제거와 중지 차단 | 설치 후 (a) proxy unit 바이트를 `foreign replacement`로 변경 (b) 복원 후 시작 링크를 `/synthetic/foreign.service`로 교체 (c) 별도로 설치 뒤 drop-in 재정의 추가 | (a) `OWNED_SERVICE_UNIT_CHANGED` (b) `OWNED_START_LINK_CHANGED` (c) `SERVICE_UNIT_OVERRIDDEN`. 모두 추가 시스템 명령 0회(중지 호출 없음), (c)는 활성 서비스 2개 유지 | 오류 코드 3건, 명령 수 불변, 활성 수 | packaging | test/test_oidc_proxy_install.py:168, test/test_oidc_proxy_install.py:192 | - |
| RC-B-838 | 전역 설치 잠금 | 잠금을 잡은 상태에서 install 호출. 제한적 umask 0o777에서 새 잠금 파일 생성 | install은 `BlockingIOError`, 명령 0회. 새 잠금 파일 `installation.lock` mode는 0600 | 예외, 명령 목록, mode assert | packaging | test/test_oidc_proxy_install.py:186, test/test_oidc_proxy_install.py:201 | - |
| RC-B-839 | 지원 아키텍처와 고정 바이너리 검증 | (a) 아키텍처 aarch64로 install (b) 바이너리 pin(크기·sha256)과 다른 공개 아티팩트 게시 (c) 올바른 바이트 게시, 재호출 (d) 대상 파일을 변경한 뒤 게시 (e) 대상이 심볼릭 링크 | (a) `PINNED_LINUX_AMD64_REQUIRED`, 명령 0회, 바이너리 준비 미호출 (b) `OFFICIAL_BINARY_MISMATCH`, 대상 미생성 (c) 대상 바이트 일치·mode 0755, 재호출 시 inode 동일 (d) `OFFICIAL_BINARY_MISMATCH`, 변경 바이트 보존 (e) 준비 실패 예외, 링크 유지 | 오류 코드, mode, inode, 링크 보존 assert | packaging | test/test_oidc_proxy_install.py:224, test/test_oidc_proxy_install.py:231 | - |
| RC-B-840 | OIDC 프록시 번들 렌더링(콜백·루프백 포트·공통 보안 템플릿; Caddy·oauth2-proxy 동반 구성 유지: 메인 판정 2) | 설정 name=`synthetic-test`, adminHostname=`approve.example.com`, mcpHostname=`mcp.example.com`, issuer=`https://accounts.google.com`, owners 1명으로 render | plan.callback=`https://approve.example.com/oauth2/callback`, ownerCount=1, servicesInstalled·servicesStarted·networkUsed·bridgeEnvironmentChanged 모두 false. 산출 파일 집합은 `Caddyfile`,`proxy.cfg`,`...-proxy.service`,`...-caddy.service`. proxy.cfg에 `oidc_issuer_url`, `code_challenge_method = "S256"`, `insecure_oidc_skip_nonce = false`, `insecure_oidc_skip_issuer_verification = false`, `insecure_oidc_allow_unverified_email = false`, `cookie_secure = true`, `cookie_httponly = true`, `request_logging/auth_logging/standard_logging = false`, `client_secret_file = "/run/credentials/ssh-portal-oidc-synthetic-test-proxy.service/client-secret"`, `upstreams = ["http://127.0.0.1:39125/"]`. Caddyfile에 `admin off`, `protocols h1 h2`, `reverse_proxy 127.0.0.1:4180`, `reverse_proxy 127.0.0.1:39124` | plan 필드 값, 파일 집합, 위 문자열 포함 assert | packaging | test/test_oidc_proxy_setup.py:29 | - |
| RC-B-841 | OIDC 프록시 설정 입력 주입·충돌 거부 | 각 필드의 잘못된 값으로 render: name=`../escape`·`x\nExecStart=/tmp/attack`·25자 `x`; adminHostname=`x`·`a.example\n}`·`127.0.0.1`·`*.example.com`·`a.localhost`·`a.example:443`; issuer=`http://accounts.google.com`·`https://accounts.google.com@evil.example`·`...?secret=x`·`...#fragment`·개행 포함; clientId=`x"\nfoo=true`·`x y`; owners=`['*']`·`['*@example.com']`·`['a@example.com\n*']`·`[]`·대소문자만 다른 중복; proxyPort=`True`·80·65536·39125. 또 mcpHostname=adminHostname, `clientSecret` 필드 포함 | 모두 ValueError 상당 거절 | 각 입력 거절 assert(전 입력 목록) | packaging | test/test_oidc_proxy_setup.py:49 | - |
| RC-B-842 | 생성 systemd unit의 자격 증명 경로·서비스 제한과 입력 속 템플릿 자리표시자 비재작성 | 기본 설정으로 render한 두 unit. 별도로 issuer=`https://accounts.example.com/portal-client`, clientId=`127.0.0.1:4180`로 render | 모든 unit에 `DynamicUser=yes`,`NoNewPrivileges=yes`,`ProtectSystem=strict`,`ProtectHome=yes`,`StandardOutput=null`,`StandardError=null`,`LoadCredential=`가 있고 `client-secret=`·`Environment=OAUTH`는 없음. caddy unit에 `StateDirectory=ssh-portal-oidc-synthetic-test-caddy`,`StateDirectoryMode=0700`,`CapabilityBoundingSet=CAP_NET_BIND_SERVICE`. proxy unit에 `LoadCredential=config:/var/lib/ssh-portal-oidc/synthetic-test/proxy.cfg`이고 `AmbientCapabilities=`·`ExecStartPre=` 없음. 입력 속 값(`.../portal-client`, `127.0.0.1:4180`)은 proxy.cfg에 그대로 들어가며 템플릿 자리표시자로 재작성되지 않음 | 포함·불포함 문자열 assert | packaging | test/test_oidc_proxy_setup.py:62, test/test_oidc_proxy_setup.py:82 | - |
| RC-B-843 | OIDC 프록시 준비 CLI의 dry-run은 비밀 없음, 준비는 비TTY 거부 | 공개 설정으로 기본 실행, `--prepare`를 stdin 문자열과 함께 비TTY로 실행, `clientSecret` 포함 설정 실행 | 기본 실행 종료 0, `status=PREPARATION_PLAN`, 출력에 `owner@example.com`·`client-secret` 없음. `--prepare` 비TTY는 종료 1, stdout 비어 있음, stderr에 stdin 문자열 없음(stdin 미읽기). 비밀 포함 설정은 종료 1, 출력에 비밀 값 없음 | 종료 코드, JSON status, 문자열 부재 | packaging | test/test_oidc_proxy_setup.py:89 | - |
| RC-B-844 | 비공개 파일·쿠키 비밀·수신증 무비밀 및 제한적 umask | 준비 호출(비밀 입력은 주입), 이어 재준비. 별도로 umask 0o777에서 준비 | `status=PREPARED_NOT_INSTALLED`. 기준 디렉터리·세부 디렉터리 mode 0700, `client-secret` 원문 일치, `cookie-secret` 32바이트, `owners`=`owner@example.com\n`, 모든 파일 mode 0600, 수신증 files 키 집합=`Caddyfile`,`proxy.cfg`+units. 수신증 JSON에 비밀 값·비밀의 sha256·cookie sha256·소유자 이메일 없음. 재준비는 `ALREADY_EXISTS`. umask 0o777에서도 디렉터리 mode 0700 유지 | mode, 파일 내용, 수신증 부재 문자열, 오류 코드 | packaging | test/test_oidc_proxy_setup.py:125, test/test_oidc_proxy_setup.py:238 | - |
| RC-B-845 | 기준 디렉터리가 심볼릭 링크이거나 쓰기 가능하면 거부 | (a) 기준 디렉터리가 외부 디렉터리로 가는 링크 (b) 기준 디렉터리 mode 0777 (c) 기준 디렉터리의 부모가 mode 0777(비밀 입력 전에 거절) | 모두 `ROOT_OWNED`, 외부 디렉터리 비어 있음, (c)는 기준 디렉터리 미생성 | 오류 코드, 부재·빈 디렉터리 assert | packaging | test/test_oidc_proxy_setup.py:144, test/test_oidc_proxy_setup.py:163 | - |
| RC-B-846 | 비밀 입력 실패는 아무것도 쓰지 않음 | (a) 비밀 확인 입력이 서로 다름(`synthetic-secret-a` vs `...-b`) (b) 에코 제어 실패로 getpass 대체 경로로 떨어질 상황을 첫 입력·확인 입력 시점에 각각 주입(제어 터미널 없음) | (a) `MISMATCHED`, 기준 디렉터리 미생성 (b) `ECHO_FREE_INPUT_REQUIRED`, 에코 대체 입력 호출 0회, 일반 입력 횟수는 실패 시점-1, 대상 디렉터리 미생성, 출력·오류에 비밀 값·Traceback 없음 | 오류 코드·메시지, 입력 호출 횟수, 부재, 출력 문자열 부재 | packaging | test/test_oidc_proxy_setup.py:157, test/test_oidc_proxy_setup.py:173 | - |
| RC-B-847 | 마지막 동기화·쓰기 실패는 준비 완료 수신증을 남기지 않음 | (a) 마지막 파일 동기화(bundle.json fsync)가 실패 (b) 마지막 디렉터리 fsync 실패 (c) cookie-secret 쓰기가 실패한 뒤 재준비 | (a)(b)(c) `INCOMPLETE`. 대상 디렉터리 존재·mode 0700, `bundle.json` 없음, (a)(b)에서 `client-secret`은 입력 값으로 남음. (c) 후 재준비는 `ALREADY_EXISTS`(기존 파일 삭제하지 않음) | 오류 코드, 파일 존재 여부, mode | packaging | test/test_oidc_proxy_setup.py:219, test/test_oidc_proxy_setup.py:247 | - |
| RC-B-848 | 배포 묶음에 비밀 저장 레코드·개인 키 포함 거부 | (a) `src/private-store/key.json`에 `{"kind":"secret-record","schema":1,"value":<표식>}` (b) OIDC 예시 설정 파일 안에 `-----BEGIN RSA PRIVATE KEY-----` 줄 | (a) 오류 메시지에 `Secret store record` 포함, (b) `Private key` 포함. 두 경우 모두 메시지에 표식 값 없음, `release-manifest.json` 미생성 | 오류 메시지 포함·불포함, 매니페스트 부재 | packaging | test/test_package.py:53, test/test_package.py:224 | - |
| RC-B-849 | 네이티브 소스·고정 번들은 배포, 생성 산출물은 제외 | `native/freerdp-input/...` 10개 소스, `scripts/build-freerdp-input.py`, `vendor/fixture-native.tgz`를 두고 생성 파일 `native/freerdp-input/runtime/bin/xfreerdp3`, `runtime/manifest.json`, `build/compiler-output.txt`도 둠. package 실행 | 매니페스트의 `native/` 경로 집합이 정확히 소스 10개와 같음, `vendor/fixture-native.tgz`·`scripts/build-freerdp-input.py` 포함. 모든 아카이브(tar.gz·zip)에 `ssh-approval-portal-<ver>/` 접두로 소스 포함, `native/` 아래 `/runtime/`·`/build/` 경로 없음 | 매니페스트 경로 집합 일치, 아카이브 이름 포함·불포함 | packaging | test/test_package.py:61 | - |
| RC-B-850 | 배포 원본의 심볼릭 링크·정션 거부 | `native/freerdp-input/input.c`가 외부 파일 링크, OIDC 예시 leaf 링크, OIDC 예시 부모 디렉터리(`deploy/oidc`) 링크, Windows 정션 | 오류 메시지 `Unsafe package symlink`(네이티브) 또는 `unsafe`(OIDC 예시)를 포함. `release-manifest.json` 미생성, 외부 대상 내용 불변·정션은 대상을 읽지 않음 | 오류 메시지 일치, 매니페스트 부재, 외부 파일 불변 | packaging | test/test_package.py:89, test/test_package.py:199, test/test_package.py:233 | - |
| RC-B-851 | 매니페스트·아카이브 경로는 대소문자 구분 이식 가능 순서 | `scripts/Z-capital.sh`, `scripts/a-lower.sh` 추가 후 package | 매니페스트 경로가 정렬 순서(`Z-capital.sh`가 `a-lower.sh`보다 앞, `LICENSE`가 `app.mjs`보다 앞). tar.gz·zip 항목 이름 목록이 `정렬된 경로 + release-manifest.json`을 다시 정렬한 목록과 같음 | 매니페스트 정렬, 두 아카이브 이름 목록 일치 | packaging | test/test_package.py:102 | - |
| RC-B-852 | 배포 제외 대상과 포함 대상(비밀·잔재 제외, 시험 고정 데이터 포함) | `src/.env`, `web/operator.key`, `test/stale-results.json` / `test/fixtures/config.json`을 두고 package. zip 추출 | zip에 `src/domain`·`src/application`·`src/adapters`·`ui/src`·`ui/dist`·`web/src`·`web/dist` 하위 소스가 있음, `src/.env`·`web/operator.key`·`test/stale-results.json` 없음, `test/fixtures/config.json` 있음. (원 시험의 Node import smoke 검사는 Node 고유라 3.0에서는 JAR/모듈 구성 검사로 대체 — 추정) | 아카이브 이름 포함·불포함 assert | packaging | test/test_package.py:118 | - |
| RC-B-853 | 매니페스트에 없는 실행 소스는 검증 실패 | package 후 verify는 성공. 매니페스트에서 `src/domain/value.mjs` 항목을 제거하고 다시 verify | 종료 비정상, 오류 출력에 `Source missing from manifest`. 3.0은 JAR·모듈 목록 기준으로 대응 (추정) | 종료 코드와 오류 문구 | packaging | test/test_package.py:143 | - |
| RC-B-854 | OIDC 프록시 예시 파일은 양쪽 아카이브·매니페스트에 정확한 내용으로 포함 | `deploy/oidc/Caddyfile`, `deploy/oidc/oauth2-proxy.cfg`와 문서 `docs/oidc-https.ko.md`, 그리고 운영자 비공개 파일(`deploy/oidc/client-secret`, `operator.cfg`, `deploy/private.json`) 존재. package | 매니페스트의 `deploy/` 경로 집합이 예시 2개만. 문서의 `../deploy/oidc/...` 링크 집합이 예시 2개와 일치. tar.gz 멤버는 일반 파일·uid=gid=0·mode 0644, 내용은 원본 바이트와 같고 매니페스트 size·sha256이 원본과 일치. 비공개 파일은 미포함 | 경로 집합, 링크 집합, 메타·바이트·해시 일치 | packaging | test/test_package.py:169 | - |
| RC-B-855 | 매니페스트의 필수 OIDC 예시 누락·템플릿 변조 감지 | package 후 각 예시 항목을 매니페스트에서 하나씩 제거하고 verify. 원본 복원 후 `oauth2-proxy.cfg`를 `changed template\n`으로 변경 후 verify | 항목 제거 시 종료 비정상·`Required package entry missing`. 변조 시 종료 비정상·`Release digest mismatch` | 종료 코드·문구(제거 2회, 변조 1회) | packaging | test/test_package.py:253 | - |
| RC-B-856 | 소스 릴리스가 기본 Docker 아카이브를 준비하고 문서·버전이 일치 | 소스 트리를 복사해 package. Dockerfile의 `ARG PACKAGE_ARCHIVE=` 기본값과 `.dockerignore` 허용 규칙, 문서의 패키징 명령·배포 진입점 링크, 기본 출력으로 package-release 실행 | `.dockerignore`에 `!<archive>`가 있어 기본 Docker 아카이브가 빌드 컨텍스트에서 제외되지 않음. 기본 아카이브명=`dist/ssh-approval-portal-<ver>.tar.gz`. 영문·한글 README에 `npm run package:release -- --output /absolute/new/portal-<ver>-release`와 `scripts/prepare-docker.sh`·`docker/compose.yaml` 링크. 해당 배포 진입점 파일이 묶음에 포함, 묶음이 자기 배포본을 재귀 포함하지 않음. package-release 출력: 아카이브 4개(server·client × tar.gz·zip), `SHA256SUMS` 4줄이 실제 해시와 일치, 서버 아카이브의 매니페스트 `status=candidate-pending-live-host-verification`이고 소스 매니페스트와 동일. (3.0에서는 Gradle 배포 산출물·`dist` 파일명·Docker 사용 여부에 맞게 치환 — 추정) | 파일명·규칙·링크·해시·status assert | packaging | test/test_package.py:271 | D-0042 |
| RC-B-857 | 릴리스 묶음 4개 자산의 버전·매니페스트·체크섬·진입점 | `--release --output <새 디렉터리>`로 빌드. 서버·클라이언트 각 tar.gz·zip | 종료 0, 출력 `version`=소스 버전, 자산 4개(server·client × tar.gz·zip)와 `archives` 4개, `SHA256SUMS` 4줄이 `<sha256 64자>  <파일명>` 형식이고 `checksums` 출력과 같음. 각 아카이브 해시 일치, 모든 항목이 일반 파일·최상위 접두 일치·절대 경로·`..`·역슬래시 없음. 매니페스트 version 일치, 경로 중복 없음, 매니페스트가 모든 파일을 설명하고 항목 size·sha256이 실제와 일치. tar·zip이 파일 바이트 동일. 클라이언트: 의존성 비어 있음, entrypoint `scripts/portal-files.mjs`, `node_modules` 없음, PATH 비운 환경에서 `--help`가 종료 0이고 `file client<ver>`·`upload --file` 포함. 서버: `status=release`, verify 성공, 의존성 설치 후 import 해소(`Packaged application imports resolved`). (진입점·npm 부분은 3.0의 클라이언트 실행 파일·서버 JAR 기동 검사로 치환 — 추정) | 자산 집합, 체크섬, 매니페스트 해시·크기, tar-zip 동등, 진입점 실행 결과 | packaging | test/test_release_package.py:87 | D-0028(후보) |
| RC-B-858 | 기존 릴리스 출력 재사용 거부 | 이미 빌드된 출력 디렉터리에 같은 빌드를 다시 실행 | 종료 비정상. 기존 자산 파일 집합·바이트·mtime 불변, 소스 `release-manifest.json` 바이트 불변 | 종료 코드, 파일 집합·바이트·mtime 비교 | packaging | test/test_release_package.py:158 | - |
| RC-B-859 | 서버·클라이언트 버전 불일치 시 부분 릴리스 미발행 | 서버 `package.json` version을 `999.0.0`으로 바꿔 빌드 | 종료 비정상, 오류 출력에 `Server and client versions must match`, 출력 디렉터리 미생성, 소스 `release-manifest.json` 미생성. (2.x의 새 minor·patch 정식 후보를 거절하지 않는지 별도 확인 필요 — 장부 D-0029) | 종료 코드, 오류 문구, 부재 assert | packaging | test/test_release_package.py:171 | D-0029(후보) |
| RC-B-860 | 코드 전용 갱신: 활성 링크만 교체·복구 | 비어 있는 `old`를 가리키는 `active` 링크, 소스 `code.mjs`. 잠금을 잡고 게시 후 old→new로 활성화, 다시 new→old로 복구. 관리 파일 6개(env·unit·helper·key·policy·database, mode 0600) | 활성화 뒤 `active`→`new`, `new` 디렉터리 mode 0750, `code.mjs` mode 0640. 복구 뒤 관리 파일 6개의 바이트·uid·gid·mode가 시작 시점과 동일, `active`→`old` | readlink, mode, 관리 파일 스냅샷 비교 | packaging | test/test_release_update.py:56 | D-0014(후보) |
| RC-B-861 | 외부 파일 변경 시 활성화·복구 차단 | 게시 후 관리 파일 6개 각각을 `user-new-setting`으로 바꾸고 old→new 활성화 및 new→old 복구를 시도. 또한 검사 호출 2번째에 첫 관리 파일이 바뀌는 표류 | 모두 RuntimeError(`external protected change`), 사용자 변경 바이트 유지, `active` 링크는 기대 대상 그대로. 표류 시험에서는 링크가 `old` 유지, `.portal-link-*` 임시 링크 없음 | 예외, 변경 파일 바이트, readlink, 임시 링크 glob(관리 파일 6 × 활성화·복구 2 입력) | packaging | test/test_release_update.py:67, test/test_release_update.py:82 | - |
| RC-B-862 | 제3 릴리스·일반 파일인 active는 덮어쓰지 않음 | `active`가 제3 디렉터리 `third`를 가리키는 경우와 일반 파일(`user-active-file`)인 경우에 old→new 활성화 | 두 경우 RuntimeError. 일반 파일 바이트와 제3 링크 대상 불변 | 예외, 바이트·readlink | packaging | test/test_release_update.py:96 | - |
| RC-B-863 | 새 릴리스 게시 거부: 기존 디렉터리·링크, 검증 중 생성, 검증 실패, 외부 심볼릭 링크 | (a) `new`가 이미 디렉터리 또는 심볼릭 링크 (b) 검증 콜백 안에서 `new` 디렉터리가 생성됨 (c) 검증 콜백이 `manifest/import check failed` 실패 (d) 소스에 관리 파일로 가는 심볼릭 링크 `external` | (a)(b) `FileExistsError`, (b)는 `new`가 비어 있고 `.portal-code-*` 임시가 없음 (c) RuntimeError 후 `new` 없음 (d) ValueError 후 `new` 없음, 관리 파일 스냅샷 불변 | 예외 종류, `new` 존재 여부, 임시 glob, 관리 파일 스냅샷 | packaging | test/test_release_update.py:113, test/test_release_update.py:123, test/test_release_update.py:131 | - |
| RC-B-864 | 설치 공유 잠금이 복구 완료까지 다른 설치기를 배제 | 잠금을 잡고 게시·활성화 뒤 다른 프로세스가 같은 잠금을 비차단으로 시도, 이어 복구 | 다른 프로세스는 `locked`(BlockingIOError), 자식 종료 0. 복구 후 잠금 해제된 뒤 `active`→`old` | 다른 프로세스 결과, readlink | packaging | test/test_release_update.py:143 | - |
| RC-B-865 | 설치·갱신 계획은 dry-run에서 실행·root 요구 없음 | `install --admin-origin https://example.test --dry-run`(실제 CLI), 그리고 `install`·`update`·`verify`·`status`·`connect access`·`connect oidc`·`connect upload-sources`·`connect env-editor`·`policy --admin-origin https://example.test`·`rollback /var/lib/ssh-mcp/app/backups/prior` 각각 `--dry-run`을 플랫폼이 win32인 상태로 | 실제 CLI: `status=DRY_RUN`, `steps[0].argv` 끝 두 개가 `--admin-origin`,`https://example.test`, `sudoGrantRequested=false`. 계획 10종: 종료 0이고 실제 실행 호출 0회. (3.0에서는 설치 스크립트 `install.sh`·`install.cmd`와 Java install 명령에 대응한다. `connect access`(관리자 Access JWT 설정)·`connect env-editor`는 3.0에서도 유지하며 env-editor는 Java가 처리하므로 root broker·Python 없음: 메인 판정 2) | JSON 필드, 종료 코드, 실행 미호출 | packaging | test/test_portal_setup.py:18, test/test_portal_setup.py:27 | - |
| RC-B-866 | `connect oidc` 계획은 소유자 트랜잭션 재사용, Cloudflare 전용 옵션 거부 | `connect oidc` 계획, `connect access` 계획, `connect oidc`에 `--apply`·`--connector`·`--restore-environment`·`--install-cloudflared`·`--sync-server` 추가 | oidc 계획 첫 단계 argv 끝 두 개가 `<scripts>/configure-admin-access.sh`,`--oidc`, `interactive=true`, 단계 이름 `['oidc','package','health']`. access 계획 첫 단계 argv=`['bash', <scripts>/configure-admin-access.sh]`. 위 5개 옵션은 각각 ValueError(`--install-cloudflared` 등은 Cloudflare 전용이라 3.0에서는 옵션 자체가 없음) | argv·단계 이름·interactive, 옵션 5개 거절 | packaging | test/test_portal_setup.py:38 | - |
| RC-B-867 | update는 설치 전용 권한·origin 옵션을 전달하지 않음 | `update` 계획. `update --grant-sudo-all`, `update --admin-origin` 인자 파싱 | 첫 단계 argv 길이 2, `settingsPreserved=true`. 두 옵션은 사용법 오류로 종료(SystemExit) | argv 길이, 플래그, SystemExit | packaging | test/test_portal_setup.py:48 | - |
| RC-B-868 | sudo 권한은 명시적이며 한 번만 전달 | `install --grant-sudo-all` 계획 | `sudoGrantRequested=true`, 첫 단계 argv에서 `--grant-sudo-all` 정확히 1회 | 플래그 개수 | packaging | test/test_portal_setup.py:56 | - |
| RC-B-869 | admin origin 형태 검증(자격 증명·경로·포트·제어 문자 거부) | `install --admin-origin <값>`에서 값: 빈 문자열, `http://example.test`, `https://user:secret@example.test`, `https://example.test/path`, `https://example.test?token=secret`, `https://example.test#fragment`, `https://example.test:no`, `https://example.test:70000`, `https://example.test\n` | 9개 모두 ValueError 상당 거절 | 9입력 모두 거절 | packaging | test/test_portal_setup.py:61 | - |
| RC-B-870 | 단계 실패 시 이후 단계 중단·재시도 없음 | (a) update 계획의 첫 단계가 종료 코드 23으로 실패 (b) install 계획의 두 번째 단계가 실패 | (a) 결과 `{status:'FAILED', step:'update', exitCode:23}`, 실행 호출 1회 (b) `step='package'`, 호출 2회(성공한 변경 단계를 반복하지 않음) | 결과 객체, 호출 횟수 | packaging | test/test_portal_setup.py:69, test/test_portal_setup.py:78 | - |
| RC-B-871 | rollback은 기존 복원 스크립트를 쓰고 복원 후 상태를 검증, 백업 경로 제한 | `rollback /var/lib/ssh-mcp/app/backups/prior` 계획. 잘못된 경로: `/tmp/backup`, `/var/lib/ssh-mcp/app/backups`, `/var/lib/ssh-mcp/app/backups/../outside`, `/var/lib/ssh-mcp/app/backups/a/nested`, `relative` | 첫 단계 argv 끝=백업 경로, argv[1]이 `rollback.sh`로 끝남, 단계 이름 `['rollback','health']`. 잘못된 경로 5개는 ValueError. (3.0 설치 경로·복원 방식은 packaging 설계에 맞게 치환 — 추정) | argv, 단계 이름, 5입력 거절 | packaging | test/test_portal_setup.py:88 | - |
| RC-B-872 | policy는 소유자 조치 필요를 보고하고 저장·활성화를 주장하지 않음 | `policy --admin-origin https://example.test` 실행 | 종료 코드 3, 실행 호출 0회, 출력 JSON `status=ACTION_REQUIRED`, `url=https://example.test/settings` | 종료 코드, JSON 필드 | packaging | test/test_portal_setup.py:100 | - |
| RC-B-873 | 지원하지 않는 환경에서 변경 작업은 실행 전에 거부 | 플랫폼이 win32인 상태에서 `install`(비 dry-run) | ValueError 거절, 실행 호출 0회. (3.0은 Windows·Linux 대상이므로 거절 대상이 달라진다 — 추정: Windows에서는 install.cmd 경로로 허용, 지원 외 OS만 거절) | 예외, 실행 미호출 | packaging | test/test_portal_setup.py:108 | - |
| RC-B-874 | 지원하지 않는 호스트는 런타임을 읽거나 만들지 않고 건너뜀(xfreerdp3 입력 준비) | root=존재하지 않는 경로, (system, machine)=(`win32`,`AMD64`)·(`linux`,`aarch64`)·(`darwin`,`x86_64`)로 prepare | 각각 `status=skipped`, `reason=UNSUPPORTED_NATIVE_PLATFORM`, root 디렉터리 미생성 | 두 필드와 root 부재(3 입력) | portal-desktop | test/test_prepare_freerdp_input.py:25 | - |
| RC-B-875 | 검증된 번들만 준비하고 바이너리를 실행하지 않으며 정확한 inode 재사용 | linux/x86_64에서 고정 번들(`bin/xfreerdp3`(종료 93으로 실행 시 실패하는 스크립트), `lib/libfixture.so.3`, `licenses/FreeRDP-LICENSE`)로 prepare 후 재호출 | 첫 호출 `status=prepared`, files=3. 각 파일 바이트 일치, mode는 `bin/`이면 0755, 그 외 0644. 번들 안 `source/`는 풀지 않음. 재호출은 `status=reused`, runtime inode 동일, `.runtime-*` 임시 없음 | 상태·파일 수, 바이트·mode, inode 비교 | portal-desktop | test/test_prepare_freerdp_input.py:82 | - |
| RC-B-876 | 제한적 umask(077)에서도 실행 파일·라이브러리 mode 보존 | CLI를 umask 077 프로세스로 실행(번들·매니페스트 고정) | 종료 0, `status=prepared`, 부모 umask 불변, 런타임·`bin`·`lib`·`licenses` 디렉터리 mode 0755, `bin/xfreerdp3` 0755, `lib/libfixture.so.3` 0644 | 종료 코드, mode, umask 비교 | portal-desktop | test/test_prepare_freerdp_input.py:96 | D-0014(후보) |
| RC-B-877 | 번들 해시·릴리스 매니페스트 고정 | (a) 유효 gzip 헤더 1바이트(offset 4)를 변조 (b) 릴리스 매니페스트의 `files`가 `[]` | (a) `FREERDP_BUNDLE_HASH_MISMATCH`, 런타임 미생성 (b) `FREERDP_RELEASE_PIN_REQUIRED`, 런타임 미생성 | 오류 코드 2건, 부재 | portal-desktop | test/test_prepare_freerdp_input.py:115, test/test_prepare_freerdp_input.py:122 | - |
| RC-B-878 | 번들 내부 매니페스트 변조 거부 | 매니페스트 변형: upstreamCommit=`0`*40 / 첫 파일 sha256=`0`*64 / size=1 / mode=0777 / 첫 파일 항목 중복 추가 / path=`../escape` | 6개 모두 ValueError, 런타임 미생성 | 6입력 거절, 부재 | portal-desktop | test/test_prepare_freerdp_input.py:129 | - |
| RC-B-879 | tar 멤버 안전: 중복·탈출·목록 밖·링크/장치, 쓰기 가능 디렉터리 | 추가 멤버: `runtime/bin/xfreerdp3`(중복), `../escape`, `/absolute`, `runtime/lib/unlisted.so`, `runtime//bad`, `source/unsafe`를 심볼릭 링크·하드 링크·문자 장치·FIFO로. 별도로 `source/overlay` 디렉터리를 mode 0775로 | 9개 멤버 각각 ValueError, 런타임 미생성. mode 0775 디렉터리는 `FREERDP_UNSAFE_ARCHIVE_MODE`, 런타임 미생성 | 9입력 + 1 거절, 부재 | portal-desktop | test/test_prepare_freerdp_input.py:142, test/test_prepare_freerdp_input.py:163 | - |
| RC-B-880 | 아카이브 항목 수·확장 크기 한도 | 항목 한도를 4(`ENTRY_LIMIT`), 확장 크기 한도를 1024(`EXPANDED_LIMIT`)로 낮추고 prepare | 각각 `FREERDP_ENTRY_LIMIT`, `FREERDP_EXPANDED_LIMIT`, 런타임 미생성 | 오류 코드 2건, 부재 | portal-desktop | test/test_prepare_freerdp_input.py:156 | - |
| RC-B-881 | 내용이 다른 기존 런타임은 변경·교체하지 않음 | 준비 후 `lib/libfixture.so.3`를 `preserve differing runtime`로 변경하고 다시 prepare | `FREERDP_EXISTING_RUNTIME_MISMATCH`, 변경 파일 바이트·inode 불변 | 오류 코드, 바이트·inode | portal-desktop | test/test_prepare_freerdp_input.py:170 | - |
| RC-B-882 | 빈 런타임 충돌과 심볼릭 링크 부모를 덮어쓰지 않음 | (a) 빈 런타임 디렉터리가 이미 존재 (b) 런타임 부모(`native`)가 외부 디렉터리로 가는 심볼릭 링크 | (a) ValueError 또는 OSError, 디렉터리 inode 불변·내용 비어 있음 (b) `FREERDP_UNSAFE_DIRECTORY`, 외부 디렉터리 비어 있음 | 예외, inode, 빈 디렉터리 | portal-desktop | test/test_prepare_freerdp_input.py:178 | - |
| RC-B-883 | 원자적 게시 실패는 자기 임시 디렉터리만 제거 | publish 단계에서 OSError(`fixture failure`) 주입 | OSError 전파, 런타임 미생성, `.runtime-*` 임시 디렉터리 없음, 번들 아카이브 파일은 보존 | 예외, glob, 아카이브 존재 | portal-desktop | test/test_prepare_freerdp_input.py:190 | - |
| RC-B-884 | 비공개 환경 파일 파서가 Vault 메타데이터 키 보존 | mode 0600 `private.env`에 `BRIDGE_VAULT_URL=https://vault.example.test:8200`, `BRIDGE_VAULT_MOUNT=secret`, `BRIDGE_VAULT_TOKEN_REF=secret://local-file/vault-reader-token` | 세 키 값이 그대로 파싱됨 | 값 3건 | portal-app | test/test_settings_contract.py:15 | - |
| RC-B-885 | 포트 설정은 평가 없이 파싱, 허용 키만 | 파일 없음 → 기본 `{mcp:39124, admin:39125}`. 0600 파일 `BRIDGE_MCP_PORT=40001`, `BRIDGE_ADMIN_PORT="40002"`, `SSH_MCP_FIXTURE2_KEY=private` → `{mcp:40001, admin:40002}`. `BRIDGE_MCP_PORT=$(false)` 포트 검증. `NODE_OPTIONS=--inspect` 읽기 | 기본값, 따옴표 제거한 값, 알 수 없는 `SSH_MCP_FIXTURE2_KEY`는 무시. `$(false)`는 ValueError(셸 평가 없음). `NODE_OPTIONS=...`는 ValueError(`NODE_OPTIONS`는 3.0에는 없는 키이나 허용 목록 밖 키 거부 동작은 유지 — 추정) | 반환 맵, 거절 2건 | portal-app | test/test_settings_contract.py:74 | - |
| RC-B-886 | 비공개 설정 파일 경계: 일반 파일·mode 0600 | (a) `private.env` mode 0644 읽기(settings), (b) 링크 경로 읽기, (c) `config.env` 0600 + CRLF 본문 읽기(upload-sources), (d) 링크, (e) mode 0644 | 0644는 ValueError, 링크는 ValueError 또는 OSError. 0600 일반 파일은 본문(`BRIDGE_UI_ENABLED=true\r\n`, CRLF 유지)을 그대로 반환 | 예외·반환 본문(Unix 권한 의미; Windows 대상은 소유자 ACL로 치환 — 추정) | portal-app | test/test_settings_contract.py:89, test/test_upload_sources.py:39 | - |
| RC-B-887 | 업로드 호스트 공유 벡터 | `config/settings-contract.json`의 `uploadHostVectors` 전체. 추가로 `null`, `'x'*65537` | `valid=false` 벡터는 ValueError, 나머지는 `expected`와 같은 정규화 결과. `null`·65537자는 ValueError | 벡터 전수 assert(계약 JSON은 3.0에서도 유지 — 추정) | portal-app | test/test_settings_contract.py:25 | - |
| RC-B-888 | origin·포트 공유 벡터 | `settings-contract.json`의 `originVectors`·`portVectors` 전체 | `valid=true`이면 origin은 값 그대로, port는 정수로 반환. 아니면 ValueError 또는 OSError | 벡터 전수 assert | portal-app | test/test_settings_contract.py:37 | - |
| RC-B-889 | 관리자 origin 정규화 결과 정확 일치와 크기 한도(Node 하위 프로세스 어댑터 세부는 제외) | origin `https://xn--fa-hia.example`. 정규화 결과가 (a) 입력과 같음 (b) 종료 1·빈 출력 (c) 다른 origin (d) 끝에 개행 추가 (e) 길이 `originMaxBytes+1` 출력 (f) 시간 초과 (g) 입력 길이가 `originMaxBytes+1` | (a) 입력 그대로 반환 (b)~(f) ValueError(메시지 정확히 `Configure one canonical HTTPS administrator origin`) (g) 외부 호출 없이 ValueError. (stdin 전달·shell=false·타임아웃 5초·`NODE_OPTIONS`·`NODE_PATH` 제거 같은 Node 호출 세부는 Java 직접 구현이라 3.0에 없음) | 반환값·오류 메시지 정규식, 입력 길이 한도 | portal-app | test/test_settings_contract.py:47 | - |
| RC-B-890 | 업로드 소스 호스트 갱신: 다른 줄·CRLF 보존, 설정 한 줄만 교체 | 본문 `BRIDGE_ADMIN_TOKEN=synthetic-secret\r\n# comment\r\nBRIDGE_UI_ENABLED=true\r\nBRIDGE_UPLOAD_SOURCE_HOSTS=old.test\r\nBRIDGE_ACCESS_OWNER_EMAILS=owner@example.test\r\n`에 `Files.Example.test,files.example.test,other.test`로 갱신. 갱신 결과에 빈 값 갱신. 별도로 본문 `...# old *.other.test\r\nBRIDGE_UPLOAD_SOURCE_HOSTS=old.test\r\n...`에 ` Files.Example.test,*.Example.test,*.example.test `(앞뒤 공백)로 갱신 | 기존 설정 줄은 삭제되고 나머지 바이트는 그대로, 끝에 `BRIDGE_UPLOAD_SOURCE_HOSTS=files.example.test,other.test\r\n`(소문자화·중복 제거, 첫 등장 순서). 빈 값 갱신의 마지막 줄은 `BRIDGE_UPLOAD_SOURCE_HOSTS=`. 와일드카드 혼합은 `files.example.test,*.example.test\r\n`, 주석 `# old *.other.test`는 보존 | 반환 문자열 전체 일치(3 입력) | portal-app | test/test_upload_sources.py:16, test/test_upload_sources.py:27 | - |
| RC-B-891 | 업로드 소스 호스트의 잘못된 입력 거부 | 갱신 값: `https://files.test/a`, `*`, `files.*.test`, `files.test.`, `owner@files.test`, `files.test:443`, `127.0.0.1`, `::1`, `127.1`, `2130706433`, `0x7f000001`, `0177.0.0.1`, `files.test,,other.test`, `files.test\nBRIDGE_UI_ENABLED=false` | 14개 모두 ValueError 거절 | 14입력 거절 | portal-app | test/test_upload_sources.py:22 | - |
| RC-B-892 | 호스트 갱신이 관리 설정 크기 한도(65536바이트)를 넘지 않음 | 본문 `BRIDGE_ADMIN_TOKEN=`+`x`*65500+`\n`(65536 미만)에 `*.downloads.example.test`로 갱신 | ValueError, 메시지에 `size limit` 포함 | 오류 메시지 | portal-app | test/test_upload_sources.py:32 | - |

### G11 (원자료 2184~2325: PowerShell·셸 142행)

| 사례 ID | 대상 기능 | 입력·조건 | 기대 결과 | 판정 방법 | 3.0 모듈 | 원 시험 | 연결 결함 |
|---|---|---|---|---|---|---|---|
| RC-B-901 | Windows 대상 파일 작업의 오류 응답 위생·분류 코드(helper의 JSON 오류 응답 → 3.0 SFTP 오류 매핑) | publish·snapshot 요청을 각각 오류로 유도하는 입력 표(DESTINATION_EXISTS: 이미 있는 대상에 overwrite=false publish, FILE_TOO_LARGE: maxBytes=1 snapshot, FILE_NOT_FOUND: 없는 파일 snapshot, PARENT_NOT_FOUND: 없는 부모 디렉터리 publish, FILE_CHANGED, PERMISSION_DENIED, UNSAFE_PATH, PATH_OUTSIDE_ALLOWED_ROOT, INVALID_REQUEST). 본문 첫 줄이 `sensitive-marker`로 시작하는 파일을 다룸 | 각 입력이 대응 코드를 대소문자 정확히 일치(`-ceq`)로 반환하고 종료 상태 1(3.0은 실패 결과). 응답·stderr에 예외 상세·파일 내용(`sensitive-marker`)·경로 원문이 없다. 오류 코드 집합은 `PARENT_NOT_FOUND, FILE_NOT_FOUND, PERMISSION_DENIED, DESTINATION_EXISTS, UNSAFE_PATH, PATH_OUTSIDE_ALLOWED_ROOT, STAGING_UNAVAILABLE, FILE_CHANGED, FILE_TOO_LARGE, INVALID_REQUEST, OPERATION_FAILED` 중 하나로 분류(미분류는 `unclassified`). 요청 검증은 INVALID_REQUEST(id가 `../sensitive-marker`, overwrite/elevate/bypassRoot가 문자열 'true', maxBytes=1.5, action='authorize'는 elevate 없이 거부)(다중 줄 Refused 호출 반영) | 코드 문자열 정확 일치, 응답 원문에 `sensitive-marker` 부재, 응답에 stderr·예외 문구 부재 | portal-ssh | test/windows-file-helper.tests.ps1:61, test/windows-file-helper.tests.ps1:105, test/windows-file-helper.tests.ps1:106 | D-0034(후보) |
| RC-B-903 | FO-SNAPSHOT-01 TEST 서버 우회(bypassRoot=true) snapshot은 외부 소유자 부모 디렉터리의 일반 파일을 읽는다 | 부모 디렉터리 소유자를 `S-1-5-32-545`(Users, 토큰 구성원이나 서비스 계정·SYSTEM·Administrators가 아님)로 설정(소유자 확인: 298). 그 안의 source.bin(UTF-8 `sensitive-marker`+CRLF+한글 바이트)에 snapshot(bypassRoot=true) | exit 0, sha256 == 독립 계산 digest, size == 바이트 길이, rootPolicyApplied == `test-server-bypass`(원문 오류 시 `PERMISSION_DENIED/policy/UNTRUSTED_OWNER`가 red). stage의 `<id>.part` 바이트가 원본과 base64 일치. 원본 부모·파일의 owner·SDDL 불변. cleanup 요청 exit 0. 전체 FO-SNAPSHOT 사례 뒤에도 부모·원본 SDDL이 처음과 동일(다중 줄 assert 288·307 반영) | exit·sha256·size·rootPolicyApplied, part 바이트, SDDL 문자열 비교, cleanup | portal-ssh | test/windows-file-helper.tests.ps1:298, test/windows-file-helper.tests.ps1:310, test/windows-file-helper.tests.ps1:311, test/windows-file-helper.tests.ps1:313, test/windows-file-helper.tests.ps1:467 | D-0001(확정) |
| RC-B-906 | FO-SNAPSHOT-04 TEST snapshot은 소스에 READ_CONTROL 권한이 없어도 데이터 읽기만으로 성공 | 부모·파일의 소유자를 `S-1-5-32-545`로 하고 서비스 계정과 `S-1-3-4`(Owner Rights)에 ReadPermissions Deny ACE 추가. 사전 OS 탐침: 소스 접근(부모 0xA0, 파일 0x100081)은 오류 0, READ_CONTROL(0x20000) 열기는 오류 5. 그 뒤 bypassRoot=true snapshot | 탐침 4개 결과가 (0,5,0,5)인 고정 조건(다중 줄 assert 372). snapshot exit 0, sha256 == digest, stage `.part` 바이트 일치, cleanup exit 0. 종료 시 ACL 복원 | exit·sha256, part 바이트, cleanup | portal-ssh | test/windows-file-helper.tests.ps1:376, test/windows-file-helper.tests.ps1:377, test/windows-file-helper.tests.ps1:378 | D-0001(후보) |
| RC-B-907 | FO-SNAPSHOT-06 및 일반 경로 안전성: 위험 경로는 UNSAFE_PATH로 거절하고 stage `.part`를 만들지 않음 | bypassRoot=true와 false 각각으로 snapshot. 외부 소유자 부모 안의 대표 입력: junction 하위 `source.bin`, 심볼릭 링크 파일, 하드링크 파일, 대체 스트림(`source.bin:stream`). 일반 입력: `relative.txt`, `\\server\share\file`, `\\?\C:\file`, `C:relative`, `C:\file:stream`, `<root>\..\escape`, `<root>\.\file`, `<root>\a\\b`, `<root>\NUL.txt`, `<root>\COM1`, `<root>\name.`, `<root>\name `(끝 공백), `<root>\folder\`(다중 줄 Refused 반영). root 안 junction/hardlink/symlink가 가리키는 외부 secret.bin | 모두 exit 1, errorCode `UNSAFE_PATH`, 응답에 파일 내용 없음, stage `.part` 미생성. 원본과 대체(decoy) 파일 바이트는 시험 전과 같다(다중 줄 assert 420) | 코드 일치, `.part` 부재, 바이트 비교 | portal-ssh | test/windows-file-helper.tests.ps1:418 | D-0003(후보) |
| RC-B-908 | FO-SNAPSHOT-08 snapshot 중 부모·leaf 이름 변경과 부모 reparse 치환 경합 | 64 MiB(67108864바이트, 끝 바이트 123) 소스(외부 소유자 부모)에 bypassRoot=true snapshot을 실행하는 동안 .part 생성이 관찰되면 부모 디렉터리 이름 변경, leaf 이름 변경, 부모를 decoy로의 reparse(junction)로 치환을 시도 | 경합 장치가 실패 없이 동작하고 `.part`를 관찰해 시도 3회 완료(아니면 시험 준비 부족이며 제품 red 아님). 성공 시 sha256 == 원본 raceHash, size == 67108864, rootPolicyApplied `test-server-bypass`, `.part` 바이트가 원본과 일치(고정한 원본만 보고, 다중 줄 assert 449 반영). 실패 시 exit 1이고 errorCode ∈ {UNSAFE_PATH, FILE_CHANGED, PERMISSION_DENIED, FILE_NOT_FOUND, PARENT_NOT_FOUND}이며 `.part` 미생성. 어느 쪽이든 stage cleanup exit 0. (3.0: SFTP는 서버가 핸들을 관리하므로 경합 시 읽은 바이트가 열린 원본 한 개와 일치하거나 안전 거절이어야 함) | 성공 분기 해시·size·바이트, 실패 분기 코드 집합과 `.part` 부재, cleanup | portal-ssh | test/windows-file-helper.tests.ps1:446, test/windows-file-helper.tests.ps1:447, test/windows-file-helper.tests.ps1:451, test/windows-file-helper.tests.ps1:454, test/windows-file-helper.tests.ps1:463 | D-0003(확정) |
| RC-B-909 | WRITER-ACL-01 inherit-only Creator Owner ACE만 있는 부모에서도 publish·snapshot 성공, 디렉터리 ACL을 고치지 않음 | 디렉터리에 `S-1-3-0`(Creator Owner) FullControl ACE를 ContainerInherit+ObjectInherit+InheritOnly로만 추가(조건 확인: Creator ACE 존재, 전부 InheritOnly(flags & 8), 쓰기 마스크 0x500D0156 포함, 다중 줄 assert 486). bypassRoot=true로 binary.bin publish 후 같은 경로 snapshot | publish exit 0, published true, rootPolicyApplied `test-server-bypass`, 대상 바이트가 입력과 일치. snapshot exit 0, sha256 == digest, `.part` 바이트 일치. 디렉터리 SDDL이 시험 전과 동일(helper는 ACL을 수리하지 않음). 두 stage 모두 cleanup exit 0 | exit·published·rootPolicy, 바이트, SDDL 불변, cleanup | portal-ssh | test/windows-file-helper.tests.ps1:496, test/windows-file-helper.tests.ps1:497, test/windows-file-helper.tests.ps1:499, test/windows-file-helper.tests.ps1:500, test/windows-file-helper.tests.ps1:501, test/windows-file-helper.tests.ps1:506 | D-0034(후보) |
| RC-B-910 | WRITER-ACL-02 Users에게 생성 권한만 있는 공유 드롭 디렉터리에서 publish·snapshot 성공, 비공개 파일 | 디렉터리에 Users(`S-1-5-32-545`) CreateFiles+CreateDirectories 허용 ACE(유효)와 ObjectInherit·InheritOnly FullControl ACE 추가(조건: Users의 비-InheritOnly ACE 마스크 & 6 == 6, 다중 줄 assert 771). bypassRoot=true로 private.bin publish → 같은 파일 snapshot | publish exit 0, published true. 대상 바이트 일치. 새 파일의 비공개 DACL 조건(RC-B-902)은 결정 D3-16으로 삭제 표로 이동해 이식하지 않는다(대체 S3-RW-05). snapshot exit 0, sha256 == digest. 디렉터리 SDDL 불변. 두 stage cleanup exit 0 | exit·published, 바이트, 파일 DACL, 디렉터리 SDDL, cleanup | portal-ssh | test/windows-file-helper.tests.ps1:779, test/windows-file-helper.tests.ps1:780, test/windows-file-helper.tests.ps1:785, test/windows-file-helper.tests.ps1:786, test/windows-file-helper.tests.ps1:790 | D-0034(후보) |
| RC-B-911 | WRITER-ACL-03 부모에서 상속된 Users 생성 ACE가 있는 자식 디렉터리에서 비공개 publish 성공 | 부모에 Users CreateFiles+CreateDirectories ACE(ContainerInherit·InheritOnly) 추가 후 자식 디렉터리 생성. 자식 SDDL에서 Users ACE가 상속(flags & 16)·유효(flags & 8 == 0)·마스크 & 6 == 6(다중 줄 assert 805). bypassRoot=true publish | exit 0, published true(원 시험 라벨은 동적 문자열). 새 파일의 비공개 DACL 조건(RC-B-902)은 결정 D3-16으로 삭제 표로 이동해 이식하지 않는다(대체 S3-RW-05). 자식 디렉터리 SDDL 불변. stage cleanup exit 0 | exit·published, 파일 DACL, SDDL 불변, cleanup | portal-ssh | test/windows-file-helper.tests.ps1:813, test/windows-file-helper.tests.ps1:815, test/windows-file-helper.tests.ps1:818 | D-0034(후보) |
| RC-B-912 | WRITER-ACL-04 및 FO-SNAPSHOT-05 실제 OS 접근 거부는 정책 거절과 구분하고 ACL을 고치지 않음 | (a) 대상 디렉터리에 서비스 계정 CreateFiles Deny ACE → bypassRoot=true publish(must-not-exist.bin). (b) 소스 파일에 서비스 계정 ReadData Deny ACE → bypassRoot=true snapshot | (a) exit 1, errorCode `PERMISSION_DENIED`, origin `os`, nativeStep `open`, nativeError 5(ERROR_ACCESS_DENIED, 3.0 SFTP는 SSH_FX_PERMISSION_DENIED로 대응, 추정), policyReason 속성 없음, published 거짓, 대상 파일 미생성, 디렉터리 SDDL 불변, 그 stage cleanup exit 0. (b) 동일 필드(origin `os`, nativeStep `open`, nativeError 5, policyReason 없음), `.part` 미생성, 소스 SDDL 불변(다중 줄 assert 400·403·833 반영) | 오류 필드 5종, 파일 부재, SDDL 불변, cleanup | portal-ssh | test/windows-file-helper.tests.ps1:835, test/windows-file-helper.tests.ps1:836, test/windows-file-helper.tests.ps1:837, test/windows-file-helper.tests.ps1:840 | D-0034(확정) |
| RC-B-913 | publish 기본 동작: 메타데이터·기본 정책·이진 바이트 | 사전 stage된 `<id>.part`(UTF-8 `sensitive-marker\r\nUnicode: 한글\n`) 의 sha256·size를 지정해 root 안 `result.bin`에 publish(overwrite=false, 우회 옵션 없음). 이어서 같은 요청을 다시 publish | 1회차 exit 0, published true, sha256 == digest, size == 바이트 길이, rootPolicyApplied `configured-root`, 대상 바이트 base64가 입력과 일치. 2회차는 exit 1·`DESTINATION_EXISTS` | exit·published·sha256·size, rootPolicyApplied, 바이트, 재실행 코드 | portal-ssh | test/windows-file-helper.tests.ps1:644, test/windows-file-helper.tests.ps1:645, test/windows-file-helper.tests.ps1:646 | D-0002(후보) |
| RC-B-915 | overwrite 중 열린 읽기 핸들: share-delete 읽기는 유지, 삭제 공유 없는 읽기는 PERMISSION_DENIED로 원본 보존 | (a) 대상을 FileShare.Read+Delete로 연 reader를 유지한 채 overwrite publish. (b) 대상을 FileShare.Read(삭제 공유 없음)로 연 reader를 유지한 채 overwrite publish | (a) exit 0, published true(원 시험 라벨 동적 문자열), 유지한 핸들에서 첫 바이트가 `script.bytes[0]`로 읽힘. (b) exit 1, `PERMISSION_DENIED`, 대상 바이트가 입력 바이트와 동일하게 보존 | (a) exit·ReadByte, (b) 코드·바이트 보존 | portal-ssh | test/windows-file-helper.tests.ps1:666, test/windows-file-helper.tests.ps1:667, test/windows-file-helper.tests.ps1:671 | - |
| RC-B-918 | snapshot 기본 동작: 메타데이터와 바이트 | root 안 기존 파일에 elevate=true snapshot. 이어서 같은 id snapshot, id를 새로 하고 maxBytes=1인 snapshot | 1회차 exit 0, sha256 == digest, size == 바이트 길이, `.part` 바이트 일치. 같은 id 재요청은 `DESTINATION_EXISTS`, maxBytes=1은 `FILE_TOO_LARGE`(Refused 호출 반영) | exit·sha256·size, 바이트, 두 거절 코드 | portal-ssh | test/windows-file-helper.tests.ps1:702, test/windows-file-helper.tests.ps1:703 | - |
| RC-B-919 | publish의 해시·크기 불일치는 FILE_CHANGED로 거절하고 대상·임시 파일을 남기지 않음 | stage에는 정상 바이트, 요청 sha256을 `0`×64로 하여 publish. 이어서 요청 size를 +1하여 publish | 두 경우 모두 exit 1·`FILE_CHANGED`. 대상 파일 미생성. root에 `.ssh-approval-*.part` 임시 파일 0개 | 코드, 대상 부재, 임시 파일 수 0 | portal-ssh | test/windows-file-helper.tests.ps1:713, test/windows-file-helper.tests.ps1:714 | - |
| RC-B-920 | 일반 모드는 허용 루트 밖 경로를 PATH_OUTSIDE_ALLOWED_ROOT로 구분하고 허용 루트는 설정에서만 가져옴 | root 밖 형제 경로 `files-other/file.bin`에 snapshot(bypassRoot 없음). 요청에 `allowedRoot=<작업 루트>` 값을 넣어 보냄 | exit 1, errorCode `PATH_OUTSIDE_ALLOWED_ROOT`(UNSAFE_PATH와 구분). 응답 allowedRoot는 helper 설정의 root이고 요청이 보낸 값이 아님 | 코드 일치, allowedRoot 값 비교 | portal-ssh | test/windows-file-helper.tests.ps1:722, test/windows-file-helper.tests.ps1:723 | D-0002(후보) |
| RC-B-921 | bypassRoot=true(TEST 서버 우회)는 허용 루트 정책을 적용하지 않음: 루트 사용 불가에서도 외부 publish·snapshot 가능 | 설정 루트 디렉터리를 이동해 사용 불가로 만든 상태. policy 요청(bypassRoot=false, true 각각), bypassRoot=true로 루트 밖 `bypass/uploaded.bin` publish, 같은 파일 snapshot | policy 응답: exit 0, protocol `file-path-policy-v1`, allowedRoot가 설정 루트, rootPolicyApplied는 false면 `configured-root`·true면 `test-server-bypass`(루트 가용성과 무관, 다중 줄 assert 738). publish exit 0·published true·rootPolicyApplied `test-server-bypass`, 대상 바이트 일치. snapshot exit 0·sha256 == digest·`test-server-bypass` | policy 필드 3종, 바이트, 정책 문자열 | portal-ssh | test/windows-file-helper.tests.ps1:742, test/windows-file-helper.tests.ps1:743, test/windows-file-helper.tests.ps1:747 | D-0002(확정) |
| RC-B-922 | stage cleanup: 자기 stage만 지우고 멱등이며 설정 루트가 없어도 동작 | publish 뒤 cleanup. 같은 cleanup 재호출. 설정 루트를 이동한 상태에서 bypass publish·snapshot 각각의 stage cleanup | cleanup exit 0·cleaned true, 자기 `<id>.part`만 삭제(다른 id stage는 그대로). 재호출도 exit 0. 루트 사용 불가에서도 cleaned true이며 `.part` 부재 | exit·cleaned, 파일 부재, 멱등 | portal-ssh | test/windows-file-helper.tests.ps1:695, test/windows-file-helper.tests.ps1:696, test/windows-file-helper.tests.ps1:697, test/windows-file-helper.tests.ps1:752, test/windows-file-helper.tests.ps1:753 | - |
| RC-B-923 | cleanup 대상 stage 파일이 심볼릭 링크면 UNSAFE_PATH로 거절하고 링크 대상을 건드리지 않음 | stage에 `<id>.part` 이름의 심볼릭 링크(대상 outside/secret.bin) 생성 후 cleanup | exit 1·`UNSAFE_PATH`, 링크 대상 secret.bin은 그대로 존재 | 코드, 대상 존재 | portal-ssh | test/windows-file-helper.tests.ps1:938 | D-0003(후보) |
| RC-B-924 | 같은 대상에 동시 publish는 정확히 1개만 성공하고 패자는 덮어쓰지 않음 | root와 bypass 디렉터리 각각(bypassRoot=false, true)에서 같은 race.bin 대상으로 서로 다른 id의 publish 2개를 동시에 실행 | 각 정책에서 성공(exit 0, published) 정확히 1건, 실패(exit 1, `DESTINATION_EXISTS`) 정확히 1건 | 성공 수 1, 실패 코드 수 1 | portal-ssh | test/windows-file-helper.tests.ps1:855, test/windows-file-helper.tests.ps1:856 | - |
| RC-B-925 | Windows 대상 실제 OpenSSH 서버 통합 CI 구성: 일회용 키·호스트 키 지문·서버 설정 검사·통합 시험 종료 코드 | 일회용 GitHub Windows 러너에서 ed25519 키 3개(client_key·wrong_key·host_key) 생성, 호스트 키와 오답 키의 SHA256 지문 계산, `sshd -t -f`(PubkeyAuthentication yes, PasswordAuthentication no, StrictModes yes, AllowTcpForwarding no 등) 설정 검사, SYSTEM 예약 작업으로 격리 sshd 기동 후 통합 시험 실행. (3.0은 `./gradlew` Windows CI 잡에서 동일 구성으로 Java 통합 시험 실행; 외부 sshd·ssh-keygen은 대상 OS 실제 서버가 필요하므로 대체 불가) | 각 단계 종료 코드 0. 지문은 `SHA256:` 형식으로 계산되어 호스트 키 pin·오답 pin 두 값 확보. sshd 설정 검사 통과 후 포트가 열려 통합 시험이 종료 코드 0으로 끝나고 마지막에 통과 메시지 출력(일회용 계정·작업은 정리) | 단계별 종료 코드, 지문 형식, 통합 시험 종료 코드 | packaging | test/windows-ssh-ci.ps1:171, test/windows-ssh-ci.ps1:180, test/windows-ssh-ci.ps1:184, test/windows-ssh-ci.ps1:327, test/windows-ssh-ci.ps1:386, test/windows-ssh-ci.ps1:390 | - |
| RC-B-926 | 배포 패키지 컨텍스트 준비: 기본은 현재 버전 아카이브, 명시 아카이브는 그대로, 없는 아카이브는 거부 | 인자 없이 컨텍스트 생성(기본), `dist/ssh-approval-portal-<현재 버전>.tar.gz`를 명시, 존재하지 않는 `missing-<guid>.tar.gz`를 명시 | 기본·명시 둘 다 컨텍스트의 candidate.tar.gz SHA-256이 현재 버전 아카이브 해시와 동일(기본이 다른 버전이면 `Default archive does not match the current version`, 명시가 바뀌면 `Explicit archive changed`). 없는 아카이브는 오류로 거부. (3.0은 현재 버전 설치 산출물을 기본으로 삼는 동일 규칙) | 해시 비교 2건, 없는 산출물 예외 | packaging | test/driver-common.test.ps1:17 | D-0042(후보) |
| RC-B-927 | 신규 설치(install, 사용자 지정 포트) 후 서비스가 정상 기동하고 SSH 왕복이 성공 | 빈 호스트에서 `install --admin-origin https://example.test --grant-sudo-all`, 설정을 사용자 지정 포트로 바꾸고(command automation·UI 활성) 서비스 재시작 | 서비스(`ssh-approval-bridge`) active, MCP 포트(설정에서 읽음)의 `/health`가 최대 30초 안에 성공. SSH 왕복 시험(승인→실행→결과) 성공. 지속 상태 capture 후 verify 통과(PASS 요약 문구의 INSTALL·CUSTOM PORTS·SSH ROUNDTRIP). (3.0은 Java install 명령, 시스템 서비스 등록) | health 응답, SSH 왕복 결과, 상태 verify | packaging | test/container-test.sh:102, test/portal-container-test.sh:106 | D-0014(후보) |
| RC-B-928 | 재설치(update 재실행)는 활성 릴리스·설정·키·sudo·unit·감사 기록을 보존 | 설치 완료 상태에서 update(재설치)를 다시 실행 | 활성 릴리스 링크(`approval-bridge`)가 이전과 동일 경로, 환경 파일 sha256 불변, 설정·키·sudo·unit·감사 보존 단언(delivery-fixture assert-preserved) 통과, 지속 상태 verify 통과, 서비스 enabled, 옛 `ssh-mcp.service` LoadState `not-found` | readlink 일치, 해시 일치, 보존 단언, systemctl 상태 | packaging | test/container-test.sh:102, test/portal-container-test.sh:106 | - |
| RC-B-929 | 이전 버전(baseline) 설치를 후보로 업그레이드해도 설정·사용자 unit 수정·상태를 보존(TEST_HAS_BASELINE=1) | baseline 릴리스 설치 후 unit에 `Environment=BRIDGE_DELIVERY_FIXTURE=preserved` 추가, 지속 상태 capture, 후보로 update | update 뒤 지속 상태 verify 통과, baseline 상태 보존 단언(assert-preserved) 통과, 업그레이드 백업 디렉터리 생성(latest_backup) | 보존 단언, 백업 존재, 상태 verify | packaging | test/container-test.sh:102, test/portal-container-test.sh:106 | - |
| RC-B-930 | rollback은 이전 활성 릴리스와 보존 상태로 되돌림 | baseline 경로: 업그레이드 백업으로 rollback 후 update. 비baseline: 재설치 백업으로 rollback | baseline 경로는 활성 릴리스가 baseline_active와 동일, 보존 단언(baseline-state)·상태 verify 통과, 이어서 update 성공. 비baseline은 rollback 뒤 candidate-state 보존 단언·상태 verify 통과 | readlink 일치, 보존 단언, 상태 verify | packaging | test/container-test.sh:102, test/portal-container-test.sh:106 | - |
| RC-B-931 | 시작에 실패하는 후보는 설치·갱신이 거부되고 기존 서비스·설정이 그대로 | 유효한 매니페스트를 갖지만 실제 기동에서 실패하는 후보(break-release)로 update(Docker 시험 중 `Broken candidate unexpectedly installed` 메시지) | update 종료 코드 0이 아님. 활성 릴리스 경로가 `active`와 동일, 환경 파일 sha256 불변, candidate-state 보존 단언·상태 verify 통과, 서비스 active, health 성공, 재시작 후에도 health 성공, delivery-runtime 점검 통과 | 종료 코드, readlink·해시, 서비스 active, health | packaging | test/container-test.sh:90, test/portal-container-test.sh:94, test/container-test.sh:102, test/portal-container-test.sh:106 | D-0047(후보) |
| RC-B-932 | 비 Cloudflare 로컬 HTTPS 설치 종단 검증: 토큰·소유자 승인·SSH·파일 기능 | `install --admin-origin https://approve.fixture.test:4443 --grant-sudo-all` 뒤 UI 활성 재시작(100×0.1초 안에 health 성공). 일회용 로컬 CA와 서버 인증서(SAN `approve.fixture.test`·`mcp.fixture.test`, serverAuth, 1일)를 만들어 HTTPS 시험 실행 후 `verify` | 서비스 health 성공. HTTPS 시험(`non-cloudflare-https.mjs`의 사례는 다른 묶음)과 `verify`가 모두 종료 코드 0이고 PASS 요약 `LOCAL NON-CLOUDFLARE HTTPS/TOKEN/OWNER APPROVAL/SSH/FILE CAPABILITIES`. (3.0은 Cloudflare 터널 없이 기기 등록 토큰으로 인증) | health, HTTPS 시험 종료 코드, verify 종료 코드 | packaging | test/non-cloudflare-container-test.sh:26 | - |
| RC-B-933 | 갱신 후보의 신뢰 기록 파일 속성 검사: 다른 사용자 읽기 가능·심볼릭 링크 거부 | 후보의 신뢰 기록(`trusted-images/<id>.sha256`)을 (a) 0644로 변경, (b) 원본을 옮기고 심볼릭 링크로 대체한 뒤 update 실행. 이후 복원 | 두 경우 update 종료 코드 0이 아님, 실행 중 인스턴스 ID가 변하지 않음 | 종료 코드, 인스턴스 동일 | packaging | test/compose-update-ci.sh:61, test/compose-update-ci.sh:67 | - |
| RC-B-934 | 신뢰 ID가 없는 후보 또는 현재 실행본은 갱신 거부 | (a) 신뢰 기록이 없는 후보 이미지(untrusted)로 update. (b) 현재 실행 이미지(baseline)의 신뢰 기록을 옮겨 둔 상태에서 update | 두 경우 종료 코드 0이 아님, 실행 중 인스턴스 불변(기록 복원 후에도) | 종료 코드, 인스턴스 동일 | packaging | test/compose-update-ci.sh:73, test/compose-update-ci.sh:92 | - |
| RC-B-935 | 갱신 복구 계약이 없는 구형 설치(legacy)는 update 거부 | 구형 커밋(`9644117a`)에서 빌드한 legacy 서비스가 실행 중인 상태에서 후보로 update | 종료 코드 0이 아님, 실행 중 인스턴스와 이미지 불변. (3.0은 2.x 설치를 update가 아닌 portal-migrate 이전 명령으로 처리, 거부 규칙은 유지) | 종료 코드, 인스턴스·이미지 동일 | packaging | test/compose-update-ci.sh:77 | - |
| RC-B-936 | 복구 파일 상위 디렉터리가 누구나 쓰기 가능(0777)하면 갱신 거부 | `/var/lib/ssh-mcp`를 0777로 변경 후 update, 이후 0755 복원 | 종료 코드 0이 아님, 인스턴스 불변 | 종료 코드, 인스턴스 동일 | packaging | test/compose-update-ci.sh:85 | - |
| RC-B-937 | 후보가 서비스 시작에 임의 코드를 주입(NODE_OPTIONS preload)하면 갱신 거부 | 후보 이미지에 `NODE_OPTIONS=--require=/tmp/injected.cjs`가 설정되고 신뢰 기록은 등록된 상태. PYTHONOPTIMIZE=1 환경으로 update. (3.0은 JAVA_TOOL_OPTIONS·JDK_JAVA_OPTIONS 같은 JVM 주입 옵션이 같은 규칙으로 거부, 추정) | 종료 코드 0이 아님, 인스턴스 불변, 주입 마커 파일 생성 안 됨(추정: 마커는 `injected-marker`) | 종료 코드, 인스턴스 동일 | packaging | test/compose-update-ci.sh:97 | - |
| RC-B-938 | 서비스 실행 계정(UID)이 설치 기록과 달라지면 갱신 거부 | 환경 파일 `BRIDGE_UID=10001`을 `10002`로 바꾸고 update(이후 복원) | 종료 코드 0이 아님, 인스턴스 불변 | 종료 코드, 인스턴스 동일 | packaging | test/compose-update-ci.sh:134 | - |
| RC-B-939 | 갱신 도중 7종 단계 실패는 maintenance 잠금과 복구 파일을 남기고 단계별 서비스 상태를 보고 | 실패 주입 failure ∈ {capture, start-before, start-after, release-before, release, release-restart, compare-restart}를 각각 baseline에서 실행. 요청 응답 유실 주입(maintenance release-verified 전후 등) 포함 | update 종료 코드 0이 아님. stderr에 `Maintenance recovery file: <경로>`가 있고 경로가 `/var/lib/ssh-mcp/.maintenance-owners/job.<영숫자>/owner` 형식이며 파일 존재. 서비스 health의 maintenance: capture·start-before는 인스턴스 동일·`true`, start-after는 새 인스턴스·`true`·환경 파일에 baseline 이미지, release-before·compare-restart는 새 인스턴스·`true`, release·release-restart는 새 인스턴스·`false` | 종료 코드, stderr 경로 정규식, 파일 존재, 인스턴스 ID, health.maintenance | packaging | test/compose-update-ci.sh:183 | D-0047(후보) |
| RC-B-940 | 복구 명령은 정규화되지 않은 owner 경로를 거부 | start-after 실패 상태에서 owner 경로를 `<dir>/../<dir 이름>/owner`로 바꿔 `--recover` 실행 | 종료 코드 0이 아님, 서비스 maintenance는 `true` 유지 | 종료 코드, health | packaging | test/compose-update-ci.sh:199 | D-0047(후보) |
| RC-B-941 | 복구 시 환경 파일이 승인 없이 바뀌었으면 거부 | (a) start-after 실패 뒤 환경 파일에 `# unapproved fixture change` 추가 후 `--recover`. (b) release·release-before·compare-restart 실패 뒤 후보 환경 파일에 같은 줄 추가 후 `--recover` | 모두 종료 코드 0이 아님. (a)는 maintenance `true` 유지. 환경 파일을 복원한 뒤에는 복구 가능 | 종료 코드, health | packaging | test/compose-update-ci.sh:202, test/compose-update-ci.sh:230 | D-0047(후보) |
| RC-B-942 | 확인된 복구가 끝나면 owner 파일과 maintenance가 정리되고 후보 이미지로 재기동 | start-after: 환경 복원 뒤 `--recover` 성공, 환경 파일에 candidate 이미지 ID, 재생성 인스턴스 이미지 == candidate, maintenance `false`. release 계열(release·release-before·compare-restart): 복원 뒤 `--recover` 성공 | owner 파일이 더 이상 존재하지 않음(`Owner retained after ...` 없음), maintenance `false`, 재생성 인스턴스 이미지 == candidate ID | owner 부재, health, 이미지 ID | packaging | test/compose-update-ci.sh:211, test/compose-update-ci.sh:234 | D-0047(후보) |
| RC-B-943 | 확인되지 않은 재시작 뒤에는 복구 거부, owner 유지 | release-restart 실패 후 서비스를 재생성(이미지 == candidate, maintenance false)한 뒤 `--recover` | 종료 코드 0이 아님, owner 파일 유지 | 종료 코드, owner 존재 | packaging | test/compose-update-ci.sh:220 | D-0047(후보) |
| RC-B-944 | 모호한 상태(start-before)의 복구는 거부, owner 유지 | start-before 실패 상태에서 `--recover` | 종료 코드 0이 아님, owner 파일 유지 | 종료 코드, owner 존재 | packaging | test/compose-update-ci.sh:242 | D-0047(후보) |
| RC-B-945 | 보존된 owner로 명시 복구: compare 뒤 release로 maintenance 해제 | capture·start-before(baseline 재생성)·start-after 외 release-before·compare-restart 실패 후 owner를 입력으로 maintenance compare, 이어서 release 실행(release 실패 유형은 제외) | compare 종료 코드 0(실패 시 디버그 출력 후 시험 실패), release 후 health maintenance `false`, 이후 owner·compose-intent 정리 | 종료 코드, health | packaging | test/compose-update-ci.sh:250 | D-0047(후보) |
| RC-B-946 | 동시 구성 변경은 감지해 maintenance를 유지하고 실패 | update 도중 환경 파일에 줄 추가(env-change 주입) | 종료 코드 0이 아님, stderr에 `Compose configuration changed; maintenance retained.`, 서비스 health maintenance `true` | 종료 코드, stderr 문구, health | packaging | test/compose-update-ci.sh:261, test/compose-update-ci.sh:265 | D-0047(후보) |
| RC-B-947 | 정상 갱신: 내구 이미지 교체·재시작 비교·release 성공 | 신뢰 기록·구성이 모두 정상인 후보로 update | 출력에 `"commandRequestsChecked":1`, 새 인스턴스 ID가 이전과 다름, 이미지 == candidate, 서비스 delivery-runtime 점검 통과, maintenance 해제 후 PASS 요약 `Actual Compose durable image replacement, restart comparison and release` | 출력 문자열, 인스턴스 ID, 이미지 ID | packaging | test/compose-update-ci.sh:270 | - |

## 3. 삭제 표

3.0에 옮기지 않는 원 시험이다. 사유는 「Node 런타임 고유」「Python helper 언어 고유 세부」「Windows helper 언어 고유 세부」「cloudflared 실행」「agentapi·codex queue CLI 깨우기」「vendor ssh-mcp/ssh2」「기존 install.sh·compose 셸 시험」 중 하나와 근거 한 줄이다. 삭제가 없는 묶음은 「없음」으로 적는다.

### G01 삭제

| 원 시험(파일:줄) | 사유 |
|---|---|
| 없음 | - |

### G02 삭제

| 원 시험(파일:줄) | 사유 |
|---|---|
| 없음 | - |

### G03 삭제

| 원 시험(파일:줄) | 사유 |
|---|---|
| test/operation-watch-cli.test.mjs:64 | `codex queue`·`agentapi` CLI 깨우기(hook만 남김): `--notify-codex` 옵트인 완료 알림이 종료 상태 뒤 1회 실행되고 알림 실패가 SSH 결과와 분리됨을 확인하나, 3.0은 호스트 깨우기를 hook으로만 한다 |
| test/operation-watch-cli.test.mjs:83 | `codex queue`·`agentapi` CLI 깨우기(hook만 남김): `--notify-codex`와 `--thread` 조합 검증(`INVALID_COMPLETION_TARGET`)을 확인하나, 해당 옵션 자체가 3.0에 없다 |
| test/portal-client-cloudflared.test.mjs:65 | cloudflared 실행(기기 등록 토큰으로 대체): `cloudflared access token --app=` 실행 인자·30초 제한·maxBuffer·shell 금지 등 cloudflared 호출 형태를 확인하며, 토큰 비노출 요구는 기기 등록 토큰 인증의 새 시험이 다룬다 |
| test/portal-client-cloudflared.test.mjs:106 | cloudflared 실행(기기 등록 토큰으로 대체): helper의 ETIMEDOUT·ENOENT·ENOBUFS를 `ACCESS_CREDENTIAL_TIMEOUT`·`CLOUDFLARED_NOT_FOUND`·`ACCESS_CREDENTIAL_TOO_LARGE`로 매핑하는 외부 helper 실패 처리를 확인하며 3.0에는 helper 프로세스가 없다 |
| test/portal-client-discovery.test.mjs:78 | cloudflared 실행(기기 등록 토큰으로 대체): cloudflared 실행 파일의 인자>환경 변수>PATH 탐색 우선순위(유니코드 경로 포함)를 확인하며 3.0에는 탐색 대상 실행 파일이 없다 |
| test/portal-client-discovery.test.mjs:90 | cloudflared 실행(기기 등록 토큰으로 대체): 잘못된 명시·환경 helper 경로가 PATH의 정상 helper로 조용히 대체되지 않음과 `INVALID_LOCAL_PATH`를 확인하며 3.0에는 helper 경로가 없다 |
| test/portal-client-discovery.test.mjs:111 | cloudflared 실행(기기 등록 토큰으로 대체): PATH에서 현재·상대 항목을 건너뛰고 정확한 플랫폼 실행 파일명만 받아들이는 cloudflared 탐색을 확인하며 3.0에 없다 |
| test/portal-client-discovery.test.mjs:137 | cloudflared 실행(기기 등록 토큰으로 대체): PATH 탐색의 디렉터리 수·문자 수 한도(`CLOUDFLARED_DISCOVERY_LIMIT`)를 확인하며 3.0에 PATH 탐색이 없다 |
| test/portal-client-discovery.test.mjs:147 | cloudflared 실행(기기 등록 토큰으로 대체): 캐시 자격 증명을 위해 `cloudflared access token`을 한 번만 비셸로 실행하는 호출 형태를 확인하며 3.0에 외부 프로세스 호출이 없다 |
| test/portal-client-discovery.test.mjs:164 | cloudflared 실행(기기 등록 토큰으로 대체): cloudflared 실행 실패(ENOENT·EACCES·EPERM·ETIMEDOUT·ENOBUFS)를 `CLOUDFLARED_*`·`ACCESS_CREDENTIAL_*` 코드로 구분하는 helper 오류 매핑을 확인하며 3.0에 없다. 값 형식 검증(`INVALID_ACCESS_CREDENTIAL`)도 아래 portal-client-cloudflared.test.mjs:120 행과 같이 기기 등록 토큰 인증의 새 시험이 다룬다 |
| test/portal-client-cloudflared.test.mjs:56 | 사용자 결정 5: 기기 등록 토큰으로 대체, cloudflared 제거 — PC 클라이언트가 Access 자격 증명(`--access-token-stdin`, 요청 헤더 `cf-access-token`)으로 `targets`를 호출하는 인증 흐름을 확인한다(메인 판정 2) |
| test/portal-client-cloudflared.test.mjs:120 | 사용자 결정 5: 기기 등록 토큰으로 대체, cloudflared 제거 — 캐시된 Access 자격 증명(JWT 형식)의 빈 값·형식 오류·과대 값을 `INVALID_ACCESS_CREDENTIAL`로 거절하는 검증이며 PC 클라이언트 Access 인증 흐름이다(메인 판정 2) |
| test/portal-client-discovery.test.mjs:178 | 사용자 결정 5: 기기 등록 토큰으로 대체, cloudflared 제거 — 휴대용 cloudflared helper(`executable` 단계)와 Access 자격 증명을 읽어 소유자 세션을 여는 PC 클라이언트 doctor ready 진단이다(메인 판정 5) |
| test/portal-client-discovery.test.mjs:198 | 사용자 결정 5: 기기 등록 토큰으로 대체, cloudflared 제거 — helper 미발견(`CLOUDFLARED_NOT_FOUND`)·Access 자격 증명 시간 초과·형식 오류(`INVALID_ACCESS_CREDENTIAL`)를 구분하는 doctor 시험이다(메인 판정 5) |
| test/portal-client-discovery.test.mjs:216 | 사용자 결정 5: 기기 등록 토큰으로 대체, cloudflared 제거 — Access 자격 증명으로 시작한 소유자 세션의 재인증·`ACCESS_MODE_REQUIRED` 실패를 구분하는 doctor 시험이다(메인 판정 5) |
| test/portal-client-discovery.test.mjs:247 | 사용자 결정 5: 기기 등록 토큰으로 대체, cloudflared 제거 — Access 자격 증명으로 발급한 임시 소유자 세션의 logout 결과가 unknown일 때 doctor가 ready가 되지 않음을 확인한다(메인 판정 5) |
| test/portal-client-discovery.test.mjs:262 | 사용자 결정 5: 기기 등록 토큰으로 대체, cloudflared 제거 — 환경 변수 `PORTAL_CLOUDFLARED`·PATH로 helper를 찾아 Access 자격 증명(`cf-access-token`)과 `/api/session/start` 세션으로 doctor를 실행하는 CLI 흐름이다(메인 판정 5) |
| test/portal-client-discovery.test.mjs:337 | 사용자 결정 5: 기기 등록 토큰으로 대체, cloudflared 제거 — Access 헤더로 `/api/session/start`를 호출해 받은 `__Host-ssh_admin_session` 쿠키의 logout·재연결 금지를 확인하는 PC 클라이언트 세션 흐름이다(메인 판정 5) |
| test/portal-client-discovery.test.mjs:353 | 사용자 결정 5: 기기 등록 토큰으로 대체, cloudflared 제거 — Access 세션 시작 응답 본문 오류 때 발급 쿠키를 정리하는 PC 클라이언트 doctor 시험이다(메인 판정 5) |
| test/portal-client-discovery.test.mjs:374 | 사용자 결정 5: 기기 등록 토큰으로 대체, cloudflared 제거 — Access 세션 쿠키 발급 뒤 logout 실패를 `OWNER_SESSION_CLEANUP_UNKNOWN`으로 보고하는 PC 클라이언트 doctor 시험이다(메인 판정 5) |
| test/portal-client-discovery.test.mjs:391 | 사용자 결정 5: 기기 등록 토큰으로 대체, cloudflared 제거 — Access 세션 시작 응답의 `Set-Cookie` 형식(누락·무관·Secure 누락·중복)을 검증하는 PC 클라이언트 쿠키 흐름이다(메인 판정 5) |

### G04 삭제

| 원 시험(파일:줄) | 사유 |
|---|---|
| test/portal-files-hook.test.mjs:108 | `codex queue`·`agentapi` CLI 깨우기(hook만 남김): H04는 wake 실행 파일이 unavailable/unknown/throw일 때 exit 1·`wake.state`·`automaticRetry=false`를 확인하는데, 3.0은 호스트 깨우기를 hook으로만 하므로 wake 실행 파일 호출 자체가 없다. 영수증 커밋 보존·공개 오류는 RC-B-319·RC-B-322·RC-B-325가 다룬다 |
| test/portal-files-hook.test.mjs:171 | `codex queue`·`agentapi` CLI 깨우기(hook만 남김): H10은 커밋 뒤 inbox close 실패 시 wake를 시도하지 않고 `wake={state:'unknown',reasonCode:'COMPLETION_INBOX_CLEANUP_UNKNOWN'}`를 반환하는지 확인하는데, 3.0에는 wake 시도 단계가 없다. 커밋 뒤 정리 실패 시 영수증 유지는 RC-B-322 계열(커밋 후 close 오류가 영수증을 지우지 않음)로 구현 담당이 보강할 수 있다 |
| test/portal-client.test.mjs:261 | 사용자 결정 5: 기기 등록 토큰으로 대체, cloudflared 제거 — PC 클라이언트 소유자 세션 시작에서 Access 이외 모드(`oidc`·`token`) 응답과 `/api/session/start`의 `__Host-ssh_admin_session` 쿠키 형식 검증을 확인하는 Access 세션 흐름이다(메인 판정 5) |
| test/python-source.test.mjs:39 | Python helper의 언어 고유 구현 세부: SOURCE-02는 맨 python(`-I -B -S -`)이 같은 유효 절단 접두를 그대로 실행함을 보여 회귀 메커니즘을 증명하는 시험으로, Python 인터프리터 동작 자체를 확인하며 Java 제품이 검증할 행동이 아니다. 절단 접두 거절 행동은 RC-B-348이 다룬다 |

### G05 삭제

| 원 시험(파일:줄) | 사유 |
|---|---|
| test/solid-architecture.test.mjs:46 | Node 런타임 고유(소스 구조 검사 도구): `.mjs` import 구문을 정규식으로 추출하는 파서 자체를 자체 시험하며(문자열·주석 속 `from` 무시, 정적·동적 import 구분) 3.0 Java에는 그 파서가 없음. 계층 의존 규칙 자체는 RC-B-438(ArchUnit)로 이식 |
| test/safety.test.mjs:139 | 메인 판정 D-18: feature-map Q6 A안 — 안전성 평가 연구 도구 삭제. 구 RC-B-420 |
| test/safety.test.mjs:153 | 메인 판정 D-18: feature-map Q6 A안 — 안전성 평가 연구 도구 삭제. 구 RC-B-420 |
| test/safety.test.mjs:161 | 메인 판정 D-18: feature-map Q6 A안 — 안전성 평가 연구 도구 삭제. 구 RC-B-421 |
| test/safety.test.mjs:184 | 메인 판정 D-18: feature-map Q6 A안 — 안전성 평가 연구 도구 삭제. 구 RC-B-423 |
| test/solid-architecture.test.mjs:70 | 메인 판정 D-18: feature-map Q11 — `file-source.mjs`는 3.0으로 옮기지 않는다(2.x에서도 쓰지 않는다). 구 RC-B-439 |
| test/retained-history.test.mjs:40 | 3단계 구현 판정(2026-11-12)으로 RC-B-393을 사례 표에서 옮겼다(stage3-design 11.3). 2.x의 메모리 이력과 장부 이력을 한 목록으로 합치며 중복을 제거하던 시험이다. 3.0은 저널이 하나라 합칠 출처가 없고, 기본 키가 같은 operation의 중복 행을 막는다. 대체: 저널 한 곳에서 한 operation을 한 번만 읽는 동작은 `JdbcHistoryQueryTest`(DisplayName RC-B-393, id로 한 operation의 메타데이터를 읽음)가 고정한다 |
| test/retained-history.test.mjs:110 | 3단계 구현 판정(2026-11-12)으로 RC-B-398을 사례 표에서 옮겼다. 2.x는 알 수 없는 상태값과 null 생성시각의 장부 항목을 읽을 때 걸러 내고 `coverage.metadataIncomplete`로 알렸다. 3.0은 상태를 enum과 CHECK 제약(`ck_operation_state`, `V1__operation_journal.sql`)으로 제한하므로 그런 행이 저장되지 않고, 손상된 행은 매퍼가 `IllegalStateException`으로 보고한다(조회 결과를 조용히 줄이지 않는다) |
| test/retained-history.test.mjs:133 | 3단계 구현 판정(2026-11-12)으로 RC-B-400을 사례 표에서 옮겼다. 2.x는 목록을 만든 뒤 반환할 20건의 본문만 지연해서 읽었다. 3.0은 `HistoryQuery.page`가 한 행에서 한 쪽 20건을 읽는다. 대체: 쪽 나누기(20·20·1, 같은 생성시각)는 RC-B-394(`HistoryServiceTest`)와 RC-A-028(`JdbcHistoryQueryTest`)이 고정한다 |
| test/retained-history.test.mjs:149 | 3단계 구현 판정(2026-11-12)으로 RC-B-401을 사례 표에서 옮겼다(두 원 시험 줄 :149·:167 모두). 2.x의 시험은 SQLite 장부 파일·휴면 장부 디렉터리를 조회 전후로 비교했다. 3.0의 대상은 H2·DBMS 표이고 이력 조회는 읽기 전용 트랜잭션(`@Transactional(readOnly = true)`)이다. 과도한 본문의 `HISTORY_ENTRY_TOO_LARGE`(본문 상한)는 RC-B-399(`HistoryServiceTest`)가 맡는다 |
| test/retained-history.test.mjs:167 | 위 :149와 같다(RC-B-401). 비활성(휴면)·부재 장부 파일이 3.0에 없다. 같은 사유로 사례 표에서 옮겼다 |

### G06 삭제

| 원 시험(파일:줄) | 사유 |
|---|---|
| test/ssh-supervisor.test.mjs:97 | vendor ssh-mcp/ssh2: ssh2 내부 `_protocol.signal`·Channel 내부 필드(type, server, outgoing.state)를 검사해 외부 채널이면 신호를 거절하는 ssh2 고유 어댑터 검증이며, 3.0은 MINA SSHD 채널 신호 API를 쓰므로 해당 내부 구조가 없다(취소 신호 전달 행동은 RC-B-484·RC-B-485로 이식). |
| test/ui-bundle.test.mjs:8 | Node 런타임 고유(esbuild 묶음): esbuild가 만든 ui/dist/card.html의 인라인 스크립트가 Node `--check`로 구문 검증되는지 확인하며, 3.0 portal-web은 esbuild 묶음 없이 정적 리소스를 서비스하므로 해당 산출물이 없다. |

### G07 삭제

| 원 시험(파일:줄) | 사유 |
|---|---|
| test/windows-agent-cli-helper.test.mjs:6 | 결정 D3-16으로 RC-B-541~549를 사례 표에서 옮겼다(3단계 설계 8.4절). Windows 에이전트 CLI helper 내부(PowerShell 스크립트의 상태 파일 원자 쓰기·환경 정리·영수증·잠금·정리 규칙): Q3로 원격 PowerShell helper를 폐지한다(feature-map `manage-agent-cli-windows.ps1` 삭제). RC-B-541의 「3.0도 고정 스크립트로 유지」는 Q3 판정 이전 문장이다. 대체 행동: S3-AG-01~10 |
| test/windows-agent-cli.test.mjs:16 | 결정 D3-16으로 RC-B-553을 옮겼다. 고정 PowerShell 설치 계획의 구조·변조 거부: 계획(스크립트 원문 생성) 자체가 3.0에 없고, 의도 digest·만료·revision 결속은 S2 `AgentCliIntent`가 닫았다. 대체 행동: S3-AG-01, S3-AG-10 |
| test/windows-agent-cli.test.mjs:24 | 결정 D3-16으로 RC-B-554를 옮겼다. 로그인 진단 PowerShell 계획: 3.0은 CLI를 실행하지 않고 자격 파일 `stat`만 본다(Q3). 대체 행동: S3-AG-07(8.4절의 S3-AG-01, S3-AG-10에 더해 이 줄에 맞는 사례) |
| test/windows-agent-cli.test.mjs:29 | 결정 D3-16으로 RC-B-555를 옮겼다. 모든 계획의 수신기 해시·시작 명령 8000자 상한 결속: 수신기 PowerShell 원문과 계획 digest가 3.0에 없다. 대체 행동: S3-AG-01, S3-AG-10 |
| test/windows-agent-cli.test.mjs:44 | 결정 D3-16으로 RC-B-556을 옮겼다. 응답 유실 뒤 읽기 전용 status 계획: 계획이 없어진다. 응답 유실 뒤 재설치 없이 상태만 묻는 행동은 대체 사례가 고정한다. 대체 행동: S3-AG-06(8.4절의 S3-AG-01, S3-AG-10에 더해 이 줄에 맞는 사례) |
| test/windows-agent-cli.test.mjs:53 | 결정 D3-16으로 RC-B-557을 옮겼다. 고정 PowerShell 계획이 낸 stdout JSON의 외부 실행 파일 경로 투영·stderr 비밀 거부: 그 JSON 계약이 3.0에 없다. 대체 행동: S3-AG-01, S3-AG-10 |

- 이 묶음의 나머지 원자료 행 50건은 행동이 3.0에도 필요하여 사례로 옮겼다. 일부 행에서 이식하지 않는 세부(RC-B-586의 helper 스크립트 경로 삽입 거부, RC-B-598·RC-B-603의 Python helper 65536바이트 상한)는 해당 사례의 본문에 사유를 적었다.

### G08 삭제

| 원 시험(파일:줄) | 사유 |
|---|---|
| test/test_agent_cli.py:166 | 결정 D3-16으로 RC-B-644를 옮겼다(3단계 설계 8.4절). Python 에이전트 CLI helper 내부: 하드링크된 잠금 파일 거절. 잠금 파일이 3.0에 없다(S2 저널이 대체). 대체 행동: S3-AG-02, S3-AG-09 |
| test/test_agent_cli.py:169 | 결정 D3-16으로 RC-B-645를 옮겼다. Python 에이전트 CLI helper 내부: 영수증 파일의 추가 필드·심볼릭 링크 거부. 영수증 파일이 3.0에 없다(S2 저널이 대체). 대체 행동: S3-AG-02, S3-AG-09 |
| test/test_agent_cli.py:175 | 보류(P3-6): RC-B-646(자식 프로세스 환경에 자격증명 비상속)을 옮기기로 했으나, npm 필요 여부는 시범 P3-6(CLI tarball)의 결과에 달렸다. npm을 쓰게 되면 사례 표로 되돌려 닫는다. 원문은 이 절 끝의 「보류 사례 원문」. 대체 행동: S3-AG-02, S3-AG-09 |
| test/test_agent_cli.py:180 | 보류(P3-6): RC-B-647(버전 조회 프로세스의 번들 런타임 PATH·비밀 제외). 같은 사유로 P3-6 결과가 나올 때까지 보류한다. 원문은 「보류 사례 원문」. 대체 행동: S3-AG-02, S3-AG-09 |
| test/test_agent_cli.py:189 | 보류(P3-6): RC-B-648(npm 설치 호출의 개별 빈 사설 설정 파일). npm 설치 방식이 유지될 때에 한정된 사례였으므로 P3-6 결과가 나올 때까지 보류한다. 원문은 「보류 사례 원문」. 대체 행동: S3-AG-02, S3-AG-09 |
| test/test_agent_cli.py:253 | 결정 D3-16으로 RC-B-657을 옮겼다. Python 에이전트 CLI helper 내부: 실제 프로세스 간 claim의 단일 승자. 프로세스 간 claim이 3.0에 없다(S2 저널이 대체). 대체 행동: S3-AG-02, S3-AG-09 |
| test/test_agent_cli.py:298 | Python helper 언어 고유 구현 세부: 설치 성공 뒤 `signal.setitimer(ITIMER_REAL)`·SIGALRM 핸들러가 원복되는지 확인. Java는 시그널 타이머를 쓰지 않으므로 대상 아님(마감 시한 행동 자체는 RC-B-659·660으로 이식) |
| test/test_agent_cli.py:301 | Python helper 언어 고유 구현 세부: 프로세스에 이미 걸린 ITIMER_REAL을 빼앗지 않고 `RUNTIME_TIMER_BUSY`로 거절. Java 구현에는 같은 프로세스 전역 타이머 충돌이 없음 |
| test/test_agent_cli.py:308 | 보류(P3-6): RC-B-661(npm 대기 중단 시 소유 프로세스 그룹만 종료·회수). npm 프로세스를 쓰는 경우에 한정된 사례이므로 P3-6 결과가 나올 때까지 보류한다. 원문은 「보류 사례 원문」. 대체 행동: S3-AG-02, S3-AG-09 |
| test/test_agent_cli_login.py:44 | 결정 D3-16으로 RC-B-672를 옮겼다(3단계 설계 8.4절). 로그인 확인 helper 내부(안전하지 않은 부모 권한 설명): 3.0은 CLI를 실행하지 않고 자격 파일 `stat`만 본다(Q3). 대체 행동: S3-AG-07 |
| test/test_agent_cli_login.py:58 | 결정 D3-16으로 RC-B-673을 옮겼다. 로그인 확인 helper 내부(실패 사유 한정·벤더 출력 비노출): CLI를 실행하지 않으므로 벤더 출력이 없다(Q3). 대체 행동: S3-AG-07 |
| test/test_agent_cli_login.py:73 | 결정 D3-16으로 RC-B-674를 옮겼다. 로그인 확인 helper 내부(고정 인자·환경): CLI를 실행하지 않는다(Q3). 대체 행동: S3-AG-07 |
| test/test_agent_cli_login.py:84 | 결정 D3-16으로 RC-B-675를 옮겼다. 로그인 확인 helper 내부(signed_out과 벤더 오류 구분): 자격 파일 있음·없음·미설치로 `signed_in`·`signed_out`·`not_installed`를 낸다(Q3). 대체 행동: S3-AG-07 |
| test/test_agent_cli_login.py:94 | 결정 D3-16으로 RC-B-676을 옮겼다. 로그인 확인 helper 내부(미설치·안전하지 않은 실행 파일): 실행 파일을 열지 않는다(Q3). 대체 행동: S3-AG-07 |
| test/test_agent_cli_login.py:102 | 결정 D3-16으로 RC-B-677을 옮겼다. 로그인 확인 helper 내부(관리 설치 메타데이터·해시 검증): 실행 파일 해시를 보지 않는다(Q3). 대체 행동: S3-AG-07 |
| test/test_agent_cli_login.py:148 | 결정 D3-16으로 RC-B-678을 옮겼다. 로그인 확인 helper 내부(대용량 관리 claude 검증): 실행 파일을 열지 않는다(Q3). 대체 행동: S3-AG-07 |
| test/test_agent_cli_login.py:161 | 결정 D3-16으로 RC-B-679를 옮겼다. 로그인 확인 helper 내부(관리 실행 파일 크기 상한): 실행 파일을 열지 않는다(Q3). 대체 행동: S3-AG-07 |
| test/test_agent_cli_login.py:170 | 결정 D3-16으로 RC-B-680을 옮겼다. 로그인 확인 helper 내부(stat 이후 증가하는 스트림 거절): 실행 파일을 열지 않는다(Q3). 대체 행동: S3-AG-07 |
| test/test_agent_cli_login.py:185 | 결정 D3-16으로 RC-B-681을 옮겼다. 로그인 확인 helper 내부(출력 상한·제한 시간·프로세스 회수): 실행하는 프로세스가 없다(Q3). 대체 행동: S3-AG-07 |
| test/test_agent_cli_login.py:193 | 결정 D3-16으로 RC-B-682를 옮겼다. 로그인 확인 helper 내부(main 출력은 벤더 오류·계정 필드를 내보내지 않음): 자격 파일 `stat` 결과만 돌려주며 벤더 오류가 없다(Q3). 대체 행동: S3-AG-07 |
| test/test_cloudflare_api_lifecycle.py:55 | Cloudflare API 프로비저닝: Cloudflare 목록 응답의 페이지 메타데이터 오류가 부재 증명이 되지 않는지 확인. 3.0은 Cloudflare API를 호출하지 않음(기기 등록 토큰 인증) |
| test/test_cloudflare_api_lifecycle.py:79 | Cloudflare API 프로비저닝: 두 번째 페이지 오류에서 삭제 의도를 불확정으로 보존. Cloudflare 리소스 정리 자체가 3.0에 없음 |
| test/test_cloudflare_api_lifecycle.py:114 | Cloudflare API 프로비저닝: 2페이지의 외부 Access 앱이 초기 정리 삭제를 막는지 확인. Cloudflare Access 앱 정리가 3.0에 없음 |
| test/test_cloudflare_api_lifecycle.py:130 | Cloudflare API 프로비저닝: 포털 탐색이 2페이지까지 읽은 뒤 생성·채택하는지 확인. Cloudflare MCP portal 프로비저닝이 3.0에 없음 |
| test/test_cloudflare_api_lifecycle.py:154 | Cloudflare API 프로비저닝: 2페이지에 남은 admin-access 대상을 삭제됨으로 보고하지 않는지 확인. Cloudflare 리소스 삭제 확인이 3.0에 없음 |
| test/test_cloudflare_api_lifecycle.py:177 | Cloudflare API 프로비저닝: 파생 앱이 없는 포털에 owner OAuth 앱 명시 생성. Cloudflare Access 앱 생성이 3.0에 없음 |
| test/test_cloudflare_api_lifecycle.py:191 | Cloudflare API 프로비저닝: 포털 생성 성공 신원이 탐색 실패 전에 저널에 남는지 확인. Cloudflare 저널·프로비저닝 자체가 3.0에 없음 |
| test/test_cloudflare_api_lifecycle.py:207 | Cloudflare API 프로비저닝: 쓰기 단계마다 실패해도 정리가 가능한지 확인. Cloudflare 리소스 계획이 3.0에 없음 |
| test/test_cloudflare_api_lifecycle.py:220 | Cloudflare API 프로비저닝: DELETE 응답 유실 시 종단 읽기 뒤 1회만 확정. Cloudflare 리소스 삭제가 3.0에 없음(결과 불명 재실행 금지 원칙은 다른 묶음 사례로 유지) |
| test/test_cloudflare_api_lifecycle.py:235 | Cloudflare API 프로비저닝: 종단 읽기 실패 시 원래 불확정 상태 보존. Cloudflare API 호출이 3.0에 없음 |
| test/test_cloudflare_api_lifecycle.py:271 | Cloudflare API 프로비저닝: 불확정 앱 생성 POST를 재생·삭제하지 않음. Cloudflare Access 앱 생성이 3.0에 없음 |
| test/test_cloudflare_api_lifecycle.py:291 | Cloudflare API 프로비저닝: 외부·중복 앱이 있으면 포털 탐색 거절. Cloudflare Access 앱이 3.0에 없음 |
| test/test_cloudflare_api_lifecycle.py:314 | Cloudflare API 프로비저닝: 터널 삭제 확정에 tombstone·빈 dedicated client 요구. Cloudflare Tunnel이 3.0에 없음(cloudflared 제거) |
| test/test_cloudflare_api_lifecycle.py:336 | Cloudflare API 프로비저닝: 새로 겹친 앱이 있으면 삭제 없이 정리 차단. Cloudflare Access 앱 정리가 3.0에 없음 |
| test/test_cloudflare_binary.py:30 | cloudflared 실행·Cloudflare 설정 CLI: `portal connect cloudflare` 옵션 전달·dry-run. 해당 CLI가 3.0에 없음 |
| test/test_cloudflare_binary.py:48 | cloudflared 설치기: 플랫폼·root·TTY 검사가 설치·비밀 입력보다 먼저인지 확인. cloudflared 설치가 3.0에 없음 |
| test/test_cloudflare_binary.py:63 | cloudflared 바이너리 다운로드: GitHub HTTPS 리다이렉트 허용 목록. cloudflared 바이너리 취득이 3.0에 없음(클라이언트 인증은 기기 등록 토큰) |
| test/test_cloudflare_binary.py:76 | cloudflared 바이너리 다운로드: 크기·시한·비밀 없는 요청·오류. cloudflared 바이너리 취득이 3.0에 없음 |
| test/test_cloudflare_binary.py:123 | cloudflared 설치기: 검증된 재사용·외부 파일 불변. cloudflared 설치가 3.0에 없음 |
| test/test_cloudflare_binary.py:133 | cloudflared 설치기: 같은 크기의 변조 산출물 미실행·미게시. cloudflared 설치가 3.0에 없음 |
| test/test_cloudflare_binary.py:142 | cloudflared 설치기: 부분 다운로드·버전 불일치 시 공개 파일 미생성. cloudflared 설치가 3.0에 없음 |
| test/test_cloudflare_binary.py:152 | cloudflared 설치기: 변경된 캐시 바이너리 미교체·미실행. cloudflared 설치가 3.0에 없음 |
| test/test_cloudflare_binary.py:160 | cloudflared 설치기: 외부 경로 링크·부모 mode 거절. cloudflared 설치가 3.0에 없음 |
| test/test_cloudflare_binary.py:189 | cloudflared 설치기: 동시 생성 파일 보존(배타 게시). cloudflared 설치가 3.0에 없음 |
| test/test_cloudflare_binary.py:200 | cloudflared 설치기: connector 인계와 선행 조건 실패 시 설치 전 중단. cloudflared connector가 3.0에 없음 |
| test/test_cloudflare_binary.py:216 | cloudflared 공식 고정 바이너리 설치·실행·재사용. cloudflared가 3.0에 없음 |
| test/test_cloudflare_connector.py:104 | cloudflared connector 로컬 준비 확인: `/health`·`/api/session` 공개, `/api/requests`는 401. connector 준비 검사가 3.0에 없음(관리자 API 인증 요구 행동은 관리자 API 사례가 맡음) |
| test/test_cloudflare_connector.py:122 | cloudflared connector systemd 자격증명 파일 ACL 판정. cloudflared systemd unit이 3.0에 없음 |
| test/test_cloudflare_connector.py:141 | cloudflared connector CLI 옵션 전달·dry-run. 해당 CLI가 3.0에 없음 |
| test/test_cloudflare_connector.py:159 | Cloudflare tunnel token의 account·tunnel·endpoint·형식 결속. Cloudflare Tunnel token이 3.0에 없음 |
| test/test_cloudflare_connector.py:172 | cloudflared connector: root·플랫폼 검사가 비밀 입력보다 먼저. connector가 3.0에 없음 |
| test/test_cloudflare_connector.py:182 | cloudflared systemd unit에 경로만 포함·토큰 로깅 비활성화. cloudflared systemd unit이 3.0에 없음(3.0 서비스 등록은 packaging 사례가 맡음) |
| test/test_cloudflare_connector.py:222 | cloudflared connector 로컬 loopback health·인증·사설 env 선행 조건. connector가 3.0에 없음 |
| test/test_cloudflare_connector.py:264 | cloudflared 생성 unit의 systemd 파서 통과. cloudflared unit이 3.0에 없음 |
| test/test_cloudflare_connector.py:275 | cloudflared connector의 DynamicUser 자격증명 읽기·자기 unit만 제거. cloudflared 서비스가 3.0에 없음 |
| test/test_cloudflare_connector.py:387 | cloudflared unit과 fixture mount 계약의 systemd 파서 일치. cloudflared unit이 3.0에 없음 |
| test/test_cloudflare_connector.py:401 | cloudflared connector 설치·제거·정리·재열기 시 외부 파일 보존. connector가 3.0에 없음 |
| test/test_cloudflare_connector.py:430 | cloudflared connector 내구 기록에 공개 필드만 저장. connector 기록이 3.0에 없음 |
| test/test_cloudflare_connector.py:447 | cloudflared connector 시작 결과 불명 시 재실행 금지·명시 제거. connector가 3.0에 없음 |
| test/test_cloudflare_connector.py:459 | Cloudflare 원격 정리가 edge 연결 전에도 차단. Cloudflare tunnel 정리가 3.0에 없음 |
| test/test_cloudflare_connector.py:467 | cloudflared dedicated 연결 읽기 실패 시 active 유지·재시작 안 함. connector 감시가 3.0에 없음 |
| test/test_cloudflare_connector.py:490 | cloudflared 로컬 active·edge pending·기록 실패 시 재시작 안 함. connector 감시가 3.0에 없음 |
| test/test_cloudflare_connector.py:517 | cloudflared unit·token·binary·drop-in이 바뀌면 손대지 않음. cloudflared 서비스가 3.0에 없음 |
| test/test_cloudflare_connector.py:542 | cloudflared connector 루트·경로 심볼릭 링크·잘못된 token·로컬 준비 미달 시 파일 생성 전 중단. connector가 3.0에 없음 |
| test/test_cloudflare_connector.py:572 | cloudflared connector 제거 실패·unlink 뒤 중단의 재개. connector가 3.0에 없음 |
| test/test_cloudflare_connector.py:585 | cloudflared connector 모호한 파일 생성을 채택·삭제하지 않음. connector가 3.0에 없음 |

### G09 삭제

| 원 시험(파일:줄) | 사유 |
|---|---|
| test/test_cloudflare_discovery.py:23 | cloudflared·Cloudflare API 프로비저닝: Cloudflare discovery CLI의 dry-run·루트 순서 확인. 3.0은 기기 등록 토큰 인증이라 discovery CLI 없음 |
| test/test_cloudflare_discovery.py:44 | cloudflared·Cloudflare API 프로비저닝: 잘못된 옵션 조합이 상태를 읽지 않음을 확인. discovery CLI 제거 |
| test/test_cloudflare_discovery.py:53 | cloudflared·Cloudflare API 프로비저닝: discovery CLI 출력 정화 확인. CLI 제거 |
| test/test_cloudflare_discovery.py:109 | cloudflared·Cloudflare API 프로비저닝: discovery 동기화 결과 영속화 확인. 해당 기능 제거 |
| test/test_cloudflare_discovery.py:127 | cloudflared·Cloudflare API 프로비저닝: 대기·오류·빈 capability를 로그인 성공으로 보지 않음. Cloudflare login 개념 제거 |
| test/test_cloudflare_discovery.py:135 | cloudflared·Cloudflare API 프로비저닝: Cloudflare 쓰기 모호 응답 시 재전송 금지. 쓰기 자체가 없어짐 |
| test/test_cloudflare_discovery.py:151 | cloudflared·Cloudflare API 프로비저닝: 확정 거절 기록·재전송 금지. 기능 제거 |
| test/test_cloudflare_discovery.py:162 | cloudflared·Cloudflare API 프로비저닝: 기존 claim·결과 파일 오류 시 sync 미전송. 기능 제거 |
| test/test_cloudflare_discovery.py:177 | cloudflared·Cloudflare API 프로비저닝: 원격 구성 drift·edge 단절 차단. cloudflared 제거 |
| test/test_cloudflare_discovery.py:188 | cloudflared·Cloudflare API 프로비저닝: 외부 portal env·connector 변경 차단. cloudflared 제거 |
| test/test_cloudflare_environment.py:31 | cloudflared·Cloudflare API 프로비저닝: Access 환경 연결 CLI 플래그·dry-run 확인. Cloudflare Access(BRIDGE_ACCESS_*) 연결 제거 |
| test/test_cloudflare_environment.py:48 | cloudflared·Cloudflare API 프로비저닝: restore CLI가 API 토큰 불필요함을 확인. 기능 제거 |
| test/test_cloudflare_environment.py:110 | cloudflared·Cloudflare API 프로비저닝: Access 값 연결·복원 및 connector 정리 차단. 일반 env 편집·백업 행동은 RC-B-726·RC-B-727로 이식 |
| test/test_cloudflare_environment.py:132 | cloudflared·Cloudflare API 프로비저닝: 이후 관리자 변경을 복원이 덮어쓰지 않음. 일반 낙관적 잠금은 RC-B-727 |
| test/test_cloudflare_environment.py:146 | cloudflared·Cloudflare API 프로비저닝: 불확실 apply 재전송 금지(Cloudflare 저널). 기능 제거 |
| test/test_cloudflare_environment.py:158 | cloudflared·Cloudflare API 프로비저닝: setup 경합 시 최신 env 보호. 일반 행동은 RC-B-732 |
| test/test_cloudflare_environment.py:165 | cloudflared·Cloudflare API 프로비저닝: 실패한 restore의 connector 정리 잠금. 기능 제거 |
| test/test_cloudflare_environment.py:179 | cloudflared·Cloudflare API 프로비저닝: 종료 코드 0이어도 기대 env 없으면 미연결. 기능 제거 |
| test/test_cloudflare_environment.py:188 | cloudflared·Cloudflare API 프로비저닝: Access 정책·audience 변경 시 transaction 미시작. 기능 제거 |
| test/test_cloudflare_environment.py:202 | cloudflared·Cloudflare API 프로비저닝: 활성 connector unit 변경 거절. cloudflared 제거 |
| test/test_cloudflare_environment.py:331 | cloudflared·Cloudflare API 프로비저닝: Access 설정 셸 helper의 link·restore. 일반 백업·0600 행동은 RC-B-726 |
| test/test_cloudflare_environment.py:344 | cloudflared·Cloudflare API 프로비저닝: Access reservation 거절 시 쓰기 전 중단. 일반 maintenance 예약은 RC-B-743 |
| test/test_cloudflare_environment.py:354 | cloudflared·Cloudflare API 프로비저닝: 재시작 실패 시 백업 복원. 일반 행동은 RC-B-737 |
| test/test_cloudflare_environment.py:363 | cloudflared·Cloudflare API 프로비저닝: reservation 중 소유자 편집 보존. 일반 행동은 RC-B-732·RC-B-738 |
| test/test_cloudflare_environment.py:372 | cloudflared·Cloudflare API 프로비저닝: 실패 재시작 중 소유자 편집 보존. 일반 행동은 RC-B-738 |
| test/test_cloudflare_environment.py:382 | cloudflared·Cloudflare API 프로비저닝: Access 인증 smoke 실패 시 원복. Access 제거 |
| test/test_cloudflare_environment.py:391 | cloudflared·Cloudflare API 프로비저닝: Access 셸 helper의 SIGTERM 복구. 셸 helper 제거 |
| test/test_cloudflare_provision.py:130 | cloudflared·Cloudflare API 프로비저닝: tunnel 응답의 public identity 보존. 기능 제거 |
| test/test_cloudflare_provision.py:146 | cloudflared·Cloudflare API 프로비저닝: tunnel 응답 충돌·미지 비밀 시 중단. 기능 제거 |
| test/test_cloudflare_provision.py:169 | cloudflared·Cloudflare API 프로비저닝: 타 POSIX 플랫폼 거절. 기능 제거 |
| test/test_cloudflare_provision.py:178 | cloudflared·Cloudflare API 프로비저닝: 추가 구성과 서버 metadata 구분. 기능 제거 |
| test/test_cloudflare_provision.py:197 | cloudflared·Cloudflare API 프로비저닝: 읽기 전용 metadata가 정리를 막지 않음. 기능 제거 |
| test/test_cloudflare_provision.py:208 | cloudflared·Cloudflare API 프로비저닝: resource id를 metadata로 무시하지 않음. 기능 제거 |
| test/test_cloudflare_provision.py:219 | cloudflared·Cloudflare API 프로비저닝: Access app 누락 시 모든 쓰기 중단. 기능 제거 |
| test/test_cloudflare_provision.py:230 | cloudflared·Cloudflare API 프로비저닝: portal 삭제 durable 기록 후 cleanup 재개. 기능 제거 |
| test/test_cloudflare_provision.py:247 | cloudflared·Cloudflare API 프로비저닝: 응답 비밀·bearer가 저널에 들어가지 않음. 저널 자체 제거(비밀 마스킹 일반 원칙은 redaction 사례 소관) |
| test/test_cloudflare_provision.py:252 | cloudflared·Cloudflare API 프로비저닝: Cloudflare 권한을 Cloudflare로만 전달. 기능 제거 |
| test/test_cloudflare_provision.py:261 | cloudflared·Cloudflare API 프로비저닝: HTTP 쓰기 메서드·불확실 실패 구분. 기능 제거 |
| test/test_cloudflare_provision.py:283 | cloudflared·Cloudflare API 프로비저닝: portal 정책 업데이트의 baseline 선택 금지. 기능 제거 |
| test/test_cloudflare_provision.py:293 | cloudflared·Cloudflare API 프로비저닝: 생성 후 명시적 cleanup이 외부 리소스 보존. 기능 제거 |
| test/test_cloudflare_provision.py:311 | cloudflared·Cloudflare API 프로비저닝: 쓰기 단계별 확정 실패 cleanup. 기능 제거 |
| test/test_cloudflare_provision.py:326 | cloudflared·Cloudflare API 프로비저닝: 불명 응답 재전송·자동 삭제 금지. 기능 제거 |
| test/test_cloudflare_provision.py:340 | cloudflared·Cloudflare API 프로비저닝: 원격 identity·tunnel 변경 시 cleanup 중단. 기능 제거 |
| test/test_cloudflare_provision.py:352 | cloudflared·Cloudflare API 프로비저닝: 모든 리소스 확인 후 삭제. 기능 제거 |
| test/test_cloudflare_provision.py:370 | cloudflared·Cloudflare API 프로비저닝: 충돌·잘못된 bearer 시 쓰기 금지. 기능 제거 |
| test/test_cloudflare_provision.py:380 | cloudflared·Cloudflare API 프로비저닝: 고정 endpoint 이탈 금지. 기능 제거 |
| test/test_cloudflare_provision.py:385 | cloudflared·Cloudflare API 프로비저닝: 기본 dry-run apply가 프롬프트·상태 생성 안 함. CLI 제거 |
| test/test_cloudflare_provision.py:395 | cloudflared·Cloudflare API 프로비저닝: mutating CLI 잘못된 조합·비TTY 쓰기 금지. CLI 제거 |
| test/test_cloudflare_provision.py:408 | cloudflared·Cloudflare API 프로비저닝: tunnel 자격증명 비영속·prefix 재개. 기능 제거 |
| test/test_cloudflare_provision.py:442 | cloudflared·Cloudflare API 프로비저닝: 저널 부모 fsync. Cloudflare 저널 제거 |
| test/test_cloudflare_provision.py:467 | cloudflared·Cloudflare API 프로비저닝: 부모 fsync 실패 시 원격 쓰기 전 중단. 기능 제거 |
| test/test_cloudflare_provision.py:483 | cloudflared·Cloudflare API 프로비저닝: 저장 계획·guard 재개 검증. 기능 제거 |
| test/test_cloudflare_provision.py:514 | cloudflared·Cloudflare API 프로비저닝: portal 삭제 마커 재개. 기능 제거 |
| test/test_cloudflare_provision.py:531 | cloudflared·Cloudflare API 프로비저닝: private atomic state·lock·crash intent(Cloudflare 저널 전용). 기능 제거 |
| test/test_cloudflare_provision.py:548 | cloudflared·Cloudflare API 프로비저닝: 저널 파일 symlink·hardlink·권한 거절. 일반 env 파일 안전은 RC-B-734 |
| test/test_cloudflare_setup.py:71 | cloudflared·Cloudflare API 프로비저닝: 신규 리소스만 계획. 기능 제거 |
| test/test_cloudflare_setup.py:87 | cloudflared·Cloudflare API 프로비저닝: 설정 파일의 추가 비밀·중복 JSON·대용량 거절. Cloudflare 설정 파일 제거 |
| test/test_cloudflare_setup.py:96 | cloudflared·Cloudflare API 프로비저닝: portal DNS 계획. 기능 제거 |
| test/test_cloudflare_setup.py:107 | cloudflared·Cloudflare API 프로비저닝: 서버 owner 정책 요구. 기능 제거 |
| test/test_cloudflare_setup.py:125 | cloudflared·Cloudflare API 프로비저닝: 고아 Access destination 충돌. 기능 제거 |
| test/test_cloudflare_setup.py:135 | cloudflared·Cloudflare API 프로비저닝: 잘못된 필드의 API path·DNS 주입 방지. 기능 제거 |
| test/test_cloudflare_setup.py:154 | cloudflared·Cloudflare API 프로비저닝: dry-run CLI의 프롬프트·네트워크 금지. CLI 제거 |
| test/test_cloudflare_setup.py:180 | cloudflared·Cloudflare API 프로비저닝: 비대화형 getpass echo 금지. CLI 제거 |
| test/test_cloudflare_setup.py:187 | cloudflared·Cloudflare API 프로비저닝: 대화형 setup 토큰 미요구. CLI 제거 |
| test/test_cloudflare_setup.py:194 | cloudflared·Cloudflare API 프로비저닝: getpass echo fallback 거절. CLI 제거 |
| test/test_cloudflare_setup.py:203 | cloudflared·Cloudflare API 프로비저닝: Cloudflare API 고정 HTTPS GET·헤더 토큰. 기능 제거 |
| test/test_cloudflare_setup.py:217 | cloudflared·Cloudflare API 프로비저닝: 오류·리다이렉트가 원격 내용을 노출하지 않음. 기능 제거 |
| test/test_cloudflare_setup.py:230 | cloudflared·Cloudflare API 프로비저닝: 리다이렉트로 Authorization 전달 금지. 기능 제거 |
| test/test_cloudflare_setup.py:255 | cloudflared·Cloudflare API 프로비저닝: 전체 페이지네이션 검사. 기능 제거 |
| test/test_cloudflare_setup.py:264 | cloudflared·Cloudflare API 프로비저닝: preflight scope 확인. 기능 제거 |
| test/test_cloudflare_setup.py:278 | cloudflared·Cloudflare API 프로비저닝: 충돌 명시·기존 리소스 불변. 기능 제거 |
| test/test_cloudflare_setup.py:291 | cloudflared·Cloudflare API 프로비저닝: 추가 Access host·공개 destination 누락 방지. 기능 제거 |
| test/test_cloudflare_setup.py:309 | cloudflared·Cloudflare API 프로비저닝: 미지원·잘못된 Access host 형태 ready 보고 금지. 기능 제거 |

### G10 삭제

| 원 시험(파일:줄) | 사유 |
|---|---|
| test/test_node_runtime.py:85 | Node 런타임 고유 동작: Node 공식 tar.xz의 vendor uid 무시와 npm 내부 링크 지원 확인. 3.0은 Node·npm을 쓰지 않음(root 소유 보장은 RC-B-828에서 이식) |
| test/test_node_runtime.py:213 | Node 런타임 고유 동작: Node v24.21.0 공식 아카이브의 고정 해시 설치와 `node --version` 실행 확인. 3.0에는 Node 런타임이 없음(체크섬·교체 복원 행동은 RC-B-829에서 이식) |
| test/test_package.py:156 | Windows 대상 helper 대체: 배포 매니페스트가 windows-file-helper.ps1·windows-file-native.cs·install-windows-helper.ps1을 필수로 요구하는지 확인. 3.0은 MINA SSHD SFTP로 대체해 해당 파일이 없음(경로·권한 행동은 portal-ssh 사례로 이식) |
| test/test_tunnel_connections.py:34 | cloudflared·Cloudflare API 프로비저닝: 터널 클라이언트 연결 목록의 빈 결과와 실제 연결 구분. 3.0 클라이언트 인증은 기기 등록 토큰이라 Cloudflare 터널이 없음 |
| test/test_tunnel_connections.py:40 | cloudflared·Cloudflare API 프로비저닝: 모든 페이지를 읽기 전에는 연결 없음으로 결정하지 않음 확인. Cloudflare 터널 API 전용 |
| test/test_tunnel_connections.py:45 | cloudflared·Cloudflare API 프로비저닝: 누락·불일치·중복·조기 빈 페이지는 unknown으로 처리하는 Cloudflare 응답 검증. 3.0에 없음 |
| test/test_tunnel_connections.py:58 | cloudflared·Cloudflare API 프로비저닝: Cloudflare 연결 조회 오류(403·404·500·TimeoutError)를 부재로 취급하지 않음 확인. 3.0에 없음 |
| test/test_tunnel_connections.py:62 | cloudflared·Cloudflare API 프로비저닝: Cloudflare 클라이언트·연결 UUID 형식 검증. 3.0에 없음 |
| test/test_tunnel_connections.py:67 | cloudflared·Cloudflare API 프로비저닝: result_info count 모순 시 빈 연결을 확정하지 않음. Cloudflare 응답 전용 |
| test/test_tunnel_connections.py:76 | cloudflared·Cloudflare API 프로비저닝: 전용 클라이언트가 연결 중이면 정리(cleanup)를 `TUNNEL_IN_USE`로 거부. Cloudflare 터널 정리 전용 |
| test/test_tunnel_connections.py:85 | cloudflared·Cloudflare API 프로비저닝: 터널 자원 검증에서 구 guard 연결은 일시적으로 보고 다른 변경은 `RESOURCE_CHANGED`로 거부. Cloudflare 터널 자원 전용 |
| test/test_tunnel_connections.py:97 | cloudflared·Cloudflare API 프로비저닝: 연결 조회 실패 시 정리가 삭제 요청을 보내지 않음. Cloudflare 터널 자원 삭제 전용 |

### G11 삭제

| 원 시험(파일:줄) | 사유 |
|---|---|
| test/windows-file-helper.tests.ps1:111 | 결정 D3-16으로 RC-B-902를 옮겼다(3단계 설계 8.4절). 새로 만든 대상 파일의 비공개 DACL(상속 차단·허용 주체 3종): SFTP로 DACL을 설정·검사할 수 없다(3단계 설계 4.4절 20·23·24번, 결정 D3-02 (a)). 대체 행동: S3-RW-05(문서화된 차이 시험), 릴리스 노트 「동작 변경」 |
| test/windows-file-helper.tests.ps1:116 | 결정 D3-16으로 RC-B-902를 옮겼다(위 :111과 같은 사례의 둘째 줄). 대체 행동: S3-RW-05, 릴리스 노트 |
| test/windows-file-helper.tests.ps1:318 | 결정 D3-16으로 RC-B-904를 옮겼다. 우회가 아닌 snapshot과 bypassRoot publish의 외부 소유자 정책 거절(`UNTRUSTED_OWNER`): 소유자·DACL 신뢰 검사를 3.0에서 내지 않는다(결정 D3-02 (a): 검사 대상이던 SYSTEM 설치 루트가 3.0에 없고, SFTP는 로그인 계정 권한으로 동작한다). 대체 행동: S3-RW-05, 릴리스 노트. D3-02에서 (b)를 고르면 닫는 쪽으로 되돌린다 |
| test/windows-file-helper.tests.ps1:323 | 결정 D3-16으로 RC-B-904를 옮겼다(:318과 같은 사례). 대체 행동: S3-RW-05, 릴리스 노트 |
| test/windows-file-helper.tests.ps1:324 | 결정 D3-16으로 RC-B-904를 옮겼다(:318과 같은 사례). 대체 행동: S3-RW-05, 릴리스 노트 |
| test/windows-file-helper.tests.ps1:332 | 결정 D3-16으로 RC-B-905를 옮겼다. stage·설치(보호) 루트의 외부 소유자 거절과 소유자 복원: 보호 루트(SYSTEM 설치 루트)가 3.0에 없다(결정 D3-02 (a)). 대체 행동: S3-RW-05, 릴리스 노트. D3-02에서 (b)를 고르면 닫는 쪽으로 되돌린다 |
| test/windows-file-helper.tests.ps1:334 | 결정 D3-16으로 RC-B-905를 옮겼다(:332와 같은 사례). 대체 행동: S3-RW-05, 릴리스 노트 |
| test/windows-file-helper.tests.ps1:339 | Windows 대상 helper: install-windows-helper.ps1이 외부 소유자 부모에서 설치를 거절하는지 확인. MINA SSHD SFTP로 대체되어 대상에 helper를 설치하지 않으므로 3.0에 없음(소유자 거절 행동은 RC-B-904·905로 이식) |
| test/windows-file-helper.tests.ps1:341 | Windows 대상 helper: 거절된 helper 설치가 보호 루트(new-files·new-helper·new-stage)를 만들지 않는지 확인. 대상에 helper를 설치하지 않으므로 3.0에 없음 |
| test/windows-file-helper.tests.ps1:424 | Windows 대상 helper: 메타데이터만 여는 부모 핸들 pin이 실제 이름 변경을 허용하는지 NtCreateFile·MoveFileEx P/Invoke로 OS 동작을 탐침. 핸들 pin 설계는 helper 구현 세부이며 SFTP에서는 핸들 공유 모드를 클라이언트가 지정할 수 없어 3.0에 없음(경합 안전 행동은 RC-B-908로 이식) |
| test/windows-file-helper.tests.ps1:425 | Windows 대상 helper: FILE_TRAVERSE 부모 pin이 이름 변경을 sharing violation(32)으로 막는지 OS 탐침. helper 핸들 pin 구현 세부로 3.0에 없음(RC-B-908로 행동 이식) |
| test/windows-file-helper.tests.ps1:426 | Windows 대상 helper: FILE_READ_DATA leaf pin이 이름 변경을 sharing violation(32)으로 막는지 OS 탐침. helper 핸들 pin 구현 세부로 3.0에 없음(RC-B-908로 행동 이식) |
| test/windows-file-helper.tests.ps1:561 | Windows 대상 helper: deny-only Administrators 제한 토큰이 helper의 권한 상승 요청(RequireAdministrator)을 거부하는지 확인. 3.0은 SSH 계정 권한으로만 SFTP를 수행하고 대상에서 권한 상승을 요청하지 않으므로 없음 |
| test/windows-file-helper.tests.ps1:567 | Windows 대상 helper: 시험 작업 루트의 보호 디렉터리 생성(CreatePrivateDirectory) 픽스처 확인. helper 네이티브 코드(windows-file-native.cs)와 함께 없어짐 |
| test/windows-file-helper.tests.ps1:575 | Windows 대상 helper: install-windows-helper.ps1의 신규 전용 설치 성공 확인. 대상에 helper를 설치하지 않으므로 3.0에 없음 |
| test/windows-file-helper.tests.ps1:580 | Windows 대상 helper: authorize(elevate) 요청으로 연결된 관리자 토큰을 확인. 3.0은 대상에서 권한 상승을 하지 않으므로 없음 |
| test/windows-file-helper.tests.ps1:581 | Windows 대상 helper: authorize 요청이 stage 파일을 만들지 않는지 확인. authorize 동작 자체가 3.0에 없음 |
| test/windows-file-helper.tests.ps1:583 | Windows 대상 helper: 기존 helper 설치를 DESTINATION_EXISTS로 보존하는지 확인. 대상에 helper를 설치하지 않으므로 3.0에 없음 |
| test/windows-file-helper.tests.ps1:595 | Windows 대상 helper: Users Modify 권한 조상 아래 helper 설치를 PERMISSION_DENIED로 거절하는지 확인. 대상에 helper를 설치하지 않으므로 3.0에 없음 |
| test/windows-file-helper.tests.ps1:596 | Windows 대상 helper: 설치기가 안전하지 않은 부모 ACL을 바꾸지 않는지 확인. 대상에 helper를 설치하지 않으므로 3.0에 없음(publish가 ACL을 고치지 않는 행동은 RC-B-909·912로 이식) |
| test/windows-file-helper.tests.ps1:597 | Windows 대상 helper: 안전하지 않은 조상에서 보호 루트가 만들어지지 않는지 확인. helper 설치가 3.0에 없음 |
| test/windows-file-helper.tests.ps1:608 | Windows 대상 helper: 속성 쓰기 가능 최종 부모 아래 helper 설치 거절 확인. helper 설치가 3.0에 없음 |
| test/windows-file-helper.tests.ps1:609 | Windows 대상 helper: 거절된 설치가 속성 쓰기 가능 빈 부모를 변경하지 않는지 확인. helper 설치가 3.0에 없음 |
| test/windows-file-helper.tests.ps1:630 | Windows 대상 helper: helper 프로세스의 stdin 요청 JSON이 EOF 전에는 publish를 시작하지 않는지 확인. stdin JSON 요청 프로토콜은 SFTP로 대체되어 3.0에 없음 |
| test/windows-file-helper.tests.ps1:634 | Windows 대상 helper: stdin EOF 뒤에만 publish가 완료되는지 확인. stdin JSON 프로토콜이 3.0에 없음 |
| test/windows-file-helper.tests.ps1:657 | 결정 D3-16으로 RC-B-914를 옮겼다. overwrite 때 대상의 DACL·소유자·시각 보존: SFTP로 DACL·소유자를 지정할 수 없어 덮어쓴 파일은 임시 파일의 속성을 가진다(4.4절 20·23·24번). 대체 행동: S3-RW-05(보존되지 않음을 시험이 명시적으로 단정), 릴리스 노트 |
| test/windows-file-helper.tests.ps1:658 | 결정 D3-16으로 RC-B-914를 옮겼다(:657과 같은 사례). 대체 행동: S3-RW-05, 릴리스 노트 |
| test/windows-file-helper.tests.ps1:659 | 결정 D3-16으로 RC-B-914를 옮겼다(:657과 같은 사례). 대체 행동: S3-RW-05, 릴리스 노트 |
| test/windows-file-helper.tests.ps1:678 | 결정 D3-16으로 RC-B-916을 옮겼다. overwrite가 대상의 명시·보호 DACL을 그대로 유지: SFTP로 DACL을 유지·지정할 수 없다. 대체 행동: S3-RW-05, 릴리스 노트 |
| test/windows-file-helper.tests.ps1:684 | 결정 D3-16으로 RC-B-916을 옮겼다(:678과 같은 사례). 대체 행동: S3-RW-05, 릴리스 노트 |
| test/windows-file-helper.tests.ps1:686 | 결정 D3-16으로 RC-B-917을 옮겼다. overwrite가 필수 무결성 레이블(low integrity)을 바꾸지 않음: SFTP로 레이블을 보존할 수 없다. 대체 행동: S3-RW-05, 릴리스 노트 |
| test/windows-file-helper.tests.ps1:688 | 결정 D3-16으로 RC-B-917을 옮겼다(:686과 같은 사례). 대체 행동: S3-RW-05, 릴리스 노트 |
| test/windows-file-helper.tests.ps1:690 | 결정 D3-16으로 RC-B-917을 옮겼다(:686과 같은 사례). 대체 행동: S3-RW-05, 릴리스 노트 |
| test/windows-file-helper.tests.ps1:692 | 결정 D3-16으로 RC-B-917을 옮겼다(:686과 같은 사례). 대체 행동: S3-RW-05, 릴리스 노트 |
| test/windows-file-helper.tests.ps1:887 | Windows 대상 helper: helper stdin 요청이 16385바이트이면 INVALID_REQUEST인 입력 한도 확인. stdin JSON 프로토콜 전용이라 3.0에 없음(요청 필드 검증은 RC-B-901로 이식) |
| test/windows-file-helper.tests.ps1:892 | Windows 대상 helper: 한도 경계 픽스처가 정확히 16384바이트인지 확인. stdin JSON 프로토콜 전용이라 3.0에 없음 |
| test/windows-file-helper.tests.ps1:893 | Windows 대상 helper: 정확히 16384바이트 요청이 EOF 뒤 수락되는지 확인. stdin JSON 프로토콜 전용이라 3.0에 없음 |
| test/windows-file-helper.tests.ps1:896 | Windows 대상 helper: 한도를 1바이트 넘는 요청을 거절하는지 확인. stdin JSON 프로토콜 전용이라 3.0에 없음 |
| test/windows-file-helper.tests.ps1:899 | Windows 대상 helper: JSON 뒤 후행 바이트(x)를 INVALID_REQUEST로 거절하는지 확인. stdin JSON 프로토콜 전용이라 3.0에 없음 |
| test/windows-file-helper.tests.ps1:902 | Windows 대상 helper: 잘못된 UTF-8 바이트(0xC3 0x28)를 JSON 파싱 전에 거절하는지 확인. stdin JSON 프로토콜 전용이라 3.0에 없음 |
| test/windows-file-helper.tests.ps1:906 | Windows 대상 helper: 한글 6000자 픽스처가 문자 수 한도와 바이트 한도를 구분하는지 확인. stdin JSON 프로토콜 전용이라 3.0에 없음 |
| test/windows-ssh-ci.ps1:382 | Node 런타임 고유: node --test로 windows-agent-cli-smoke.test.mjs(공식 CLI 설치 전용 시험)를 실행하는 CI 단계. 3.0에는 Node 시험 실행기가 없고, 그 시험의 행동은 해당 파일의 행(다른 묶음)에서 이식 |
| test/windows-ssh-ci.ps1:389 | Node 런타임 고유: 공식 CLI 설치 전용 시험(node --test) 통과 메시지 출력. 3.0에는 Node 시험이 없고 행동은 windows-agent-cli-smoke.test.mjs 행(다른 묶음)에서 이식 |
| test/compose-driver.sh:85 | 기존 compose 셸 시험: Docker compose의 compose-update.sh 미지원 거절을 확인. Docker compose 고유 동작이며 3.0 배포 산출물은 jlink·install 스크립트(거절 후 이미지·비밀·상태 불변 행동은 RC-B-931로 이식) |
| test/compose-driver.sh:90 | 기존 compose 셸 시험: Docker compose 기동·SSH 왕복·거절된 update 뒤 이미지·비밀·상태 불변 PASS 요약. Docker compose 고유(compose.yaml·docker secrets·볼륨 subpath)이며 3.0에 없음(SSH 왕복·상태 불변은 RC-B-927·931로 이식) |
| test/compose-update-ci.sh:110 | 기존 compose 셸 시험: 기존 컨테이너에 중첩 마운트가 추가되면 update 거절. 컨테이너 마운트 구성은 Docker compose 고유라 3.0에 없음 |
| test/compose-update-ci.sh:123 | 기존 compose 셸 시험: 컨테이너 루트 파일시스템이 쓰기 가능(read_only: false)이면 update 거절. 컨테이너 구성은 Docker compose 고유라 3.0에 없음 |
| test/compose-update-ci.sh:129 | 기존 compose 셸 시험: 지원되지 않는 Compose override(BRIDGE_COMPOSE_OVERRIDE) 거절. compose override 파일은 Docker compose 고유라 3.0에 없음 |
| test/container-test.sh:61 | Node 런타임 고유: ARM(aarch64) 픽스처에서 node --test --test-concurrency=1 실행기 선택 안내. 3.0 시험은 Gradle·JUnit이 실행하므로 없음 |
| test/portal-container-test.sh:65 | Node 런타임 고유: ARM(aarch64) 픽스처에서 node --test --test-concurrency=1 실행기 선택 안내. 3.0 시험은 Gradle·JUnit이 실행하므로 없음 |
| test/non-cloudflare-container-test.sh:3 | 기존 셸 시험: 격리된 root Docker 픽스처에서만 실행되도록 막는 환경 가드(`id -u`==0, container==docker). 셸·Docker 고유 구성이며 3.0은 CI 잡 격리로 대체 |
| test/ssh-recovery-red.sh:23 | 기존 셸 시험 + Node 런타임 고유: 수정 전 커밋(2ccec18a)의 Node 소스에 node --test를 실행해 3개 회귀 시험(ssh-connection-lifecycle·command-output-accounting·execution-failure)이 AssertionError로 실패함을 확인하는 red 검증 하네스. 3.0에는 수정 전 Node 소스가 없고 세 시험의 행동은 해당 파일 행(다른 묶음)에서 이식 |

### 보류 사례 원문 (결정 D3-16, 시범 P3-6)

RC-B-646·RC-B-647·RC-B-648·RC-B-661은 시범 P3-6(CLI tarball: npm을 쓰는지)의 결과가 나올 때까지 보류한다. 위 G08 삭제 표의 해당 줄(test_agent_cli.py:175·:180·:189·:308)이 이 사례들이다. P3-6 결과 npm 프로세스를 쓰게 되면 아래 행을 G08 사례 표로 되돌려 닫는 쪽으로 바꾸고 대응표·수량표를 다시 맞춘다. 되돌릴 때 원문을 잃지 않도록 옮기기 전 행을 그대로 둔다(사례 ID 칸 앞의 「보류」는 사례 표 행 수 집계에서 빼려는 표시이며, 되돌릴 때 지운다).

| 사례 ID | 대상 기능 | 입력·조건 | 기대 결과 | 판정 방법 | 3.0 모듈 | 원 시험 | 연결 결함 |
|---|---|---|---|---|---|---|---|
| 보류 RC-B-646 | 자식 프로세스 환경에 자격증명 비상속 | 호스트 환경에 `JEV_API_KEY`·`OPENAI_API_KEY`·`NPM_TOKEN`·`NODE_OPTIONS`가 있을 때 자식 환경 생성 후 설치 | 자식 환경 키 집합이 정확히 `{LANG,LC_ALL,PATH,HOME,CODEX_HOME,CLAUDE_CONFIG_DIR,DISABLE_UPDATES}`, 합성 비밀 문자열이 환경에 없음, 설치 성공 | 키 집합 동치, 비밀 부재 | portal-ssh·portal-app | test/test_agent_cli.py:175 | - |
| 보류 RC-B-647 | 버전 조회 프로세스: 번들 런타임 PATH·비밀 제외 | `OPENAI_API_KEY` 설정 상태에서 `<home>/codex` 버전 조회(출력 `codex-cli 1.2.3`) | 버전 `1.2.3`, 자식 PATH 항목에 `/opt/ssh-approval/node/bin` 포함, 자식 환경에 합성 비밀 없음 (3.0에서 번들 런타임 경로가 달라지면 경로만 대응 값으로 바꾼다) | 반환 버전, 캡처한 env | portal-ssh·portal-app | test/test_agent_cli.py:180 | - |
| 보류 RC-B-648 | npm 설치 호출의 개별 빈 사설 설정 파일 | work 디렉터리에서 패키지 설치 실행 | 인자에 `--userconfig`·`--globalconfig` 경로가 서로 다르고 둘 다 work 디렉터리 직속, 내용 빈 바이트, mode 0o600, 심볼릭 링크 아님. 자식 env에 `NPM_TOKEN`·`NODE_OPTIONS` 없음. 호출 1회. (npm으로 설치하는 방식을 3.0에서 유지할 때에 한정; 방식이 바뀌면 사용자·전역 설정 격리 요건으로 대체) | 캡처한 인자·env, 파일 바이트·mode | portal-ssh·portal-app | test/test_agent_cli.py:189 | - |
| 보류 RC-B-661 | npm 대기 중단 시 소유 프로세스 그룹만 종료·회수 | npm 대기가 `synthetic-wait-interruption` 예외로 중단 | 예외가 그대로 전파, 자식 1개가 종료(poll이 None 아님), 종료 신호는 해당 자식 그룹에 SIGKILL 단 1회 | 예외 메시지, 신호 기록, 자식 종료 | portal-ssh·portal-app | test/test_agent_cli.py:308 | - |

## 4. 대응표

B범위 원자료 모든 행(파일:줄)을 사례 ID 또는 「삭제」(또는 읽지 못한 경우 「미확인」)로 대응한다. 묶음당 원자료 행 1개 = 표 1행이다.

### G01 대응

| 원 시험(파일:줄) | 사례 ID·삭제 |
|---|---|
| test/maintenance-client.test.mjs:11 | RC-B-001, RC-B-002 |
| test/maintenance-client.test.mjs:55 | RC-B-003 |
| test/maintenance-durable.test.mjs:21 | RC-B-004 |
| test/maintenance-durable.test.mjs:39 | RC-B-005, RC-B-006, RC-B-007 |
| test/maintenance-durable.test.mjs:88 | RC-B-008 |
| test/maintenance.test.mjs:8 | RC-B-009, RC-B-010 |
| test/mcp-contracts.test.mjs:54 | RC-B-011 |
| test/mcp-contracts.test.mjs:73 | RC-B-012 |
| test/mcp-contracts.test.mjs:83 | RC-B-013, RC-B-032 |
| test/mcp-contracts.test.mjs:98 | RC-B-014, RC-B-015 |
| test/mcp-contracts.test.mjs:134 | RC-B-016 |
| test/mcp-contracts.test.mjs:149 | RC-B-017 |
| test/mcp-contracts.test.mjs:165 | RC-B-018, RC-B-019 |
| test/mcp-contracts.test.mjs:188 | RC-B-020 |
| test/mcp-contracts.test.mjs:222 | RC-B-021 |
| test/mcp-contracts.test.mjs:238 | RC-B-022 |
| test/mcp-contracts.test.mjs:253 | RC-B-023 |
| test/mcp-contracts.test.mjs:268 | RC-B-024 |
| test/mcp-contracts.test.mjs:278 | RC-B-025 |
| test/mcp-contracts.test.mjs:292 | RC-B-026 |
| test/mcp-contracts.test.mjs:310 | RC-B-027 |
| test/mcp-contracts.test.mjs:319 | RC-B-028 |
| test/mcp-contracts.test.mjs:337 | RC-B-029 |
| test/mcp-contracts.test.mjs:349 | RC-B-030 |
| test/mcp-contracts.test.mjs:362 | RC-B-031 |
| test/mcp-contracts.test.mjs:381 | RC-B-032 |
| test/mcp-input-limits.test.mjs:61 | RC-B-033 |
| test/mcp-input-limits.test.mjs:79 | RC-B-034, RC-B-035 |
| test/mcp-input-limits.test.mjs:110 | RC-B-036, RC-B-037 |
| test/mcp180-bytes.test.mjs:26 | RC-B-038 |
| test/mcp180-bytes.test.mjs:45 | RC-B-039 |
| test/mcp180-bytes.test.mjs:58 | RC-B-040 |
| test/mcp180-bytes.test.mjs:67 | RC-B-041 |
| test/mcp180-bytes.test.mjs:83 | RC-B-042, RC-B-043 |
| test/mcp180-bytes.test.mjs:134 | RC-B-044 |
| test/model-selection.test.mjs:8 | RC-B-045 |
| test/model-selection.test.mjs:16 | RC-B-046 |
| test/model-selection.test.mjs:21 | RC-B-047 |
| test/model-selection.test.mjs:31 | RC-B-048 |
| test/multi-admin.test.mjs:34 | RC-B-049, RC-B-050 |
| test/multi-admin.test.mjs:63 | RC-B-051 |
| test/multi-admin.test.mjs:73 | RC-B-052 |
| test/multi-admin.test.mjs:83 | RC-B-053 |
| test/multi-target-config.test.mjs:10 | RC-B-054, RC-B-055 |
| test/multi-target-config.test.mjs:28 | RC-B-056 |
| test/multi-target-ssh.test.mjs:36 | RC-B-057, RC-B-058 |
| test/multi-target.test.mjs:49 | RC-B-059, RC-B-060, RC-B-061 |
| test/multi-target.test.mjs:72 | RC-B-062, RC-B-063 |
| test/multi-target.test.mjs:107 | RC-B-064 |
| test/multi-target.test.mjs:129 | RC-B-065, RC-B-066, RC-B-067 |
| test/multi-target.test.mjs:155 | RC-B-068 |
| test/multi-target.test.mjs:169 | RC-B-069, RC-B-070, RC-B-071 |
| test/multiline-commands.test.mjs:44 | RC-B-072 |
| test/multiline-commands.test.mjs:56 | RC-B-073 |
| test/multiline-commands.test.mjs:69 | RC-B-074 |
| test/multiline-commands.test.mjs:99 | RC-B-075 |
| test/multiline-commands.test.mjs:149 | RC-B-076 |
| test/multiline-commands.test.mjs:182 | RC-B-075 |
| test/multiline-commands.test.mjs:191 | RC-B-077 |
| test/native-install-paths.test.mjs:15 | RC-B-078 |
| test/native-install-paths.test.mjs:24 | RC-B-079 |
| test/native-install-paths.test.mjs:58 | RC-B-080 |
| test/native-install-paths.test.mjs:66 | RC-B-081 |
| test/native-install-paths.test.mjs:73 | RC-B-080 |
| test/native-install-paths.test.mjs:79 | RC-B-081 |
| test/native-install-paths.test.mjs:85 | RC-B-081 |
| test/offline-preservation.test.mjs:19 | RC-B-082 |
| test/offline-preservation.test.mjs:37 | RC-B-084 |
| test/offline-preservation.test.mjs:46 | RC-B-083 |
| test/offline-preservation.test.mjs:59 | RC-B-084 |
| test/oidc-access.test.mjs:12 | RC-B-085 |
| test/oidc-access.test.mjs:19 | RC-B-086 |
| test/oidc-access.test.mjs:30 | RC-B-087 |
| test/oidc-access.test.mjs:37 | RC-B-088 |
| test/oidc-access.test.mjs:44 | RC-B-087 |

### G02 대응

| 원 시험(파일:줄) | 사례 ID·삭제 |
|---|---|
| test/opaque-artifacts.test.mjs:19 | RC-B-091 |
| test/opaque-artifacts.test.mjs:33 | RC-B-092 |
| test/opaque-artifacts.test.mjs:45 | RC-B-093 |
| test/opaque-artifacts.test.mjs:66 | RC-B-094 |
| test/opaque-artifacts.test.mjs:83 | RC-B-095 |
| test/opaque-file-api.test.mjs:31 | RC-B-096 |
| test/opaque-file-api.test.mjs:53 | RC-B-097 |
| test/opaque-file-api.test.mjs:67 | RC-B-099 |
| test/opaque-file-api.test.mjs:79 | RC-B-100 |
| test/opaque-file-api.test.mjs:95 | RC-B-101, RC-B-102 |
| test/opaque-file-api.test.mjs:137 | RC-B-103 |
| test/opaque-file-api.test.mjs:152 | RC-B-104 |
| test/opaque-files-application.test.mjs:48 | RC-B-105 |
| test/opaque-files-application.test.mjs:81 | RC-B-098 |
| test/opaque-files-client.test.mjs:71 | RC-B-106 |
| test/opaque-files-client.test.mjs:96 | RC-B-107 |
| test/opaque-files-client.test.mjs:104 | RC-B-108 |
| test/opaque-files-client.test.mjs:111 | RC-B-109 |
| test/opaque-files-client.test.mjs:126 | RC-B-110 |
| test/opaque-files-client.test.mjs:136 | RC-B-111 |
| test/opaque-files-client.test.mjs:145 | RC-B-112 |
| test/opaque-files-client.test.mjs:152 | RC-B-113 |
| test/opaque-files-client.test.mjs:165 | RC-B-114 |
| test/opaque-files-client.test.mjs:182 | RC-B-115 |
| test/opaque-files-client.test.mjs:188 | RC-B-116 |
| test/opaque-files-client.test.mjs:195 | RC-B-117 |
| test/opaque-files-client.test.mjs:202 | RC-B-118 |
| test/opaque-files-client.test.mjs:208 | RC-B-119 |
| test/opaque-files-client.test.mjs:214 | RC-B-120 |
| test/opaque-files-client.test.mjs:221 | RC-B-121 |
| test/opaque-files-client.test.mjs:227 | RC-B-122 |
| test/opaque-files-client.test.mjs:233 | RC-B-123 |
| test/opaque-files-client.test.mjs:240 | RC-B-124 |
| test/opaque-files-client.test.mjs:250 | RC-B-125 |
| test/opaque-files-client.test.mjs:262 | RC-B-126 |
| test/opaque-files-client.test.mjs:272 | RC-B-127 |
| test/opaque-files-client.test.mjs:277 | RC-B-128 |
| test/opaque-files.test.mjs:53 | RC-B-129 |
| test/opaque-files.test.mjs:69 | RC-B-130 |
| test/opaque-files.test.mjs:90 | RC-B-131 |
| test/opaque-files.test.mjs:98 | RC-B-132 |
| test/opaque-files.test.mjs:117 | RC-B-133 |
| test/opaque-files.test.mjs:138 | RC-B-134 |
| test/opaque-files.test.mjs:179 | RC-B-135 |
| test/opaque-files.test.mjs:195 | RC-B-136 |
| test/opaque-files.test.mjs:206 | RC-B-137 |
| test/opaque-files.test.mjs:216 | RC-B-138 |
| test/operation-migration-180.test.mjs:32 | RC-B-139 |
| test/operation-migration-180.test.mjs:57 | RC-B-140 |
| test/operation-migration-180.test.mjs:72 | RC-B-141 |
| test/operation-migration-180.test.mjs:82 | RC-B-142 |
| test/operation-migration-180.test.mjs:135 | RC-B-143 |
| test/operation-migration-180.test.mjs:150 | RC-B-144 |
| test/operation-migration-180.test.mjs:161 | RC-B-145 |
| test/operation-migration-180.test.mjs:181 | RC-B-146 |
| test/operation-migration-180.test.mjs:194 | RC-B-146 |
| test/operation-migration-180.test.mjs:211 | RC-B-147 |
| test/operation-migration-180.test.mjs:230 | RC-B-147 |
| test/operation-migration-batch.test.mjs:27 | RC-B-148 |
| test/operation-migration-batch.test.mjs:60 | RC-B-149 |
| test/operation-migration-batch.test.mjs:89 | RC-B-150 |
| test/operation-migration-batch.test.mjs:107 | RC-B-151 |
| test/operation-migration-batch.test.mjs:134 | RC-B-152 |
| test/operation-migration-preflight.test.mjs:51 | RC-B-153 |
| test/operation-migration-preflight.test.mjs:61 | RC-B-154 |
| test/operation-migration-preflight.test.mjs:70 | RC-B-155 |
| test/operation-migration-preflight.test.mjs:82 | RC-B-156 |
| test/operation-migration-preflight.test.mjs:105 | RC-B-157 |
| test/operation-migration-preflight.test.mjs:125 | RC-B-158 |
| test/operation-migration-retained-budget.test.mjs:19 | RC-B-159 |
| test/operation-migration-retained-budget.test.mjs:38 | RC-B-160 |
| test/operation-migration-retained-budget.test.mjs:56 | RC-B-161 |
| test/operation-migration-retained-budget.test.mjs:70 | RC-B-162 |
| test/operation-migration-retained-budget.test.mjs:89 | RC-B-163 |

### G03 대응

| 원 시험(파일:줄) | 사례 ID·삭제 |
|---|---|
| test/operation-observer-http.test.mjs:42 | RC-B-181 |
| test/operation-observer-http.test.mjs:54 | RC-B-182 |
| test/operation-observer-http.test.mjs:66 | RC-B-183 |
| test/operation-observer-http.test.mjs:80 | RC-B-184 |
| test/operation-observer-http.test.mjs:90 | RC-B-185 |
| test/operation-scheduler.test.mjs:26 | RC-B-186 |
| test/operation-scheduler.test.mjs:35 | RC-B-187 |
| test/operation-scheduler.test.mjs:43 | RC-B-188 |
| test/operation-scheduler.test.mjs:54 | RC-B-189 |
| test/operation-scheduler.test.mjs:83 | RC-B-190 |
| test/operation-scheduler.test.mjs:102 | RC-B-191 |
| test/operation-scheduler.test.mjs:117 | RC-B-192 |
| test/operation-scheduler.test.mjs:129 | RC-B-193 |
| test/operation-scheduler.test.mjs:139 | RC-B-194 |
| test/operation-scheduler.test.mjs:146 | RC-B-195 |
| test/operation-scheduler.test.mjs:154 | RC-B-196 |
| test/operation-scheduler.test.mjs:163 | RC-B-197 |
| test/operation-scheduler.test.mjs:172 | RC-B-198 |
| test/operation-scheduler.test.mjs:183 | RC-B-199 |
| test/operation-scheduler.test.mjs:190 | RC-B-200 |
| test/operation-store.test.mjs:18 | RC-B-201 |
| test/operation-store.test.mjs:30 | RC-B-202 |
| test/operation-store.test.mjs:44 | RC-B-203 |
| test/operation-store.test.mjs:59 | RC-B-204 |
| test/operation-store.test.mjs:69 | RC-B-205 |
| test/operation-store.test.mjs:82 | RC-B-206 |
| test/operation-store.test.mjs:93 | RC-B-207 |
| test/operation-watch-cli.test.mjs:10 | RC-B-208 |
| test/operation-watch-cli.test.mjs:17 | RC-B-209 |
| test/operation-watch-cli.test.mjs:37 | RC-B-210 |
| test/operation-watch-cli.test.mjs:46 | RC-B-211 |
| test/operation-watch-cli.test.mjs:55 | RC-B-212 |
| test/operation-watch-cli.test.mjs:64 | 삭제 |
| test/operation-watch-cli.test.mjs:83 | 삭제 |
| test/operation-watch-cli.test.mjs:98 | RC-B-213 |
| test/operation-watch-cli.test.mjs:110 | RC-B-214 |
| test/operation-watch-cli.test.mjs:122 | RC-B-215 |
| test/operation-watch-cli.test.mjs:130 | RC-B-216 |
| test/operation-watcher.test.mjs:66 | RC-B-217 |
| test/operation-watcher.test.mjs:78 | RC-B-218 |
| test/operation-watcher.test.mjs:94 | RC-B-219 |
| test/operation-watcher.test.mjs:106 | RC-B-220 |
| test/operation-watcher.test.mjs:121 | RC-B-221 |
| test/operation-watcher.test.mjs:129 | RC-B-222 |
| test/operation-watcher.test.mjs:140 | RC-B-223 |
| test/operation-watcher.test.mjs:149 | RC-B-224 |
| test/operation-watcher.test.mjs:158 | RC-B-225 |
| test/operation-watcher.test.mjs:174 | RC-B-226 |
| test/operation-watcher.test.mjs:183 | RC-B-227 |
| test/operation-watcher.test.mjs:192 | RC-B-228 |
| test/operation-watcher.test.mjs:201 | RC-B-229 |
| test/operation-watcher.test.mjs:210 | RC-B-230 |
| test/operation-watcher.test.mjs:220 | RC-B-231 |
| test/operation-watcher.test.mjs:227 | RC-B-232 |
| test/operations-180.test.mjs:66 | RC-B-233 |
| test/operations-180.test.mjs:77 | RC-B-234 |
| test/operations-180.test.mjs:88 | RC-B-235 |
| test/operations-180.test.mjs:98 | RC-B-236 |
| test/operations-180.test.mjs:110 | RC-B-237 |
| test/operations-180.test.mjs:128 | RC-B-238 |
| test/operations-180.test.mjs:137 | RC-B-239 |
| test/operations-180.test.mjs:145 | RC-B-240 |
| test/operations-180.test.mjs:159 | RC-B-241 |
| test/operations-180.test.mjs:169 | RC-B-242 |
| test/portal-client-bound-files.test.mjs:35 | RC-B-243 |
| test/portal-client-bound-files.test.mjs:41 | RC-B-244 |
| test/portal-client-bound-files.test.mjs:46 | RC-B-245 |
| test/portal-client-bound-files.test.mjs:51 | RC-B-246 |
| test/portal-client-bound-files.test.mjs:55 | RC-B-247 |
| test/portal-client-bound-files.test.mjs:59 | RC-B-248 |
| test/portal-client-bound-files.test.mjs:67 | RC-B-249 |
| test/portal-client-cloudflared.test.mjs:56 | 삭제 |
| test/portal-client-cloudflared.test.mjs:65 | 삭제 |
| test/portal-client-cloudflared.test.mjs:80 | RC-B-251 |
| test/portal-client-cloudflared.test.mjs:106 | 삭제 |
| test/portal-client-cloudflared.test.mjs:120 | 삭제 |
| test/portal-client-cloudflared.test.mjs:130 | RC-B-253 |
| test/portal-client-cloudflared.test.mjs:137 | RC-B-254 |
| test/portal-client-cloudflared.test.mjs:152 | RC-B-255 |
| test/portal-client-cloudflared.test.mjs:165 | RC-B-256 |
| test/portal-client-combined.test.mjs:6 | RC-B-257 |
| test/portal-client-discovery.test.mjs:78 | 삭제 |
| test/portal-client-discovery.test.mjs:90 | 삭제 |
| test/portal-client-discovery.test.mjs:111 | 삭제 |
| test/portal-client-discovery.test.mjs:137 | 삭제 |
| test/portal-client-discovery.test.mjs:147 | 삭제 |
| test/portal-client-discovery.test.mjs:164 | 삭제 |
| test/portal-client-discovery.test.mjs:178 | 삭제 |
| test/portal-client-discovery.test.mjs:198 | 삭제 |
| test/portal-client-discovery.test.mjs:216 | 삭제 |
| test/portal-client-discovery.test.mjs:231 | RC-B-261 |
| test/portal-client-discovery.test.mjs:247 | 삭제 |
| test/portal-client-discovery.test.mjs:262 | 삭제 |
| test/portal-client-discovery.test.mjs:337 | 삭제 |
| test/portal-client-discovery.test.mjs:353 | 삭제 |
| test/portal-client-discovery.test.mjs:374 | 삭제 |
| test/portal-client-discovery.test.mjs:391 | 삭제 |

### G04 대응

| 원 시험(파일:줄) | 사례 ID·삭제 |
|---|---|
| test/portal-client-output.test.mjs:51 | RC-B-271 |
| test/portal-client-output.test.mjs:64 | RC-B-272 |
| test/portal-client-output.test.mjs:71 | RC-B-273 |
| test/portal-client-output.test.mjs:80 | RC-B-274 |
| test/portal-client-output.test.mjs:90 | RC-B-275 |
| test/portal-client-output.test.mjs:100 | RC-B-276 |
| test/portal-client-output.test.mjs:110 | RC-B-277 |
| test/portal-client-output.test.mjs:118 | RC-B-274 |
| test/portal-client-output.test.mjs:129 | RC-B-276 |
| test/portal-client-process.test.mjs:130 | RC-B-278 |
| test/portal-client-process.test.mjs:165 | RC-B-279 |
| test/portal-client-process.test.mjs:175 | RC-B-280 |
| test/portal-client-process.test.mjs:193 | RC-B-281 |
| test/portal-client-process.test.mjs:231 | RC-B-282 |
| test/portal-client-source-binding.test.mjs:49 | RC-B-283 |
| test/portal-client-source-binding.test.mjs:64 | RC-B-284 |
| test/portal-client-source-binding.test.mjs:74 | RC-B-285 |
| test/portal-client-source-binding.test.mjs:84 | RC-B-286 |
| test/portal-client-source-binding.test.mjs:91 | RC-B-286 |
| test/portal-client-source-binding.test.mjs:98 | RC-B-283 |
| test/portal-client-source-binding.test.mjs:104 | RC-B-287 |
| test/portal-client-source-binding.test.mjs:112 | RC-B-288 |
| test/portal-client-source-binding.test.mjs:134 | RC-B-289 |
| test/portal-client.test.mjs:71 | RC-B-290 |
| test/portal-client.test.mjs:108 | RC-B-291 |
| test/portal-client.test.mjs:124 | RC-B-292 |
| test/portal-client.test.mjs:144 | RC-B-293 |
| test/portal-client.test.mjs:169 | RC-B-294 |
| test/portal-client.test.mjs:194 | RC-B-295 |
| test/portal-client.test.mjs:213 | RC-B-296 |
| test/portal-client.test.mjs:229 | RC-B-297 |
| test/portal-client.test.mjs:243 | RC-B-298 |
| test/portal-client.test.mjs:251 | RC-B-288 |
| test/portal-client.test.mjs:261 | 삭제 |
| test/portal-client.test.mjs:276 | RC-B-300 |
| test/portal-client.test.mjs:358 | RC-B-301 |
| test/portal-client.test.mjs:378 | RC-B-302 |
| test/portal-client.test.mjs:407 | RC-B-303 |
| test/portal-client.test.mjs:424 | RC-B-303 |
| test/portal-client.test.mjs:443 | RC-B-304 |
| test/portal-client.test.mjs:465 | RC-B-305 |
| test/portal-client.test.mjs:479 | RC-B-300 |
| test/portal-file-forwarder.test.mjs:36 | RC-B-306 |
| test/portal-file-forwarder.test.mjs:42 | RC-B-307 |
| test/portal-file-forwarder.test.mjs:47 | RC-B-308 |
| test/portal-file-forwarder.test.mjs:51 | RC-B-309 |
| test/portal-file-forwarder.test.mjs:56 | RC-B-310 |
| test/portal-file-forwarder.test.mjs:61 | RC-B-311 |
| test/portal-file-forwarder.test.mjs:68 | RC-B-312 |
| test/portal-file-forwarder.test.mjs:72 | RC-B-313 |
| test/portal-file-forwarder.test.mjs:78 | RC-B-314 |
| test/portal-file-mcp-process.test.mjs:33 | RC-B-315 |
| test/portal-file-mcp-process.test.mjs:43 | RC-B-316 |
| test/portal-file-mcp-process.test.mjs:49 | RC-B-317 |
| test/portal-file-mcp-process.test.mjs:56 | RC-B-318 |
| test/portal-files-hook.test.mjs:55 | RC-B-319 |
| test/portal-files-hook.test.mjs:77 | RC-B-320 |
| test/portal-files-hook.test.mjs:91 | RC-B-320 |
| test/portal-files-hook.test.mjs:108 | 삭제 |
| test/portal-files-hook.test.mjs:122 | RC-B-321 |
| test/portal-files-hook.test.mjs:131 | RC-B-322 |
| test/portal-files-hook.test.mjs:141 | RC-B-322 |
| test/portal-files-hook.test.mjs:151 | RC-B-323 |
| test/portal-files-hook.test.mjs:161 | RC-B-324 |
| test/portal-files-hook.test.mjs:171 | 삭제 |
| test/portal-files-hook.test.mjs:182 | RC-B-325 |
| test/preservation-baseline.test.mjs:39 | RC-B-326 |
| test/preservation-baseline.test.mjs:64 | RC-B-327 |
| test/preservation-baseline.test.mjs:75 | RC-B-328 |
| test/preservation-baseline.test.mjs:103 | RC-B-329 |
| test/preservation-baseline.test.mjs:117 | RC-B-330 |
| test/preservation-baseline.test.mjs:138 | RC-B-331 |
| test/preservation-baseline.test.mjs:157 | RC-B-332 |
| test/preservation-integration.test.mjs:18 | RC-B-333 |
| test/preservation-integration.test.mjs:41 | RC-B-334 |
| test/preservation-integration.test.mjs:60 | RC-B-334 |
| test/preservation-integration.test.mjs:75 | RC-B-335 |
| test/preservation-integration.test.mjs:133 | RC-B-336 |
| test/preservation-integration.test.mjs:152 | RC-B-337 |
| test/preservation-verification.test.mjs:13 | RC-B-338 |
| test/preservation-verification.test.mjs:60 | RC-B-339 |
| test/preservation-verification.test.mjs:94 | RC-B-340 |
| test/preservation-verification.test.mjs:108 | RC-B-341 |
| test/preservation-verification.test.mjs:124 | RC-B-342 |
| test/preservation-verification.test.mjs:143 | RC-B-343 |
| test/python-source-ssh.test.mjs:38 | RC-B-344 |
| test/python-source-ssh.test.mjs:53 | RC-B-345 |
| test/python-source-ssh.test.mjs:62 | RC-B-346 |
| test/python-source-ssh.test.mjs:81 | RC-B-347 |
| test/python-source.test.mjs:21 | RC-B-348 |
| test/python-source.test.mjs:39 | 삭제 |
| test/python-source.test.mjs:46 | RC-B-349 |
| test/python-source.test.mjs:57 | RC-B-350 |
| test/python-source.test.mjs:73 | RC-B-351 |
| test/python-source.test.mjs:87 | RC-B-352 |
| test/read-command-refusals.test.mjs:54 | RC-B-353 |
| test/read-command-refusals.test.mjs:63 | RC-B-354 |
| test/read-command-refusals.test.mjs:71 | RC-B-355 |
| test/read-command-refusals.test.mjs:77 | RC-B-356 |
| test/read-command-refusals.test.mjs:85 | RC-B-357 |
| test/read-command-refusals.test.mjs:98 | RC-B-358 |
| test/read-command-refusals.test.mjs:107 | RC-B-359 |

### G05 대응

| 원 시험(파일:줄) | 사례 ID·삭제 |
|---|---|
| test/release-version.test.mjs:9 | RC-B-361 |
| test/release-version.test.mjs:25 | RC-B-362 |
| test/remote-mcp-upload.test.mjs:72 | RC-B-363 |
| test/remote-mcp-upload.test.mjs:95 | RC-B-364 |
| test/remote-mcp-upload.test.mjs:128 | RC-B-365 |
| test/remote-mcp-upload.test.mjs:144 | RC-B-366 |
| test/remote-mcp-upload.test.mjs:162 | RC-B-367 |
| test/remote-mcp-upload.test.mjs:176 | RC-B-368 |
| test/remote-mcp-upload.test.mjs:186 | RC-B-369 |
| test/remote-mcp-upload.test.mjs:209 | RC-B-370 |
| test/remote-mcp-upload.test.mjs:220 | RC-B-371 |
| test/request-admission.test.mjs:13 | RC-B-372 |
| test/request-admission.test.mjs:26 | RC-B-373 |
| test/request-admission.test.mjs:47 | RC-B-374 |
| test/request-admission.test.mjs:68 | RC-B-374 |
| test/request-admission.test.mjs:84 | RC-B-375 |
| test/request-admission.test.mjs:98 | RC-B-375 |
| test/request-admission.test.mjs:114 | RC-B-376 |
| test/request-admission.test.mjs:138 | RC-B-377 |
| test/request-admission.test.mjs:159 | RC-B-378 |
| test/request-capacity.test.mjs:15 | RC-B-379 |
| test/request-capacity.test.mjs:26 | RC-B-380 |
| test/request-capacity.test.mjs:47 | RC-B-381 |
| test/request-capacity.test.mjs:60 | RC-B-382 |
| test/request-capacity.test.mjs:79 | RC-B-383 |
| test/request-safety-http.test.mjs:54 | RC-B-384, RC-B-385 |
| test/request-safety.test.mjs:13 | RC-B-386 |
| test/request-safety.test.mjs:42 | RC-B-387 |
| test/request-safety.test.mjs:52 | RC-B-388 |
| test/request-safety.test.mjs:59 | RC-B-389 |
| test/request-safety.test.mjs:69 | RC-B-390 |
| test/request-safety.test.mjs:78 | RC-B-391 |
| test/retained-history.test.mjs:28 | RC-B-392 |
| test/retained-history.test.mjs:40 | 삭제 |
| test/retained-history.test.mjs:50 | RC-B-394 |
| test/retained-history.test.mjs:65 | RC-B-395 |
| test/retained-history.test.mjs:73 | RC-B-395 |
| test/retained-history.test.mjs:82 | RC-B-396 |
| test/retained-history.test.mjs:95 | RC-B-397 |
| test/retained-history.test.mjs:110 | 삭제 |
| test/retained-history.test.mjs:119 | RC-B-399 |
| test/retained-history.test.mjs:133 | 삭제 |
| test/retained-history.test.mjs:149 | 삭제 |
| test/retained-history.test.mjs:167 | 삭제 |
| test/retained-history.test.mjs:181 | RC-B-402 |
| test/retained-history.test.mjs:218 | RC-B-403 |
| test/rollback-stopped.test.mjs:6 | RC-B-404 |
| test/runtime-capacity-180.test.mjs:20 | RC-B-405 |
| test/runtime-capacity-180.test.mjs:38 | RC-B-406 |
| test/runtime-capacity-180.test.mjs:64 | RC-B-407 |
| test/runtime-capacity-180.test.mjs:74 | RC-B-408 |
| test/runtime-capacity.test.mjs:26 | RC-B-405 |
| test/runtime-capacity.test.mjs:38 | RC-B-409 |
| test/runtime-capacity.test.mjs:50 | RC-B-410 |
| test/safety-http.test.mjs:15 | RC-B-411 |
| test/safety-http.test.mjs:42 | RC-B-422 |
| test/safety-http.test.mjs:57 | RC-B-414 |
| test/safety-http.test.mjs:72 | RC-B-415 |
| test/safety-http.test.mjs:81 | RC-B-415 |
| test/safety-http.test.mjs:89 | RC-B-416 |
| test/safety-http.test.mjs:98 | RC-B-418 |
| test/safety.test.mjs:20 | RC-B-411 |
| test/safety.test.mjs:35 | RC-B-412 |
| test/safety.test.mjs:56 | RC-B-413 |
| test/safety.test.mjs:64 | RC-B-414 |
| test/safety.test.mjs:81 | RC-B-415 |
| test/safety.test.mjs:91 | RC-B-416 |
| test/safety.test.mjs:101 | RC-B-417 |
| test/safety.test.mjs:111 | RC-B-418 |
| test/safety.test.mjs:122 | RC-B-418 |
| test/safety.test.mjs:131 | RC-B-419 |
| test/safety.test.mjs:139 | 삭제 |
| test/safety.test.mjs:153 | 삭제 |
| test/safety.test.mjs:161 | 삭제 |
| test/safety.test.mjs:173 | RC-B-422 |
| test/safety.test.mjs:184 | 삭제 |
| test/secret-cli-pty.test.mjs:6 | RC-B-424 |
| test/secret-integration.test.mjs:52 | RC-B-425, RC-B-426 |
| test/secret-io-failures.test.mjs:24 | RC-B-427 |
| test/secret-io-failures.test.mjs:45 | RC-B-428 |
| test/secret-io-failures.test.mjs:61 | RC-B-429 |
| test/secret-io-failures.test.mjs:74 | RC-B-430 |
| test/secret-io-failures.test.mjs:91 | RC-B-429 |
| test/secret-io-failures.test.mjs:103 | RC-B-431 |
| test/secret-service.test.mjs:9 | RC-B-432 |
| test/secret-service.test.mjs:19 | RC-B-433 |
| test/secret-service.test.mjs:42 | RC-B-434 |
| test/secrets.test.mjs:7 | RC-B-435 |
| test/shutdown.test.mjs:26 | RC-B-436 |
| test/shutdown.test.mjs:43 | RC-B-437 |
| test/solid-architecture.test.mjs:38 | RC-B-438 |
| test/solid-architecture.test.mjs:46 | 삭제 |
| test/solid-architecture.test.mjs:70 | 삭제 |
| test/solid-architecture.test.mjs:99 | RC-B-440 |
| test/solid-regressions.test.mjs:14 | RC-B-441, RC-B-442, RC-B-443, RC-B-444, RC-B-445, RC-B-446 |

### G06 대응

| 원 시험(파일:줄) | 사례 ID·삭제 |
|---|---|
| test/source-automation.test.mjs:66 | RC-B-451 |
| test/source-automation.test.mjs:101 | RC-B-452 |
| test/source-automation.test.mjs:114 | RC-B-453 |
| test/source-automation.test.mjs:124 | RC-B-454 |
| test/source-automation.test.mjs:138 | RC-B-455 |
| test/source-automation.test.mjs:148 | RC-B-456 |
| test/source-automation.test.mjs:159 | RC-B-457 |
| test/source-automation.test.mjs:179 | RC-B-458 |
| test/source-automation.test.mjs:187 | RC-B-459 |
| test/source-automation.test.mjs:200 | RC-B-460 |
| test/source-automation.test.mjs:223 | RC-B-461 |
| test/source-automation.test.mjs:236 | RC-B-461 |
| test/source-automation.test.mjs:249 | RC-B-457 |
| test/source-automation.test.mjs:303 | RC-B-462 |
| test/source-automation.test.mjs:331 | RC-B-463 |
| test/source-automation.test.mjs:346 | RC-B-464 |
| test/source-automation.test.mjs:359 | RC-B-465 |
| test/source-input-refusals.test.mjs:76 | RC-B-466 |
| test/source-input-refusals.test.mjs:96 | RC-B-467 |
| test/source-input-refusals.test.mjs:114 | RC-B-468 |
| test/source-input-refusals.test.mjs:129 | RC-B-469 |
| test/source-input-refusals.test.mjs:142 | RC-B-470 |
| test/source-input-refusals.test.mjs:154 | RC-B-471 |
| test/source-input-refusals.test.mjs:175 | RC-B-472 |
| test/source-input-refusals.test.mjs:189 | RC-B-472 |
| test/source-linux-runtime.mjs:32 | RC-B-473 |
| test/ssh-connection-lifecycle.test.mjs:102 | RC-B-474 |
| test/ssh-connection-lifecycle.test.mjs:116 | RC-B-475 |
| test/ssh-connection-lifecycle.test.mjs:128 | RC-B-476 |
| test/ssh-connection-lifecycle.test.mjs:142 | RC-B-476 |
| test/ssh-connection-lifecycle.test.mjs:151 | RC-B-477 |
| test/ssh-connection-lifecycle.test.mjs:165 | RC-B-477 |
| test/ssh-connection-lifecycle.test.mjs:180 | RC-B-478 |
| test/ssh-connection-lifecycle.test.mjs:192 | RC-B-479 |
| test/ssh-connection-lifecycle.test.mjs:201 | RC-B-480 |
| test/ssh-supervisor.test.mjs:21 | RC-B-481 |
| test/ssh-supervisor.test.mjs:34 | RC-B-482 |
| test/ssh-supervisor.test.mjs:48 | RC-B-483 |
| test/ssh-supervisor.test.mjs:59 | RC-B-483 |
| test/ssh-supervisor.test.mjs:65 | RC-B-484 |
| test/ssh-supervisor.test.mjs:97 | 삭제 |
| test/ssh-supervisor.test.mjs:107 | RC-B-485 |
| test/ssh-supervisor.test.mjs:116 | RC-B-486 |
| test/ssh-supervisor.test.mjs:125 | RC-B-487 |
| test/ssh-supervisor.test.mjs:132 | RC-B-487 |
| test/ssh-supervisor.test.mjs:140 | RC-B-488 |
| test/ssh-supervisor.test.mjs:151 | RC-B-489 |
| test/ssh-supervisor.test.mjs:161 | RC-B-489 |
| test/ssh-supervisor.test.mjs:193 | RC-B-490 |
| test/ssh-supervisor.test.mjs:200 | RC-B-490 |
| test/ssh-supervisor.test.mjs:208 | RC-B-491 |
| test/ssh-supervisor.test.mjs:223 | RC-B-492 |
| test/terminal-restore.test.mjs:40 | RC-B-493 |
| test/terminal-restore.test.mjs:60 | RC-B-494 |
| test/terminal-restore.test.mjs:81 | RC-B-495 |
| test/test-mode-file-path-policy.test.mjs:57 | RC-B-496 |
| test/test-mode-file-path-policy.test.mjs:74 | RC-B-497 |
| test/test-mode-file-path-policy.test.mjs:98 | RC-B-498 |
| test/test-mode-file-path-policy.test.mjs:107 | RC-B-538 |
| test/test-mode-file-path-policy.test.mjs:127 | RC-B-499 |
| test/test-mode-file-path-policy.test.mjs:141 | RC-B-499 |
| test/test-mode-file-path-policy.test.mjs:154 | RC-B-500 |
| test/test-mode-file-path-policy.test.mjs:176 | RC-B-501 |
| test/test-mode-file-path-policy.test.mjs:189 | RC-B-502 |
| test/test-mode-file-path-policy.test.mjs:209 | RC-B-539 |
| test/test-mode-file-policy-application.test.mjs:76 | RC-B-503 |
| test/test-mode-file-policy-application.test.mjs:87 | RC-B-504 |
| test/test-mode-file-policy-application.test.mjs:100 | RC-B-505 |
| test/test-mode-file-policy-application.test.mjs:109 | RC-B-505 |
| test/test-mode-file-policy-application.test.mjs:117 | RC-B-506 |
| test/test-mode-file-policy-application.test.mjs:134 | RC-B-506 |
| test/test-mode-file-policy-application.test.mjs:159 | RC-B-507 |
| test/test-mode-file-policy-application.test.mjs:176 | RC-B-508 |
| test/test-server-mode.test.mjs:5 | RC-B-509 |
| test/transfer-failure.test.mjs:14 | RC-B-510 |
| test/transfer-failure.test.mjs:30 | RC-B-510 |
| test/transfer-failure.test.mjs:42 | RC-B-511 |
| test/transfer-failure.test.mjs:111 | RC-B-512 |
| test/transfer-failure.test.mjs:127 | RC-B-513 |
| test/transfer-failure.test.mjs:141 | RC-B-514 |
| test/transfer-failure.test.mjs:157 | RC-B-515 |
| test/transfer-failure.test.mjs:168 | RC-B-516 |
| test/transfer-failure.test.mjs:199 | RC-B-517 |
| test/transfer-failure.test.mjs:212 | RC-B-518 |
| test/transfer-failure.test.mjs:264 | RC-B-519 |
| test/transfer-failure.test.mjs:274 | RC-B-520 |
| test/transfer-failure.test.mjs:303 | RC-B-521 |
| test/transfer-failure.test.mjs:319 | RC-B-521 |
| test/ui-bundle.test.mjs:8 | 삭제 |
| test/ui-bundle.test.mjs:23 | RC-B-522 |
| test/vault-kv.test.mjs:6 | RC-B-523 |
| test/vault-kv.test.mjs:18 | RC-B-524 |
| test/version-check.test.mjs:32 | RC-B-525 |
| test/version-check.test.mjs:42 | RC-B-526 |
| test/version-check.test.mjs:90 | RC-B-526 |
| test/version-check.test.mjs:101 | RC-B-527 |
| test/web-session.test.mjs:69 | RC-B-528 |
| test/web-session.test.mjs:79 | RC-B-530 |
| test/web-session.test.mjs:90 | RC-B-531 |
| test/web-session.test.mjs:99 | RC-B-531 |
| test/web-session.test.mjs:118 | RC-B-532 |
| test/web-session.test.mjs:129 | RC-B-533 |
| test/web-session.test.mjs:135 | RC-B-532 |
| test/web-session.test.mjs:150 | RC-B-532 |
| test/web-session.test.mjs:156 | RC-B-534 |
| test/web-session.test.mjs:164 | RC-B-535 |
| test/web-session.test.mjs:180 | RC-B-535 |
| test/web-session.test.mjs:190 | RC-B-535 |
| test/web-session.test.mjs:205 | RC-B-537 |
| test/web-session.test.mjs:229 | RC-B-529 |
| test/web-session.test.mjs:234 | RC-B-536 |
| test/web-session.test.mjs:248 | RC-B-529 |

### G07 대응

| 원 시험(파일:줄) | 사례 ID·삭제 |
|---|---|
| test/windows-agent-cli-helper.test.mjs:6 | 삭제 |
| test/windows-agent-cli-smoke.test.mjs:63 | RC-B-550, RC-B-551 |
| test/windows-agent-cli.test.mjs:11 | RC-B-552 |
| test/windows-agent-cli.test.mjs:16 | 삭제 |
| test/windows-agent-cli.test.mjs:24 | 삭제 |
| test/windows-agent-cli.test.mjs:29 | 삭제 |
| test/windows-agent-cli.test.mjs:44 | 삭제 |
| test/windows-agent-cli.test.mjs:53 | 삭제 |
| test/windows-command-execution.test.mjs:8 | RC-B-558 |
| test/windows-command-execution.test.mjs:22 | RC-B-559 |
| test/windows-command-line.test.mjs:22 | RC-B-560 |
| test/windows-command-line.test.mjs:44 | RC-B-561 |
| test/windows-command-line.test.mjs:64 | RC-B-562 |
| test/windows-command-line.test.mjs:195 | RC-B-563 |
| test/windows-command-line.test.mjs:215 | RC-B-564 |
| test/windows-command-line.test.mjs:232 | RC-B-565 |
| test/windows-command-line.test.mjs:245 | RC-B-566, RC-B-567 |
| test/windows-command-line.test.mjs:274 | RC-B-568 |
| test/windows-command-line.test.mjs:281 | RC-B-569 |
| test/windows-dispatch-binding.test.mjs:165 | RC-B-570, RC-B-571 |
| test/windows-dispatch-binding.test.mjs:198 | RC-B-572 |
| test/windows-dispatch-binding.test.mjs:213 | RC-B-573 |
| test/windows-dispatch-binding.test.mjs:224 | RC-B-574 |
| test/windows-dispatch-binding.test.mjs:235 | RC-B-575 |
| test/windows-dispatch-binding.test.mjs:245 | RC-B-576 |
| test/windows-dispatch-binding.test.mjs:270 | RC-B-577 |
| test/windows-dispatch-binding.test.mjs:301 | RC-B-578 |
| test/windows-dispatch-binding.test.mjs:317 | RC-B-579 |
| test/windows-file-contracts.test.mjs:21 | RC-B-580 |
| test/windows-file-contracts.test.mjs:38 | RC-B-581 |
| test/windows-file-contracts.test.mjs:49 | RC-B-582 |
| test/windows-file-contracts.test.mjs:60 | RC-B-583 |
| test/windows-file-contracts.test.mjs:82 | RC-B-584 |
| test/windows-file-contracts.test.mjs:110 | RC-B-585 |
| test/windows-file-contracts.test.mjs:148 | RC-B-586 |
| test/windows-file-contracts.test.mjs:165 | RC-B-587 |
| test/windows-full-application.test.mjs:19 | RC-B-588 |
| test/windows-full-application.test.mjs:31 | RC-B-589 |
| test/windows-full-application.test.mjs:39 | RC-B-590 |
| test/windows-full-application.test.mjs:70 | RC-B-591 |
| test/windows-jev-contract.test.mjs:25 | RC-B-592 |
| test/windows-jev-contract.test.mjs:50 | RC-B-593 |
| test/windows-jev-contract.test.mjs:66 | RC-B-594 |
| test/windows-python-source.test.mjs:48 | RC-B-595, RC-B-596 |
| test/windows-python-source.test.mjs:94 | RC-B-597, RC-B-598 |
| test/windows-python-source.test.mjs:180 | RC-B-599 |
| test/windows-python-source.test.mjs:231 | RC-B-600 |
| test/windows-python-source.test.mjs:266 | RC-B-601, RC-B-602, RC-B-603 |
| test/windows-ssh-integration.test.mjs:26 | RC-B-604, RC-B-605, RC-B-606, RC-B-607, RC-B-608, RC-B-609, RC-B-610, RC-B-611, RC-B-612, RC-B-613, RC-B-614, RC-B-615, RC-B-616, RC-B-617, RC-B-618, RC-B-619, RC-B-620, RC-B-621, RC-B-622 |
| test/windows-target.test.mjs:29 | RC-B-623 |
| test/windows-target.test.mjs:63 | RC-B-624 |
| test/windows-target.test.mjs:77 | RC-B-625 |
| test/windows-target.test.mjs:93 | RC-B-626 |
| test/windows-target.test.mjs:155 | RC-B-627 |
| test/windows-target.test.mjs:186 | RC-B-628 |
| test/windows-target.test.mjs:215 | RC-B-629 |

### G08 대응

| 원 시험(파일:줄) | 사례 ID·삭제 |
|---|---|
| test/test_agent_cli.py:69 | RC-B-631 |
| test/test_agent_cli.py:73 | RC-B-632 |
| test/test_agent_cli.py:77 | RC-B-633 |
| test/test_agent_cli.py:80 | RC-B-634 |
| test/test_agent_cli.py:84 | RC-B-635 |
| test/test_agent_cli.py:89 | RC-B-636 |
| test/test_agent_cli.py:96 | RC-B-637 |
| test/test_agent_cli.py:101 | RC-B-638 |
| test/test_agent_cli.py:107 | RC-B-639 |
| test/test_agent_cli.py:117 | RC-B-640 |
| test/test_agent_cli.py:149 | RC-B-641 |
| test/test_agent_cli.py:154 | RC-B-642 |
| test/test_agent_cli.py:160 | RC-B-643 |
| test/test_agent_cli.py:166 | 삭제 |
| test/test_agent_cli.py:169 | 삭제 |
| test/test_agent_cli.py:175 | 삭제 |
| test/test_agent_cli.py:180 | 삭제 |
| test/test_agent_cli.py:189 | 삭제 |
| test/test_agent_cli.py:200 | RC-B-649 |
| test/test_agent_cli.py:206 | RC-B-650 |
| test/test_agent_cli.py:214 | RC-B-651 |
| test/test_agent_cli.py:220 | RC-B-652 |
| test/test_agent_cli.py:227 | RC-B-653 |
| test/test_agent_cli.py:234 | RC-B-654 |
| test/test_agent_cli.py:241 | RC-B-655 |
| test/test_agent_cli.py:249 | RC-B-656 |
| test/test_agent_cli.py:253 | 삭제 |
| test/test_agent_cli.py:268 | RC-B-658 |
| test/test_agent_cli.py:280 | RC-B-659 |
| test/test_agent_cli.py:289 | RC-B-660 |
| test/test_agent_cli.py:298 | 삭제 |
| test/test_agent_cli.py:301 | 삭제 |
| test/test_agent_cli.py:308 | 삭제 |
| test/test_agent_cli.py:351 | RC-B-662 |
| test/test_agent_cli.py:352 | RC-B-662 |
| test/test_agent_cli.py:353 | RC-B-662 |
| test/test_agent_cli.py:354 | RC-B-663 |
| test/test_agent_cli.py:444 | RC-B-664 |
| test/test_agent_cli.py:445 | RC-B-665 |
| test/test_agent_cli.py:446 | RC-B-666 |
| test/test_agent_cli.py:455 | RC-B-667 |
| test/test_agent_cli.py:484 | RC-B-668 |
| test/test_agent_cli.py:485 | RC-B-669 |
| test/test_agent_cli.py:486 | RC-B-670 |
| test/test_agent_cli.py:502 | RC-B-671 |
| test/test_agent_cli_login.py:44 | 삭제 |
| test/test_agent_cli_login.py:58 | 삭제 |
| test/test_agent_cli_login.py:73 | 삭제 |
| test/test_agent_cli_login.py:84 | 삭제 |
| test/test_agent_cli_login.py:94 | 삭제 |
| test/test_agent_cli_login.py:102 | 삭제 |
| test/test_agent_cli_login.py:148 | 삭제 |
| test/test_agent_cli_login.py:161 | 삭제 |
| test/test_agent_cli_login.py:170 | 삭제 |
| test/test_agent_cli_login.py:185 | 삭제 |
| test/test_agent_cli_login.py:193 | 삭제 |
| test/test_cloudflare_api_lifecycle.py:55 | 삭제 |
| test/test_cloudflare_api_lifecycle.py:79 | 삭제 |
| test/test_cloudflare_api_lifecycle.py:114 | 삭제 |
| test/test_cloudflare_api_lifecycle.py:130 | 삭제 |
| test/test_cloudflare_api_lifecycle.py:154 | 삭제 |
| test/test_cloudflare_api_lifecycle.py:177 | 삭제 |
| test/test_cloudflare_api_lifecycle.py:191 | 삭제 |
| test/test_cloudflare_api_lifecycle.py:207 | 삭제 |
| test/test_cloudflare_api_lifecycle.py:220 | 삭제 |
| test/test_cloudflare_api_lifecycle.py:235 | 삭제 |
| test/test_cloudflare_api_lifecycle.py:271 | 삭제 |
| test/test_cloudflare_api_lifecycle.py:291 | 삭제 |
| test/test_cloudflare_api_lifecycle.py:314 | 삭제 |
| test/test_cloudflare_api_lifecycle.py:336 | 삭제 |
| test/test_cloudflare_binary.py:30 | 삭제 |
| test/test_cloudflare_binary.py:48 | 삭제 |
| test/test_cloudflare_binary.py:63 | 삭제 |
| test/test_cloudflare_binary.py:76 | 삭제 |
| test/test_cloudflare_binary.py:123 | 삭제 |
| test/test_cloudflare_binary.py:133 | 삭제 |
| test/test_cloudflare_binary.py:142 | 삭제 |
| test/test_cloudflare_binary.py:152 | 삭제 |
| test/test_cloudflare_binary.py:160 | 삭제 |
| test/test_cloudflare_binary.py:189 | 삭제 |
| test/test_cloudflare_binary.py:200 | 삭제 |
| test/test_cloudflare_binary.py:216 | 삭제 |
| test/test_cloudflare_connector.py:104 | 삭제 |
| test/test_cloudflare_connector.py:122 | 삭제 |
| test/test_cloudflare_connector.py:141 | 삭제 |
| test/test_cloudflare_connector.py:159 | 삭제 |
| test/test_cloudflare_connector.py:172 | 삭제 |
| test/test_cloudflare_connector.py:182 | 삭제 |
| test/test_cloudflare_connector.py:222 | 삭제 |
| test/test_cloudflare_connector.py:264 | 삭제 |
| test/test_cloudflare_connector.py:275 | 삭제 |
| test/test_cloudflare_connector.py:387 | 삭제 |
| test/test_cloudflare_connector.py:401 | 삭제 |
| test/test_cloudflare_connector.py:430 | 삭제 |
| test/test_cloudflare_connector.py:447 | 삭제 |
| test/test_cloudflare_connector.py:459 | 삭제 |
| test/test_cloudflare_connector.py:467 | 삭제 |
| test/test_cloudflare_connector.py:490 | 삭제 |
| test/test_cloudflare_connector.py:517 | 삭제 |
| test/test_cloudflare_connector.py:542 | 삭제 |
| test/test_cloudflare_connector.py:572 | 삭제 |
| test/test_cloudflare_connector.py:585 | 삭제 |

### G09 대응

| 원 시험(파일:줄) | 사례 ID·삭제 |
|---|---|
| test/test_cloudflare_discovery.py:23 | 삭제 |
| test/test_cloudflare_discovery.py:44 | 삭제 |
| test/test_cloudflare_discovery.py:53 | 삭제 |
| test/test_cloudflare_discovery.py:109 | 삭제 |
| test/test_cloudflare_discovery.py:127 | 삭제 |
| test/test_cloudflare_discovery.py:135 | 삭제 |
| test/test_cloudflare_discovery.py:151 | 삭제 |
| test/test_cloudflare_discovery.py:162 | 삭제 |
| test/test_cloudflare_discovery.py:177 | 삭제 |
| test/test_cloudflare_discovery.py:188 | 삭제 |
| test/test_cloudflare_environment.py:31 | 삭제 |
| test/test_cloudflare_environment.py:48 | 삭제 |
| test/test_cloudflare_environment.py:110 | 삭제 |
| test/test_cloudflare_environment.py:132 | 삭제 |
| test/test_cloudflare_environment.py:146 | 삭제 |
| test/test_cloudflare_environment.py:158 | 삭제 |
| test/test_cloudflare_environment.py:165 | 삭제 |
| test/test_cloudflare_environment.py:179 | 삭제 |
| test/test_cloudflare_environment.py:188 | 삭제 |
| test/test_cloudflare_environment.py:202 | 삭제 |
| test/test_cloudflare_environment.py:331 | 삭제 |
| test/test_cloudflare_environment.py:344 | 삭제 |
| test/test_cloudflare_environment.py:354 | 삭제 |
| test/test_cloudflare_environment.py:363 | 삭제 |
| test/test_cloudflare_environment.py:372 | 삭제 |
| test/test_cloudflare_environment.py:382 | 삭제 |
| test/test_cloudflare_environment.py:391 | 삭제 |
| test/test_cloudflare_provision.py:130 | 삭제 |
| test/test_cloudflare_provision.py:146 | 삭제 |
| test/test_cloudflare_provision.py:169 | 삭제 |
| test/test_cloudflare_provision.py:178 | 삭제 |
| test/test_cloudflare_provision.py:197 | 삭제 |
| test/test_cloudflare_provision.py:208 | 삭제 |
| test/test_cloudflare_provision.py:219 | 삭제 |
| test/test_cloudflare_provision.py:230 | 삭제 |
| test/test_cloudflare_provision.py:247 | 삭제 |
| test/test_cloudflare_provision.py:252 | 삭제 |
| test/test_cloudflare_provision.py:261 | 삭제 |
| test/test_cloudflare_provision.py:283 | 삭제 |
| test/test_cloudflare_provision.py:293 | 삭제 |
| test/test_cloudflare_provision.py:311 | 삭제 |
| test/test_cloudflare_provision.py:326 | 삭제 |
| test/test_cloudflare_provision.py:340 | 삭제 |
| test/test_cloudflare_provision.py:352 | 삭제 |
| test/test_cloudflare_provision.py:370 | 삭제 |
| test/test_cloudflare_provision.py:380 | 삭제 |
| test/test_cloudflare_provision.py:385 | 삭제 |
| test/test_cloudflare_provision.py:395 | 삭제 |
| test/test_cloudflare_provision.py:408 | 삭제 |
| test/test_cloudflare_provision.py:442 | 삭제 |
| test/test_cloudflare_provision.py:467 | 삭제 |
| test/test_cloudflare_provision.py:483 | 삭제 |
| test/test_cloudflare_provision.py:514 | 삭제 |
| test/test_cloudflare_provision.py:531 | 삭제 |
| test/test_cloudflare_provision.py:548 | 삭제 |
| test/test_cloudflare_setup.py:71 | 삭제 |
| test/test_cloudflare_setup.py:87 | 삭제 |
| test/test_cloudflare_setup.py:96 | 삭제 |
| test/test_cloudflare_setup.py:107 | 삭제 |
| test/test_cloudflare_setup.py:125 | 삭제 |
| test/test_cloudflare_setup.py:135 | 삭제 |
| test/test_cloudflare_setup.py:154 | 삭제 |
| test/test_cloudflare_setup.py:180 | 삭제 |
| test/test_cloudflare_setup.py:187 | 삭제 |
| test/test_cloudflare_setup.py:194 | 삭제 |
| test/test_cloudflare_setup.py:203 | 삭제 |
| test/test_cloudflare_setup.py:217 | 삭제 |
| test/test_cloudflare_setup.py:230 | 삭제 |
| test/test_cloudflare_setup.py:255 | 삭제 |
| test/test_cloudflare_setup.py:264 | 삭제 |
| test/test_cloudflare_setup.py:278 | 삭제 |
| test/test_cloudflare_setup.py:291 | 삭제 |
| test/test_cloudflare_setup.py:309 | 삭제 |
| test/test_compose_env.py:31 | RC-B-749 |
| test/test_compose_env.py:43 | RC-B-750 |
| test/test_compose_env.py:48 | RC-B-751 |
| test/test_compose_env.py:55 | RC-B-752 |
| test/test_compose_env.py:60 | RC-B-753 |
| test/test_compose_env.py:77 | RC-B-754 |
| test/test_env_editor_lock.py:11 | RC-B-755 |
| test/test_environment_helper.py:45 | RC-B-721 |
| test/test_environment_helper.py:54 | RC-B-722, RC-B-723 |
| test/test_environment_helper.py:74 | RC-B-724 |
| test/test_environment_helper.py:89 | RC-B-725 |
| test/test_environment_helper.py:103 | RC-B-726 |
| test/test_environment_helper.py:113 | RC-B-727 |
| test/test_environment_helper.py:124 | RC-B-728 |
| test/test_environment_helper.py:130 | RC-B-729 |
| test/test_environment_helper.py:137 | RC-B-730 |
| test/test_environment_helper.py:147 | RC-B-731 |
| test/test_environment_helper.py:156 | RC-B-732 |
| test/test_environment_helper.py:164 | RC-B-733 |
| test/test_environment_helper.py:170 | RC-B-734 |
| test/test_environment_helper.py:188 | RC-B-735 |
| test/test_environment_helper.py:198 | RC-B-736 |
| test/test_environment_helper.py:214 | RC-B-737 |
| test/test_environment_helper.py:229 | RC-B-738 |
| test/test_environment_helper.py:239 | RC-B-739 |
| test/test_environment_helper.py:248 | RC-B-740 |
| test/test_environment_helper.py:259 | RC-B-741 |
| test/test_environment_helper.py:271 | RC-B-742 |
| test/test_environment_helper.py:283 | RC-B-743 |
| test/test_environment_helper.py:335 | RC-B-744 |
| test/test_environment_helper.py:341 | RC-B-745 |
| test/test_environment_helper.py:350 | RC-B-746 |
| test/test_environment_helper.py:361 | RC-B-747, RC-B-748 |

### G10 대응

| 원 시험(파일:줄) | 사례 ID·삭제 |
|---|---|
| test/test_helper.py:36 | RC-B-811 |
| test/test_helper.py:52 | RC-B-812 |
| test/test_helper.py:84 | RC-B-813 |
| test/test_helper.py:92 | RC-B-813 |
| test/test_helper.py:100 | RC-B-814 |
| test/test_helper.py:111 | RC-B-815 |
| test/test_helper.py:127 | RC-B-816 |
| test/test_helper.py:144 | RC-B-817 |
| test/test_helper.py:151 | RC-B-818 |
| test/test_helper.py:163 | RC-B-819 |
| test/test_linux_desktop_session.py:56 | RC-B-820 |
| test/test_linux_desktop_session.py:66 | RC-B-821 |
| test/test_linux_desktop_session.py:77 | RC-B-822 |
| test/test_linux_desktop_session.py:96 | RC-B-823 |
| test/test_linux_desktop_session.py:117 | RC-B-824 |
| test/test_linux_desktop_session.py:249 | RC-B-825 |
| test/test_linux_desktop_session.py:252 | RC-B-825 |
| test/test_linux_desktop_session.py:257 | RC-B-825 |
| test/test_linux_desktop_session.py:262 | RC-B-826 |
| test/test_linux_desktop_session.py:269 | RC-B-827 |
| test/test_node_runtime.py:85 | 삭제 |
| test/test_node_runtime.py:93 | RC-B-828 |
| test/test_node_runtime.py:105 | RC-B-828 |
| test/test_node_runtime.py:113 | RC-B-829 |
| test/test_node_runtime.py:123 | RC-B-829 |
| test/test_node_runtime.py:131 | RC-B-828 |
| test/test_node_runtime.py:139 | RC-B-828 |
| test/test_node_runtime.py:155 | RC-B-828 |
| test/test_node_runtime.py:162 | RC-B-829 |
| test/test_node_runtime.py:174 | RC-B-829 |
| test/test_node_runtime.py:202 | RC-B-830 |
| test/test_node_runtime.py:213 | 삭제 |
| test/test_oidc_environment.py:34 | RC-B-831 |
| test/test_oidc_environment.py:43 | RC-B-831 |
| test/test_oidc_proxy_install.py:28 | RC-B-832 |
| test/test_oidc_proxy_install.py:97 | RC-B-833 |
| test/test_oidc_proxy_install.py:122 | RC-B-834 |
| test/test_oidc_proxy_install.py:135 | RC-B-834 |
| test/test_oidc_proxy_install.py:146 | RC-B-835 |
| test/test_oidc_proxy_install.py:159 | RC-B-836 |
| test/test_oidc_proxy_install.py:168 | RC-B-837 |
| test/test_oidc_proxy_install.py:186 | RC-B-838 |
| test/test_oidc_proxy_install.py:192 | RC-B-837 |
| test/test_oidc_proxy_install.py:201 | RC-B-838 |
| test/test_oidc_proxy_install.py:209 | RC-B-836 |
| test/test_oidc_proxy_install.py:224 | RC-B-839 |
| test/test_oidc_proxy_install.py:231 | RC-B-839 |
| test/test_oidc_proxy_setup.py:29 | RC-B-840 |
| test/test_oidc_proxy_setup.py:49 | RC-B-841 |
| test/test_oidc_proxy_setup.py:62 | RC-B-842 |
| test/test_oidc_proxy_setup.py:82 | RC-B-842 |
| test/test_oidc_proxy_setup.py:89 | RC-B-843 |
| test/test_oidc_proxy_setup.py:125 | RC-B-844 |
| test/test_oidc_proxy_setup.py:144 | RC-B-845 |
| test/test_oidc_proxy_setup.py:157 | RC-B-846 |
| test/test_oidc_proxy_setup.py:163 | RC-B-845 |
| test/test_oidc_proxy_setup.py:173 | RC-B-846 |
| test/test_oidc_proxy_setup.py:219 | RC-B-847 |
| test/test_oidc_proxy_setup.py:238 | RC-B-844 |
| test/test_oidc_proxy_setup.py:247 | RC-B-847 |
| test/test_package.py:53 | RC-B-848 |
| test/test_package.py:61 | RC-B-849 |
| test/test_package.py:89 | RC-B-850 |
| test/test_package.py:102 | RC-B-851 |
| test/test_package.py:118 | RC-B-852 |
| test/test_package.py:143 | RC-B-853 |
| test/test_package.py:156 | 삭제 |
| test/test_package.py:169 | RC-B-854 |
| test/test_package.py:199 | RC-B-850 |
| test/test_package.py:224 | RC-B-848 |
| test/test_package.py:233 | RC-B-850 |
| test/test_package.py:253 | RC-B-855 |
| test/test_package.py:271 | RC-B-856 |
| test/test_portal_setup.py:18 | RC-B-865 |
| test/test_portal_setup.py:27 | RC-B-865 |
| test/test_portal_setup.py:38 | RC-B-866 |
| test/test_portal_setup.py:48 | RC-B-867 |
| test/test_portal_setup.py:56 | RC-B-868 |
| test/test_portal_setup.py:61 | RC-B-869 |
| test/test_portal_setup.py:69 | RC-B-870 |
| test/test_portal_setup.py:78 | RC-B-870 |
| test/test_portal_setup.py:88 | RC-B-871 |
| test/test_portal_setup.py:100 | RC-B-872 |
| test/test_portal_setup.py:108 | RC-B-873 |
| test/test_prepare_freerdp_input.py:25 | RC-B-874 |
| test/test_prepare_freerdp_input.py:82 | RC-B-875 |
| test/test_prepare_freerdp_input.py:96 | RC-B-876 |
| test/test_prepare_freerdp_input.py:115 | RC-B-877 |
| test/test_prepare_freerdp_input.py:122 | RC-B-877 |
| test/test_prepare_freerdp_input.py:129 | RC-B-878 |
| test/test_prepare_freerdp_input.py:142 | RC-B-879 |
| test/test_prepare_freerdp_input.py:156 | RC-B-880 |
| test/test_prepare_freerdp_input.py:163 | RC-B-879 |
| test/test_prepare_freerdp_input.py:170 | RC-B-881 |
| test/test_prepare_freerdp_input.py:178 | RC-B-882 |
| test/test_prepare_freerdp_input.py:190 | RC-B-883 |
| test/test_release_package.py:87 | RC-B-857 |
| test/test_release_package.py:158 | RC-B-858 |
| test/test_release_package.py:171 | RC-B-859 |
| test/test_release_update.py:56 | RC-B-860 |
| test/test_release_update.py:67 | RC-B-861 |
| test/test_release_update.py:82 | RC-B-861 |
| test/test_release_update.py:96 | RC-B-862 |
| test/test_release_update.py:113 | RC-B-863 |
| test/test_release_update.py:123 | RC-B-863 |
| test/test_release_update.py:131 | RC-B-863 |
| test/test_release_update.py:143 | RC-B-864 |
| test/test_settings_contract.py:15 | RC-B-884 |
| test/test_settings_contract.py:25 | RC-B-887 |
| test/test_settings_contract.py:37 | RC-B-888 |
| test/test_settings_contract.py:47 | RC-B-889 |
| test/test_settings_contract.py:74 | RC-B-885 |
| test/test_settings_contract.py:89 | RC-B-886 |
| test/test_tunnel_connections.py:34 | 삭제 |
| test/test_tunnel_connections.py:40 | 삭제 |
| test/test_tunnel_connections.py:45 | 삭제 |
| test/test_tunnel_connections.py:58 | 삭제 |
| test/test_tunnel_connections.py:62 | 삭제 |
| test/test_tunnel_connections.py:67 | 삭제 |
| test/test_tunnel_connections.py:76 | 삭제 |
| test/test_tunnel_connections.py:85 | 삭제 |
| test/test_tunnel_connections.py:97 | 삭제 |
| test/test_upload_sources.py:16 | RC-B-890 |
| test/test_upload_sources.py:22 | RC-B-891 |
| test/test_upload_sources.py:27 | RC-B-890 |
| test/test_upload_sources.py:32 | RC-B-892 |
| test/test_upload_sources.py:39 | RC-B-886 |

### G11 대응

| 원 시험(파일:줄) | 사례 ID·삭제 |
|---|---|
| test/windows-file-helper.tests.ps1:61 | RC-B-901 |
| test/windows-file-helper.tests.ps1:105 | RC-B-901 |
| test/windows-file-helper.tests.ps1:106 | RC-B-901 |
| test/windows-file-helper.tests.ps1:111 | 삭제 |
| test/windows-file-helper.tests.ps1:116 | 삭제 |
| test/windows-file-helper.tests.ps1:298 | RC-B-903 |
| test/windows-file-helper.tests.ps1:310 | RC-B-903 |
| test/windows-file-helper.tests.ps1:311 | RC-B-903 |
| test/windows-file-helper.tests.ps1:313 | RC-B-903 |
| test/windows-file-helper.tests.ps1:318 | 삭제 |
| test/windows-file-helper.tests.ps1:323 | 삭제 |
| test/windows-file-helper.tests.ps1:324 | 삭제 |
| test/windows-file-helper.tests.ps1:332 | 삭제 |
| test/windows-file-helper.tests.ps1:334 | 삭제 |
| test/windows-file-helper.tests.ps1:339 | 삭제 |
| test/windows-file-helper.tests.ps1:341 | 삭제 |
| test/windows-file-helper.tests.ps1:376 | RC-B-906 |
| test/windows-file-helper.tests.ps1:377 | RC-B-906 |
| test/windows-file-helper.tests.ps1:378 | RC-B-906 |
| test/windows-file-helper.tests.ps1:418 | RC-B-907 |
| test/windows-file-helper.tests.ps1:424 | 삭제 |
| test/windows-file-helper.tests.ps1:425 | 삭제 |
| test/windows-file-helper.tests.ps1:426 | 삭제 |
| test/windows-file-helper.tests.ps1:446 | RC-B-908 |
| test/windows-file-helper.tests.ps1:447 | RC-B-908 |
| test/windows-file-helper.tests.ps1:451 | RC-B-908 |
| test/windows-file-helper.tests.ps1:454 | RC-B-908 |
| test/windows-file-helper.tests.ps1:463 | RC-B-908 |
| test/windows-file-helper.tests.ps1:467 | RC-B-903 |
| test/windows-file-helper.tests.ps1:496 | RC-B-909 |
| test/windows-file-helper.tests.ps1:497 | RC-B-909 |
| test/windows-file-helper.tests.ps1:499 | RC-B-909 |
| test/windows-file-helper.tests.ps1:500 | RC-B-909 |
| test/windows-file-helper.tests.ps1:501 | RC-B-909 |
| test/windows-file-helper.tests.ps1:506 | RC-B-909 |
| test/windows-file-helper.tests.ps1:561 | 삭제 |
| test/windows-file-helper.tests.ps1:567 | 삭제 |
| test/windows-file-helper.tests.ps1:575 | 삭제 |
| test/windows-file-helper.tests.ps1:580 | 삭제 |
| test/windows-file-helper.tests.ps1:581 | 삭제 |
| test/windows-file-helper.tests.ps1:583 | 삭제 |
| test/windows-file-helper.tests.ps1:595 | 삭제 |
| test/windows-file-helper.tests.ps1:596 | 삭제 |
| test/windows-file-helper.tests.ps1:597 | 삭제 |
| test/windows-file-helper.tests.ps1:608 | 삭제 |
| test/windows-file-helper.tests.ps1:609 | 삭제 |
| test/windows-file-helper.tests.ps1:630 | 삭제 |
| test/windows-file-helper.tests.ps1:634 | 삭제 |
| test/windows-file-helper.tests.ps1:644 | RC-B-913 |
| test/windows-file-helper.tests.ps1:645 | RC-B-913 |
| test/windows-file-helper.tests.ps1:646 | RC-B-913 |
| test/windows-file-helper.tests.ps1:657 | 삭제 |
| test/windows-file-helper.tests.ps1:658 | 삭제 |
| test/windows-file-helper.tests.ps1:659 | 삭제 |
| test/windows-file-helper.tests.ps1:666 | RC-B-915 |
| test/windows-file-helper.tests.ps1:667 | RC-B-915 |
| test/windows-file-helper.tests.ps1:671 | RC-B-915 |
| test/windows-file-helper.tests.ps1:678 | 삭제 |
| test/windows-file-helper.tests.ps1:684 | 삭제 |
| test/windows-file-helper.tests.ps1:686 | 삭제 |
| test/windows-file-helper.tests.ps1:688 | 삭제 |
| test/windows-file-helper.tests.ps1:690 | 삭제 |
| test/windows-file-helper.tests.ps1:692 | 삭제 |
| test/windows-file-helper.tests.ps1:695 | RC-B-922 |
| test/windows-file-helper.tests.ps1:696 | RC-B-922 |
| test/windows-file-helper.tests.ps1:697 | RC-B-922 |
| test/windows-file-helper.tests.ps1:702 | RC-B-918 |
| test/windows-file-helper.tests.ps1:703 | RC-B-918 |
| test/windows-file-helper.tests.ps1:713 | RC-B-919 |
| test/windows-file-helper.tests.ps1:714 | RC-B-919 |
| test/windows-file-helper.tests.ps1:722 | RC-B-920 |
| test/windows-file-helper.tests.ps1:723 | RC-B-920 |
| test/windows-file-helper.tests.ps1:742 | RC-B-921 |
| test/windows-file-helper.tests.ps1:743 | RC-B-921 |
| test/windows-file-helper.tests.ps1:747 | RC-B-921 |
| test/windows-file-helper.tests.ps1:752 | RC-B-922 |
| test/windows-file-helper.tests.ps1:753 | RC-B-922 |
| test/windows-file-helper.tests.ps1:779 | RC-B-910 |
| test/windows-file-helper.tests.ps1:780 | RC-B-910 |
| test/windows-file-helper.tests.ps1:785 | RC-B-910 |
| test/windows-file-helper.tests.ps1:786 | RC-B-910 |
| test/windows-file-helper.tests.ps1:790 | RC-B-910 |
| test/windows-file-helper.tests.ps1:813 | RC-B-911 |
| test/windows-file-helper.tests.ps1:815 | RC-B-911 |
| test/windows-file-helper.tests.ps1:818 | RC-B-911 |
| test/windows-file-helper.tests.ps1:835 | RC-B-912 |
| test/windows-file-helper.tests.ps1:836 | RC-B-912 |
| test/windows-file-helper.tests.ps1:837 | RC-B-912 |
| test/windows-file-helper.tests.ps1:840 | RC-B-912 |
| test/windows-file-helper.tests.ps1:855 | RC-B-924 |
| test/windows-file-helper.tests.ps1:856 | RC-B-924 |
| test/windows-file-helper.tests.ps1:887 | 삭제 |
| test/windows-file-helper.tests.ps1:892 | 삭제 |
| test/windows-file-helper.tests.ps1:893 | 삭제 |
| test/windows-file-helper.tests.ps1:896 | 삭제 |
| test/windows-file-helper.tests.ps1:899 | 삭제 |
| test/windows-file-helper.tests.ps1:902 | 삭제 |
| test/windows-file-helper.tests.ps1:906 | 삭제 |
| test/windows-file-helper.tests.ps1:938 | RC-B-923 |
| test/windows-ssh-ci.ps1:171 | RC-B-925 |
| test/windows-ssh-ci.ps1:180 | RC-B-925 |
| test/windows-ssh-ci.ps1:184 | RC-B-925 |
| test/windows-ssh-ci.ps1:327 | RC-B-925 |
| test/windows-ssh-ci.ps1:382 | 삭제 |
| test/windows-ssh-ci.ps1:386 | RC-B-925 |
| test/windows-ssh-ci.ps1:389 | 삭제 |
| test/windows-ssh-ci.ps1:390 | RC-B-925 |
| test/driver-common.test.ps1:17 | RC-B-926 |
| test/compose-driver.sh:85 | 삭제 |
| test/compose-driver.sh:90 | 삭제 |
| test/compose-update-ci.sh:61 | RC-B-933 |
| test/compose-update-ci.sh:67 | RC-B-933 |
| test/compose-update-ci.sh:73 | RC-B-934 |
| test/compose-update-ci.sh:77 | RC-B-935 |
| test/compose-update-ci.sh:85 | RC-B-936 |
| test/compose-update-ci.sh:92 | RC-B-934 |
| test/compose-update-ci.sh:97 | RC-B-937 |
| test/compose-update-ci.sh:110 | 삭제 |
| test/compose-update-ci.sh:123 | 삭제 |
| test/compose-update-ci.sh:129 | 삭제 |
| test/compose-update-ci.sh:134 | RC-B-938 |
| test/compose-update-ci.sh:183 | RC-B-939 |
| test/compose-update-ci.sh:199 | RC-B-940 |
| test/compose-update-ci.sh:202 | RC-B-941 |
| test/compose-update-ci.sh:211 | RC-B-942 |
| test/compose-update-ci.sh:220 | RC-B-943 |
| test/compose-update-ci.sh:230 | RC-B-941 |
| test/compose-update-ci.sh:234 | RC-B-942 |
| test/compose-update-ci.sh:242 | RC-B-944 |
| test/compose-update-ci.sh:250 | RC-B-945 |
| test/compose-update-ci.sh:261 | RC-B-946 |
| test/compose-update-ci.sh:265 | RC-B-946 |
| test/compose-update-ci.sh:270 | RC-B-947 |
| test/container-test.sh:61 | 삭제 |
| test/container-test.sh:90 | RC-B-931 |
| test/container-test.sh:102 | RC-B-927, RC-B-928, RC-B-929, RC-B-930, RC-B-931 |
| test/portal-container-test.sh:65 | 삭제 |
| test/portal-container-test.sh:94 | RC-B-931 |
| test/portal-container-test.sh:106 | RC-B-927, RC-B-928, RC-B-929, RC-B-930, RC-B-931 |
| test/non-cloudflare-container-test.sh:3 | 삭제 |
| test/non-cloudflare-container-test.sh:26 | RC-B-932 |
| test/ssh-recovery-red.sh:23 | 삭제 |

### 대응표 합계

| 묶음 | 원자료 행 | 사례로 간 행 | 삭제 행 | 미확인 행 | 사례 수(ID 범위) |
|---|---|---|---|---|---|
| G01 | 75 | 75 | 0 | 0 | 88 (RC-B-001~088) |
| G02 | 74 | 74 | 0 | 0 | 73 (RC-B-091~163) |
| G03 | 97 | 76 | 21 | 0 | 76 (RC-B-181~267, 삭제로 빠진 250·252·258~260·262~267 제외) |
| G04 | 102 | 98 | 4 | 0 | 88 (RC-B-271~359, 삭제로 빠진 299 제외) |
| G05 | 95 | 84 | 11 | 0 | 78 (RC-B-361~446, 삭제로 빠진 420·421·423·439와 3단계 구현 판정으로 옮긴 393·398·400·401 제외) |
| G06 | 112 | 110 | 2 | 0 | 89 (RC-B-451~537, 메인 판정 6으로 되살린 538·539 포함) |
| G07 | 56 | 50 | 6 | 0 | 75 (RC-B-541~629, 결정 D3-16으로 삭제 표로 옮긴 541~549·553~557 제외) |
| G08 | 102 | 36 | 66 | 0 | 34 (RC-B-631~682, 결정 D3-16으로 삭제 표로 옮긴 644~648·657·661·672~682 제외) |
| G09 | 106 | 33 | 73 | 0 | 35 (RC-B-721~755) |
| G10 | 127 | 115 | 12 | 0 | 82 (RC-B-811~892) |
| G11 | 142 | 90 | 52 | 0 | 41 (RC-B-901~947, 결정 D3-16으로 삭제 표로 옮긴 902·904·905·914·916·917 제외) |
| **합계** | **1,088** | **841** | **247** | **0** | **759** |

- 3단계 결정 D3-16(3단계 설계 8.4절, 11.1절)으로 사례 38건(RC-B-541~549, 553~557, 644~648, 657, 661, 672~682, 902, 904, 905, 914, 916, 917)을 사례 표에서 삭제 표로 옮겼다. 이 38건이 걸치던 원 시험 행 40개(G07 6, G08 18, G11 16)가 「사례로 간 행」에서 「삭제 행」으로 바뀌었다(886 - 40 = 846, 202 + 40 = 242). RC-B-646~648·661(원 시험 4행)은 시범 P3-6 결과가 나올 때까지 「보류」이며 원문을 3절 끝 「보류 사례 원문」에 남겼다(`| 보류 RC-B-…` 형식이라 사례 표 행 수에 세지 않는다).
- 3단계 구현 판정(2026-11-12, stage3-design 11.3)으로 사례 4건(RC-B-393, 398, 400, 401)을 사례 표에서 삭제 표로 옮겼다(G05, 사유는 G05 삭제 표). 이 4건이 걸치던 원 시험 행 5개(`test/retained-history.test.mjs`의 :40, :110, :133, :149, :167)가 「사례로 간 행」에서 「삭제 행」으로 바뀌었다(846 - 5 = 841, 242 + 5 = 247).
- 원자료 행 수(B범위) 1,088 = mjs 611 + py 335 + ps1·sh 142. 대응표 행 수 1,088(파일 Grep으로 확인: 대응표 행 `| test/...:줄 | RC-B-…·삭제·미확인`이 1,088개, 그중 `삭제` 247개, `미확인` 0개).
- 사례로 간 행 841 + 삭제 247 + 미확인 0 = 1,088. 삭제 표의 행 수도 247이다(`| test/파일:줄 |` 행. 두 칸 표 행 1,335 = 대응표 1,088 + 삭제 표 247).
- 사례 수 759(`| RC-B-nnn |` 행 759개). 한 원자료 행이 여러 사례에 걸치는 경우가 있어(대응표 셀에 사례 ID를 쉼표로 나열) 「사례 수」와 「사례로 간 행」은 같지 않다.
- 결번: 대역의 빈 번호(RC-B-089·090, 164~180, 268~270, 360, 447~450, 540, 630, 683~720, 756~810, 893~900, 948~990)와 메인 판정 2·5로 삭제 표로 옮긴 사례 번호(RC-B-250·252·258~260·262~267·299)와 메인 판정 D-18로 옮긴 사례 번호(RC-B-420·421·423·439)와 결정 D3-16으로 옮긴 사례 번호 38개(위 괄호의 번호. 보류 4개 포함)와 3단계 구현 판정으로 옮긴 사례 번호 4개(RC-B-393·398·400·401). 결번은 이번에도 다시 매기지 않는다.

### 교차 검증 결과 (메인 판정 7)

방법: Grep으로 (가) 사례 표 구간의 모든 `test/파일:줄` 토큰, (나) 대응표 1,088행, (다) 삭제 표의 `| test/파일:줄 |` 행을 각각 줄 번호와 함께 뽑아 원자료 순서대로 대조했다. 파일 단위로 사례 표의 원 시험 집합과 대응표 사례 행 집합을 비교했고(G01~G11 전 파일), 대응표 `삭제` 행 집합과 삭제 표 행 집합을 비교했다.

| 비교 | 결과 |
|---|---|
| 사례 표의 원 시험(파일:줄) 집합 − 대응표 사례 행 집합 | 0건 (사례 표에만 있는 줄 없음) |
| 대응표 사례 행 집합(841) − 사례 표의 원 시험 집합 | 0건 (사례 표에 없는 사례 행 없음) |
| 대응표 `삭제` 행 집합(247) − 삭제 표 행 집합(247) | 0건 |
| 삭제 표 행 집합 − 대응표 `삭제` 행 집합 | 0건 |
| 개수 | 대응표 1,088 = 원자료 1,088, 삭제 247 = 247, 사례 행 759 |

- 같은 대조에서 한 가지 해석이 필요했다. G11의 `windows-file-helper.tests.ps1`은 사례 표의 원 시험 열이 아닌 설명 열에도 줄 번호(여러 줄 assert 15개 등)를 인용한다. 이 인용 줄은 원자료 행이 아니므로 대응표 행에서 제외했고, 사례 표의 원 시험 열에 있는 줄과 대응표 사례 행이 정확히 일치함을 확인했다.
- 한 줄이 여러 사례에 속하는 경우(예: `test/mcp-contracts.test.mjs:83` → RC-B-013·RC-B-032, `test/solid-regressions.test.mjs:14` → RC-B-441~446)는 사례 표에서 해당 줄이 해당 사례 행마다 나오고 대응표 셀에 ID가 모두 적혀 있어 일치한다.
- 한계: 위 비교는 줄 집합 수준이다. 대응표의 사례 ID가 사례 표에서 그 줄을 가진 행의 ID와 같은지는 일부 행(`mcp-contracts:83`, `multiline-commands:99·182`, `safety-http`·`safety`, `solid-regressions:14`, `test-mode-file-path-policy:107·209` 등)에서 확인했고, 전수 기계 비교는 하지 않았다. 대응표에 적힌 ID가 사례 표에 존재하지 않는 경우는 결번 구간 참조 검색으로 0건임을 확인했다.

## 5. 결함 연결

장부 결함 중 B범위 시험이 회귀를 고정하는 결함이다. 근거(시험 줄·장부 제목)를 붙이고, 근거가 약하면 「후보」로 표시한다. 연결이 없는 묶음은 「없음」으로 적는다. 시험 이름에 결함 번호를 적은 원 시험은 없고(원자료 기준), 연결은 시험 이름·주석·assert 내용과 장부 제목의 대조로만 판단했다.

### 결함별 요약(전 묶음 통합)

「확정」은 시험이 결함의 증상을 직접 assert하는 사례, 「후보」는 주제만 겹치는 사례다. 사례 ID는 사례 표의 ID이며, 근거 줄은 아래 묶음별 표에 있다.

| 결함 | 확정 사례 | 후보 사례 |
|---|---|---|
| SSH_PORTAL-D-0001 | RC-B-903 | RC-B-519, 906 (RC-B-904·905는 결정 D3-16으로 삭제 표로 이동) |
| SSH_PORTAL-D-0002 | RC-B-497, 504, 620, 921 | RC-B-496, 500, 501, 503, 505, 506, 508, 509, 538, 539, 913, 920 |
| SSH_PORTAL-D-0003 | RC-B-908 | RC-B-619, 621, 812, 907, 923 |
| SSH_PORTAL-D-0004 | RC-B-065 | RC-B-383, 465 |
| SSH_PORTAL-D-0005 | RC-B-072~077 | RC-B-605 |
| SSH_PORTAL-D-0006 | - | RC-B-014, 022, 038, 353, 507 |
| SSH_PORTAL-D-0007 | - | RC-B-042, 043, 363 |
| SSH_PORTAL-D-0008 | - | RC-B-020 |
| SSH_PORTAL-D-0009 | RC-B-558 | - |
| SSH_PORTAL-D-0010 | - | RC-B-026, 041, 481, 482 |
| SSH_PORTAL-D-0011 | RC-B-559 | RC-B-604 |
| SSH_PORTAL-D-0012 | - | RC-B-094, 101, 364, 510 |
| SSH_PORTAL-D-0013 | - | RC-B-579 |
| SSH_PORTAL-D-0014 | - | RC-B-078, 080, 860, 876, 927 |
| SSH_PORTAL-D-0015 | - | RC-B-158 |
| SSH_PORTAL-D-0016 | - | RC-B-139, 142~145, 205 |
| SSH_PORTAL-D-0017 | - | RC-B-136, 148, 149, 151, 159~163, 189, 190, 392, 403 |
| SSH_PORTAL-D-0018 | - | RC-B-140, 153~157, 205 |
| SSH_PORTAL-D-0019 | RC-B-328 | RC-B-004 |
| SSH_PORTAL-D-0020 | - | RC-B-824 |
| SSH_PORTAL-D-0021 | - | RC-B-492 |
| SSH_PORTAL-D-0022 | - | RC-B-825, 826 |
| SSH_PORTAL-D-0023 | - | RC-B-533 (연관 약함) |
| SSH_PORTAL-D-0024 | - | RC-B-537 (연관 약함) |
| SSH_PORTAL-D-0025 | - | RC-B-529, 535, 536 |
| SSH_PORTAL-D-0028 | - | RC-B-857 |
| SSH_PORTAL-D-0029 | - | RC-B-859 |
| SSH_PORTAL-D-0030 | - | RC-B-303, 364, 495 |
| SSH_PORTAL-D-0031 | RC-B-336, 337, 341, 342 | RC-B-006, 007, 082~084, 146, 147, 493 |
| SSH_PORTAL-D-0032 | RC-B-722~725 | RC-B-743 |
| SSH_PORTAL-D-0033 | - | RC-B-024, 242 |
| SSH_PORTAL-D-0034 | RC-B-912 | RC-B-039, 102, 499, 516~518, 520, 521, 615, 616, 619, 813, 814, 817, 901, 909~911 |
| SSH_PORTAL-D-0035 | - | RC-B-664~669, 818 |
| SSH_PORTAL-D-0036 | - | RC-B-025, 271 |
| SSH_PORTAL-D-0037 | - | RC-B-414 |
| SSH_PORTAL-D-0038 | - | RC-B-474~477 |
| SSH_PORTAL-D-0039 | RC-B-156 | RC-B-140, 149, 150, 152, 157 |
| SSH_PORTAL-D-0040 | RC-B-489 | - |
| SSH_PORTAL-D-0041 | - | RC-B-649, 650, 662, 663 (RC-B-672는 결정 D3-16으로 삭제 표로 이동) |
| SSH_PORTAL-D-0042 | RC-B-362, 856 | RC-B-751~753, 926 |
| SSH_PORTAL-D-0046 | - | RC-B-319, 323, 325 |
| SSH_PORTAL-D-0047 | RC-B-019 | RC-B-003, 008, 354, 931, 939~946 |
| SSH_PORTAL-D-0048 | RC-B-827 | - |

B범위 시험에서 연결하지 않은 결함: D-0026·D-0027(클라이언트 설치 시험은 a~l 범위), D-0043, D-0044·D-0045(hook 시험은 근거가 약해 연결하지 않음. 다만 RC-B-319~325의 hook 사례가 가까운 후보다), D-0046 이외 hook 계열.

### G01 결함

| 결함 | 사례 ID | 근거(시험 줄, 장부 제목) | 구분(확정·후보) |
|---|---|---|---|
| SSH_PORTAL-D-0004 | RC-B-065 | test/multi-target.test.mjs:129 주석: 동기 busy 거절을 제거하고 durable queued 직렬화로 교체. 읽기·쓰기 요청이 queued로 대기하다 슬롯이 비면 실행됨을 assert. 장부: 승인된 요청이 실행 대기열 대신 busy_check에서 즉시 실패 | 확정 |
| SSH_PORTAL-D-0005 | RC-B-072, RC-B-073, RC-B-074, RC-B-075, RC-B-076, RC-B-077 | test/multiline-commands.test.mjs:44-191, 헤더 주석의 red proof(기준 커밋에서 Invalid command). LF·CRLF·heredoc 명령이 한 줄 명령처럼 수용·승인 경로를 탐. 장부: 여러 줄 heredoc 명령을 한 줄 명령과 달리 거절 | 확정 |
| SSH_PORTAL-D-0006 | RC-B-014, RC-B-022, RC-B-038 | test/mcp-contracts.test.mjs:98·238, test/mcp180-bytes.test.mjs:26. 공개 출력 스키마 검증, draft-07·2020-12 컴파일, queued 포함 상태 열거 보존. 장부: MCP 출력 스키마가 클라이언트 방언·queued 상태와 불일치 | 후보 |
| SSH_PORTAL-D-0007 | RC-B-042, RC-B-043 | test/mcp180-bytes.test.mjs:83. UI·URL·셸·로컬 stdio 없이 artifact-begin/chunk/finish/read로 바이트 왕복. 장부: 파일 업로드 안내가 OpenAI 첨부/UI 카드에 의존해 CLI 에이전트를 막음 | 후보 |
| SSH_PORTAL-D-0008 | RC-B-020 | test/mcp-contracts.test.mjs:188. 구형 도구(get-client-setup, run-command, read-command-output 등) 부재와 카드 도구 가시성 계약. 장부: 2.0 MCP 전환 뒤 ChatGPT 카드가 구형 읽기·다운로드 계약을 호출 | 후보 |
| SSH_PORTAL-D-0010 | RC-B-026, RC-B-041 | test/mcp-contracts.test.mjs:292, test/mcp180-bytes.test.mjs:67. deadline·transport_lost·cancel·exit를 유형화 증거로 보존(OPERATION_FAILED·unavailable로 뭉개지 않음). 장부: 60초 실행 종료를 OPERATION_FAILED와 unavailable로만 보고 | 후보 |
| SSH_PORTAL-D-0014 | RC-B-078, RC-B-080 | test/native-install-paths.test.mjs:15·58. 모드 정리(0640) 뒤 런타임 준비, 실행 파일 모드 0755 보존. 장부: private umask로 준비한 릴리스 경로를 서비스 계정이 통과하지 못함 | 후보 |
| SSH_PORTAL-D-0019 | RC-B-004 | test/maintenance-durable.test.mjs:21. 유지보수 보호 장치 실패·초기화 실패 때 만료 출력을 삭제하지 않음. 장부: 유지보수 중 TTL 만료된 출력 때문에 보존 비교와 서비스 복구가 충돌 | 후보 |
| SSH_PORTAL-D-0031 | RC-B-006, RC-B-007, RC-B-082, RC-B-083, RC-B-084 | test/maintenance-durable.test.mjs:39, test/offline-preservation.test.mjs:19-59. 재시작 뒤 보존 비교(PASS·실패 탐지), 휴면 journal 포함, 비종결 요청 거절. 장부: 재시작 보존 검사가 canonical operation 이력을 충분히 결속하지 못함 | 후보 |
| SSH_PORTAL-D-0033 | RC-B-024 | test/mcp-contracts.test.mjs:268. observe는 단일 조회 키·명시 출력·waitMs 상한이며 timeout이 취소·재제출하지 않음. 장부: observe 사용 안내가 에이전트의 동기 대기·반복 폴링을 유도 | 후보 |
| SSH_PORTAL-D-0034 | RC-B-039 | test/mcp180-bytes.test.mjs:45. 정책 거절(origin 'policy')과 OS 실패(origin 'os', nativeError)를 구분해 노출. 장부: 파일 API가 권한·공간·I/O 오류를 하나의 안전거부로 뭉뚱그림 | 후보 |
| SSH_PORTAL-D-0036 | RC-B-025 | test/mcp-contracts.test.mjs:278. 명시 includeOutput 요청에서 UTF-8 출력을 페이지로 재구성. 장부: 저장 출력은 존재하지만 일부 호스트 소비 경로에서 본문이 전달되지 않은 과거 사례 | 후보 |
| SSH_PORTAL-D-0047 | RC-B-019 | test/mcp-contracts.test.mjs:165. 유지보수 중 submit이 error `{code:'MAINTENANCE_ACTIVE', retryable:true, executionAttempted:false}`로 구분됨(REQUEST_REFUSED로 소거되지 않음). 장부: install.sh 중단 시 maintenance 잠금 영구 잔류 및 유지보수 중 submit의 원인 소거 | 확정 |
| SSH_PORTAL-D-0047 | RC-B-003, RC-B-008 | test/maintenance-client.test.mjs:55(남은 활성 owner 토큰 복구·정리), test/maintenance-durable.test.mjs:88(비정상 종료 owner 복구). 같은 결함의 maintenance 잠금 잔류 측면 | 후보 |

### G02 결함

| 결함 | 사례 ID | 근거(시험 줄, 장부 제목) | 구분(확정·후보) |
|---|---|---|---|
| SSH_PORTAL-D-0016 | RC-B-139, RC-B-142, RC-B-143, RC-B-144, RC-B-145 | operation-migration-180.test.mjs:82(재배포 시 reused=true·originalGeneration, 세 DB 바이트 불변·새 보관 디렉터리 없음), :135(증거 없으면 LEGACY_MIGRATION_RECEIPT_REQUIRED), :150·:161(보관 심볼릭 링크·추가 이력은 거절). 장부 제목: 전진 배포마다 구형 장부를 다시 import해 기존 이력 재처리 위험 | 후보 |
| SSH_PORTAL-D-0017 | RC-B-148, RC-B-149, RC-B-151, RC-B-159, RC-B-160, RC-B-161, RC-B-162, RC-B-163, RC-B-136 | operation-migration-batch.test.mjs:27(8000행 60초 자식 경계), :107(원본 30MiB가 64MiB 초과 확장돼도 실행 예산 미소비), operation-migration-retained-budget.test.mjs:19~89(보존 예산과 실행 예산 분리, LEGACY_HISTORY_CAPACITY·OPERATION_CAPACITY). 장부 제목: 누적 이력 마이그레이션이 단건 처리시간·새 작업 저장 예산에 묶임 | 후보 |
| SSH_PORTAL-D-0018 | RC-B-140, RC-B-153, RC-B-154, RC-B-155, RC-B-156, RC-B-157 | operation-migration-preflight.test.mjs:51~105(C18-01~C18-04 시험 이름이 18번 결함 번호와 대응, OPERATION_KEY_CONFLICT 사전 검사)·operation-migration-180.test.mjs:57. 장부 제목: 이력 이전에서 OPERATION_KEY_CONFLICT로 서비스 전환 중단된 과거 사례(OPEN) | 후보 |
| SSH_PORTAL-D-0039 | RC-B-156, RC-B-140, RC-B-149, RC-B-150, RC-B-152, RC-B-157 | operation-migration-preflight.test.mjs:82(뒤쪽 canonical key/id/original/digest/source 충돌이 앞 129행 출처를 커밋하지 못함: 129행 get·find null, usage 불변), batch.test.mjs:60(충돌 배치 뒤 find null·usage 불변). 장부 제목: legacy migration이 뒤쪽 identity 충돌 전에 앞 batch를 부분 기록함 | 확정(RC-B-156), 후보(나머지) |
| SSH_PORTAL-D-0015 | RC-B-158 | operation-migration-preflight.test.mjs:125(유니코드 NFC/NFD 키·'합성 이력 😀' 증거가 정확·구분 유지). 이 시험은 stdin 청크 경계를 직접 만들지 않으므로 UTF-8 원문 보존 관점의 후보. 장부 제목: 마이그레이션 stdin 청크 경계에서 UTF-8 원문 보존 불일치 | 후보 |
| SSH_PORTAL-D-0031 | RC-B-146, RC-B-147 | operation-migration-180.test.mjs:181·194(durableFingerprint가 payload·capacity·사이드카를 포함하고 미지 이름은 UNSUPPORTED_DURABLE_DATA), :211·:230(새 쓰기 뒤 DOWNMIGRATION_FORBIDDEN_AFTER_WRITES). 장부 제목: 재시작 보존 검사가 canonical operation 이력을 충분히 결속하지 못함 | 후보 |
| SSH_PORTAL-D-0012 | RC-B-094, RC-B-101 | opaque-artifacts.test.mjs:66·opaque-file-api.test.mjs:95(쿼터 초과 시 ARTIFACT_QUOTA 정확한 원인, 수락 바이트 보존). 장부 제목: 작은 파일 artifact-begin이 ARTIFACT_QUOTA로 거절된 과거 사례(OPEN) | 후보 |
| SSH_PORTAL-D-0034 | RC-B-102 | opaque-file-api.test.mjs:95(storage 권한·공간·I/O 오류를 403/507/500 서로 다른 코드로 구분). 장부 제목: 파일 API가 권한·공간·I/O 오류를 하나의 안전거부로 뭉뚱그림(대상 파일 API와 artifact API는 다름) | 후보 |

### G03 결함

| 결함 | 사례 ID | 근거(시험 줄, 장부 제목) | 구분(확정·후보) |
|---|---|---|---|
| SSH_PORTAL-D-0017 | RC-B-189, RC-B-190 | test/operation-scheduler.test.mjs:54, :83: 이전된 legacy unknown 33건이 신규 작업 수락·디스패치 예산을 소비하지 않고 라이브 unknown만 예산을 소진함을 assert. 장부 제목 「누적 이력 마이그레이션이 단건 처리시간·새 작업 저장 예산에 묶임」과 주제가 겹침 | 후보 |
| SSH_PORTAL-D-0016 | RC-B-205 | test/operation-store.test.mjs:69: 같은 legacy 행의 재가져오기가 기존 레코드를 그대로 반환(멱등)함을 assert. 장부 제목 「전진 배포마다 구형 장부를 다시 import해 기존 이력을 재처리할 위험」과 겹침 | 후보 |
| SSH_PORTAL-D-0018 | RC-B-205 | test/operation-store.test.mjs:77: 내용이 다른 legacy 재가져오기가 `OPERATION_KEY_CONFLICT`를 던짐을 assert. 장부 제목 「이력 이전에서 OPERATION_KEY_CONFLICT로 서비스 전환 중단」과 오류 코드가 같음 | 후보 |
| SSH_PORTAL-D-0033 | RC-B-242 | test/operations-180.test.mjs:169: 기본 observe가 보류된 실행을 기다리지 않고 즉시 running을 반환함을 assert(OBS01). 장부 제목 「observe 사용 안내가 동기 대기·반복 폴링을 유도」와 관련 | 후보 |

### G04 결함

| 결함 | 사례 ID | 근거(시험 줄, 장부 제목) | 구분(확정·후보) |
|---|---|---|---|
| SSH_PORTAL-D-0019 | RC-B-328 | test/preservation-baseline.test.mjs:75: 만료된 baseline 출력이 주기 정리·재시작 동안 영속 예약으로 보존되고(expiredOutputsRemoved=0, 페이로드 바이트 불변) verified 해제 뒤에만 정리가 재개됨. 장부 제목: 유지보수 중 TTL 만료된 출력 때문에 보존 비교와 서비스 복구가 충돌 | 확정 |
| SSH_PORTAL-D-0031 | RC-B-336, RC-B-337, RC-B-341, RC-B-342 | test/preservation-integration.test.mjs:133·152, test/preservation-verification.test.mjs:108·124: canonical operation·event 접두·legacy budget·스키마 변경을 서비스 교체 뒤 PASS로 통과시키지 않음. 장부 제목: 재시작 보존 검사가 canonical operation 이력을 충분히 결속하지 못함 | 확정 |
| SSH_PORTAL-D-0047 | RC-B-354 | test/read-command-refusals.test.mjs:63: 유지보수 중 submit이 원인이 보이는 안전 거절(대문자 오류 코드)로 끝나고 해제 후 접수 복구. 장부 제목: install.sh 중단 시 maintenance 잠금 영구 잔류 및 유지보수 중 submit의 원인 소거 | 후보 |
| SSH_PORTAL-D-0006 | RC-B-353 | test/read-command-refusals.test.mjs:54: 실제 표준 MCP 클라이언트의 출력 스키마 캐시를 채운 뒤 queued/pending 응답을 검증. 장부 제목: MCP 출력 스키마가 클라이언트 방언·queued 상태와 불일치 | 후보 |
| SSH_PORTAL-D-0046 | RC-B-319, RC-B-323, RC-B-325 | test/portal-files-hook.test.mjs:55·151·182: 완료 훅이 영수증을 ACK하지 않고 중복 전달에 영수증 1개 유지, Claude 네이티브 훅 deferral이 큐 성공으로 처리됨. 장부 제목: Claude Code 완료 훅이 미요청 작업 자동감시·미ACK 중복·차단오류 표시 및 직전 도구명 오표기 | 후보 |
| SSH_PORTAL-D-0036 | RC-B-271 | test/portal-client-output.test.mjs:51: 명시적 `output` 읽기로 저장 출력 본문을 호스트 소비 경로에서 전달. 장부 제목: 저장 출력은 존재하지만 일부 호스트 소비 경로에서 본문이 전달되지 않은 과거 사례 | 후보 |
| SSH_PORTAL-D-0030 | RC-B-303 | test/portal-client.test.mjs:424: 만료·사라진 스테이징은 대체 작업 없이 거절(UPLOAD_NOT_RESUMABLE, PORTAL_REQUEST_REFUSED). 장부 제목: artifact 만료 뒤 재시작에서 이미 종료된 업로드 복구를 잘못 처리 | 후보 |

### G05 결함

| 결함 | 사례 ID | 근거(시험 줄, 장부 제목) | 구분(확정·후보) |
|---|---|---|---|
| SSH_PORTAL-D-0042 | RC-B-362 | release-version.test.mjs:25가 Dockerfile ARG·.dockerignore·compose 기본 이미지·env 예시·README의 현재 버전 일치를 assert; 장부 제목: Docker archive 기본값·build context 허용 파일·이미지 예시의 현재 버전이 어긋남 | 확정 |
| SSH_PORTAL-D-0007 | RC-B-363 | remote-mcp-upload.test.mjs:72가 `openai/fileParams`·app 전용 가시성 없이 표준 MCP JSON 업로드 도구를 노출하는지 assert; 장부 제목: 파일 업로드 안내가 OpenAI 첨부/UI 카드에 의존해 CLI 에이전트를 막음 | 후보 |
| SSH_PORTAL-D-0012 | RC-B-364 | remote-mcp-upload.test.mjs:95가 빈 파일·작은 바이너리 artifact-begin이 거절 없이 통과함을 assert; 장부 제목: 작은 파일의 artifact-begin이 ARTIFACT_QUOTA로 거절된 과거 사례(OPEN) | 후보 |
| SSH_PORTAL-D-0030 | RC-B-364 | remote-mcp-upload.test.mjs:95가 아티팩트 reap 뒤에도 status가 completed 요청을 반환하고 finish가 같은 id를 돌려주는지 assert; 장부 제목: artifact 만료 뒤 재시작에서 이미 종료된 업로드 복구를 잘못 처리 | 후보 |
| SSH_PORTAL-D-0004 | RC-B-383 | request-capacity.test.mjs:79가 승인된 요청 2건이 공통 스케줄러에서 queued→running으로 직렬화되는지 assert; 장부 제목: 승인된 요청이 실행 대기열 대신 busy_check에서 즉시 실패 | 후보 |
| SSH_PORTAL-D-0017 | RC-B-392 | retained-history.test.mjs:28이 24시간 초과 기존 장부 명령을 기간으로 조회(HIST-OLD)하고 :218이 N=100~10000 보관 행 조회를 assert; 장부 제목: 누적 이력 마이그레이션이 단건 처리시간·새 작업 저장 예산에 묶임 | 후보 |
| SSH_PORTAL-D-0017 | RC-B-403 | retained-history.test.mjs:218이 보관 행 10000건까지 조회·승인 동시 응답과 불변을 assert; 장부 제목: 누적 이력 마이그레이션이 단건 처리시간·새 작업 저장 예산에 묶임 | 후보 |
| SSH_PORTAL-D-0037 | RC-B-414 | safety.test.mjs:64가 확률 합·범위 위반 응답을 assessed로 받지 않고 invalid_response로 처리함을 assert; 장부 제목: Jev 연구가 응답 검증 오류·확률합 계약 충돌로 중단되어 품질 개선 미입증(OPEN) | 후보 |

### G06 결함

| 결함 | 사례 ID | 근거(시험 줄, 장부 제목) | 구분(확정·후보) |
|---|---|---|---|
| SSH_PORTAL-D-0002 | RC-B-497, RC-B-504 | test-mode-file-path-policy.test.mjs:74 (서버 정책 bypassRoot true일 때만 우회, 우회 플래그가 policy·publish·snapshot에 true), test-mode-file-policy-application.test.mjs:87 (활성 testServer 정책+유효 secret이면 pathPolicy {bypassRoot:true}); 장부 제목: Windows 파일 전송에서 TEST 모드인데도 허용 루트 정책이 적용됨 | 확정 |
| SSH_PORTAL-D-0002 | RC-B-496, RC-B-500, RC-B-501, RC-B-503, RC-B-505, RC-B-506, RC-B-508, RC-B-509, RC-B-538, RC-B-539 | test-mode 경로 정책 전 시험군(위조 필드 무효·권한 오류 비승격·승격 의도 보존·다른 대상/오래된 revision 정책 무효·정책 변경 중 철회·secret fail-closed); 같은 결함의 우회 조건 경계를 고정하는 시험 | 후보 |
| SSH_PORTAL-D-0001 | RC-B-519 | transfer-failure.test.mjs:264 (WRITER-DIAG-01, policyReason UNTRUSTED_OWNER 등 6종을 PERMISSION_DENIED의 diagnostic으로 보존); 장부 제목: Windows TEST가 SSH로 읽을 수 있는 GUI 생성 파일 다운로드를 UNTRUSTED_OWNER로 거절 | 후보 |
| SSH_PORTAL-D-0034 | RC-B-499, RC-B-516, RC-B-517, RC-B-518, RC-B-520, RC-B-521 | transfer-failure.test.mjs:168·199·212·274·303·319 및 test-mode-file-path-policy.test.mjs:127·141 (PATH_OUTSIDE_ALLOWED_ROOT·PARENT_NOT_FOUND·FILE_NOT_FOUND 등 오류 코드를 구분해 공개하고 알 수 없는 오류만 OPERATION_FAILED); 장부 제목: 파일 API가 권한·공간·I/O 오류를 하나의 안전거부로 뭉뚱그림 | 후보 |
| SSH_PORTAL-D-0040 | RC-B-489 | ssh-supervisor.test.mjs:161 (정착 시 일시정지된 SSH 읽기 스트림을 비워 channel.closed true, 싱크 실패 포함); 장부 제목: SSH 종료 시 durable output backpressure가 readable을 영구 pause 상태로 남김 | 확정 |
| SSH_PORTAL-D-0021 | RC-B-492 | ssh-supervisor.test.mjs:223 (포워드 취소가 자기 채널만 destroy하고 정확한 endpoint 추적); 장부 제목: GUI 종료에서 소유 SSH forward가 남거나 정리결과를 확정하지 못함 | 후보 |
| SSH_PORTAL-D-0010 | RC-B-481, RC-B-482 | ssh-supervisor.test.mjs:21 (DEFAULT_RUN_TIMEOUT_MS ≥ 120000), :34 (deadline reason과 부분 출력 보존); 장부 제목: 60초 실행 종료를 OPERATION_FAILED와 unavailable로만 보고 | 후보 |
| SSH_PORTAL-D-0038 | RC-B-474, RC-B-475, RC-B-476, RC-B-477 | ssh-connection-lifecycle.test.mjs:102·116·128·151·165 (채널 열기 실패 후 단일 시도·연결 보존·복구 규칙); 장부 제목: Linux·Windows 실행 요청이 짧은 시간에 반복 unavailable로 종료된 과거 사건(OPEN) | 후보 |
| SSH_PORTAL-D-0004 | RC-B-465 | source-automation.test.mjs:359 (test server source가 대기열에서 state 'queued', decision.dispatchFailure undefined로 유지되다가 순서대로 실행); 장부 제목: 승인된 요청이 실행 대기열 대신 busy_check에서 즉시 실패 | 후보 |
| SSH_PORTAL-D-0012 | RC-B-510 | transfer-failure.test.mjs:14 (다운로드 예약 할당량 실패를 ARTIFACT_QUOTA·not_started로 유형화); 장부 제목: 작은 파일의 artifact-begin이 ARTIFACT_QUOTA로 거절된 과거 사례(OPEN) | 후보 |
| SSH_PORTAL-D-0030 | RC-B-495 | terminal-restore.test.mjs:81 (시작 시 종료된 upload의 artifact를 1회 해제, 이력·감사 불변); 장부 제목: artifact 만료 뒤 재시작에서 이미 종료된 업로드 복구를 잘못 처리 | 후보 |
| SSH_PORTAL-D-0031 | RC-B-493 | terminal-restore.test.mjs:40 (재시작 시 canonical operation 이력·이벤트를 다시 쓰지 않음); 장부 제목: 재시작 보존 검사가 canonical operation 이력을 충분히 결속하지 못함 | 후보 |
| SSH_PORTAL-D-0006 | RC-B-507 | test-mode-file-policy-application.test.mjs:159 (targets 출력이 공개 outputSchema strict parse를 통과, 추가 필드는 safeParse 실패); 장부 제목: MCP 출력 스키마가 클라이언트 방언·queued 상태와 불일치 | 후보 |
| SSH_PORTAL-D-0025 | RC-B-529, RC-B-535, RC-B-536 | web-session.test.mjs:229 (로그아웃이 부트스트랩을 기다림), :234 (로그아웃 응답 유실 시 데스크톱 닫기 훅 1회·명시적 재시도), :164 (로그아웃 정리); 장부 제목: 입력 중 관리자 로그아웃이 GUI close보다 먼저 세션을 폐기 | 후보 |
| SSH_PORTAL-D-0024 | RC-B-537 | web-session.test.mjs:205 (무관한 요청 변경에서 기존 노드·details 펼침·출력 scrollTop 보존); 장부 제목: 관리자 데스크톱 화면 갱신이 입력 초안·초점·선택을 지움(요청 목록 화면의 갱신 보존 시험이라 연관 약함) | 후보 |
| SSH_PORTAL-D-0023 | RC-B-533 | web-session.test.mjs:129 (브라우저 언어별 한국어 보존·영어 대체); 장부 제목: 선택한 locale 지역 형식이 일부 패널에 전달되지 않고 상속 카탈로그 키 처리 오류(언어 선택 시험이라 연관 약함) | 후보 |

### G07 결함

| 결함 | 사례 ID | 근거(시험 줄, 장부 제목) | 구분(확정·후보) |
|---|---|---|---|
| SSH_PORTAL-D-0009 | RC-B-558 | test/windows-command-execution.test.mjs:8 — 모든 Windows catch 경로가 `$_.ToString()`·`InvocationInfo.PositionMessage`를 보고하고 일반 문구 `Windows command failed` WriteLine이 없음을 assert. 장부: Windows 실패의 실제 오류문구를 일반 문구로 치환 | 확정 |
| SSH_PORTAL-D-0011 | RC-B-559 | test/windows-command-execution.test.mjs:22 — CLIXML 진행 기록만 있는 stderr 표시는 빈 문자열, 혼합 시 오류 문구만 남김, 원문은 호출자 소유. 장부: Windows 정상 명령 stderr에 CLIXML 진행 기록이 섞임 | 확정 |
| SSH_PORTAL-D-0011 | RC-B-604 | test/windows-ssh-integration.test.mjs:26(하위 시험 '한글·공백·양쪽 따옴표와 종료 코드') — 실제 SSH에서 stderr가 정확히 `예상 실패`일 것을 assert(부가 기록 없음). 직접 CLIXML 문구 assert는 아니므로 후보 | 후보 |
| SSH_PORTAL-D-0002 | RC-B-620 | test/windows-ssh-integration.test.mjs:26(하위 시험 '테스트 모드의 루트 우회') — bypassRoot 시 `rootPolicyApplied=='test-server-bypass'`로 허용 루트 밖 경로 publish·snapshot 성공, 일반 모드는 `PATH_OUTSIDE_ALLOWED_ROOT`. 장부: Windows 파일 전송에서 TEST 모드인데도 허용 루트 정책이 적용됨 | 확정 |
| SSH_PORTAL-D-0003 | RC-B-621 | test/windows-ssh-integration.test.mjs:26(하위 시험 '보조프로그램은 위험 경로…') — junction·symlink·ADS·장치명 등 12종 `UNSAFE_PATH`. 검사된 부모 핸들 결속을 직접 assert하지는 않아 후보. 장부: 경로 검사 뒤 leaf I/O를 검사된 부모 핸들에 결속할 필요 | 후보 |
| SSH_PORTAL-D-0003 | RC-B-619 | test/windows-ssh-integration.test.mjs:26(하위 시험 'WRITER-ACL-01/02/03') — 전송 후 ACL 불변·OS 권한 오류 진단. 부모 핸들 결속과는 간접 관계라 후보 | 후보 |
| SSH_PORTAL-D-0034 | RC-B-619 | test/windows-ssh-integration.test.mjs:26 — OS 거부가 `{errorCode:'PERMISSION_DENIED',diagnostic:{origin:'os',nativeStep:'open',nativeError:5}}`로 정책 거절과 구분됨. 장부: 파일 API가 권한·공간·I/O 오류를 하나의 안전거부로 뭉뚱그림 | 후보 |
| SSH_PORTAL-D-0034 | RC-B-615 | test/windows-ssh-integration.test.mjs:26 — 묵시적 덮어쓰기는 `DESTINATION_EXISTS`로 별도 오류 코드. 같은 장부 항목(오류 구분)과 관련 | 후보 |
| SSH_PORTAL-D-0034 | RC-B-616 | test/windows-ssh-integration.test.mjs:26 — 비관리자 elevate는 `PERMISSION_DENIED`로 구분. 같은 장부 항목과 관련 | 후보 |
| SSH_PORTAL-D-0005 | RC-B-605 | test/windows-ssh-integration.test.mjs:26(하위 시험 'ML-WIN') — Windows LF·CRLF 여러 줄 here-string 명령을 거절하지 않고 실행. 장부는 Linux heredoc 거절 결함이므로 Windows 대응 사례로 후보 | 후보 |
| SSH_PORTAL-D-0013 | RC-B-579 | test/windows-dispatch-binding.test.mjs:317 — 파일 helper 응답 유실이 `unknown`·`requiresReconciliation`로 보존되고 자동 재실행 없음. 장부: 작은 TEST 파일 다운로드가 transport_lost/unknown으로 종료된 과거 사례(OPEN). 현상 재현이 아닌 계약 고정이라 후보 | 후보 |

### G08 결함

| 결함 | 사례 ID | 근거(시험 줄, 장부 제목) | 구분(확정·후보) |
|---|---|---|---|
| SSH_PORTAL-D-0035 | RC-B-664, RC-B-665, RC-B-666, RC-B-667, RC-B-668, RC-B-669 | test/test_agent_cli.py:444~485: post-replace 영수증·ACK 실패와 롤백 뒤 completed 기록이 실제 active와 어긋나지 않는지(`STALE_COMPLETED_WITH_ROLLED_BACK_CURRENT`, `STALE_COMPLETED_AT_ROLLBACK_KILL`) assert. 장부 제목은 구형 v16 helper의 post-replace 실패·rollback 뒤 completed 잔류로, agent CLI 설치기와 같은 증상이나 대상 helper가 같은지는 확인하지 못함 | 후보 |
| SSH_PORTAL-D-0041 | RC-B-649, RC-B-650, RC-B-662, RC-B-663 (RC-B-672는 결정 D3-16으로 삭제 표로 이동) | test/test_agent_cli.py:69~: 시험 setUp이 `os.umask(0o077)`로 고정하고 정상 외부(foreign) 경로가 unsafe로 판정되지 않음을 assert. 장부 제목은 CLI helper 시험 fixture가 SSH umask0002를 상속해 정상 foreign 경로를 unsafe로 만듦 | 후보 |

### G09 결함

| 결함 | 사례 ID | 근거(시험 줄, 장부 제목) | 구분(확정·후보) |
|---|---|---|---|
| SSH_PORTAL-D-0032 | RC-B-722, RC-B-723, RC-B-724, RC-B-725 | test_environment_helper.py:54 중복 키 마지막 값 우선·미편집 바이트 보존, :74 중복 BRIDGE_MCP_PORT 마지막 값으로 health 호출, :89 재시작 시 capture→compare-baseline→release-baseline-verified 순서. 장부 제목: ENV helper의 중복 키 해석과 baseline 보존이 실제 실행 환경과 불일치 | 확정 |
| SSH_PORTAL-D-0032 | RC-B-743 | test_environment_helper.py:283 실제 helper·애플리케이션으로 BRIDGE_COMMAND_AUTOMATION 토글 후 baseline compare PASS 확인(실제 실행 환경과 일치 검증) | 후보 |
| SSH_PORTAL-D-0042 | RC-B-751, RC-B-752, RC-B-753 | test_compose_env.py:48,55,60 기본 BRIDGE_IMAGE가 제품 버전 태그와 일치해야 하고 이미지 값 교체 확인. 장부 제목(Docker archive 기본값·이미지 예시의 현재 버전 어긋남)과 관련은 있으나 시험이 직접 버전 어긋남을 다루지는 않음 | 후보 |

### G10 결함

| 결함 | 사례 ID | 근거(시험 줄, 장부 제목) | 구분(확정·후보) |
|---|---|---|---|
| SSH_PORTAL-D-0048 | RC-B-827 | test/test_linux_desktop_session.py:269 `test_unwritable_tmp_falls_back_for_session_root_and_reports_xvnc_start_failed`: /tmp 쓰기 불가 시 `DESKTOP_XVNC_START_FAILED` 코드만 보고. 장부: /tmp 권한 비정상 환경에서 DESKTOP_XVNC_START_FAILED 발생·원시 에러 코드 노출 | 확정 |
| SSH_PORTAL-D-0022 | RC-B-825, RC-B-826 | test/test_linux_desktop_session.py:249-267: 전체 기한 만료는 `DESKTOP_EXPIRED`, 단계 기한은 `DESKTOP_WINDOW_NOT_READY`·`DESKTOP_WINDOW_MANAGER_NOT_READY`·`DESKTOP_START_TIMEOUT`를 유지하는 assert. 장부: GUI 자원 만료와 세션 시작 timeout을 같은 오류로 취급 | 후보 |
| SSH_PORTAL-D-0020 | RC-B-824 | test/test_linux_desktop_session.py:117 xfreerdp3 인자에 `/kbd:unicode:on` 정확히 1개 assert(FreeRDP는 요청 없으면 Unicode 입력을 끔). test_prepare_freerdp_input.py는 번들 준비만 확인하며 입력 문자열을 assert하지 않아 연결 근거 없음. 장부: Windows RDP 긴 혼합문자 입력에서 누락·대소문자 변조 | 후보 |
| SSH_PORTAL-D-0042 | RC-B-856 | test/test_package.py:271 기본 Docker 아카이브명이 `.dockerignore`에서 허용되고 `dist/ssh-approval-portal-<version>.tar.gz`와 package.json 버전이 일치함을 assert. 장부: Docker archive 기본값·build context 허용 파일·이미지 예시의 현재 버전이 어긋남 | 확정 |
| SSH_PORTAL-D-0029 | RC-B-859 | test/test_release_package.py:171 서버·클라이언트 버전 불일치(`999.0.0`)를 `Server and client versions must match`로 거절. 같은 버전 검사 경계이며 2.x 새 minor/patch 후보를 거절하지 않는 별도 assert는 이 시험에 없음. 장부: 배포 버전 검사가 2.x의 새 minor/patch 정식 후보를 거절 | 후보 |
| SSH_PORTAL-D-0028 | RC-B-857 | test/test_release_package.py:87 배포 자산 4개의 매니페스트·체크섬·진입점 계약 assert(의존성 설치·import 포함). 의존성 URL 직접 assert는 없음. 장부: 미게시 2.3.1 후보에서 의존성 URL을 잘못 바꿔 배포 묶음 계약 실패 | 후보 |
| SSH_PORTAL-D-0014 | RC-B-860, RC-B-876 | test/test_prepare_freerdp_input.py:96 umask 077 프로세스에서 런타임 디렉터리 0755·실행 파일 0755·라이브러리 0644 assert, test/test_release_update.py:56 새 릴리스 디렉터리 0750·파일 0640. 장부: private umask로 준비한 릴리스 경로를 서비스 계정이 통과하지 못함 | 후보 |
| SSH_PORTAL-D-0034 | RC-B-813, RC-B-814, RC-B-817 | test/test_helper.py:84,92,100,144: 상위 없음 `PARENT_NOT_FOUND`·원본 없음 `FILE_NOT_FOUND`·staging `STAGING_UNAVAILABLE`·권한 `PERMISSION_DENIED`·기타 `OPERATION_FAILED`·크기 `FILE_TOO_LARGE`를 서로 구분하는 assert. 장부: 파일 API가 권한·공간·I/O 오류를 하나의 안전거부로 뭉뚱그림 | 후보 |
| SSH_PORTAL-D-0035 | RC-B-818 | test/test_helper.py:151 게시 이후 실패(fsync)는 권한 오류여도 `OPERATION_FAILED`이고 대상은 게시 상태로 남음 assert. 장부: 구형 v16 helper의 post-replace 실패·rollback 뒤 completed 기록 잔류(OPEN) | 후보 |
| SSH_PORTAL-D-0003 | RC-B-812 | test/test_helper.py:52 링크 leaf를 O_NOFOLLOW로 열면 ELOOP, snapshot은 `UNSAFE_PATH`. 장부는 Windows 경로 검사 뒤 leaf I/O를 검사된 부모 핸들에 결속할 필요로, Linux helper의 부모 fd 기반 동작과 같은 유형이나 Windows 직접 assert는 아님 | 후보 |

### G11 결함

| 결함 | 사례 ID | 근거(시험 줄, 장부 제목) | 구분(확정·후보) |
|---|---|---|---|
| SSH_PORTAL-D-0001 | RC-B-903 | windows-file-helper.tests.ps1:298~311(주석 302: baseline은 policy/UNTRUSTED_OWNER로 실패해야 함). 외부 소유자(`S-1-5-32-545`) 부모의 TEST snapshot(bypassRoot)이 성공해야 함. 장부: Windows TEST가 SSH로 읽을 수 있는 GUI 생성 파일 다운로드를 UNTRUSTED_OWNER로 거절 | 확정 |
| SSH_PORTAL-D-0001 | RC-B-904(삭제 표로 이동, 결정 D3-16) | windows-file-helper.tests.ps1:318·323·324. 같은 외부 소유자 시나리오에서 일반 모드·publish는 정책 거절 유지(TEST 우회만 허용). D-0001 수정의 범위 경계. 3.0은 소유자 신뢰 검사를 내지 않는다(결정 D3-02 (a)) | 후보 |
| SSH_PORTAL-D-0001 | RC-B-905(삭제 표로 이동, 결정 D3-16) | windows-file-helper.tests.ps1:332·334. 보호 루트 외부 소유자 거절 유지(FO-SNAPSHOT-03). D-0001 수정의 범위 경계. 3.0은 소유자 신뢰 검사를 내지 않는다(결정 D3-02 (a)) | 후보 |
| SSH_PORTAL-D-0001 | RC-B-906 | windows-file-helper.tests.ps1:376~378. 소스에 READ_CONTROL이 없어도 TEST snapshot 성공(FO-SNAPSHOT-04). UNTRUSTED_OWNER 판정을 소유자 조회 없이 하도록 한 수정의 변형 | 후보 |
| SSH_PORTAL-D-0002 | RC-B-921 | windows-file-helper.tests.ps1:742·743·747. bypassRoot(TEST)에서 설정 루트가 사용 불가여도 외부 publish·snapshot 성공, rootPolicyApplied `test-server-bypass`. 장부: Windows 파일 전송에서 TEST 모드인데도 허용 루트 정책이 적용됨 | 확정 |
| SSH_PORTAL-D-0002 | RC-B-913 | windows-file-helper.tests.ps1:645. 기본 요청은 rootPolicyApplied `configured-root`로 정책 적용(TEST 우회와 대비) | 후보 |
| SSH_PORTAL-D-0002 | RC-B-920 | windows-file-helper.tests.ps1:722·723. 일반 모드는 PATH_OUTSIDE_ALLOWED_ROOT, allowedRoot는 설정에서만 | 후보 |
| SSH_PORTAL-D-0003 | RC-B-908 | windows-file-helper.tests.ps1:446~463. snapshot 중 부모·leaf 이름 변경·reparse 치환 경합에서 고정(pinned)된 원본 바이트만 보고하거나 안전 거절. 장부: Windows 경로 검사 뒤 leaf I/O를 검사된 부모 핸들에 결속할 필요 | 확정 |
| SSH_PORTAL-D-0003 | RC-B-907 | windows-file-helper.tests.ps1:418. junction·symlink·hardlink·ADS 소스는 UNSAFE_PATH, 원본·decoy 바이트 불변(경로 검사와 I/O 결속의 정적 면) | 후보 |
| SSH_PORTAL-D-0003 | RC-B-923 | windows-file-helper.tests.ps1:938. stage 심볼릭 링크 cleanup이 링크 대상을 건드리지 않음 | 후보 |
| SSH_PORTAL-D-0034 | RC-B-912 | windows-file-helper.tests.ps1:835~840(다중 줄 833·400·403). 실제 OS 접근 거부는 origin `os`·nativeStep `open`·nativeError 5로 policy 거절과 구분. 장부: 파일 API가 권한·공간·I/O 오류를 하나의 안전거부로 뭉뚱그림 | 확정 |
| SSH_PORTAL-D-0034 | RC-B-901 | windows-file-helper.tests.ps1:105·106. 오류 코드 11종을 정확히 구분해 반환 | 후보 |
| SSH_PORTAL-D-0034 | RC-B-909 | windows-file-helper.tests.ps1:496. 쓰기 권한이 inherit-only뿐인 부모에서 정책 거절 없이 성공 구분 | 후보 |
| SSH_PORTAL-D-0034 | RC-B-910 | windows-file-helper.tests.ps1:779. 공유 create-only 부모에서 정책 거절 없이 성공 | 후보 |
| SSH_PORTAL-D-0034 | RC-B-911 | windows-file-helper.tests.ps1:813. 상속된 생성 권한 부모에서 정책 거절 없이 성공 | 후보 |
| SSH_PORTAL-D-0014 | RC-B-927 | container-test.sh:102, portal-container-test.sh:106. root 설치 뒤 서비스 계정으로 기동·health·SSH 왕복 성공 단언(릴리스 경로 통과 여부의 간접 검증). 시험 이름·주석에 umask 언급은 없음. 장부: private umask로 준비한 릴리스 경로를 서비스 계정이 통과하지 못함 | 후보 |
| SSH_PORTAL-D-0042 | RC-B-926 | driver-common.test.ps1:10~17. 기본 아카이브가 현재 버전 dist 아카이브와 동일, 명시 아카이브 유지, 없는 아카이브 거부. 장부: Docker archive 기본값 ... 현재 버전이 어긋남 | 후보 |
| SSH_PORTAL-D-0047 | RC-B-931 | container-test.sh:90, portal-container-test.sh:94. 시작에 실패하는 후보 update 거부 뒤 서비스 active·health 유지(잠금 잔류 없음). 장부: install.sh 중단 시 maintenance 잠금 영구 잔류 | 후보 |
| SSH_PORTAL-D-0047 | RC-B-939 | compose-update-ci.sh:183~195. 갱신 단계별 실패 7종에서 maintenance 소유 파일을 보고·보존하고 단계별 maintenance 상태(true/false)를 확인 | 후보 |
| SSH_PORTAL-D-0047 | RC-B-940 | compose-update-ci.sh:199. 복구 명령의 owner 경로 정규화 검사 | 후보 |
| SSH_PORTAL-D-0047 | RC-B-941 | compose-update-ci.sh:202·230. 환경 변경 시 복구 거부(maintenance 유지) | 후보 |
| SSH_PORTAL-D-0047 | RC-B-942 | compose-update-ci.sh:211·234. 확인된 복구 뒤 owner 파일 제거·maintenance 해제 | 후보 |
| SSH_PORTAL-D-0047 | RC-B-943 | compose-update-ci.sh:220. 확인되지 않은 재시작 뒤 복구 거부, owner 유지 | 후보 |
| SSH_PORTAL-D-0047 | RC-B-944 | compose-update-ci.sh:242. 모호한 복구 거부, owner 유지 | 후보 |
| SSH_PORTAL-D-0047 | RC-B-945 | compose-update-ci.sh:250. 보존된 owner로 compare 뒤 release해 maintenance 해제 | 후보 |
| SSH_PORTAL-D-0047 | RC-B-946 | compose-update-ci.sh:261·265. 동시 구성 변경 시 `maintenance retained.` 메시지·maintenance true 유지 | 후보 |
