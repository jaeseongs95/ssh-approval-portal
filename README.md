# SSH Approval Portal 2.0.0

[한국어](README.ko.md) · [Connection and tool contract](docs/mcp-tools.ko.md) · [Administrator sign-in](docs/admin-login.en.md) · [File client guide (Korean)](docs/client-files.ko.md) · [Architecture](docs/architecture.en.md)

A standard MCP server for SSH commands, file transfers and OS desktops under existing server policy and owner approval. Its public contract is independent of AI vendors and agent SDKs. Start with `targets` to inspect revisions, platforms, capabilities and file policy; use `submit` and `observe` for the same operation. MCP Apps cards are optional. One bridge supports up to 32 registered SSH targets. See the [tool contract](docs/mcp-tools.ko.md) and [target configuration](docs/multi-targets.ko.md).

The 2.0.0 scope includes the packaged `scripts/portal-files.mjs` client. The local CLI reads PC bytes and sends them over owner-authenticated HTTP, printing only `{"uuid":"..."}` on upload success. File bodies do not pass through model arguments or conversation text. Through the existing remote MCP connection, an agent supplies that UUID to `files` for status, copy, move or removal of the temporary source. A second local stdio server is optional. A remote server cannot directly read a PC path. Follow the [file client guide](docs/client-files.ko.md) for authentication and usage.

The UUID server/client path is part of 2.0.0 integration work. Contract descriptions do not establish a final full-suite, package, installation, deployment or all-vendor acceptance result. Earlier ChatGPT web/Claude desktop card and file round trips and older restructuring tests apply only to their recorded releases. Unverified combinations, including ChatGPT desktop and Claude web, remain unverified. Use the candidate's `VALIDATION.json` and execution records for environment and preservation evidence.

See [Windows target configuration](docs/windows-targets.ko.md) for PowerShell, files, Python and server CLI prerequisites. Hosting the bridge on Windows remains later scope. Jev is an auxiliary assessment provider for commands outside the preapproved list. [Secret management](docs/secret-management.ko.md) passes references rather than values in chat, MCP results or packages. Cards default to `BRIDGE_UI_ENABLED=false`; administrator authentication defaults to `BRIDGE_ADMIN_AUTH_MODE=token`.

## How automatic approval works

**Preapprove recurring commands, and use AI to review commands outside that list.** Settings apply to each server separately.

1. **Register command names.** Choose names such as `ls` and `pwd`, read the risk feedback, then confirm **OK → Save**. Do not enter options or arguments.
2. **Check the complete command line.** If **every executable name is preapproved, run without Jev or another approval**. If any name is missing or the syntax cannot be resolved, send the complete command line and task context to Jev.
3. **Apply the model gate.** Model-based automatic approval and external disclosure must be enabled. The assessment must classify the command as low risk and meet the saved low-risk score threshold. Other outcomes—including insufficient context, a low score or evaluation failure—require owner approval.
4. **Ask the owner when needed.** Pending requests expire after one hour. History labels automatically admitted requests as **Automatic approval**.

With only `ls` and `pwd` registered:

| Request | Result |
| --- | --- |
| `pwd && ls -la` | Both names are registered → run without Jev |
| `pwd && uptime` | `uptime` is unregistered → evaluate the entire line, then approve automatically or ask the owner |

**Approving a command name permits its options and arguments too.** This is not an argument restriction; review the capabilities before registration. Denied names take priority. Disabling model-based approval leaves preapproved-command bypass active. Model scores are not measured incident probabilities or safety guarantees.

**Uploads, downloads and sudo have separate important settings.** Only new ordinary uploads can be automatic; overwrites and elevated uploads still need individual approval. Sudo commands need the sudo opt-in before entering the flow above; elevated downloads need both download and sudo opt-ins. Jev does not inspect file contents. A prepared download must still be saved to the device. No option expands the SSH account's actual permissions.

## Approval and file transfers

Server policy and valid owner approval authorize execution. Agents may supply detailed English `context` and a faithful Korean `displayContext`; these are caller claims, not authority. Acceptance, approval, remote completion and saving to the PC are separate states.

