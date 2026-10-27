# SSH Approval Portal 1.6.2

[한국어](README.ko.md) · [Administrator sign-in](docs/admin-login.en.md) · [Agent file uploads](docs/agent-upload.en.md) · [Architecture and compatibility](docs/architecture.en.md)

An MCP server for reviewing and approving SSH commands and file transfers. It provides MCP Apps cards for ChatGPT and Claude alongside a web administrator interface. One bridge supports up to 32 registered SSH targets. The unified administrator screen shows requests across targets and lets the owner filter and act on each request. See [target configuration](docs/multi-targets.ko.md).

Jev assists with commands outside the preapproved list. Owner settings determine whether its assessment can lead to automatic approval or requires owner review. A separate [synthetic evaluation tool](docs/jev-observation.ko.md) is also available.

[Secret management (Korean)](docs/secret-management.ko.md) separates secret references from provider adapters. Its first backend is a private POSIX local store managed through a hidden-input operator CLI. Jev resolves a reference at startup; actual values stay out of chat, MCP results, and packages.

Version **1.6.2** adds durable maintenance ownership and post-restart preservation comparison. Existing approval policies and model thresholds are preserved. See `VALIDATION.json` for the exact tested environments and preservation scope; a health check alone does not verify data preservation. Version 1.6.1 added approval/completion waits, assessment failure details, and bounded MCP inputs.

| Area | Verified scope and remaining limits |
| --- | --- |
| ChatGPT web | Actual card approval, denial, and PC file upload/download round trips have been confirmed. |
| Claude desktop app | Actual card approval, denial, and PC file upload/download round trips have been confirmed. |
| ChatGPT desktop and Claude web | Full functionality has not been verified in these clients. |
| ChatGPT `request-upload` | An actual file input reached `upload-source-not-configured` and returned the provider hostname. This observation does not establish provider retrieval, approval, or an SSH round trip. |
| Claude automatic file delivery | The actual test supplied `file_uuid` and an empty `download_url`, failing input validation. Its sandbox HTTPS connection to the destination was also blocked by a proxy CONNECT 403. Automatic transfer is unsupported. |
| Restructuring validation | The non-ARM implementation passed two independent final reviews against Node 94/Linux Python 21 tests, browser regressions, amd64 installation, updates, rollback, Compose, and real SSH roundtrip evidence. The release `VALIDATION.json` records the scope of the 1.0.0 version-change checks. |

The file-provider hostname allowlist starts empty. `BRIDGE_UPLOAD_SOURCE_HOSTS` accepts a comma-separated mix of exact hostnames and leading `*.domain` patterns, for example `files.example.test,*.downloads.example.test` (fictional). A pattern covers one or more subdomain labels at any depth, excludes the apex domain, and matches at a dot boundary. Bare `*`, other wildcard placements, URLs, IP addresses and ports are rejected. Choosing a wildcard means trusting every subdomain it covers; do not broadly allow a shared CDN without verifying that trust scope. Card approval defaults to `BRIDGE_UI_ENABLED=false`, and web administrator authentication defaults to `BRIDGE_ADMIN_AUTH_MODE=token`. Successful tests of an existing client flow do not establish that the new agent-upload path or another platform works.

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

Proven read-only inspections may run immediately. Automatic command and file approvals follow the server policy above; other requests run once after owner approval in a card or the website. Upload bytes reach the target only after automatic or owner approval is established.

Agents provide detailed English `context` for evaluation and a faithful Korean `displayContext` for Korean administrators. The localized explanation is not sent to Jev. Commands and paths remain unchanged. Both explanations are caller claims, not execution authority.

The main tools are listed below. The `ui-*` tools are card-only; approval tickets are not exposed in model responses.

| Tool | Behavior |
| --- | --- |
| `read-command` | Runs commands classified as read-only. |
| `run-command` | Applies server policy for automatic approval or queues a request for owner approval. |
| `get-request-status` and `show-approval` | Retrieve request status and display an approval/denial card. |
| `show-file-transfer` | Displays a card for choosing a PC file to upload or saving a remote file. |
| `request-download` | Automatically prepares a file or asks the owner under server policy. Device saving is separate. |
| `request-upload` | Stages a ChatGPT/OpenAI file input with `download_url` and `file_id`, then queues an upload for approval. A Claude `file_uuid` alone cannot satisfy this input. |
| `show-ui-probe` | Checks card and private-metadata delivery without running a command or file. |

For PC uploads, choose a file in the card and set its destination path, overwrite flag, and sudo flag. The bridge fixes the received bytes' SHA-256 and these settings in the approval request. The new `request-upload` path uses the same approval process. It does not fetch a file until an administrator verifies the provider and allows its exact hostname or a leading `*.domain` pattern. See the [agent-upload guide](docs/agent-upload.en.md) for setup and client limits. Do not substitute login cookies, arbitrary URLs, or file bytes pasted into a conversation.

The single-file limit is 64 MiB, and the default staging budget is 512 MiB. Set `BRIDGE_TRANSFER_MAX_BYTES` to no more than 64 MiB and `BRIDGE_TRANSFER_BUDGET_BYTES` to at least the single-file limit. Directories, links, and device files are rejected. Send a folder as a ZIP file; the server does not automatically extract it or execute uploaded files. File snapshots and downloads do not mask their bytes. Download links expire after 10 minutes and are single-use; request a new link in the card if saving fails.

An overwrite is not reported as complete if the existing file's ownership, mode, or extended attributes cannot be preserved. New files use mode 0600; sudo uploads are owned by root. Changes to the request, file, or server, expiry, and requests lost on restart require a new approval. Connection failures and operations with an uncertain publication result are not retried automatically.

## Native installation and updates

The previous release was validated for Ubuntu 22.04/24.04 on x86_64. The ARM64 installation path remains available, but validation is deferred to a later enhancement. An internet connection and an administrator terminal on the server are required. The runtime requires Node 24.2 or later within the 24.x series. Node 24 is installed in a dedicated path without replacing the system Node installation.

```sh
tar -xzf ssh-approval-portal-1.6.2.tar.gz
cd ssh-approval-portal-1.6.2
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

The website displays pending requests, history, and execution results. After connecting, it refreshes every 10 seconds while the page is visible. Manual refreshes and approval/denial actions refresh immediately. Display language can be automatic, Korean or English and is saved only in this browser. Search retained approval history by request creation date, text, status and target together. Date ranges include both calendar dates in the browser’s local time; blank dates show the full retained period.

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

Approval callbacks: use `wait-for-request` after showing an owner approval request to receive its actual decision without another user chat message. See [callback delivery and limits](docs/approval-callback.ko.md).
