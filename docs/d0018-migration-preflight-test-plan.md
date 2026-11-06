# D0018 migration 전체 충돌 사전 검사

engineering-test-plan: SSH_PORTAL-D-0018, 기준 `cee89137d47f2e5765aa73d583e2e8727af32e0b`.

요구: 두 legacy source와 기존 canonical store의 ID·요청 키·원본 증거 충돌은 기존 `OPERATION_KEY_CONFLICT`로 거부한다. 키를 변조하지 않는다. 충돌을 발견하기 전에 이번 migration의 앞행을 canonical에 부분 추가하지 않는다. 기존에 정확히 수입된 이력과 원본 bytes는 보존한다. 중간 I/O 장애의 전체 migration 원자성은 이번 요구가 아니다.

공개 경계는 `migrateLegacyOperations`와 `createOperationStore`다. 기존 `node:test` runner와 실제 임시 SQLite 파일을 사용하며 DB mock은 없다. fixture는 각 사례가 소유한 `os.tmpdir()` 하위 폴더에 만들고 종료 후 정리한다. 서비스·운영 DB·실제 과거 TEST 원본은 변경하지 않는다.

| 사례 | 입력·선행 조건 | 절차 | 기대 결과·합격 기준 | 실제 결과 |
| --- | --- | --- | --- | --- |
| C18-01 | 두 source에 다른 ID, 같은 명시 요청 키. 빈 canonical store | 공개 migration 호출, 종료 후 원본/archive 및 canonical 검사 | `OPERATION_KEY_CONFLICT`; 신규 row/event/budget 0; 원본 bytes 동일; archive 생성 전 거부 | NOT_RUN |
| C18-02 | 두 source에 같은 ID, 다른 요청 키. 빈 canonical store | 공개 migration 호출 후 두 키와 ID 조회 | 동일 오류; 신규 row/event/budget 0; 원본 bytes 동일 | NOT_RUN |
| C18-03 | 첫 source 129행, 두 번째 source 1행. 두 번째 source와 기존 canonical의 key/ID/original/digest/source 중 한 축만 충돌 | 다섯 하위 사례 각각 기존 row/event/budget snapshot 후 migration 호출 | 동일 오류; 앞선 129행도 추가 0; 기존 row/event/budget 및 원본 bytes 동일 | NOT_RUN |
| C18-04 | 충돌 없는 두 source 중 앞행만 이미 정확히 import됨 | migration 호출, 재호출, existing event 및 원본 비교 | 미수입 행만 추가; 기존 event 불변; receipt·retained budget 동일; queued row 0; 원본/archive bytes 동일 | NOT_RUN |
| C18-05 | 한글·emoji·NFC/NFD를 포함한 서로 다른 요청 키와 원본 body | migration 호출 및 같은 archive/target 재검증 | 문자열·원본 객체 정확 보존; 다른 Unicode 키 합치기 0; 재실행 추가 event 0 | NOT_RUN |

oracle은 fixture에 직접 정한 ID·키·객체와 독립적으로 보관한 원본 파일 bytes, 공개 store 조회 및 이벤트·용량 계수다. 피검사 변환으로 기대값을 만들지 않는다. 실패는 오류 코드만 맞아도 통과하지 않으며, 앞선 행이 하나라도 추가되면 실패다.

TEST 실행 명령: `node --test test/operation-migration-preflight.test.mjs test/operation-migration-180.test.mjs test/operation-migration-batch.test.mjs test/operation-migration-retained-budget.test.mjs test/deploy180-migration-stdin.test.mjs`.

engineering-test-proof: 부모 담당자가 지정 TEST 서버의 격리된 기준 사본에 같은 신규 테스트를 적용해 RED를 확인하고, 수정 후보로 GREEN을 확인한다. 테스트 파일·명령은 동일하게 고정한다. 로컬 제품 시험은 실행하지 않는다. 원 TEST receipt의 정확 원인(전역 요청 키 충돌, 기존 partial canonical 불일치, 인코딩)은 이 합성 회귀만으로 확정하지 않는다. 기존 split-stdin 시험은 인코딩 경계를 별도로 검증한다.

engineering-test-result: 전체 NOT_RUN. 이 문서는 테스트 작성 전에 사례·합격 기준을 고정한 계획이며 실행 결과가 아니다.