| Tool | Behavior |
| --- | --- |
| `targets` | Inspect revisions, platforms, capabilities, file policy and limits. |
| `submit` | Submit `command`, Python `source` or `download` using a stable `operationKey`. |
| `observe`, `cancel` | Observe the same ID/key; request cancellation by existing ID. Read output only with `includeOutput:true`. |
| `files` | The 2.0 contract for UUID `stat`, target `copy`/`move` and temporary-source `remove`. |
| `artifact-begin/chunk/status/finish` | Stage already available small bytes bound to target, size and SHA-256, then submit through file approval policy. |
| `artifact-read` | Read bounded base64 pages of a completed download snapshot. Use the packaged client for large PC files. |
| `desktop-open/status/observe/input/close` | Manage real OS desktop leases, readiness, PNG frames, explicit input and close. |

A UUID upload confirms temporary storage, not placement on an SSH target. `copy` retains the source; `move` consumes it after confirmed publication. `remove` affects only that temporary UUID object. Placement retains approval, revision, path, OS-permission and TEST policies. Replies exclude internal staging paths; possession of a UUID is not authority. See the [public contract](docs/mcp-tools.ko.md).

The three `show-ui-probe`, `show-approval` and `show-file-transfer` tools are model-visible card openers with a rendering UI resource. Only the six `ui-*` tools are app-only, with no rendering resource and tickets in private metadata. Clients without cards can use public MCP and the administrator website. Legacy `read-command`, `run-command`, `request-upload` and setup names are not current public tools.

The single-file limit is 64 MiB and default staging budget is 512 MiB. `BRIDGE_TRANSFER_MAX_BYTES` must not exceed 64 MiB; `BRIDGE_TRANSFER_BUDGET_BYTES` must cover one maximum-sized file. Directories, links and device files are rejected. ZIP files are not automatically extracted and uploads are not automatically executed. Follow returned retention/expiry state. File bytes themselves are not redacted in transfer.

Linux overwrites do not report completion unless existing ownership, mode and extended attributes can be preserved. New files use mode 0600; sudo uploads are root-owned. See [Windows transfer limits](docs/windows-targets.ko.md). Observation timeout or connection failure does not establish cancellation or non-execution. Inspect the original UUID, operationKey and request ID; never replay uncertain placement under a new key.

## Native installation and updates

The previous release was validated for Ubuntu 22.04/24.04 on x86_64. The ARM64 installation path remains available, but validation is deferred to a later enhancement. An internet connection and an administrator terminal on the server are required. The runtime requires Node 24.2 or later within the 24.x series. Node 24 is installed in a dedicated path without replacing the system Node installation.

```sh
tar -xzf ssh-approval-portal-2.0.0.tar.gz
cd ssh-approval-portal-2.0.0
sudo bash scripts/install.sh --admin-origin https://ssh-approve.example.com --grant-sudo-all
```

`--grant-sudo-all` grants `mcpops` unrestricted passwordless sudo. This applies to other sessions using that SSH account as well as the approval bridge. Omit the option to use ordinary account permissions. Existing sudo configuration is neither rewritten nor removed.

For an existing server, use `sudo bash scripts/install.sh` from the new package after checking the maintenance and recovery procedure. Existing settings, tokens, and SSH keys are preserved; the first update adds a UI signing key if the installation has none. The installer does not automatically roll back to a version that cannot enforce durable maintenance. First upgrades from older versions need a separate verified offline procedure.

User changes to an existing unit are preserved. An ExecStart outside the managed pattern is not overwritten automatically. The original `ssh-mcp.service` is not installed.

Maintenance reservation requires an owner token and blocks new work on cooperating paths. Running or pending requests and incomplete uploads prevent reservation. If the installer is interrupted or the result is unknown, retain its protected owner file and inspect the actual state before recovery; do not blindly release the reservation. Non-cooperating root processes and older versions can bypass this protection. See [maintenance testing and recovery](docs/maintenance-test-and-recovery.ko.md).

## Connection and card checks

