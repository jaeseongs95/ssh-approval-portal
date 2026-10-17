# Jev 명령 위험 관측·평가

이 문서는 v1 관측·평가 계약을 설명한다. 선택적인 명령셋·v2 위험 평가 실행 경로는 [명령 자동 실행](command-automation.ko.md)을 따른다. v1 후보 임계값과 평가 결과는 v2 자동 실행의 검증 근거로 승계하지 않는다.

4단계의 구현은 독립 평가 도구입니다. 중계기·관리자 화면·MCP 승인 큐에는 연결하지 않습니다. Jev 응답이나 `candidateMatch`가 실행 권한을 만들지 않으며, `automaticExecutionEnabled`와 `stage5Ready`는 항상 `false`입니다. 기존 명령·파일 승인 동작은 그대로입니다.

## AGS·AIK와의 역할

총괄과 AIK 리드에게 확인한 현재 경계는 다음과 같습니다.

- AGS는 `noul` 기반 스킬 추천과 에이전트 최종 선택을 다룹니다. SSH 명령 안전성용 공통 계약과 검증된 임계값은 없습니다.
- AIK는 `noul/choice/score` 클라이언트와 Choice 스킬 추천을 구현했습니다. Python 구현이며, 추천 실패에도 요청을 진행하는 흐름을 SSH 자동 실행에 가져오지 않습니다.
- 재사용할 원칙은 요청·관측 모델 버전 결속, 응답 검증, 사용량·고정 오류 코드 기록입니다. 스킬 추천 라벨과 SSH 위험 라벨·정답·평가 책임은 분리합니다. 공통 배포 패키지나 호환 API가 있다는 가정은 하지 않습니다.

## 계약과 한도

`src/domain/safety.mjs`는 공급자 중립 입력과 결과를 정의합니다. 입력은 `command`, `target`, `environment`, `context` 네 필드입니다. 결과는 `low_risk / high_risk / uncertain`, 확률 분포, 신뢰도, 관측 모델, 토큰 사용량입니다. 낮은 위험도는 실행 허가를 뜻하지 않습니다. 알려지지 않은 동작·민감도는 `uncertain`으로 분류합니다.

