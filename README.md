# SSH Approval Portal 0.3.0

[한국어](README.ko.md) · [Administrator sign-in](docs/admin-login.en.md) · [Agent file uploads](docs/agent-upload.en.md) · [Architecture and compatibility](docs/architecture.en.md)

An MCP server for reviewing and approving SSH commands and file transfers. It provides MCP Apps cards for ChatGPT and Claude alongside a web administrator interface. Each bridge currently connects to one SSH target. Multi-server support is still at the design stage and is not implemented.

The current version is a **0.3.0 candidate**. Responsibilities are separated into domain, application, and adapter layers while preserving approval rules. Existing client tests, agent-upload observations, and local validation of the restructuring are recorded separately.

| Area | Verified scope and remaining limits |
| --- | --- |
| ChatGPT web | Actual card approval, denial, and PC file upload/download round trips have been confirmed. |
| Claude desktop app | Actual card approval, denial, and PC file upload/download round trips have been confirmed. |
| ChatGPT desktop and Claude web | Full functionality has not been verified in these clients. |
| ChatGPT `request-upload` | An actual file input reached `upload-source-not-configured` and returned the provider hostname. This observation does not establish provider retrieval, approval, or an SSH round trip. |
| Claude automatic file delivery | The actual test supplied `file_uuid` and an empty `download_url`, failing input validation. Its sandbox HTTPS connection to the destination was also blocked by a proxy CONNECT 403. Automatic transfer is unsupported. |
| Local restructuring | Consult the separate validation record for this change's integration results. The earlier candidate's 47 local tests do not establish that the current change passes. |

The file-provider hostname allowlist starts empty. `BRIDGE_UPLOAD_SOURCE_HOSTS` accepts a comma-separated mix of exact hostnames and leading `*.domain` patterns, for example `files.example.test,*.downloads.example.test` (fictional). A pattern covers one or more subdomain labels at any depth, excludes the apex domain, and matches at a dot boundary. Bare `*`, other wildcard placements, URLs, IP addresses and ports are rejected. Choosing a wildcard means trusting every subdomain it covers; do not broadly allow a shared CDN without verifying that trust scope. Card approval defaults to `BRIDGE_UI_ENABLED=false`, and web administrator authentication defaults to `BRIDGE_ADMIN_AUTH_MODE=token`. Successful tests of an existing client flow do not establish that the new agent-upload path or another platform works.

## Approval and file transfers

Ordinary read-only operations and ordinary downloads without sudo run immediately. Every other command, upload, overwrite, and sudo transfer requires the owner's approval in a card or the website and then runs once. No upload bytes are sent to the target server, and no destination file is changed, before approval.

The main tools are listed below. The `ui-*` tools are card-only; approval tickets are not exposed in model responses.

| Tool | Behavior |
| --- | --- |
| `read-command` | Runs commands classified as read-only. |
| `run-command` | Runs read-only commands immediately and queues other commands for approval. |
| `get-request-status` and `show-approval` | Retrieve request status and display an approval/denial card. |
| `show-file-transfer` | Displays a card for choosing a PC file to upload or saving a remote file. |
| `request-download` | Downloads an ordinary file or requests approval for a sudo download. |
| `request-upload` | Stages a ChatGPT/OpenAI file input with `download_url` and `file_id`, then queues an upload for approval. A Claude `file_uuid` alone cannot satisfy this input. |
| `show-ui-probe` | Checks card and private-metadata delivery without running a command or file. |

For PC uploads, choose a file in the card and set its destination path, overwrite flag, and sudo flag. The bridge fixes the received bytes' SHA-256 and these settings in the approval request. The new `request-upload` path uses the same approval process. It does not fetch a file until an administrator verifies the provider and allows its exact hostname or a leading `*.domain` pattern. See the [agent-upload guide](docs/agent-upload.en.md) for setup and client limits. Do not substitute login cookies, arbitrary URLs, or file bytes pasted into a conversation.

The single-file limit is 64 MiB, and the default staging budget is 512 MiB. Set `BRIDGE_TRANSFER_MAX_BYTES` to no more than 64 MiB and `BRIDGE_TRANSFER_BUDGET_BYTES` to at least the single-file limit. Directories, links, and device files are rejected. Send a folder as a ZIP file; the server does not automatically extract it or execute uploaded files. File snapshots and downloads do not mask their bytes. Download links expire after 10 minutes and are single-use; request a new link in the card if saving fails.

An overwrite is not reported as complete if the existing file's ownership, mode, or extended attributes cannot be preserved. New files use mode 0600; sudo uploads are owned by root. Changes to the request, file, or server, expiry, and requests lost on restart require a new approval. Connection failures and operations with an uncertain publication result are not retried automatically.

## Native installation and updates

Requires Ubuntu 22.04/24.04 on x86_64 or arm64, an internet connection, and an administrator terminal on the server. Node 24 is installed in a dedicated path without replacing the system Node installation.

```sh
tar -xzf ssh-approval-portal-0.3.0.tar.gz
cd ssh-approval-portal-0.3.0
sudo bash scripts/install.sh --admin-origin https://ssh-approve.example.com --grant-sudo-all
```

`--grant-sudo-all` grants `mcpops` unrestricted passwordless sudo. This applies to other sessions using that SSH account as well as the approval bridge. Omit the option to use ordinary account permissions. Existing sudo configuration is neither rewritten nor removed.

To update an existing server, run `sudo bash scripts/install.sh` from the new package. Finish or deny pending and running requests first. Existing settings, tokens, and SSH keys are preserved; the first update adds a UI signing key if the installation has none. Restore the previous version with `sudo bash scripts/rollback.sh BACKUP`, using the backup path printed by the installer.

