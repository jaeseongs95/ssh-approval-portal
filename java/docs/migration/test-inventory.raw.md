# 시험 사례 이름 원자료 (test-inventory.raw)

- 목적: ssh-approval-portal v2.4.2의 기존 시험을 Java(JUnit) 회귀 사례로 옮기기 위해, 시험 사례 이름을 파일별로 모은 원자료 목록이다. 판단·평가·수정 제안은 담지 않는다.
- 기준: 저장소 `D:/codex/build/ssh-portal-v300-prep`, HEAD `a44c4d1`, `git ls-files test` 결과 중 시험 파일.
- 세는 기준: 시험 사례 호출 1개 = 1행. `describe`는 묶음 열로만 기록하고 1건으로 세지 않는다. 이 저장소의 mjs 파일에는 `describe(` 호출이 없다.
- 동적 판정: 이름 인자가 따옴표·백틱 리터럴 하나(`${` 없음)이면 정적이다. 리터럴 뒤에 변수가 `+`로 결합되거나(`'…'+변수`), 템플릿에 `${…}`가 있거나, 이름 자리가 변수이면 동적이다. 원래 지시의 COUNT_RULE(변수로 만들어지는 이름은 동적)을 따랐으므로, 조합 호출은 첫 인자가 리터럴이어도 동적으로 표시했다. 동적 행의 이름은 호출 원문 식을 그대로 적었다. 반복문(`for … test(…)`)으로 같은 리터럴 이름이 여러 번 도는 경우는 정적 1행으로 두었다.
- 결함 번호: 이름에 `SSH_PORTAL-D-xxxx`, `D-00xx`, `D00xx` 패턴이 있으면 해당 열에 적는다. 본 수집에서는 해당 패턴이 발견되지 않았다.
- 범위 제외: `test/legacy-17/**`는 파일 목록에만 두고 사례는 세지 않았다(보존용).

## 사용한 명령 (수집 경로)

- 파일 목록: `git ls-files test` (HEAD `a44c4d1`, 307개 추적 파일). 실행 종료 코드 0.
- mjs 호출 줄 수집: `grep -nE "(^|[^A-Za-z0-9_.\$])(test|it|describe)(\.[a-zA-Z]+)?\s*\(" <파일>` (legacy-17 제외). 232개 mjs 중 호출이 있는 203개 파일, 매칭 1,582줄(스크래치패드 `mjs.tsv`). 이후 Grep 도구(content, -n, head_limit 0)로 이름 열을 읽었다.
- 합계 대조: Grep 도구 count 모드로 `test/**/*.mjs`는 1,582건(주석 1건 포함), 결과 파일 표의 `| test/` 행은 1,581건이다. 차이 1건은 주석 줄이다. 파이썬은 `^\s*def test` count 335건과 파이썬 표 335행이 일치한다. ps1·sh는 Grep 도구 count로 행 수를 확인했다(142행).
- 주석 1줄(`test/multi-target.test.mjs:17`, `// queued/serialization/drain test …`)은 호출이 아니므로 제외했다.
- 파이썬: `^\s*(class \w+|def test\w*)` Grep(content). 클래스 이름을 describe 묶음 열에 적었다.
- ps1·sh: `Assert-True` 라벨과 PASS·거부 문자열을 Grep 도구로 찾았다. 그 밖의 다중 줄 `Assert-True` 호출은 이 표에 없다(미확인).
- Bash 도구는 AGS 편집 게이트가 경로를 알 수 없다며 막아서, 이후 읽기는 Grep·Read만 썼다. 쓰기는 Write·Edit로 이 파일 하나만 했다.

## 파일별 사례 수 요약

