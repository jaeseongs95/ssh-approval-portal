import { validateOrigin } from '../config/settings.mjs';

const fail = (code, details = {}) => Object.assign(new Error(code), { code, ...details });
export const safePortalErrorCode = value => typeof value === 'string' && value === value.trim() && /^[A-Z][A-Z0-9_]{2,63}$/.test(value);

export async function readPortalJson(response) {
  if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw fail('INVALID_PORTAL_RESPONSE');
  const parts = []; let size = 0;
  for await (const bytes of response.body) {
    size += bytes.length;
    if (size > 1024 * 1024) { await response.body.cancel?.().catch(() => {}); throw fail('PORTAL_RESPONSE_TOO_LARGE'); }
    parts.push(bytes);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); }
  catch { throw fail('INVALID_PORTAL_RESPONSE'); }
}

/** Owner-authenticated HTTP only. Credentials and cookies never leave this closure.
 * A single deadline spans bootstrap, transfer and cleanup; no request is retried. */
export function createOwnerHttpSession({ origin, accessToken, signal, timeoutMs = 120_000, fetch: send = globalThis.fetch }) {
  validateOrigin(origin);
  if (typeof accessToken !== 'string' || accessToken.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken)) throw fail('INVALID_ACCESS_CREDENTIAL');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw fail('INVALID_DEADLINE');
  const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), signal].filter(Boolean));
  let cookie, connected = false, connectAttempted = false, retired = false;
  async function request(path, { method = 'GET', body, headers = {}, signal: requestSignal } = {}) {
    if (retired) throw fail('CLIENT_CLOSED');
    const url = new URL(path, origin);
    if (url.origin !== origin || url.username || url.password || url.hash) throw fail('UNTRUSTED_PORTAL_URL');
    try {
      const response = await send(url.href, { method, redirect: 'error', signal: requestSignal ? AbortSignal.any([deadline, requestSignal]) : deadline,
        headers: { ...headers, 'cf-access-token': accessToken, Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
        ...(body === undefined ? {} : { body }) });
      if (!response.ok) {
        let serverCode;
        try {
          // A refusal remains a refusal even when its optional cause is
          // malformed, oversized or unavailable. Never reflect the raw body.
          if (response.status !== 401) {
            const detail = await readPortalJson(response);
            if (safePortalErrorCode(detail?.error)) serverCode = detail.error;
          }
        } catch { /* Preserve the legacy status/code, without an unverified cause. */ }
        finally { await response.body?.cancel().catch(() => {}); }
        throw fail(response.status === 401 ? 'OWNER_REAUTH_REQUIRED' : 'PORTAL_REQUEST_REFUSED',
          { status: response.status, ...(serverCode ? { serverCode } : {}) });
      }
      return response;
    } catch (error) {
      if (['OWNER_REAUTH_REQUIRED', 'PORTAL_REQUEST_REFUSED'].includes(error.code)) throw error;
      throw fail(method === 'GET' ? 'PORTAL_READ_FAILED' : 'PORTAL_RESULT_UNKNOWN');
    }
  }
  const response = (path, body) => request(path, { method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) });
  const json = async (path, body) => readPortalJson(await response(path, body));
  function ready() { if (!connected || retired) throw fail('OWNER_SESSION_REQUIRED'); }
  return {
    signal: deadline, ready, request, response, json,
    async connect() {
      if (connectAttempted || retired) throw fail('OWNER_SESSION_ALREADY_USED');
      connectAttempted = true;
      if ((await json('/api/session')).mode !== 'access') throw fail('ACCESS_MODE_REQUIRED');
      const r = await response('/api/session/start', {});
      const candidates = r.headers.getSetCookie().filter(value => value.startsWith('__Host-ssh_admin_session='));
      if (candidates.length !== 1 || !/^__Host-ssh_admin_session=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=[1-9][0-9]*$/.test(candidates[0])) throw fail('INVALID_OWNER_SESSION');
      cookie = candidates[0].split(';')[0];
      if ((await readPortalJson(r)).connected !== true) throw fail('INVALID_OWNER_SESSION');
      connected = true;
      return { connected: true, mode: 'access' };
    },
    async close() {
      try { if (cookie && !retired) await json('/api/session/logout', {}); }
      finally { retired = true; connected = false; cookie = undefined; accessToken = undefined; }
    },
  };
}
