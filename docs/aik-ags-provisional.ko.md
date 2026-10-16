# AIK·AGS 임시 연결 시험

AIK 리드와 총괄이 확인한 현재 경계에 맞춘 합성 시험이다. 합의된 AIK↔AGS↔SSH 공통 계약과 전용 적합성 시험은 아직 없다. 이 fixture는 제품 구현이나 실제 AIK/AGS 연동 인증을 대신하지 않는다.

- AIK: `AuthorityGateway.request(session, ToolCall)` 형태를 임시 포트로 표현한다. `ToolSession`은 프로세스 내부 객체이며 원격 토큰으로 직렬화하지 않는다. 실제 인가 검사·effect journal·fencing은 구현하지 않는다.
- AGS: `cli.call(operation, payload)`, `{host,sessionId}`, `aik.peer.v1`의 task 본문, broker 발급 ID를 사용한 prepare→intent→send 순서를 임시 포트로 표현한다. 현재 전송 본문 4,096 UTF-8 바이트 제한을 적용한다. 실제 CLI 프로세스·broker·영속 journal은 실행하지 않는다.
- SSH: 실제 연결·명령 실행을 하지 않는다. ACK와 Jev 판정은 owner 승인이나 업무 완료로 변환되지 않는다. 불명 전송을 자동으로 재시도하지 않는다. 세 시스템 ID 매핑은 시험용 가정이다.

정본은 AIK의 `docs/ags-peer.ko.md`, `docs/authority.ko.md`, `contracts/upstream/integration-contract.json`, `contracts/upstream/task-execution-binding.schema.json`이다. upstream binding은 실행 권한 토큰이 아니며, 런타임 연동 검증은 미완료다.

`node --test test/aik-ags.test.mjs`는 외부 호출 없이 경계를 검사한다. Node 24 Cloud의 `JEV_API_KEY` 개인용 네트워크 시크릿을 `api.typesafe.ai`에 바인딩한 뒤, 명시적으로 `node scripts/probe-aik-ags-jev.mjs NEW_REPORT.json`을 실행하면 실제 SSH MCP의 `run-command` → `assess-request-risk`와 기존 Jev 어댑터를 통해 합성 사례를 최대 세 번 직접 호출한다. SSH 실행기는 시험용이며 호출되면 실패한다. 응답 실패 시 다음 사례를 중단하며 재시도하지 않는다. 기존 보고 경로는 덮어쓰지 않는다.

Codex Cloud에서는 상속한 프록시·CA와 TLS 검증을 유지하고 `node --use-env-proxy scripts/probe-aik-ags-jev.mjs NEW_REPORT.json`으로 실행한다. loopback MCP를 사용할 때는 기존 `NO_PROXY`/`no_proxy` 항목을 보존하면서 `127.0.0.1`과 `localhost`만 추가한다. 별도 실행기의 지원된 네트워크 권한도 필요할 수 있다. 기본 sandbox의 프록시 연결 실패를 TypeSafe 인증 실패로 해석하지 않는다.

키·placeholder는 명령 인자나 보고에 남기지 않는다. 이 probe는 소수의 연결 확인이며 모델 품질·임계값을 검증하지 않는다. 운영 승인 정책과 자동 실행은 바꾸지 않는다.

## 실제 SSH MCP 사용 경로

서버가 `BRIDGE_JEV_ENABLED=true`와 `JEV_API_KEY`를 공급한 경우, MCP 사용자는 대기 중인 명령 요청의 ID로 `assess-request-risk`를 호출할 수 있다. `externalDisclosureApproved=true`는 정확한 명령·대상 ID/표시명·선택적 context를 TypeSafe로 전송함을 명시한다. SSH 사용자·주소·키·명령 실행 결과는 이 경로의 전송 필드에 포함하지 않는다. 명령이나 context에 비밀을 넣어 평가하지 않는다.

Cloud의 네트워크 시크릿 placeholder는 그 프록시에서만 사용할 수 있다. 이를 네이티브 시험·운영 서버의 키로 복사하지 않는다. 실제 서버에 적용할 때는 서버의 비밀 관리 경로에서 `JEV_API_KEY`를 주입하고, 시험 서버의 명시적 관측부터 확인한 뒤 운영 opt-in을 적용한다. 이번 Cloud 시험은 두 서버에 대한 배포가 아니다.

평가는 서버가 보관한 원 요청의 대상 ID·설정 revision·subject digest에 묶인다. 호출자가 대상을 새로 지정할 수 없다. 첫 평가의 context와 결과를 프로세스 메모리에 유지하며, 같은 요청을 동시에 호출하거나 다시 조회해도 API를 재호출하지 않는다. 실패 결과도 보관한다. `BRIDGE_JEV_MAX_CALLS`는 프로세스당 시도 수 상한(기본 100, 허용 1~10000)이며 재시작하면 초기화된다. 영속 일일 예산이 아니다. 기본 기능은 꺼져 있다.

Jev 장애·시간 초과·예산 소진은 `unavailable`로 반환한다. 기존 요청 상태와 owner 승인 요건은 유지된다. 평가 조회는 승인·거절·명령 실행을 수행하지 않는다. 현재는 명시적인 MCP 관측 도구이며 승인 화면의 평가 표시와 영속 감사 기록은 후속 연결 대상이다. 모델 임계값 검증과 자동 승인 정책은 별도 단계다.
