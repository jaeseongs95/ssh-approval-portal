# MCP 계약 시험의 1.8 대응

`mcp-contracts.test.mjs.17`은 후보 `ea65c55b5c3f8e3993f815165bdf34f59816d659`의 1.7 시험 18개를 바이트 그대로 보관한다. SHA-256은 `3f0bdd226ff026d77ce6a9510a94ade63ea4e153da7a11c2390baf38cc43eaa1`이다. `.17`은 실행 대상이 아니다.

활성 `test/mcp-contracts.test.mjs`의 14개 시험은 실제 HTTP와 SDK를 통해 1.8의 9개 공개 도구를 검사한다. 아래 번호는 각 파일의 최상위 `test` 순서다.

| 보관본 번호 | 보존한 경계와 1.8 활성 시험 |
| --- | --- |
| 1 | 명령 5 KiB/32 KiB와 경로를 담은 설명: 1, 9 |
| 2 | 잘못된 설명·비밀·미호출·오류 비반사: 2 |
| 3 | 공개 도구 이름·JSON text·private UI·공개 envelope: 3, 10, 13 |
| 4 | 벤더 독립·읽기 전용 discovery·UI 비활성: 4 |
| 5 | 실제 SDK JSON schema의 draft-07/2020-12 호환: 5 |
| 6 | 제거된 client setup 경로 선택을 서버 `targets` discovery로 대체: 3, 4. 제거된 도구의 부재도 검사 |
| 7 | setup 입력 검사는 제거된 API 계약. 새 submit의 unknown field·필수 payload·key 검사는 6 |
| 8 | 로컬 setup을 안내하던 구형 파일 도구 제거. 3, 4에서 부재와 서버 limits/승인주체를 검사하고 실제 전송은 `remote-mcp-upload.test.mjs`, `mcp180-bytes.test.mjs`에서 검사 |
| 9 | text-only UTF-8 페이지·상태 분리·크기·digest·만료 메타데이터: 7, 8. 만료된 출력 상태는 `mcp180-bytes.test.mjs`의 상태 projection 시험 |
| 10 | app 전용 canonical base64 chunk: 10 |
| 11 | health callback 예외의 503와 서버 유지: 11 |
| 12 | 웹 JSON과 승인 완료 대기: 12 |
| 13 | 다운로드 파일명 공개와 URL의 private metadata 결속: 13 |
| 14 | 선택 설명 8192자 보존·8193자 거부: 1, 2 |
| 15 | command-only 구형 envelope는 공개 1.8 API에서 제거. 3에서 구형 도구 부재, 6에서 native strict 입력 검사. 내부 호환 parser의 직접 회귀는 `execution-context.test.mjs`에 유지 |
| 16 | 실제 package version의 health/MCP 초기화: 14 |
| 17 | 영어 평가 설명과 한국어 사용자 설명의 분리·원문 보존: 1, 2 |
| 18 | 실제 HTTP command 바이트 경계·overflow·source 크기: 1, 9 |

1.8의 신규 관측 경계는 7에서 lookup 단일성·명시 출력·대기 timeout의 비취소를, 8에서 backing port가 페이지를 반환해도 status 응답에 본문을 숨기는 것을 검사한다. 후자는 TEST 후보 `0df64e0`의 별도 복사본에서 출력 guard 제거 mutation을 검출했다. 이 증거는 해당 후보에만 해당하며 최종 후보의 재시험을 대신하지 않는다.
