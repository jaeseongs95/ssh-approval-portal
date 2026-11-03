# Architecture and compatibility

[한국어](architecture.ko.md) · [README](../README.md)

This document describes the responsibilities and public contracts in the 1.8 source. Implemented contracts, observed tests, and real-client or production acceptance require separate evidence. The existence of a feature does not establish release or deployment readiness.

## Layers and composition

| Location | Responsibility | Boundary |
| --- | --- | --- |
| `src/domain/` | Approval/execution transitions, scheduling, capacity, input and desktop lease invariants | No direct filesystem, HTTP, environment or host SDK access. |
| `src/application/` | Command, source, file, history, runtime capacity, desktop and shutdown use cases | Calls injected stores, executors and providers. Adapters construct MCP replies and HTTP statuses. |
| `src/adapters/` | MCP, HTTP, configuration, authentication, audit, SQLite, artifacts, SSH and RFB I/O | Converts external representations and acquires/releases resources. |
| `src/contracts/ports.mjs` | Neutral outcomes, ports and shared limits | Basic `OperationOutcome` fields are `{failed,texts,data?,output?}`. |
| `app.mjs` and `bridge.mjs` | Dependency composition, target services, assets and startup | Do not duplicate domain rules or transport routes. |

Vendor internal imports are localized in `src/adapters/ssh/vendor.mjs`, which checks the `ssh-mcp` 2.18.0 contract. Domain and application code do not expose MCP SDK or vendor profile objects in public results.

## Neutral tools and approval

`src/adapters/mcp/public-contract.mjs` owns input/output schemas and reply validation for `contractVersion: "1.8"`. The model-facing base surface has nine tools.

| Tool | Contract |
| --- | --- |
| `targets` | Target revisions, actual capabilities, file policies and limits |
| `submit` | Submit `command`, explicit Python `source`, or `download` with a stable `operationKey` |
| `observe` | Inspect the same ID or key; include paginated output only when requested |
| `cancel` | Request cancellation of the same operation; inspect its returned state for confirmation |
| `artifact-begin`, `artifact-chunk`, `artifact-status`, `artifact-finish` | Stage and submit authorized bytes bound to size, SHA-256 and target revision |
| `artifact-read` | Read bounded base64 pages of a verified snapshot for a completed download |

When a desktop service is composed, four more tools are registered: `desktop-open`, `desktop-observe`, `desktop-input` and `desktop-close`. Registration alone does not establish target availability: check capabilities and current policy. Existing `show-*` and `ui-*` tools are app-only owner card actions, not a model approval path. Public schemas exclude approval/download tickets and internal host objects.

Neutral tools do not require a separate local CLI, stdio server or card installation. The caller must already possess upload bytes; platform file references do not automatically supply those bytes. See the [agent-upload guide](agent-upload.en.md) for platform limits. Administrator agent CLI installation, login and update are separate use cases, not prerequisites for neutral tools.

Server policy and valid owner approval authorize execution. An ID confirms acceptance, not successful execution. The same key with the same immutable input recovers the same operation; conflicting input is refused. Observation timeout or disconnect does not cancel work. Never use a fresh key to replay an uncertain outcome. `terminating` still represents live execution resources; `unknown` requires reconciliation.

## Durable journal and execution queue

`operations.sqlite`, owned by `src/adapters/storage/operation-store.mjs`, records request keys, immutable execution contracts, target revisions, state versions and events. SQLite transactions and version comparisons protect acceptance, claims and outcomes. `starting` is durable before external execution. A second bridge is refused concurrent execution authority over the same journal. The store itself does not execute SSH commands.

`src/domain/operation-scheduler.mjs` rotates ready targets and applies global and target queue/concurrency limits. `starting`, `running` and `terminating` count as active. On restart these states become `unknown` and are not automatically replayed. Unknown outcomes and conflicting resources have separate constraints. Durable queued work still passes current target revision, policy, expiry and maintenance checks. Old history does not create new execution authority.

Installation defaults use the available CPU count `N` from `os.availableParallelism()`: `queueCapacity=N*10` and `maxConcurrency=N`. `BRIDGE_QUEUE_CAPACITY` and `BRIDGE_MAX_CONCURRENCY` accept positive safe integers. The corresponding `BRIDGE_TARGETS` fields accept numbers or `null`; omitted or `null` values inherit global settings. `requestCapacity` limits retained approval requests separately from the execution queue.

`src/application/runtime-capacity.mjs` and a separate `capacity.sqlite` own live administrator overrides. GET `/api/capacity` returns revision, available CPUs, configured/effective limits and queued/running counts. POST requires `expectedRevision`, persists a compare-and-set and then configures the scheduler. Installation environment values initialize this state; they do not overwrite saved overrides. Global and target limits both apply. Lowering them does not terminate active work. After a lost save reply, the UI requires an explicit fresh read before saving again.

