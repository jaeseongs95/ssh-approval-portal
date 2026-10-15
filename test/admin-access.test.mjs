import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { accessConfiguration, createAdminAccess } from '../src/adapters/security/admin-access.mjs';
import { updateAccessSettings } from '../scripts/admin-access-config.mjs';
const env = { BRIDGE_ADMIN_AUTH_MODE: 'access', BRIDGE_ACCESS_TEAM_DOMAIN: 'https://fixture.cloudflareaccess.com', BRIDGE_ACCESS_AUD: 'a'.repeat(64), BRIDGE_ACCESS_OWNER_EMAILS: 'Owner@example.test' };
const { privateKey, publicKey } = await generateKeyPair('RS256');
const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'fixture' }] });
const sign = (claims = {}, key = privateKey) => new SignJWT({ type: 'app', email: 'owner@example.test', ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer(claims.iss ?? env.BRIDGE_ACCESS_TEAM_DOMAIN).setAudience(claims.aud ?? env.BRIDGE_ACCESS_AUD).setSubject(claims.sub ?? 'fixture-owner').setIssuedAt(claims.iat ?? Math.floor(Date.now()/1000)).setExpirationTime(claims.exp ?? '5m').sign(key);

test('Access configuration is explicit and pins a team, audience and exact owners', () => {
  assert.deepEqual(accessConfiguration({}), { mode: 'token' });
  for (const value of [{BRIDGE_ADMIN_AUTH_MODE:'other'}, {...env,BRIDGE_ACCESS_TEAM_DOMAIN:'https://evil.test'}, {...env,BRIDGE_ACCESS_TEAM_DOMAIN:'https://fixture.cloudflareaccess.com@evil.test'}, {...env,BRIDGE_ACCESS_TEAM_DOMAIN:env.BRIDGE_ACCESS_TEAM_DOMAIN+'/x'}, {...env,BRIDGE_ACCESS_AUD:''}, {...env,BRIDGE_ACCESS_OWNER_EMAILS:'*'}, {...env,BRIDGE_ACCESS_OWNER_EMAILS:'owner@example.test,'}]) assert.throws(()=>accessConfiguration(value));
});
test('Access settings preserve secrets and line endings, replace only owner authentication keys and reject malformed input', () => {
  for(const newline of ['\n','\r\n']){
    const original=['# fixture','BRIDGE_ADMIN_TOKEN=synthetic-do-not-print','BRIDGE_UI_ENABLED=true','BRIDGE_ADMIN_AUTH_MODE=token','BRIDGE_ACCESS_AUD=old',''].join(newline);
    const next=updateAccessSettings(original,env);
    assert.ok(next.includes('BRIDGE_ADMIN_TOKEN=synthetic-do-not-print'+newline));assert.ok(next.includes('BRIDGE_UI_ENABLED=true'+newline));
    assert.equal(next.split('BRIDGE_ADMIN_AUTH_MODE=').length,2);assert.ok(!next.includes('BRIDGE_ACCESS_AUD=old'));
    assert.equal(updateAccessSettings(next,env),next);
    if(newline==='\r\n')assert.equal(next.replaceAll('\r\n','').includes('\n'),false);
  }
  assert.throws(()=>updateAccessSettings('',{...env,BRIDGE_ACCESS_OWNER_EMAILS:'owner@example.test\nBRIDGE_UI_ENABLED=false'}));
  assert.ok(!updateAccessSettings('',{...env,BRIDGE_ACCESS_OWNER_EMAILS:' Owner@example.test\r\n'}).includes('\r'));
});
test('Signed Access assertions enforce issuer, audience, time, human identity and owner; no header or bearer fallback', async () => {
  const auth = createAdminAccess(env, keys);
  const check = token => auth.authenticated({headers:{'cf-access-jwt-assertion':token}});
  assert.equal(await check(await sign()),true);
  for (const claims of [{iss:'https://other.cloudflareaccess.com'}, {aud:'b'.repeat(64)}, {exp:1}, {nbf:Math.floor(Date.now()/1000)+600}, {iat:Math.floor(Date.now()/1000)+600}, {email:'attacker@example.test'}, {email:null}, {type:'service'}, {sub:''}]) assert.equal(await check(await sign(claims)), false, JSON.stringify(claims));
  const other=await generateKeyPair('RS256');assert.equal(await check(await sign({},other.privateKey)),false);
  const token=await sign();const parts=token.split('.');parts[1]=Buffer.from(JSON.stringify({email:'owner@example.test'})).toString('base64url');assert.equal(await check(parts.join('.')),false);
  assert.equal(await check('malformed'),false);assert.equal(await check('x'.repeat(16385)),false);
  assert.equal(await auth.authenticated({headers:{authorization:'Bearer synthetic-admin','cf-access-authenticated-user-email':'owner@example.test'}}),false);
});
