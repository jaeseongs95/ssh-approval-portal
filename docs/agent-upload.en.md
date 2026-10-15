# Agent file uploads

`request-upload` stages a file supplied by a supported client, measures its size and SHA-256, and queues an immutable upload approval. The agent can supply the file reference, but the owner must approve the card or website before the remote destination changes. Files are never executed and ZIP archives are never extracted.

The implementation uses ChatGPT's official `openai/fileParams` contract. `download_url` and `file_id` are required; `mime_type` and `file_name` are optional. An actual ChatGPT file input reached `upload-source-not-configured` and returned the provider hostname. Provider retrieval, approval, and an SSH round trip remain unverified. [Official file input contract](https://developers.openai.com/plugins/reference#file-apis)

The actual Claude test supplied `file_uuid` and an empty `download_url`, failing input validation. Do not turn `file_uuid` into an invented download URL or treat it as an Anthropic Files API `file_id`. The same Claude sandbox's destination HTTPS connection was blocked by a proxy CONNECT 403. No automatic Claude upload path is provided; use the existing card file picker.

Claude Team and Enterprise organization owners can configure code-execution access to specific domains in `Organization settings > Capabilities`. Custom-domain settings are not guaranteed for personal Free, Pro, or Max plans. A working MCP connection does not establish sandbox egress permission. Do not describe a sandbox push path as supported until domain access and actual raw-byte transfer have each been demonstrated. [Claude file creation and network settings](https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude)

## Initial connection

1. Verify the installed candidate, synchronize Cloudflare Portal capabilities, and refresh the ChatGPT connection's tools.
2. Create or attach a file in ChatGPT and ask: “Use `request-upload` to request uploading this file to `/home/mcpops/reviewed-script.py`.” The host must supply an authorized file reference; do not invent a URL or pass cookies.
3. The initial source allowlist is empty. The tool returns `upload-source-not-configured` and only the source hostname. It neither fetches a file nor queues an approval. An administrator must verify that hostname belongs to the actual file provider. Do not paste the signed URL into chat or logs.
4. On a native server, run this in the administrator terminal and enter only the verified **exact hostname**. Separate multiple hosts with commas. An empty input disables this ingestion path.

```sh
sudo bash /var/lib/ssh-mcp/app/approval-bridge/scripts/configure-upload-sources.sh
```

The script verifies installed files and configuration, reserves maintenance, backs up the configuration, and changes only the source allowlist while preserving secrets, SSH keys, and authentication. It attempts restoration if startup checks fail. Complete or deny pending jobs and transfers first.

5. Supply the same file through a fresh host file input. A successful result is `pending`. Check the name, measured size, SHA-256, destination, overwrite and sudo settings in the card before approving. Compare the downloaded file hash with the original to complete a roundtrip test.

A login-protected source link such as `chatgpt.com/api/library/.../download` is not a substitute for the host's authorized temporary file input. If the host cannot deliver it or Library download fails, the upload is not complete. Do not work around this by passing cookies, allowing arbitrary URLs, or putting file bytes in chat.

## Limits and cancellation

- Maximum single file: 64 MiB. Default total staging budget: 512 MiB. Each import reserves the maximum file size before starting and reduces the reservation to the measured size after completion. At most two external imports run at once.
- Only HTTPS/443, exact configured hostnames and public DNS addresses are accepted. Every DNS answer is checked and the connection is pinned to a validated address. Redirects and compressed responses are refused.
- Default total deadline: 60 seconds; idle timeout: 15 seconds. HTTP disconnect, service shutdown, errors and size violations remove staging and release reservations. An already-running OS DNS lookup cannot be cancelled, but its late result cannot start a connection.
- This server uses stateless MCP. A separate logical cancellation POST is not guaranteed to find the running request. Actual HTTP disconnect, service shutdown and deadlines are enforced independently.
- Existing ten-minute approval expiry and the memory-only queue apply. Restarted requests are never automatically restored or executed.

## Docker configuration

Containers read the same `BRIDGE_UPLOAD_SOURCE_HOSTS` setting, empty by default. An administrator backs up `/etc/ssh-approval-portal/docker-secrets.env`, adds only verified exact hostnames, and recreates the container through the existing maintenance and Compose update procedure. Do not add a Docker socket or extra runtime privileges.

When reverting to an older image, check whether it accepts the new configuration key. Restore the matching protected configuration backup when returning to an image without this feature. The native-only setup script does not manage Docker services.

## Verification scope

Local tests distinguish input schema, network policy, real HTTPS transport, staging cleanup, zero remote execution before approval, and exactly one execution after approval. Actual temporary file URLs, Library delivery, Portal metadata, owner clicks and saving must succeed in the client being claimed. Mock network tests or a public-document download do not establish a successful platform file upload.