User changes to an existing unit are preserved. An ExecStart outside the managed pattern is not overwritten automatically. The original `ssh-mcp.service` is not installed.

Version 0.3 updates and rollbacks reserve maintenance through the administrator API first. Running or pending requests and incomplete uploads prevent the reservation. Once reserved, new reads, approvals, and transfers are blocked. Version 0.2 has no maintenance API: finish requests, run `sudo systemctl stop ssh-approval-bridge.service` in the administrator terminal, and then install. If the installer is forcibly terminated while maintenance is reserved, release it with `sudo /opt/ssh-approval/node/bin/node scripts/maintenance.mjs release`.

## Connection and card checks

- MCP defaults to localhost port 39124 at `/mcp`; the web administrator interface defaults to localhost port 39125. Set `BRIDGE_MCP_PORT` and `BRIDGE_ADMIN_PORT` in the protected configuration to ports from 1–65535. Maintenance and startup checks use those same values.
- Connect HTTPS domains through Cloudflare Tunnel or an equivalent service. Bind `BRIDGE_MCP_TOKEN` to the Cloudflare Portal upstream Bearer credential and keep an owner-only access policy. Do not bind the administrator token to the upstream.
- `BRIDGE_ADMIN_ORIGIN` must exactly match the canonical HTTPS administrator origin, with a lowercase hostname and no path, trailing slash, query, fragment, or user information. To use another SSH server, configure both read and write profiles for the same server and account, verify and pin its public host key, and prepare the file helper and private remote staging directory on that target.
- Keep the server ID `ssh-approval-bridge` in the Portal's ordinary tool mode. If tool aliases change, check `BRIDGE_UI_TOOL_PREFIX` and the UI tool mapping. Refresh the tools in ChatGPT and connect Claude to the same owner-only Portal URL.
- Call `show-ui-probe`. Confirm that the private marker appears in the card but not in model responses or context. Check each client's UI resource, `_meta`, and app-only tool delivery as well.
- `BRIDGE_UI_ENABLED=false` is the default. Complete the intended environment's tests and an independent audit before changing the root environment setting to true and restarting the service. Do not enable card approval on an unverified platform.
- Administrator secrets are stored in `/etc/ssh-mcp-approval-bridge.env` with mode 0600. Do not send their values to chat or command output. Actual keys and tokens are not included in the package.

## Web administrator interface and sign-in

The website displays pending requests, history, and execution results. After connecting, it refreshes every 10 seconds while the page is visible. Manual refreshes and approval/denial actions refresh immediately. Browser languages starting with `ko` use Korean; all other languages use English.

Administrator-token authentication is the default. Cloudflare, Google, and GitHub sign-in are **web administrator sign-in through Cloudflare Access**; they do not replace SSH login or MCP connection authentication. Configure and test the providers and actual sign-in before explicitly enabling Access mode. See the [administrator sign-in guide](docs/admin-login.en.md) for setup, access restrictions, and recovery.

Signing out stops automatic refresh and clears the displayed requests. Access mode signs out through Cloudflare Access; token mode clears the token entered in the current tab. It does not revoke server tokens or cancel an operation that is already running.

## Docker Compose deployment

The deployment target is Docker Engine with Compose v2 on Ubuntu 22.04/24.04. The bridge runs as a non-root user with a read-only root filesystem and dropped capabilities. Prepare the SSH account, sudo permissions, and file helper on the target server. Do not grant the container `--privileged` or access to the Docker socket. `scripts/prepare-docker.sh` also uses the shared `scripts/ensure-node-runtime.sh` to prepare a host Node 24 runtime in `/opt/ssh-approval/node` without replacing the system Node installation.

```sh
sudo bash scripts/prepare-docker.sh --admin-origin https://ssh-approve.example.com --grant-sudo-all
sudo docker compose --env-file /etc/ssh-approval-portal/compose.env -f docker/compose.yaml build
sudo docker compose --env-file /etc/ssh-approval-portal/compose.env -f docker/compose.yaml up -d --wait
```

To migrate an existing server to Compose, finish requests and stop `ssh-approval-bridge.service` first. Apply the verified native updater first if the installed helper differs. Check that the new Compose service is healthy before disabling automatic startup of the old native unit. Running both deployments on the same server with the same configured ports causes a conflict. The defaults are 39124/39125. Neither deployment installs the original `ssh-mcp.service`.

For prebuilt images, check the actual tag and architecture in the release asset's `VALIDATION.json` first. Load the archive with `sudo docker load -i IMAGE.tar`, set `BRIDGE_IMAGE` in `/etc/ssh-approval-portal/compose.env` to that tag, and add `--no-build` to the Compose startup command above. Images include Node 24.21.0, locked dependencies, and the UI. Choose the correct amd64 or arm64 image. ARM64 emulation tests do not replace tests on physical ARM hardware.

Tokens are provided through `/run/secrets/bridge_config`, not Compose environment variables. The host source is `/etc/ssh-approval-portal/docker-secrets.env`, readable only by the service account. SSH keys and configuration are mounted read-only; audit data and transfer staging use separate writable mounts. Linux host networking preserves the existing localhost SSH and Cloudflare Tunnel paths.

Prepare the new image, then run `sudo bash scripts/compose-update.sh IMAGE_TAG_OR_DIGEST`. The updater reserves maintenance to block new execution before switching and returns to the previous image ID if startup checks fail. Pass the printed previous image ID to the same script to roll back. Do not indiscriminately remove images, transfer staging, or secrets with `docker compose down -v`. Before rolling back to an exact-only version, replace wildcard entries with verified exact hostnames or restore that version's protected configuration backup. Recognizing `BRIDGE_UPLOAD_SOURCE_HOSTS` does not imply support for wildcard values. Restore a compatible protected backup as well when the older image does not recognize the key.

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
