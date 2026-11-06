# 클라이언트 설치 및 호스트 등록

배포 ZIP 또는 tar.gz를 일반 사용자 디렉터리에 풀고 Node 설치기를 실행합니다. Python·npm 설치는 필요하지 않습니다. 기본 동작은 읽기 전용 설치 계획(plan)이며 `--apply`를 명시해야 버전 디렉터리와 선택한 호스트 설정을 씁니다. Windows·Linux·macOS 경로를 지원하지만 각 OS의 실제 호스트 hook 동작은 해당 호스트에서 별도로 확인해야 합니다.

## 준비 및 계획

미리 설치된 Node `>=24.2.0 <25`가 필요합니다. 설치기는 Node나 cloudflared를 다운로드·설치하지 않습니다. `--node`를 생략하면 설치기를 실행한 Node의 실제 절대 경로를 launcher와 hook에 고정합니다. cloudflared는 기존에 신뢰한 실행 파일의 절대 경로를 지정합니다.

공개 배포본의 SHA256SUMS와 대조해 내려받은 archive의 SHA-256을 확인한 다음 풀어야 합니다. `--manifest-sha256`에는 신뢰를 확인한 배포본의 `client-manifest.json` SHA-256을 넣습니다. 단순히 출처 불명의 archive 안에 있는 manifest를 해시해 넣는 것은 배포자 신뢰 확인을 대신하지 않습니다. 설치기는 그 manifest 핀과 모든 명시 파일의 size/SHA-256을 대조하고 링크·경로 탈출·Windows 예약명·중복 경로를 거부합니다. manifest 밖의 파일은 설치하지 않습니다.

Windows PowerShell 예시입니다. 경로와 origin은 실제 값을 사용합니다.

```powershell
$node = 'C:/Program Files/nodejs/node.exe'
$source = 'C:/Downloads/ssh-approval-portal-client-2.3.1'
$pin = (Get-FileHash -LiteralPath "$source/client-manifest.json" -Algorithm SHA256).Hash.ToLowerInvariant()
& $node "$source/scripts/install-client.mjs" --source $source --manifest-sha256 $pin --hosts codex,claude-code,antigravity --claude 'C:/Users/USER/.local/bin/claude.exe' --cloudflared 'C:/Tools/cloudflared.exe' --test-origin 'https://test-approve.example.com' --prod-origin 'https://approve.example.com'
```

Linux/macOS 예시입니다. Node·Claude 경로는 해당 PC의 실제 절대 경로로 바꿉니다.

```sh
node /downloads/ssh-approval-portal-client-2.3.1/scripts/install-client.mjs \
  --manifest-sha256 TRUSTED_MANIFEST_SHA256 \
  --node /opt/node/bin/node \
  --hosts codex,claude-code,antigravity --claude /home/USER/.local/bin/claude \
  --cloudflared /usr/local/bin/cloudflared \
  --test-origin https://test-approve.example.com --prod-origin https://approve.example.com
```

`--hosts` 기본값은 `none`입니다. 원하는 호스트만 쉼표로 나열합니다. Antigravity Native는 `antigravity`이며 Gemini CLI로 대체하지 않습니다. `--install-root`를 지정하지 않으면 Windows에서는 `%LOCALAPPDATA%/Programs/ssh-approval-portal-client`, Linux/macOS에서는 `~/.local/share/ssh-approval-portal-client`를 사용하고 그 아래 manifest 버전의 새 디렉터리를 만듭니다. 다른 버전은 보존합니다. `--home`으로 Codex·Antigravity 설정 기준 디렉터리를 바꿀 수 있습니다. Claude 등록에는 현재 사용자의 실제 home만 지원합니다.

plan JSON에서 설치 대상, 각 파일 해시, 설정 변경 여부, 백업 대상, Claude argv와 재적재 안내를 확인합니다. Claude를 선택하면 공식 `plugin list --json`과 `plugin marketplace list --json`의 읽기 전용 선택 메타데이터도 조회해 plan SHA에 고정합니다. 그 뒤 선택 상태·source·다른 plugin 상태가 바뀌면 새 계획을 검토하도록 중단합니다. 계획은 인증 값·기존 설정 본문을 출력하지 않습니다. `--test-origin` 또는 `--prod-origin`을 주면 `--cloudflared`도 필요합니다. HTTPS origin만 허용하며 URL의 인증정보·경로·query·fragment는 거부합니다.

## 적용 및 보존

동일 명령 끝에 `--apply`를 붙여 적용합니다. 검토한 계획에 고정하려면 함께 출력된 `planSha256`을 `--expect-plan SHA256`으로 전달합니다. 그 사이 원본이나 설정이 바뀌면 새 계획을 검토하도록 중단합니다.