| 파일 | 형식 | 사례 수 |
|---|---|---|
| 전체 합계 | 전 형식 | **2,058** (mjs 1,581 + py 335 + ps1 108 + sh 34) |
| test/**/*.mjs (203개 파일, 호출 있는 파일만) | mjs, `test`/`it` 호출 | **1,581** |
| test/test_*.py (26개 파일) | py, `def test_*` (unittest) | **335** |
| test/windows-file-helper.tests.ps1 | ps1, `Assert-True` 라벨 | 99 |
| test/windows-ssh-ci.ps1 | ps1, `Assert-Exit` 단계·PASS 문자열 | 8 |
| test/driver-common.test.ps1 | ps1, PASS 문자열 | 1 |
| test/compose-update-ci.sh | sh, 거부 검사·PASS 문자열 | 23 |
| test/compose-driver.sh | sh, PASS 문자열 | 2 |
| test/container-test.sh | sh, 설치·거부 문자열 | 3 |
| test/portal-container-test.sh | sh, 설치·거부 문자열 | 3 |
| test/non-cloudflare-container-test.sh | sh, PASS 문자열 | 2 |
| test/ssh-recovery-red.sh | sh, 동적 사례명 | 1 |
| test/legacy-17/** | 보존용(이름만 목록) | 사례 미계수 |

mjs 파일별 사례 수(표 순서는 파일 열거 순서, 사례 표는 경로 오름차순):

| 파일 | 형식 | 사례 수 |
|---|---|---|
| test/admin-access-http.test.mjs | mjs | 1 |
| test/admin-access.test.mjs | mjs | 6 |
| test/admin-browser-sessions.test.mjs | mjs | 3 |
| test/agent-cli-delivery.test.mjs | mjs | 18 |
| test/agent-cli-history.test.mjs | mjs | 3 |
| test/agent-cli-http.test.mjs | mjs | 27 |
| test/agent-cli-releases.test.mjs | mjs | 8 |
| test/agent-cli-service.test.mjs | mjs | 23 |
| test/agent-cli.test.mjs | mjs | 10 |
| test/agent-file-forwarder.test.mjs | mjs | 20 |
| test/agent-file-mcp-process.test.mjs | mjs | 12 |
| test/agent-upload.test.mjs | mjs | 6 |
| test/aik-180.test.mjs | mjs | 6 |
| test/aik-ags.test.mjs | mjs | 7 |
| test/approval-callback.test.mjs | mjs | 15 |
| test/approval-expiry.test.mjs | mjs | 3 |
| test/artifact-cleanup-contract.test.mjs | mjs | 2 |
| test/artifact-durability.test.mjs | mjs | 13 |
| test/artifact-restart-unavailable.test.mjs | mjs | 4 |
| test/artifacts.test.mjs | mjs | 6 |
| test/audit-gate.test.mjs | mjs | 1 |
| test/automatic-downloads.test.mjs | mjs | 7 |
| test/automatic-uploads.test.mjs | mjs | 9 |
| test/automation-metrics.test.mjs | mjs | 2 |
| test/bridge-cli-runtime.test.mjs | mjs | 1 |
| test/browser/admin-workflow.test.mjs | mjs | 2 |
| test/browser/agent-cli.test.mjs | mjs | 17 |
| test/browser/async-approval.test.mjs | mjs | 1 |
| test/browser/capacity-desktop.test.mjs | mjs | 4 |
| test/browser/command-line-import.test.mjs | mjs | 15 |
| test/browser/command-output.test.mjs | mjs | 5 |
| test/browser/command-policy.test.mjs | mjs | 37 |
| test/browser/desktop-draft.test.mjs | mjs | 5 |
| test/browser/desktop-gestures.test.mjs | mjs | 6 |
| test/browser/environment.test.mjs | mjs | 4 |
| test/browser/history-language.test.mjs | mjs | 15 |
| test/browser/multi-admin.test.mjs | mjs | 10 |
| test/browser/queued-state.test.mjs | mjs | 2 |
| test/browser/regressions.test.mjs | mjs | 20 |
| test/browser/source-automation.test.mjs | mjs | 2 |
| test/browser/windows-targets.test.mjs | mjs | 5 |
| test/capacity-settings.test.mjs | mjs | 7 |
| test/capacity-ui-desktop.test.mjs | mjs | 3 |
| test/capacity-ui.test.mjs | mjs | 3 |
| test/card-mcp-contract.test.mjs | mjs | 8 |
| test/cli-entrypoint.test.mjs | mjs | 1 |
| test/cli-local-files.test.mjs | mjs | 13 |
| test/cli-platform-paths.test.mjs | mjs | 2 |
| test/client-install.test.mjs | mjs | 38 |
| test/codex-completion.test.mjs | mjs | 8 |
| test/command-automation.test.mjs | mjs | 46 |
| test/command-line-import.test.mjs | mjs | 4 |
| test/command-line.test.mjs | mjs | 3 |
| test/command-limits.test.mjs | mjs | 8 |
| test/command-lifecycle.test.mjs | mjs | 9 |
| test/command-output-accounting.test.mjs | mjs | 8 |
| test/command-output-stream180.test.mjs | mjs | 11 |
| test/command-output.test.mjs | mjs | 9 |
| test/command-policy-review.test.mjs | mjs | 9 |
| test/command-state-startup.test.mjs | mjs | 3 |
| test/compose-maintenance-gate.test.mjs | mjs | 1 |
| test/completion-auto-watch.test.mjs | mjs | 24 |
| test/completion-hook.test.mjs | mjs | 37 |
| test/completion-inbox.test.mjs | mjs | 28 |
| test/completion-wake.test.mjs | mjs | 12 |
| test/config-contracts.test.mjs | mjs | 9 |
| test/core.test.mjs | mjs | 8 |
| test/deploy180-archive-permissions.test.mjs | mjs | 2 |
| test/deploy180-migration-stdin.test.mjs | mjs | 3 |
| test/deploy180-native-runtime.test.mjs | mjs | 3 |
| test/deploy180-output-sidecars.test.mjs | mjs | 4 |
| test/deploy180-release-permissions.test.mjs | mjs | 7 |
| test/desktop-http.test.mjs | mjs | 4 |
| test/desktop-local-process.test.mjs | mjs | 9 |
| test/desktop-public-contract.test.mjs | mjs | 4 |
| test/desktop-rdp-native-input.test.mjs | mjs | 18 |
| test/desktop-rdp-runtime.test.mjs | mjs | 11 |
| test/desktop-rdp-session.test.mjs | mjs | 10 |
| test/desktop-rfb-input-endian.test.mjs | mjs | 1 |
| test/desktop-rfb.test.mjs | mjs | 2 |
| test/desktop-service.test.mjs | mjs | 21 |
| test/desktop-ssh-forward-close.test.mjs | mjs | 6 |
| test/desktop-ssh-tunnel.test.mjs | mjs | 7 |
| test/desktop-state.test.mjs | mjs | 5 |
| test/desktop-target-backends.test.mjs | mjs | 5 |
| test/dispatch-failure.test.mjs | mjs | 3 |
| test/download-delivery.test.mjs | mjs | 4 |
| test/environment.test.mjs | mjs | 2 |
| test/execution-claims.test.mjs | mjs | 8 |
| test/execution-context.test.mjs | mjs | 7 |
| test/execution-failure.test.mjs | mjs | 6 |
| test/execution-queue.test.mjs | mjs | 7 |
| test/file-contracts.test.mjs | mjs | 7 |
| test/file-source.test.mjs | mjs | 13 |
| test/file-target-binding.test.mjs | mjs | 12 |
| test/gui-account-provision.test.mjs | mjs | 13 |
| test/gui-ssh-stream.test.mjs | mjs | 14 |
| test/http-admission.test.mjs | mjs | 9 |
| test/http-races.test.mjs | mjs | 3 |
| test/http.test.mjs | mjs | 1 |
| test/i18n.test.mjs | mjs | 8 |
| test/install-origin-preflight.test.mjs | mjs | 9 |
| test/install-state-guard.test.mjs | mjs | 1 |
| test/jev-binary-contract.test.mjs | mjs | 3 |
| test/jev-diagnostics.test.mjs | mjs | 5 |
| test/jev-input-factor.test.mjs | mjs | 6 |
| test/jev-prompt-revision.test.mjs | mjs | 1 |
| test/jev-shadow.test.mjs | mjs | 12 |
| test/linux-desktop-session.test.mjs | mjs | 14 |
| test/local-secret-store.test.mjs | mjs | 5 |
| test/maintenance-client.test.mjs | mjs | 2 |
| test/maintenance-durable.test.mjs | mjs | 3 |
| test/maintenance.test.mjs | mjs | 1 |
| test/mcp-contracts.test.mjs | mjs | 20 |
| test/mcp-input-limits.test.mjs | mjs | 3 |
| test/mcp180-bytes.test.mjs | mjs | 6 |
| test/model-selection.test.mjs | mjs | 4 |
| test/multi-admin.test.mjs | mjs | 4 |
| test/multi-target-config.test.mjs | mjs | 2 |
| test/multi-target-ssh.test.mjs | mjs | 1 |
| test/multi-target.test.mjs | mjs | 6 |
| test/multiline-commands.test.mjs | mjs | 7 |
| test/native-install-paths.test.mjs | mjs | 7 |
| test/offline-preservation.test.mjs | mjs | 4 |
| test/oidc-access.test.mjs | mjs | 5 |
| test/opaque-artifacts.test.mjs | mjs | 5 |
| test/opaque-file-api.test.mjs | mjs | 7 |
| test/opaque-files-application.test.mjs | mjs | 2 |
| test/opaque-files-client.test.mjs | mjs | 23 |
| test/opaque-files.test.mjs | mjs | 10 |
| test/operation-migration-180.test.mjs | mjs | 11 |
| test/operation-migration-batch.test.mjs | mjs | 5 |
| test/operation-migration-preflight.test.mjs | mjs | 6 |
| test/operation-migration-retained-budget.test.mjs | mjs | 5 |
| test/operation-observer-http.test.mjs | mjs | 5 |
| test/operation-scheduler.test.mjs | mjs | 15 |
| test/operation-store.test.mjs | mjs | 7 |
| test/operation-watch-cli.test.mjs | mjs | 11 |
| test/operation-watcher.test.mjs | mjs | 16 |
| test/operations-180.test.mjs | mjs | 10 |
| test/portal-client-bound-files.test.mjs | mjs | 7 |
| test/portal-client-cloudflared.test.mjs | mjs | 9 |
| test/portal-client-combined.test.mjs | mjs | 1 |
| test/portal-client-discovery.test.mjs | mjs | 16 |
| test/portal-client-output.test.mjs | mjs | 9 |
| test/portal-client-process.test.mjs | mjs | 5 |
| test/portal-client-source-binding.test.mjs | mjs | 9 |
| test/portal-client.test.mjs | mjs | 19 |
| test/portal-file-forwarder.test.mjs | mjs | 9 |
| test/portal-file-mcp-process.test.mjs | mjs | 4 |
| test/portal-files-hook.test.mjs | mjs | 11 |
| test/preservation-baseline.test.mjs | mjs | 7 |
| test/preservation-integration.test.mjs | mjs | 6 |
| test/preservation-verification.test.mjs | mjs | 6 |
| test/python-source-ssh.test.mjs | mjs | 4 |
| test/python-source.test.mjs | mjs | 6 |
| test/read-command-refusals.test.mjs | mjs | 7 |
| test/release-version.test.mjs | mjs | 2 |
| test/remote-mcp-upload.test.mjs | mjs | 9 |
| test/request-admission.test.mjs | mjs | 9 |
| test/request-capacity.test.mjs | mjs | 5 |
| test/request-safety-http.test.mjs | mjs | 1 |
| test/request-safety.test.mjs | mjs | 6 |
| test/retained-history.test.mjs | mjs | 14 |
| test/rollback-stopped.test.mjs | mjs | 1 |
| test/runtime-capacity-180.test.mjs | mjs | 4 |
| test/runtime-capacity.test.mjs | mjs | 3 |
| test/safety-http.test.mjs | mjs | 7 |
| test/safety.test.mjs | mjs | 15 |
| test/secret-cli-pty.test.mjs | mjs | 1 |
| test/secret-integration.test.mjs | mjs | 1 |
| test/secret-io-failures.test.mjs | mjs | 6 |
| test/secret-service.test.mjs | mjs | 3 |
| test/secrets.test.mjs | mjs | 1 |
| test/shutdown.test.mjs | mjs | 2 |
| test/solid-architecture.test.mjs | mjs | 4 |
| test/solid-regressions.test.mjs | mjs | 1 |
| test/source-automation.test.mjs | mjs | 17 |
| test/source-input-refusals.test.mjs | mjs | 8 |
| test/source-linux-runtime.mjs | mjs | 1 |
| test/ssh-connection-lifecycle.test.mjs | mjs | 9 |
| test/ssh-supervisor.test.mjs | mjs | 17 |
| test/terminal-restore.test.mjs | mjs | 3 |
| test/test-mode-file-path-policy.test.mjs | mjs | 10 |
| test/test-mode-file-policy-application.test.mjs | mjs | 8 |
| test/test-server-mode.test.mjs | mjs | 1 |
| test/transfer-failure.test.mjs | mjs | 14 |
| test/ui-bundle.test.mjs | mjs | 2 |
| test/vault-kv.test.mjs | mjs | 2 |
| test/version-check.test.mjs | mjs | 4 |
| test/web-session.test.mjs | mjs | 16 |
| test/windows-agent-cli-helper.test.mjs | mjs | 1 |
| test/windows-agent-cli-smoke.test.mjs | mjs | 1 |
| test/windows-agent-cli.test.mjs | mjs | 6 |
| test/windows-command-execution.test.mjs | mjs | 2 |
| test/windows-command-line.test.mjs | mjs | 9 |
| test/windows-dispatch-binding.test.mjs | mjs | 9 |
| test/windows-file-contracts.test.mjs | mjs | 8 |
| test/windows-full-application.test.mjs | mjs | 4 |
| test/windows-jev-contract.test.mjs | mjs | 3 |
| test/windows-python-source.test.mjs | mjs | 5 |
| test/windows-ssh-integration.test.mjs | mjs | 1 |
| test/windows-target.test.mjs | mjs | 7 |

py 파일별 사례 수: test/test_agent_cli.py 45, test/test_agent_cli_login.py 11, test/test_cloudflare_api_lifecycle.py 14, test/test_cloudflare_binary.py 12, test/test_cloudflare_connector.py 20, test/test_cloudflare_discovery.py 10, test/test_cloudflare_environment.py 17, test/test_cloudflare_provision.py 28, test/test_cloudflare_setup.py 18, test/test_compose_env.py 6, test/test_env_editor_lock.py 1, test/test_environment_helper.py 26, test/test_helper.py 10, test/test_linux_desktop_session.py 10, test/test_node_runtime.py 12, test/test_oidc_environment.py 2, test/test_oidc_proxy_install.py 13, test/test_oidc_proxy_setup.py 13, test/test_package.py 13, test/test_portal_setup.py 11, test/test_prepare_freerdp_input.py 12, test/test_release_package.py 3, test/test_release_update.py 8, test/test_settings_contract.py 6, test/test_tunnel_connections.py 9, test/test_upload_sources.py 5 (합 335).

## 사례 표 (파일 경로 오름차순 · 줄 오름차순)

| 파일 | 줄 | describe 묶음 | 사례 이름(원문) | 결함 번호 | 동적 여부 |
|---|---|---|---|---|---|
| test/admin-access-http.test.mjs | 11 | - | mode+' web requires signed owner, cookie POST origin and separate maintenance token; no credential disclosure' | - | 동적 |
| test/admin-access.test.mjs | 16 | - | Access configuration is explicit and pins a team, audience and exact owners | - | 정적 |
| test/admin-access.test.mjs | 20 | - | Access settings preserve secrets and line endings, replace only owner authentication keys and reject malformed input | - | 정적 |
| test/admin-access.test.mjs | 32 | - | Owned Access restore preserves original absent/empty keys and rejects later changes or unrelated replacements | - | 정적 |
| test/admin-access.test.mjs | 44 | - | OIDC settings preserve non-owner ENV, quotes and exact restoration; reject invalid input and cross-mode restores | - | 정적 |
| test/admin-access.test.mjs | 72 | - | authMode+' owned staging CLI reads a private managed ENV, compares before writing and keeps secrets out of errors' | - | 동적 |
| test/admin-access.test.mjs | 118 | - | Signed Access assertions enforce issuer, audience, time, human identity and owner; no header or bearer fallback | - | 정적 |
| test/admin-browser-sessions.test.mjs | 12 | - | browser sessions bind verified identity, do not extend expiry, and revoke independently | - | 정적 |
| test/admin-browser-sessions.test.mjs | 26 | - | browser cookie transport is opaque, host-only, strict, and rejects duplicates or oversized input | - | 정적 |
| test/admin-browser-sessions.test.mjs | 35 | - | 'LOGOUT-HTTP '+mode+' revokes one browser while the same MCP credential keeps working' | - | 동적 |
| test/agent-cli-delivery.test.mjs | 42 | - | CLI-DELIVERY fixed timeouts and public projection cover both providers and all actions | - | 정적 |
| test/agent-cli-delivery.test.mjs | 49 | - | CLI-DELIVERY generic Python source uses the default deadline and redacted-text contract | - | 정적 |
| test/agent-cli-delivery.test.mjs | 54 | - | CLI-DELIVERY fixed receipt digest matches the Python helper canonical JSON contract | - | 정적 |
| test/agent-cli-delivery.test.mjs | 60 | - | CLI-DELIVERY generic or mutated source/metadata/argv plans are refused before connection | - | 정적 |
| test/agent-cli-delivery.test.mjs | 67 | - | CLI-DELIVERY TTY/read-only/workdir, changed target and changed registry profile never dispatch | - | 정적 |
| test/agent-cli-delivery.test.mjs | 73 | - | CLI-DELIVERY private extras are discarded without redacting validated public hashes | - | 정적 |
| test/agent-cli-delivery.test.mjs | 77 | - | CLI-DELIVERY managed and foreign installation paths remain distinct and typed | - | 정적 |
| test/agent-cli-delivery.test.mjs | 85 | - | 'CLI-DELIVERY refuses '+name+' without raw output' | - | 동적 |
| test/agent-cli-delivery.test.mjs | 94 | - | 'CLI-DELIVERY '+name+' remains unknown with no replay or private error' | - | 동적 |
| test/agent-cli-delivery.test.mjs | 97 | - | CLI-DELIVERY dispatch exception is unknown and never replayed | - | 정적 |
| test/agent-cli-delivery.test.mjs | 100 | - | CLI-DELIVERY acquisition failure is private and an admitted plan is immutable across acquisition | - | 정적 |
| test/agent-cli-delivery.test.mjs | 105 | - | CLI-DELIVERY status preserves explicit remote states and generic failure while binding operation/intent | - | 정적 |
| test/agent-cli-delivery.test.mjs | 115 | - | CLI-DELIVERY install cannot report failed, wrong version or a different receipt intent as success | - | 정적 |
| test/agent-cli-delivery.test.mjs | 123 | - | CLI-LOOPBACK exact helper executes inspection/status over pinned SSH and preserves authentication bytes | - | 정적 |
| test/agent-cli-delivery.test.mjs | 172 | - | CLI-LOOPBACK a distinct request after refusal rechecks policy/target/profile without replay | - | 정적 |
| test/agent-cli-delivery.test.mjs | 185 | - | CLI-LOGIN delivery accepts only the fixed helper and discards vendor private fields | - | 정적 |
| test/agent-cli-delivery.test.mjs | 209 | - | `DISPATCH-GUARD ${port} awaits authority after ${revokeAt}` | - | 동적 |
| test/agent-cli-delivery.test.mjs | 244 | - | DISPATCH-GUARD source retains sync binding verification after async authority check | - | 정적 |
| test/agent-cli-history.test.mjs | 17 | - | CLI-HISTORY journal exposes only current-binding public metadata and never writes on read | - | 정적 |
| test/agent-cli-history.test.mjs | 26 | - | CLI-HISTORY journal keyset pages include older requests once despite newer arrivals and tied timestamps | - | 정적 |
| test/agent-cli-history.test.mjs | 35 | - | CLI-HISTORY journal rejects malformed cursors and returns no records for another current scope | - | 정적 |
| test/agent-cli-http.test.mjs | 52 | - | CLI-HTTP capability is owner-only and executes no SSH; Jev/automation off stays off | - | 정적 |
| test/agent-cli-http.test.mjs | 57 | - | CLI-HTTP missing runtime reports unavailable without a private CLI journal | - | 정적 |
| test/agent-cli-http.test.mjs | 60 | - | CLI-HTTP lookup restores only a scoped owner record with GET and never probes or executes | - | 정적 |
| test/agent-cli-http.test.mjs | 72 | - | CLI-HISTORY owner can find existing scoped requests without a browser key and no probe or journal write | - | 정적 |
| test/agent-cli-http.test.mjs | 82 | - | CLI-HISTORY preserves owner/current-binding and exact query boundaries | - | 정적 |
| test/agent-cli-http.test.mjs | 91 | - | CLI-HISTORY survived restart exposes the same expired request without recreating execution authority | - | 정적 |
| test/agent-cli-http.test.mjs | 96 | - | CLI-HTTP every mutation requires owner, exact Origin and bounded JSON before probe | - | 정적 |
| test/agent-cli-http.test.mjs | 107 | - | CLI-HTTP real app preview/pending/start/output flow accepts owner work promptly then observes execution | - | 정적 |
| test/agent-cli-http.test.mjs | 119 | - | CLI-HTTP changing preview target/profile/fields/key payload cannot create a replacement request | - | 정적 |
| test/agent-cli-http.test.mjs | 124 | - | CLI-HTTP target drift at actual start blocks the same persisted job | - | 정적 |
| test/agent-cli-http.test.mjs | 127 | - | CLI-HTTP a pending request expires after app restart and private source/installation authority are never restored | - | 정적 |
| test/agent-cli-http.test.mjs | 131 | - | CLI-HTTP unknown transport persists across restart; readonly reconcile does not replay installation or rewrite its audit state | - | 정적 |
| test/agent-cli-http.test.mjs | 138 | - | CLI-HTTP probe claim blocks maintenance and shutdown drains it before closing connections | - | 정적 |
| test/agent-cli-http.test.mjs | 144 | - | CLI-HTTP probe audit failure prevents remote work and releases its global claim | - | 정적 |
| test/agent-cli-http.test.mjs | 147 | - | CLI-HTTP stored deny policy applies to fixed helper and stays byte-identical during rejected CLI requests | - | 정적 |
| test/agent-cli-http.test.mjs | 154 | - | CLI-HTTP adding deny policy after pending admission blocks start without touching that policy | - | 정적 |
| test/agent-cli-http.test.mjs | 160 | - | CLI-HTTP explicit targets and the global request key cannot cross-bind CLI work | - | 정적 |
| test/agent-cli-http.test.mjs | 169 | - | CLI-JOURNAL pending/running normalization, conflict and remote public projection use the dedicated private file | - | 정적 |
| test/agent-cli-http.test.mjs | 177 | - | CLI-JOURNAL refuses a foreign symlink or permissive existing database | - | 정적 |
| test/agent-cli-http.test.mjs | 181 | - | CLI-ACK reconciliation observes remote records without completing or replaying an unknown request | - | 정적 |
| test/agent-cli-http.test.mjs | 199 | - | CLI-LOGIN owner projection covers both providers and four honest states | - | 정적 |
| test/agent-cli-http.test.mjs | 213 | - | CLI-LOGIN owner preserves fixed failure reasons and refuses forged or inconsistent reasons | - | 정적 |
| test/agent-cli-http.test.mjs | 225 | - | CLI-LOGIN probes queue within target capacity, hide errors and reject binding drift | - | 정적 |
| test/agent-cli-http.test.mjs | 245 | - | CLI-LOGIN and preview wait behind a command through the same target scheduler | - | 정적 |
| test/agent-cli-http.test.mjs | 257 | - | test server owner policy automatically executes a new CLI request and replay never repeats installation | - | 정적 |
| test/agent-cli-http.test.mjs | 270 | - | test server CLI waits behind an active command and replay never repeats installation | - | 정적 |
| test/agent-cli-http.test.mjs | 286 | - | test server CLI dispatch hook rejects revoked secret after admission and replay cannot install | - | 정적 |
| test/agent-cli-releases.test.mjs | 34 | - | fixed provider URL and credential-free TLS request; public immutable plan only | - | 정적 |
| test/agent-cli-releases.test.mjs | 45 | - | unsupported providers are refused before any request | - | 정적 |
| test/agent-cli-releases.test.mjs | 61 | - | name+' produces one bounded generic failure' | - | 동적 |
| test/agent-cli-releases.test.mjs | 65 | - | an overall request deadline destroys the owned request and does not retry | - | 정적 |
| test/agent-cli-releases.test.mjs | 70 | - | same-provider concurrent reads share one request and a valid cache entry | - | 정적 |
| test/agent-cli-releases.test.mjs | 75 | - | exact cache expiry refreshes metadata and never uses stale results on failure | - | 정적 |
| test/agent-cli-releases.test.mjs | 81 | - | late success after plan lifetime never becomes an installable plan | - | 정적 |
| test/agent-cli-releases.test.mjs | 85 | - | invalid clock and synchronous transport exceptions are refused without private errors | - | 정적 |
| test/agent-cli-service.test.mjs | 42 | - | preview binds exact registered target, release, revision and lifetime; strips private extras | - | 정적 |
| test/agent-cli-service.test.mjs | 47 | - | fixed source plan binds helper argv and target; root elevation and arbitrary source are absent | - | 정적 |
| test/agent-cli-service.test.mjs | 56 | - | submit persists a pending owner job and never executes before actual queue approval | - | 정적 |
| test/agent-cli-service.test.mjs | 61 | - | owner queue approval executes once and stores output with exact execution/target/plan binding | - | 정적 |
| test/agent-cli-service.test.mjs | 68 | - | same request key/body returns same persistent job even after plan expiry, without new dispatch | - | 정적 |
| test/agent-cli-service.test.mjs | 74 | - | new keys cannot queue a second same-target/provider install while one is pending or running | - | 정적 |
| test/agent-cli-service.test.mjs | 78 | - | expired preview and approval deadline never dispatch | - | 정적 |
| test/agent-cli-service.test.mjs | 82 | - | changed target, current deny policy and maintenance prevent dispatch at actual approval | - | 정적 |
| test/agent-cli-service.test.mjs | 89 | - | one scheduler slot is shared by agent CLI operations and keeps the second queued | - | 정적 |
| test/agent-cli-service.test.mjs | 100 | - | target change after owner admission is rechecked and confirms no remote dispatch | - | 정적 |
| test/agent-cli-service.test.mjs | 104 | - | plan expiry between owner admission and dispatch prevents the remote effect | - | 정적 |
| test/agent-cli-service.test.mjs | 108 | - | output reservation failure never dispatches and cannot be replayed | - | 정적 |
| test/agent-cli-service.test.mjs | 112 | - | transport result loss and malformed outcome stay unknown without automatic SSH retry | - | 정적 |
| test/agent-cli-service.test.mjs | 118 | - | journal restart expires pending and marks running unknown; missing private plan never reconstructs | - | 정적 |
| test/agent-cli-service.test.mjs | 125 | - | audit or durable admission failure produces no executable job and no remote call | - | 정적 |
| test/agent-cli-service.test.mjs | 129 | - | unsupported fields, disabled targets and changed preview snapshots are refused before submit | - | 정적 |
| test/agent-cli-service.test.mjs | 134 | - | preview rejects target drift, false login claims and invalid installation metadata | - | 정적 |
| test/agent-cli-service.test.mjs | 141 | - | preview cache has a fixed capacity and exact expiry frees only expired entries | - | 정적 |
| test/agent-cli-service.test.mjs | 144 | - | existing queue keeps its one-hour default and refuses deadlines outside its authority window | - | 정적 |
| test/agent-cli-service.test.mjs | 149 | - | changed queued operation or profile cannot consume the private execution plan | - | 정적 |
| test/agent-cli-service.test.mjs | 155 | - | CLI-DISPATCH arbitrary policy callback failures are unknown at the policy guard, never confirmed denial | - | 정적 |
| test/agent-cli-service.test.mjs | 160 | - | false catalog provider, release digest or extended lifetime never becomes a preview | - | 정적 |
| test/agent-cli-service.test.mjs | 167 | - | service close prevents a late inspection from restoring previews or execution authority | - | 정적 |
| test/agent-cli.test.mjs | 12 | - | fixed provider catalog rejects property names and shell input | - | 정적 |
| test/agent-cli.test.mjs | 17 | - | 'official public release projection '+provider | - | 동적 |
| test/agent-cli.test.mjs | 25 | - | 'release rejects unstable or unbounded version '+JSON.stringify(version) | - | 동적 |
| test/agent-cli.test.mjs | 26 | - | 'release refuses alternative distribution '+url | - | 동적 |
| test/agent-cli.test.mjs | 27 | - | release rejects malformed metadata and checksum | - | 정적 |
| test/agent-cli.test.mjs | 31 | - | intent binds release, action, target and installation snapshot but not replay key | - | 정적 |
| test/agent-cli.test.mjs | 42 | - | intent refuses stale, disabled and malformed targets | - | 정적 |
| test/agent-cli.test.mjs | 46 | - | intent refuses additional, missing and malformed request fields | - | 정적 |
| test/agent-cli.test.mjs | 51 | - | intent detects tampering in every release identity field | - | 정적 |
| test/agent-cli.test.mjs | 55 | - | expiry boundary never gains an epsilon or implicit clock extension | - | 정적 |
| test/agent-file-forwarder.test.mjs | 75 | - | 임의 바이너리와 빈 파일 선택은 메타데이터만 반환하고 명시 업로드에서 원래 바이트와 대상을 전달한다 | - | 정적 |
| test/agent-file-forwarder.test.mjs | 89 | - | 같은 선택은 파일 삭제와 재시작 뒤에도 재조회 없이 돌아오고 다른 의도는 거절된다 | - | 정적 |
| test/agent-file-forwarder.test.mjs | 99 | - | 선택 뒤 소스가 바뀌면 원래 해시로 거절하고 원격 전송을 시작하지 않는다 | - | 정적 |
| test/agent-file-forwarder.test.mjs | 105 | - | 원격 시작 뒤 소스 교체는 실제 불변 스냅샷의 바이트를 바꾸지 않는다 | - | 정적 |
| test/agent-file-forwarder.test.mjs | 110 | - | 동시 선택과 동시 실행 및 재시작은 원격 전송을 한 번만 만든다 | - | 정적 |
| test/agent-file-forwarder.test.mjs | 117 | - | 대상 revision 변경 또는 비활성화는 선택 당시 의도를 새 대상으로 바꾸지 않는다 | - | 정적 |
| test/agent-file-forwarder.test.mjs | 124 | - | 선택 시 누락되거나 비활성 또는 중복된 대상은 고정할 수 없다 | - | 정적 |
| test/agent-file-forwarder.test.mjs | 131 | - | 결과 불명 시작은 재시작·재실행·재개에서 새 업로드를 만들지 않는다 | - | 정적 |
| test/agent-file-forwarder.test.mjs | 140 | - | 알려진 전송은 같은 바이트·전송 ID로 명시 재개하고 새 업로드를 만들지 않는다 | - | 정적 |
| test/agent-file-forwarder.test.mjs | 147 | - | 선택된 업로드에 다운로드·저장을 적용해도 원격 변형은 없다 | - | 정적 |
| test/agent-file-forwarder.test.mjs | 153 | - | 엄격한 선택 입력과 일반 파일이 아닌 경로는 업로드 없이 거절된다 | - | 정적 |
| test/agent-file-forwarder.test.mjs | 161 | - | 파일 심볼릭 링크는 선택할 수 없다 | - | 정적 |
| test/agent-file-forwarder.test.mjs | 170 | - | 손상된 선택 기록은 재선택으로 복구하거나 새 업로드를 만들지 않는다 | - | 정적 |
| test/agent-file-forwarder.test.mjs | 181 | - | WINDOWS-SELECTION drive and backslash destinations preserve binary bytes and pinned Windows target | - | 정적 |
| test/agent-file-forwarder.test.mjs | 199 | - | PLATFORM-SELECTION incompatible or unsafe remote destinations fail before transfer and leave no selection | - | 정적 |
| test/agent-file-forwarder.test.mjs | 211 | - | PLATFORM-SELECTION unknown advertised platform refuses target without creating a selection | - | 정적 |
| test/agent-file-forwarder.test.mjs | 217 | - | FWD-TARGET-API target transport, authentication and malformed replies retain safe codes and target-query stage | - | 정적 |
| test/agent-file-forwarder.test.mjs | 237 | - | FWD-CLEANUP cleanup failure reports its own stage while a primary target failure remains primary | - | 정적 |
| test/agent-file-forwarder.test.mjs | 257 | - | FWD-LOCAL-SOURCE missing and non-file paths are public snapshot failures without publishing a selection | - | 정적 |
| test/agent-file-forwarder.test.mjs | 269 | - | FWD-STATUS-API known request read failures retain unknown state, metadata and capability-status stage after restart | - | 정적 |
| test/agent-file-mcp-process.test.mjs | 34 | - | 실제 MCP 프로세스는 명시 모드에서만 선택 도구를 노출하고 엄격 입력과 메타데이터를 지킨다 | - | 정적 |
| test/agent-file-mcp-process.test.mjs | 48 | - | 서로 다른 MCP 프로세스의 동시 claim과 재시작은 업로드를 한 번만 만든다 | - | 정적 |
| test/agent-file-mcp-process.test.mjs | 56 | - | 원격 시작 직후 실제 프로세스 종료는 재시작 뒤 새 업로드나 재개를 만들지 않는다 | - | 정적 |
| test/agent-file-mcp-process.test.mjs | 63 | - | 잘못 섞은 명시 선택 모드 CLI 인자는 인증 helper 전에 거절된다 | - | 정적 |
| test/agent-file-mcp-process.test.mjs | 77 | - | SDK-WINDOWS selection accepts both drive path forms and uploads once with status after restart | - | 정적 |
| test/agent-file-mcp-process.test.mjs | 95 | - | SDK-REFUSAL known unavailable ID path and selection mismatch remain distinct without effects | - | 정적 |
| test/agent-file-mcp-process.test.mjs | 111 | - | SDK-VALIDATION malformed IDs and extra authority never dispatch or create a selection | - | 정적 |
| test/agent-file-mcp-process.test.mjs | 129 | - | SDK-ERROR-CODES allowlisted credentials stay actionable and private exception details stay opaque | - | 정적 |
| test/agent-file-mcp-process.test.mjs | 142 | - | STDIO-LOCAL-CAUSES missing source, non-file source and unusable snapshot temp stay distinct | - | 정적 |
| test/agent-file-mcp-process.test.mjs | 155 | - | STDIO-JOURNAL corrupt owned selection is a capability-load refusal and never starts another transfer | - | 정적 |
| test/agent-file-mcp-process.test.mjs | 166 | - | STDIO-RUNTIME executing process reports safe identity without selecting, authenticating or uploading | - | 정적 |
| test/agent-file-mcp-process.test.mjs | 186 | - | STDIO-SAFE-ERRORS semantic codes and trusted stages survive while raw exception fields remain private | - | 정적 |
| test/agent-upload.test.mjs | 82 | - | native upload schema freezes metadata and keeps approval authority private to the owner | - | 정적 |
| test/agent-upload.test.mjs | 111 | - | URL/file references cannot enter native staging; blocked sources stay offline and UI-disabled uploads retain owner denial | - | 정적 |
| test/agent-upload.test.mjs | 130 | - | native input rejects provider URLs while the retained source boundary permits exact and regional hosts only | - | 정적 |
| test/agent-upload.test.mjs | 154 | - | source, public error, audit and configured queue refusals clean staging without remote mutation or private error leaks | - | 정적 |
| test/agent-upload.test.mjs | 177 | - | in-flight source imports and native partial staging block maintenance without granting submission authority | - | 정적 |
| test/agent-upload.test.mjs | 195 | - | native disconnect and shutdown retain acknowledged bytes; source cancellation still releases unsubmitted imports | - | 정적 |
| test/aik-180.test.mjs | 56 | - | AIK uses actual MCP 1.8 submit/observe calls with stable tracking and private authority | - | 정적 |
| test/aik-180.test.mjs | 90 | - | AIK rejects authority revoked during explicit MCP output read before returning bytes | - | 정적 |
| test/aik-180.test.mjs | 102 | - | AIK keeps audit failure distinct and never turns it into a success receipt | - | 정적 |
| test/aik-180.test.mjs | 113 | - | AIK preserves supervisor reconciliation evidence after a deadline | - | 정적 |
| test/aik-180.test.mjs | 125 | - | AIK preserves uncertain dispatch without replay and refuses legacy or mismatched envelopes | - | 정적 |
| test/aik-180.test.mjs | 143 | - | AIK preserves a confirmed admission refusal without replay | - | 정적 |
| test/aik-ags.test.mjs | 9 | - | AIK authorization and AGS ACK do not become owner approval or completion | - | 정적 |
| test/aik-ags.test.mjs | 22 | - | unknown delivery keeps the prepared ID and does not retry or classify | - | 정적 |
| test/aik-ags.test.mjs | 32 | - | AIK denial stops before sending or calling Jev | - | 정적 |
| test/aik-ags.test.mjs | 39 | - | serialized ToolSession imitation is rejected | - | 정적 |
| test/aik-ags.test.mjs | 44 | - | AIK target scheme/path validation refuses bare host and traversal before messaging | - | 정적 |
| test/aik-ags.test.mjs | 52 | - | AGS send requires prepared ID and prior intent | - | 정적 |
| test/aik-ags.test.mjs | 58 | - | AGS UTF-8 body limit and unsupported operations are enforced | - | 정적 |
| test/approval-callback.test.mjs | 29 | - | approval callback arrives before execution completion; late waits observe the existing result | - | 정적 |
| test/approval-callback.test.mjs | 44 | - | evaluation does not signal approval; automatic policy approval and repeated waiters do not execute twice | - | 정적 |
| test/approval-callback.test.mjs | 57 | - | denial, failed execution, unknown source and missing IDs are not approval success | - | 정적 |
| test/approval-callback.test.mjs | 70 | - | audit or persistence failure cannot send approval or execute a command | - | 정적 |
| test/approval-callback.test.mjs | 83 | - | expiry wakes without a queue reaper, while timeout leaves the original request pending | - | 정적 |
| test/approval-callback.test.mjs | 97 | - | expiry wake before the wall-clock deadline rearms without consuming the caller timeout | - | 정적 |
| test/approval-callback.test.mjs | 125 | - | abort, saturation and invalid deadlines release subscriptions without cancelling the operation | - | 정적 |
| test/approval-callback.test.mjs | 142 | - | router delegates to the exact owning queue and refuses ambiguous IDs | - | 정적 |
| test/approval-callback.test.mjs | 181 | - | real SDK observation reports approval before completion and omits stored output bodies | - | 정적 |
| test/approval-callback.test.mjs | 199 | - | MCP denial, timeout, unknown ID and SDK cancellation preserve zero execution | - | 정적 |
| test/approval-callback.test.mjs | 216 | - | actual HTTP disconnect and shutdown release observations without executing pending requests | - | 정적 |
| test/approval-callback.test.mjs | 232 | - | terminal audit or persistence failure remains visible and never retries completed effects | - | 정적 |
| test/approval-callback.test.mjs | 244 | - | approval and completion race with abort exactly once, including duplicate state notifications | - | 정적 |
| test/approval-callback.test.mjs | 273 | - | MCP observes terminal audit failure without replaying the original effects | - | 정적 |
| test/approval-callback.test.mjs | 287 | - | timeout and completion ordering settle once under the same clock tick | - | 정적 |
| test/approval-expiry.test.mjs | 13 | - | command, upload and elevated download approval tickets last one hour and execute only once | - | 정적 |
| test/approval-expiry.test.mjs | 33 | - | approval expires exactly at one hour and restored old requests retain their original deadline | - | 정적 |
| test/approval-expiry.test.mjs | 50 | - | upload staging remains ten minutes while a submitted upload stays pinned through its one-hour approval window | - | 정적 |
| test/artifact-cleanup-contract.test.mjs | 69 | - | 'MCP observes Windows staged refusal with ' + (cleanupConfirmed ? 'confirmed' : 'unconfirmed') + ' cleanup without replay' | - | 동적 |
| test/artifact-cleanup-contract.test.mjs | 105 | - | MCP records local download quota as failed and not dispatched while preserving the exact quota cause | - | 정적 |
| test/artifact-durability.test.mjs | 26 | - | partial uploads, operation contracts and all acknowledged chunk sequences survive restart | - | 정적 |
| test/artifact-durability.test.mjs | 55 | - | restart rolls back unacknowledged byte tails and rejects changed acknowledged bytes | - | 정적 |
| test/artifact-durability.test.mjs | 67 | - | completed downloads and expiration retain their metadata and quota across restart | - | 정적 |
| test/artifact-durability.test.mjs | 79 | - | upload completion converges on one request and retains its submission binding after restart | - | 정적 |
| test/artifact-durability.test.mjs | 100 | - | native download pages bind the original target and verified artifact without bearer links | - | 정적 |
| test/artifact-durability.test.mjs | 124 | - | restoration refuses symlink metadata and leaves staged bytes intact | - | 정적 |
| test/artifact-durability.test.mjs | 134 | - | recovery completes a committed removal and quarantines legacy bytes without blocking startup | - | 정적 |
| test/artifact-durability.test.mjs | 156 | - | partial upload expiration and explicit release remain effective after restart | - | 정적 |
| test/artifact-durability.test.mjs | 172 | - | legacy recovery charges exact retained bytes alongside live reservations without rewriting evidence | - | 정적 |
| test/artifact-durability.test.mjs | 202 | - | actual retained legacy bytes still enforce the shared staging budget | - | 정적 |
| test/artifact-durability.test.mjs | 212 | - | unsafe legacy ownership remains preserved and conservatively charged without following or unlinking it | - | 정적 |
| test/artifact-durability.test.mjs | 224 | - | artifact allocation is governed by byte budget rather than a fixed item count | - | 정적 |
| test/artifact-durability.test.mjs | 233 | - | maintenance reaping policy preserves expired bytes, manifests and accounting until released | - | 정적 |
| test/artifact-restart-unavailable.test.mjs | 85 | - | F4-REAP completed upload survives two real application restarts after TTL artifact removal without replay | - | 정적 |
| test/artifact-restart-unavailable.test.mjs | 103 | - | F4-MISSING denied upload history survives explicit artifact removal and restart without creating execution | - | 정적 |
| test/artifact-restart-unavailable.test.mjs | 115 | - | F4-PRESERVE restart keeps pending pinned and partial artifacts while cleaning present terminal artifacts | - | 정적 |
| test/artifact-restart-unavailable.test.mjs | 143 | - | F4-RELEASE missing cleanup is typed and repeatable while present wrong target or revision remains forbidden | - | 정적 |
| test/artifacts.test.mjs | 10 | - | prepareRoot creates a private directory before initialization and preserves expired staging unchanged | - | 정적 |
| test/artifacts.test.mjs | 36 | - | prepareRoot refuses a symbolic-link root without changing its target | - | 정적 |
| test/artifacts.test.mjs | 44 | - | binary and empty uploads: chunks are idempotent, hash-bound and quota-limited | - | 정적 |
| test/artifacts.test.mjs | 62 | - | expired/incomplete uploads refuse publication and reaping frees capacity | - | 정적 |
| test/artifacts.test.mjs | 74 | - | stream imports reserve capacity before opening, hash exact bytes and reuse ready-file verification | - | 정적 |
| test/artifacts.test.mjs | 103 | - | stream import failures, truncation, overflow and cancellation leave no file or quota | - | 정적 |
| test/audit-gate.test.mjs | 5 | - | deployment gate reads exactly one final verdict and ignores PASS elsewhere | - | 정적 |
| test/automatic-downloads.test.mjs | 34 | - | downloads require explicit target opt-in and elevated downloads require both reviewed switches | - | 정적 |
| test/automatic-downloads.test.mjs | 45 | - | download flag validation and exact feedback confirmation prevent unreviewed authority | - | 정적 |
| test/automatic-downloads.test.mjs | 54 | - | automatic download queues behind busy execution but stale target and audit failure still refuse | - | 정적 |
| test/automatic-downloads.test.mjs | 71 | - | global automation OFF still permits owner-approved downloads, never policy execution | - | 정적 |
| test/automatic-downloads.test.mjs | 75 | - | settings is a safe HTML entry while observation data remains owner authenticated and target bound | - | 정적 |
| test/automatic-downloads.test.mjs | 86 | - | test server bypass covers elevated downloads without other flags and never leaks across targets | - | 정적 |
| test/automatic-downloads.test.mjs | 95 | - | test server download waits behind an active transfer without falling back to owner approval | - | 정적 |
| test/automatic-uploads.test.mjs | 29 | - | uploads default to owner approval; exact reviewed opt-in applies to one target and can be disabled | - | 정적 |
| test/automatic-uploads.test.mjs | 40 | - | file picker and imported files share policy; overwrite and sudo always retain owner approval | - | 정적 |
| test/automatic-uploads.test.mjs | 47 | - | invalid flag and altered unconfirmed policy cannot grant upload authority | - | 정적 |
| test/automatic-uploads.test.mjs | 55 | - | revocation while importing and stale target fencing prevent automatic publication | - | 정적 |
| test/automatic-uploads.test.mjs | 61 | - | busy automatic upload queues and starts exactly once when a slot becomes free | - | 정적 |
| test/automatic-uploads.test.mjs | 66 | - | execution audit failure grants no upload and is not silently retried | - | 정적 |
| test/automatic-uploads.test.mjs | 75 | - | global automation off and blocked file source cannot cause automatic transmission | - | 정적 |
| test/automatic-uploads.test.mjs | 81 | - | test server bypass covers elevated overwrite uploads only on the reviewed target and is revoked at dispatch | - | 정적 |
| test/automatic-uploads.test.mjs | 92 | - | test server upload waits behind an active transfer without falling back to owner approval | - | 정적 |
| test/automation-metrics.test.mjs | 6 | - | metrics project only recorded decisions, preserve target/window boundaries and distinguish unknown cost/quality | - | 정적 |
| test/automation-metrics.test.mjs | 24 | - | disabled automation reports unavailable measurements rather than zero observed use | - | 정적 |
| test/bridge-cli-runtime.test.mjs | 6 | - | BRIDGE-CLI-RUNTIME actual entrypoint enables owner CLI without remote calls or automation changes | - | 정적 |
| test/browser/admin-workflow.test.mjs | 29 | - | 'UI168 동일 이름 대상·상태 상세·서버 초안·관리 범위 '+width | - | 동적 |
| test/browser/admin-workflow.test.mjs | 107 | - | UI168 실제 기존 장부의 24시간 초과 기록을 날짜로 조회하며 실행하지 않는다 | - | 정적 |
| test/browser/agent-cli.test.mjs | 71 | - | `CLI UI ${browserName} ${locale} ${width}: scoped explicit flow, keyboard and scrolling` | - | 동적 |
| test/browser/agent-cli.test.mjs | 81 | - | CLI UI both providers, lost submit/start responses recover with GET only | - | 정적 |
| test/browser/agent-cli.test.mjs | 85 | - | CLI UI stale preview response cannot cross provider or page scopes | - | 정적 |
| test/browser/agent-cli.test.mjs | 89 | - | CLI UI missing record and unknown status never auto-submit; logout clears public hints | - | 정적 |
| test/browser/agent-cli.test.mjs | 94 | - | CLI UI submission pins its server and provider until reconciled; output scroll stays local | - | 정적 |
| test/browser/agent-cli.test.mjs | 101 | - | CLI UI invalid public hints are ignored and never become execution authority | - | 정적 |
| test/browser/agent-cli.test.mjs | 104 | - | 'CLI-HISTORY cold browser reads an explicitly selected saved request and output without POST '+locale+' compiled='+compiled | - | 동적 |
| test/browser/agent-cli.test.mjs | 116 | - | CLI-HISTORY older pages are explicit GET reads and retain the selected request ID | - | 정적 |
| test/browser/agent-cli.test.mjs | 125 | - | 'CLI-HISTORY late history reply cannot cross '+change+' scope' | - | 동적 |
| test/browser/agent-cli.test.mjs | 131 | - | CLI-HISTORY wrong-binding metadata is refused before a saved request can be selected | - | 정적 |
| test/browser/agent-cli.test.mjs | 136 | - | 'CLI UI external coexistence and managed update are explicit '+locale | - | 동적 |
| test/browser/agent-cli.test.mjs | 141 | - | 'CLI-LOGIN UI explicit status and account/Node guidance '+locale | - | 동적 |
| test/browser/agent-cli.test.mjs | 157 | - | CLI-LOGIN UI late results cannot cross target/provider/page/logout scopes | - | 정적 |
| test/browser/agent-cli.test.mjs | 169 | - | LOGOUT compiled administrator UI revokes locally and reconnects without global logout | - | 정적 |
| test/browser/agent-cli.test.mjs | 178 | - | 'LOGOUT response loss remains local and explicit retry finishes '+locale | - | 동적 |
| test/browser/agent-cli.test.mjs | 186 | - | 'BOOTSTRAP compiled UI explicit recovery '+locale+' '+failure | - | 동적 |
| test/browser/agent-cli.test.mjs | 194 | - | `CLI-LOGIN ${browserName} ${locale} explains fixed reasons without exposing arbitrary details` | - | 동적 |
| test/browser/async-approval.test.mjs | 10 | - | `owner approval releases the browser while actual execution is held (${failed ? 'failed' : 'completed'})` | - | 동적 |
| test/browser/capacity-desktop.test.mjs | 70 | - | 'CAPACITY-BROWSER user saves global/target limits with null inheritance and CAS ' + suffix | - | 동적 |
| test/browser/capacity-desktop.test.mjs | 94 | - | 'DESKTOP-BROWSER real viewer gestures retain frame/sequence and close before logout ' + suffix | - | 동적 |
| test/browser/capacity-desktop.test.mjs | 113 | - | CAPACITY-BROWSER conflict and committed response loss require explicit GET without replay | - | 정적 |
| test/browser/capacity-desktop.test.mjs | 129 | - | DESKTOP-BROWSER lost input never replays and explicit observation recovers the next sequence | - | 정적 |
| test/browser/command-line-import.test.mjs | 46 | - | 'command import review/save and scroll '+width+' '+locale | - | 동적 |
| test/browser/command-line-import.test.mjs | 60 | - | unsupported/stale source never stages partial names or posts | - | 정적 |
| test/browser/command-line-import.test.mjs | 64 | - | name limit rejects a whole selected batch and scope changes clear the private command | - | 정적 |
| test/browser/command-line-import.test.mjs | 69 | - | history completed command opens matching target with no selected names or policy post | - | 정적 |
| test/browser/command-line-import.test.mjs | 73 | - | 'history mismatched '+field+' cannot prefill a new policy' | - | 동적 |
| test/browser/command-line-import.test.mjs | 77 | - | history without a binding has a disabled import button | - | 정적 |
| test/browser/command-line-import.test.mjs | 81 | - | state+' command does not offer history registration' | - | 동적 |
| test/browser/command-line-import.test.mjs | 91 | - | non-command history does not offer command registration | - | 정적 |
| test/browser/command-line-import.test.mjs | 95 | - | submitted source history does not register its executor as a command name | - | 정적 |
| test/browser/command-line-import.test.mjs | 99 | - | logout clears a pasted command and a delayed history import cannot restore it | - | 정적 |
| test/browser/command-line-import.test.mjs | 103 | - | history navigation while binding reload is pending discards late prefill | - | 정적 |
| test/browser/command-line-import.test.mjs | 107 | - | failed policy reload clears private import at request start and keeps it cleared after failure | - | 정적 |
| test/browser/command-line-import.test.mjs | 113 | - | oversized paste never silently truncates the command before extraction | - | 정적 |
| test/browser/command-line-import.test.mjs | 119 | - | 'LIMIT-BROWSER full 32KiB paste retains tail and browser layout '+width | - | 동적 |
| test/browser/command-line-import.test.mjs | 129 | - | LIMIT-HISTORY full 32KiB command imports from completed history without truncation or save | - | 정적 |
| test/browser/command-output.test.mjs | 22 | - | card output is explicit UI-only and display metadata changes do not repeat terminal model context | - | 정적 |
| test/browser/command-output.test.mjs | 38 | - | late card output cannot overwrite a replacement request | - | 정적 |
| test/browser/command-output.test.mjs | 46 | - | web history reads no output before explicit click and keeps content outside polling snapshots | - | 정적 |
| test/browser/command-output.test.mjs | 54 | - | late web output is discarded through target A to B to A replacement | - | 정적 |
| test/browser/command-output.test.mjs | 63 | - | built administrator bundle loads stored result from actual authenticated application only on click | - | 정적 |
| test/browser/command-policy.test.mjs | 82 | - | 'simple registration preserves explicit consent and fits mobile ' + width | - | 동적 |
| test/browser/command-policy.test.mjs | 120 | - | Jev 90 percent needs no manual reference and persists exactly the reviewed candidate | - | 정적 |
| test/browser/command-policy.test.mjs | 145 | - | legacy, 80 percent, fallback, denied rules and other targets survive command-only editing; migration is explicit | - | 정적 |
| test/browser/command-policy.test.mjs | 168 | - | v4 threshold stays unchanged until an explicit v5 conversion is reviewed and saved | - | 정적 |
| test/browser/command-policy.test.mjs | 194 | - | `v4 conversion explains the changed score meaning for ${provider} in ${surface}` | - | 동적 |
| test/browser/command-policy.test.mjs | 211 | - | 'late review cannot authorize a changed draft: ' + mode | - | 동적 |
| test/browser/command-policy.test.mjs | 232 | - | expired feedback clears OK without losing input, and an unobserved save preserves the draft without retry | - | 정적 |
| test/browser/command-policy.test.mjs | 250 | - | local high-risk warning remains prominent even when Jev reports low risk | - | 정적 |
| test/browser/command-policy.test.mjs | 257 | - | command search matches descriptions, preserves review for filters, and selection clears OK | - | 정적 |
| test/browser/command-policy.test.mjs | 280 | - | search Enter keeps the reviewed draft unsaved until the save button is clicked | - | 정적 |
| test/browser/command-policy.test.mjs | 290 | - | saved empty and custom command policies are not replaced by defaults | - | 정적 |
| test/browser/command-policy.test.mjs | 299 | - | download opt-in is visible, exact-review-bound and isolated per target | - | 정적 |
| test/browser/command-policy.test.mjs | 309 | - | settings is a separate URL, navigation preserves unsaved input without storing credentials and metrics load on demand | - | 정적 |
| test/browser/command-policy.test.mjs | 321 | - | upload opt-in is explicit, review-bound, preserved per target and reversible | - | 정적 |
| test/browser/command-policy.test.mjs | 340 | - | model selection is above consent, invalidates review, and threshold errors stay beside their input | - | 정적 |
| test/browser/command-policy.test.mjs | 356 | - | important upload and sudo controls are isolated in server permissions; changes require exact feedback and OK | - | 정적 |
| test/browser/command-policy.test.mjs | 379 | - | model autoapproval is visible beside transfer controls and requires review and OK while preserving the saved threshold | - | 정적 |
| test/browser/command-policy.test.mjs | 405 | - | target drafts preserve raw inputs but never reuse review; other-target updates use the newest snapshot | - | 정적 |
| test/browser/command-policy.test.mjs | 422 | - | same-target policy conflicts preserve the old raw draft for copying and require explicit latest start | - | 정적 |
| test/browser/command-policy.test.mjs | 434 | - | changed target bindings never silently rebind a preserved draft | - | 정적 |
| test/browser/command-policy.test.mjs | 444 | - | unknown save locks authority edits; failed read stays unknown and matching read reports only current equality | - | 정적 |
| test/browser/command-policy.test.mjs | 459 | - | uncommitted unknown save keeps a differing draft; later conflicting current policy is never overwritten | - | 정적 |
| test/browser/command-policy.test.mjs | 468 | - | selection exposes capability and same-count deltas; 128 names remain filterable and removable on narrow screens | - | 정적 |
| test/browser/command-policy.test.mjs | 480 | - | hidden advanced errors open their ancestors and expired consent restores keyboard focus | - | 정적 |
| test/browser/command-policy.test.mjs | 487 | - | late feedback does not steal search focus and search descriptions remain available to accessibility APIs | - | 정적 |
| test/browser/command-policy.test.mjs | 497 | - | 'expiration remains announced outside hidden settings without stealing focus '+mode | - | 동적 |
| test/browser/command-policy.test.mjs | 506 | - | 'late feedback reports outside collapsed settings and preserves navigation focus '+outcome | - | 동적 |
| test/browser/command-policy.test.mjs | 515 | - | settings workspace tabs preserve one reviewed draft through keyboard navigation without requests | - | 정적 |
| test/browser/command-policy.test.mjs | 530 | - | settings workspace shows saved and draft rule membership and preserves overlapping deny on edits | - | 정적 |
| test/browser/command-policy.test.mjs | 545 | - | settings workspace direct names and catalog navigation never silently register or normalize raw bulk input | - | 정적 |
| test/browser/command-policy.test.mjs | 558 | - | settings workspace hidden model validation opens its tab while retaining command changes | - | 정적 |
| test/browser/command-policy.test.mjs | 567 | - | settings workspace tab navigation stays available while an unknown save locks all command actions | - | 정적 |
| test/browser/command-policy.test.mjs | 579 | - | 'command master detail separates selection from edits and keeps review '+width | - | 동적 |
| test/browser/command-policy.test.mjs | 599 | - | 'command list scroll keeps headers and selection independent '+width | - | 동적 |
| test/browser/command-policy.test.mjs | 617 | - | test server option keeps per-target drafts and saves without altering other permissions | - | 정적 |
| test/browser/command-policy.test.mjs | 637 | - | test server option is disabled without the server secret and exposes no secret reference | - | 정적 |
| test/browser/command-policy.test.mjs | 645 | - | a saved test server setting can be disabled after secret availability is lost | - | 정적 |
| test/browser/desktop-draft.test.mjs | 43 | - | DESKTOP-DRAFT automatic observation preserves draft focus, selection and typing | - | 정적 |
| test/browser/desktop-draft.test.mjs | 52 | - | DESKTOP-DRAFT manual refresh and connection checks preserve editable local draft | - | 정적 |
| test/browser/desktop-draft.test.mjs | 62 | - | DESKTOP-DRAFT completing a send preserves a newly edited draft and sends only its snapshot | - | 정적 |
| test/browser/desktop-draft.test.mjs | 74 | - | DESKTOP-DRAFT an unchanged successful send clears its draft; closing and reopening cannot reuse it | - | 정적 |
| test/browser/desktop-draft.test.mjs | 82 | - | DESKTOP-DRAFT automatic capture cannot blur an empty focused one-time authentication field | - | 정적 |
| test/browser/desktop-gestures.test.mjs | 77 | - | DESKTOP-GESTURE capture overlap delivers ordered keys and scaled pointer to the host once | - | 정적 |
| test/browser/desktop-gestures.test.mjs | 89 | - | DESKTOP-GESTURE bursts during a pending key preserve order and text send reaches the host | - | 정적 |
| test/browser/desktop-gestures.test.mjs | 99 | - | DESKTOP-GESTURE uncertain committed input cancels unsent keys without replay after refresh | - | 정적 |
| test/browser/desktop-gestures.test.mjs | 109 | - | DESKTOP-GESTURE close, target changes and logout invalidate waiting gestures | - | 정적 |
| test/browser/desktop-gestures.test.mjs | 122 | - | DESKTOP-GESTURE composition and Tab stay local while queue saturation is visible and bounded | - | 정적 |
| test/browser/desktop-gestures.test.mjs | 132 | - | 'DESKTOP-LOGOUT controller closes once before admin sign-out during ' + scenario.action + ' uncertain=' + scenario.uncertain | - | 동적 |
| test/browser/environment.test.mjs | 59 | - | ENV browser edits fields, masks existing key, preserves blank secret and confirms save/restart | - | 정적 |
| test/browser/environment.test.mjs | 78 | - | ENV browser secret replacement/unset, conflict keeps draft, responsive width | - | 정적 |
| test/browser/environment.test.mjs | 98 | - | ENV browser lost restart reply reconciles by GET without another restart POST | - | 정적 |
| test/browser/environment.test.mjs | 106 | - | ENV browser explains pending-request refusal immediately without restarting | - | 정적 |
| test/browser/history-language.test.mjs | 24 | - | history dates include both local calendar boundaries and filter creation rather than finish time | - | 정적 |
| test/browser/history-language.test.mjs | 31 | - | history dates handle a 25 hour daylight saving day including both repeated hours | - | 정적 |
| test/browser/history-language.test.mjs | 36 | - | open history date bounds and clear dates keep search and status filters | - | 정적 |
| test/browser/history-language.test.mjs | 43 | - | invalid history dates show an accessible error without stale results or changing live queues | - | 정적 |
| test/browser/history-language.test.mjs | 50 | - | history dates reset pagination and combine with target, status and text search | - | 정적 |
| test/browser/history-language.test.mjs | 57 | - | history dates survive navigation and refresh while loaded output is read only once | - | 정적 |
| test/browser/history-language.test.mjs | 64 | - | history has an independent route and keeps filters, expanded DOM and loaded output across tabs/back/forward | - | 정적 |
| test/browser/history-language.test.mjs | 79 | - | filtered history pagination uses the filtered anchor and direct entry survives refresh on mobile | - | 정적 |
| test/browser/history-language.test.mjs | 90 | - | explicit language overrides browser language, persists across reload/navigation and stores no token or draft | - | 정적 |
| test/browser/history-language.test.mjs | 101 | - | Korean selection works in English browser, and automatic restores browser detection | - | 정적 |
| test/browser/history-language.test.mjs | 106 | - | disabled storage shows an accessible error | - | 정적 |
| test/browser/history-language.test.mjs | 111 | - | English settings translate dynamic command controls, input errors and ENV labels without changing server values | - | 정적 |
| test/browser/history-language.test.mjs | 128 | - | 'responsive history and language workflow '+viewport.name | - | 동적 |
| test/browser/history-language.test.mjs | 157 | - | invalid saved language safely uses browser detection without changing other storage | - | 정적 |
| test/browser/history-language.test.mjs | 162 | - | 'UI168 불완전 이력은 정상 0건과 구별하고 다음 완전 조회에서 경고를 해제한다 '+locale | - | 동적 |
| test/browser/multi-admin.test.mjs | 35 | - | 'query/policy scopes, draft/search and keyboard page navigation remain independent at '+width | - | 동적 |
| test/browser/multi-admin.test.mjs | 68 | - | language discard confirmation preserves all target drafts on cancel and only then stores preference | - | 정적 |
| test/browser/multi-admin.test.mjs | 79 | - | lost policy save blocks language reload and target jumps without replaying POST | - | 정적 |
| test/browser/multi-admin.test.mjs | 89 | - | ENV dirty/busy/uncertain blocks or confirms language change without printing or persisting secret inputs | - | 정적 |
| test/browser/multi-admin.test.mjs | 99 | - | a hung query is superseded immediately; late responses cannot replace the selected target | - | 정적 |
| test/browser/multi-admin.test.mjs | 108 | - | old metrics from A to B to A are discarded by generation including page changes | - | 정적 |
| test/browser/multi-admin.test.mjs | 117 | - | inactive policy deletion is explicit and reviewed; duplicate request IDs expose no approval buttons | - | 정적 |
| test/browser/multi-admin.test.mjs | 123 | - | lost approval response blocks language until a current request status reconciles without a second POST | - | 정적 |
| test/browser/multi-admin.test.mjs | 136 | - | download link POST blocks language while pending and cannot navigate after an explicit page change | - | 정적 |
| test/browser/multi-admin.test.mjs | 148 | - | 'download page generation rejects stale responses ('+navigation+'-'+outcome+')' | - | 동적 |
| test/browser/queued-state.test.mjs | 27 | - | `queued card polls without announcing completion and exposes cancellation only ${locale}` | - | 동적 |
| test/browser/queued-state.test.mjs | 49 | - | `queued web request stays active, refreshes approval explanation and cancels by deny ${locale}` | - | 동적 |
| test/browser/regressions.test.mjs | 44 | - | `OIDC browser uses cookie login and local logout ${locale} ${width}x${height}` | - | 동적 |
| test/browser/regressions.test.mjs | 64 | - | approval card labels actual automatic approval and removes it for owner approval | - | 정적 |
| test/browser/regressions.test.mjs | 75 | - | card and web show classification and actual review condition before diagnostic numbers | - | 정적 |
| test/browser/regressions.test.mjs | 106 | - | `binary assessment shows exactly its two recorded scores ${locale} ${label}` | - | 동적 |
| test/browser/regressions.test.mjs | 124 | - | UI-S-01 selected file cannot cross a card replacement | - | 정적 |
| test/browser/regressions.test.mjs | 131 | - | `UI-S-01 stale ${stage} cannot change the replacement card` | - | 동적 |
| test/browser/regressions.test.mjs | 146 | - | UI-S-02 unrelated 10-second refresh preserves node identity, focus, selection, open details and scroll | - | 정적 |
| test/browser/regressions.test.mjs | 168 | - | `UI preserved language and Access logout (${locale})` | - | 동적 |
| test/browser/regressions.test.mjs | 176 | - | server names distinguish installations, remain text, and accompany pending and completed jobs | - | 정적 |
| test/browser/regressions.test.mjs | 194 | - | card identity follows replacement and completed result without HTML injection or stale names | - | 정적 |
| test/browser/regressions.test.mjs | 212 | - | multi-target web filter retires a delayed old response and updates visible identity | - | 정적 |
| test/browser/regressions.test.mjs | 229 | - | card target replacement clears selected file and blocks late upload work for the former target | - | 정적 |
| test/browser/regressions.test.mjs | 245 | - | `web download response belongs to its captured selection generation (${mode})` | - | 동적 |
| test/browser/regressions.test.mjs | 268 | - | unified console counts all targets, separates running work, sorts across queues and acts on immutable IDs | - | 정적 |
| test/browser/regressions.test.mjs | 299 | - | approved history keeps historical scores and threshold while explaining the completed owner action in past tense | - | 정적 |
| test/browser/regressions.test.mjs | 331 | - | long history uses a full-width page of 20 and preserves expanded records across pages and polling | - | 정적 |
| test/browser/regressions.test.mjs | 348 | - | prepared download card distinguishes server readiness from local receipt and opens authenticated browser save | - | 정적 |
| test/browser/regressions.test.mjs | 357 | - | `recorded approval display separates admission, policy and AI history (${locale})` | - | 동적 |
| test/browser/regressions.test.mjs | 400 | - | 'owner and assessment details select localized context without mixing evaluator prose ' + locale | - | 동적 |
| test/browser/regressions.test.mjs | 422 | - | 'JEV failure details distinguish unavailable from uncertain ' + locale | - | 동적 |
| test/browser/source-automation.test.mjs | 48 | - | `SOURCE-BROWSER policy consent/drafts/save and source scroll ${browserName} ${width}x${height} ${ko ? 'ko' : 'en'}` | - | 동적 |
| test/browser/source-automation.test.mjs | 77 | - | `SOURCE-BROWSER delayed source never populates replaced scope ${browserName} ${action}` | - | 동적 |
| test/browser/windows-targets.test.mjs | 53 | - | Windows 기능 정보를 따라 이름·권한·Python·CLI를 제공하고 Linux 초안을 보존한다 | - | 정적 |
| test/browser/windows-targets.test.mjs | 106 | - | 대상 개요에 운영체제를 표시하고 Windows 이력의 명령 이름 등록을 제공한다 | - | 정적 |
| test/browser/windows-targets.test.mjs | 132 | - | Python 경로가 없거나 CLI가 지원되지 않으면 해당 기능만 비활성화한다 | - | 정적 |
| test/browser/windows-targets.test.mjs | 143 | - | Windows 이름 가져오기는 리터럴만 추출하고 동적 호출은 전체를 거부한다 | - | 정적 |
| test/browser/windows-targets.test.mjs | 154 | - | Windows 파일 카드의 권한 상승 선택은 기존 관리자 토큰을 설명한다 | - | 정적 |
| test/capacity-settings.test.mjs | 18 | - | capacity defaults follow available Relay CPUs and permit explicit positive safe integers | - | 정적 |
| test/capacity-settings.test.mjs | 33 | - | Docker installation default CLI uses the same Relay CPU defaults | - | 정적 |
| test/capacity-settings.test.mjs | 40 | - | target overrides inherit global values while retaining nullable startup configuration | - | 정적 |
| test/capacity-settings.test.mjs | 51 | - | target count and profile aliases retain payload and identity safeguards | - | 정적 |
| test/capacity-settings.test.mjs | 65 | - | desktop settings require an explicit immutable configuration bound to the target revision | - | 정적 |
| test/capacity-settings.test.mjs | 79 | - | initial installation persists CPU defaults and upgrades preserve saved capacities | - | 정적 |
| test/capacity-settings.test.mjs | 98 | - | installation fills only missing capacity fields and refuses invalid saved values atomically | - | 정적 |
| test/capacity-ui-desktop.test.mjs | 6 | - | desktop coordinates use framebuffer/CSS scaling once and complete pointer gestures release buttons | - | 정적 |
| test/capacity-ui-desktop.test.mjs | 13 | - | desktop shortcuts and Unicode use X11 keysyms and release every pressed key | - | 정적 |
| test/capacity-ui-desktop.test.mjs | 21 | - | logout awaits desktop close while suppressing duplicate logout gestures | - | 정적 |
| test/capacity-ui.test.mjs | 35 | - | capacity values preserve inheritance and reject zero, fractional, exponential and unsafe input | - | 정적 |
| test/capacity-ui.test.mjs | 41 | - | global and target saves carry CAS revision, explicit null inheritance and preserve other drafts | - | 정적 |
| test/capacity-ui.test.mjs | 55 | - | a committed save with a lost response is never replayed and a GET reconciles the actual value | - | 정적 |
| test/card-mcp-contract.test.mjs | 37 | - | card polls the actual MCP presentation once per refresh and renews private tickets without output reads | - | 정적 |
| test/card-mcp-contract.test.mjs | 46 | - | missing card preserves the actual MCP refusal without inventing a terminal state or resubmitting | - | 정적 |
| test/card-mcp-contract.test.mjs | 51 | - | download card submits current MCP fields with a stable key and pinned target revision, then loads the private card | - | 정적 |
| test/card-mcp-contract.test.mjs | 60 | - | lost download reply recovers the original key with observe and never creates a second submission | - | 정적 |
| test/card-mcp-contract.test.mjs | 67 | - | uncertain download intent cannot change path or target under its existing operation key | - | 정적 |
| test/card-mcp-contract.test.mjs | 74 | - | download refuses a card without a pinned revision before sending any operation | - | 정적 |
| test/card-mcp-contract.test.mjs | 79 | - | typed submit rejection is not mistaken for an accepted ID or a new rendered job | - | 정적 |
| test/card-mcp-contract.test.mjs | 84 | - | late presentation cannot replace another card | - | 정적 |
| test/cli-entrypoint.test.mjs | 14 | - | CLI entrypoints execute through the native installer directory link and remain inert on import | - | 정적 |
| test/cli-local-files.test.mjs | 24 | - | upload snapshot keeps exact binary bytes after source replacement, then releases its copy | - | 정적 |
| test/cli-local-files.test.mjs | 38 | - | empty and exact-limit snapshots work; oversized and nonregular input never reach consumer | - | 정적 |
| test/cli-local-files.test.mjs | 50 | - | snapshot rejects an observed source change during capture | - | 정적 |
| test/cli-local-files.test.mjs | 61 | - | snapshot consumer failure, early stream exit and abort release only owned staging | - | 정적 |
| test/cli-local-files.test.mjs | 75 | - | download verifies binary and empty files before publishing exact bytes | - | 정적 |
| test/cli-local-files.test.mjs | 86 | - | download mismatch, short/excessive and invalid bytes never publish | - | 정적 |
| test/cli-local-files.test.mjs | 96 | - | download preserves an existing file and a racing destination | - | 정적 |
| test/cli-local-files.test.mjs | 108 | - | concurrent publications have exactly one winner and retain complete bytes | - | 정적 |
| test/cli-local-files.test.mjs | 119 | - | download abort and producer error leave no destination or partial files | - | 정적 |
| test/cli-local-files.test.mjs | 129 | - | download cancellation after publication preserves success and saved bytes | - | 정적 |
| test/cli-local-files.test.mjs | 137 | - | hardlink destination cannot change a separate existing file | - | 정적 |
| test/cli-local-files.test.mjs | 144 | - | unsafe paths and invalid declared metadata are rejected before consuming bytes | - | 정적 |
| test/cli-local-files.test.mjs | 153 | - | download binds verified bytes to disk when the producer mutates its buffer after the real write | - | 정적 |
| test/cli-platform-paths.test.mjs | 27 | - | CLI upload, resume and download accept Windows and POSIX remote paths before credential acquisition | - | 정적 |
| test/cli-platform-paths.test.mjs | 39 | - | CLI rejects unsafe Windows and POSIX remote paths before credential acquisition | - | 정적 |
| test/client-install.test.mjs | 53 | - | I01 default plan is read-only and describes the version-specific target | - | 정적 |
| test/client-install.test.mjs | 63 | - | I02 rejects an incorrect trusted manifest pin before writing | - | 정적 |
| test/client-install.test.mjs | 71 | - | I03 rejects corrupted payload size and digest before writing | - | 정적 |
| test/client-install.test.mjs | 79 | - | `I04 rejects unsafe manifest path ${path}` | - | 동적 |
| test/client-install.test.mjs | 87 | - | I04 rejects case-insensitive duplicate paths | - | 정적 |
| test/client-install.test.mjs | 94 | - | I05 installs a fresh version alongside an untouched previous version | - | 정적 |
| test/client-install.test.mjs | 109 | - | I06 preserves unrelated handlers, disabled Native hooks, BOM/CRLF, and exact backups | - | 정적 |
| test/client-install.test.mjs | 133 | - | I07 repeated application is idempotent and does not add backup directories | - | 정적 |
| test/client-install.test.mjs | 146 | - | I08 preserves a changed same-version installation and refuses overwrite | - | 정적 |
| test/client-install.test.mjs | 156 | - | `I09 preserves invalid Codex config ${body}` | - | 동적 |
| test/client-install.test.mjs | 164 | - | I09 preserves an Antigravity hook-name conflict | - | 정적 |
| test/client-install.test.mjs | 172 | - | I10 rejects target parent symlink or Windows junction without touching its destination | - | 정적 |
| test/client-install.test.mjs | 180 | - | I10 rejects a host config parent link | - | 정적 |
| test/client-install.test.mjs | 189 | - | I11 generates TEST and PROD launchers with exact origin and executable arguments | - | 정적 |
| test/client-install.test.mjs | 208 | - | `I11 rejects unsafe launcher origin ${origin.replace('password', 'REDACTED')}` | - | 동적 |
| test/client-install.test.mjs | 215 | - | I12 refuses an existing installation lock and preserves it | - | 정적 |
| test/client-install.test.mjs | 223 | - | I13 Claude plan pins official read-only metadata and planned qualified commands without host mutation | - | 정적 |
| test/client-install.test.mjs | 240 | - | reviewed plan pin detects a changed source setting before any installation | - | 정적 |
| test/client-install.test.mjs | 247 | - | reviewed plan pin accepts the same inputs for apply | - | 정적 |
| test/client-install.test.mjs | 253 | - | host names are explicit and Gemini CLI is not accepted as Native Antigravity | - | 정적 |
| test/client-install.test.mjs | 310 | - | U01 source add then qualified user update verifies new version and preserves unrelated project plugin | - | 정적 |
| test/client-install.test.mjs | 323 | - | U02 exact registration is reused without a host mutation or another backup | - | 정적 |
| test/client-install.test.mjs | 335 | - | U03 disabled user selection survives source upgrade and official update | - | 정적 |
| test/client-install.test.mjs | 342 | - | U07 fresh registration adds source before qualified user install | - | 정적 |
| test/client-install.test.mjs | 350 | - | U04 existing foreign source is never retargeted even when it has no installed plugin | - | 정적 |
| test/client-install.test.mjs | 358 | - | `U04 refuses a source change shared with ${scope} scope` | - | 동적 |
| test/client-install.test.mjs | 367 | - | U08 dedicated catalog guard rejects another plugin before source mutation | - | 정적 |
| test/client-install.test.mjs | 376 | - | `U06 ${failStage} failure preserves a safe hostCode and exact partial stage without host output` | - | 동적 |
| test/client-install.test.mjs | 387 | - | U06 non-allowlisted host code is suppressed rather than exposing host output | - | 정적 |
| test/client-install.test.mjs | 397 | - | `U06 official exit zero is not success if final inventory differs: ${Object.keys(state)[0]}` | - | 동적 |
| test/client-install.test.mjs | 406 | - | `reviewed Claude plan rejects ${change} metadata changes before target or source mutation` | - | 동적 |
| test/client-install.test.mjs | 418 | - | Claude metadata changed at the apply lock boundary stops before copying or source mutation | - | 정적 |
| test/client-install.test.mjs | 425 | - | another installed plugin using the same marketplace identity blocks a source change | - | 정적 |
| test/client-install.test.mjs | 434 | - | AW17 origin installation configures automatic watch routes and preserves unrelated native handlers | - | 정적 |
| test/client-install.test.mjs | 457 | - | AW17 Claude package hooks receive the installed automatic watch config without changing another plugin | - | 정적 |
| test/client-install.test.mjs | 469 | - | AW17 malformed explicit MCP route aliases stop before installation or host configuration changes | - | 정적 |
| test/client-install.test.mjs | 477 | - | I14 --manifest-sha256 auto computes pin from source manifest and discovers cloudflared from PORTAL_CLOUDFLARED | - | 정적 |
| test/client-install.test.mjs | 489 | - | U09 recovers when a previously owned version directory was removed and Claude reports cache-miss | - | 정적 |
| test/codex-completion.test.mjs | 24 | - | C01 target validation only checks the explicit regular file and exact UUID | - | 정적 |
| test/codex-completion.test.mjs | 29 | - | C02 invalid target is rejected before notification execution | - | 정적 |
| test/codex-completion.test.mjs | 41 | - | C03 queues exact fixed arguments once, bounds execution, and reports acceptance only | - | 정적 |
| test/codex-completion.test.mjs | 56 | - | C04 only closed completion metadata is sent and the original event is preserved | - | 정적 |
| test/codex-completion.test.mjs | 68 | - | C05 invalid or nonterminal metadata never starts a queue command | - | 정적 |
| test/codex-completion.test.mjs | 80 | - | C06 accepted receipt plus stderr is queued with unconfirmed resumption without raw output | - | 정적 |
| test/codex-completion.test.mjs | 91 | - | C07 invalid receipts and recipient mismatch never claim queue acceptance | - | 정적 |
| test/codex-completion.test.mjs | 103 | - | C08 subprocess failures and timeout remain typed unknown outcomes without retransmission | - | 정적 |
| test/command-automation.test.mjs | 58 | - | every registered command bypasses argument-risk evaluation; all segments and nested names must match | - | 정적 |
| test/command-automation.test.mjs | 72 | - | model OR path executes sudo and unmatched commands only with explicit provider-specific safety probability policy | - | 정적 |
| test/command-automation.test.mjs | 86 | - | safety probability0.9 is inclusive and confidence is diagnostic rather than a second gate | - | 정적 |
| test/command-automation.test.mjs | 98 | - | legacy combined-confidence policy stays readable but never silently gains probability-only authority | - | 정적 |
| test/command-automation.test.mjs | 113 | - | explanations identify the first failed gate and preserve usage without changing authority | - | 정적 |
| test/command-automation.test.mjs | 135 | - | missing thresholds, denied names, disclosure and sensitive-input guards never autoexecute | - | 정적 |
| test/command-automation.test.mjs | 149 | - | fallback runs only after unavailability; no score shopping after a valid risky answer | - | 정적 |
| test/command-automation.test.mjs | 159 | - | policy revision change during evaluation discards the old automatic decision | - | 정적 |
| test/command-automation.test.mjs | 175 | - | request keys survive restart, reject changed arguments, and never replay completed execution | - | 정적 |
| test/command-automation.test.mjs | 184 | - | durable admission restores interrupted evaluation/execution as unknown and pending as expired | - | 정적 |
| test/command-automation.test.mjs | 193 | - | startup restores a natively claimed command as unknown and never automatically replays it | - | 정적 |
| test/command-automation.test.mjs | 224 | - | owner authentication, exact Origin, revision and target bindings protect policy mutations | - | 정적 |
| test/command-automation.test.mjs | 238 | - | a stored v2 threshold is loadable but cannot approve execution under the changed v5 question | - | 정적 |
| test/command-automation.test.mjs | 245 | - | stored v4 probability policy remains readable after restart but cannot authorize v5 evaluations | - | 정적 |
| test/command-automation.test.mjs | 255 | - | partial name approval never tells Jev the whole mixed line was explicitly approved | - | 정적 |
| test/command-automation.test.mjs | 261 | - | AIK adapter never dispatches before authority and keeps host authorization out of MCP | - | 정적 |
| test/command-automation.test.mjs | 279 | - | legacy three-label, subthreshold and malformed model results require human review | - | 정적 |
| test/command-automation.test.mjs | 292 | - | a newly denied command cannot execute through a previously issued owner request | - | 정적 |
| test/command-automation.test.mjs | 298 | - | concurrent duplicate key observes the same evaluating job and does not evaluate twice | - | 정적 |
| test/command-automation.test.mjs | 310 | - | execution admission audit failure cannot dispatch a preapproved command | - | 정적 |
| test/command-automation.test.mjs | 323 | - | an evaluated command retains observed usage when execution admission fails | - | 정적 |
| test/command-automation.test.mjs | 340 | - | unknown elevated programs and interpreter carriers route to independent evaluation | - | 정적 |
| test/command-automation.test.mjs | 348 | - | owner approval remains distinguishable from automatic approval after review | - | 정적 |
| test/command-automation.test.mjs | 355 | - | caller context survives routing, durable replay and restart without becoming approval | - | 정적 |
| test/command-automation.test.mjs | 370 | - | sensitive or oversized context is refused before queue admission and model dispatch | - | 정적 |
| test/command-automation.test.mjs | 376 | - | legacy v3 probability-only thresholds cannot authorize the v5 context question | - | 정적 |
| test/command-automation.test.mjs | 384 | - | registration feedback describes a proposal rather than an already approved command | - | 정적 |
| test/command-automation.test.mjs | 395 | - | reviewed model selection drives actual evaluator transport while preserving old pinned selections | - | 정적 |
| test/command-automation.test.mjs | 409 | - | missing or whitespace-only task context withholds the model call and execution; explicit command-name authority is unchanged | - | 정적 |
| test/command-automation.test.mjs | 421 | - | the native command MCP submission delivers exact task context through automation into the Jev HTTP body | - | 정적 |
| test/command-automation.test.mjs | 448 | - | sudo defaults to individual owner approval even if its name was saved; opt-in is separate and revocable | - | 정적 |
| test/command-automation.test.mjs | 462 | - | denied names remain prior to full-line bypass after shell quote removal | - | 정적 |
| test/command-automation.test.mjs | 468 | - | combined shell flags cannot hide unregistered or disabled sudo names | - | 정적 |
| test/command-automation.test.mjs | 475 | - | localized owner prose stays out of the real Jev wire body and remains bound across restart and replay | - | 정적 |
| test/command-automation.test.mjs | 505 | - | adopted prompt revision is journaled while saved v5 threshold policy stays byte-identical in meaning | - | 정적 |
| test/command-automation.test.mjs | 521 | - | failed model attempts retain prompt provenance without granting execution or relabeling no-call paths | - | 정적 |
| test/command-automation.test.mjs | 546 | - | D-PERSIST failed model diagnostics survive audit, database and restart without authority or provider text | - | 정적 |
| test/command-automation.test.mjs | 564 | - | D-COMPOSITION actual Jev adapter failure reaches command DB, observation cache and evaluation without raw data | - | 정적 |
| test/command-automation.test.mjs | 585 | - | LIMIT-AUTOMATION long approved prefix cannot bypass unmatched or denied final command | - | 정적 |
| test/command-automation.test.mjs | 594 | - | test server bypass overrides deny, sudo and missing evaluators only after exact owner save and survives restart | - | 정적 |
| test/command-automation.test.mjs | 618 | - | test server automatic command waits for execution capacity and replay never dispatches twice | - | 정적 |
| test/command-automation.test.mjs | 651 | - | application shutdown cancels queued automatic work and drains only the active command | - | 정적 |
| test/command-automation.test.mjs | 667 | - | test server secret is mandatory for policy registration, rechecked on save and dispatch, and hidden from clients | - | 정적 |
| test/command-automation.test.mjs | 688 | - | production portal without a server secret refuses a test bypass policy regardless of target display name | - | 정적 |
| test/command-automation.test.mjs | 697 | - | test server dispatch hook rejects secret revocation after adapter admission and never replays | - | 정적 |
| test/command-automation.test.mjs | 712 | - | test server dispatch guard permits a valid read without a queue job | - | 정적 |
| test/command-lifecycle.test.mjs | 22 | - | AP-02 a failed read hides transport text and releases the shared scheduler slot for queued work | - | 정적 |
| test/command-lifecycle.test.mjs | 49 | - | read audit failures preserve fail-closed admission and durable outcomes after terminal audit errors | - | 정적 |
| test/command-lifecycle.test.mjs | 72 | - | command routing returns durable jobs for reads and owner approvals and shares the scheduler | - | 정적 |
| test/command-lifecycle.test.mjs | 93 | - | AP-01 expiry audit failure cannot resurrect a request and notifies terminal ownership once | - | 정적 |
| test/command-lifecycle.test.mjs | 107 | - | completion audit failure preserves the completed operation and prevents retry | - | 정적 |
| test/command-lifecycle.test.mjs | 119 | - | lifecycle blocks maintenance for commands, imports, staged data, and pending jobs | - | 정적 |
| test/command-lifecycle.test.mjs | 134 | - | lifecycle cleanup still reaps capabilities when expiry auditing or file reaping fails | - | 정적 |
| test/command-lifecycle.test.mjs | 147 | - | lifecycle close claims maintenance, drains file work and transports, then waits for execution before closing SSH | - | 정적 |
| test/command-lifecycle.test.mjs | 160 | - | JSONL audit persists an explicit metadata allowlist and uses injected redaction without result, ticket or payload bytes | - | 정적 |
| test/command-limits.test.mjs | 16 | - | LIMIT-ASCII exact 32KiB accepted and one byte over rejected before classifier | - | 정적 |
| test/command-limits.test.mjs | 28 | - | LIMIT-UTF8 counts Korean/emoji bytes and refuses invalid Unicode or hidden characters | - | 정적 |
| test/command-limits.test.mjs | 39 | - | LIMIT-ENVELOPE keeps exact inner bytes and contexts with independent wire and command caps | - | 정적 |
| test/command-limits.test.mjs | 48 | - | LIMIT-TAIL full parser, denied-name guard and digest observe final executable | - | 정적 |
| test/command-limits.test.mjs | 55 | - | LIMIT-RECURSION repeated sudo beyond bounded grammar is incomplete | - | 정적 |
| test/command-limits.test.mjs | 60 | - | LIMIT-JEV exact full command and tail delivered once without experimental header | - | 정적 |
| test/command-limits.test.mjs | 73 | - | LIMIT-JEV provider rejects long input without retry or approval | - | 정적 |
| test/command-limits.test.mjs | 77 | - | LIMIT-SSH real pinned loopback channel receives complete 32KiB commands without shell execution | - | 정적 |
| test/command-line-import.test.mjs | 5 | - | import names reuse actual policy grammar for pipes sudo quoting and literal nested commands | - | 정적 |
| test/command-line-import.test.mjs | 12 | - | unsupported input never returns partial preapproval candidates | - | 정적 |
| test/command-line-import.test.mjs | 17 | - | 32KiB UTF-8 and80 name limits agree with existing policies without truncation | - | 정적 |
| test/command-line-import.test.mjs | 21 | - | empty and non-string input do not coerce or execute supplied values | - | 정적 |
| test/command-line.test.mjs | 5 | - | all shell segments and literal substitutions contribute names, never argument risk | - | 정적 |
| test/command-line.test.mjs | 16 | - | uncertain syntax cannot establish all-name approval | - | 정적 |
| test/command-line.test.mjs | 22 | - | sudo is separate authority and its inner executable still contributes a name | - | 정적 |
| test/command-output-accounting.test.mjs | 51 | - | more than eight failed reservations release empty payload charges without losing records or ready output | - | 정적 |
| test/command-output-accounting.test.mjs | 77 | - | partial write and unavailable persistence failure keep bytes charged across restart | - | 정적 |
| test/command-output-accounting.test.mjs | 99 | - | publication persistence failure retains the complete payload and its actual charge | - | 정적 |
| test/command-output-accounting.test.mjs | 115 | - | restart reconciles old unavailable and interrupted reservations, preserving expiry, both files and schema | - | 정적 |
| test/command-output-accounting.test.mjs | 142 | - | maintenance preserves old charges and exact rows until normal reserve can reconcile them | - | 정적 |
| test/command-output-accounting.test.mjs | 164 | - | missing and unsafe payload evidence conservatively retains the reservation; oversize bytes are fully charged | - | 정적 |
| test/command-output-accounting.test.mjs | 179 | - | oversize capture releases an untouched payload reservation and exposes only safe failure metadata | - | 정적 |
| test/command-output-accounting.test.mjs | 194 | - | ready captures retain safe executor diagnostics without changing output bytes or blessing invalid metadata | - | 정적 |
| test/command-output-stream180.test.mjs | 27 | - | partial stdout/stderr bytes are durable before finish, paged by cursor, and independent of UTF8 boundaries | - | 정적 |
| test/command-output-stream180.test.mjs | 46 | - | finish preserves timeout metadata and the legacy immutable snapshot alongside captured bytes | - | 정적 |
| test/command-output-stream180.test.mjs | 62 | - | finish preserves exit status and signal through durable operation settlement without changing outcome certainty | - | 정적 |
| test/command-output-stream180.test.mjs | 85 | - | finish rejects invalid exit status and signal metadata from its public projection | - | 정적 |
| test/command-output-stream180.test.mjs | 94 | - | truncation bounds physical spool bytes, records loss and retains committed bytes after capture failure | - | 정적 |
| test/command-output-stream180.test.mjs | 106 | - | stream reads reject revocation, damage, hardlinks and expiration, while interrupted tails are ignored | - | 정적 |
| test/command-output-stream180.test.mjs | 124 | - | stream reservation checks its full capacity before dispatch without altering legacy capacity | - | 정적 |
| test/command-output-stream180.test.mjs | 131 | - | a failed manifest checkpoint exposes only the preceding durable cursor and retains uncommitted evidence | - | 정적 |
| test/command-output-stream180.test.mjs | 149 | - | abandon closes the stream without dropping bytes, while finish strips unknown execution properties | - | 정적 |
| test/command-output-stream180.test.mjs | 159 | - | preservation baseline hashes stream bytes including interrupted tails and detects their mutation | - | 정적 |
| test/command-output-stream180.test.mjs | 176 | - | maintenance retains expired stream bytes and exact accounting without extending read authority | - | 정적 |
| test/command-output.test.mjs | 29 | - | output snapshots preserve text blocks/data exactly across UTF8 pages and restart without execution | - | 정적 |
| test/command-output.test.mjs | 48 | - | capacity/expiry and interrupted capture remain independent from execution identity | - | 정적 |
| test/command-output.test.mjs | 61 | - | MAINT-OUTPUT cleanup guard preserves expired rows and bytes at restart, reap and reserve without extending read authority | - | 정적 |
| test/command-output.test.mjs | 85 | - | crash before manifest admission quarantines orphan bytes without blocking startup or replaying | - | 정적 |
| test/command-output.test.mjs | 95 | - | each output read checks current authorization and only returns verified payload bytes | - | 정적 |
| test/command-output.test.mjs | 116 | - | actual MCP/HTTP defaults omit sentinel and arbitrary command data; explicit reads alone expose bounded body | - | 정적 |
| test/command-output.test.mjs | 182 | - | signal delivery survives actual command output capture, durable storage and MCP observe without proving remote exit | - | 정적 |
| test/command-output.test.mjs | 225 | - | AIK output observation requires original binding and revalidates after delayed reads | - | 정적 |
| test/command-output.test.mjs | 242 | - | legacy journal conversion preserves snapshot; expiry and restart retain durable replay protection | - | 정적 |
| test/command-policy-review.test.mjs | 17 | - | registration risk feedback precedes persistence and carries proposals rather than user approval | - | 정적 |
| test/command-policy-review.test.mjs | 31 | - | concurrent reviews and unconsumed confirmation storage have fixed bounds | - | 정적 |
| test/command-policy-review.test.mjs | 43 | - | missing OK, forged token, altered proposal and stale revision cannot register; tokens are single use | - | 정적 |
| test/command-policy-review.test.mjs | 53 | - | expiry and changed bindings invalidate confirmation and invalid candidates make no paid calls | - | 정적 |
| test/command-policy-review.test.mjs | 62 | - | a policy change during model feedback prevents issuing a usable review | - | 정적 |
| test/command-policy-review.test.mjs | 71 | - | missing disclosure or evaluator and exhausted budget return explicit uncertainty; sudo alone is not a high-risk verdict | - | 정적 |
| test/command-policy-review.test.mjs | 84 | - | failed assessment still requires an explicit informed OK; failed audit cannot commit | - | 정적 |
| test/command-policy-review.test.mjs | 96 | - | sudo opt-in is high-risk feedback, separately acknowledged and exact-review-bound | - | 정적 |
| test/command-policy-review.test.mjs | 105 | - | D-REGISTRATION feedback and audit retain only sanitized failure details; explicit OK still required | - | 정적 |
| test/command-state-startup.test.mjs | 26 | - | startup never updates unchanged history and preserves its exact body, key and digest | - | 정적 |
| test/command-state-startup.test.mjs | 38 | - | startup normalizes only interrupted states and a second open performs no updates | - | 정적 |
| test/command-state-startup.test.mjs | 59 | - | startup normalization rolls back every changed row if a later row fails | - | 정적 |
| test/completion-auto-watch.test.mjs | 68 | - | AW01 configured submit defers watch until observe is invoked for the exact host session | - | 정적 |
| test/completion-auto-watch.test.mjs | 85 | - | AW02 configured observe response starts a watch with its existing operation id | - | 정적 |
| test/completion-auto-watch.test.mjs | 94 | - | AW03 unconfigured and near-match tool routes do not start a watcher | - | 정적 |
| test/completion-auto-watch.test.mjs | 103 | - | AW04 only contract 2.0 success at the recognized response boundary can start a watcher | - | 정적 |
| test/completion-auto-watch.test.mjs | 115 | - | AW05 malformed operation identity revision or target cannot be promoted into a watch | - | 정적 |
| test/completion-auto-watch.test.mjs | 127 | - | AW06 private response bodies never become argv or public auto-watch output | - | 정적 |
| test/completion-auto-watch.test.mjs | 136 | - | AW07 duplicate hooks and observe calls share a durable single watch claim | - | 정적 |
| test/completion-auto-watch.test.mjs | 145 | - | AW07 the operation id stays canonical when an optional operation key disappears | - | 정적 |
| test/completion-auto-watch.test.mjs | 153 | - | AW07 concurrent native hook invocations acquire only one durable watch claim | - | 정적 |
| test/completion-auto-watch.test.mjs | 161 | - | AW08 exact session and host bindings have separate watcher claims | - | 정적 |
| test/completion-auto-watch.test.mjs | 170 | - | AW09 claims include the configured origin and do not merge separate owners | - | 정적 |
| test/completion-auto-watch.test.mjs | 180 | - | AW10 a definite spawn failure releases its lease so the next hook can observe the same id | - | 정적 |
| test/completion-auto-watch.test.mjs | 193 | - | AW10 a pre-spawn asynchronous error is sanitized and releases its observation lease | - | 정적 |
| test/completion-auto-watch.test.mjs | 207 | - | AW11 an unknown child is suppressed until lease expiry then only the same id is observed again | - | 정적 |
| test/completion-auto-watch.test.mjs | 227 | - | AW12 watcher launch uses detached shell-free hidden execution and private output fds | - | 정적 |
| test/completion-auto-watch.test.mjs | 239 | - | AW13 response origin and executable fields cannot choose watcher routing or launch paths | - | 정적 |
| test/completion-auto-watch.test.mjs | 249 | - | AW14 invalid host inputs and missing configuration have no launch side effects | - | 정적 |
| test/completion-auto-watch.test.mjs | 260 | - | AW14 invalid configuration never launches or exposes its original bytes | - | 정적 |
| test/completion-auto-watch.test.mjs | 272 | - | AW15 automatic watch arguments keep the existing inbox hook and explicit ACK binding | - | 정적 |
| test/completion-auto-watch.test.mjs | 300 | - | AW16 Antigravity native call wrapper defers on submit and watches its stable operation key on observe | - | 정적 |
| test/completion-auto-watch.test.mjs | 328 | - | `AW-WIRING ${host} native hook starts its configured read-only observation` | - | 동적 |
| test/completion-auto-watch.test.mjs | 378 | - | AW17 observe response in terminal state does not spawn a watcher and auto-acknowledges inbox receipt before hook output | - | 정적 |
| test/completion-auto-watch.test.mjs | 407 | - | AW20 Antigravity observe settles and suppresses watcher when operation completion is already in inbox | - | 정적 |
| test/completion-auto-watch.test.mjs | 423 | - | AW21 Antigravity first observe completion without prior inbox seed suppresses duplicate notification via --skip-initial-terminal | - | 정적 |
| test/completion-hook.test.mjs | 61 | - | RH01 native SessionStart registers only its exact Codex or Claude binding | - | 정적 |
| test/completion-hook.test.mjs | 73 | - | RH02 Codex tool prompt and session hooks deliver exact status and acknowledgement arguments as context | - | 정적 |
| test/completion-hook.test.mjs | 91 | - | RH03 Codex Stop uses block reason without unsupported context fields | - | 정적 |
| test/completion-hook.test.mjs | 102 | - | RH04 an already active Stop cannot claim a receipt or create a continuation loop | - | 정적 |
| test/completion-hook.test.mjs | 109 | - | RH05 output does not acknowledge and an expired lease redelivers the same receipt | - | 정적 |
| test/completion-hook.test.mjs | 126 | - | RH06 invalid host event or session cannot consume pending status | - | 정적 |
| test/completion-hook.test.mjs | 138 | - | RH07 unresolved Codex or Claude child identity cannot take the parent session receipt or arm waiter | - | 정적 |
| test/completion-hook.test.mjs | 151 | - | RH08 hook claims only the registered host and session combination | - | 정적 |
| test/completion-hook.test.mjs | 161 | - | RH09 acknowledgement requires exact binding and latest receipt token | - | 정적 |
| test/completion-hook.test.mjs | 174 | - | RH10 native tool transcript fields and extra event secrets are never injected | - | 정적 |
| test/completion-hook.test.mjs | 186 | - | RH11 hook and failed acknowledgement close their real SQLite connection | - | 정적 |
| test/completion-hook.test.mjs | 203 | - | RC01 installed script entry point reads native stdin and writes a single JSON result | - | 정적 |
| test/completion-hook.test.mjs | 216 | - | RC02 CLI hook renders claimed status without implicitly acknowledging it | - | 정적 |
| test/completion-hook.test.mjs | 225 | - | RC03 malformed JSON remains a safe nonblocking hook failure without input disclosure | - | 정적 |
| test/completion-hook.test.mjs | 243 | - | RC04 exactly eight MiB of native input is accepted without echoing tool content | - | 정적 |
| test/completion-hook.test.mjs | 250 | - | RC05 over eight MiB is bounded and leaves the target session unregistered | - | 정적 |
| test/completion-hook.test.mjs | 262 | - | RC06 explicit CLI acknowledgement uses exact fields and never consumes hook stdin | - | 정적 |
| test/completion-hook.test.mjs | 276 | - | RC07 CLI acknowledgement errors cannot consume another host or session receipt | - | 정적 |
| test/completion-hook.test.mjs | 288 | - | RC08 malformed CLI arguments keep hook and acknowledgement exit semantics separate | - | 정적 |
| test/completion-hook.test.mjs | 301 | - | RC09 unexpected errors expose neither messages paths nor malformed error codes | - | 정적 |
| test/completion-hook.test.mjs | 309 | - | AH01 agy session and invocation events use the source-defined nested system message | - | 정적 |
| test/completion-hook.test.mjs | 325 | - | AH02 a normal agy Stop continues with reason and keeps its claim unacknowledged | - | 정적 |
| test/completion-hook.test.mjs | 335 | - | AH03 agy cancellation errors and exhausted limits cannot claim on Stop | - | 정적 |
| test/completion-hook.test.mjs | 349 | - | AH04 agy accepts its native session field and rejects conflicting identities | - | 정적 |
| test/completion-hook.test.mjs | 363 | - | AH05 agy PostToolUse consumes only its own receipt at the native tool boundary | - | 정적 |
| test/completion-hook.test.mjs | 371 | - | AC01 only agy can supply a nonconflicting native event through the CLI flag | - | 정적 |
| test/completion-hook.test.mjs | 390 | - | AC02 agy acknowledgement cannot carry a hook event flag | - | 정적 |
| test/completion-hook.test.mjs | 406 | - | NW05 native Claude waiter renders the committed receipt to stderr with exit2 and no ACK | - | 정적 |
| test/completion-hook.test.mjs | 418 | - | NW05 a pending-free SessionStart waiter sees an enqueue after its first poll | - | 정적 |
| test/completion-hook.test.mjs | 428 | - | NW06 duplicates exit immediately and Stop remains armable with stop_hook_active true | - | 정적 |
| test/completion-hook.test.mjs | 448 | - | NW07 SessionEnd stops its worker, preserves pending status, and fences late Stop rearming | - | 정적 |
| test/completion-hook.test.mjs | 467 | - | NW08 deadline and abort release the owned lease and close the SQLite connection | - | 정적 |
| test/completion-hook.test.mjs | 495 | - | NW09 polling is capped at one second and heartbeat renews every ten seconds until deadline | - | 정적 |
| test/completion-hook.test.mjs | 507 | - | NW10 Claude manifest uses exec argv, bounded asyncRewake, synchronous prompt drain and SessionEnd | - | 정적 |
| test/completion-hook.test.mjs | 528 | - | NW12 invalid native wait flags fail before opening an inbox or claiming status | - | 정적 |
| test/completion-hook.test.mjs | 541 | - | NW13 Claude short hooks never block Stop while UserPromptSubmit keeps lease redelivery | - | 정적 |
| test/completion-hook.test.mjs | 560 | - | NW14 Claude active turn hooks pause an idle SessionStart waiter so Stop owns completion rewake | - | 정적 |
| test/completion-inbox.test.mjs | 98 | - | I01 registration survives reopen and reuses only the exact binding | - | 정적 |
| test/completion-inbox.test.mjs | 109 | - | I02 committed enqueue survives response loss and duplicate watch after reopen | - | 정적 |
| test/completion-inbox.test.mjs | 125 | - | I03 different payload at the same intent key conflicts without changing the original | - | 정적 |
| test/completion-inbox.test.mjs | 135 | - | I04 session host origin and revision keep their independent receipt boundaries | - | 정적 |
| test/completion-inbox.test.mjs | 150 | - | I05 extra secrets are neither persisted returned nor included in idempotency | - | 정적 |
| test/completion-inbox.test.mjs | 168 | - | I06 invalid and credential-bearing origins are rejected before storage | - | 정적 |
| test/completion-inbox.test.mjs | 177 | - | I07 invalid terminal event fields leave no partial record and do not poison the connection | - | 정적 |
| test/completion-inbox.test.mjs | 190 | - | I08 bounded claim leaves the remainder and never repeats an unexpired receipt | - | 정적 |
| test/completion-inbox.test.mjs | 201 | - | I09 concurrent independent hook processes atomically claim each receipt once | - | 정적 |
| test/completion-inbox.test.mjs | 216 | - | I10 unacknowledged claim survives process crash and is reclaimed at the lease boundary | - | 정적 |
| test/completion-inbox.test.mjs | 234 | - | I11 reassigned ownership fences stale tokens and other session acknowledgements | - | 정적 |
| test/completion-inbox.test.mjs | 247 | - | I12 the latest acknowledgement is durable and idempotent for that token only | - | 정적 |
| test/completion-inbox.test.mjs | 260 | - | I13 pending claimed and acknowledged counts preserve separate evidence states | - | 정적 |
| test/completion-inbox.test.mjs | 271 | - | I14 operations on a closed connection fail and a fresh connection remains usable | - | 정적 |
| test/completion-inbox.test.mjs | 284 | - | I15 unknown binding cannot insert claim or acknowledge another session receipt | - | 정적 |
| test/completion-inbox.test.mjs | 295 | - | I16 private SQLite leaf works under the normal OS tmp ancestor including Windows | - | 정적 |
| test/completion-inbox.test.mjs | 312 | - | I17 unsafe POSIX file types and multiple links are rejected without altering the source | - | 정적 |
| test/completion-inbox.test.mjs | 335 | - | I18 concurrent duplicate watches commit exactly one receipt | - | 정적 |
| test/completion-inbox.test.mjs | 349 | - | I19 all terminal states preserve failure and unknown metadata without reinterpretation | - | 정적 |
| test/completion-inbox.test.mjs | 423 | - | NW01 schema1 migration preserves exact event, claim, ACK and binding state and is repeatable | - | 정적 |
| test/completion-inbox.test.mjs | 441 | - | NW01 failed migration keeps schema1 rows and can migrate after the obstacle is removed | - | 정적 |
| test/completion-inbox.test.mjs | 459 | - | AW18 adding watch leases preserves schema2 version and exact binding event and waiter rows | - | 정적 |
| test/completion-inbox.test.mjs | 478 | - | AW19 watch leases expire after 600000ms and stale tokens cannot release a replacement owner | - | 정적 |
| test/completion-inbox.test.mjs | 495 | - | NW02 concurrent process acquisition has one winner per binding and independent sessions | - | 정적 |
| test/completion-inbox.test.mjs | 511 | - | NW03 expired owner cannot poll renew or release a replacement generation | - | 정적 |
| test/completion-inbox.test.mjs | 526 | - | NW04 native poll and pendingOnly claims never redeliver expired claimed events | - | 정적 |
| test/completion-inbox.test.mjs | 542 | - | NW07 SessionEnd invalidates ownership and rejects late arms until an actual SessionStart | - | 정적 |
| test/completion-inbox.test.mjs | 557 | - | NW09 heartbeat extends only an unexpired owner and stale lease recovery is bounded | - | 정적 |
| test/completion-wake.test.mjs | 60 | - | W01 invalid destinations and unsupported hosts never dispatch | - | 정적 |
| test/completion-wake.test.mjs | 77 | - | W02 W10 Codex sends one exact marker with bounded argv and no resume or body | - | 정적 |
| test/completion-wake.test.mjs | 90 | - | W03 Codex uses only an explicit file or official managed launcher | - | 정적 |
| test/completion-wake.test.mjs | 112 | - | W04 Codex distinguishes spawn/no-active/uncertain failures without retransmission | - | 정적 |
| test/completion-wake.test.mjs | 134 | - | W05 NW11 Claude defers to its native hook without reading private env or dispatching | - | 정적 |
| test/completion-wake.test.mjs | 145 | - | W06 Claude requires no messaging environment and never reports requested delivery | - | 정적 |
| test/completion-wake.test.mjs | 154 | - | W07 agy verifies exact project before sending exact marker | - | 정적 |
| test/completion-wake.test.mjs | 174 | - | W07b agy honors an explicit executable while preserving preflight and project checks | - | 정적 |
| test/completion-wake.test.mjs | 198 | - | W08 agy requires current env without executable/auth discovery | - | 정적 |
| test/completion-wake.test.mjs | 210 | - | W08 agy lookup failures and project mismatch never start send-message | - | 정적 |
| test/completion-wake.test.mjs | 227 | - | W09 W10 agy send failures do not retry or expose raw diagnostics | - | 정적 |
| test/completion-wake.test.mjs | 242 | - | W11 missing subprocess callback has a strict deadline and one kill | - | 정적 |
| test/compose-maintenance-gate.test.mjs | 9 | - | Compose update rejects malformed image references before Docker, lock, or state mutations | - | 정적 |
| test/config-contracts.test.mjs | 18 | - | native ENV loader preserves Vault public metadata and reference without evaluation | - | 정적 |
| test/config-contracts.test.mjs | 23 | - | runtime upload settings share exact and wildcard policy vectors with deployment tools | - | 정적 |
| test/config-contracts.test.mjs | 46 | - | canonical origin and supported port vectors are identical configuration contracts | - | 정적 |
| test/config-contracts.test.mjs | 65 | - | Node24 origin CLI delegates to the same validator with bounded exact stdin and stdout | - | 정적 |
| test/config-contracts.test.mjs | 77 | - | admin authorization preserves mode, maintenance, Origin and capability exception matrix | - | 정적 |
| test/config-contracts.test.mjs | 114 | - | native secret generation preserves protected bytes and ownership with atomic replacement | - | 정적 |
| test/config-contracts.test.mjs | 136 | - | native staging write and rename failures preserve previous configuration and clean staging | - | 정적 |
| test/config-contracts.test.mjs | 161 | - | healthcheck uses configured port and requires healthy JSON without disclosing settings | - | 정적 |
| test/config-contracts.test.mjs | 172 | - | display names are optional public labels, bounded and free of control/formatting characters | - | 정적 |
| test/core.test.mjs | 10 | - | all non-read classes reserve exactly one execution after audit, shared by web and UI | - | 정적 |
| test/core.test.mjs | 26 | - | file operation and ticket scope are immutable; expiry, denial and audit failure block side effects | - | 정적 |
| test/core.test.mjs | 41 | - | a boolean cannot grant automatic file authority; raw error text never reaches owner-approved results | - | 정적 |
| test/core.test.mjs | 48 | - | audit partial writes complete; zero-write fails | - | 정적 |
| test/core.test.mjs | 53 | - | late completed downloads remain addressable for a full hour after completion | - | 정적 |
| test/core.test.mjs | 63 | - | DISPATCH-01 admission failures retain fixed cause/stage, never exception properties, and settle once | - | 정적 |
| test/core.test.mjs | 94 | - | DISPATCH-02 a pre-dispatch persistence failure and a remote failure keep distinct certainty and settle once | - | 정적 |
| test/core.test.mjs | 108 | - | DISPATCH-03 old not_dispatched records remain byte-identical and forged/unknown cause text is never reflected | - | 정적 |
| test/deploy180-archive-permissions.test.mjs | 52 | - | `root umask077 migration traverses ${existingParent ? 'an existing root0700' : 'a newly created'} archive parent as the real service uid` | - | 동적 |
| test/deploy180-archive-permissions.test.mjs | 81 | - | `migration refuses an ${unsafe} archive parent without normalizing unrelated ownership or permissions` | - | 동적 |
| test/deploy180-migration-stdin.test.mjs | 49 | - | migration-check preserves ASCII, Korean and emoji across one-byte stdin chunks | - | 정적 |
| test/deploy180-migration-stdin.test.mjs | 64 | - | migration-check still rejects genuinely changed original evidence with split stdin | - | 정적 |
| test/deploy180-migration-stdin.test.mjs | 76 | - | migration-child preserves Korean and emoji in its stdin data-root path | - | 정적 |
| test/deploy180-native-runtime.test.mjs | 83 | - | stage prepares private runtime after npm under umask077 and real service imports succeed; repeated stage only reuses | - | 정적 |
| test/deploy180-native-runtime.test.mjs | 99 | - | runtime integrity failure stops staging before release publication and never stops the existing service | - | 정적 |
| test/deploy180-native-runtime.test.mjs | 107 | - | unsupported native architecture produces a skip receipt while ordinary server staging and imports succeed | - | 정적 |
| test/deploy180-output-sidecars.test.mjs | 18 | - | a normal persistent SQLite output journal remains fingerprintable after clean database close | - | 정적 |
| test/deploy180-output-sidecars.test.mjs | 30 | - | all three output manifest sidecars participate in the hash even with unchanged size and timestamp | - | 정적 |
| test/deploy180-output-sidecars.test.mjs | 49 | - | output sidecar links remain refused | - | 정적 |
| test/deploy180-output-sidecars.test.mjs | 59 | - | an output journal write forbids downmigration and retains the selected release and every fixture byte | - | 정적 |
| test/deploy180-release-permissions.test.mjs | 93 | - | D221-CANDIDATE inspect accepts major 2 release versions and refuses historical, major 3 or prerelease candidates before writing state | - | 정적 |
| test/deploy180-release-permissions.test.mjs | 106 | - | `D221-RECEIPT ${previousVersion} requires completed migration evidence without reimport` | - | 동적 |
| test/deploy180-release-permissions.test.mjs | 126 | - | `D221-REUSE ${previousVersion} preserves authoritative completed migration and canonical data` | - | 동적 |
| test/deploy180-release-permissions.test.mjs | 151 | - | `umask077 ${version} staging permits real service imports with ${existingParent ? 'existing' : 'new'} public deployment parents` | - | 동적 |
| test/deploy180-release-permissions.test.mjs | 180 | - | activation detects service-uid import access failure before stopping the previous service | - | 정적 |
| test/deploy180-release-permissions.test.mjs | 193 | - | pre-start recovery can select a preserved 1.8 release without accepting it as a new candidate | - | 정적 |
| test/deploy180-release-permissions.test.mjs | 213 | - | `staging refuses an ${unsafe} releases parent without changing it` | - | 동적 |
| test/desktop-http.test.mjs | 72 | - | DESKTOP-HTTP actual UI open crosses authenticated HTTP/app contract and uses server epoch | - | 정적 |
| test/desktop-http.test.mjs | 90 | - | DESKTOP-HTTP rejects legacy UI fields, stale revision and unauthorized open before channel creation | - | 정적 |
| test/desktop-http.test.mjs | 103 | - | DESKTOP-HTTP owner login screen, nonstored credential field and SAS cross the real application route | - | 정적 |
| test/desktop-http.test.mjs | 136 | - | DESKTOP-HTTP renders localized guidance and diagnostic code when desktop open fails with DESKTOP_XVNC_START_FAILED | - | 정적 |
| test/desktop-local-process.test.mjs | 13 | - | local helper preserves binary stdin/stdout and buffers early stderr separately | - | 정적 |
| test/desktop-local-process.test.mjs | 23 | - | native input has a separate duplex fd without mixing credential or RFB bytes | - | 정적 |
| test/desktop-local-process.test.mjs | 36 | - | fixed minimal environment excludes parent credentials and bootstrap stays in stdin | - | 정적 |
| test/desktop-local-process.test.mjs | 53 | - | beforeDispatch refusal and cancellation during its await never start a process | - | 정적 |
| test/desktop-local-process.test.mjs | 66 | - | idempotent close observes delayed TERM cleanup and an isolated child process group | - | 정적 |
| test/desktop-local-process.test.mjs | 78 | - | abort terminates only the helper group and preserves the cancelling result | - | 정적 |
| test/desktop-local-process.test.mjs | 87 | - | uncooperative TERM handler is killed after the bounded grace window | - | 정적 |
| test/desktop-local-process.test.mjs | 95 | - | owned descendants are terminated and reaped before cleanup is reported complete | - | 정적 |
| test/desktop-local-process.test.mjs | 102 | - | nonzero exit and stderr overflow remain typed and diagnostics stay bounded | - | 정적 |
| test/desktop-public-contract.test.mjs | 23 | - | GUI-CONTRACT agents receive actual image content without an owner UI card | - | 정적 |
| test/desktop-public-contract.test.mjs | 38 | - | GUI-CONTRACT discovery advertises server configuration without opening a desktop | - | 정적 |
| test/desktop-public-contract.test.mjs | 52 | - | GUI-CONTRACT open request key and status recovery metadata use the common schema | - | 정적 |
| test/desktop-public-contract.test.mjs | 63 | - | GUI-CONTRACT cleanup receipts preserve each provider outcome and typed refusals | - | 정적 |
| test/desktop-rdp-native-input.test.mjs | 65 | - | four literal section 11.6 oracles bind INPUT, RELEASE, CLOSE and received ACK | - | 정적 |
| test/desktop-rdp-native-input.test.mjs | 78 | - | HELLO tolerates every header/body split and sends no premature INPUT | - | 정적 |
| test/desktop-rdp-native-input.test.mjs | 89 | - | ACK tolerates every split and resolves only after its full body | - | 정적 |
| test/desktop-rdp-native-input.test.mjs | 99 | - | UTF-8 Korean/emoji and mixed action TLVs retain byte order and sequence | - | 정적 |
| test/desktop-rdp-native-input.test.mjs | 113 | - | domain action, Unicode, geometry and aggregate bounds reject before write | - | 정적 |
| test/desktop-rdp-native-input.test.mjs | 125 | - | exact per-action UTF16, public event and 128-action boundaries remain usable | - | 정적 |
| test/desktop-rdp-native-input.test.mjs | 133 | - | HELLO header direction, lengths, sequence and every fixed capability reject | - | 정적 |
| test/desktop-rdp-native-input.test.mjs | 150 | - | ACK wrong direction, duplicate/gap sequence and invalid framing close without replay | - | 정적 |
| test/desktop-rdp-native-input.test.mjs | 162 | - | ACK status, scope, counters, phase, flags, held state and reserved bytes are validated | - | 정적 |
| test/desktop-rdp-native-input.test.mjs | 175 | - | rejected and partial/unknown receipts retain cursor and never retry or resume | - | 정적 |
| test/desktop-rdp-native-input.test.mjs | 192 | - | error ACK cannot claim an unrequested CLOSE or RELEASE or omit unknown native effect | - | 정적 |
| test/desktop-rdp-native-input.test.mjs | 202 | - | concurrent duplicate calls do not write or replay while one request awaits ACK | - | 정적 |
| test/desktop-rdp-native-input.test.mjs | 210 | - | release/close require their own completion flags and empty held state | - | 정적 |
| test/desktop-rdp-native-input.test.mjs | 216 | - | no HELLO, incomplete HELLO and absent/incomplete ACK have bounded deadlines | - | 정적 |
| test/desktop-rdp-native-input.test.mjs | 231 | - | truncated EOF rejects, while a complete ACK buffered before EOF remains observable | - | 정적 |
| test/desktop-rdp-native-input.test.mjs | 242 | - | pre-abort and cancellation during ACK wait prohibit later writes | - | 정적 |
| test/desktop-rdp-native-input.test.mjs | 254 | - | write callback failure, thrown write, stalled write and late transport errors stay terminal | - | 정적 |
| test/desktop-rdp-native-input.test.mjs | 267 | - | wire buffering is bounded even before HELLO completes | - | 정적 |
| test/desktop-rdp-runtime.test.mjs | 61 | - | private runtime verifies all declared files and runs exact standalone probe with isolated environment | - | 정적 |
| test/desktop-rdp-runtime.test.mjs | 79 | - | capability object requires exact private path and upstream/patch/protocol binding | - | 정적 |
| test/desktop-rdp-runtime.test.mjs | 93 | - | missing manifest or private executable fails closed without stock-client fallback | - | 정적 |
| test/desktop-rdp-runtime.test.mjs | 100 | - | manifest rejects version, upstream, digest, executable and file-list contract violations before probe | - | 정적 |
| test/desktop-rdp-runtime.test.mjs | 117 | - | manifest size bound is enforced before parsing or probing | - | 정적 |
| test/desktop-rdp-runtime.test.mjs | 122 | - | every declared file is checked for content, size, mode and regular-file type before probe | - | 정적 |
| test/desktop-rdp-runtime.test.mjs | 135 | - | executable entry must retain an executable mode even when manifest and file agree | - | 정적 |
| test/desktop-rdp-runtime.test.mjs | 140 | - | leaf symlink cannot replace a declared runtime file or manifest | - | 정적 |
| test/desktop-rdp-runtime.test.mjs | 148 | - | runtime parent-directory symlink cannot redirect verified files outside the private tree | - | 정적 |
| test/desktop-rdp-runtime.test.mjs | 157 | - | runtime rejects files absent from the manifest, including possible private library shadows | - | 정적 |
| test/desktop-rdp-runtime.test.mjs | 165 | - | probe protocol mismatch, malformed output, extra fields and nonzero exit never become available | - | 정적 |
| test/desktop-rdp-session.test.mjs | 35 | - | RDP relay: native/display readiness is distinct from Windows logon and close is a detach receipt | - | 정적 |
| test/desktop-rdp-session.test.mjs | 63 | - | RDP relay refuses absent client and mismatched identity before asking for credentials | - | 정적 |
| test/desktop-rdp-session.test.mjs | 75 | - | RDP relay validates public plan and restricts the tunnel to loopback | - | 정적 |
| test/desktop-rdp-session.test.mjs | 86 | - | RDP client capability requires the private framed protocol, upstream pin and executable digest | - | 정적 |
| test/desktop-rdp-session.test.mjs | 100 | - | RDP normal close preserves the input channel until native detach acknowledgement | - | 정적 |
| test/desktop-rdp-session.test.mjs | 115 | - | RDP close preserves a tunnel cleanup-unknown receipt after successful native detach | - | 정적 |
| test/desktop-rdp-session.test.mjs | 125 | - | RDP private bootstrap rejects controls, oversized native input, malformed UTF16, and clears its buffer | - | 정적 |
| test/desktop-rdp-session.test.mjs | 136 | - | RDP private bootstrap aborts a stalled pipe and removes raw provider errors | - | 정적 |
| test/desktop-rdp-session.test.mjs | 146 | - | RDP relay closes a late tunnel after cancellation without opening a display | - | 정적 |
| test/desktop-rdp-session.test.mjs | 156 | - | RDP relay closes a late managed display after cancellation and reports cleanup failures | - | 정적 |
| test/desktop-rfb-input-endian.test.mjs | 6 | - | RFB text KeyEvent는 ASCII와 Unicode keysym을 network byte order로 전송한다 | - | 정적 |
| test/desktop-rfb.test.mjs | 27 | - | RFB fragmented raw framebuffer is a valid PNG; resize changes geometry and held inputs release | - | 정적 |
| test/desktop-rfb.test.mjs | 47 | - | RFB refuses unconfigured security, unsupported version and oversized server framebuffer | - | 정적 |
| test/desktop-service.test.mjs | 18 | - | GUI-AUTH login screens remain observable; owner private input and SAS never become model tools or replayable credentials | - | 정적 |
| test/desktop-service.test.mjs | 48 | - | GUI-AUTH changed backend generation fences same-size frames and a lock appearing before dispatch | - | 정적 |
| test/desktop-service.test.mjs | 70 | - | GUI lease fences owner, epoch, target revision and expires with key cleanup | - | 정적 |
| test/desktop-service.test.mjs | 82 | - | GUI input accepts continuous frames, deduplicates latest receipt and refuses stale geometry | - | 정적 |
| test/desktop-service.test.mjs | 102 | - | GUI capacity includes pending opens and has a separate per-owner ceiling | - | 정적 |
| test/desktop-service.test.mjs | 111 | - | an uncertain GUI input is never retried and closes its lease | - | 정적 |
| test/desktop-service.test.mjs | 120 | - | logout closes only that owner including a lease whose open receipt was lost | - | 정적 |
| test/desktop-service.test.mjs | 130 | - | one physical desktop excludes different owners and target aliases while opening and disposing | - | 정적 |
| test/desktop-service.test.mjs | 151 | - | authority is rechecked before every observation and input after initial admission | - | 정적 |
| test/desktop-service.test.mjs | 163 | - | asynchronous authority revocation while geometry is observed prevents input dispatch | - | 정적 |
| test/desktop-service.test.mjs | 179 | - | closing a pending open keeps the physical resource reserved until its late channel is closed | - | 정적 |
| test/desktop-service.test.mjs | 192 | - | idle GUI close waits for release and detach before aborting its private transport | - | 정적 |
| test/desktop-service.test.mjs | 212 | - | GUI-AGENT an open request recovers one pending lease and keeps its original epoch | - | 정적 |
| test/desktop-service.test.mjs | 233 | - | GUI-AGENT open recovery rechecks authority and isolates request keys by authority | - | 정적 |
| test/desktop-service.test.mjs | 246 | - | GUI-AGENT failed opens keep their request key and never open another transport | - | 정적 |
| test/desktop-service.test.mjs | 255 | - | GUI-AGENT provider state is OS neutral and fences a replaced same-size session | - | 정적 |
| test/desktop-service.test.mjs | 276 | - | GUI-AGENT status recovers only the latest non-private input receipt | - | 정적 |
| test/desktop-service.test.mjs | 294 | - | GUI-AGENT provider capability refusals preserve the lease and dispatch no input | - | 정적 |
| test/desktop-service.test.mjs | 304 | - | GUI-AGENT cleanup distinguishes attached preservation, managed termination and uncertainty | - | 정적 |
| test/desktop-service.test.mjs | 323 | - | GUI-AGENT issuance is stateless and signed keys bind expiry and server generation | - | 정적 |
| test/desktop-service.test.mjs | 341 | - | GUI-AGENT expired recovery records release admission without replay across a backward clock | - | 정적 |
| test/desktop-ssh-forward-close.test.mjs | 50 | - | forward close drains an empty paused ssh2 readable and observes protocol end/close | - | 정적 |
| test/desktop-ssh-forward-close.test.mjs | 64 | - | forward close discards buffered lease data without draining an unrelated channel | - | 정적 |
| test/desktop-ssh-forward-close.test.mjs | 73 | - | tunnel teardown settles both real ssh2 pipelines after the native socket has closed | - | 정적 |
| test/desktop-ssh-forward-close.test.mjs | 88 | - | missing SSH protocol close rejects cleanup instead of treating destroy/finish as closure | - | 정적 |
| test/desktop-ssh-forward-close.test.mjs | 95 | - | cancelled forward open drains and closes a late real ssh2 channel without replay | - | 정적 |
| test/desktop-ssh-forward-close.test.mjs | 103 | - | opening timeout still drains a late callback channel and never closes the shared client | - | 정적 |
| test/desktop-ssh-tunnel.test.mjs | 13 | - | desktop RDP tunnel uses only bridge loopback and fixed remote RDP endpoint | - | 정적 |
| test/desktop-ssh-tunnel.test.mjs | 33 | - | desktop tunnel cancellation before listen never creates an endpoint | - | 정적 |
| test/desktop-ssh-tunnel.test.mjs | 39 | - | desktop tunnel closes a late SSH channel before finishing cleanup | - | 정적 |
| test/desktop-ssh-tunnel.test.mjs | 55 | - | desktop tunnel retains an explicit cleanup failure | - | 정적 |
| test/desktop-ssh-tunnel.test.mjs | 71 | - | tunnel close cancels a pending channel open with its own lease signal | - | 정적 |
| test/desktop-ssh-tunnel.test.mjs | 86 | - | unresponsive guard returns cleanup unknown and cannot dispatch after late completion | - | 정적 |
| test/desktop-ssh-tunnel.test.mjs | 101 | - | unresponsive opener remains unknown and closes a channel delivered after the deadline once | - | 정적 |
| test/desktop-state.test.mjs | 10 | - | GUI-STATE handshake and WTS metadata never attest a desktop or a disconnected session | - | 정적 |
| test/desktop-state.test.mjs | 26 | - | GUI-STATE generations change on boot, lock or session changes and ignore row ordering and time | - | 정적 |
| test/desktop-state.test.mjs | 39 | - | GUI-STATE fixed native query consumes bounded stdin on the selected read profile and hides failures | - | 정적 |
| test/desktop-state.test.mjs | 56 | - | GUI-STATE public desktop status carries typed readiness and no screen pixels | - | 정적 |
| test/desktop-state.test.mjs | 68 | - | GUI-STATE verified provider sessions do not require Windows integer session IDs | - | 정적 |
| test/desktop-target-backends.test.mjs | 22 | - | target config selects platform-supported backends and canonical private references | - | 정적 |
| test/desktop-target-backends.test.mjs | 38 | - | discovery distinguishes configured backend from available native support without opening a session | - | 정적 |
| test/desktop-target-backends.test.mjs | 53 | - | managed Linux leases are distinct while attached displays and Windows hosts remain exclusive | - | 정적 |
| test/desktop-target-backends.test.mjs | 64 | - | target changes and maintenance prevent native dispatch and credential reads | - | 정적 |
| test/desktop-target-backends.test.mjs | 73 | - | failed native capability or pinned SSH establishment never requests an RDP credential | - | 정적 |
| test/dispatch-failure.test.mjs | 18 | - | DISPATCH-04 actual source/target/policy guards keep distinct fixed reasons without source or raw exceptions | - | 정적 |
| test/dispatch-failure.test.mjs | 35 | - | DISPATCH-05 finishEvaluation persistence failure is not busy and normal review does not autoexecute | - | 정적 |
| test/dispatch-failure.test.mjs | 43 | - | DISPATCH-06 a rejected test-server source releases its plan even when failure persistence also fails | - | 정적 |
| test/download-delivery.test.mjs | 15 | - | authenticated downloads open the user browser without a host fetch or a claim of device receipt | - | 정적 |
| test/download-delivery.test.mjs | 21 | - | unsupported host save renews the possibly consumed link, then opens the browser once | - | 정적 |
| test/download-delivery.test.mjs | 28 | - | a rejected browser save reports a manual next step and never requests another SSH operation | - | 정적 |
| test/download-delivery.test.mjs | 33 | - | an obsolete card cannot save another file | - | 정적 |
| test/environment.test.mjs | 13 | - | ENV HTTP authorization, Origin, types/limits, maintenance, audit and restart acceptance | - | 정적 |
| test/environment.test.mjs | 52 | - | ENV broker errors do not expose diagnostics, concurrent calls excluded, failed writes release maintenance | - | 정적 |
| test/execution-claims.test.mjs | 9 | - | claim limits and subscribers reject invalid configuration without allocating work | - | 정적 |
| test/execution-claims.test.mjs | 25 | - | active claim limit and synchronous idempotent release preserve the existing contract | - | 정적 |
| test/execution-claims.test.mjs | 41 | - | global waiting defaults to 32 and is independent of active ownership | - | 정적 |
| test/execution-claims.test.mjs | 60 | - | zero waiting slots reject before ownership and custom wait limits recover exactly once | - | 정적 |
| test/execution-claims.test.mjs | 73 | - | active and wait releases coalesce into one asynchronous notification to every subscriber | - | 정적 |
| test/execution-claims.test.mjs | 88 | - | unsubscribe removes only its registration and can cancel a queued wakeup | - | 정적 |
| test/execution-claims.test.mjs | 103 | - | callback and reporting failures never suppress another queue wakeup or corrupt ownership | - | 정적 |
| test/execution-claims.test.mjs | 117 | - | a release inside a notification schedules another pass without recursive callback execution | - | 정적 |
| test/execution-context.test.mjs | 11 | - | context references sensitive paths without weakening command disclosure guards | - | 정적 |
| test/execution-context.test.mjs | 23 | - | caller context rejects credential material, invalid values and overflow with stable safe codes | - | 정적 |
| test/execution-context.test.mjs | 32 | - | detailed context keeps the complete caller account, whitelists facts and states unknowns | - | 정적 |
| test/execution-context.test.mjs | 45 | - | the actual Jev wire body contains exact command and detailed context but cannot forge policy approval | - | 정적 |
| test/execution-context.test.mjs | 66 | - | advisory assessment includes the queued situation and additional evidence once, without executing | - | 정적 |
| test/execution-context.test.mjs | 83 | - | source evidence uses a bounded separate budget tied to the actual private plan at every evaluator boundary | - | 정적 |
| test/execution-context.test.mjs | 114 | - | normalized secret references are public identifiers, without hiding credential material | - | 정적 |
| test/execution-failure.test.mjs | 57 | - | execution diagnostic identity preserves only the six allowlisted causes and returns detached details | - | 정적 |
| test/execution-failure.test.mjs | 73 | - | untrusted fields and non-Error thrown values never become trusted execution diagnostics | - | 정적 |
| test/execution-failure.test.mjs | 85 | - | durable diagnostic data is copied through the allowlist without raw fields or replay permission | - | 정적 |
| test/execution-failure.test.mjs | 100 | - | tagged execution causes survive the queue result, terminal persistence, audit and job presenter | - | 정적 |
| test/execution-failure.test.mjs | 127 | - | unknown execution rejection keeps fixed fallback diagnostics through the same queue boundaries | - | 정적 |
| test/execution-failure.test.mjs | 141 | - | read failure preserves tagged diagnostics in its durable job without leaking raw text or replaying execution | - | 정적 |
| test/execution-queue.test.mjs | 47 | - | approval intent is durable before approval; approval queues into the single scheduler | - | 정적 |
| test/execution-queue.test.mjs | 60 | - | two approved jobs on the same target use two configured slots and remaining work is queued | - | 정적 |
| test/execution-queue.test.mjs | 70 | - | reads wait in the same durable queue and command run returns a job handle | - | 정적 |
| test/execution-queue.test.mjs | 82 | - | queued policy revalidation refuses revoked work without effects or blocking followers | - | 정적 |
| test/execution-queue.test.mjs | 94 | - | queued denial and expiry settle approval observers once and never dispatch | - | 정적 |
| test/execution-queue.test.mjs | 106 | - | uncertain execution is durable unknown and cannot be approved or replayed | - | 정적 |
| test/execution-queue.test.mjs | 115 | - | external submission identity is preserved in the durable exact input contract | - | 정적 |
| test/file-contracts.test.mjs | 30 | - | store snapshots cannot alter quota/state; download completion owns hash, retention and release | - | 정적 |
| test/file-contracts.test.mjs | 53 | - | download integrity or writer failure frees all capacity and rejects non-binary chunks | - | 정적 |
| test/file-contracts.test.mjs | 67 | - | manual and imported uploads share immutable approval and terminal release; no remote bytes before approval | - | 정적 |
| test/file-contracts.test.mjs | 86 | - | source refusal is offline; abort after submission preserves approval but abort before submission releases bytes | - | 정적 |
| test/file-contracts.test.mjs | 107 | - | import concurrency reserves before opening, and maintenance winning submission leaves no staged file | - | 정적 |
| test/file-contracts.test.mjs | 120 | - | ordinary and sudo downloads wait for owner without a reviewed policy | - | 정적 |
| test/file-contracts.test.mjs | 136 | - | source release failure never strands a pinned upload or consumes quota | - | 정적 |
| test/file-source.test.mjs | 38 | - | bound source supplies a neutral capability without exposing its signed URL | - | 정적 |
| test/file-source.test.mjs | 48 | - | inspect is offline, requires exact allowed host and rejects ambiguous or unsafe URLs | - | 정적 |
| test/file-source.test.mjs | 68 | - | mixed exact and wildcard hosts allow regional rotation and nested hosts with label boundaries | - | 정적 |
| test/file-source.test.mjs | 86 | - | wildcard permission still rejects any private DNS answer and redirects before file exposure | - | 정적 |
| test/file-source.test.mjs | 97 | - | all DNS answers must be public, including mapped and transition IPv6 | - | 정적 |
| test/file-source.test.mjs | 108 | - | transport preserves host/TLS, pins the validated DNS address and returns raw binary | - | 정적 |
| test/file-source.test.mjs | 122 | - | redirects, status, encodings, oversized headers and untrusted content lengths fail before exposure | - | 정적 |
| test/file-source.test.mjs | 128 | - | stream limits measure actual bytes and reject truncated or excess payloads | - | 정적 |
| test/file-source.test.mjs | 139 | - | deadline and caller abort cover unresolved DNS without creating a request | - | 정적 |
| test/file-source.test.mjs | 152 | - | header/body stalls, cancellation and explicit close release the request once | - | 정적 |
| test/file-source.test.mjs | 164 | - | total deadline stops a progressing body even while the idle deadline resets | - | 정적 |
| test/file-source.test.mjs | 171 | - | DNS/request exceptions never escape as raw source errors | - | 정적 |
| test/file-source.test.mjs | 182 | - | real HTTP parser preserves policy checks across fragmented response headers | - | 정적 |
| test/file-target-binding.test.mjs | 49 | - | owner target metadata exposes the exact opaque revision in legacy and explicit modes | - | 정적 |
| test/file-target-binding.test.mjs | 58 | - | stale malformed missing-target and disabled bindings create no artifact job or SSH effect | - | 정적 |
| test/file-target-binding.test.mjs | 72 | - | bound binary and empty uploads retain server identity inside immutable approval operations | - | 정적 |
| test/file-target-binding.test.mjs | 88 | - | bound downloads preserve artifact identity and require the same ticket before delivering exact bytes | - | 정적 |
| test/file-target-binding.test.mjs | 103 | - | a bound upload operation cannot substitute another revision or omit its declared binding before SSH | - | 정적 |
| test/file-target-binding.test.mjs | 112 | - | changed registry refuses new bound admission and existing bound append finish and ticket claims | - | 정적 |
| test/file-target-binding.test.mjs | 131 | - | owner file fields reject identity injection and unauthenticated requests before allocation | - | 정적 |
| test/file-target-binding.test.mjs | 140 | - | old unbound transfers retain their original operation and legacy metadata contracts | - | 정적 |
| test/file-target-binding.test.mjs | 150 | - | bound download tickets reject mismatched job identity and old IDs after a fresh application epoch | - | 정적 |
| test/file-target-binding.test.mjs | 163 | - | the internal binding builder refuses an empty or partial binding instead of downgrading it | - | 정적 |
| test/file-target-binding.test.mjs | 169 | - | bound source imports preserve identity and reject a configuration change before queue submission | - | 정적 |
| test/file-target-binding.test.mjs | 189 | - | bound finish rechecks the target after asynchronous file verification and before creating its job | - | 정적 |
| test/gui-account-provision.test.mjs | 33 | - | argument parser accepts target aliases, requires revision/ref and rejects secret argv | - | 정적 |
| test/gui-account-provision.test.mjs | 44 | - | registered Windows alias resolves while unknown, Linux, stale and unpinned aliases refuse | - | 정적 |
| test/gui-account-provision.test.mjs | 63 | - | default dry-run leaves filesystem unchanged and emits no store path/password | - | 정적 |
| test/gui-account-provision.test.mjs | 72 | - | unconfigured/mismatched store, changed revision and unpinned target refuse before probing | - | 정적 |
| test/gui-account-provision.test.mjs | 85 | - | existing account or any secret path refuses without generation, replacement or private state | - | 정적 |
| test/gui-account-provision.test.mjs | 98 | - | apply publishes one valid existing-provider record and status contains only public state | - | 정적 |
| test/gui-account-provision.test.mjs | 114 | - | unknown dispatch persists credential and stops a second attempt without automatic replay | - | 정적 |
| test/gui-account-provision.test.mjs | 128 | - | status refuses corrupt private state without printing attacker-controlled fields | - | 정적 |
| test/gui-account-provision.test.mjs | 137 | - | group failure preserves created SID and private credential without publishing | - | 정적 |
| test/gui-account-provision.test.mjs | 149 | - | racing secret writer wins without overwrite; operation keeps staged credential | - | 정적 |
| test/gui-account-provision.test.mjs | 163 | - | credential generation failure before dispatch prevents account creation | - | 정적 |
| test/gui-account-provision.test.mjs | 171 | - | native port sends secret only through stdin; malformed output fails closed | - | 정적 |
| test/gui-account-provision.test.mjs | 192 | - | native port bounds stalled stdin and checks binding again before secret dispatch | - | 정적 |
| test/gui-ssh-stream.test.mjs | 40 | - | fixed helper uses binary exec without PTY, keeps stderr separate and shares the client | - | 정적 |
| test/gui-ssh-stream.test.mjs | 63 | - | close is idempotent, sends TERM and EOF, and waits for observed exit/close | - | 정적 |
| test/gui-ssh-stream.test.mjs | 75 | - | stderr metadata emitted before the caller awaits open is buffered separately | - | 정적 |
| test/gui-ssh-stream.test.mjs | 84 | - | abort after open closes only its channel and preserves cancellation evidence | - | 정적 |
| test/gui-ssh-stream.test.mjs | 93 | - | abort before acquisition and while connecting never dispatches | - | 정적 |
| test/gui-ssh-stream.test.mjs | 105 | - | abort during opening rejects once and destroys a late callback channel | - | 정적 |
| test/gui-ssh-stream.test.mjs | 113 | - | dispatch guard and changed profiles refuse before exec, including callback binding changes | - | 정적 |
| test/gui-ssh-stream.test.mjs | 125 | - | profile tty and read-only cannot change helper execution semantics | - | 정적 |
| test/gui-ssh-stream.test.mjs | 134 | - | registered profile workdir does not rewrite or reject the fixed absolute helper command | - | 정적 |
| test/gui-ssh-stream.test.mjs | 143 | - | stderr capture is bounded and overflow terminates with a typed result without entering stdout | - | 정적 |
| test/gui-ssh-stream.test.mjs | 155 | - | nonzero exit is typed, duplicate exit/close and late errors cannot change its result | - | 정적 |
| test/gui-ssh-stream.test.mjs | 164 | - | transport loss before and after open has no automatic replay or false cleanup success | - | 정적 |
| test/gui-ssh-stream.test.mjs | 174 | - | channel error and exit without close preserve bounded, unconfirmed cleanup results | - | 정적 |
| test/gui-ssh-stream.test.mjs | 183 | - | channel opening refusal is typed and never automatically retries | - | 정적 |
| test/http-admission.test.mjs | 133 | - | 10 requests/second stays bounded before parsing, promotes FIFO, then recovers | - | 정적 |
| test/http-admission.test.mjs | 164 | - | waiting deadline refuses unstarted work and a later release does not submit it | - | 정적 |
| test/http-admission.test.mjs | 177 | - | disconnect while queued removes the unstarted body and recovers its FIFO capacity | - | 정적 |
| test/http-admission.test.mjs | 194 | - | administrator admission is bounded independently and MCP plus health remain responsive | - | 정적 |
| test/http-admission.test.mjs | 210 | - | validated long waits have a separate finite budget without blocking control or weakening approval | - | 정적 |
| test/http-admission.test.mjs | 241 | - | slow synchronous approval keeps control available; disconnect does not cancel or replay SSH | - | 정적 |
| test/http-admission.test.mjs | 285 | - | shutdown rejects queued bodies without promotion and releases long-wait subscriptions | - | 정적 |
| test/http-admission.test.mjs | 304 | - | JSON-RPC batches cannot detach a shared lease or dispatch multiple command submissions | - | 정적 |
| test/http-admission.test.mjs | 332 | - | bounded JSON body parsing rejects primitives, invalid encoding, oversize and wrong MIME without effects | - | 정적 |
| test/http-races.test.mjs | 12 | - | malformed raw HTTP target is contained; isolated server remains healthy | - | 정적 |
| test/http-races.test.mjs | 27 | - | one download URL is claimed before verification await; simultaneous replay receives no bytes | - | 정적 |
| test/http-races.test.mjs | 58 | - | `asynchronous owner approval acknowledges acceptance before execution ${failed?'fails':'completes'}` | - | 동적 |
| test/http.test.mjs | 14 | - | MCP transport, hidden capability, ticket checks, probe-only gate and web origin coexist | - | 정적 |
| test/i18n.test.mjs | 15 | - | BCP 47 canonicalization, fallback catalog and native Intl formatting | - | 정적 |
| test/i18n.test.mjs | 35 | - | unknown keys never read inherited object members or interpolate caller text | - | 정적 |
| test/i18n.test.mjs | 66 | - | metrics and capacity retain explicit regional formatting when document language is fallback English | - | 정적 |
| test/i18n.test.mjs | 80 | - | CLI history and login timestamps use the explicit format locale | - | 정적 |
| test/i18n.test.mjs | 99 | - | whole count messages handle zero, one and many without English singular suffixes | - | 정적 |
| test/i18n.test.mjs | 117 | - | all actual ko/en catalogs have valid message syntax, identical keys and placeholders | - | 정적 |
| test/i18n.test.mjs | 152 | - | translation callsite guard distinguishes catalog lookup from inline bilingual pairs without ignoring missing translations | - | 정적 |
| test/i18n.test.mjs | 161 | - | literal Korean UI translations have an English message at their actual catalog or inline boundary | - | 정적 |
| test/install-origin-preflight.test.mjs | 35 | - | S07 actual guard executes before dependency, runtime, account, config and SSH mutations | - | 정적 |
| test/install-origin-preflight.test.mjs | 46 | - | S01 missing fresh-install origin fails clearly before the fixture mutation | - | 정적 |
| test/install-origin-preflight.test.mjs | 53 | - | S02 existing-env update preserves the omitted-origin contract and original bytes | - | 정적 |
| test/install-origin-preflight.test.mjs | 60 | - | S03 explicit HTTPS origin reuses real portal.py dry-run without installation | - | 정적 |
| test/install-origin-preflight.test.mjs | 69 | - | `S04 refuses invalid explicit origin before mutation (existingEnv=${env}, ${origin})` | - | 동적 |
| test/install-origin-preflight.test.mjs | 79 | - | S05 missing origin fails even when Python is not yet installed | - | 정적 |
| test/install-origin-preflight.test.mjs | 86 | - | S06 explicit origin defers validation until the existing Python prerequisite installation | - | 정적 |
| test/install-origin-preflight.test.mjs | 92 | - | S08 deferred validation runs after Python becomes available and clears the pending flag | - | 정적 |
| test/install-origin-preflight.test.mjs | 98 | - | S08 deferred invalid origin still stops before runtime/account/SSH fixture mutation | - | 정적 |
| test/install-state-guard.test.mjs | 8 | - | stopped existing installations cannot bypass preservation verification | - | 정적 |
| test/jev-binary-contract.test.mjs | 12 | - | all new Jev questions ask only for safe or risky, and use a new execution contract | - | 정적 |
| test/jev-binary-contract.test.mjs | 19 | - | binary responses are accepted and a third or malformed score is refused | - | 정적 |
| test/jev-binary-contract.test.mjs | 33 | - | the real adapter accepts a binary provider response without leaking the key | - | 정적 |
| test/jev-diagnostics.test.mjs | 27 | - | `D-CODES-${i} rejects ${diagnostic} without provider text` | - | 동적 |
| test/jev-diagnostics.test.mjs | 34 | - | D-ACCEPTANCE all labels, ties and exact sum remain unchanged; valid answers never carry diagnostics | - | 정적 |
| test/jev-diagnostics.test.mjs | 56 | - | `D-TRANSPORT ${diagnostic} preserves broad failure reason` | - | 동적 |
| test/jev-diagnostics.test.mjs | 61 | - | D-PRIVACY failure sanitizer copies only fixed enums and rejects guessed status/reason/code | - | 정적 |
| test/jev-diagnostics.test.mjs | 68 | - | D-RETENTION observation cache and evaluation report preserve fixed codes without retry or execution | - | 정적 |
| test/jev-input-factor.test.mjs | 22 | - | FACTOR-01 exactly12 families and48 current-v4 cells, no extra question calls | - | 정적 |
| test/jev-input-factor.test.mjs | 40 | - | FACTOR-02 paired representations preserve all facts, source binding and material unknowns | - | 정적 |
| test/jev-input-factor.test.mjs | 59 | - | FACTOR-03 fixture inventory contains bounded positives, material violations and unavailable helper | - | 정적 |
| test/jev-input-factor.test.mjs | 76 | - | FACTOR-04 original8 wire digests remain byte-identical and profiles cannot select arbitrary files | - | 정적 |
| test/jev-input-factor.test.mjs | 88 | - | FACTOR-05 prepare makes zero calls; injected48 preserve .51/.80 meaning without authority or quality claims | - | 정적 |
| test/jev-input-factor.test.mjs | 105 | - | FACTOR-06 CLI accepts the finite profile, refuses unknown profiles and preserves existing output | - | 정적 |
| test/jev-prompt-revision.test.mjs | 6 | - | binary wording has a distinct immutable version and prompt digest | - | 정적 |
| test/jev-shadow.test.mjs | 18 | - | SHADOW-01 eight paired cells preserve exact command, provenance and facts across representations | - | 정적 |
| test/jev-shadow.test.mjs | 36 | - | SHADOW-02 changed artifact bytes cannot retain the old digest | - | 정적 |
| test/jev-shadow.test.mjs | 41 | - | SHADOW-03 malformed/duplicate/non-synthetic corpus is rejected without input mutation | - | 정적 |
| test/jev-shadow.test.mjs | 49 | - | SHADOW-04 wire never includes draft oracle and each question is self-contained | - | 정적 |
| test/jev-shadow.test.mjs | 60 | - | SHADOW-05 current .51/.80 use p(low_risk); new questions never inherit those gates | - | 정적 |
| test/jev-shadow.test.mjs | 71 | - | SHADOW-06 response schema, pinned model, probability distribution and winning label are checked | - | 정적 |
| test/jev-shadow.test.mjs | 85 | - | SHADOW-07 prepare has no transport calls; injected replies exercise all cells without model-quality claims | - | 정적 |
| test/jev-shadow.test.mjs | 99 | - | SHADOW-08 timeout stops all subsequent cells even when a transport ignores abort | - | 정적 |
| test/jev-shadow.test.mjs | 109 | - | SHADOW-09 streamed size, malformed bytes, HTTP and provider errors cannot become valid answers | - | 정적 |
| test/jev-shadow.test.mjs | 119 | - | SHADOW-10 CLI refuses overwrite/missing key and saves a prepare artifact without a key | - | 정적 |
| test/jev-shadow.test.mjs | 133 | - | SHADOW-11 partial source coverage remains explicit and one violated atomic obligation is not averaged away | - | 정적 |
| test/jev-shadow.test.mjs | 143 | - | SHADOW-12 timeout covers stalled body; auth and rate rejection leave remaining cells unattempted | - | 정적 |
| test/linux-desktop-session.test.mjs | 65 | - | Linux 관리형 세션의 경계값을 실행 전에 거절한다 | - | 정적 |
| test/linux-desktop-session.test.mjs | 72 | - | RDP application은 고정 loopback·클라이언트·인증 모드만 허용한다 | - | 정적 |
| test/linux-desktop-session.test.mjs | 86 | - | RDP bootstrap 실패는 RFB 전에 원 오류를 보존하고 채널을 닫는다 | - | 정적 |
| test/linux-desktop-session.test.mjs | 101 | - | RDP fd3가 없으면 credential 공급자를 호출하지 않는다 | - | 정적 |
| test/linux-desktop-session.test.mjs | 168 | - | RDP text·key·pointer·release는 native 단일 큐만 쓰며 CLOSE ACK 뒤 helper를 닫는다 | - | 정적 |
| test/linux-desktop-session.test.mjs | 184 | - | RDP partial native ACK는 재전송 없이 원 오류와 별도 helper cleanup을 남긴다 | - | 정적 |
| test/linux-desktop-session.test.mjs | 197 | - | RDP partial native ACK 뒤 helper cleanup 증거가 없으면 close도 unknown을 유지한다 | - | 정적 |
| test/linux-desktop-session.test.mjs | 210 | - | RDP native CLOSE ACK는 helper 종료 영수증·cleanup 증거를 대신하지 않는다 | - | 정적 |
| test/linux-desktop-session.test.mjs | 217 | - | RDP 취소는 추가 INPUT/CLOSE 재전송 없이 helper를 회수한다 | - | 정적 |
| test/linux-desktop-session.test.mjs | 225 | - | TEST Linux GUI: 실제 화면·텍스트·포인터 입력과 소유 세션 종료 | - | 정적 |
| test/linux-desktop-session.test.mjs | 249 | - | TEST Linux GUI: 동시 세션은 display·generation·PID를 공유하지 않는다 | - | 정적 |
| test/linux-desktop-session.test.mjs | 261 | - | TEST Linux GUI: RFB 입력 EOF와 TTL이 소유 자식을 회수한다 | - | 정적 |
| test/linux-desktop-session.test.mjs | 289 | - | TEST Linux GUI: helper 종료 영수증이 없으면 성공한 exit도 unknown이다 | - | 정적 |
| test/linux-desktop-session.test.mjs | 295 | - | TEST Linux GUI: 터미널이 만든 별도 프로세스 세션도 함께 회수한다 | - | 정적 |
| test/local-secret-store.test.mjs | 20 | - | private local store registers, rotates, resolves and removes while metadata excludes value | - | 정적 |
| test/local-secret-store.test.mjs | 42 | - | unsafe permissions, symlinks, hardlinks, corruption and oversized records fail closed | - | 정적 |
| test/local-secret-store.test.mjs | 64 | - | exclusive writer lock refuses overlap and stale locks while committed readers see complete records | - | 정적 |
| test/local-secret-store.test.mjs | 79 | - | CLI set/rotation/status/list/delete show metadata only and mismatched confirmation preserves prior value | - | 정적 |
| test/local-secret-store.test.mjs | 91 | - | independent writer processes honor the filesystem claim and leave one complete committed record | - | 정적 |
| test/maintenance-client.test.mjs | 11 | - | client verifies durable capability before mutation and passes the same owner on reserve and release | - | 정적 |
| test/maintenance-client.test.mjs | 55 | - | installer maintenance helper recovers a retained active owner token and cleans up its directory | - | 정적 |
| test/maintenance-durable.test.mjs | 21 | - | MAINT-OUTPUT unreadable maintenance or cleanup guard fails before expired bytes are deleted | - | 정적 |
| test/maintenance-durable.test.mjs | 39 | - | reservation is owner-bound across replacement and preservation comparison requires a new instance | - | 정적 |
| test/maintenance-durable.test.mjs | 88 | - | a crashed owner survives process exit and a concurrent process cannot take the SQLite claim | - | 정적 |
| test/maintenance.test.mjs | 8 | - | maintenance atomically excludes pending/running jobs and blocks new execution during deployment preparation | - | 정적 |
| test/mcp-contracts.test.mjs | 54 | - | owner completion observation reuses existing authenticated GET and returns no command body | - | 정적 |
| test/mcp-contracts.test.mjs | 73 | - | owner completion observation checks current authorization again after waiting | - | 정적 |
| test/mcp-contracts.test.mjs | 83 | - | MCP initialization distinguishes remote calls from model-external local file transfer | - | 정적 |
| test/mcp-contracts.test.mjs | 98 | - | actual MCP files projects UUID metadata and observes the original queued placement | - | 정적 |
| test/mcp-contracts.test.mjs | 134 | - | MCP files retains unconfirmed admission in UUID status without inventing an observable job | - | 정적 |
| test/mcp-contracts.test.mjs | 149 | - | actual MCP HTTP preserves 5 KiB and 32 KiB native commands plus bilingual path-only context | - | 정적 |
| test/mcp-contracts.test.mjs | 165 | - | actual MCP HTTP refuses invalid or secret descriptions without dispatch or secret reflection | - | 정적 |
| test/mcp-contracts.test.mjs | 188 | - | public MCP surface exposes operation and card tools while owner UI actions stay app-only | - | 정적 |
| test/mcp-contracts.test.mjs | 222 | - | cardless discovery stays read-only and exposes limits plus owner authority for either UI setting | - | 정적 |
| test/mcp-contracts.test.mjs | 238 | - | SDK-published MCP schemas compile in draft-07 and remain structurally compatible with 2020-12 | - | 정적 |
| test/mcp-contracts.test.mjs | 253 | - | native submit rejects unknown fields, wrong kinds, missing payload and invalid replay keys before dispatch | - | 정적 |
| test/mcp-contracts.test.mjs | 268 | - | observe requires one stable lookup and explicit output reads; timeout never cancels or resubmits | - | 정적 |
| test/mcp-contracts.test.mjs | 278 | - | text-only MCP clients reconstruct bounded UTF-8 output and digest with no status body leakage | - | 정적 |
| test/mcp-contracts.test.mjs | 292 | - | actual MCP observe projects signal delivery without converting a request into remote exit evidence | - | 정적 |
| test/mcp-contracts.test.mjs | 310 | - | native submit keeps exact UTF-8 limits and refuses command overflow without dispatch | - | 정적 |
| test/mcp-contracts.test.mjs | 319 | - | app-only chunks decode canonical base64 before the application sees bytes | - | 정적 |
| test/mcp-contracts.test.mjs | 337 | - | health callback exceptions become controlled 503 and leave the HTTP server usable | - | 정적 |
| test/mcp-contracts.test.mjs | 349 | - | web presents neutral outcomes as legacy JSON and approval waits for completion | - | 정적 |
| test/mcp-contracts.test.mjs | 362 | - | download-ready publishes only filename while the renewed URL stays in private metadata | - | 정적 |
| test/mcp-contracts.test.mjs | 381 | - | health and MCP initialization report the actual package version | - | 정적 |
| test/mcp-input-limits.test.mjs | 61 | - | MCP HTTP enforces one MiB before parsing tool calls, initialization and batches, including chunked requests | - | 정적 |
| test/mcp-input-limits.test.mjs | 79 | - | MCP aggregate bound precedes every schema while strict schemas reject unknown fields and desktop accepts 128 actions | - | 정적 |
| test/mcp-input-limits.test.mjs | 110 | - | native JSON preserves exact command/source bytes, sixteen literal arguments, full artifact chunks and bounded observations | - | 정적 |
| test/mcp180-bytes.test.mjs | 26 | - | MCP 1.8 states and explicit output preserve the status trust boundary | - | 정적 |
| test/mcp180-bytes.test.mjs | 45 | - | MCP 1.8 file diagnostics retain policy refusal versus native OS failure | - | 정적 |
| test/mcp180-bytes.test.mjs | 58 | - | MCP 1.8 audit persistence failure stays distinct from successful remote execution | - | 정적 |
| test/mcp180-bytes.test.mjs | 67 | - | MCP 1.8 preserves typed deadline, transport, cancellation and exit evidence without raw output | - | 정적 |
| test/mcp180-bytes.test.mjs | 83 | - | MCP 1.8 binary contract transfers bytes without UI, URLs, shell or local stdio | - | 정적 |
| test/mcp180-bytes.test.mjs | 134 | - | MCP 1.8 desktop observation returns actual image content and no owner identity | - | 정적 |
| test/model-selection.test.mjs | 8 | - | selected pinned version reaches the API and old saved versions remain exact; aliases cannot move authority | - | 정적 |
| test/model-selection.test.mjs | 16 | - | switching model versions cannot bypass the shared outstanding-call limit | - | 정적 |
| test/model-selection.test.mjs | 21 | - | catalog reads coalesce, refresh daily, keep failures for an hour, and never evaluate commands | - | 정적 |
| test/model-selection.test.mjs | 31 | - | provider model metadata uses the fixed account endpoint and excludes aliases and unknown fields | - | 정적 |
| test/multi-admin.test.mjs | 34 | - | 'unchanged '+variant+' rule survives another target review/save, with CAS and exact digest' | - | 동적 |
| test/multi-admin.test.mjs | 63 | - | disable suspends the target; identical re-enable restores the same binding and existing policy | - | 정적 |
| test/multi-admin.test.mjs | 73 | - | stored output rechecks current activation/revision without repeating SSH execution | - | 정적 |
| test/multi-admin.test.mjs | 83 | - | ambiguous request ownership refuses all routing without calling either target | - | 정적 |
| test/multi-target-config.test.mjs | 10 | - | registered target configuration is bounded, immutable, optional, with an explicit fixed default only | - | 정적 |
| test/multi-target-config.test.mjs | 28 | - | target aliases preserve profile pairing and separate revision fences even on shared SSH identities | - | 정적 |
| test/multi-target-ssh.test.mjs | 36 | - | two independent pinned loopback SSH servers receive only their selected read/write profiles | - | 정적 |
| test/multi-target.test.mjs | 49 | - | MCP target routing, explicit/default refusal and owner-only HTTP filtering preserve fixed identities | - | 정적 |
| test/multi-target.test.mjs | 72 | - | file bootstrap, staged bytes, approval tickets and cleanup remain target-owned | - | 정적 |
| test/multi-target.test.mjs | 107 | - | native upload revision bindings keep staged bytes, submitted status and execution target-owned | - | 정적 |
| test/multi-target.test.mjs | 129 | - | durable global slots queue reads, serialize targets, fence audit/configuration changes and drain shutdown | - | 정적 |
| test/multi-target.test.mjs | 155 | - | global import/quota reservations survive cross-target failure and maintenance races | - | 정적 |
| test/multi-target.test.mjs | 169 | - | changed target revisions reject old bootstrap/native admission and download reads cannot cross targets | - | 정적 |
| test/multiline-commands.test.mjs | 44 | - | ML-INPUT accepts LF, CRLF and heredoc tabs without changing classifier input | - | 정적 |
| test/multiline-commands.test.mjs | 56 | - | ML-IDENTITY newline, tab and surrounding whitespace remain distinct digest subjects | - | 정적 |
| test/multiline-commands.test.mjs | 69 | - | ML-BOUND exact 32KiB multiline UTF-8 accepted; excess and forbidden controls refused before classifier | - | 정적 |
| test/multiline-commands.test.mjs | 99 | - | ML-NAMES multiline syntax never establishes partial name or Windows read approval | - | 정적 |
| test/multiline-commands.test.mjs | 149 | - | `ML-AUTH ${platform} multiline requires full review and preserves owner/model/TEST routes` | - | 동적 |
| test/multiline-commands.test.mjs | 182 | - | `ML-READ ${platform} multiline cannot use an injected read-only prefix classification` | - | 동적 |
| test/multiline-commands.test.mjs | 191 | - | ML-SH real Linux shell executes quoted/unquoted/tab-stripped/piped heredocs | - | 정적 |
| test/native-install-paths.test.mjs | 15 | - | fresh and reused native release prepare the pinned runtime after the mode sweep | - | 정적 |
| test/native-install-paths.test.mjs | 24 | - | Docker verifies and prepares the bundle in build stage and supplies its runtime ABI | - | 정적 |
| test/native-install-paths.test.mjs | 58 | - | actual preparation preserves executable mode and avoids apt when dependencies resolve | - | 정적 |
| test/native-install-paths.test.mjs | 66 | - | optional GUI package failure does not stop bridge installation | - | 정적 |
| test/native-install-paths.test.mjs | 73 | - | existing release preparation reuses the validated executable without changing its mode | - | 정적 |
| test/native-install-paths.test.mjs | 79 | - | Ubuntu22.04 retains bridge support without installing incompatible GUI libraries | - | 정적 |
| test/native-install-paths.test.mjs | 85 | - | Ubuntu24.04 missing ABI installs only the pinned runtime dependency set | - | 정적 |
| test/offline-preservation.test.mjs | 19 | - | offline baseline leaves old databases untouched and verifies first candidate startup | - | 정적 |
| test/offline-preservation.test.mjs | 37 | - | offline preparation refuses a live database owner and leaves no reservation file | - | 정적 |
| test/offline-preservation.test.mjs | 46 | - | offline baseline includes existing dormant command journal | - | 정적 |
| test/offline-preservation.test.mjs | 59 | - | offline baseline refuses interrupted requests and first startup detects later data changes | - | 정적 |
| test/oidc-access.test.mjs | 12 | - | OIDC configuration pins HTTPS issuer, independent JWKS, client and exact owners | - | 정적 |
| test/oidc-access.test.mjs | 19 | - | OIDC enforces signature, issuer, audience/authorized party, verified human owner and claim times | - | 정적 |
| test/oidc-access.test.mjs | 30 | - | OIDC requires exp, iat, sub, verified email and rejects symmetric token substitution | - | 정적 |
| test/oidc-access.test.mjs | 37 | - | OIDC route guard rejects administrator bearer fallback and protects static/download routes | - | 정적 |
| test/oidc-access.test.mjs | 44 | - | OIDC ES256 tokens are verified using the configured key set | - | 정적 |
| test/opaque-artifacts.test.mjs | 19 | - | staged UUID allocation is owner-bound and operation-key idempotent without a target/path | - | 정적 |
| test/opaque-artifacts.test.mjs | 33 | - | staged identifiers and hashes reject trailing CR/LF without normalization | - | 정적 |
| test/opaque-artifacts.test.mjs | 45 | - | raw binary chunks recover after restart, reject altered retries, and complete idempotently | - | 정적 |
| test/opaque-artifacts.test.mjs | 66 | - | empty files, final hash mismatch, staged TTL, and quota use the existing lifecycle | - | 정적 |
| test/opaque-artifacts.test.mjs | 83 | - | consumption is a restart-safe tombstone with the original UUID and metadata | - | 정적 |
| test/opaque-file-api.test.mjs | 31 | - | HTTP create/raw chunks/complete expose only UUID and explicit public metadata | - | 정적 |
| test/opaque-file-api.test.mjs | 53 | - | route requires verified principal and same authorization after body I/O | - | 정적 |
| test/opaque-file-api.test.mjs | 67 | - | strict staging fields forbid destination, target, owner and extra completion inputs | - | 정적 |
| test/opaque-file-api.test.mjs | 79 | - | binary request bounds, chunk digest and method/content admission protect unchanged progress | - | 정적 |
| test/opaque-file-api.test.mjs | 95 | - | public API distinguishes quota, absent UUID, full-file hash and unavailable service safely | - | 정적 |
| test/opaque-file-api.test.mjs | 137 | - | only allowlisted typed codes and exact legacy literals cross the public error boundary | - | 정적 |
| test/opaque-file-api.test.mjs | 152 | - | HTTP identifiers and hash fields reject CR/LF suffixes rather than trimming them | - | 정적 |
| test/opaque-files-application.test.mjs | 48 | - | composed owner HTTP staging and MCP copy/move share durable admission and exact bytes | - | 정적 |
| test/opaque-files-application.test.mjs | 81 | - | artifact HTTP policy requires verified owner and exact origin for every supported method | - | 정적 |
| test/opaque-files-client.test.mjs | 71 | - | opaque upload sends exact385KiB as bounded raw bytes and returns only the completed UUID | - | 정적 |
| test/opaque-files-client.test.mjs | 96 | - | server cause: shared session preserves typed causes without changing legacy refusal codes | - | 정적 |
| test/opaque-files-client.test.mjs | 104 | - | server cause: malformed JSON or non-JSON error responses retain the original refusal only | - | 정적 |
| test/opaque-files-client.test.mjs | 111 | - | server cause: only a3..64 uppercase ASCII code is retained, never arbitrary error values | - | 정적 |
| test/opaque-files-client.test.mjs | 126 | - | server cause: the existing1MiB JSON body limit also bounds optional refusal causes | - | 정적 |
| test/opaque-files-client.test.mjs | 136 | - | server cause:401 remains owner reauthentication and never accepts a contradictory server cause | - | 정적 |
| test/opaque-files-client.test.mjs | 145 | - | server cause: network uncertainty retains read/write distinctions without inventing a cause | - | 정적 |
| test/opaque-files-client.test.mjs | 152 | - | server cause: opaque upload and CLI stderr retain a safe chunk cause with the same UUID only | - | 정적 |
| test/opaque-files-client.test.mjs | 165 | - | opaque status projects safe metadata for the same UUID across declared states | - | 정적 |
| test/opaque-files-client.test.mjs | 182 | - | existing ready artifact yields UUID without chunk or completion replay | - | 정적 |
| test/opaque-files-client.test.mjs | 188 | - | zero-byte snapshot completes without fabricated chunk bytes | - | 정적 |
| test/opaque-files-client.test.mjs | 195 | - | owner refusal and malformed progress metadata never send file chunks | - | 정적 |
| test/opaque-files-client.test.mjs | 202 | - | existing partial artifact is observed and never silently resumed | - | 정적 |
| test/opaque-files-client.test.mjs | 208 | - | begin response loss preserves uncertainty without a replacement allocation | - | 정적 |
| test/opaque-files-client.test.mjs | 214 | - | lost chunk response observes the same UUID and sends no retry or complete | - | 정적 |
| test/opaque-files-client.test.mjs | 221 | - | lost completion response reports same ready UUID as progress without replay or false success | - | 정적 |
| test/opaque-files-client.test.mjs | 227 | - | wrong acknowledgement cannot produce a completed UUID or skip a byte range | - | 정적 |
| test/opaque-files-client.test.mjs | 233 | - | invalid UUID and mismatched whole hash fail before sending file chunks | - | 정적 |
| test/opaque-files-client.test.mjs | 240 | - | CLI upload emits only one UUID JSON line and never prints source bytes, filename or credential | - | 정적 |
| test/opaque-files-client.test.mjs | 250 | - | CLI lost response emits no success stdout and only bounded same-UUID progress on stderr | - | 정적 |
| test/opaque-files-client.test.mjs | 262 | - | CLI rejects missing stable key and invalid UUID before credential or network access | - | 정적 |
| test/opaque-files-client.test.mjs | 272 | - | operation-key grammar matches the public16..128 ASCII contract at both boundaries | - | 정적 |
| test/opaque-files-client.test.mjs | 277 | - | client tar and zip contain identical verified sources and run without npm dependencies | - | 정적 |
| test/opaque-files.test.mjs | 53 | - | copy uses a target-bound fd clone and recovers one durable request after lost replies/restart | - | 정적 |
| test/opaque-files.test.mjs | 69 | - | move keeps the source for unknown outcomes and consumes once only after confirmed publication | - | 정적 |
| test/opaque-files.test.mjs | 90 | - | completed without a publication acknowledgement never consumes the move source | - | 정적 |
| test/opaque-files.test.mjs | 98 | - | publication checks bind source bytes, audit status and optional execution metadata | - | 정적 |
| test/opaque-files.test.mjs | 117 | - | recovery removes only proven unaccepted clone provenance; missing-journal queue identity is preserved | - | 정적 |
| test/opaque-files.test.mjs | 138 | - | unknown or missing-journal copy blocks a new move but preserves the original receipt | - | 정적 |
| test/opaque-files.test.mjs | 179 | - | startup orphan cleanup preserves other-job queue references and failed/incomplete journal reads | - | 정적 |
| test/opaque-files.test.mjs | 195 | - | startup reference scan includes retained legacy rows beyond the ordinary journal row limit | - | 정적 |
| test/opaque-files.test.mjs | 206 | - | chunk hash failure and wrong-owner UUID access do not change accepted bytes | - | 정적 |
| test/opaque-files.test.mjs | 216 | - | copy and move operation keys reject trailing CR/LF before any admission | - | 정적 |
| test/operation-migration-180.test.mjs | 32 | - | migration retains exact history/policies and source bytes, archives readonly, and never queues legacy work | - | 정적 |
| test/operation-migration-180.test.mjs | 57 | - | legacy global request-key collisions fail before adding canonical rows or changing original journals | - | 정적 |
| test/operation-migration-180.test.mjs | 72 | - | unsupported and unclean old schemas fail before import without changing the old database | - | 정적 |
| test/operation-migration-180.test.mjs | 82 | - | `redeployment preserves the first import after real ${previousVersion} journal recovery and still detects conflicting original evidence` | - | 동적 |
| test/operation-migration-180.test.mjs | 135 | - | `an existing ${previousVersion} deployment requires authoritative completed migration evidence and never guesses from a partial state` | - | 동적 |
| test/operation-migration-180.test.mjs | 150 | - | migration reuse rejects an archive symlink before opening its target | - | 정적 |
| test/operation-migration-180.test.mjs | 161 | - | a restored 1.7 writer with additional history cannot silently reuse an earlier migration marker | - | 정적 |
| test/operation-migration-180.test.mjs | 181 | - | recovery checks payloads and new durable stores, not only operations rows | - | 정적 |
| test/operation-migration-180.test.mjs | 194 | - | fingerprints cover capacity and known SQLite sidecars while unknown database names remain refused | - | 정적 |
| test/operation-migration-180.test.mjs | 211 | - | recover refuses a downmigration after new writes and leaves candidate selected and data intact | - | 정적 |
| test/operation-migration-180.test.mjs | 230 | - | capacity database and sidecar writes each prevent automatic recovery without changing the active release or data | - | 정적 |
| test/operation-migration-batch.test.mjs | 27 | - | 8000 synthetic legacy rows migrate within the existing 60-second child boundary, preserve bytes, and recheck idempotently | - | 정적 |
| test/operation-migration-batch.test.mjs | 60 | - | batch failures preserve earlier imports and exact retained/live byte and row budgets across reopen | - | 정적 |
| test/operation-migration-batch.test.mjs | 89 | - | a pre-budget partial import with a hot SQLite journal reopens without losing original history or charging live allowance | - | 정적 |
| test/operation-migration-batch.test.mjs | 107 | - | accepted 30 MiB original history may expand beyond 64 MiB without consuming the separate live budget | - | 정적 |
| test/operation-migration-batch.test.mjs | 134 | - | batch verification rejects missing and conflicting evidence without adding rows or events | - | 정적 |
| test/operation-migration-preflight.test.mjs | 51 | - | C18-01 cross-source request-key collisions reject the whole inventory before any canonical write | - | 정적 |
| test/operation-migration-preflight.test.mjs | 61 | - | C18-01 explicit keys cannot collide with another source default legacy key | - | 정적 |
| test/operation-migration-preflight.test.mjs | 70 | - | C18-02 cross-source operation ID collisions reject different original keys without partial import | - | 정적 |
| test/operation-migration-preflight.test.mjs | 82 | - | `C18-03 a late canonical ${conflict} conflict cannot commit an earlier 129-row source` | - | 동적 |
| test/operation-migration-preflight.test.mjs | 105 | - | C18-04 an exact partial import resumes without changing existing evidence or replaying work | - | 정적 |
| test/operation-migration-preflight.test.mjs | 125 | - | C18-05 Unicode original keys and evidence remain exact and distinct through preflight and rerun | - | 정적 |
| test/operation-migration-retained-budget.test.mjs | 19 | - | two accepted 10000-row sources remain visible beside live jobs and cannot consume live execution or storage slots | - | 정적 |
| test/operation-migration-retained-budget.test.mjs | 38 | - | exact 256 KiB legacy entries survive expanded body/contract storage and retain their immutable evidence | - | 정적 |
| test/operation-migration-retained-budget.test.mjs | 56 | - | legacy result growth charges the live byte budget exactly and shrinking restores it without enlarging reservations | - | 정적 |
| test/operation-migration-retained-budget.test.mjs | 70 | - | a legacy shrink cannot fund another row, while each original baseline and aggregate live growth remain available | - | 정적 |
| test/operation-migration-retained-budget.test.mjs | 89 | - | missing old reservations never turn a modified import projection into a free baseline | - | 정적 |
| test/operation-observer-http.test.mjs | 42 | - | HK01 owner reads existing key and ID through the same bounded operation contract | - | 정적 |
| test/operation-observer-http.test.mjs | 54 | - | HK02 malformed duplicate unknown selectors and unauthenticated calls cannot observe | - | 정적 |
| test/operation-observer-http.test.mjs | 66 | - | HK03 key longpoll uses the existing detached budget while owner control stays available | - | 정적 |
| test/operation-observer-http.test.mjs | 80 | - | HK04 key status is withheld if owner authority expires during observation | - | 정적 |
| test/operation-observer-http.test.mjs | 90 | - | HK05 missing or revision-conflicting keys preserve refusal without replacement work | - | 정적 |
| test/operation-scheduler.test.mjs | 26 | - | one ready-target ring provides round robin fairness and target FIFO across operation kinds | - | 정적 |
| test/operation-scheduler.test.mjs | 35 | - | duplicate enqueue never dispatches twice and key conflicts reject before effects | - | 정적 |
| test/operation-scheduler.test.mjs | 43 | - | unknown blocks one conflict key while independent work continues on the same target | - | 정적 |
| test/operation-scheduler.test.mjs | 54 | - | 33 retained legacy unknowns stay visible without consuming admission or dispatch capacity | - | 정적 |
| test/operation-scheduler.test.mjs | 83 | - | live unknowns still exhaust the shared budget and stop queued dispatch beside retained history | - | 정적 |
| test/operation-scheduler.test.mjs | 102 | - | partial legacy markers do not exempt a live unknown from admission risk | - | 정적 |
| test/operation-scheduler.test.mjs | 117 | - | shrinking capacity preserves running and accepted work; overload is typed and unaccepted | - | 정적 |
| test/operation-scheduler.test.mjs | 129 | - | observation timeout/abort never cancels execution; explicit queued cancellation has no effects | - | 정적 |
| test/operation-scheduler.test.mjs | 139 | - | running cancellation remains terminating until typed remote settlement | - | 정적 |
| test/operation-scheduler.test.mjs | 146 | - | approval terminal transitions wake registered observers without executing the operation | - | 정적 |
| test/operation-scheduler.test.mjs | 154 | - | queued expiry wakes while the occupied execution slot remains running | - | 정적 |
| test/operation-scheduler.test.mjs | 163 | - | expiry during a dispatch guard still prevents the executor from starting | - | 정적 |
| test/operation-scheduler.test.mjs | 172 | - | safe integer capacity has no arbitrary cap and the default risk budget follows global concurrency | - | 정적 |
| test/operation-scheduler.test.mjs | 183 | - | guard refusal is not dispatched and notification errors cannot strand the next job | - | 정적 |
| test/operation-scheduler.test.mjs | 190 | - | queued restart checks the original expiry and running restart never calls execute again | - | 정적 |
| test/operation-store.test.mjs | 18 | - | durable acceptance returns one identity for equal contracts and rejects changed bytes/owner/pins | - | 정적 |
| test/operation-store.test.mjs | 30 | - | optimistic claims persist before dispatch and cannot be acquired twice | - | 정적 |
| test/operation-store.test.mjs | 44 | - | restart preserves queued contracts and isolates dispatched attempts as unknown without replay | - | 정적 |
| test/operation-store.test.mjs | 59 | - | typed remote evidence determines terminal outcome; a resolved legacy promise proves nothing | - | 정적 |
| test/operation-store.test.mjs | 69 | - | legacy import preserves exact old identity/evidence/output and never executes old queued rows | - | 정적 |
| test/operation-store.test.mjs | 82 | - | explicit conflict keys serialize active work and quarantine only their target revision | - | 정적 |
| test/operation-store.test.mjs | 93 | - | unknown budget reserves every active attempt and journal budget refuses new records explicitly | - | 정적 |
| test/operation-watch-cli.test.mjs | 10 | - | watch CLI accepts an already completed operation without creating an upload | - | 정적 |
| test/operation-watch-cli.test.mjs | 17 | - | watch CLI waits outside model input and emits one final event; old upload client is not used | - | 정적 |
| test/operation-watch-cli.test.mjs | 37 | - | watch CLI preserves failed and uncertain terminal states with exit 1 and no replay | - | 정적 |
| test/operation-watch-cli.test.mjs | 46 | - | watch CLI rejects malformed identifiers and deadlines before credentials or owner connection | - | 정적 |
| test/operation-watch-cli.test.mjs | 55 | - | watch CLI read failure retains the original ID and closes its session | - | 정적 |
| test/operation-watch-cli.test.mjs | 64 | - | opt-in completion notification runs once after terminal status and keeps failures separate from SSH | - | 정적 |
| test/operation-watch-cli.test.mjs | 83 | - | completion routing requires an explicit executable and exact thread before authentication | - | 정적 |
| test/operation-watch-cli.test.mjs | 98 | - | CK01 key watch passes exact selector binding and retains the existing deadline | - | 정적 |
| test/operation-watch-cli.test.mjs | 110 | - | CK02 key and ID are exclusive and malformed selectors refuse before authentication | - | 정적 |
| test/operation-watch-cli.test.mjs | 122 | - | CK03 key observation errors retain the key and learned ID without replay | - | 정적 |
| test/operation-watch-cli.test.mjs | 130 | - | CK04 ID observation also accepts the exact expected target binding | - | 정적 |
| test/operation-watcher.test.mjs | 66 | - | W01 W09 already completed work returns one bounded event without output or command disclosure | - | 정적 |
| test/operation-watcher.test.mjs | 78 | - | W02 pending longpoll permits independent work and resolves only once after completion | - | 정적 |
| test/operation-watcher.test.mjs | 94 | - | W03 failure refusal cancellation expiry and unknown remain distinct terminal results | - | 정적 |
| test/operation-watcher.test.mjs | 106 | - | W04 foreign IDs invalid states malformed contracts and refusals retain the requested ID | - | 정적 |
| test/operation-watcher.test.mjs | 121 | - | W05 target or revision changes after the initial status cannot produce completion | - | 정적 |
| test/operation-watcher.test.mjs | 129 | - | W06 HTTP authentication refusal and transport failures preserve typed errors without retry | - | 정적 |
| test/operation-watcher.test.mjs | 140 | - | W07 close interrupts only the local read and logs out without cancelling remote work | - | 정적 |
| test/operation-watcher.test.mjs | 149 | - | W08 external abort stops observation and preserves identity without remote cancellation | - | 정적 |
| test/operation-watcher.test.mjs | 158 | - | W10 invalid operation identifiers are rejected before any operation read | - | 정적 |
| test/operation-watcher.test.mjs | 174 | - | WK01 key-only observation binds the returned ID and preserves unknown outcome | - | 정적 |
| test/operation-watcher.test.mjs | 183 | - | WK02 key lookup rejects changed or absent key ID target and revision | - | 정적 |
| test/operation-watcher.test.mjs | 192 | - | WK03 expected target binding is enforced on the very first terminal response | - | 정적 |
| test/operation-watcher.test.mjs | 201 | - | WK04 invalid selectors and incomplete bindings refuse before operation reads | - | 정적 |
| test/operation-watcher.test.mjs | 210 | - | WK05 missing key is a refusal and never submits a replacement | - | 정적 |
| test/operation-watcher.test.mjs | 220 | - | WK06 ID object selector enforces the expected binding on first response | - | 정적 |
| test/operation-watcher.test.mjs | 227 | - | WK07 requireInitialNonTerminal marks alreadySettledOnFirstPoll only when terminal on first poll | - | 정적 |
| test/operations-180.test.mjs | 66 | - | parallel same-key submissions share one durable identity and one approval/execution admission | - | 정적 |
| test/operations-180.test.mjs | 77 | - | observation rechecks target revision after waiting before delivering the state | - | 정적 |
| test/operations-180.test.mjs | 88 | - | an in-flight key rejects changed bytes before the second port call while independent keys progress | - | 정적 |
| test/operations-180.test.mjs | 98 | - | source/download admission uses the same key guard and snapshots mutable source arguments | - | 정적 |
| test/operations-180.test.mjs | 110 | - | download context is validated, retained and bound to the same durable key with optional revision | - | 정적 |
| test/operations-180.test.mjs | 128 | - | a failed admission releases its key without inventing acceptance or replaying accepted work | - | 정적 |
| test/operations-180.test.mjs | 137 | - | a port returning a different journal identity cannot confirm this operation key | - | 정적 |
| test/operations-180.test.mjs | 145 | - | observation reads output only on explicit request and preserves target/revision/execution authorization | - | 정적 |
| test/operations-180.test.mjs | 159 | - | cancellation targets the original operation and never submits a replacement | - | 정적 |
| test/operations-180.test.mjs | 169 | - | default observe returns running state without waiting for held execution | - | 정적 |
| test/portal-client-bound-files.test.mjs | 35 | - | guarded save checks fixed bytes and operation before ticket or publication | - | 정적 |
| test/portal-client-bound-files.test.mjs | 41 | - | guarded save accepts exact binary and empty contents and preserves old calls | - | 정적 |
| test/portal-client-bound-files.test.mjs | 46 | - | guarded save rejects malformed expectations before HTTP | - | 정적 |
| test/portal-client-bound-files.test.mjs | 51 | - | guarded save binds a copied expectation to its own metadata read | - | 정적 |
| test/portal-client-bound-files.test.mjs | 55 | - | bound resume accepts original revision and bytes on the same transfer ID | - | 정적 |
| test/portal-client-bound-files.test.mjs | 59 | - | bound resume refuses current epoch or recorded binding mismatch without mutation | - | 정적 |
| test/portal-client-bound-files.test.mjs | 67 | - | resume checks declared source bytes even for legacy calls before chunks | - | 정적 |
| test/portal-client-cloudflared.test.mjs | 56 | - | stdin credential mode remains available without invoking cloudflared | - | 정적 |
| test/portal-client-cloudflared.test.mjs | 65 | - | cached helper mode connects privately once with a finite execution budget | - | 정적 |
| test/portal-client-cloudflared.test.mjs | 80 | - | invalid mode, origin, helper path and flags refuse before credential or portal access | - | 정적 |
| test/portal-client-cloudflared.test.mjs | 106 | - | helper failures suppress raw stdout stderr and never retry or reach the portal | - | 정적 |
| test/portal-client-cloudflared.test.mjs | 120 | - | empty malformed and oversized cached credentials refuse before portal access | - | 정적 |
| test/portal-client-cloudflared.test.mjs | 130 | - | pending command status stays pending without an approval mutation | - | 정적 |
| test/portal-client-cloudflared.test.mjs | 137 | - | lost upload response retains the same transfer ID without begin or chunk replay | - | 정적 |
| test/portal-client-cloudflared.test.mjs | 152 | - | cached authentication preserves upload bytes and a pending upload ACK | - | 정적 |
| test/portal-client-cloudflared.test.mjs | 165 | - | cached authentication reports saved only after exclusive local byte and hash verification | - | 정적 |
| test/portal-client-combined.test.mjs | 6 | - | output and source-bound upload reject each other\'s options before credentials or HTTP | - | 정적 |
| test/portal-client-discovery.test.mjs | 78 | - | discovery accepts an explicit portable Unicode path despite a PATH miss and preserves precedence | - | 정적 |
| test/portal-client-discovery.test.mjs | 90 | - | broken explicit and environment configuration never silently fall back to a working PATH helper | - | 정적 |
| test/portal-client-discovery.test.mjs | 111 | - | PATH discovery skips current and relative entries and accepts only the exact platform executable | - | 정적 |
| test/portal-client-discovery.test.mjs | 137 | - | PATH discovery enforces directory and character limits before any candidate can win | - | 정적 |
| test/portal-client-discovery.test.mjs | 147 | - | cached credentials invoke exactly one bounded non-shell cache read and never login | - | 정적 |
| test/portal-client-discovery.test.mjs | 164 | - | cached credential failures distinguish missing executable, access, timeout and output limits without private diagnostics | - | 정적 |
| test/portal-client-discovery.test.mjs | 178 | - | doctor reports ready for a portable helper with no PATH and reads credentials once without remote operations | - | 정적 |
| test/portal-client-discovery.test.mjs | 198 | - | doctor distinguishes undiscovered helper from unusable cache and never opens a portal for either | - | 정적 |
| test/portal-client-discovery.test.mjs | 216 | - | doctor separates owner authentication, mode and portal availability failures and closes once | - | 정적 |
| test/portal-client-discovery.test.mjs | 231 | - | doctor rejects malformed or oversized target responses instead of claiming readiness | - | 정적 |
| test/portal-client-discovery.test.mjs | 247 | - | doctor does not report readiness when temporary session cleanup is unknown | - | 정적 |
| test/portal-client-discovery.test.mjs | 262 | - | CLI doctor uses injected environment discovery and returns public ready or blocked JSON with correct exit codes | - | 정적 |
| test/portal-client-discovery.test.mjs | 337 | - | shared owner client logs out the issued cookie after malformed connect body without becoming ready or reconnecting | - | 정적 |
| test/portal-client-discovery.test.mjs | 353 | - | doctor with the real HTTP client cleans up valid cookies after invalid or unreadable session bodies | - | 정적 |
| test/portal-client-discovery.test.mjs | 374 | - | doctor reports OWNER_SESSION_CLEANUP_UNKNOWN when logout fails after an issued cookie and invalid body | - | 정적 |
| test/portal-client-discovery.test.mjs | 391 | - | invalid or ambiguous session cookies never authorize operations or select an arbitrary cookie for logout | - | 정적 |
| test/portal-client-output.test.mjs | 51 | - | explicit output reads whole text and JSON with distinct format hashes and preserved body | - | 정적 |
| test/portal-client-output.test.mjs | 64 | - | explicit UTF8 pages preserve cursor and never claim a partial-format whole hash | - | 정적 |
| test/portal-client-output.test.mjs | 71 | - | a later UTF8 page and an empty failed command output remain readable without replay | - | 정적 |
| test/portal-client-output.test.mjs | 80 | - | invalid output identifiers ranges formats and output-only flags fail before authentication | - | 정적 |
| test/portal-client-output.test.mjs | 90 | - | unready stale or mismatched output references never fetch body or mutate work | - | 정적 |
| test/portal-client-output.test.mjs | 100 | - | malformed foreign or inconsistent pages refuse their body and retain validated IDs | - | 정적 |
| test/portal-client-output.test.mjs | 110 | - | revocation refusal and read failure expose only public errors with no retry | - | 정적 |
| test/portal-client-output.test.mjs | 118 | - | embedded client rejects invalid options without an output HTTP request | - | 정적 |
| test/portal-client-output.test.mjs | 129 | - | partial page hashes must be strings even when a whole-format hash cannot be computed | - | 정적 |
| test/portal-client-process.test.mjs | 130 | - | native CLI process uses verified TLS and private stdin through approval and exact local file roundtrip | - | 정적 |
| test/portal-client-process.test.mjs | 165 | - | native CLI process refuses untrusted TLS and non-owner identity without new file jobs or effects | - | 정적 |
| test/portal-client-process.test.mjs | 175 | - | a fresh native CLI process explicitly resumes the same transfer after an accepted chunk reply is lost | - | 정적 |
| test/portal-client-process.test.mjs | 193 | - | native owner CLI explicitly reads stored UTF8 text and JSON pages and stops on session revocation without reexecution | - | 정적 |
| test/portal-client-process.test.mjs | 231 | - | native CLI binds declared source bytes before begin while preserving valid binary and empty owner uploads | - | 정적 |
| test/portal-client-source-binding.test.mjs | 49 | - | source expectation validates exact own fields and freezes a primitive copy | - | 정적 |
| test/portal-client-source-binding.test.mjs | 64 | - | declared binary and empty snapshots upload exact bytes without expectation fields on the wire | - | 정적 |
| test/portal-client-source-binding.test.mjs | 74 | - | size and SHA mismatch refuse before remote begin, transfer callback or bytes | - | 정적 |
| test/portal-client-source-binding.test.mjs | 84 | - | late caller expectation mutation cannot replace the source identity during async capture | - | 정적 |
| test/portal-client-source-binding.test.mjs | 91 | - | source path changes after the guard do not replace the immutable snapshot sent | - | 정적 |
| test/portal-client-source-binding.test.mjs | 98 | - | invalid API expectation is refused before reading a missing source or remote begin | - | 정적 |
| test/portal-client-source-binding.test.mjs | 104 | - | bound upload unknown begin response retains ambiguity without retry or raw diagnostic | - | 정적 |
| test/portal-client-source-binding.test.mjs | 112 | - | CLI invalid expectation pair, syntax, help and non-upload use reject before helper, stdin or HTTP | - | 정적 |
| test/portal-client-source-binding.test.mjs | 134 | - | CLI forwards a valid expectation to the same upload snapshot and refuses stale bytes | - | 정적 |
| test/portal-client.test.mjs | 71 | - | owner CLI moves exact multi-chunk and empty bytes only after explicit approval, then saves the same prepared download | - | 정적 |
| test/portal-client.test.mjs | 108 | - | new file routes require valid owner proof AND its own session AND mutation Origin | - | 정적 |
| test/portal-client.test.mjs | 124 | - | owner file boundary rejects malformed fields/chunks/targets and reuses the existing staging sequence rules | - | 정적 |
| test/portal-client.test.mjs | 144 | - | legacy finish refuses duplicate, missing, ambiguous and mismatched submission bindings without a new request | - | 정적 |
| test/portal-client.test.mjs | 169 | - | concurrent legacy finishes crossing the storage await submit exactly one approval and one remote effect | - | 정적 |
| test/portal-client.test.mjs | 194 | - | lost finish and approval ACKs return known handles without a repeated POST or remote effect | - | 정적 |
| test/portal-client.test.mjs | 213 | - | redirects never carry owner credentials to a second listener; off-origin download URLs are refused | - | 정적 |
| test/portal-client.test.mjs | 229 | - | truncated delivery never publishes; explicitly saving the same prepared artifact again does not rerun SSH | - | 정적 |
| test/portal-client.test.mjs | 243 | - | cancel after a known upload allocation stops before remote approval and never creates a replacement request | - | 정적 |
| test/portal-client.test.mjs | 251 | - | CLI entry is inert on import and rejects invalid arguments before consuming private input | - | 정적 |
| test/portal-client.test.mjs | 261 | - | Access client refuses other authentication modes and malformed session cookies without a fallback | - | 정적 |
| test/portal-client.test.mjs | 276 | - | owner file admission rechecks the same session after a delayed body crosses logout or expiry | - | 정적 |
| test/portal-client.test.mjs | 358 | - | resume sends only remaining bytes of the same transfer after lost chunk ACK, including an unaligned prefix | - | 정적 |
| test/portal-client.test.mjs | 378 | - | resume reconciles a lost finish ACK and observes every known job state without another mutation | - | 정적 |
| test/portal-client.test.mjs | 407 | - | resume rejects changed source bytes, size and original destination flags before any mutation | - | 정적 |
| test/portal-client.test.mjs | 424 | - | resume refuses malformed, ready, expired or missing staging without replacement work | - | 정적 |
| test/portal-client.test.mjs | 443 | - | concurrent owner clients resuming one staging cursor produce at most one upload job | - | 정적 |
| test/portal-client.test.mjs | 465 | - | resume handles an allocated empty file without chunks or a replacement allocation | - | 정적 |
| test/portal-client.test.mjs | 479 | - | revoking the same resume session after cursor read prevents any new chunk admission | - | 정적 |
| test/portal-file-forwarder.test.mjs | 36 | - | strict human manifest and capability arguments refuse extra authority before helper | - | 정적 |
| test/portal-file-forwarder.test.mjs | 42 | - | exclusive durable initial claim permits one effect across competing instances | - | 정적 |
| test/portal-file-forwarder.test.mjs | 47 | - | unknown initial reply survives restart without a replacement request or private errors | - | 정적 |
| test/portal-file-forwarder.test.mjs | 51 | - | known transfer permits only explicit same ID resume; status remains read only | - | 정적 |
| test/portal-file-forwarder.test.mjs | 56 | - | partial journal, changed manifest and expiry fail closed without an initial effect | - | 정적 |
| test/portal-file-forwarder.test.mjs | 61 | - | pending and prepared downloads differ from verified binary and empty saved receipts | - | 정적 |
| test/portal-file-forwarder.test.mjs | 68 | - | destination collision consumes save attempt without overwrite or replay | - | 정적 |
| test/portal-file-forwarder.test.mjs | 72 | - | publication before journal receipt failure is unknown and never inferred as saved | - | 정적 |
| test/portal-file-forwarder.test.mjs | 78 | - | missing, stale or disabled advertised target revision refuses initial mutation | - | 정적 |
| test/portal-file-mcp-process.test.mjs | 33 | - | native SDK exposes strict opaque schemas and refuses additional authority without effects | - | 정적 |
| test/portal-file-mcp-process.test.mjs | 43 | - | fresh native processes race one durable initial claim and observe after restart | - | 정적 |
| test/portal-file-mcp-process.test.mjs | 49 | - | actual process crash after effect but before handle never creates replacement upload | - | 정적 |
| test/portal-file-mcp-process.test.mjs | 56 | - | production stdio entry uses verified TLS and actual owner app for fixed binary and empty PC roundtrips | - | 정적 |
| test/portal-files-hook.test.mjs | 55 | - | H01 hook watch commits and closes before wake, without ACK or private extra fields | - | 정적 |
| test/portal-files-hook.test.mjs | 77 | - | H02 absent or other-session binding is rejected before credentials and never registered | - | 정적 |
| test/portal-files-hook.test.mjs | 91 | - | H03 incomplete, mixed, wrong-command, and relative-path options fail before side effects | - | 정적 |
| test/portal-files-hook.test.mjs | 108 | - | H04 wake uncertainty keeps the committed receipt and SSH success, with exit1 and no retries | - | 정적 |
| test/portal-files-hook.test.mjs | 122 | - | H05 failed and uncertain terminal events retain their original semantics | - | 정적 |
| test/portal-files-hook.test.mjs | 131 | - | H06 failed enqueue closes the inbox and never wakes, while retaining terminal completion | - | 정적 |
| test/portal-files-hook.test.mjs | 141 | - | H07 watcher failure happens with preflight inbox already closed and causes no delivery | - | 정적 |
| test/portal-files-hook.test.mjs | 151 | - | H08 duplicate explicit delivery retains one durable receipt and never ACKs it | - | 정적 |
| test/portal-files-hook.test.mjs | 161 | - | H09 default inbox path comes only from the profile state base and fixed private leaf | - | 정적 |
| test/portal-files-hook.test.mjs | 171 | - | H10 cleanup failure after commit preserves the receipt and does not attempt wake | - | 정적 |
| test/portal-files-hook.test.mjs | 182 | - | H11 native Claude deferral is queue success without socket credentials or a receipt claim | - | 정적 |
| test/preservation-baseline.test.mjs | 39 | - | baseline mode preserves unavailable rows without promoting partial evidence to strict release | - | 정적 |
| test/preservation-baseline.test.mjs | 64 | - | baseline PASS still cannot grant strict release, nor can strict PASS grant baseline release | - | 정적 |
| test/preservation-baseline.test.mjs | 75 | - | MAINT-OUTPUT durable reservation retains expired baseline through periodic cleanup and restart, then resumes cleanup after verified release | - | 정적 |
| test/preservation-baseline.test.mjs | 103 | - | failed or unknown-mode recompare revokes earlier same-instance verification | - | 정적 |
| test/preservation-baseline.test.mjs | 117 | - | a newly added ready or unavailable output is not evidence of unchanged baseline state | - | 정적 |
| test/preservation-baseline.test.mjs | 138 | - | verified release rechecks payload after compare; a restart cannot reuse verification | - | 정적 |
| test/preservation-baseline.test.mjs | 157 | - | baseline client requires explicit server capability, exact contract and unambiguous evidence | - | 정적 |
| test/preservation-integration.test.mjs | 18 | - | persisted baseline detects a real journal change during service replacement | - | 정적 |
| test/preservation-integration.test.mjs | 41 | - | `automation ${before} to ${after} preserves the existing journal across restart` | - | 동적 |
| test/preservation-integration.test.mjs | 60 | - | enabling automation for the first time allows its new journal | - | 정적 |
| test/preservation-integration.test.mjs | 75 | - | reserved startup defers legacy output conversion and preserves strict baseline rows and payload | - | 정적 |
| test/preservation-integration.test.mjs | 133 | - | `canonical preservation rejects ${name} across real service replacement` | - | 동적 |
| test/preservation-integration.test.mjs | 152 | - | canonical preservation counts retained rows and event prefix separately from legitimate new history | - | 정적 |
| test/preservation-verification.test.mjs | 13 | - | real journals compare old rows and payload after restart, allowing expiry and new requests | - | 정적 |
| test/preservation-verification.test.mjs | 60 | - | baseline preservation distinguishes unchanged unavailable bodies from expiry, additions and actual loss | - | 정적 |
| test/preservation-verification.test.mjs | 94 | - | capture rejects in-flight state; policy or journal deletion cannot pass comparison | - | 정적 |
| test/preservation-verification.test.mjs | 108 | - | canonical capture requires its existing connection and performs SELECT only without exposing private bodies | - | 정적 |
| test/preservation-verification.test.mjs | 124 | - | canonical comparator detects budget loss and event-prefix tampering, while keeping old baseline coverage explicit | - | 정적 |
| test/preservation-verification.test.mjs | 143 | - | `canonical ${state} cannot cross an idle preservation boundary` | - | 동적 |
| test/python-source-ssh.test.mjs | 38 | - | SOURCE-SSH-01 malformed plan and writable/nonTTY/explicit-cwd guards refuse before SSH exec | - | 정적 |
| test/python-source-ssh.test.mjs | 53 | - | SOURCE-SSH-02 async target/profile changes are checked after acquiring the connection | - | 정적 |
| test/python-source-ssh.test.mjs | 62 | - | SOURCE-SSH-03 admitted plan is an immutable snapshot and dispatch exceptions never replay or expose source | - | 정적 |
| test/python-source-ssh.test.mjs | 81 | - | SOURCE-SSH-04 pinned real loopback SSH preserves UTF8 bytes, clean env and blocks short/wrong delivery effects | - | 정적 |
| test/python-source.test.mjs | 21 | - | SOURCE-01 receiver rejects valid truncated prefix, wrong bytes, trailing data and UTF8 truncation before effects | - | 정적 |
| test/python-source.test.mjs | 39 | - | SOURCE-02 bare Python executes the same valid truncated prefix, establishing the regression mechanism | - | 정적 |
| test/python-source.test.mjs | 46 | - | SOURCE-03 exact body, literal argv, module contract and EOF stdin support scratch change and recovery | - | 정적 |
| test/python-source.test.mjs | 57 | - | SOURCE-04 complete bytes without EOF remain gated and then execute once after EOF | - | 정적 |
| test/python-source.test.mjs | 73 | - | SOURCE-05 public manifest is flat and source-free, private input immutable, every binding changes plan digest | - | 정적 |
| test/python-source.test.mjs | 87 | - | SOURCE-06 bounded validated source/arguments/binding and literal shell quoting | - | 정적 |
| test/read-command-refusals.test.mjs | 54 | - | READ-REFUSAL-01 unified command admission keeps non-read commands pending without self-approval | - | 정적 |
| test/read-command-refusals.test.mjs | 63 | - | READ-REFUSAL-02 maintenance refuses before execution and leaves admission usable after release | - | 정적 |
| test/read-command-refusals.test.mjs | 71 | - | READ-REFUSAL-03 admission audit failure is private and never starts an operation | - | 정적 |
| test/read-command-refusals.test.mjs | 77 | - | READ-REFUSAL-04 malformed commands, target and classifier errors never expose private exception details | - | 정적 |
| test/read-command-refusals.test.mjs | 85 | - | READ-REFUSAL-05 completed and neutral command failure expose references and explicit bounded output only | - | 정적 |
| test/read-command-refusals.test.mjs | 98 | - | READ-REFUSAL-06 failed start guard releases execution capacity and a later operation can complete | - | 정적 |
| test/read-command-refusals.test.mjs | 107 | - | READ-REFUSAL-07 uncertain executor outcome is observed by the same key without replay | - | 정적 |
| test/release-version.test.mjs | 9 | - | the installer release-id helper derives version and identity from its actual source package | - | 정적 |
| test/release-version.test.mjs | 25 | - | Docker defaults and delivery instructions match the current package version | - | 정적 |
| test/remote-mcp-upload.test.mjs | 72 | - | REMOTE-JSON schemas expose strict model tools without Apps or private upload tickets | - | 정적 |
| test/remote-mcp-upload.test.mjs | 95 | - | REMOTE-JSON real binary and empty uploads bind bytes and target without effects before owner approval | - | 정적 |
| test/remote-mcp-upload.test.mjs | 128 | - | REMOTE-JSON missing binding invalid metadata and extra authority allocate nothing | - | 정적 |
| test/remote-mcp-upload.test.mjs | 144 | - | REMOTE-JSON canonical chunk bounds duplicate ACK and rejected sequence preserve staged bytes | - | 정적 |
| test/remote-mcp-upload.test.mjs | 162 | - | REMOTE-JSON incomplete and hash-mismatched finishes create no upload job | - | 정적 |
| test/remote-mcp-upload.test.mjs | 176 | - | REMOTE-JSON simultaneous finish and lost reply recover one immutable request through status | - | 정적 |
| test/remote-mcp-upload.test.mjs | 186 | - | REMOTE-JSON ready upload recovers one request while UI artifacts and stale targets cannot enter the JSON path | - | 정적 |
| test/remote-mcp-upload.test.mjs | 209 | - | REMOTE-JSON authentication and opaque public failures never echo bytes or allocate uploads | - | 정적 |
| test/remote-mcp-upload.test.mjs | 220 | - | REMOTE-JSON real service and artifact clock report expiry without writing or submitting | - | 정적 |
| test/request-admission.test.mjs | 13 | - | admission limits have bounded defaults and reject invalid configuration | - | 정적 |
| test/request-admission.test.mjs | 26 | - | bounded FIFO admission never lets a newcomer pass a waiter and release is idempotent | - | 정적 |
| test/request-admission.test.mjs | 47 | - | queued and pre-aborted requests are removed while active cancellation retains its slot | - | 정적 |
| test/request-admission.test.mjs | 68 | - | a granted waiter owns its slot even if aborted before its Promise continuation | - | 정적 |
| test/request-admission.test.mjs | 84 | - | queue timeout removes the waiter without releasing work still owned by another request | - | 정적 |
| test/request-admission.test.mjs | 98 | - | a stalled timer cannot grant an expired waiter when release runs before the timer callback | - | 정적 |
| test/request-admission.test.mjs | 114 | - | detach reserves separate bounded capacity before promoting FIFO work and failure retains active ownership | - | 정적 |
| test/request-admission.test.mjs | 138 | - | close rejects queued and future requests while owners retain and release active and detached slots | - | 정적 |
| test/request-admission.test.mjs | 159 | - | zero queued and detached capacity rejects immediately without changing active ownership | - | 정적 |
| test/request-capacity.test.mjs | 15 | - | request capacity defaults to 100 and accepts canonical positive safe integers | - | 정적 |
| test/request-capacity.test.mjs | 26 | - | application wiring applies the configured capacity independently to legacy and every explicit target | - | 정적 |
| test/request-capacity.test.mjs | 47 | - | default saturation refuses before allocating an ID and preserves all 100 terminal requests | - | 정적 |
| test/request-capacity.test.mjs | 60 | - | custom capacity stays bounded, retains terminal output for one hour and never reaps running work | - | 정적 |
| test/request-capacity.test.mjs | 79 | - | larger request capacity preserves configured serialization in the common durable scheduler | - | 정적 |
| test/request-safety-http.test.mjs | 54 | - | authenticated MCP evaluates only with owner disclosure policy and observation leaves approval pending | - | 정적 |
| test/request-safety.test.mjs | 13 | - | request assessment freezes server identity and shares an in-flight result across callers | - | 정적 |
| test/request-safety.test.mjs | 42 | - | provider failure is sanitized, cached and never retried | - | 정적 |
| test/request-safety.test.mjs | 52 | - | process call budget bounds distinct requests and cached reads consume no calls | - | 정적 |
| test/request-safety.test.mjs | 59 | - | disabled observer, unknown ID, file jobs and denied requests never call the assessor | - | 정적 |
| test/request-safety.test.mjs | 69 | - | Jev opt-in and bounded call limit are strict configuration values | - | 정적 |
| test/request-safety.test.mjs | 78 | - | completed requests expose historical provenance and retain the first input without a paid retry | - | 정적 |
| test/retained-history.test.mjs | 28 | - | HIST-OLD 기존 장부의 24시간 초과 명령을 기간으로 찾고 결과 원문을 공개하지 않는다 | - | 정적 |
| test/retained-history.test.mjs | 40 | - | HIST-MERGE 중복 제거 뒤 메모리 현재 상태로 조건을 적용하고 결속 충돌을 거절한다 | - | 정적 |
| test/retained-history.test.mjs | 50 | - | HIST-PAGE 같은 생성시각 41개를 고정 상한과 복합 커서로 한 번씩 방문한다 | - | 정적 |
| test/retained-history.test.mjs | 65 | - | HIST-RANGE 기간은 포함 하한과 제외 상한이며 조건 변경 커서를 거절한다 | - | 정적 |
| test/retained-history.test.mjs | 73 | - | HIST-INPUT 알 수 없는 필드와 중복, 비정규 커서, 검색 상한을 거절한다 | - | 정적 |
| test/retained-history.test.mjs | 82 | - | HIST-TARGET 현재 미등록 대상은 제외하며 변경·사용 중지된 일반 명령은 기록 당시 결속으로 표시한다 | - | 정적 |
| test/retained-history.test.mjs | 95 | - | HIST-CLI 도구 장부는 현재 활성 대상·연결 버전·프로필·공급자 범위를 유지한다 | - | 정적 |
| test/retained-history.test.mjs | 110 | - | HIST-COVERAGE 잘못된 관측 메타데이터를 완전한 이력으로 표시하지 않는다 | - | 정적 |
| test/retained-history.test.mjs | 119 | - | HIST-BYTES 응답 전체 바이트 상한에서 부분 페이지를 반환하고 단일 거대 행을 거절한다 | - | 정적 |
| test/retained-history.test.mjs | 133 | - | HIST-HYDRATE 후보 메타데이터만 순회하고 반환하는 장부 행만 본문으로 읽는다 | - | 정적 |
| test/retained-history.test.mjs | 149 | - | HIST-SQL 기존 명령·도구 장부 조회는 스키마·내용을 바꾸지 않으며 비활성 장부에서도 읽는다 | - | 정적 |
| test/retained-history.test.mjs | 167 | - | HIST-ABSENT  없는 비활성 장부를 만들지 않고 과도한 저장 본문을 읽지 않는다 | - | 정적 |
| test/retained-history.test.mjs | 181 | - | HIST-AUTH 기존 관리자 인증·브라우저 세션·출처를 보존하고 새 문서 경로를 분류한다 | - | 정적 |
| test/retained-history.test.mjs | 218 | - | 'HIST-MEASURE 기존 조회·보관 조회와 동시 승인 응답 계측 '+records | - | 동적 |
| test/rollback-stopped.test.mjs | 6 | - | rollback refuses a stopped installation before replacing files or restarting | - | 정적 |
| test/runtime-capacity-180.test.mjs | 20 | - | runtime capacity persists overrides, inherits globals and shrinks without cancelling existing work | - | 정적 |
| test/runtime-capacity-180.test.mjs | 38 | - | durable capacity CAS rejects stale handles and maintenance, validation and audit failures do not change limits | - | 정적 |
| test/runtime-capacity-180.test.mjs | 64 | - | malformed persisted capacity closes its state port before scheduler application | - | 정적 |
| test/runtime-capacity-180.test.mjs | 74 | - | storage adapter rejects malformed JSON and non-private files without replacing their contents | - | 정적 |
| test/runtime-capacity.test.mjs | 26 | - | administrator overrides persist with CAS and nullable inheritance across restart | - | 정적 |
| test/runtime-capacity.test.mjs | 38 | - | removing a configured target retains its override without blocking startup or changing other targets | - | 정적 |
| test/runtime-capacity.test.mjs | 50 | - | shrinking limits does not mutate active jobs, and malformed settings or maintenance writes do not save | - | 정적 |
| test/safety-http.test.mjs | 15 | - | WIRE-01 temporary server independently enforces route, method, bearer, model, state and Choice keys | - | 정적 |
| test/safety-http.test.mjs | 42 | - | WIRE-02 actual evaluation/adapter/HTTP path preserves 20 cases, usage and simulated provenance | - | 정적 |
| test/safety-http.test.mjs | 57 | - | WIRE-03 fragmented real HTTP response decodes correctly; unknown keys/models/types refuse then recover | - | 정적 |
| test/safety-http.test.mjs | 72 | - | WIRE-04 real HTTP failures are single-attempt and never disclose error bodies | - | 정적 |
| test/safety-http.test.mjs | 81 | - | WIRE-05 actual fetch refuses redirect without contacting the destination | - | 정적 |
| test/safety-http.test.mjs | 89 | - | WIRE-06 real chunked response exceeding 64KiB is unavailable and next request recovers | - | 정적 |
| test/safety-http.test.mjs | 98 | - | `WIRE-07 ${hold} timeout closes real response and permits recovery without queued duplicate` | - | 동적 |
| test/safety.test.mjs | 20 | - | JEV-01 request has fixed route/model/question, no labels or extra secret fields | - | 정적 |
| test/safety.test.mjs | 35 | - | execution sends explicit user approval only for matching owner command names, and registration sends proposals | - | 정적 |
| test/safety.test.mjs | 56 | - | JEV-02 missing key and invalid input cause zero dispatches | - | 정적 |
| test/safety.test.mjs | 64 | - | JEV-03 malformed answer/model/usage never yields an assessed result | - | 정적 |
| test/safety.test.mjs | 81 | - | JEV-04 bounded failures do not echo raw errors, headers or HTTP bodies; no retries | - | 정적 |
| test/safety.test.mjs | 91 | - | JEV-05 response type/bytes/JSON/UTF8 are bounded and validated | - | 정적 |
| test/safety.test.mjs | 101 | - | JEV-06 busy admission is synchronous; caller mutation cannot alter dispatched state | - | 정적 |
| test/safety.test.mjs | 111 | - | JEV-07 fetch timeout is bounded and slot stays claimed until ignored abort settles | - | 정적 |
| test/safety.test.mjs | 122 | - | JEV-08 deadline includes slow response body; cancellation occurs | - | 정적 |
| test/safety.test.mjs | 131 | - | JEV-09 candidate threshold rejects high-risk/low confidence and is never authority | - | 정적 |
| test/safety.test.mjs | 139 | - | EVAL-01 evaluation freezes inputs, hides labels/rationales and contains provider throws | - | 정적 |
| test/safety.test.mjs | 153 | - | EVAL-02 invalid/duplicate/oversized corpus is rejected before dispatch | - | 정적 |
| test/safety.test.mjs | 161 | - | EVAL-03 simulated report preserves deliberate wrong/failed cases and hand-calculated totals | - | 정적 |
| test/safety.test.mjs | 173 | - | EVAL-04 injected transport uses adapter on every case but never claims a real-model evaluation | - | 정적 |
| test/safety.test.mjs | 184 | - | EVAL-05 CLI refuses overwrite and missing key without leaking secrets or making paid calls | - | 정적 |
| test/secret-cli-pty.test.mjs | 6 | - | actual Linux TTY registers, rotates and cancels without echoing synthetic values | - | 정적 |
| test/secret-integration.test.mjs | 52 | - | MCP evaluation resolves injected secrets internally, preserves env compatibility and fails closed | - | 정적 |
| test/secret-io-failures.test.mjs | 24 | - | untrusted writable ancestors are refused before init, read, put and delete | - | 정적 |
| test/secret-io-failures.test.mjs | 45 | - | `pre-commit ${stage} failure preserves old revision and cleans staging files` | - | 동적 |
| test/secret-io-failures.test.mjs | 61 | - | `post-commit directory sync failure during ${action} reports commit_uncertain` | - | 동적 |
| test/secret-io-failures.test.mjs | 74 | - | cleanup errors preserve primary failure and successful commit is reported uncertain | - | 정적 |
| test/secret-io-failures.test.mjs | 91 | - | lock cleanup failure cannot mask post-commit uncertainty | - | 정적 |
| test/secret-io-failures.test.mjs | 103 | - | killed staged writer preserves old complete record and stale lock blocks later writes | - | 정적 |
| test/secret-service.test.mjs | 9 | - | secret references select a provider without leaking filesystem or vendor assumptions | - | 정적 |
| test/secret-service.test.mjs | 19 | - | hidden input emits only prompt/newline and restores terminal state on success and cancellation | - | 정적 |
| test/secret-service.test.mjs | 42 | - | actual CLI rejects piped secret bytes and value arguments without echoing them | - | 정적 |
| test/secrets.test.mjs | 7 | - | Compose secret files bind into server settings without shell evaluation or public payload | - | 정적 |
| test/shutdown.test.mjs | 26 | - | shutdown bounds an unfinished HTTP body without waiting for the client to finish | - | 정적 |
| test/shutdown.test.mjs | 43 | - | shutdown lets a valid in-flight response finish within the grace period | - | 정적 |
| test/solid-architecture.test.mjs | 38 | - | ARCH-01 domain/application dependencies point inward and never expose host DTOs or store writes | - | 정적 |
| test/solid-architecture.test.mjs | 46 | - | ARCH-IMPORT 일반 from 문자열은 무시하고 실제 정적·동적 외부 의존은 거절한다 | - | 정적 |
| test/solid-architecture.test.mjs | 70 | - | PORT-01 stream and async-iterator FileSource substitutes preserve approval and byte contracts | - | 정적 |
| test/solid-architecture.test.mjs | 99 | - | PORT-02 default staging budget reserves eight 64MiB files without allocating their contents | - | 정적 |
| test/solid-regressions.test.mjs | 14 | - | `${id} public-boundary regression` | - | 동적 |
| test/source-automation.test.mjs | 66 | - | SOURCE-PRODUCT-01 exact source reaches the real Jev HTTP adapter via MCP, then the identical bound executor, without public or durable body copies | - | 정적 |
| test/source-automation.test.mjs | 101 | - | SOURCE-PRODUCT-02 source opt-in is independent of approved python/sudo names and disclosure; no model or execution before consent | - | 정적 |
| test/source-automation.test.mjs | 114 | - | SOURCE-PRODUCT-03 constrained sudo and deny policies are not silently bypassed by arbitrary code | - | 정적 |
| test/source-automation.test.mjs | 124 | - | SOURCE-PRODUCT-04 protected pending source review is exact/no-store, unauthenticated and MCP tokens cannot read it, owner approval releases it | - | 정적 |
| test/source-automation.test.mjs | 138 | - | SOURCE-PRODUCT-05 source probability threshold remains per user, unfavorable valid answers are never retried through fallback | - | 정적 |
| test/source-automation.test.mjs | 148 | - | SOURCE-PRODUCT-06 key conflicts bind body, argv, cwd, elevation and context; restart never restores private body or replays execution | - | 정적 |
| test/source-automation.test.mjs | 159 | - | SOURCE-PRODUCT-07 async evaluation policy changes withhold dispatch and async connection verification refuses a revoked grant | - | 정적 |
| test/source-automation.test.mjs | 179 | - | SOURCE-PRODUCT-08 transport ambiguity is unknown and stable request key never replays | - | 정적 |
| test/source-automation.test.mjs | 187 | - | SOURCE-PRODUCT-09 reject credentials/arguments/cwd before admission and keep bounded source evidence complete | - | 정적 |
| test/source-automation.test.mjs | 200 | - | SOURCE-PRODUCT-15 sensitive-path guard lists in a 12712-byte source reach the exact bound evaluator and executor | - | 정적 |
| test/source-automation.test.mjs | 223 | - | SOURCE-PRODUCT-10 denial/expiry release the shared byte budget; absent runtime capability fails before admission | - | 정적 |
| test/source-automation.test.mjs | 236 | - | SOURCE-PRODUCT-11 admission journal failures and terminal persistence failures release private source | - | 정적 |
| test/source-automation.test.mjs | 249 | - | SOURCE-PRODUCT-12 owner revocation during unavailable primary prevents fallback disclosure | - | 정적 |
| test/source-automation.test.mjs | 303 | - | SOURCE-PRODUCT-13 fresh pinned SSH channel rechecks actual owner policy and target after connection wait | - | 정적 |
| test/source-automation.test.mjs | 331 | - | SOURCE-PRODUCT-14 source request keys cannot collide with a legacy string equal to its public plan digest | - | 정적 |
| test/source-automation.test.mjs | 346 | - | test server executes source without disclosure, model, source opt-in or sudo opt-in and revocation restores review | - | 정적 |
| test/source-automation.test.mjs | 359 | - | test server source retains its private plan while queued and executes exact bytes once | - | 정적 |
| test/source-input-refusals.test.mjs | 76 | - | SOURCE-REFUSAL-01 실제 MCP는 가짜 인증정보와 공개 합성값을 안전 사유로 거부한다 | - | 정적 |
| test/source-input-refusals.test.mjs | 96 | - | SOURCE-REFUSAL-02 인수와 작업 경로의 인증정보·민감 경로 사유를 구별한다 | - | 정적 |
| test/source-input-refusals.test.mjs | 114 | - | SOURCE-REFUSAL-03 내부 오류 코드는 기존 메시지와 source→argv→cwd 우선순위를 보존한다 | - | 정적 |
| test/source-input-refusals.test.mjs | 129 | - | SOURCE-REFUSAL-04 TEST 우회도 세 입력 거부를 건너뛰지 않는다 | - | 정적 |
| test/source-input-refusals.test.mjs | 142 | - | SOURCE-REFUSAL-05 정상 원문과 유사 문자열 및 원문 민감 경로 설명을 침범하지 않는다 | - | 정적 |
| test/source-input-refusals.test.mjs | 154 | - | SOURCE-REFUSAL-06 기존 context 사유와 일반 예외 비반사를 유지한다 | - | 정적 |
| test/source-input-refusals.test.mjs | 175 | - | SOURCE-REFUSAL-07 public secret references retain source bytes and the normal approval boundary | - | 정적 |
| test/source-input-refusals.test.mjs | 189 | - | SOURCE-REFUSAL-08 references never conceal later credentials or skip source admission guards | - | 정적 |
| test/source-linux-runtime.mjs | 32 | - | SOURCE-LINUX-01 actual MCP/app/OpenSSH/POSIX source contract and privilege/replay boundaries | - | 정적 |
| test/ssh-connection-lifecycle.test.mjs | 102 | - | `SSH-RECOVER ${port}: exhausted opening fails once; a later request uses a fresh client` | - | 동적 |
| test/ssh-connection-lifecycle.test.mjs | 116 | - | `SSH-RECOVER ${port}: uncertain opening has one attempt and preserves the transport` | - | 동적 |
| test/ssh-connection-lifecycle.test.mjs | 128 | - | SSH-RECOVER transient opening failure and remote nonzero do not discard the connection | - | 정적 |
| test/ssh-connection-lifecycle.test.mjs | 142 | - | SSH-RECOVER a successful SFTP open followed by a file error does not discard | - | 정적 |
| test/ssh-connection-lifecycle.test.mjs | 151 | - | SSH-RECOVER live work blocks retirement; its completion permits future recovery | - | 정적 |
| test/ssh-connection-lifecycle.test.mjs | 165 | - | SSH-RECOVER opening callback still pending after timeout prevents destroying its client | - | 정적 |
| test/ssh-connection-lifecycle.test.mjs | 180 | - | SSH-RECOVER original cleanup client is never replaced by a fresh connection | - | 정적 |
| test/ssh-connection-lifecycle.test.mjs | 192 | - | SSH-RECOVER ProxyJump reconstruction stays in registry and concurrent successors close once | - | 정적 |
| test/ssh-connection-lifecycle.test.mjs | 201 | - | SSH-RECOVER a delayed close never ends a replacement client | - | 정적 |
| test/ssh-supervisor.test.mjs | 21 | - | owned execution preserves streaming UTF-8 bytes, stderr, exit and exact cursors | - | 정적 |
| test/ssh-supervisor.test.mjs | 34 | - | deadline keeps partial output and waits for close after a stop request | - | 정적 |
| test/ssh-supervisor.test.mjs | 48 | - | cancel is distinct from deadline and does not claim that a signal killed the process | - | 정적 |
| test/ssh-supervisor.test.mjs | 59 | - | already cancelled work never dispatches | - | 정적 |
| test/ssh-supervisor.test.mjs | 65 | - | pinned ssh2 channel signal crosses stdin EOF on the exact channel and waits for remote exit and cleanup | - | 정적 |
| test/ssh-supervisor.test.mjs | 97 | - | signal port refuses foreign channels or unsupported internals instead of touching another transport | - | 정적 |
| test/ssh-supervisor.test.mjs | 107 | - | unsupported signal delivery remains explicit and never claims termination | - | 정적 |
| test/ssh-supervisor.test.mjs | 116 | - | transport loss preserves bytes and remains unknown even after local cleanup | - | 정적 |
| test/ssh-supervisor.test.mjs | 125 | - | late channel callback is stopped without another dispatch | - | 정적 |
| test/ssh-supervisor.test.mjs | 132 | - | refused open is not dispatched; uncertain errors are never replayed | - | 정적 |
| test/ssh-supervisor.test.mjs | 140 | - | byte retention is bounded for both streams and truncation is explicit | - | 정적 |
| test/ssh-supervisor.test.mjs | 151 | - | sink failure and a stalled sink are bounded without erasing captured output | - | 정적 |
| test/ssh-supervisor.test.mjs | 161 | - | `settlement drains a paused SSH readable after ${reason}; sink failure=${sinkFails}` | - | 동적 |
| test/ssh-supervisor.test.mjs | 193 | - | write failure is typed and keeps the channel slot through cleanup | - | 정적 |
| test/ssh-supervisor.test.mjs | 200 | - | exit without close has bounded cleanup and preserves exit evidence | - | 정적 |
| test/ssh-supervisor.test.mjs | 208 | - | source uses the owned channel port and rejects a stdin override before acquisition | - | 정적 |
| test/ssh-supervisor.test.mjs | 223 | - | desktop forward cancellation closes only its channel and tracks exact endpoint | - | 정적 |
| test/terminal-restore.test.mjs | 40 | - | startup restores terminal command history without rewriting operation versions, events, legacy bodies or audits | - | 정적 |
| test/terminal-restore.test.mjs | 60 | - | live completion still persists and audits once and notifies, resolves and cleans up once | - | 정적 |
| test/terminal-restore.test.mjs | 81 | - | startup terminal upload releases its artifact once while leaving its history and audit unchanged | - | 정적 |
| test/test-mode-file-path-policy.test.mjs | 57 | - | TM-PATH-01 기본 정책과 위조한 operation 필드는 root 우회 권한을 만들지 않는다 | - | 정적 |
| test/test-mode-file-path-policy.test.mjs | 74 | - | TM-PATH-02 서버 정책의 명시적 true는 파일 변경 전에 helper 호환성을 확인한다 | - | 정적 |
| test/test-mode-file-path-policy.test.mjs | 98 | - | TM-PATH-03 Linux 전송은 Windows root 우회 payload를 받지 않는다 | - | 정적 |
| test/test-mode-file-path-policy.test.mjs | 107 | - | TM-PATH-04 우회 echo가 없거나 다르면 성공 응답도 실패로 처리하고 재시도하지 않는다 | - | 정적 |
| test/test-mode-file-path-policy.test.mjs | 127 | - | TM-PATH-05 root 제한 오류는 검증한 allowedRoot만 공개하고 helper 원문을 버린다 | - | 정적 |
| test/test-mode-file-path-policy.test.mjs | 141 | - | TM-PATH-06 유효하지 않은 allowedRoot는 root 제한 오류에도 공개하지 않는다 | - | 정적 |
| test/test-mode-file-path-policy.test.mjs | 154 | - | TM-PATH-07 우회 모드에서도 SSH 권한 거부는 실패이며 승격과 재시도가 없다 | - | 정적 |
| test/test-mode-file-path-policy.test.mjs | 176 | - | TM-PATH-08 우회 정책은 명시된 승격 의도와 정리 권한을 바꾸지 않는다 | - | 정적 |
| test/test-mode-file-path-policy.test.mjs | 189 | - | TM-PATH-09 연결에 고정한 정리는 helper 정책을 다시 요청하거나 우회하지 않는다 | - | 정적 |
| test/test-mode-file-path-policy.test.mjs | 209 | - | TM-PATH-10 구형 또는 불일치 policy 응답은 SFTP와 publish 및 snapshot 전에 거부한다 | - | 정적 |
| test/test-mode-file-policy-application.test.mjs | 76 | - | TM-APP-01 일반 Windows와 Linux 대상은 경로 정책과 실제 권한 경계를 구분한다 | - | 정적 |
| test/test-mode-file-policy-application.test.mjs | 87 | - | TM-APP-02 활성 testServer 정책과 유효 secret이 함께 있어야 root 우회를 허용한다 | - | 정적 |
| test/test-mode-file-policy-application.test.mjs | 100 | - | TM-APP-03 다른 대상의 testServer 정책이나 위조한 client 필드는 현재 대상에 권한을 주지 않는다 | - | 정적 |
| test/test-mode-file-policy-application.test.mjs | 109 | - | TM-APP-04 오래된 revision 또는 다른 profile 정책은 root 우회를 허용하지 않는다 | - | 정적 |
| test/test-mode-file-policy-application.test.mjs | 117 | - | TM-APP-05 secret 검사 중 정책이 바뀌면 이전 root 우회 권한을 반환하지 않는다 | - | 정적 |
| test/test-mode-file-policy-application.test.mjs | 134 | - | TM-APP-06 SFTP 뒤 secret 철회는 publish를 막고 원래 연결 정리는 유지한다 | - | 정적 |
| test/test-mode-file-policy-application.test.mjs | 159 | - | TM-APP-07 MCP targets 출력은 활성 정책을 strict filePolicy 스키마로 공개한다 | - | 정적 |
| test/test-mode-file-policy-application.test.mjs | 176 | - | TM-APP-08 실제 대상 설정 변경은 policy 조회와 우회 권한을 모두 중단한다 | - | 정적 |
| test/test-server-mode.test.mjs | 5 | - | test server secret checks fail closed, use the existing resolver, and never cache capability | - | 정적 |
| test/transfer-failure.test.mjs | 14 | - | download reservation quota is a typed not-started failure before any SSH effect | - | 정적 |
| test/transfer-failure.test.mjs | 30 | - | failed SSH connection releases reserved download quota and creates no local payload | - | 정적 |
| test/transfer-failure.test.mjs | 42 | - | failed scoped download preserves its original refusal and grants only its owner one completed-cleanup acknowledgement | - | 정적 |
| test/transfer-failure.test.mjs | 111 | - | upload transport streams exact binary and invokes sudo helper with frozen approved metadata, then unprivileged cleanup | - | 정적 |
| test/transfer-failure.test.mjs | 127 | - | upload failure makes one attempt, never publishes and still attempts cleanup | - | 정적 |
| test/transfer-failure.test.mjs | 141 | - | download transport chooses privilege profile, retains exact binary and returns neutral metadata | - | 정적 |
| test/transfer-failure.test.mjs | 157 | - | download transfer and hash failures clean local quota and attempt remote cleanup without retry | - | 정적 |
| test/transfer-failure.test.mjs | 168 | - | missing remote parent keeps safe guidance after confirmed cleanup while cleanup loss stays unknown without replay | - | 정적 |
| test/transfer-failure.test.mjs | 199 | - | known helper failure codes preserve download failure, quota release and cleanup without retry | - | 정적 |
| test/transfer-failure.test.mjs | 212 | - | legacy, unknown, malformed and signalled helper errors expose only the fixed fallback | - | 정적 |
| test/transfer-failure.test.mjs | 264 | - | WRITER-DIAG-01 정책 원점은 명시한 bounded reason만 보존하고 승격·재시도하지 않는다 | - | 정적 |
| test/transfer-failure.test.mjs | 274 | - | WRITER-DIAG-02 OS 원점은 검증한 단계와 정수만 공개하고 queue 실패를 유지한다 | - | 정적 |
| test/transfer-failure.test.mjs | 303 | - | WRITER-DIAG-03 누락·위조·부분 진단은 추론 없이 전체 제외한다 | - | 정적 |
| test/transfer-failure.test.mjs | 319 | - | WRITER-DIAG-04 진단은 Windows의 정상 helper 실패 protocol에서만 수용한다 | - | 정적 |
| test/ui-bundle.test.mjs | 8 | - | packaged UI inline module remains valid JavaScript after HTML embedding | - | 정적 |
| test/ui-bundle.test.mjs | 23 | - | web bundle is standalone JavaScript for the existing script route | - | 정적 |
| test/vault-kv.test.mjs | 6 | - | Vault configuration pins HTTPS origin, flat mount and local-only token reference | - | 정적 |
| test/vault-kv.test.mjs | 18 | - | Vault port rejects unsafe names, invalid tokens and mutations without connecting | - | 정적 |
| test/version-check.test.mjs | 32 | - | V01 semver parser and comparator handle v-prefixes and prerelease tags | - | 정적 |
| test/version-check.test.mjs | 42 | - | V02 portal release checker detects update_available, up_to_date, ahead, and caches results with cooldown | - | 정적 |
| test/version-check.test.mjs | 90 | - | V03 network failure or non-200 response degrades gracefully to unavailable | - | 정적 |
| test/version-check.test.mjs | 101 | - | V04 GET /api/version requires admin auth and returns release status | - | 정적 |
| test/web-session.test.mjs | 69 | - | GET deadline and supersession settle even if transport ignores abort; POST remains single and untimed | - | 정적 |
| test/web-session.test.mjs | 79 | - | initial/transient read failures recover by polling, authorization denial stops it and POST is never retried | - | 정적 |
| test/web-session.test.mjs | 90 | - | lost approval observation keeps unknown state until the fixed request is reconciled | - | 정적 |
| test/web-session.test.mjs | 99 | - | approval requests async acceptance, releases the decision lock before refresh and retires an older snapshot | - | 정적 |
| test/web-session.test.mjs | 118 | - | English web labels, ten-second automatic timer and immediate manual/action refresh | - | 정적 |
| test/web-session.test.mjs | 129 | - | Korean browser language preserves Korean UI; other locales fall back to English | - | 정적 |
| test/web-session.test.mjs | 135 | - | decision refresh survives an in-flight automatic GET without waiting for the next ten-second tick | - | 정적 |
| test/web-session.test.mjs | 150 | - | manual Enter refresh is preserved behind an in-flight automatic GET | - | 정적 |
| test/web-session.test.mjs | 156 | - | Access browser connects automatically, hides token input and sends no bearer credential | - | 정적 |
| test/web-session.test.mjs | 164 | - | Access logout is localized, clears requests, stops polling and navigates without credentials | - | 정적 |
| test/web-session.test.mjs | 180 | - | token logout forgets the entered credential and resets the page without revoking server tokens | - | 정적 |
| test/web-session.test.mjs | 190 | - | late download POST cannot navigate away from logout or restore requests | - | 정적 |
| test/web-session.test.mjs | 205 | - | unrelated request changes preserve existing nodes, selected history detail and output state | - | 정적 |
| test/web-session.test.mjs | 229 | - | administrator logout waits for bootstrap and never sends a global logout request | - | 정적 |
| test/web-session.test.mjs | 234 | - | administrator logout response loss stays unconfirmed until explicit idempotent retry | - | 정적 |
| test/web-session.test.mjs | 248 | - | `bootstrap ${failure} failure exposes explicit administrator reconnect` | - | 동적 |
| test/windows-agent-cli-helper.test.mjs | 6 | - | Windows CLI helper의 ACL, 원자적 상태, 출력 제한과 비밀 제거 | - | 정적 |
| test/windows-agent-cli-smoke.test.mjs | 63 | - | 고정 공식 npm 패키지를 격리 Windows SSH 계정에 설치하고 버전·상태를 확인한다 | - | 정적 |
| test/windows-agent-cli.test.mjs | 11 | - | CLI 의도 해시는 expected를 expires 앞에 둔 고정 JSON과 LF에 결속된다 | - | 정적 |
| test/windows-agent-cli.test.mjs | 16 | - | Windows 고정 CLI 계획은 Python 없이 전체 인수와 소스에 결속된다 | - | 정적 |
| test/windows-agent-cli.test.mjs | 24 | - | Windows 로그인 진단도 고정 helper와 7개 인수만 허용한다 | - | 정적 |
| test/windows-agent-cli.test.mjs | 29 | - | Windows CLI의 모든 계획은 원문·수신기 해시와 시작 명령 상한에 결속된다 | - | 정적 |
| test/windows-agent-cli.test.mjs | 44 | - | Windows 응답 유실 뒤에는 기존 intent의 읽기 전용 상태 계획을 만든다 | - | 정적 |
| test/windows-agent-cli.test.mjs | 53 | - | Windows 외부 실행 파일 경로를 투영하고 UNC/상대경로/비밀 출력은 거부한다 | - | 정적 |
| test/windows-command-execution.test.mjs | 8 | - | all Windows command catch paths report the original ErrorRecord and source position | - | 정적 |
| test/windows-command-execution.test.mjs | 22 | - | CLIXML progress noise is removed from presentation while stderr remains caller-owned | - | 정적 |
| test/windows-command-line.test.mjs | 22 | - | WIN-STDIN 최대 32KiB 원문은 짧은 수신기의 길이·해시에 결속되고 본문으로 전송된다 | - | 정적 |
| test/windows-command-line.test.mjs | 44 | - | WIN-EOF 표준입력은 실제 파이프 종료만 EOF로 취급하고 준비 범위를 격리한다 | - | 정적 |
| test/windows-command-line.test.mjs | 64 | - | WIN-EOF 실제 0바이트 쓰기는 건너뛰고 뒤따르는 바이트와 파이프 종료를 구분한다 | - | 정적 |
| test/windows-command-line.test.mjs | 195 | - | WIN-LIMIT 다양한 512바이트 경로와 32KiB 원문도 8000자 시작 명령 안에 든다 | - | 정적 |
| test/windows-command-line.test.mjs | 215 | - | WIN-WORKDIR 관리자 경로를 데이터로 결속하고 읽기 전용 모듈 고정을 보존한다 | - | 정적 |
| test/windows-command-line.test.mjs | 232 | - | SEC-WIN-001 관리자 경로의 일반·곡선 작은따옴표와 곡선 큰따옴표를 코드로 삽입하지 않는다 | - | 정적 |
| test/windows-command-line.test.mjs | 245 | - | WIN-NAMES 정적인 전체 명령 이름과 리터럴 인수만 인식하고 Windows 대소문자를 정규화한다 | - | 정적 |
| test/windows-command-line.test.mjs | 274 | - | WIN-CAPABILITIES Windows source는 관리자 인터프리터 설정에만 의존한다 | - | 정적 |
| test/windows-command-line.test.mjs | 281 | - | SEC-WIN-001 곡선 따옴표는 원문을 보존하면서 이름 승인 전체를 포기한다 | - | 정적 |
| test/windows-dispatch-binding.test.mjs | 165 | - | DISPATCH-BIND 비TEST 연결 대기 중 변경은 실제 exec/SFTP/helper 효과를 차단한다 | - | 정적 |
| test/windows-dispatch-binding.test.mjs | 198 | - | DISPATCH-BIND 마지막 await 뒤의 대상·만료·유지보수 변경도 getClient 전에 거부한다 | - | 정적 |
| test/windows-dispatch-binding.test.mjs | 213 | - | DISPATCH-BIND TEST 비밀 확인의 await 도중 정책·대상 변경도 미실행한다 | - | 정적 |
| test/windows-dispatch-binding.test.mjs | 224 | - | DISPATCH-BIND 큐 없는 읽기와 기존 수동 파일 승인은 유지한다 | - | 정적 |
| test/windows-dispatch-binding.test.mjs | 235 | - | DISPATCH-BIND 원격 효과 뒤 응답 유실은 자동 재실행하지 않는다 | - | 정적 |
| test/windows-dispatch-binding.test.mjs | 245 | - | DISPATCH-CLEANUP 부분 전송 뒤 승인 철회는 게시·수신을 막고 자기 part만 정리한다 | - | 정적 |
| test/windows-dispatch-binding.test.mjs | 270 | - | DISPATCH-CLEANUP 원래 대상·연결이 달라지면 삭제하지 않고 잔존 확인 필요를 남긴다 | - | 정적 |
| test/windows-dispatch-binding.test.mjs | 301 | - | DISPATCH-CLEANUP 본 작업 뒤 정리 응답이 거부·불완전이면 성공을 단정하지 않는다 | - | 정적 |
| test/windows-dispatch-binding.test.mjs | 317 | - | DISPATCH-CLEANUP 파일 헬퍼 효과 뒤 응답 유실은 정리 효과가 있어도 unknown을 보존한다 | - | 정적 |
| test/windows-file-contracts.test.mjs | 21 | - | Windows 경로는 두 구분자를 허용하고 위험한 경로를 거부한다 | - | 정적 |
| test/windows-file-contracts.test.mjs | 38 | - | 기존 POSIX 경로 문법과 기본 basename 동작을 보존한다 | - | 정적 |
| test/windows-file-contracts.test.mjs | 49 | - | 클라이언트 기대값과 전달 명세는 Windows 경로와 기존 결속 필드를 수용한다 | - | 정적 |
| test/windows-file-contracts.test.mjs | 60 | - | 공유 저장소는 두 대상 문법을 받아들이고 메타데이터와 결속을 보존한다 | - | 정적 |
| test/windows-file-contracts.test.mjs | 82 | - | 파일 서비스는 대상 문법을 검사하고 Windows 관리자 토큰 요청을 보존한다 | - | 정적 |
| test/windows-file-contracts.test.mjs | 110 | - | Windows 전송은 고정 명령과 JSON으로 바이트를 왕복하고 정리한다 | - | 정적 |
| test/windows-file-contracts.test.mjs | 148 | - | Windows 전송은 대상 문법·실행 경로 삽입을 연결 전에 거부한다 | - | 정적 |
| test/windows-file-contracts.test.mjs | 165 | - | Windows 관리자 토큰 확인을 업로드 전에 요구하고 승인된 특권 의도를 유지한다 | - | 정적 |
| test/windows-full-application.test.mjs | 19 | - | Windows 런타임 설정은 대상 revision에 결속되고 TTY·POSIX 작업 폴더를 거부한다 | - | 정적 |
| test/windows-full-application.test.mjs | 31 | - | Windows 정책의 명령 이름은 플랫폼을 명시하고 정규화 중복을 거부한다 | - | 정적 |
| test/windows-full-application.test.mjs | 39 | - | Windows source와 CLI 고정 계획은 같은 SSH 검증 경계를 통과하고 변조 시 미실행한다 | - | 정적 |
| test/windows-full-application.test.mjs | 70 | - | Windows app는 명시 Python 경로로 승인된 source를 실행하고 CLI를 Python 설정과 분리한다 | - | 정적 |
| test/windows-jev-contract.test.mjs | 25 | - | WIN-JEV-NAMES Windows 이름 승인과 전체 명령 평가가 같은 문법·대소문자 계약을 사용한다 | - | 정적 |
| test/windows-jev-contract.test.mjs | 50 | - | WIN-JEV-BOUND 서버 옵션만 Windows 문법을 선택하며 Linux payload와 승인 문장은 보존한다 | - | 정적 |
| test/windows-jev-contract.test.mjs | 66 | - | WIN-JEV-APP 등록·실행·관측이 실제 target 플랫폼에 결속되고 플랫폼 위조 등록을 거부한다 | - | 정적 |
| test/windows-python-source.test.mjs | 48 | - | Windows source binds its exact runtime, bytes, environment, argv and administrator-token requirement | - | 정적 |
| test/windows-python-source.test.mjs | 94 | - | Windows source rejects ambiguous runtime/platform, invalid input and command overflow; source and helper bounds remain separate | - | 정적 |
| test/windows-python-source.test.mjs | 180 | - | Windows PowerShell 5.1 forwards source bytes and literal arguments without BOM or newline transformation | - | 정적 |
| test/windows-python-source.test.mjs | 231 | - | Windows source rejects truncated, altered and trailing bytes before effects and waits for EOF | - | 정적 |
| test/windows-python-source.test.mjs | 266 | - | 실제 Windows SSH의 Python 실행·비관리자 상승 거부·전송 전 승인·원문 무결성 | - | 정적 |
| test/windows-ssh-integration.test.mjs | 26 | - | 실제 Windows SSH 명령·승인·파일 전송 경계 | - | 정적 |
| test/windows-target.test.mjs | 29 | - | WIN-CONFIG 기존 Linux revision을 보존하고 명시 플랫폼과 Windows workdir를 검증한다 | - | 정적 |
| test/windows-target.test.mjs | 63 | - | WIN-ENCODE UTF-16LE 래퍼가 원문과 셸 특수문자를 보존하고 제어문자를 거부한다 | - | 정적 |
| test/windows-target.test.mjs | 77 | - | WIN-BOUND ASCII·한글·이모지 모두 실제 인코딩 명령 8000자 경계를 적용하고 자르지 않는다 | - | 정적 |
| test/windows-target.test.mjs | 93 | - | WIN-CLASSIFY POSIX 분류를 우회하지 않고 모듈 한정 무인수 읽기 두 개만 허용한다 | - | 정적 |
| test/windows-target.test.mjs | 155 | - | WIN-APP safe 명령은 소유자 승인을 거치고 원문·출력 수명과 실제 래퍼를 보존한다 | - | 정적 |
| test/windows-target.test.mjs | 186 | - | WIN-POLICY 불명확한 이름은 전체 평가하고 리터럴 이름 승인·플랫폼 문맥·대소문자 거부를 적용한다 | - | 정적 |
| test/windows-target.test.mjs | 215 | - | WIN-CAPABILITY Windows CLI·이름승인·승격파일을 표시하고 source는 명시적 Python 없이 TEST에서도 거부한다 | - | 정적 |

## 사례 표 (파이썬 test/test_*.py, 파일 경로 오름차순 · 줄 오름차순)

describe 묶음 열은 `unittest.TestCase` 하위 클래스 이름이다. 이름은 `def test_*` 함수 이름 원문이다. 파이썬 사례는 모두 정적이다.

| 파일 | 줄 | describe 묶음 | 사례 이름(원문) | 결함 번호 | 동적 여부 |
|---|---|---|---|---|---|
| test/test_agent_cli.py | 69 | AgentCli | test_non_root_fixed_provider_and_home_boundary | - | 정적 |
| test/test_agent_cli.py | 73 | AgentCli | test_success_and_exact_completed_request_replay | - | 정적 |
| test/test_agent_cli.py | 77 | AgentCli | test_same_version_new_request_reuses_verified_install | - | 정적 |
| test/test_agent_cli.py | 80 | AgentCli | test_managed_same_version_never_reuses_a_different_release_integrity | - | 정적 |
| test/test_agent_cli.py | 84 | AgentCli | test_two_providers_have_separate_versions_and_commands | - | 정적 |
| test/test_agent_cli.py | 89 | AgentCli | test_update_preserves_previous_version_and_credentials | - | 정적 |
| test/test_agent_cli.py | 96 | AgentCli | test_failed_download_and_integrity_never_invoke_npm | - | 정적 |
| test/test_agent_cli.py | 101 | AgentCli | test_npm_version_and_escape_failures_preserve_existing_active | - | 정적 |
| test/test_agent_cli.py | 107 | AgentCli | test_storage_keeps_only_receipts_and_active_plus_prior_version | - | 정적 |
| test/test_agent_cli.py | 117 | AgentCli | test_cleanup_failures_are_recorded_in_receipt_and_status_without_cascading_enotempty | - | 정적 |
| test/test_agent_cli.py | 149 | AgentCli | test_stale_snapshot_conflicting_payload_and_expiry | - | 정적 |
| test/test_agent_cli.py | 154 | AgentCli | test_invalid_integrity_and_identifiers | - | 정적 |
| test/test_agent_cli.py | 160 | AgentCli | test_symlink_parent_and_current_never_escape_managed_tree | - | 정적 |
| test/test_agent_cli.py | 166 | AgentCli | test_hardlinked_lock_refuses_install | - | 정적 |
| test/test_agent_cli.py | 169 | AgentCli | test_receipt_extra_fields_and_symlinks_are_not_returned | - | 정적 |
| test/test_agent_cli.py | 175 | AgentCli | test_child_environment_does_not_inherit_credentials | - | 정적 |
| test/test_agent_cli.py | 180 | AgentCli | test_version_probe_uses_bundled_node_path_without_credentials | - | 정적 |
| test/test_agent_cli.py | 189 | AgentCli | test_npm_uses_distinct_private_empty_config_files | - | 정적 |
| test/test_agent_cli.py | 200 | AgentCli | test_foreign_install_is_reused_but_not_overwritten | - | 정적 |
| test/test_agent_cli.py | 206 | AgentCli | test_foreign_different_versions_install_side_by_side_both_providers | - | 정적 |
| test/test_agent_cli.py | 214 | AgentCli | test_foreign_install_failures_preserve_original_binary_and_auth | - | 정적 |
| test/test_agent_cli.py | 220 | AgentCli | test_foreign_drift_during_install_is_preserved_without_publishing | - | 정적 |
| test/test_agent_cli.py | 227 | AgentCli | test_completion_receipt_failure_restores_previous_managed_link | - | 정적 |
| test/test_agent_cli.py | 234 | AgentCli | test_first_managed_receipt_failure_restores_external_installation | - | 정적 |
| test/test_agent_cli.py | 241 | AgentCli | test_rollback_preserves_a_replacement_current_link | - | 정적 |
| test/test_agent_cli.py | 249 | AgentCli | test_foreign_update_requires_an_explicit_separate_install | - | 정적 |
| test/test_agent_cli.py | 253 | AgentCli | test_real_process_claim_has_one_winner | - | 정적 |
| test/test_agent_cli.py | 268 | AgentCli | test_killed_worker_is_unknown_and_never_reexecuted | - | 정적 |
| test/test_agent_cli.py | 280 | AgentCli | test_install_deadline_interrupts_slow_download_before_npm | - | 정적 |
| test/test_agent_cli.py | 289 | AgentCli | test_install_deadline_preserves_prior_version_and_auth | - | 정적 |
| test/test_agent_cli.py | 298 | AgentCli | test_success_restores_private_timer_and_handler | - | 정적 |
| test/test_agent_cli.py | 301 | AgentCli | test_existing_process_timer_is_not_stolen | - | 정적 |
| test/test_agent_cli.py | 308 | AgentCli | test_npm_wait_interruption_kills_and_reaps_only_owned_live_group | - | 정적 |
| test/test_agent_cli.py | 351 | ForeignProbeBoundary | test_untrusted_foreign_directory_never_executes | - | 정적 |
| test/test_agent_cli.py | 352 | ForeignProbeBoundary | test_untrusted_foreign_executable_never_executes | - | 정적 |
| test/test_agent_cli.py | 353 | ForeignProbeBoundary | test_untrusted_resolved_native_directory_never_executes | - | 정적 |
| test/test_agent_cli.py | 354 | ForeignProbeBoundary | test_trusted_owned_native_symlink_and_auth_are_preserved | - | 정적 |
| test/test_agent_cli.py | 444 | AckReceiptBoundary | test_postreplace_completed_and_failed_precommit_keep_actual_effect_consistent | - | 정적 |
| test/test_agent_cli.py | 445 | AckReceiptBoundary | test_first_managed_postreplace_preserves_external_install_and_auth | - | 정적 |
| test/test_agent_cli.py | 446 | AckReceiptBoundary | test_completed_postreplace_failure_with_recorded_failure_restores_old_current | - | 정적 |
| test/test_agent_cli.py | 455 | AckReceiptBoundary | test_failed_receipt_postreplace_ack_failure_does_not_claim_rollback | - | 정적 |
| test/test_agent_cli.py | 484 | AckReceiptBoundary | test_worker_termination_immediately_after_rollback_has_no_stale_completion | - | 정적 |
| test/test_agent_cli.py | 485 | AckReceiptBoundary | test_worker_termination_after_failed_receipt_replace_preserves_effect | - | 정적 |
| test/test_agent_cli.py | 486 | AckReceiptBoundary | test_historic_completed_and_reused_survive_later_legitimate_updates | - | 정적 |
| test/test_agent_cli.py | 502 | AckReceiptBoundary | test_foreign_reused_history_survives_later_managed_install | - | 정적 |
| test/test_agent_cli_login.py | 44 | LoginStatusTests | test_unsafe_parent_permissions_are_explained_without_starting_process | - | 정적 |
| test/test_agent_cli_login.py | 58 | LoginStatusTests | test_failure_reasons_are_bounded_and_vendor_output_never_echoes | - | 정적 |
| test/test_agent_cli_login.py | 73 | LoginStatusTests | test_fixed_arguments_actual_home_and_secret_free_environment | - | 정적 |
| test/test_agent_cli_login.py | 84 | LoginStatusTests | test_signed_out_is_distinct_from_vendor_error | - | 정적 |
| test/test_agent_cli_login.py | 94 | LoginStatusTests | test_missing_and_unsafe_executables | - | 정적 |
| test/test_agent_cli_login.py | 102 | LoginStatusTests | test_managed_installation_metadata_and_hash | - | 정적 |
| test/test_agent_cli_login.py | 148 | LoginStatusTests | test_observed_large_claude_is_verified_before_auth_status | - | 정적 |
| test/test_agent_cli_login.py | 161 | LoginStatusTests | test_managed_executable_limit_is_finite_and_inclusive | - | 정적 |
| test/test_agent_cli_login.py | 170 | LoginStatusTests | test_hash_read_rejects_growth_after_stat | - | 정적 |
| test/test_agent_cli_login.py | 185 | LoginStatusTests | test_output_limit_and_timeout_are_bounded_and_reaped | - | 정적 |
| test/test_agent_cli_login.py | 193 | LoginStatusTests | test_main_never_emits_vendor_error_or_account_fields | - | 정적 |
| test/test_cloudflare_api_lifecycle.py | 55 | ApiLifecycle | test_pagination_metadata_and_second_page_errors_never_prove_absence | - | 정적 |
| test/test_cloudflare_api_lifecycle.py | 79 | ApiLifecycle | test_actual_paginated_transport_preserves_unknown_cleanup_intent | - | 정적 |
| test/test_cloudflare_api_lifecycle.py | 114 | ApiLifecycle | test_foreign_app_on_second_page_blocks_initial_cleanup_delete | - | 정적 |
| test/test_cloudflare_api_lifecycle.py | 130 | ApiLifecycle | test_portal_discovery_reads_the_second_page_before_create_or_adoption | - | 정적 |
| test/test_cloudflare_api_lifecycle.py | 154 | ApiLifecycle | test_later_page_target_cannot_be_reported_as_deleted | - | 정적 |
| test/test_cloudflare_api_lifecycle.py | 177 | ApiLifecycle | test_portal_without_derived_app_creates_explicit_owner_oauth_app | - | 정적 |
| test/test_cloudflare_api_lifecycle.py | 191 | ApiLifecycle | test_successful_portal_is_durable_before_discovery_failure | - | 정적 |
| test/test_cloudflare_api_lifecycle.py | 207 | ApiLifecycle | test_definite_failure_at_every_explicit_write_preserves_cleanup | - | 정적 |
| test/test_cloudflare_api_lifecycle.py | 220 | ApiLifecycle | test_uncertain_delete_resolves_once_only_after_terminal_reads | - | 정적 |
| test/test_cloudflare_api_lifecycle.py | 235 | ApiLifecycle | test_failed_terminal_read_preserves_original_uncertainty | - | 정적 |
| test/test_cloudflare_api_lifecycle.py | 271 | ApiLifecycle | test_uncertain_explicit_app_creation_is_not_replayed_or_deleted | - | 정적 |
| test/test_cloudflare_api_lifecycle.py | 291 | ApiLifecycle | test_portal_discovery_rejects_foreign_or_ambiguous_apps | - | 정적 |
| test/test_cloudflare_api_lifecycle.py | 314 | ApiLifecycle | test_deleted_tunnel_requires_valid_tombstone_and_empty_dedicated_clients | - | 정적 |
| test/test_cloudflare_api_lifecycle.py | 336 | ApiLifecycle | test_new_overlapping_app_blocks_cleanup_without_any_delete | - | 정적 |
| test/test_cloudflare_binary.py | 30 | Portable | test_explicit_cli_forwarding_choice_and_nonmutating_dry_run | - | 정적 |
| test/test_cloudflare_binary.py | 48 | Portable | test_platform_root_tty_rejected_before_any_install_or_secret | - | 정적 |
| test/test_cloudflare_binary.py | 63 | Portable | test_https_redirect_allowlist_rejects_credentials_other_hosts_and_versions | - | 정적 |
| test/test_cloudflare_binary.py | 76 | Portable | test_download_size_deadline_and_secret_free_request_and_errors | - | 정적 |
| test/test_cloudflare_binary.py | 123 | Filesystem | test_install_and_verified_reuse_without_touching_foreign_files | - | 정적 |
| test/test_cloudflare_binary.py | 133 | Filesystem | test_corrupt_same_size_artifact_is_not_executed_or_published | - | 정적 |
| test/test_cloudflare_binary.py | 142 | Filesystem | test_partial_download_and_wrong_version_leave_no_public_file | - | 정적 |
| test/test_cloudflare_binary.py | 152 | Filesystem | test_changed_cached_binary_is_not_replaced_or_executed | - | 정적 |
| test/test_cloudflare_binary.py | 160 | Filesystem | test_foreign_path_links_and_parent_modes_are_refused | - | 정적 |
| test/test_cloudflare_binary.py | 189 | Filesystem | test_exclusive_publication_preserves_a_concurrent_existing_file | - | 정적 |
| test/test_cloudflare_binary.py | 200 | Filesystem | test_connector_handoff_and_failed_preconditions_before_binary_install | - | 정적 |
| test/test_cloudflare_binary.py | 216 | Filesystem | test_official_pinned_binary_installs_executes_and_reuses | - | 정적 |
| test/test_cloudflare_connector.py | 104 | Portable | test_token_session_metadata_is_public_but_requests_must_require_authentication | - | 정적 |
| test/test_cloudflare_connector.py | 122 | Portable | test_credential_acl_oracle_rejects_other_users_groups_write_and_unknown_layout | - | 정적 |
| test/test_cloudflare_connector.py | 141 | Portable | test_native_flags_forward_and_dry_run_never_opens_state_or_prompts | - | 정적 |
| test/test_cloudflare_connector.py | 159 | Portable | test_token_account_tunnel_endpoint_and_shape_are_bound | - | 정적 |
| test/test_cloudflare_connector.py | 172 | Portable | test_root_and_platform_are_checked_before_secret_input | - | 정적 |
| test/test_cloudflare_connector.py | 182 | Portable | test_unit_contains_paths_not_tokens_and_disables_token_logging | - | 정적 |
| test/test_cloudflare_connector.py | 222 | Filesystem | test_actual_loopback_health_auth_and_private_env_preconditions | - | 정적 |
| test/test_cloudflare_connector.py | 264 | Filesystem | test_generated_unit_passes_systemd_parser_without_starting_a_service | - | 정적 |
| test/test_cloudflare_connector.py | 275 | Filesystem | test_real_manager_reads_private_credential_as_dynamic_user_and_removes_only_own_unit | - | 정적 |
| test/test_cloudflare_connector.py | 387 | Filesystem | test_systemd_parser_matches_explicit_fixture_mount_contract | - | 정적 |
| test/test_cloudflare_connector.py | 401 | Filesystem | test_install_remove_cleanup_and_durable_reopen_preserve_foreign_files | - | 정적 |
| test/test_cloudflare_connector.py | 430 | Filesystem | test_every_durable_connector_record_contains_only_public_fields | - | 정적 |
| test/test_cloudflare_connector.py | 447 | Filesystem | test_unknown_start_outcome_is_not_replayed_and_can_be_explicitly_removed | - | 정적 |
| test/test_cloudflare_connector.py | 459 | Filesystem | test_remote_cleanup_is_blocked_even_before_edge_connection_appears | - | 정적 |
| test/test_cloudflare_connector.py | 467 | Filesystem | test_dedicated_connection_read_failure_keeps_active_without_restart | - | 정적 |
| test/test_cloudflare_connector.py | 490 | Filesystem | test_local_active_edge_pending_and_record_failure_do_not_trigger_restart | - | 정적 |
| test/test_cloudflare_connector.py | 517 | Filesystem | test_changed_unit_token_binary_or_dropin_is_not_touched | - | 정적 |
| test/test_cloudflare_connector.py | 542 | Filesystem | test_root_path_symlinks_bad_token_and_local_readiness_stop_before_files | - | 정적 |
| test/test_cloudflare_connector.py | 572 | Filesystem | test_remove_failure_and_crash_after_unlink_can_resume_without_start | - | 정적 |
| test/test_cloudflare_connector.py | 585 | Filesystem | test_ambiguous_file_creation_is_not_adopted_or_deleted | - | 정적 |
| test/test_cloudflare_discovery.py | 23 | Portable | test_cli_forwarding_dry_run_and_root_before_secret | - | 정적 |
| test/test_cloudflare_discovery.py | 44 | Portable | test_invalid_combinations_never_read_state | - | 정적 |
| test/test_cloudflare_discovery.py | 53 | Portable | test_cli_dispatch_prints_only_sanitized_result | - | 정적 |
| test/test_cloudflare_discovery.py | 109 | Filesystem | test_sync_once_persists_private_result_then_reads_only_even_after_reopen | - | 정적 |
| test/test_cloudflare_discovery.py | 127 | Filesystem | test_waiting_error_and_empty_capabilities_are_not_successful_login | - | 정적 |
| test/test_cloudflare_discovery.py | 135 | Filesystem | test_ambiguous_write_or_post_read_and_changed_guard_preserve_intent_without_replay | - | 정적 |
| test/test_cloudflare_discovery.py | 151 | Filesystem | test_definite_rejection_is_recorded_and_cannot_replay | - | 정적 |
| test/test_cloudflare_discovery.py | 162 | Filesystem | test_existing_claim_invalid_result_or_symlink_never_sends_sync | - | 정적 |
| test/test_cloudflare_discovery.py | 177 | Filesystem | test_remote_config_drift_and_disconnected_edge_block_before_claim | - | 정적 |
| test/test_cloudflare_discovery.py | 188 | Filesystem | test_foreign_portal_env_change_local_auth_and_connector_change_block_before_claim | - | 정적 |
| test/test_cloudflare_environment.py | 31 | Portable | test_explicit_flags_dry_run_and_nonroot_never_open_state_or_prompt | - | 정적 |
| test/test_cloudflare_environment.py | 48 | Portable | test_restore_cli_requires_no_cloudflare_api_token_or_remote_client | - | 정적 |
| test/test_cloudflare_environment.py | 110 | Filesystem | test_link_restore_actual_private_files_preserve_bytes_and_block_connector_cleanup | - | 정적 |
| test/test_cloudflare_environment.py | 132 | Filesystem | test_later_admin_change_and_replaced_snapshot_are_never_overwritten | - | 정적 |
| test/test_cloudflare_environment.py | 146 | Filesystem | test_failed_or_unknown_apply_cannot_be_replayed_or_automatically_restored | - | 정적 |
| test/test_cloudflare_environment.py | 158 | Filesystem | test_compare_guard_rejects_setup_race_without_overwriting_latest_env | - | 정적 |
| test/test_cloudflare_environment.py | 165 | Filesystem | test_failed_restore_is_not_replayed_and_does_not_unlock_connector_cleanup | - | 정적 |
| test/test_cloudflare_environment.py | 179 | Filesystem | test_zero_exit_without_expected_env_is_not_linked | - | 정적 |
| test/test_cloudflare_environment.py | 188 | Filesystem | test_changed_access_policy_or_missing_audience_never_starts_environment_transaction | - | 정적 |
| test/test_cloudflare_environment.py | 202 | Filesystem | test_changed_active_unit_is_rejected_before_any_environment_record | - | 정적 |
| test/test_cloudflare_environment.py | 331 | NativeHelper | test_real_shell_link_restore_backups_and_private_files_preserve_exact_original | - | 정적 |
| test/test_cloudflare_environment.py | 344 | NativeHelper | test_reservation_denial_is_before_live_write_backup_or_restart | - | 정적 |
| test/test_cloudflare_environment.py | 354 | NativeHelper | test_restart_failure_restores_backup_and_releases_reservation | - | 정적 |
| test/test_cloudflare_environment.py | 363 | NativeHelper | test_owner_edit_during_reservation_is_preserved_before_any_live_replace | - | 정적 |
| test/test_cloudflare_environment.py | 372 | NativeHelper | test_owner_edit_during_failed_restart_is_not_overwritten_by_recovery | - | 정적 |
| test/test_cloudflare_environment.py | 382 | NativeHelper | test_auth_smoke_failure_restores_original_settings | - | 정적 |
| test/test_cloudflare_environment.py | 391 | NativeHelper | test_term_during_restart_recovers_original_and_releases_reservation | - | 정적 |
| test/test_cloudflare_provision.py | 130 | Provisioning | test_documented_tunnel_response_preserves_public_identity_and_cleanup | - | 정적 |
| test/test_cloudflare_provision.py | 146 | Provisioning | test_tunnel_response_conflicts_and_unknown_secrets_stop_before_next_write | - | 정적 |
| test/test_cloudflare_provision.py | 169 | Provisioning | test_platform_guard_rejects_other_posix_systems_before_secrets_or_files | - | 정적 |
| test/test_cloudflare_provision.py | 178 | Provisioning | test_added_configuration_is_not_mistaken_for_server_metadata | - | 정적 |
| test/test_cloudflare_provision.py | 197 | Provisioning | test_known_readonly_metadata_does_not_block_cleanup | - | 정적 |
| test/test_cloudflare_provision.py | 208 | Provisioning | test_resource_id_is_never_ignored_as_metadata | - | 정적 |
| test/test_cloudflare_provision.py | 219 | Provisioning | test_derived_app_missing_before_our_portal_delete_stops_all_writes | - | 정적 |
| test/test_cloudflare_provision.py | 230 | Provisioning | test_cleanup_resumes_only_after_durable_known_portal_delete | - | 정적 |
| test/test_cloudflare_provision.py | 247 | Provisioning | test_private_response_fields_or_reflected_bearers_cannot_enter_journal | - | 정적 |
| test/test_cloudflare_provision.py | 252 | Provisioning | test_portal_forwards_explicit_cloudflare_authority_only_to_cloudflare | - | 정적 |
| test/test_cloudflare_provision.py | 261 | Provisioning | test_http_write_method_body_and_uncertain_failures_are_distinguished | - | 정적 |
| test/test_cloudflare_provision.py | 283 | Provisioning | test_portal_policy_update_never_selects_a_baseline_or_ambiguous_app | - | 정적 |
| test/test_cloudflare_provision.py | 293 | Provisioning | test_create_then_explicit_cleanup_preserves_foreign_resources_and_secrets | - | 정적 |
| test/test_cloudflare_provision.py | 311 | Provisioning | test_definite_failure_at_every_write_can_cleanup_known_prefix | - | 정적 |
| test/test_cloudflare_provision.py | 326 | Provisioning | test_unknown_response_never_replays_or_automatically_deletes | - | 정적 |
| test/test_cloudflare_provision.py | 340 | Provisioning | test_remote_identity_or_tunnel_use_change_stops_cleanup | - | 정적 |
| test/test_cloudflare_provision.py | 352 | Provisioning | test_cleanup_checks_all_resources_before_deleting_anything | - | 정적 |
| test/test_cloudflare_provision.py | 370 | Provisioning | test_conflict_or_bad_bearer_never_writes | - | 정적 |
| test/test_cloudflare_provision.py | 380 | Provisioning | test_arbitrary_ids_and_kinds_cannot_escape_fixed_endpoints | - | 정적 |
| test/test_cloudflare_provision.py | 385 | Provisioning | test_default_dryrun_apply_still_does_not_prompt_or_create_state | - | 정적 |
| test/test_cloudflare_provision.py | 395 | Provisioning | test_mutating_cli_invalid_combinations_and_non_tty_do_not_write | - | 정적 |
| test/test_cloudflare_provision.py | 408 | PrivateJournal | test_documented_tunnel_credentials_are_never_durable_and_prefix_can_resume | - | 정적 |
| test/test_cloudflare_provision.py | 442 | PrivateJournal | test_run_parent_file_and_directory_are_durable_before_first_write | - | 정적 |
| test/test_cloudflare_provision.py | 467 | PrivateJournal | test_parent_fsync_failure_is_before_any_remote_write | - | 정적 |
| test/test_cloudflare_provision.py | 483 | PrivateJournal | test_saved_plan_and_full_guard_are_validated_on_reopen | - | 정적 |
| test/test_cloudflare_provision.py | 514 | PrivateJournal | test_durable_portal_delete_marker_survives_actual_journal_reopen | - | 정적 |
| test/test_cloudflare_provision.py | 531 | PrivateJournal | test_private_atomic_state_lock_and_crash_intent | - | 정적 |
| test/test_cloudflare_provision.py | 548 | PrivateJournal | test_symlink_hardlink_permissions_and_duplicate_json_are_rejected | - | 정적 |
| test/test_cloudflare_setup.py | 71 | CloudflareSetup | test_plan_is_new_resources_only_and_retains_owner_and_oauth_boundaries | - | 정적 |
| test/test_cloudflare_setup.py | 87 | CloudflareSetup | test_config_rejects_extra_secret_duplicate_json_and_large_file | - | 정적 |
| test/test_cloudflare_setup.py | 96 | CloudflareSetup | test_portal_dns_is_planned_separately_from_tunnel | - | 정적 |
| test/test_cloudflare_setup.py | 107 | CloudflareSetup | test_server_requires_its_own_owner_policy_before_portal_mapping | - | 정적 |
| test/test_cloudflare_setup.py | 125 | CloudflareSetup | test_orphan_server_access_destination_is_a_conflict_even_without_server | - | 정적 |
| test/test_cloudflare_setup.py | 135 | CloudflareSetup | test_bad_fields_cannot_inject_api_paths_dns_policies_or_redirects | - | 정적 |
| test/test_cloudflare_setup.py | 154 | CloudflareSetup | test_cli_dry_run_does_not_prompt_tokens_access_network_or_write_files | - | 정적 |
| test/test_cloudflare_setup.py | 180 | CloudflareSetup | test_noninteractive_checks_never_fall_back_to_echoing_getpass | - | 정적 |
| test/test_cloudflare_setup.py | 187 | CloudflareSetup | test_public_interactive_setup_accepts_defaults_but_never_asks_for_token | - | 정적 |
| test/test_cloudflare_setup.py | 194 | CloudflareSetup | test_getpass_echo_fallback_is_rejected_and_no_api_request_occurs | - | 정적 |
| test/test_cloudflare_setup.py | 203 | CloudflareSetup | test_api_is_fixed_https_get_only_and_token_is_header_only | - | 정적 |
| test/test_cloudflare_setup.py | 217 | CloudflareSetup | test_errors_and_redirects_never_echo_private_remote_content | - | 정적 |
| test/test_cloudflare_setup.py | 230 | CloudflareSetup | test_real_http_redirect_does_not_forward_fixture_authorization | - | 정적 |
| test/test_cloudflare_setup.py | 255 | CloudflareSetup | test_pagination_inspects_all_pages_not_just_first_page | - | 정적 |
| test/test_cloudflare_setup.py | 264 | CloudflareSetup | test_preflight_checks_scope_and_never_claims_provisioned_or_logged_in | - | 정적 |
| test/test_cloudflare_setup.py | 278 | CloudflareSetup | test_conflicts_are_explicit_and_existing_resources_remain_untouched | - | 정적 |
| test/test_cloudflare_setup.py | 291 | CloudflareSetup | test_additional_access_hosts_and_public_destinations_cannot_be_missed | - | 정적 |
| test/test_cloudflare_setup.py | 309 | CloudflareSetup | test_unsupported_or_malformed_access_host_shapes_do_not_report_ready | - | 정적 |
| test/test_compose_env.py | 31 | ComposeEnvironment | test_supported_assignment_styles_preserve_image_comments_and_options | - | 정적 |
| test/test_compose_env.py | 43 | ComposeEnvironment | test_export_quoted_and_duplicate_ids_only_replace_values | - | 정적 |
| test/test_compose_env.py | 48 | ComposeEnvironment | test_multiline_options_are_not_interpreted_as_settings | - | 정적 |
| test/test_compose_env.py | 55 | ComposeEnvironment | test_missing_keys_append_without_joining_the_last_line | - | 정적 |
| test/test_compose_env.py | 60 | ComposeEnvironment | test_image_update_replaces_only_values_in_all_supported_assignments | - | 정적 |
| test/test_compose_env.py | 77 | ComposeEnvironment | test_existing_owner_and_private_mode_are_preserved | - | 정적 |
| test/test_env_editor_lock.py | 11 | EnvironmentEditorLock | test_shared_install_lock_rejects_without_mutation | - | 정적 |
| test/test_environment_helper.py | 45 | EditorTests | test_snapshot_write_only_and_opaque_revision | - | 정적 |
| test/test_environment_helper.py | 54 | EditorTests | test_duplicate_assignments_last_win_and_unedited_bytes_survive | - | 정적 |
| test/test_environment_helper.py | 74 | EditorTests | test_healthy_uses_last_duplicate_port_without_system_service_access | - | 정적 |
| test/test_environment_helper.py | 89 | EditorTests | test_default_restart_requires_verified_baseline_preservation | - | 정적 |
| test/test_environment_helper.py | 103 | EditorTests | test_patch_preserves_backup_unknowns_crlf_and_mode | - | 정적 |
| test/test_environment_helper.py | 113 | EditorTests | test_stale_revision_and_manual_change_do_not_overwrite | - | 정적 |
| test/test_environment_helper.py | 124 | EditorTests | test_path_shell_newline_and_secret_controls_refused | - | 정적 |
| test/test_environment_helper.py | 130 | EditorTests | test_unicode_line_breaks_and_controls_cannot_poison_saved_env | - | 정적 |
| test/test_environment_helper.py | 137 | EditorTests | test_existing_non_lf_separator_is_preserved_or_replaced_as_one_entry | - | 정적 |
| test/test_environment_helper.py | 147 | EditorTests | test_validation_failure_never_changes_env | - | 정적 |
| test/test_environment_helper.py | 156 | EditorTests | test_external_edit_during_validation_is_preserved | - | 정적 |
| test/test_environment_helper.py | 164 | EditorTests | test_null_removes_key_and_secret_is_not_returned | - | 정적 |
| test/test_environment_helper.py | 170 | EditorTests | test_symlink_hardlink_fifo_and_public_files_refused | - | 정적 |
| test/test_environment_helper.py | 188 | EditorTests | test_acknowledgement_and_scheduled_job_exclusion | - | 정적 |
| test/test_environment_helper.py | 198 | EditorTests | test_successful_restart_and_duplicate_job_never_replays | - | 정적 |
| test/test_environment_helper.py | 214 | EditorTests | test_failed_start_rolls_back_earliest_env | - | 정적 |
| test/test_environment_helper.py | 229 | EditorTests | test_external_edit_after_scheduling_stops_restart | - | 정적 |
| test/test_environment_helper.py | 239 | EditorTests | test_failed_recovery_is_reported_and_backup_preserved | - | 정적 |
| test/test_environment_helper.py | 248 | EditorTests | test_unconfirmed_release_keeps_owner_and_pending_backup | - | 정적 |
| test/test_environment_helper.py | 259 | EditorTests | test_unconfirmed_comparison_keeps_owner_and_pending_backup | - | 정적 |
| test/test_environment_helper.py | 271 | EditorTests | test_unconfirmed_capture_never_restarts_or_releases | - | 정적 |
| test/test_environment_helper.py | 283 | EditorTests | test_command_automation_toggle_real_helper_and_application | - | 정적 |
| test/test_environment_helper.py | 335 | EditorTests | test_plain_restart_failure_does_not_claim_env_recovery | - | 정적 |
| test/test_environment_helper.py | 341 | EditorTests | test_scheduler_failure_does_not_claim_restart | - | 정적 |
| test/test_environment_helper.py | 350 | EditorTests | test_status_read_does_not_wait_for_restart_mutation_lock | - | 정적 |
| test/test_environment_helper.py | 361 | NativeSocketTests | test_root_broker_and_peer_boundary | - | 정적 |
| test/test_helper.py | 36 | Files | test_binary_empty_hash_overwrite_mode_and_snapshot | - | 정적 |
| test/test_helper.py | 52 | Files | test_hash_failure_does_not_replace_and_symlinks_are_refused | - | 정적 |
| test/test_helper.py | 84 | Files | test_missing_parent_is_distinct_and_never_created | - | 정적 |
| test/test_helper.py | 92 | Files | test_missing_source_and_staging_are_not_missing_parent | - | 정적 |
| test/test_helper.py | 100 | Files | test_permissions_are_classified_by_errno_without_arbitrary_text | - | 정적 |
| test/test_helper.py | 111 | Files | test_existing_destination_and_links_are_preserved_with_safe_errors | - | 정적 |
| test/test_helper.py | 127 | Files | test_failure_releases_descriptors_and_removes_publish_temporary | - | 정적 |
| test/test_helper.py | 144 | Files | test_unknown_failure_is_generic_and_invalid_request_and_limit_are_safe | - | 정적 |
| test/test_helper.py | 151 | Files | test_post_publication_failure_is_unknown_even_when_errno_is_permission | - | 정적 |
| test/test_helper.py | 163 | Files | test_directory_fifo_and_size_limit_refused | - | 정적 |
| test/test_linux_desktop_session.py | 56 | NativeRdpValidationTest | test_exact_private_hash_and_unix_stream_keep_fd_open_but_not_inheritable | - | 정적 |
| test/test_linux_desktop_session.py | 66 | NativeRdpValidationTest | test_bad_manifest_or_stock_path_fails_before_bootstrap | - | 정적 |
| test/test_linux_desktop_session.py | 77 | NativeRdpValidationTest | test_changed_executable_missing_file_symlink_and_nonexecutable_are_rejected | - | 정적 |
| test/test_linux_desktop_session.py | 96 | NativeRdpValidationTest | test_pipe_datagram_unconnected_or_missing_fd_fails_before_bootstrap | - | 정적 |
| test/test_linux_desktop_session.py | 117 | NativeRdpValidationTest | test_only_native_child_inherits_control_and_parent_closes_before_credentials | - | 정적 |
| test/test_linux_desktop_session.py | 249 | StartupDeadlineTest | test_global_expiry_during_failed_window_probe_is_not_window_timeout | - | 정적 |
| test/test_linux_desktop_session.py | 252 | StartupDeadlineTest | test_late_viewable_or_focus_never_emits_ready | - | 정적 |
| test/test_linux_desktop_session.py | 257 | StartupDeadlineTest | test_global_probe_timeout_or_display_wait_is_expired | - | 정적 |
| test/test_linux_desktop_session.py | 262 | StartupDeadlineTest | test_phase_deadlines_keep_their_original_error_codes | - | 정적 |
| test/test_linux_desktop_session.py | 269 | StartupDeadlineTest | test_unwritable_tmp_falls_back_for_session_root_and_reports_xvnc_start_failed | - | 정적 |
| test/test_node_runtime.py | 85 | NativeRuntime | test_fresh_archive_ignores_vendor_uid_and_supports_internal_npm_link | - | 정적 |
| test/test_node_runtime.py | 93 | NativeRuntime | test_untrusted_existing_is_never_executed_and_is_preserved_privately | - | 정적 |
| test/test_node_runtime.py | 105 | NativeRuntime | test_trusted_existing_reused_without_download | - | 정적 |
| test/test_node_runtime.py | 113 | NativeRuntime | test_checksum_failure_preserves_existing_bytes_owner_and_no_execution | - | 정적 |
| test/test_node_runtime.py | 123 | NativeRuntime | test_wrong_new_major_preserves_existing | - | 정적 |
| test/test_node_runtime.py | 131 | NativeRuntime | test_top_level_symlink_is_not_followed_or_replaced | - | 정적 |
| test/test_node_runtime.py | 139 | NativeRuntime | test_escaping_or_writable_runtime_is_not_executed | - | 정적 |
| test/test_node_runtime.py | 155 | NativeRuntime | test_untrusted_parent_rejected_before_download | - | 정적 |
| test/test_node_runtime.py | 162 | NativeRuntime | test_failed_final_rename_restores_old_runtime | - | 정적 |
| test/test_node_runtime.py | 174 | NativeRuntime | test_term_between_renames_restores_old_runtime | - | 정적 |
| test/test_node_runtime.py | 202 | NativeRuntime | test_existing_lock_prevents_parallel_install | - | 정적 |
| test/test_node_runtime.py | 213 | NativeRuntime | test_verified_official_archive_installs_and_executes_as_root_owned | - | 정적 |
| test/test_oidc_environment.py | 34 | OidcNative | test_public_oidc_session_is_rejected_and_original_env_restored | - | 정적 |
| test/test_oidc_environment.py | 43 | OidcNative | test_public_oidc_requests_are_rejected_and_original_env_restored | - | 정적 |
| test/test_oidc_proxy_install.py | 28 | PublicInstallation | test_default_cli_is_only_a_plan_and_rejects_secret_config | - | 정적 |
| test/test_oidc_proxy_install.py | 97 | NativeInstallation | test_install_remove_and_duplicate_preserve_private_files_and_existing_units | - | 정적 |
| test/test_oidc_proxy_install.py | 122 | NativeInstallation | test_reconstructed_files_and_receipt_reject_forgery_before_install | - | 정적 |
| test/test_oidc_proxy_install.py | 135 | NativeInstallation | test_missing_invalid_or_linked_credentials_fail_before_service_writes | - | 정적 |
| test/test_oidc_proxy_install.py | 146 | NativeInstallation | test_existing_service_and_dropin_are_not_overwritten_or_stopped | - | 정적 |
| test/test_oidc_proxy_install.py | 159 | NativeInstallation | test_second_start_failure_stops_owned_services_and_removes_only_owned_units | - | 정적 |
| test/test_oidc_proxy_install.py | 168 | NativeInstallation | test_changed_owned_unit_or_start_link_or_dropin_stops_removal | - | 정적 |
| test/test_oidc_proxy_install.py | 186 | NativeInstallation | test_global_lock_blocks_parallel_install | - | 정적 |
| test/test_oidc_proxy_install.py | 192 | NativeInstallation | test_dropin_added_after_install_prevents_any_stop | - | 정적 |
| test/test_oidc_proxy_install.py | 201 | NativeInstallation | test_new_lock_keeps_private_mode_under_restrictive_umask | - | 정적 |
| test/test_oidc_proxy_install.py | 209 | NativeInstallation | test_unrecorded_partial_unit_is_retained_for_manual_review | - | 정적 |
| test/test_oidc_proxy_install.py | 224 | NativeInstallation | test_unsupported_architecture_never_installs | - | 정적 |
| test/test_oidc_proxy_install.py | 231 | NativeInstallation | test_binary_pins_publish_exclusively_and_reject_changed_or_linked_bytes | - | 정적 |
| test/test_oidc_proxy_setup.py | 29 | PublicBundle | test_exact_callback_loopback_ports_and_shared_security_template | - | 정적 |
| test/test_oidc_proxy_setup.py | 49 | PublicBundle | test_input_injection_and_conflicts_are_rejected | - | 정적 |
| test/test_oidc_proxy_setup.py | 62 | PublicBundle | test_systemd_credential_paths_and_service_restrictions | - | 정적 |
| test/test_oidc_proxy_setup.py | 82 | PublicBundle | test_template_placeholders_inside_input_are_not_rewritten | - | 정적 |
| test/test_oidc_proxy_setup.py | 89 | PublicBundle | test_cli_dry_run_is_secret_free_and_prepare_rejects_non_tty | - | 정적 |
| test/test_oidc_proxy_setup.py | 125 | PrivatePreparation | test_private_files_cookie_and_no_secret_in_receipt | - | 정적 |
| test/test_oidc_proxy_setup.py | 144 | PrivatePreparation | test_parent_symlink_and_writable_directory_are_rejected | - | 정적 |
| test/test_oidc_proxy_setup.py | 157 | PrivatePreparation | test_secret_confirmation_failure_writes_nothing | - | 정적 |
| test/test_oidc_proxy_setup.py | 163 | PrivatePreparation | test_writable_parent_is_rejected_before_secret_input | - | 정적 |
| test/test_oidc_proxy_setup.py | 173 | PrivatePreparation | test_getpass_fallback_stops_before_first_or_confirmation_input | - | 정적 |
| test/test_oidc_proxy_setup.py | 219 | PrivatePreparation | test_final_file_and_directory_sync_failures_leave_no_ready_receipt | - | 정적 |
| test/test_oidc_proxy_setup.py | 238 | PrivatePreparation | test_restrictive_umask_does_not_break_private_directory_modes | - | 정적 |
| test/test_oidc_proxy_setup.py | 247 | PrivatePreparation | test_partial_write_does_not_create_ready_receipt_or_remove_existing_files | - | 정적 |
| test/test_package.py | 53 | PackageContract | test_secret_store_records_are_rejected_without_exposing_the_value | - | 정적 |
| test/test_package.py | 61 | PackageContract | test_native_sources_and_pinned_bundle_ship_but_generated_runtime_does_not | - | 정적 |
| test/test_package.py | 89 | PackageContract | test_native_source_symlink_is_rejected_before_manifest_publication | - | 정적 |
| test/test_package.py | 102 | PackageContract | test_manifest_and_archive_paths_use_case_sensitive_portable_order | - | 정적 |
| test/test_package.py | 118 | PackageContract | test_layered_sources_and_bundles_resolve_from_extracted_package | - | 정적 |
| test/test_package.py | 143 | PackageContract | test_manifest_rejects_unlisted_runtime_source | - | 정적 |
| test/test_package.py | 156 | PackageContract | test_manifest_requires_windows_transfer_runtime | - | 정적 |
| test/test_package.py | 169 | PackageContract | test_oidc_proxy_examples_are_in_both_archives_and_manifest_with_working_doc_links | - | 정적 |
| test/test_package.py | 199 | PackageContract | test_oidc_example_leaf_and_parent_symlinks_are_rejected | - | 정적 |
| test/test_package.py | 224 | PackageContract | test_oidc_template_private_key_is_rejected_before_manifest | - | 정적 |
| test/test_package.py | 233 | PackageContract | test_oidc_example_parent_junction_is_rejected_without_reading_target | - | 정적 |
| test/test_package.py | 253 | PackageContract | test_manifest_requires_oidc_proxy_examples_and_rejects_template_tampering | - | 정적 |
| test/test_package.py | 271 | PackageContract | test_source_release_can_prepare_default_docker_archive | - | 정적 |
| test/test_portal_setup.py | 18 | PortalWorkflow | test_real_cli_dry_run_needs_no_root_or_installed_runtime | - | 정적 |
| test/test_portal_setup.py | 27 | PortalWorkflow | test_all_plans_do_not_execute_or_require_linux_root | - | 정적 |
| test/test_portal_setup.py | 38 | PortalWorkflow | test_oidc_reuses_owner_transaction_and_rejects_cloudflare_only_options | - | 정적 |
| test/test_portal_setup.py | 48 | PortalWorkflow | test_update_never_forwards_install_only_authority_or_origin | - | 정적 |
| test/test_portal_setup.py | 56 | PortalWorkflow | test_sudo_is_explicit_and_passed_once | - | 정적 |
| test/test_portal_setup.py | 61 | PortalWorkflow | test_origin_shapes_reject_credential_path_port_and_control_input | - | 정적 |
| test/test_portal_setup.py | 69 | PortalWorkflow | test_failure_stops_before_later_steps_and_never_retries | - | 정적 |
| test/test_portal_setup.py | 78 | PortalWorkflow | test_verification_failure_does_not_repeat_successful_mutation | - | 정적 |
| test/test_portal_setup.py | 88 | PortalWorkflow | test_rollback_uses_existing_restore_and_verifies_restored_health | - | 정적 |
| test/test_portal_setup.py | 100 | PortalWorkflow | test_policy_reports_owner_action_instead_of_claiming_saved_or_enabling | - | 정적 |
| test/test_portal_setup.py | 108 | PortalWorkflow | test_mutation_rejects_unsupported_environment_before_execution | - | 정적 |
| test/test_prepare_freerdp_input.py | 25 | UnsupportedPlatform | test_unsupported_host_skips_without_reading_or_creating_a_runtime | - | 정적 |
| test/test_prepare_freerdp_input.py | 82 | PrivateRuntime | test_prepares_only_verified_runtime_without_executing_the_binary_and_reuses_exact_inode | - | 정적 |
| test/test_prepare_freerdp_input.py | 96 | PrivateRuntime | test_cli_isolates_umask077_and_preserves_executable_and_library_modes | - | 정적 |
| test/test_prepare_freerdp_input.py | 115 | PrivateRuntime | test_archive_pin_catches_a_valid_gzip_header_mutation_before_publication | - | 정적 |
| test/test_prepare_freerdp_input.py | 122 | PrivateRuntime | test_release_manifest_must_pin_the_exact_fixed_archive | - | 정적 |
| test/test_prepare_freerdp_input.py | 129 | PrivateRuntime | test_manifest_rejects_wrong_upstream_hash_size_mode_duplicates_and_traversal | - | 정적 |
| test/test_prepare_freerdp_input.py | 142 | PrivateRuntime | test_tar_rejects_duplicate_traversal_unlisted_files_and_link_device_members | - | 정적 |
| test/test_prepare_freerdp_input.py | 156 | PrivateRuntime | test_archive_entry_and_expansion_limits_are_enforced_before_publication | - | 정적 |
| test/test_prepare_freerdp_input.py | 163 | PrivateRuntime | test_group_writable_source_directory_is_rejected_without_publication | - | 정적 |
| test/test_prepare_freerdp_input.py | 170 | PrivateRuntime | test_existing_different_runtime_is_unchanged_and_never_replaced | - | 정적 |
| test/test_prepare_freerdp_input.py | 178 | PrivateRuntime | test_empty_runtime_collision_and_symlink_parent_do_not_get_overwritten | - | 정적 |
| test/test_prepare_freerdp_input.py | 190 | PrivateRuntime | test_failed_atomic_publication_removes_only_its_own_temporary_directory | - | 정적 |
| test/test_release_package.py | 87 | ReleasePackageContract | test_four_real_assets_have_matching_versions_manifests_checksums_and_working_entrypoints | - | 정적 |
| test/test_release_package.py | 158 | ReleasePackageContract | test_reusing_output_refuses_without_changing_any_existing_asset | - | 정적 |
| test/test_release_package.py | 171 | ReleasePackageContract | test_server_client_version_mismatch_creates_no_output_or_server_manifest | - | 정적 |
| test/test_release_update.py | 56 | CodeOnlyUpdate | test_success_and_recovery_touch_only_exact_release_link | - | 정적 |
| test/test_release_update.py | 67 | CodeOnlyUpdate | test_each_external_file_change_blocks_activation_and_recovery | - | 정적 |
| test/test_release_update.py | 82 | CodeOnlyUpdate | test_drift_between_checks_is_detected_before_replace | - | 정적 |
| test/test_release_update.py | 96 | CodeOnlyUpdate | test_third_release_or_regular_active_is_never_overwritten | - | 정적 |
| test/test_release_update.py | 113 | CodeOnlyUpdate | test_existing_new_directory_or_symlink_is_not_reused | - | 정적 |
| test/test_release_update.py | 123 | CodeOnlyUpdate | test_destination_created_during_verification_is_not_replaced | - | 정적 |
| test/test_release_update.py | 131 | CodeOnlyUpdate | test_invalid_candidate_and_external_symlink_are_not_published | - | 정적 |
| test/test_release_update.py | 143 | CodeOnlyUpdate | test_shared_lock_excludes_another_installer_until_recovery_finishes | - | 정적 |
| test/test_settings_contract.py | 15 | SettingsContract | test_vault_metadata_names_are_preserved_by_private_env_parser | - | 정적 |
| test/test_settings_contract.py | 25 | SettingsContract | test_shared_upload_host_vectors | - | 정적 |
| test/test_settings_contract.py | 37 | SettingsContract | test_shared_origin_and_port_vectors | - | 정적 |
| test/test_settings_contract.py | 47 | SettingsContract | test_origin_adapter_uses_stdin_and_checks_exact_bounded_output | - | 정적 |
| test/test_settings_contract.py | 74 | SettingsContract | test_ports_parse_private_settings_without_evaluation | - | 정적 |
| test/test_settings_contract.py | 89 | SettingsContract | test_private_config_boundary | - | 정적 |
| test/test_tunnel_connections.py | 34 | DedicatedConnections | test_complete_empty_and_actual_connection_are_distinct | - | 정적 |
| test/test_tunnel_connections.py | 40 | DedicatedConnections | test_all_pages_are_required_before_deciding_no_connections | - | 정적 |
| test/test_tunnel_connections.py | 45 | DedicatedConnections | test_missing_inconsistent_duplicate_or_early_empty_page_is_unknown | - | 정적 |
| test/test_tunnel_connections.py | 58 | DedicatedConnections | test_connection_read_errors_are_never_absence | - | 정적 |
| test/test_tunnel_connections.py | 62 | DedicatedConnections | test_uuid_format_must_be_complete_for_clients_and_connections | - | 정적 |
| test/test_tunnel_connections.py | 67 | DedicatedConnections | test_count_contradiction_never_confirms_empty_connections | - | 정적 |
| test/test_tunnel_connections.py | 76 | DedicatedConnections | test_cleanup_refuses_dedicated_client_when_deprecated_field_is_empty | - | 정적 |
| test/test_tunnel_connections.py | 85 | DedicatedConnections | test_old_guard_connections_are_ephemeral_but_other_changes_still_refused | - | 정적 |
| test/test_tunnel_connections.py | 97 | DedicatedConnections | test_cleanup_read_failure_sends_no_delete | - | 정적 |
| test/test_upload_sources.py | 16 | UploadSourceConfiguration | test_preserves_other_lines_and_crlf_and_replaces_only_source_setting | - | 정적 |
| test/test_upload_sources.py | 22 | UploadSourceConfiguration | test_invalid_hosts_and_credential_or_url_inputs_are_rejected | - | 정적 |
| test/test_upload_sources.py | 27 | UploadSourceConfiguration | test_mixed_exact_and_wildcard_settings_preserve_other_bytes | - | 정적 |
| test/test_upload_sources.py | 32 | UploadSourceConfiguration | test_host_update_cannot_exceed_managed_configuration_limit | - | 정적 |
| test/test_upload_sources.py | 39 | UploadSourceConfiguration | test_private_regular_file_boundary | - | 정적 |

## 사례 표 (PowerShell·셸 스크립트, 판정 단위 = 사례 이름 문자열)

이 파일들은 `Describe`/`It` 블록이 없다. 그래서 사례 이름은 다음 두 방식으로 잡았다.
- `windows-file-helper.tests.ps1`: `Assert-True`의 두 번째 인자(라벨) 한 줄 호출 1개 = 1행. 라벨 앞머리의 `FO-SNAPSHOT-xx`, `WRITER-ACL-xx` 같은 사례 번호가 같은 사례 묶음을 나타낸다. 여러 줄에 걸친 `Assert-True` 호출은 이 표에 넣지 않았다(아래 미확인 항목).
- 셸·기타 ps1: 최종 PASS 요약 문자열, 실패 검사의 `unexpectedly accepted` 등 사례 판정 문자열, `Assert-Exit` 운영 단계 이름.

| 파일 | 줄 | describe 묶음 | 사례 이름(원문) | 결함 번호 | 동적 여부 |
|---|---|---|---|---|---|
| test/windows-file-helper.tests.ps1 | 61 | - | stderr must not contain exception details | - | 정적 |
| test/windows-file-helper.tests.ps1 | 105 | - | ('expected ' + $code + '; ' + (Describe-Result $result)) | - | 동적 |
| test/windows-file-helper.tests.ps1 | 106 | - | content must never be returned | - | 정적 |
| test/windows-file-helper.tests.ps1 | 111 | - | new file DACL is protected from parent inheritance | - | 정적 |
| test/windows-file-helper.tests.ps1 | 116 | - | new file grants access only to account SYSTEM and Administrators | - | 정적 |
| test/windows-file-helper.tests.ps1 | 298 | - | FO-SNAPSHOT fixture has the requested foreign parent owner | - | 정적 |
| test/windows-file-helper.tests.ps1 | 310 | - | FO-SNAPSHOT-01 snapshot has exact independent bytes | - | 정적 |
| test/windows-file-helper.tests.ps1 | 311 | - | FO-SNAPSHOT-01 source owner and DACL are unchanged | - | 정적 |
| test/windows-file-helper.tests.ps1 | 313 | - | FO-SNAPSHOT-01 stage is cleaned | - | 정적 |
| test/windows-file-helper.tests.ps1 | 318 | - | FO-SNAPSHOT-02 refused normal snapshot creates no part | - | 정적 |
| test/windows-file-helper.tests.ps1 | 323 | - | FO-SNAPSHOT-02 publish refusal preserves source parent | - | 정적 |
| test/windows-file-helper.tests.ps1 | 324 | - | FO-SNAPSHOT-02 refused publish stage is cleaned | - | 정적 |
| test/windows-file-helper.tests.ps1 | 332 | - | FO-SNAPSHOT-03 rejected protected root creates no part | - | 정적 |
| test/windows-file-helper.tests.ps1 | 334 | - | FO-SNAPSHOT-03 protected root owner is restored exactly | - | 정적 |
| test/windows-file-helper.tests.ps1 | 339 | - | FO-SNAPSHOT-03 installer rejects foreign-owner parent | - | 정적 |
| test/windows-file-helper.tests.ps1 | 341 | - | FO-SNAPSHOT-03 refused installer creates no protected root | - | 정적 |
| test/windows-file-helper.tests.ps1 | 376 | - | ('FO-SNAPSHOT-04 TEST snapshot needs no source READ_CONTROL; ' + (Describe-Result $result)) | - | 동적 |
| test/windows-file-helper.tests.ps1 | 377 | - | FO-SNAPSHOT-04 exact independent source bytes | - | 정적 |
| test/windows-file-helper.tests.ps1 | 378 | - | FO-SNAPSHOT-04 stage is cleaned | - | 정적 |
| test/windows-file-helper.tests.ps1 | 418 | - | FO-SNAPSHOT-06 unsafe source creates no stage part | - | 정적 |
| test/windows-file-helper.tests.ps1 | 424 | - | FO-SNAPSHOT-07 control metadata-only parent pin permits actual rename | - | 정적 |
| test/windows-file-helper.tests.ps1 | 425 | - | FO-SNAPSHOT-07 FILE_TRAVERSE parent pin blocks actual rename with sharing violation | - | 정적 |
| test/windows-file-helper.tests.ps1 | 426 | - | FO-SNAPSHOT-07 FILE_READ_DATA leaf pin blocks actual rename with sharing violation | - | 정적 |
| test/windows-file-helper.tests.ps1 | 446 | - | FO-SNAPSHOT-08 native race worker completed without fixture failure | - | 정적 |
| test/windows-file-helper.tests.ps1 | 447 | - | FO-SNAPSHOT-08 RACE_OBSERVATION_MISSING is a preparation gap, not a product red | - | 정적 |
| test/windows-file-helper.tests.ps1 | 451 | - | FO-SNAPSHOT-08 successful raced snapshot has exact pinned source bytes | - | 정적 |
| test/windows-file-helper.tests.ps1 | 454 | - | ('FO-SNAPSHOT-08 raced refusal leaves no part; ' + (Describe-Result $result)) | - | 동적 |
| test/windows-file-helper.tests.ps1 | 463 | - | FO-SNAPSHOT-08 raced stage is cleaned | - | 정적 |
| test/windows-file-helper.tests.ps1 | 467 | - | FO-SNAPSHOT source ACL and owner remain exact after all cases | - | 정적 |
| test/windows-file-helper.tests.ps1 | 496 | - | ('WRITER-ACL-01 inherit-only Creator Owner permits publish; ' + (Describe-Result $result)) | - | 동적 |
| test/windows-file-helper.tests.ps1 | 497 | - | WRITER-ACL-01 published binary equals independent input | - | 정적 |
| test/windows-file-helper.tests.ps1 | 499 | - | WRITER-ACL-01 inherit-only Creator Owner permits snapshot | - | 정적 |
| test/windows-file-helper.tests.ps1 | 500 | - | WRITER-ACL-01 snapshot binary equals independent input | - | 정적 |
| test/windows-file-helper.tests.ps1 | 501 | - | WRITER-ACL-01 helper never repairs directory ACL | - | 정적 |
| test/windows-file-helper.tests.ps1 | 506 | - | WRITER-ACL-01 original session stage can be cleaned | - | 정적 |
| test/windows-file-helper.tests.ps1 | 561 | - | deny-only Administrators token cannot request elevation | - | 정적 |
| test/windows-file-helper.tests.ps1 | 567 | - | default ProgramData parent supports protected directory creation | - | 정적 |
| test/windows-file-helper.tests.ps1 | 575 | - | new dedicated installation | - | 정적 |
| test/windows-file-helper.tests.ps1 | 580 | - | ('connected administrator token is authorized; ' + (Describe-Result $authorized)) | - | 동적 |
| test/windows-file-helper.tests.ps1 | 581 | - | authorization does not create a staged file | - | 정적 |
| test/windows-file-helper.tests.ps1 | 583 | - | existing installation must be preserved | - | 정적 |
| test/windows-file-helper.tests.ps1 | 595 | - | Users Modify ancestor must reject installation | - | 정적 |
| test/windows-file-helper.tests.ps1 | 596 | - | installer cannot change an unsafe parent ACL | - | 정적 |
| test/windows-file-helper.tests.ps1 | 597 | - | unsafe ancestry cannot create protected roots | - | 정적 |
| test/windows-file-helper.tests.ps1 | 608 | - | attribute-writable final parent must reject installation | - | 정적 |
| test/windows-file-helper.tests.ps1 | 609 | - | attribute-writable empty parent remains unchanged | - | 정적 |
| test/windows-file-helper.tests.ps1 | 630 | - | valid metadata cannot publish before stdin EOF | - | 정적 |
| test/windows-file-helper.tests.ps1 | 634 | - | valid metadata publishes only after stdin EOF | - | 정적 |
| test/windows-file-helper.tests.ps1 | 644 | - | publish metadata | - | 정적 |
| test/windows-file-helper.tests.ps1 | 645 | - | default request applies configured root policy | - | 정적 |
| test/windows-file-helper.tests.ps1 | 646 | - | binary publish bytes | - | 정적 |
| test/windows-file-helper.tests.ps1 | 657 | - | ('atomic overwrite; ' + (Describe-Result $result)) | - | 동적 |
| test/windows-file-helper.tests.ps1 | 658 | - | overwrite retains destination DACL | - | 정적 |
| test/windows-file-helper.tests.ps1 | 659 | - | overwrite retains destination owner | - | 정적 |
| test/windows-file-helper.tests.ps1 | 666 | - | ('overwrite preserves shared-delete reader; ' + (Describe-Result $result)) | - | 동적 |
| test/windows-file-helper.tests.ps1 | 667 | - | replaced file remains readable through retained handle | - | 정적 |
| test/windows-file-helper.tests.ps1 | 671 | - | blocked overwrite preserves destination bytes | - | 정적 |
| test/windows-file-helper.tests.ps1 | 678 | - | ('overwrite copies a differing explicit safe DACL with inheritance enabled; ' + (Describe-Result $result)) | - | 동적 |
| test/windows-file-helper.tests.ps1 | 684 | - | ('overwrite copies a differing protected destination DACL; ' + (Describe-Result $result)) | - | 동적 |
| test/windows-file-helper.tests.ps1 | 686 | - | fixture mandatory low integrity label is set | - | 정적 |
| test/windows-file-helper.tests.ps1 | 688 | - | fixture mandatory label can be read | - | 정적 |
| test/windows-file-helper.tests.ps1 | 690 | - | ('overwrite retains mandatory label; ' + (Describe-Result $result)) | - | 동적 |
| test/windows-file-helper.tests.ps1 | 692 | - | overwrite cannot replace a mandatory low integrity label with its default label | - | 정적 |
| test/windows-file-helper.tests.ps1 | 695 | - | cleanup staged data | - | 정적 |
| test/windows-file-helper.tests.ps1 | 696 | - | cleanup removed only own stage | - | 정적 |
| test/windows-file-helper.tests.ps1 | 697 | - | cleanup idempotent | - | 정적 |
| test/windows-file-helper.tests.ps1 | 702 | - | snapshot metadata | - | 정적 |
| test/windows-file-helper.tests.ps1 | 703 | - | snapshot binary bytes | - | 정적 |
| test/windows-file-helper.tests.ps1 | 713 | - | hash mismatch cannot publish | - | 정적 |
| test/windows-file-helper.tests.ps1 | 714 | - | failed publish removes temporary file | - | 정적 |
| test/windows-file-helper.tests.ps1 | 722 | - | normal mode distinguishes root policy from unsafe path | - | 정적 |
| test/windows-file-helper.tests.ps1 | 723 | - | allowed root metadata comes from helper config, never request | - | 정적 |
| test/windows-file-helper.tests.ps1 | 742 | - | bypass publishes outside an unavailable configured root | - | 정적 |
| test/windows-file-helper.tests.ps1 | 743 | - | outside publish has exact input bytes | - | 정적 |
| test/windows-file-helper.tests.ps1 | 747 | - | bypass snapshots outside configured root | - | 정적 |
| test/windows-file-helper.tests.ps1 | 752 | - | normal cleanup works without configured destination root | - | 정적 |
| test/windows-file-helper.tests.ps1 | 753 | - | cleanup removes stage with unavailable destination root | - | 정적 |
| test/windows-file-helper.tests.ps1 | 779 | - | ('WRITER-ACL-02 shared create-only parent permits publish; ' + (Describe-Result $effectiveResult)) | - | 동적 |
| test/windows-file-helper.tests.ps1 | 780 | - | WRITER-ACL-02 binary bytes are exact | - | 정적 |
| test/windows-file-helper.tests.ps1 | 785 | - | WRITER-ACL-02 shared parent permits snapshot of the pinned regular file | - | 정적 |
| test/windows-file-helper.tests.ps1 | 786 | - | WRITER-ACL-02 directory ACL stays unchanged | - | 정적 |
| test/windows-file-helper.tests.ps1 | 790 | - | WRITER-ACL-02 stage is cleaned | - | 정적 |
| test/windows-file-helper.tests.ps1 | 813 | - | ('WRITER-ACL-03 inherited create rights permit private publish; ' + (Describe-Result $childResult)) | - | 동적 |
| test/windows-file-helper.tests.ps1 | 815 | - | WRITER-ACL-03 inherited directory ACL is unchanged | - | 정적 |
| test/windows-file-helper.tests.ps1 | 818 | - | WRITER-ACL-03 stage is cleaned | - | 정적 |
| test/windows-file-helper.tests.ps1 | 835 | - | WRITER-ACL-04 actual OS open denial is distinct from policy refusal | - | 정적 |
| test/windows-file-helper.tests.ps1 | 836 | - | permission denial cannot report or create published destination | - | 정적 |
| test/windows-file-helper.tests.ps1 | 837 | - | bypass never repairs destination directory permissions | - | 정적 |
| test/windows-file-helper.tests.ps1 | 840 | - | permission-denied publish can clean its stage | - | 정적 |
| test/windows-file-helper.tests.ps1 | 855 | - | concurrent new publish has exactly one winner with either root policy | - | 정적 |
| test/windows-file-helper.tests.ps1 | 856 | - | concurrent publish loser cannot overwrite with either root policy | - | 정적 |
| test/windows-file-helper.tests.ps1 | 887 | - | bounded input | - | 정적 |
| test/windows-file-helper.tests.ps1 | 892 | - | boundary fixture has exactly the maximum input byte count | - | 정적 |
| test/windows-file-helper.tests.ps1 | 893 | - | exact maximum metadata is accepted after EOF | - | 정적 |
| test/windows-file-helper.tests.ps1 | 896 | - | one byte beyond the limit is refused | - | 정적 |
| test/windows-file-helper.tests.ps1 | 899 | - | trailing bytes after JSON are refused | - | 정적 |
| test/windows-file-helper.tests.ps1 | 902 | - | malformed UTF8 is refused before JSON parsing | - | 정적 |
| test/windows-file-helper.tests.ps1 | 906 | - | multibyte fixture isolates the byte bound from the character bound | - | 정적 |
| test/windows-file-helper.tests.ps1 | 938 | - | unsafe cleanup cannot touch target | - | 정적 |
| test/windows-ssh-ci.ps1 | 171 | - | 일회용 키 생성 (Assert-Exit 운영 단계) | - | 정적 |
| test/windows-ssh-ci.ps1 | 180 | - | 호스트 키 지문 계산 (Assert-Exit 운영 단계) | - | 정적 |
| test/windows-ssh-ci.ps1 | 184 | - | 거부 시험용 호스트 키 지문 계산 (Assert-Exit 운영 단계) | - | 정적 |
| test/windows-ssh-ci.ps1 | 327 | - | 격리 SSH 서버 설정 검사 (Assert-Exit 운영 단계) | - | 정적 |
| test/windows-ssh-ci.ps1 | 382 | - | 공식 CLI 설치 전용 시험 (Assert-Exit 운영 단계) | - | 정적 |
| test/windows-ssh-ci.ps1 | 386 | - | 실제 Windows SSH/Python 회귀 시험 (Assert-Exit 운영 단계) | - | 정적 |
| test/windows-ssh-ci.ps1 | 389 | - | 공식 CLI 설치 전용 시험 통과 | - | 정적 |
| test/windows-ssh-ci.ps1 | 390 | - | 실제 Windows OpenSSH/Python 회귀 시험 통과 | - | 정적 |
| test/driver-common.test.ps1 | 17 | - | CURRENT VERSION DEFAULT, EXPLICIT ARCHIVE, MISSING ARCHIVE REFUSAL: PASS | - | 정적 |
| test/compose-driver.sh | 85 | - | Unsupported Compose update unexpectedly succeeded | - | 정적 |
| test/compose-driver.sh | 90 | - | ACTUAL COMPOSE: SSH roundtrip and unchanged image, secrets, and state after rejected update PASS; image update and rollback are unsupported | - | 정적 |
| test/compose-update-ci.sh | 61 | - | A trust record readable by others was unexpectedly accepted | - | 정적 |
| test/compose-update-ci.sh | 67 | - | A symlink trust record was unexpectedly accepted | - | 정적 |
| test/compose-update-ci.sh | 73 | - | An image without a trusted ID was unexpectedly accepted | - | 정적 |
| test/compose-update-ci.sh | 77 | - | A legacy bridge was unexpectedly accepted | - | 정적 |
| test/compose-update-ci.sh | 85 | - | A writable recovery ancestor was unexpectedly accepted | - | 정적 |
| test/compose-update-ci.sh | 92 | - | An existing image without a trusted ID was unexpectedly accepted | - | 정적 |
| test/compose-update-ci.sh | 97 | - | An image containing an untrusted Node preload was unexpectedly accepted | - | 정적 |
| test/compose-update-ci.sh | 110 | - | An existing container with an extra nested mount was unexpectedly accepted | - | 정적 |
| test/compose-update-ci.sh | 123 | - | An existing container with a writable root filesystem was unexpectedly accepted | - | 정적 |
| test/compose-update-ci.sh | 129 | - | An unsupported Compose override was unexpectedly accepted | - | 정적 |
| test/compose-update-ci.sh | 134 | - | A changed Compose user was unexpectedly accepted | - | 정적 |
| test/compose-update-ci.sh | 183 | - | Synthetic ${failure} failure was unexpectedly accepted | - | 동적 |
| test/compose-update-ci.sh | 199 | - | An unnormalized owner path was unexpectedly accepted | - | 정적 |
| test/compose-update-ci.sh | 202 | - | Changed environment was unexpectedly recovered | - | 정적 |
| test/compose-update-ci.sh | 211 | - | Owner retained after confirmed recovery | - | 정적 |
| test/compose-update-ci.sh | 220 | - | Recovery after an unverified restart was unexpectedly accepted | - | 정적 |
| test/compose-update-ci.sh | 230 | - | Changed candidate environment was unexpectedly recovered | - | 정적 |
| test/compose-update-ci.sh | 234 | - | Owner retained after confirmed release recovery | - | 정적 |
| test/compose-update-ci.sh | 242 | - | Ambiguous recovery was unexpectedly accepted | - | 정적 |
| test/compose-update-ci.sh | 250 | - | Verifying explicit recovery using the retained owner | - | 정적 |
| test/compose-update-ci.sh | 261 | - | Check detected concurrent Compose configuration change and retained reservation | - | 정적 |
| test/compose-update-ci.sh | 265 | - | Concurrent configuration change was unexpectedly accepted | - | 정적 |
| test/compose-update-ci.sh | 270 | - | Actual Compose durable image replacement, restart comparison and release PASS | - | 정적 |
| test/container-test.sh | 61 | - | Node suite runner: --test-concurrency=1 (ARM fixture; assertions unchanged, no retries) | - | 정적 |
| test/container-test.sh | 90 | - | Broken candidate unexpectedly installed | - | 정적 |
| test/container-test.sh | 102 | - | INSTALL, CUSTOM PORTS, REINSTALL, SETTINGS/KEY/SUDO/UNIT/AUDIT PRESERVATION, SSH ROUNDTRIP, ROLLBACK, FAILED-START RECOVERY: PASS; baseline=${TEST_HAS_BASELINE:-0} | - | 동적 |
| test/portal-container-test.sh | 65 | - | Node suite runner: --test-concurrency=1 (ARM fixture; assertions unchanged, no retries) | - | 정적 |
| test/portal-container-test.sh | 94 | - | Broken candidate unexpectedly installed | - | 정적 |
| test/portal-container-test.sh | 106 | - | UNIFIED CLI INSTALL, CUSTOM PORTS, REINSTALL, SETTINGS/KEY/SUDO/UNIT/AUDIT PRESERVATION, SSH ROUNDTRIP, ROLLBACK, FAILED-START RECOVERY: PASS; baseline=${TEST_HAS_BASELINE:-0} | - | 동적 |
| test/non-cloudflare-container-test.sh | 3 | - | Isolated root Docker fixture only | - | 정적 |
| test/non-cloudflare-container-test.sh | 26 | - | LOCAL NON-CLOUDFLARE HTTPS/TOKEN/OWNER APPROVAL/SSH/FILE CAPABILITIES: PASS | - | 정적 |
| test/ssh-recovery-red.sh | 23 | - | Pre-fix $case regression unexpectedly passed | - | 동적 |









