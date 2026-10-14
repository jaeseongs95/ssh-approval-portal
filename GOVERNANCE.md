# 구현·검증 작업 기록

사용자 승인 설계: SSH Approval Portal 0.3.0 명령 승인 UI, 웹 승인 유지, 파일 전송, Ubuntu 설치·업데이트 패키지.

Agent Governance Suite를 직접 스킬 경로로 적용한다. 구현 위임은 하지 않고, 고위험 후보 검토는 fresh context 독립 감사자로 분리한다. MCP guarded workflow 완료나 외부 클라이언트 검증을 실제 관측 없이 주장하지 않는다.

| 순서 | 전문 스킬 | 입력·산출물 | 진행 조건 |
|---|---|---|---|
| 1 | orchestrator | 사용자 설계와 이 작업 기록, 직접 구현 + audit-only 경로 | 범위는 이 디렉터리, 기존 서버는 승인된 배포 전 변경하지 않음 |
| 2 | ponytail | 기존 core, SSH 라이브러리 → typed queue·UI·전송·설치 코드 | 새 추상화·서비스 없이 기존 SSH 계정과 연결 재사용 |
| 3 | test-engineering | 수용 기준 → Node/Python/Linux 및 패키지 검증 근거 | 실패 경계·바이트 일치·중복 실행 검증 |
| 4 | mutation-risk-preflight | 고정 후보·서버 기준 상태·복구 계획 | 실제 서버 변경 직전에 사용자 승인 포털 사용 |
| 5 | independent-audit-gate | 후보 해시·원시 테스트·설치 스크립트 | 구현과 분리된 감사, pre/post 검사 |
| 6 | acceptance-evidence-validator | 실제 시험 결과와 수용 기준 | GPT/Claude 실제 시험 공백을 완료로 처리하지 않음 |

공개 게시·원격 Git·Cloudflare 설정 변경은 범위 밖이다. 비밀은 배포 산출물에서 제외한다. UI 승인 자격 발급은 실제 host/Portal 비노출 시험 전 기본 비활성화다.

현재 환경: Windows Node 24, WSL Ubuntu 26.04. Docker Linux engine은 조사 시점에 꺼져 있었다. Ubuntu 22.04/24.04 설치 검증은 별도 컨테이너 시험이 필요하며 이 사실을 다른 환경 시험으로 대체하지 않는다.
