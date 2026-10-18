# 설치·연결·검증·복구 진입점

Ubuntu 22.04/24.04의 네이티브 설치를 `python3 scripts/portal.py`에서 진행합니다. 기존 설치·잠금·백업·복구 스크립트를 사용하며 정책을 자동으로 켜지 않습니다. Docker/Compose 호스트 설치는 기존 전용 도구를 사용합니다.

먼저 실행 계획을 확인합니다. `--dry-run`은 관리자 권한이나 설치된 서버 없이 사용할 수 있으며 파일·서비스·네트워크를 변경하지 않습니다. JSON의 `argv`는 실제 실행할 인자 배열입니다. Windows에서 확인한 경로는 Windows 경로이므로 실제 설치할 Ubuntu에서도 계획을 확인하세요.

```bash
python3 scripts/portal.py install --admin-origin https://approve.example.com --dry-run
sudo python3 scripts/portal.py install --admin-origin https://approve.example.com
```

최초 설치에만 `--grant-sudo-all`을 명시적으로 선택할 수 있습니다. 이 옵션은 MCP 계정에 비밀번호 없는 전체 sudo를 부여합니다. 지정하지 않으면 부여하지 않습니다. 갱신에는 이 옵션이나 새 origin을 전달할 수 없고 기존 ENV·정책·키를 유지합니다.

```bash
python3 scripts/portal.py update --dry-run
sudo python3 scripts/portal.py update
```

필요한 연결 기능을 선택합니다. `access`는 기존 Cloudflare 소유자 인증 설정, `upload-sources`는 업로드 원본 허용 호스트 설정이며 관리자 터미널에서 대화식으로 입력합니다. 키나 토큰을 명령행 인자에 넣지 않습니다. `env-editor`는 ENV 관리 소켓을 설치합니다. 각 단계 뒤에 패키지와 서비스 health를 검사합니다. 외부 DNS·터널·OAuth 제공자 등록은 이 CLI가 생성하지 않으며 실제 로그인은 별도 확인해야 합니다.

```bash
sudo python3 scripts/portal.py connect access
sudo python3 scripts/portal.py connect upload-sources
sudo python3 scripts/portal.py connect env-editor
```

정책 설정은 아래 명령으로 관리자 설정 주소를 확인하고, 해당 화면에서 대상·명령·sudo·전송·모델 허용 범위를 검토한 뒤 저장합니다. CLI는 `ACTION_REQUIRED`와 종료 코드 3을 반환합니다. 이는 정책이 저장됐다는 뜻이 아닙니다. 브라우저에서 기존 소유자 인증과 검토·저장 절차를 따릅니다.

```bash
python3 scripts/portal.py policy --admin-origin https://approve.example.com
sudo python3 scripts/portal.py status
sudo python3 scripts/portal.py verify
```

갱신 실패의 복구는 기존 설치 스크립트가 담당합니다. CLI는 실패한 단계를 표시하고 추가 단계나 자동 재시도를 실행하지 않습니다. 성공했던 앞선 설정 작업까지 일괄 취소하지 않으므로 실패 결과를 확인한 뒤 다음 작업을 정하세요.

직접 복구할 때는 설치 결과에 표시된 정확한 백업 경로를 지정합니다. 백업은 관리되는 `backups` 바로 아래 폴더여야 합니다. 복구 뒤에는 복원된 서비스의 health를 확인하며 현재 소스가 복원된 이전 코드라고 가정하지 않습니다.

```bash
python3 scripts/portal.py rollback /var/lib/ssh-mcp/app/backups/백업이름 --dry-run
sudo python3 scripts/portal.py rollback /var/lib/ssh-mcp/app/backups/백업이름
```

로컬 검사는 `python3 -B test/test_portal_setup.py`로 인자·dry run·실패 중단·정책 미승인 동작을 확인합니다. `test/portal-container-test.sh`는 기존 native 설치 fixture의 합성 데이터·설정 보존·실제 SSH·복구 판정을 유지하면서 통합 CLI로 설치·갱신·재설치·실패 복구를 실행하는 격리 Linux 컨테이너용 driver입니다. 실제 실행 결과가 없으면 로드맵에서 완료로 표시하지 않습니다.