- MCP defaults to localhost port 39124 at `/mcp`; the web administrator interface defaults to localhost port 39125. Set `BRIDGE_MCP_PORT` and `BRIDGE_ADMIN_PORT` in the protected configuration to ports from 1–65535. Maintenance and startup checks use those same values.
- Connect HTTPS domains through Cloudflare Tunnel or an equivalent service. Bind `BRIDGE_MCP_TOKEN` to the Cloudflare Portal upstream Bearer credential and keep an owner-only access policy. Do not bind the administrator token to the upstream.
- 여러 SSH 대상 등록·고정 기본 대상·승인 결속과 전역 한도는 [다중 대상 설정](docs/multi-targets.ko.md)을 참고하세요.
- `BRIDGE_DISPLAY_NAME`과 `BRIDGE_TARGET_DISPLAY_NAME`은 관리자 탭·화면과 승인·결과 카드에 표시할 중계기 및 SSH 대상 이름입니다. 생략하면 공개 관리자 호스트명과 `SSH`를 사용합니다. 앞뒤 공백을 제거하며, 최대 80 UTF-16 코드 단위이고 제어·서식 문자는 허용하지 않습니다. 인증 전에도 표시될 수 있으므로 비밀·계정·키 경로를 넣지 마세요. 이름은 실행 대상이나 승인 권한을 바꾸지 않습니다.
- `BRIDGE_ADMIN_ORIGIN` must exactly match the canonical HTTPS administrator origin, with a lowercase hostname and no path, trailing slash, query, fragment, or user information. To use another SSH server, configure both read and write profiles for the same server and account, verify and pin its public host key, and prepare the file helper and private remote staging directory on that target.
- Keep the server ID `ssh-approval-bridge` in the Portal's ordinary tool mode. If tool aliases change, check `BRIDGE_UI_TOOL_PREFIX` and the UI tool mapping. Refresh the tools in ChatGPT and connect Claude to the same owner-only Portal URL.
- Call `show-ui-probe`. Confirm that the private marker appears in the card but not in model responses or context. Check each client's UI resource, `_meta`, and app-only tool delivery as well.
- `BRIDGE_UI_ENABLED=false` is the default. Complete the intended environment's tests and an independent audit before changing the root environment setting to true and restarting the service. Do not enable card approval on an unverified platform.
- Administrator secrets are stored in `/etc/ssh-mcp-approval-bridge.env` with mode 0600. Do not send their values to chat or command output. Actual keys and tokens are not included in the package.

## Web administrator interface and sign-in

The website displays pending requests, history, and execution results. After connecting, it refreshes every 10 seconds while the page is visible. Manual refreshes and approval/denial actions refresh immediately. Approval acceptance immediately releases the page controls; subsequent reads show execution completion or failure. Acceptance does not mean successful execution. Display language can be automatic, Korean or English and is saved only in this browser. Search retained approval history by request creation date, text, status and target together. Date ranges include both calendar dates in the browser’s local time; blank dates show the full retained period.

Administrator-token authentication is the default. Cloudflare, Google, and GitHub sign-in are **web administrator sign-in through Cloudflare Access**; they do not replace SSH login or MCP connection authentication. Configure and test the providers and actual sign-in before explicitly enabling Access mode. See the [administrator sign-in guide](docs/admin-login.en.md) for setup, access restrictions, and recovery.

Signing out stops automatic refresh and clears the displayed requests. Access mode signs out through Cloudflare Access; token mode clears the token entered in the current tab. It does not revoke server tokens or cancel an operation that is already running.

## Docker Compose deployment

The deployment target is Docker Engine with Compose v2 on Ubuntu 22.04/24.04. The bridge runs as a non-root user with a read-only root filesystem and dropped capabilities. Prepare the SSH account, sudo permissions, and file helper on the target server. Do not grant the container `--privileged` or access to the Docker socket. `scripts/prepare-docker.sh` also uses the shared `scripts/ensure-node-runtime.sh` to prepare a host Node 24 runtime in `/opt/ssh-approval/node` without replacing the system Node installation.

```sh
python3 scripts/package.py --release
sudo bash scripts/prepare-docker.sh --admin-origin https://ssh-approve.example.com --grant-sudo-all
sudo docker compose --env-file /etc/ssh-approval-portal/compose.env -f docker/compose.yaml build
sudo docker compose --env-file /etc/ssh-approval-portal/compose.env -f docker/compose.yaml up -d --wait
```

