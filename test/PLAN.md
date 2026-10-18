# 검증 계획

이 문서는 시험의 목적과 필요한 근거를 정리합니다. 실행 결과표가 아니며, 아래 명령이나 사례가 적혀 있다는 이유만으로 통과를 뜻하지 않습니다. 최종 후보의 해시·환경·명령·종료 코드·원시 결과를 함께 기록합니다.

## 기본 명령과 실행 범위

```sh
npm ci --ignore-scripts
npm run build:ui
npm test
npx playwright install chromium
npm run test:browser
python3 test/test_helper.py
node scripts/verify.mjs
```

의존성 설치·전체 빌드·패키지 검증은 조정된 단일 실행으로 수행합니다. `verify`는 현재 후보로 생성한 manifest가 있어야 의미가 있으며 시험 결과나 의존성 목록의 완전성을 대신하지 않습니다. 브라우저·Linux·설치 환경의 시험은 각 전용 driver와 전제 조건을 확인한 뒤 실행합니다.

## 관측 가능한 동작

| 경계 | 필수 관측 |
| --- | --- |
| 승인 큐 | 사용자 승인 전 executor 0회, 감사 저장 뒤 실행, 중복 승인 1회, ticket kind/id/hash/target/flags/expiry 결속, 만료 시 감사 실패에도 재실행 불가 |
| 즉시 읽기·오류 | executor rejection 정규화, read-failed terminal 감사 시도, 내부 오류 비노출, health callback 예외의 제어된 503과 프로세스 생존 |
| 파일 저장소 | 실제 바이너리·빈 파일의 바이트와 SHA-256 일치, 중복·오순서·해시 불일치·기한·파일 한도·저장 총량, 완료·실패·거부·만료·종료의 해제 |
| 파일 전송 | vendor와 분리된 transport 성공·실패·정리, 승인 전 원격 쓰기 없음, 승인 후 한 번 실행, 최종 반영 불명확 시 자동 재시도 없음 |
| HTTP·MCP | 실제 loopback StreamableHTTP, Bearer·Origin, UI 기본 비활성화, 공개 응답과 도구별 출력 스키마, app-only·비공개 메타데이터의 경계 |
| 관리자 인증 | token/access의 session·static·API·maintenance·file GET/HEAD 정책, 정확한 소유자·capability 조합, 잘못된 자격과 bearer fallback 거부 |
| 카드·웹 | 화면 교체 뒤 오래된 업로드·상태 응답 무시, 새 파일 선택 보존, 무관한 polling 갱신에서 포커스·선택·스크롤 보존, 실제 브라우저 실행 |
| 공통 설정 | JavaScript·Python의 canonical HTTPS origin·허용 키·기본값·1–65535 포트 계약 일치, native 시크릿의 원자적 교체와 기존 값·모드·소유권 보존 |
| 배포 도구 | 비기본 MCP/admin 포트의 maintenance·health·업데이트·복원, prepare 재실행의 이미지·추가 설정 보존, 중첩 production 의존성의 name@version notice 목록 |

## Linux·설치·파일 helper

파일 helper는 Linux 임시 디렉터리에서 실제 바이너리·빈 파일 업다운로드, overwrite=false, mode와 SHA 불일치 시 기존 파일 보존, symlink·FIFO·디렉터리 거부를 확인합니다. root/sudo 경계는 격리된 설치 시험으로 따로 확인합니다.

Ubuntu 22.04/24.04의 네이티브·Docker·Compose는 fresh·update·reinstall·failed-start·rollback과 실제 격리 SSH 파일 왕복을 확인합니다. 각 검증은 합성 설정·데이터를 사용하고 현재 운영 서비스나 자격을 사용하지 않습니다. 현재 1.0.0 릴리스 범위는 amd64이며 ARM64 검증은 사용자 지시로 후속 고도화에 이관했습니다. Windows·WSL·ARM64 에뮬레이션과 실제 ARM 하드웨어 결과를 구분합니다. 실행하지 않은 환경은 NOT_RUN으로 남깁니다.

Windows의 Docker driver는 `package.json` 버전에 맞는 `dist/ssh-approval-portal-VERSION.tar.gz`를 기본으로 사용합니다. 패키지 생성 후 `pwsh -File test/driver-common.test.ps1`로 기본 경로·명시 경로·누락 파일 거부를 확인합니다. 실제 Docker·Compose 검사는 각 `test/docker-runtime.ps1`·`test/compose-runtime.ps1`에서 수행합니다. Compose 시작 실패 시 합성 서비스 로그와 health 기록을 정리 전에 남기며 원래 실패 코드는 유지합니다. 구버전 기준 이미지는 해당 설정을 지원해야 합니다. 새 키를 모르는 이미지의 설정 검증을 우회하거나 키를 자동 삭제하지 않습니다.

Compose 갱신 검사는 같은 후보의 SSH 프로토콜 검사 클라이언트로 기준 버전과 후보 서비스를 각각 검사합니다. 검사 클라이언트는 별도 제한 컨테이너에서 합성 시크릿만 읽으며 Docker socket을 받지 않습니다. 구버전 이미지에 포함된 옛 테스트의 자동승인 가정을 적용하지 않고 기본 다운로드의 owner 승인을 실제로 수행합니다.

이 합성 보존 사례에서만 서비스 시작 전에 명령 정책·journal 기능을 활성화합니다. 기준 서비스에 비기본 정책을 검토·저장하고, 완료 명령과 저장 출력의 owner API 응답을 private fixture volume에 digest로 보관합니다. 갱신·명시적 rollback·재갱신·비기본 포트·시작 실패 복구 뒤 정책 revision/규칙·기존 명령·실제 출력 읽기와 SSH config 원문 일치를 검사합니다. 서비스에는 이 proof 경로를 마운트하지 않으며 live SQLite의 exclusive lock을 우회하지 않습니다.

## 에이전트 파일 입력과 실제 클라이언트

OpenAI fileParams의 필수 `download_url`·`file_id`와 선택 `mime_type`·`file_name`을 구분합니다. opaque `file_uuid`나 빈 주소는 지원하지 않습니다. URL·파일 바이트·티켓이 일반 응답·audit에 나타나지 않는지 확인합니다. 입력 취소·큐 실패·유지보수·실제 HTTP 연결 종료·서비스 종료에서 staging과 예산 정리를 검사합니다.

HTTPS source는 allowlist·SSRF·전체 DNS 검증과 연결 고정·redirect·압축·크기·시간 제한·취소를 공개 경계에서 시험합니다. 주입한 네트워크 시험과 실제 공개 HTTPS 가져오기를 구분합니다. stateless MCP의 별도 POST 취소를 실제 연결 종료와 같다고 가정하지 않습니다.

과거 ChatGPT 웹·Claude 데스크톱의 PC 카드 왕복은 새 플랫폼 파일 입력 검증을 대신하지 않습니다. 새 ChatGPT 입력은 source 설정 거부 응답까지 실제 관측했으며 전체 fetch·승인·왕복은 미확인입니다. Claude 입력은 UUID·빈 URL로 실패했고 sandbox HTTPS egress도 proxy CONNECT 403으로 막혔습니다. 외부 접근 허용이나 우회 성공을 가정하지 않습니다.

실제 플랫폼 입력·Library·Portal 메타데이터, 각 클라이언트의 승인·저장, Cloudflare·Google·GitHub 로그인과 실제 ARM 하드웨어는 대상 환경의 개별 기록이 있어야 PASS로 기재합니다. 이번 로컬 구조 변경은 공개 릴리스나 운영 배포 완료를 뜻하지 않습니다.
