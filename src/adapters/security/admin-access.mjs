import { createRemoteJWKSet, jwtVerify } from 'jose';
import { settingsContract } from '../config/settings.mjs';
import { oidcConfiguration, createOidcAccess } from './oidc-access.mjs';

export function accessConfiguration(env) {
  const mode = env.BRIDGE_ADMIN_AUTH_MODE ?? settingsContract.defaults.BRIDGE_ADMIN_AUTH_MODE;
  if (!['token', 'access', 'oidc'].includes(mode)) throw Error('Invalid administrator authentication mode');
  if (mode === 'token') return { mode };
  if (mode === 'oidc') return oidcConfiguration(env);
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
  if (config.mode === 'oidc') return createOidcAccess(env, keySet);
  // One cached JWKS per application; never follow a key URL supplied by a token.
  const keys = keySet ?? createRemoteJWKSet(new URL(config.issuer + '/cdn-cgi/access/certs'), { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000 });
  const identity=async req=>{
    const token = req.headers['cf-access-jwt-assertion'];
    if (typeof token !== 'string' || token.length > 16384) return false;
    try {
      const { payload } = await jwtVerify(token, keys, { algorithms: ['RS256'], issuer: config.issuer, audience: config.audience,
        requiredClaims: ['exp', 'iat', 'sub', 'email', 'type'], clockTolerance: 5 });
      const valid=payload.type === 'app' && typeof payload.sub === 'string' && payload.sub.length > 0 &&
        payload.iat <= Math.floor(Date.now() / 1000) + 5 && typeof payload.email === 'string' && config.owners.includes(payload.email.toLowerCase());
      if(!valid||payload.sub.length>255||!Number.isSafeInteger(payload.exp)||!Number.isSafeInteger(payload.exp*1000))return null;
      return Object.freeze({subject:JSON.stringify([config.issuer,config.audience,payload.sub]),expiresAt:payload.exp*1000});
    } catch { return false; }
  };
  return {mode:'access',identity,authenticated:async req=>Boolean(await identity(req))};
}