## SSH connections and file lifetime

The SSH registry owns authenticated connection reuse, host keys and ProxyJump. Each execution opens its own exec/SFTP channel without inheriting another operation's shell state. Exhausted channel-open refusals can mark a connection for retirement, but do not interrupt other active channels. Once resources are idle, a later separately authorized operation can acquire a fresh connection. Command exit status, timeout or an uncertain remote outcome never justifies replaying that operation during connection recovery.

`src/adapters/storage/artifacts.mjs` owns staging bytes, reservations, manifests, completion and release. Synchronized bytes and manifests restore acknowledged chunks after restart, roll back unacknowledged tails and quarantine files without metadata for diagnosis. Durable storage does not authorize SSH upload replay. Approval binds filename, size, SHA-256, destination, overwrite, elevation and target revision.

The per-file maximum is 64 MiB, the default staging budget is 512 MiB, approval expiry is one hour, and staging/download links default to ten minutes. Command output follows its separate store's retention timestamps and output references, with a default one-hour TTL. Public output pages contain redacted adapter outcomes and do not guarantee complete remote stdout/stderr capture. Expired or deleted bytes are not regenerated by replaying commands. See [1.8 deployment and migration](deployment-180.ko.md) for legacy history, redeployment and recovery.

## Real OS desktops

`src/application/desktop.mjs` owns an exclusive lease bound to owner, target revision and epoch, with frames and input order. GUI leases are not reassigned through the operation queue or to another owner. The current MCP shared principal requires the target's explicit TEST bypass authority. Administrator HTTP requests receive their authenticated browser principal on the server. A target needs `desktop: {enabled:true,port:...}` and a connected backend before opening succeeds.

The path is administrator UI or MCP → desktop service → RFB adapter → SSH `direct-tcpip` channel → target loopback VNC server. `direct-tcpip` is a forwarding channel inside authenticated SSH. The browser does not connect directly to the target's VNC TCP port. `src/adapters/desktop/rfb.mjs` supports RFB 3.8 Raw/DesktopSize and explicitly enabled None security only. SSH authenticates transport, not other local users on the target. VNC installation, OS login and graphical session creation are outside this adapter. PTY or terminal text does not substitute for OS screen capture.

Observation returns PNG, `frameId`, physical dimensions, `geometryRevision` and the next input sequence. MCP delivers PNG as the image in `content[1]` with JSON frame metadata; administrator HTTP returns PNG base64. Input binds the same session, epoch and observed geometry to a monotonically increasing sequence and stable requestKey. Repeating identical latest input recovers its receipt without wire replay. Uncertain input is never automatically resent under a new key. Close attempts held-key/button release and channel cleanup; inspect `releaseSent` and `cleanupError`. It does not log out the OS or terminate the shared SSH transport.

The administrator viewer supports clicks, shortcuts and text, but not dragging. It converts CSS coordinates to physical framebuffer coordinates once and reserves Tab for browser focus. Navigation and app logout await close; server logout cleans remaining leases for that owner only.

## Administrator UI, authentication and localization

Administrator authentication defaults to `token`. Owner login in `access` mode, file-download capabilities and maintenance tokens retain separate boundaries. `config/settings-contract.json` is the shared configuration contract. Default ports are 39124/39125, with the range 1–65535. JavaScript and Python use Node 24 WHATWG URL behavior as the common origin authority.

File selection, drafts and progress belong to the current view. Earlier asynchronous results must not overwrite a later view, and periodic refresh must preserve focus, selection and scroll. Concurrent logout calls share one attempt; after a lost reply, session termination is retried only on an explicit user request.

`web/src/locale.js` normalizes BCP 47 locales and validates ko/en catalogs, English fallback and named-placeholder syntax. Korean source strings remain message identifiers; their language alone is not a translation defect. A valid unsupported locale uses English messages while retaining its `Intl` number/date formats. Commands, output, policies and user input are not translated. See the [localization specification](i18n.ko.md).

## Validation boundaries

Source boundary tests, real SSH execution, real OS GUI, administrator browser behavior, platform MCP clients, packaging, installation and deployment each require their own evidence. Follow the [verification plan](../test/PLAN.md) for commands and environments. Product tests run on authorized TEST servers or CI. For this task, browser regression ran locally in headless Chromium as explicitly requested by the user.

The 2026-11-03 browser evidence covers 245 unique legacy cases and six new capacity/desktop cases across pinned commits and partial runs. It is not a single complete suite pass at a final SHA. The six new cases use actual administrator DOM interactions with fixture APIs to check inheritance, CAS, response loss, input ordering, close and logout; they do not prove input against an actual VNC server or OS screen. Actual CLI provider installation/login/update, Linux/Windows OS GUI, ChatGPT/Claude cards and file inputs, external sign-in, physical ARM hardware and production deployment each require execution evidence in their own environment. Updating this document does not mark unverified work complete.
