import { resolveCloudflared, cachedAccessToken } from './cloudflared.mjs';
import { createPortalClient } from './portal-client.mjs';

const publicCodes = new Set(['CLOUDFLARED_NOT_FOUND', 'CLOUDFLARED_NOT_EXECUTABLE', 'CLOUDFLARED_DISCOVERY_LIMIT',
  'INVALID_LOCAL_PATH', 'ACCESS_CREDENTIAL_TIMEOUT', 'ACCESS_CREDENTIAL_TOO_LARGE', 'ACCESS_CREDENTIAL_UNAVAILABLE',
  'INVALID_ACCESS_CREDENTIAL', 'OWNER_REAUTH_REQUIRED', 'ACCESS_MODE_REQUIRED', 'PORTAL_REQUEST_REFUSED',
  'PORTAL_READ_FAILED', 'PORTAL_RESULT_UNKNOWN', 'INVALID_OWNER_SESSION', 'INVALID_PORTAL_RESPONSE', 'PORTAL_RESPONSE_TOO_LARGE']);

export async function diagnoseClient({ origin, cloudflared, env = process.env, runCredential, openClient = createPortalClient }) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const result = { contract: 'portal-client-diagnostic-v1', state: 'blocked',
    runtime: { node: process.versions.node, supported: major === 24 && minor >= 2 },
    origin, checks: [], remoteOperationSubmitted: false, automaticLogin: false, automaticInstall: false,
    message: 'This checks local credentials and a temporary owner session only. It does not upload, execute SSH commands or approve requests.' };
  let client, stage = 'runtime';
  try {
    if (!result.runtime.supported) throw Object.assign(Error(), { code: 'UNSUPPORTED_NODE_VERSION' });
    stage = 'executable';
    result.cloudflared = await resolveCloudflared({ explicit: cloudflared, env });
    result.checks.push({ stage, state: 'configured' });
    stage = 'credential';
    const token = cachedAccessToken(result.cloudflared.path, origin, runCredential);
    result.checks.push({ stage, state: 'available' });
    stage = 'owner-session';
    client = openClient({ origin, accessToken: token, timeoutMs: 30000 });
    await client.connect();
    result.checks.push({ stage, state: 'connected' });
    stage = 'targets';
    const listed = await client.targets();
    if (!Array.isArray(listed?.targets) || listed.targets.length > 256 || listed.targets.some(target =>
      typeof target?.id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(target.id) || typeof target.enabled !== 'boolean'))
      throw Object.assign(Error(), { code: 'INVALID_PORTAL_RESPONSE' });
    result.targets = listed.targets.map(({ id, enabled }) => ({ id, enabled }));
    result.checks.push({ stage, state: 'readable' });
    result.state = 'ready';
    result.next = 'Use upload LOCAL_ABSOLUTE_PATH REMOTE_PATH --target TARGET; follow the returned request ID with status. Pending needs owner approval; queued/running need observation. Never automatically resubmit unknown or failed operations.';
  } catch (error) {
    const code = error.code === 'UNSUPPORTED_NODE_VERSION' || publicCodes.has(error.code) ? error.code : 'DIAGNOSTIC_FAILED';
    result.checks.push({ stage, state: 'blocked', error: code });
    result.next = stage === 'executable' || code.startsWith('CLOUDFLARED_')
      ? 'PATH lookup does not prove cloudflared is uninstalled. Set --cloudflared to an existing trusted absolute executable, or set PORTAL_CLOUDFLARED. No recursive search or install was attempted.'
      : stage === 'credential'
        ? 'The existing cache was not usable; no login was started. After resolving the reported helper error, the user may run cloudflared access login for this exact origin. Never send tokens to the agent.'
        : stage === 'runtime' ? 'Use the package-supported Node.js 24.2 or newer within major 24.'
          : 'Check this exact portal origin and its owner authentication/availability. Local helper presence does not prove remote access. No SSH operation was submitted.';
  } finally {
    try { await client?.close(); }
    catch {
      result.sessionCleanup = 'unknown';
      result.state = 'blocked';
      result.checks.push({ stage: 'session-cleanup', state: 'blocked', error: 'OWNER_SESSION_CLEANUP_UNKNOWN' });
      result.next = 'The temporary session logout result is unknown. Do not repeat the operation automatically; inspect the portal session before proceeding.';
    }
  }
  return result;
}