To migrate an existing server to Compose, finish requests and stop `ssh-approval-bridge.service` first. Apply the verified native updater first if the installed helper differs. Check that the new Compose service is healthy before disabling automatic startup of the old native unit. Running both deployments on the same server with the same configured ports causes a conflict. The defaults are 39124/39125. Neither deployment installs the original `ssh-mcp.service`.

For prebuilt images, check the actual tag and architecture in the release asset's `VALIDATION.json` first. Load the archive with `sudo docker load -i IMAGE.tar`, set `BRIDGE_IMAGE` in `/etc/ssh-approval-portal/compose.env` to that tag, and add `--no-build` to the Compose startup command above. Images include Node 24.21.0, locked dependencies, and the UI. Choose the correct amd64 or arm64 image. ARM64 emulation tests do not replace tests on physical ARM hardware.

Tokens are provided through `/run/secrets/bridge_config`, not Compose environment variables. The host source is `/etc/ssh-approval-portal/docker-secrets.env`, readable only by the service account. SSH keys and configuration are mounted read-only; audit data and transfer staging use separate writable mounts. Linux host networking preserves the existing localhost SSH and Cloudflare Tunnel paths.

Compose updates support a limited configuration: the running bridge must support durable maintenance, both images must have independently verified identities registered in the protected trust directory, and the default host bind storage and runtime constraints must match. The updater reserves maintenance, compares preservation after the new container starts, and releases only after confirmation. Failure or an unknown result retains the reservation and owner file; it does not automatically roll back to an older image. Legacy upgrades, Compose overrides and custom storage need a separately verified procedure. See [maintenance testing and recovery](docs/maintenance-test-and-recovery.ko.md) for exact constraints and recovery. Do not indiscriminately remove images, transfer staging, or secrets with `docker compose down -v`.

## Verification and status

These commands belong in authorized TEST/CI environments; they were not run for this documentation change. Final 2.0.0 client, package, installation and deployment results need their own pinned commit and execution evidence.

```sh
npm ci --ignore-scripts
npm run build:ui
npm test
npx playwright install chromium
npm run test:browser
python3 test/test_helper.py
sudo bash scripts/status.sh
```

Build the UI with its separate `ui` dependencies without upgrading the server SDK. Rebuild distributable assets with `npm run build:ui` after changing UI or web modules. See the [architecture guide](docs/architecture.en.md) and [verification plan](test/PLAN.md) for boundaries, compatibility, and future test requirements. `test/docker-tests.ps1` creates and cleans up isolated Ubuntu containers with synthetic data. Record actual client card/file-save tests, platform file-input tests, and physical ARM hardware tests as complete only when each has its own execution evidence.

Verify the release's `release-manifest.json` and `SHA256SUMS`. Packages exclude node_modules, actual configuration, tokens, private keys, and user sessions. Read the candidate's test records together with the verification limits above. Publishing and Cloudflare configuration changes are not performed automatically.

Use `observe` with `waitMs` for public waits. `waitTimedOut` limits observation and does not authorize replay. The [older callback guide](docs/approval-callback.ko.md) retains historical tool names.

The **Test server** checkbox in the important automatic-approval settings bypasses risk assessment and individual approval for that target's commands, Python source, CLI installation and file transfers. It overrides command denials and other automatic-approval switches and is off by default. Administrators decide which targets are test servers. Authentication, target binding, input/file validation, SSH account permissions and maintenance/concurrency limits remain enforced. Disabling it restores the existing policy.

Test bypass additionally requires a dedicated value in the existing secret store and server-only `BRIDGE_TEST_SERVER_SECRET_REF=secret://local-file/test-server`. The operator provisions a 64-character lowercase hexadecimal value through the existing hidden-input TTY registration CLI, only on the test portal. This reference cannot be edited through the administrator ENV UI/API. The value is never returned to UI/API/MCP or logs; the existing resolver rechecks it before policy review, save and execution. Missing, malformed or unreadable references/values reject activation and bypass execution.
