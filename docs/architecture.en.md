# Architecture and compatibility

[한국어](architecture.ko.md) · [README](../README.md)

This document describes responsibilities and validation requirements for the 0.3.0 restructuring candidate. The presence of files or a new structure does not establish passing integration tests, real-client acceptance, or deployment validation.

## Three layers and composition

| Location | Responsibility | Boundary |
| --- | --- | --- |
| `src/domain/` | Approval state transitions, invariants, and input validation | No filesystem, HTTP, environment, or host SDK dependencies. |
| `src/application/` | Command, file, maintenance, and shutdown use cases | Calls injected queues, stores, executors, and file sources. Does not construct MCP responses or HTTP statuses. |
| `src/adapters/` | MCP, HTTP, public results, authentication, configuration, audit, storage, HTTPS sources, and SSH | Converts external representations to internal contracts and owns I/O. |
| `src/contracts/ports.mjs` | Neutral outcomes, port contracts, and shared limits | `OperationOutcome` is `{failed,texts,data?}`. |
| `app.mjs` and `bridge.mjs` | Dependency composition, asset loading, and process startup | Do not duplicate domain rules or HTTP routes. |

Internal `Job.result` uses the neutral outcome. Public presenters convert it to the existing `content`, `isError`, and `structuredContent` representation. Legacy injected command callback results are normalized at composition. Vendor deep imports are localized in `src/adapters/ssh/vendor.mjs`.

## Behavior to preserve

Remote upload execution must occur zero times before approval and once after audit persistence and a valid owner approval. Expiry or audit failure must never restore execution permission. Immediate read failures also attempt a terminal audit and never expose raw internal errors in ordinary responses.

The artifact store owns reservation, completion, release, and download completion. Application code does not mutate its internal state. Upload approvals bind filename, size, SHA-256, destination, overwrite, and sudo flags. The 64 MiB file limit, default 512 MiB staging budget, ten-minute expiry, and no automatic replay after restart remain in force.

Preserve MCP tool names, public Job fields, error distinctions, and app-only card tools. Approval and download capabilities stay in their existing private delivery channel, outside public output schemas. Register top-level object output schemas accepted by the SDK and validate actual response variants in presenters. Preserve the timing distinction between an MCP running response and the website waiting for completion.

Administrator authentication defaults to `token`. Preserve the separate requirements for owner login, file-download capabilities, and maintenance tokens in `access` mode. `config/settings-contract.json` holds defaults and allowed keys; JavaScript and Python consumers share origin and port validation. Port defaults are 39124/39125, with a supported range of 1–65535. Origin validation uses Node 24's WHATWG URL implementation as its single authority; Python's `settings_contract.validate_origin` also calls `scripts/validate-origin.mjs` without a shell and supplies the value only on stdin.

Card file selection and progress belong to their current view. Earlier asynchronous work must not overwrite a later view. Periodic web refresh must not unnecessarily erase another request's focus, selection, or scroll. Verify these behaviors in a real browser separately.

## Changes and validation

Implement features against neutral internal contracts; handle host file references and response shapes in adapters. Do not accept Claude `file_uuid` or an empty URL as an OpenAI file input. Add a provider only after verifying its actual delivery contract and network access. See the [agent-upload guide](agent-upload.en.md) for current limits.

Run the affected boundary tests after source changes and rebuild UI and web assets. Node, Python, browser, Linux, native, Docker, and Compose validation provide separate evidence. Check non-default ports through maintenance, health, update, and rollback; preserve configured image choices; verify atomic secret persistence and notices for nested dependency versions. Commands and required checks are in the [verification plan](../test/PLAN.md).

Real ChatGPT and Claude cards, platform file inputs, Google/GitHub/Cloudflare sign-in, physical ARM hardware, and production deployment each need their own observed evidence. Local success does not establish these results. The current task covers local changes, validation, and a default-branch merge; a public release, remote push, or production deployment requires separate approval.
