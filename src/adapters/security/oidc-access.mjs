import { createRemoteJWKSet, jwtVerify } from 'jose';
import { validateOrigin } from '../config/settings.mjs';

function endpoint(value) {
  try {
    if (typeof value !== 'string' || value.length > 4096 || /[\s\p{Cc}]/u.test(value)) throw Error();
    const url = new URL(value);
    validateOrigin(url.origin);
    if (url.username || url.password || url.search || url.hash ||
        (value !== url.origin && value !== url.origin + url.pathname)) throw Error();
    return value;
  } catch { throw Error('Configure an exact HTTPS OIDC issuer and JWKS URL'); }
}

export function oidcConfiguration(env) {
  const issuer = endpoint(env.BRIDGE_OIDC_ISSUER), jwksUrl = endpoint(env.BRIDGE_OIDC_JWKS_URL);
  const audience = env.BRIDGE_OIDC_CLIENT_ID;
  const owners = (env.BRIDGE_OIDC_OWNER_EMAILS ?? '').split(',').map(x => x.trim().toLowerCase());
  if (typeof audience !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(audience) || owners.length > 20 ||
      owners.some(x => x.length > 254 || !/^[^\s,@*]+@[^\s,@*]+\.[^\s,@*]+$/.test(x)))
    throw Error('Configure the exact OIDC client ID and owner emails');
  return { mode: 'oidc', issuer, jwksUrl, audience, owners };
}

// The OIDC proxy owns code/state/nonce/PKCE and sessions. The bridge independently
// verifies its forwarded ID token; plain identity headers never grant access.
export function createOidcAccess(env, keySet) {
  const config = oidcConfiguration(env);
  const keys = keySet ?? createRemoteJWKSet(new URL(config.jwksUrl), { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000 });
  return { mode: 'oidc', async authenticated(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ') || header.length > 16391) return false;
    try {
      const { payload } = await jwtVerify(header.slice(7), keys, { algorithms: ['RS256', 'ES256'], issuer: config.issuer, audience: config.audience,
        requiredClaims: ['exp', 'iat', 'sub', 'email', 'email_verified'], clockTolerance: 5 });
      return typeof payload.sub === 'string' && payload.sub.length > 0 && payload.sub.length <= 255 &&
        payload.iat <= Math.floor(Date.now() / 1000) + 5 && payload.email_verified === true &&
        (!Array.isArray(payload.aud) || payload.aud.length === 1 || payload.azp === config.audience) &&
        (payload.azp === undefined || payload.azp === config.audience) &&
        typeof payload.email === 'string' && config.owners.includes(payload.email.toLowerCase());
    } catch { return false; }
  } };
}