TypeSafe 어댑터는 [공식 Choice 계약](https://docs.typesafe.ai/primitives/choice)과 [HTTP API](https://docs.typesafe.ai/api)를 사용합니다. 기본 관측 모델은 이동 별칭 대신 `jev-1.14.0`, 질문은 `ssh-command-risk-v1`, 어댑터는 `typesafe-choice-v1`로 고정합니다. 명령 자동화에서는 사용자가 위험도 확인 후 저장한 판본으로 실제 호출하며, 응답 판본도 정확히 일치해야 합니다. 모델 판본 변경만으로 판정 성능이 검증됐다고 간주하지 않습니다.

- 목적지는 `https://api.typesafe.ai/v1/systemone`으로 고정합니다. 리다이렉트·자동 재시도·대체 모델 호출은 없습니다.
- 요청 본문 최대 24 KiB, 각 입력 필드 최대 4,096자, 응답 최대 64 KiB입니다. 헤더와 본문 수신을 합쳐 기본 10초 제한을 적용합니다.
- 어댑터당 동시 호출은 1개입니다. 중복 호출은 큐에 넣지 않고 `busy`로 거절합니다. 시간초과 후에도 전송이 종료되지 않았다면 슬롯을 유지합니다. 프로세스 간 중복 제거 기능은 없습니다.
- CLI는 저장소에 포함된 합성 사례 20개만 순서대로 평가합니다. 임의 입력 파일·실제 SSH 요청·서비스 설정·키 파일은 읽지 않습니다. 명령은 분류용 문자열이며 셸에서 실행하지 않습니다.
- API 키는 `TYPESAFE_API_KEY` 환경변수로만 받습니다. 결과에는 원시 명령·문맥·응답 본문·HTTP 오류·키를 기록하지 않습니다. 입력 필드 화이트리스트는 자동 비밀 제거기가 아닙니다. 향후 실제 데이터 관측에는 별도 전송 허용 정책이 필요합니다.
- 실패·시간초과는 `unavailable`입니다. 원시 오류 대신 고정 오류 코드만 남깁니다. 타임아웃은 공급자가 처리하지 않았거나 요금을 청구하지 않았다는 뜻이 아닙니다. 사용량이 없는 실패는 총 사용량을 확정할 수 없습니다. 금액은 `actualCostUsd: null`이며 금액 상한을 집행하는 기능은 없습니다.

## 로컬 모의 평가

Node 24에서 실행합니다. 새 의존성은 필요 없습니다.

```sh
node --test test/safety.test.mjs
node scripts/evaluate-safety.mjs --mode replay --out safety-replay-001.json
```

모의 파일은 잘못된 예측과 응답 실패를 의도적으로 포함합니다. 20건 중 19건 응답, 16건 정답, 3건 오판, 1건 판단 불가, 후보 조건의 오탐 2건이 예상됩니다. 이 숫자는 집계기 검증용이며 Jev 정확도가 아닙니다. `source: simulated`, `modelQualityStatus: NOT_MEASURED`로 기록합니다.

## Codex Cloud Node 24에서 실측

이 구현이 포함된 작업 사본과 기존 비밀 환경변수 `TYPESAFE_API_KEY`가 있는 환경에서 실행합니다. 키를 채팅이나 명령행 인자에 붙이지 않습니다.

```sh
node --version
node scripts/evaluate-safety.mjs --mode live --out safety-live-001.json
```

이 명령은 합성 사례만 외부 TypeSafe API로 최대 20회 전송합니다. 새 실행은 별도 과금될 수 있습니다. 기존 출력 파일은 덮어쓰지 않으며 출력 경로를 먼저 확보한 뒤 호출합니다. 종료 코드 `0`은 전 사례 응답, `1`은 판단 불가 포함, `2`는 실행 준비·기록 실패입니다. **종료 코드 0도 모델 품질 통과나 자동 실행 허가를 뜻하지 않습니다.**

실행 결과에는 run ID·시작/종료 시각·corpus 원본 digest·질문/정책 digest·실행 소스 파일 digest·요청 모델·사례별 판정·오판·혼동 행렬·후보 오탐·관측 토큰을 남깁니다. 정답과 설명은 모델 입력에서 제외합니다. 실측은 `source: live`, `modelQualityStatus: UNVALIDATED`로 기록합니다.

## 계약에 맞춘 임시 HTTP 서버 시험

```sh
node --test test/safety-http.test.mjs
```

시험이 `127.0.0.1`의 임의 포트에 서버를 만들고 종료 시 정리합니다. 실제 Jev 키는 읽지 않고 합성 토큰만 사용합니다. 제품 어댑터의 목적지는 그대로 고정하며, 테스트에 주입한 연결 함수만 로컬 서버로 연결합니다. CLI에 임의 endpoint 설정은 추가하지 않습니다.

임시 서버는 제품 encoder/validator를 import하지 않고 POST·Bearer·model·state·Choice 질문/답변 키를 별도로 검사합니다. 실제 Node HTTP/fetch로 20개 합성 사례, 분할 응답, 잘못된 모델·답변, 401/429/500/529, redirect 거절, 응답 크기 초과, 헤더/본문 지연과 취소 뒤 복구를 확인합니다. AGS의 스킬 추천 라벨은 SSH 위험 질문 계약에서 거절합니다.

`runSafetyEvaluation()`에 `fetchImpl`을 주입하면 `transport: injected`, `source: simulated`, `modelQualityStatus: NOT_MEASURED`로 기록합니다. 실제 HTTP 왕복을 했더라도 모델 실측으로 표시하지 않습니다. 기본 연결을 사용한 명시적 live 실행만 `transport: typesafe-https`가 됩니다. 이 테스트는 TypeSafe의 외부 TLS·모델 품질·과금을 검증하지 않습니다.

## 5단계 진입 조건

현재 corpus는 개발용 합성 smoke 사례이며 독립적인 품질 평가셋이 아닙니다. 실제 Jev 평가와 정답의 독립 검토가 끝나지 않았습니다. 후보 임계값 `P(low_risk) >= 0.999`, `confidence >= 0.99`는 집계 동작을 확인하기 위한 미검증 값입니다. 신뢰도는 안전성 보증이나 승인 확률이 아닙니다.

5단계 이전에 독립적인 정답·분리된 평가 사례·셸 우회와 환경별 반례·오탐 허용 기준·질문/모델/정책 판본·비용 예산을 고정하고 실제 결과를 독립 검토해야 합니다. 기존 AGS/AIK 스킬 평가 결과를 이 검증으로 대체하지 않습니다. 그 뒤에도 자동 실행 권한은 관리자의 명시적 정책에서만 나옵니다.
