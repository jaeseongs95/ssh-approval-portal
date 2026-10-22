# Administrator sign-in

Token authentication remains the default. Optional `access` mode verifies a human Cloudflare Access assertion and exact owner emails at the origin. It rejects administrator bearer tokens for browser approval APIs. The server token remains available only for deployment maintenance. SSH permissions and MCP connections are unchanged.

## Configure the three providers

1. In Cloudflare Zero Trust → Integrations → Identity providers, configure Cloudflare, Google and GitHub. For an existing team without Cloudflare, add that provider and restrict it to account members.
2. Create a Google web OAuth client with JavaScript origin `https://YOUR_TEAM.cloudflareaccess.com` and redirect URI `https://YOUR_TEAM.cloudflareaccess.com/cdn-cgi/access/callback`. Enter the ID and secret directly into Cloudflare's Google provider and run Test.
3. Create a GitHub OAuth App with the same team homepage and callback. Enter its ID and secret into Cloudflare's GitHub provider, complete Finish setup → Authorize, then Test.
4. In Access controls → Applications → `ssh-approve`, select all three login methods. Avoid single-provider automatic redirects. Allow only exact owner emails. Do not use Everyone or bypass policies. If providers return different owner email addresses, explicitly allow each address in both Access and server configuration.
5. Copy the application's Audience(AUD). Keep provider secrets in Cloudflare; never paste them into chat, origin configuration or the repository. Keep your current administrator session while testing each method in another browser session.

Official guides: [Cloudflare](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/), [Google](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/), [GitHub](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/github/), [JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

## Apply server configuration

Install an audited package containing this feature first. After configuring and testing the providers, stop new requests and approvals and use your administrator terminal:

```bash
sudo bash /var/lib/ssh-mcp/app/approval-bridge/scripts/configure-admin-access.sh
```

Enter the team HTTPS domain, application AUD and owner emails in that terminal. The script checks the installed manifest and unchanged configuration, reserves idle maintenance, preserves tokens/UI/SSH settings, backs up the configuration, switches it atomically and restarts the service. Failed startup checks restore the previous configuration. It does not print secrets. Health alone cannot verify that your real provider login works; complete the checks below.

For Docker, add the same four settings to `/etc/ssh-approval-portal/docker-secrets.env`. Finish requests/transfers and safely stop the container before editing. Preserve secrets, ownership and mode `0600`, then recreate Compose. The native script does not manage Docker restarts.

```dotenv
BRIDGE_ADMIN_AUTH_MODE=access
BRIDGE_ACCESS_TEAM_DOMAIN=https://YOUR_TEAM.cloudflareaccess.com
BRIDGE_ACCESS_AUD=YOUR_APPLICATION_AUD_64_HEX
BRIDGE_ACCESS_OWNER_EMAILS=owner@example.com
```

Keep the existing Tunnel route to loopback port39125 and Access protection. The origin pins team JWKS, issuer, application audience and RS256, checks time and human `sub/email/type` claims, and requires an exact owner email. It never trusts an unsigned email header. The UI does not store JWTs or tokens. Download links also require owner login in Access mode; use browser saving when a host download API cannot forward that session. Actual host saving requires a separate test.

## Administrator browser sessions

Access/OIDC administrator APIs, output and downloads require an application browser session in addition to the existing signed owner identity. Opening the administrator page connects through an exact-Origin `POST /api/session/start`; `POST /api/session/logout` revokes that session only. The server uses an opaque host-only `HttpOnly; Secure; SameSite=Strict` cookie. JavaScript never reads or stores its ID. Expiry cannot exceed the upstream JWT expiry verified at issuance, and a server restart requires a new connection. No configuration, database or authentication key is added. **Reconnect administrator** on the signed-out page starts a new application session using the existing SSO identity.

## Acceptance and recovery

- **Sign out** stops polling, clears displayed requests, revokes only this administrator browser session on the server and opens a local signed-out page. It does not call the global Cloudflare Access or OIDC logout endpoint, so this action preserves Claude/Codex MCP authentication and other administrator browser sessions. An unconfirmed response offers explicit sign-out retry. Token mode clears only the entered token. Previously approved work is neither cancelled nor replayed.
- Test Cloudflare, Google and GitHub in separate fresh browser sessions. Pending requests, history and results must appear without a token field.
- Reject unapproved accounts, unauthenticated requests and wrong-application assertions. Approval/denial POSTs require the exact same Origin.
- Decision/manual refreshes are immediate, periodic refresh is10seconds, and browser `ko*` selects Korean; all other locales select English.
- If locked out, restore the printed `.before-access.*` backup into the native env file and restart from the administrator terminal. Finish active jobs/transfers first. In-memory requests disappear on restart and are never replayed. For Docker, restore the prior secret file and recreate Compose.

Synthetic JWT tests do not prove real provider login. Installation, provider login, approval and file saving require actual acceptance evidence before declaring deployment complete.
# Approval history and display language

Open **Approval history** or `/history` to search retained results and filter by status. Tab navigation keeps the target, search, status filter, page, expanded records and loaded output. Reloading reopens the history route but resets temporary view state. This is not an all-time archive; output is read only after **View output** is clicked.

Under Settings, **Display language** offers automatic detection, Korean and English. **Apply language and reload** stores only this browser preference and reloads the page. Unsaved drafts are cleared; token authentication requires re-entering the administrator token. If storage is unavailable, automatic detection remains active and an error is shown. Commands, raw output, server policies and English Jev evaluation context remain unchanged.

If initial administrator connection fails, select **Reconnect administrator**. This clears only the application cookie and reopens the administrator page. Start requests carrying a revoked or expired cookie cannot automatically create a replacement session.
