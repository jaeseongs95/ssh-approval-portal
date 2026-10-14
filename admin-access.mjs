import { createRemoteJWKSet, jwtVerify } from 'jose';

export function accessConfiguration(env) {
  const mode = env.BRIDGE_ADMIN_AUTH_MODE ?? 'token';
  if (!['token', 'access'].includes(mode)) throw Error('Invalid administrator authentication mode');
  if (mode === 'token') return { mode };
  const issuer = env.BRIDGE_ACCESS_TEAM_DOMAIN;
  const audience = env.BRIDGE_ACCESS_AUD;
  const owners = (env.BRIDGE_ACCESS_OWNER_EMAILS ?? '').split(',').map(x => x.trim().toLowerCase());
  if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer ?? '') ||
      !/^[a-f0-9]{64}$/.test(audience ?? '') || owners.length > 20 ||
      owners.some(x => x.length > 254 || !/^[^\s,@*]+@[^\s,@*]+\.[^\s,@*]+$/.test(x))) throw Error('Configure the exact Access team domain, application AUD and owner emails');
  return { mode, issuer, audience, owners };
}

export function createAdminAccess(env, keySet) {
  const config = accessConfiguration(env);
  if (config.mode === 'token') return { mode: 'token' };
  // One cached JWKS per application; never follow a key URL supplied by a token.
  const keys = keySet ?? createRemoteJWKSet(new URL(config.issuer + '/cdn-cgi/access/certs'), { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000 });
  return { mode: 'access', async authenticated(req) {
    const token = req.headers['cf-access-jwt-assertion'];
    if (typeof token !== 'string' || token.length > 16384) return false;
    try {
      const { payload } = await jwtVerify(token, keys, { algorithms: ['RS256'], issuer: config.issuer, audience: config.audience,
        requiredClaims: ['exp', 'iat', 'sub', 'email', 'type'], clockTolerance: 5 });
      return payload.type === 'app' && typeof payload.sub === 'string' && payload.sub.length > 0 &&
        payload.iat <= Math.floor(Date.now() / 1000) + 5 && typeof payload.email === 'string' && config.owners.includes(payload.email.toLowerCase());
    } catch { return false; }
  } };
}
