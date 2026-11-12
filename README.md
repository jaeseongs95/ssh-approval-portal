# SSH Approval Portal 2.4.2

2.4.2 connects existing MCP tool calls to completion observation through native hooks. Check the release notes for installation status and verification on each host.

Completion hooks: the local client saves status in a durable inbox. Native host hooks deliver it to the agent, with a separate handling ACK; Claude Code uses its background `asyncRewake` hook. See the [client hook guide](docs/client-files.ko.md) for host support, reload requirements and idle limits.


[한국어](README.ko.md) · [Download v2.4.2](https://github.com/jaeseongs95/ssh-approval-portal/releases/tag/v2.4.2) · [Architecture](docs/architecture.en.md) · [MCP contract (Korean)](docs/mcp-tools.ko.md)

Run SSH commands, transfer files and operate real OS desktops through a vendor-neutral MCP server. Agents use a common tool contract; server policy, owner decisions and the target account's permissions govern execution.

- Run Linux shell commands, Windows PowerShell commands and explicitly submitted Python source.
- Upload PC files outside the model context, then use a UUID to place them on an SSH target.
- Observe and control Linux or Windows GUI desktops through agent tools, when the backend and access policy are configured.
- Manage approvals, history, per-target policy and execution capacity in the administrator website.

## Start here

| Your situation | First step | What to confirm |
| --- | --- | --- |
| An administrator has already provided your MCP connection | [Run your first command](#agent) | Actual target ID, revision and capabilities |
| You need to upload a file from this PC | [Use the PC file client](#files) | Existing Node/cloudflared, administrator Access authentication, then a ready UUID |
| You are setting up a new bridge | [Install and connect](#server) | Local service health, protected HTTPS endpoints and an actual MCP response |
| An agent needs a graphical desktop | [Configure GUI access](#gui) | Backend prerequisites and the current TEST policy/secret requirement |

## Components and supported environments

```text
Agent / MCP host ── MCP ──> Linux bridge ── SSH ──> Linux / Windows targets
PC file client ── HTTPS ──> UUID staging ── files copy/move ──> target
Owner browser ── HTTPS ──> approvals, settings and history
```

| Component | Current scope |
| --- | --- |
| Bridge host | Native Ubuntu 22.04/24.04; Node.js >=24.2.0 and <25. The installer prepares its dedicated Node runtime. Windows bridge hosting is not supported. |
| SSH targets | Linux and Windows OpenSSH. Windows needs the target/helper setup described in the [Windows guide (Korean)](docs/windows-targets.ko.md). One bridge supports up to 32 registered targets. |
| PC file client | A separate, portable client archive. Existing Node.js >=24.2.0 and <25, trusted `cloudflared` and owner authentication are required. No npm/global installation or second MCP connection is required. |
| Graphical desktops | Managed Linux X11, Windows RDP through the Linux relay, or configured RFB. GUI runtime support is narrower than general SSH support; see [GUI access](#gui). |
| MCP Apps cards | Optional host-specific UI. The common MCP tools and administrator website remain the path for clients without cards. |

The native installer has an ARM64 path, but physical ARM64 acceptance is not established. The bundled Windows GUI relay runtime targets Ubuntu 24.04 x86_64; it is not a general Ubuntu 22.04/ARM64 compatibility claim.

The contract is vendor-neutral, not a promise that every web, desktop and CLI host implements the same file or UI capabilities. Check `targets` and the actual client response. See [agent clients (Korean)](docs/agent-clients.ko.md).

<a id="agent"></a>
## Run your first command

After connecting to the MCP endpoint supplied by the administrator:

1. Call `targets({})` and select an enabled target. Read its `revision` and capabilities.
2. Call `submit` with a stable `operationKey`. Replace placeholders below with the actual target and revision.
3. Keep the returned `data.id`; call `observe` on that ID until the outcome is known.

`submit` example; `hostname` works on both Linux and Windows:

```json
{
  "kind": "command",
  "operationKey": "readme-hostname-0001",
  "target": "<target-id>",
  "expectedTargetRevision": "<revision-from-targets>",
  "command": "hostname"
}
```

`observe` example; replace the ID with the returned value:

```json
{
  "id": "<request-id>",
  "waitMs": 0,
  "includeOutput": true
}
```

`pending` means owner approval is needed; `queued` means the request is waiting for execution capacity. A timeout while observing does not cancel execution. Continue observing the original ID or operation key; an uncertain result is not a reason to submit a new key.

Commands preserve multiline text and use the target's native shell. `kind:"source"` submits Python separately; `kind:"download"` requests a file snapshot. Use only the fields for that kind: a command request must omit `elevate`, including `elevate:false`. `context` and `displayContext` are optional descriptions, not authentication or language requirements.

Output is read explicitly with `includeOutput:true` and paginated when needed. The current public API does not stream raw output while a command is running. Refer to the [tool contract (Korean)](docs/mcp-tools.ko.md) for states, output pages, execution deadlines and cancellation.

<a id="files"></a>
## Upload a PC file without putting bytes in the model context

Download and extract `ssh-approval-portal-client-2.4.2.zip` or `.tar.gz` from the [release](https://github.com/jaeseongs95/ssh-approval-portal/releases/tag/v2.4.2). Run the entry point from that extracted folder. The portable client works directly from that folder. For a versioned installation, TEST/PROD launchers and Codex, Claude Code or Antigravity Native hooks, use the [client installer](docs/client-install.ko.md): inspect its default read-only plan, then apply it. Existing versions and unrelated host settings are preserved; PATH and authentication are unchanged.

The current client requires an administrator HTTPS origin configured for **Access** mode, an existing trusted `cloudflared` executable and the owner's login cache. MCP authentication and the server's default administrator token mode do not substitute for this authentication.

PowerShell example; replace the origin and paths:

```powershell
$portalFiles = @(
  'scripts/portal-files.mjs',
  '--origin', 'https://approve.example.com',
  '--cloudflared', 'C:/tools/cloudflared.exe'
)
node @portalFiles doctor
node @portalFiles upload --file 'C:/work/package.tar.gz' --operation-key 'package-upload-0001'
```

In hosts with configured native completion hooks, `submit` and `observe` automatically connect background completion watching without running `watch` manually. In hosts without completion hooks, run `node @portalFiles watch REQUEST_ID` through your agent host's background-process tool to keep working while SSH runs. The existing client waits outside the model and prints one terminal event. Completion delivery and automatic resumption depend on the host; see [client completion guidance](docs/client-files.ko.md#작업-완료를-모델-밖에서-기다리기).

`doctor` diagnoses the existing runtime, authentication and connection. It does not log in, upload a file, approve a request or execute SSH commands. Upload success prints one JSON object:

```json
{"uuid":"12345678-1234-4234-8234-123456789abc"}
```

The UUID identifies a temporary server object, not a public filesystem path or completed target placement. Through the **existing remote MCP connection**, call `files` to place it:

```json
{
  "action": "copy",
  "uuid": "<uuid-from-upload>",
  "operationKey": "package-placement-0001",
  "target": "<target-id>",
  "expectedTargetRevision": "<revision-from-targets>",
  "remotePath": "/home/mcpops/package.tar.gz"
}
```

Choose a writable destination on the selected target; Windows paths such as `C:/upload/package.tar.gz` use the same contract. Observe `data.request.id` when returned. If admission is uncertain, inspect the same UUID's status and operations before taking further action.

| Action | Meaning |
| --- | --- |
| `files stat` | Inspect UUID metadata and placement operations. |
| `files copy` | Place a file on the selected target and keep the temporary source. |
| `files move` | Place the file, then consume the source after confirmed publication. |
| `files remove` | Remove the temporary UUID source; already placed target files remain. |

The remote MCP server cannot read a PC path by itself. An agent needs a host with permitted local process/file access to run this client; otherwise the user runs it or uses a supported host file UI. File bytes travel directly from the client to HTTPS rather than being transcribed by the model.

The standalone client provides **`doctor`, `upload`, `status` and `watch`**. It has no download/save command. Server downloads use `submit(kind=download)` and `artifact-read`; saving to the PC requires permitted client code or host UI, followed by a size/hash check. Low-level `artifact-*` tools are available for code that already has the bytes. The per-file ceiling is 64 MiB and the default shared staging budget is 512 MiB. See the [file client guide (Korean)](docs/client-files.ko.md) for configuration, authentication and uncertain transfers.

<a id="server"></a>
## Install and connect a bridge

Choose the path that matches the existing server:

| Server state | Path |
| --- | --- |
| New server without an existing installation | Use the fresh-install example below. |
| Running managed installation with durable maintenance support | Use the supported update/maintenance procedure in the [lifecycle guide (Korean)](docs/install-workflow.ko.md). |
| Stopped existing installation, unsupported legacy layout or a 2.0 history transition | Inspect and plan the transition first; use [deployment, migration and recovery (Korean)](docs/deployment-180.ko.md). Do not treat a fresh install as recovery. |

### Fresh native installation

Prepare an Ubuntu 22.04/24.04 server with Python 3, internet access and an administrator terminal. Download the server archive and `SHA256SUMS` from the [release](https://github.com/jaeseongs95/ssh-approval-portal/releases/tag/v2.4.2), then run on that server:

```sh
sha256sum --check --ignore-missing SHA256SUMS
tar -xzf ssh-approval-portal-2.4.2.tar.gz
cd ssh-approval-portal-2.4.2
python3 scripts/portal.py install --admin-origin https://approve.example.com --dry-run
sudo python3 scripts/portal.py install --admin-origin https://approve.example.com
sudo python3 scripts/portal.py status
```

`--dry-run` displays the commands that would run; it is not a readiness check or an installation. The actual installer prepares a dedicated Node 24 runtime and local service. **Installation does not complete external HTTPS routing, identity-provider configuration or MCP login.**

The default example does not grant unrestricted sudo. The optional `--grant-sudo-all` grants the `mcpops` account passwordless full sudo, including its other sessions; select it only when that authority is intended.

For Linux Docker Compose deployment, use the separate [preparation script](scripts/prepare-docker.sh), [Compose configuration](docker/compose.yaml) and [maintenance procedure (Korean)](docs/maintenance-test-and-recovery.ko.md). Do not run native and Compose services against the same ports and storage simultaneously.

### Connect HTTPS, authentication and targets

The default local endpoints are MCP `http://127.0.0.1:39124/mcp` and administrator `http://127.0.0.1:39125`. Publish them through protected HTTPS routing. Configure owner access and the MCP upstream credential separately; use [installation and connection (Korean)](docs/install-workflow.ko.md) or [HTTPS without Cloudflare (Korean)](docs/non-cloudflare-https.ko.md).

| Boundary | What it authenticates |
| --- | --- |
| MCP connection | The client calling the MCP server; it does not grant access to PC files. |
| Administrator website | The owner reviewing requests/settings. Token mode is the default; Access/OIDC setup is separate. |
| SSH target | The configured remote account and pinned host key; its actual OS permissions apply. |
| Windows GUI credentials | GUI logon for the RDP backend; an SSH public key does not replace them. |

Register and pin each target's host key before use. Target IDs, revision binding and profile configuration are described in [target configuration (Korean)](docs/multi-targets.ko.md); use the current `targets`/`submit`/`observe` names in the [2.0 tool contract (Korean)](docs/mcp-tools.ko.md).

Connect the MCP URL in your agent host, refresh its tool list and verify `targets`. Cards are optional and disabled by default with `BRIDGE_UI_ENABLED=false`. If enabled, their rendering depends on the host's MCP Apps support; app-only `ui-*` actions are not standalone widgets. See [administrator sign-in](docs/admin-login.en.md) for browser sessions. Signing out there ends the current administrator session and preserves MCP authentication.

<a id="gui"></a>
## Agent-operated graphical desktops

GUI tools operate a real OS screen, not a browser terminal. The agent opens a lease, observes a PNG frame, sends explicit text/key/pointer input tied to that frame, observes the result, then closes the lease:

```text
targets → desktop-open → desktop-status / desktop-observe
        → desktop-input → desktop-observe → desktop-close
```

The server must have the backend prerequisites and target configuration. **Current agent GUI access also requires the target's active TEST policy and server-side TEST secret.** Enabling `desktop.enabled` alone is insufficient; administrator GUI access has a different authorization path. Do not enable TEST bypass on production just to obtain GUI access.

- **Linux:** the managed backend creates a dedicated Xvnc/Openbox/xterm X11 session under the SSH account. It is not sharing an existing Wayland screen.
- **Windows:** the Linux relay connects its private FreeRDP runtime through pinned SSH to the Windows RDP service. GUI logon credentials stored through a secret reference are required; use a dedicated account to avoid interfering with human sessions. The bundled native runtime supports Ubuntu 24.04 x86_64.
- **Existing RFB:** share only a deliberately configured trusted session; this does not automatically create or unlock OS sessions.

The user does **not** need to keep a PC RDP window open or maintain the agent's desktop manually. Backend availability, transport connection and an authenticated usable desktop are distinct states. Use the reported state and observe the result of input. Closing a lease is not Windows logout. See [GUI setup (Korean)](docs/desktop.ko.md) and [authentication state (Korean)](docs/desktop-auth-state.ko.md).

<a id="policy"></a>
## Approvals, capacity and TEST mode

Policy is evaluated per target. Preapproved command names permit their options and arguments; deny rules take priority. If a whole command cannot be admitted by policy, configured model assessment may help decide whether to execute automatically or request owner approval. Model assessment is optional, requires explicit disclosure settings and does not inspect transferred file bodies.

Upload, download and sudo automatic approval are separate choices. A UUID, task description or enabled approval switch does not expand the remote account's OS permissions.

The administrator page configures global and per-target **queue capacity** and **concurrent execution**. Initial defaults use the bridge's available CPU count `N`: queue capacity `N × 10`, concurrent execution `N`. Stored administrator settings are retained. Execution waiting is separate from HTTP admission waiting; `queued` is not another approval request.

TEST bypass is off by default. When its dedicated server secret and current target/policy binding are valid, it bypasses assessment, individual approval and the configured allowed-root membership restriction, regardless of command denials and individual automatic-approval switches. Authentication, path-safety checks, actual OS permissions and resource limits remain. It does not change ACLs, create credentials or bypass UAC. Disabling TEST restores the target's regular policy.

<a id="upgrade"></a>
## Upgrade and troubleshoot

2.0 replaces the 1.x public tool contract. Refresh cached MCP tool definitions; use `targets`, `submit` and `observe` instead of legacy `list-targets`, `run-command` and `wait-for-request`.

Existing history migration is supported through the [deployment guide (Korean)](docs/deployment-180.ko.md), subject to its layout, integrity and capacity checks. It preserves source/archive evidence, does not replay uncertain historical requests and does not recreate expired output. `deploy180.mjs` is the retained script name, not the product version. Recovery is explicit; a failed or uncertain deployment is not permission to restore a database or retry blindly.

| Symptom | Next step |
| --- | --- |
| Old tools, `INVALID_ARGUMENT`, or a stale output schema | Refresh the MCP tool list and compare with the current contract. |
| `OPERATION_INPUT_CONFLICT` | Check the fields allowed for the submitted kind; omit `elevate` for commands. |
| Approval needed or `queued` | Inspect the existing request; approve only when required and observe the same ID. |
| Lost connection, deadline or unknown outcome | Inspect the original ID/key and `execution` metadata; do not invent a replacement operation. |
| PC client authentication failure | Run `doctor` with the administrator origin and trusted cloudflared path; distinguish it from MCP login. |
| GUI unavailable or authentication required | Read `desktop-status` and backend prerequisites before sending input. |

<a id="docs"></a>
## Documentation

| Topic | Guide |
| --- | --- |
| Public contract and agent clients | [Tools (Korean)](docs/mcp-tools.ko.md) · [Client capabilities (Korean)](docs/agent-clients.ko.md) |
| PC file uploads | [Client package and UUID files (Korean)](docs/client-files.ko.md) |
| Installation and recovery | [Lifecycle (Korean)](docs/install-workflow.ko.md) · [Migration/recovery (Korean)](docs/deployment-180.ko.md) |
| Administrator authentication | [English](docs/admin-login.en.md) · [한국어](docs/admin-login.ko.md) |
| Target setup | [Multiple targets (Korean)](docs/multi-targets.ko.md) · [Windows (Korean)](docs/windows-targets.ko.md) |
| Graphical desktops | [Setup (Korean)](docs/desktop.ko.md) · [Authentication state (Korean)](docs/desktop-auth-state.ko.md) |
| Secrets and non-Cloudflare routing | [Secret references (Korean)](docs/secret-management.ko.md) · [HTTPS (Korean)](docs/non-cloudflare-https.ko.md) |
| Design and verification | [Architecture](docs/architecture.en.md) · [Test plan (Korean)](test/PLAN.md) · [Local browser testing (Korean)](docs/browser-testing.ko.md) |

Some detailed guides retain versioned historical execution records. Those records describe their pinned environments, not universal acceptance of later releases. Regular v2.0.0 is published; specific host, GUI, file-save and architecture combinations still need their own evidence.

## Development and packaging

Use a source checkout for development; release users do not need to build packages. Server tests belong in the project's authorized TEST/CI environment. Run browser regressions on the local PC as described in the browser guide.

```sh
npm ci --ignore-scripts
npm run build:ui
npm test
python3 test/test_helper.py
```

To generate server/client archives in a **new** absolute output directory:

```sh
npm run package:release -- --output /absolute/new/portal-2.4.2-release
```

The server archive is named `ssh-approval-portal-2.4.2.tar.gz`.

Packaging produces server and client `.tar.gz`/`.zip` assets and checksums. Node.js, cloudflared, credentials and user sessions are not bundled. Source, fixture, live-host, client UI and deployment checks establish different things; an available command is not evidence that a test has passed. Keep published assets immutable and compare the release checksums before use.

## License

SSH Approval Portal is licensed under the [GNU Affero General Public License, version 3 or (at your option) any later version](LICENSE) (SPDX identifier `AGPL-3.0-or-later`). This license applies to version 3.0.0 and to every release published after it, including any later maintenance release of an earlier line.

Releases up to and including 2.4.2 were published under the MIT License. The MIT terms continue to apply only to copies of those already published releases.

Files that carry their own license notice keep that license: `native/freerdp-input/` (Apache-2.0, a patch to FreeRDP) and the Gradle wrapper (`java/gradlew`, `java/gradlew.bat`, `java/gradle/wrapper/`, Apache-2.0).

If you modify the program and let users interact with it over a network, section 13 of the license requires you to offer those users the corresponding source code of your version.