설치 파일은 Node 절대 경로를 사용하는 `portal-files`·`portal-completion-hook` launcher와 선택한 TEST/PROD launcher를 포함합니다. Windows에서는 `.cmd`와 `.ps1`(origin launcher는 `.ps1`), Linux/macOS에서는 `.sh`를 만듭니다. Windows `.ps1`은 PowerShell 5.1에서 한글 경로를 읽도록 UTF-8 BOM을 포함하며 ASCII `.cmd`는 같은 디렉터리의 `.ps1`로 위임합니다. 기존 PowerShell 실행 정책을 따르며 우회하지 않습니다. 공백과 한글 경로를 인용합니다. Windows cmd 셸 해석이 모호한 경로 문자(`"`, `%`, `!`, `^`)는 거부합니다. PATH를 바꾸지 않으므로 생성된 launcher의 경로를 직접 사용합니다.

Codex는 `~/.codex/hooks.json`의 해당 `portal-completion-hook.mjs` handler만 갱신하고, 같은 그룹에 있는 다른 handler도 보존합니다. Antigravity는 [공식 Native hook 경로](https://antigravity.google/docs/hooks)인 `~/.gemini/config/hooks.json`의 `ssh-completion-inbox` 항목만 갱신합니다. 이 이름에 다른 handler가 있으면 충돌로 중단합니다. 기존 Antigravity hook이 `enabled:false`이면 그 선택을 보존합니다. JSON 원문은 byte 단위로 백업하고, BOM·CRLF/LF를 보존해 새 설정을 씁니다. 기존 주석을 포함한 JSONC는 지원하지 않으므로 JSON 문법 오류로 중단합니다.

Claude Code는 기존 marketplace identity `ssh-mcp-client-local`을 사용해 버전 디렉터리의 로컬 wrapper를 등록합니다. [공식 marketplace 등록](https://code.claude.com/docs/en/plugin-marketplaces)과 qualified plugin 명령을 사용합니다. 같은 marketplace 이름의 source 변경에는 `install --marketplace NEW`가 충돌할 수 있으므로 삭제 없이 공식 `marketplace add NEW --scope user`로 source를 추가·교체하고 기존 user 설치에는 `update`, 새 설치에는 `install`을 실행합니다. 이 경로는 TEST Claude Code 2.1.314에서 실측했습니다. 기존 플러그인 권한과 조직 정책을 우회하지 않습니다.

```sh
claude plugin marketplace add /installed/VERSION/.claude-marketplace --scope user --json
claude plugin update ssh-completion-client@ssh-mcp-client-local --scope user --json
# 새 user 설치에는 update 대신 다음 명령을 사용합니다.
claude plugin install ssh-completion-client@ssh-mcp-client-local --scope user --json
```

source를 교체하기 전 기존 directory source가 같은 설치 루트의 `<버전>/.claude-marketplace`에 있고 SSH plugin 하나만 담은 catalog인지 확인합니다. 같은 이름의 foreign source, catalog의 다른 plugin 또는 다른 scope 등록이 있으면 `CLAUDE_MARKETPLACE_CONFLICT`·`CLAUDE_SCOPE_CONFLICT`로 변경 전에 중단합니다. 무관한 marketplace는 교체하지 않으며 marketplace remove나 raw registry 편집은 사용하지 않습니다. 생성 wrapper에는 간단한 README와 원본 배포 LICENSE를 포함합니다.

설정 변경 전 `INSTALL_ROOT/backups/<시각-고유ID>/`에 해당 Codex·Antigravity hook JSON 원문을 백업합니다. Claude는 공식 `plugin list --json`의 해당 user 플러그인 `id`, `version`, `scope`, `enabled`, `readFromFolder`, `folderVersion`과 marketplace의 name/source/path를 선택해 `claude-plugin.before.json`에 저장합니다. 다른 plugin의 선택 메타데이터는 비교용 SHA-256으로 보존합니다. Claude의 `settings.json`·플러그인 registry·인증·토큰 저장소 원문은 열거나 복사하지 않습니다. Claude 복구가 필요하면 보존한 이전 source에 공식 `plugin marketplace add PREVIOUS_SOURCE --scope user`, 이어 qualified `plugin update ... --scope user --json`을 실행하고 이전 enabled 상태를 확인합니다. 백업에는 사용자 hook 설정이 들어 있을 수 있으므로 설치 루트의 개인 권한을 유지합니다. 기존 hook 설정은 쓰기 직전 원본 해시를 다시 확인한 뒤 같은 디렉터리의 임시 파일을 원자 rename해 교체합니다. 한 설치 루트에 설치기 잠금을 두어 중복 실행을 차단합니다.

같은 버전의 기존 설치 파일이 정확히 일치하면 재사용하고 hook 중복을 만들지 않습니다. Claude는 공식 inventory의 user scope·version·folderVersion(제공되는 경우)·`readFromFolder`·marketplace source가 설치 wrapper와 같으면 변경 명령을 생략합니다. 기존 disabled 선택도 보존하며 upgrade에는 공식 qualified update를 사용합니다. 기존 파일이 다르면 `TARGET_CONFLICT`로 중단합니다. manifest 밖 파일은 재귀 탐색하거나 정리하지 않습니다. 설정·옵션을 바꿔 같은 버전의 생성 launcher가 달라져도 충돌하므로 새 설치 루트나 새 버전을 사용해 구분합니다.

## 확인 및 재적재

적용 결과는 설치 파일과 hook JSON을 다시 읽어 검증합니다. Claude는 공식 명령 exit0 이후에도 inventory를 다시 조회해 기대 version·folderVersion(제공되는 경우)·source·user scope·기존 enabled 상태·무관한 plugin 메타데이터 보존을 전부 확인해야 설치 성공을 보고합니다. 일치하지 않으면 `CLAUDE_POST_INSTALL_MISMATCH`로 실패합니다. 이 inventory 확인은 실제 hook 실행 성공과 구별합니다. `claude plugin details ssh-completion-client@ssh-mcp-client-local`과 실제 호스트에서 completion hook을 확인합니다. TEST와 PROD 각각 생성된 launcher로 `doctor`를 실행해 기존 owner 인증을 확인합니다. 설치기는 로그인이나 비밀 변경을 대신 수행하지 않습니다.

Codex는 새 세션에서 확인합니다. Claude Code의 열린 세션은 `/reload-plugins` 또는 새 세션에서 확인합니다. Antigravity Native는 앱을 재적재하거나 새 세션에서 Settings > Customizations > Hooks를 확인합니다. 호스트의 hook enable·trust 요구는 그대로 유지하며 자동 재시작·권한 우회는 하지 않습니다.

## 실패와 복구 경계

잘못된 핀은 `MANIFEST_HASH_MISMATCH`, 손상된 배포 파일은 `FILE_INTEGRITY_MISMATCH`, 바뀐 호스트 설정은 `HOST_SOURCE_CHANGED`, 바뀐 Claude 선택 메타데이터는 `CLAUDE_SOURCE_CHANGED`, 중복 실행은 `INSTALL_BUSY`로 구별합니다. 오류는 종료 코드 1과 JSON으로 출력하며 외부 CLI의 stdout/stderr 원문은 비밀 노출을 막기 위해 출력하지 않습니다. 공식 JSON의 `failureCode` 또는 `code`가 소스에 고정한 안전한 식별자 허용 목록에 있으면 `hostCode`로 보존해 `name_taken` 같은 원인을 구별합니다. 알 수 없는 값은 그대로 출력하지 않습니다.

설치 파일·여러 호스트 설정·Claude 공식 CLI를 아우르는 전체 트랜잭션은 지원하지 않습니다. 적용 중 실패하면 `partialApply`에 설치·완료된 설정·진행 중 Claude 단계·완료 단계 배열·백업 경로를 남기고 자동 rollback하지 않습니다. 예를 들어 source add 성공 뒤 update 실패는 `claude:plugin-update-started`와 완료 배열의 `marketplace-added`로 구별합니다. Claude CLI가 일부만 반영한 실패나 시간 초과는 공식 CLI로 현재 상태를 먼저 확인합니다. 새 버전 디렉터리·백업을 보존하고 완료 단계를 대조한 뒤 복구합니다. 부분 복사된 버전 디렉터리는 충돌로 보호되므로 자동 재시도로 덮어쓰지 않습니다.

호스트가 이 설치기 잠금에 참여하지 않으므로 마지막 원본 검사 직후 동시에 설정을 쓰는 경쟁까지 잠그지는 못합니다. 호스트 설정 편집·동시 설치를 멈추고 적용합니다. 강제 종료 후 `.install-client.lock`이 남으면 잠금 JSON의 PID와 대상에서 실제 실행이 끝났는지 확인한 뒤 해당 잠금 파일만 수동 복구합니다. 설치기는 기존 버전·백업·잠금을 임의 삭제하지 않습니다. OS별 실호스트 시험을 수행하지 않은 결과는 지원 검증 완료로 보고하지 않습니다.
