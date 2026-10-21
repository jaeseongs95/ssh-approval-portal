import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, statSync, statfsSync, unlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { accessConfiguration, createAdminAccess } from '../src/adapters/security/admin-access.mjs';
import { updateAccessSettings, restoreAccessSettings } from '../scripts/admin-access-config.mjs';
import { parseSecretText } from '../src/adapters/config/secrets.mjs';
const env = { BRIDGE_ADMIN_AUTH_MODE: 'access', BRIDGE_ACCESS_TEAM_DOMAIN: 'https://fixture.cloudflareaccess.com', BRIDGE_ACCESS_AUD: 'a'.repeat(64), BRIDGE_ACCESS_OWNER_EMAILS: 'Owner@example.test' };
const oidcEnv = {BRIDGE_OIDC_ISSUER:'https://accounts.google.com',BRIDGE_OIDC_JWKS_URL:'https://www.googleapis.com/oauth2/v3/certs',BRIDGE_OIDC_CLIENT_ID:'synthetic-client.apps.googleusercontent.com',BRIDGE_OIDC_OWNER_EMAILS:'Owner@example.test'};
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
test('Owned Access restore preserves original absent/empty keys and rejects later changes or unrelated replacements', () => {
  for (const original of ['', 'BRIDGE_ADMIN_TOKEN=synthetic-keep', 'BRIDGE_ADMIN_AUTH_MODE=\nBRIDGE_ACCESS_AUD=\n',
    '# original\r\nBRIDGE_ADMIN_AUTH_MODE=token\r\nBRIDGE_ADMIN_TOKEN=synthetic-keep\r\n']) {
    const applied = updateAccessSettings(original, env);
    assert.equal(restoreAccessSettings(applied, applied, original), original);
    assert.throws(() => restoreAccessSettings(applied + '# later\n', applied, original));
    assert.throws(() => restoreAccessSettings(applied, applied, original + 'BRIDGE_UI_ENABLED=false\n'));
  }
  assert.throws(() => restoreAccessSettings('', '', ''));
  assert.throws(() => restoreAccessSettings(null, '', ''));
  assert.throws(() => restoreAccessSettings('x'.repeat(65537), '', ''));
});
test('OIDC settings preserve non-owner ENV, quotes and exact restoration; reject invalid input and cross-mode restores',()=>{
  for(const newline of ['\n','\r\n'])for(const audience of ['synthetic.apps.googleusercontent.com',"'quoted'",'"quoted"','a"b\\c#d=e','two\\\\slashes','dollar\\$value']){
    const original=['# fixture','BRIDGE_ADMIN_TOKEN=synthetic-keep','BRIDGE_ACCESS_AUD=legacy-keep','BRIDGE_OIDC_CLIENT_ID=old','BRIDGE_UI_ENABLED=true',''].join(newline);
    const input={...oidcEnv,BRIDGE_OIDC_CLIENT_ID:audience},applied=updateAccessSettings(original,input,'oidc');
    const config=accessConfiguration(parseSecretText(applied));
    assert.equal(config.mode,'oidc');assert.equal(config.audience,audience);assert.deepEqual(config.owners,['owner@example.test']);
    assert.ok(applied.includes('BRIDGE_ADMIN_TOKEN=synthetic-keep'+newline));assert.ok(applied.includes('BRIDGE_ACCESS_AUD=legacy-keep'+newline));assert.ok(applied.includes('BRIDGE_UI_ENABLED=true'+newline));
    assert.equal(updateAccessSettings(applied,input,'oidc'),applied);assert.equal(restoreAccessSettings(applied,applied,original,'oidc'),original);
    assert.throws(()=>restoreAccessSettings(applied+'# changed',applied,original,'oidc'));
    assert.throws(()=>restoreAccessSettings(applied,applied,original+'BRIDGE_UPLOAD_HOSTS=evil.test'+newline,'oidc'));
    assert.throws(()=>restoreAccessSettings(applied,applied,original,'access'));
    if(newline==='\r\n')assert.equal(applied.replaceAll('\r\n','').includes('\n'),false);
  }
  for(const change of [{BRIDGE_OIDC_ISSUER:'http://accounts.google.com'},{BRIDGE_OIDC_JWKS_URL:'https://evil.test?key=1'},{BRIDGE_OIDC_CLIENT_ID:'a\nBRIDGE_UI_ENABLED=false'},{BRIDGE_OIDC_OWNER_EMAILS:'*'}])assert.throws(()=>updateAccessSettings('',{...oidcEnv,...change},'oidc'));
  assert.throws(()=>updateAccessSettings('',oidcEnv,'token'));
  assert.throws(()=>updateAccessSettings('',{...oidcEnv,BRIDGE_OIDC_CLIENT_ID:"a'\"b"},'oidc'),/quoting/);
  for(const original of ['#'+'x'.repeat(65535),'#'+'가'.repeat(21845)]){
    assert.equal(Buffer.byteLength(original),65536);
    for(const mode of ['access','oidc'])assert.throws(()=>updateAccessSettings(original,mode==='oidc'?oidcEnv:env,mode),/too large/);
  }
  for(const mode of ['access','oidc']){
    const values=mode==='oidc'?oidcEnv:env,overhead=Buffer.byteLength(updateAccessSettings('#',values,mode));
    const original='#'+'x'.repeat(65536-overhead);
    assert.equal(Buffer.byteLength(updateAccessSettings(original,values,mode)),65536);
    assert.throws(()=>updateAccessSettings(original+'x',values,mode),/too large/);
  }
});

for(const authMode of ['access','oidc'])test(authMode+' owned staging CLI reads a private managed ENV, compares before writing and keeps secrets out of errors', {
  skip: process.env.CLOUDFLARE_ENV_FIXTURE !== '1' || process.platform !== 'linux'
}, () => {
  assert.ok(existsSync('/.dockerenv'));
  assert.equal(process.getuid(), 0);
  assert.equal(statfsSync('/etc').type, 0x1021994, 'only an explicitly disposable /etc tmpfs');
  const source='/etc/ssh-mcp-approval-bridge.env';
  assert.equal(existsSync(source),false,'never replace an existing managed ENV');
  const work=mkdtempSync('/fixture/admin-access-cli-');
  const original='# 한글 원본 🧪\nBRIDGE_ADMIN_TOKEN=synthetic-cli-secret-preserve\nBRIDGE_UI_ENABLED=true\nBRIDGE_ADMIN_AUTH_MODE=token\n';
  writeFileSync(source,original,{flag:'wx',mode:0o600});
  const inode=statSync(source).ino;
  const run=(mode,input,name)=>spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/admin-access-config.mjs',import.meta.url)),source,work+'/'+name,...(mode?[mode]:[])],
    {input:typeof input==='string'?input:JSON.stringify(input),encoding:'utf8',env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  try {
    const values=authMode==='oidc'?oidcEnv:env;
    const linked=run('--link-owned-'+authMode,{expected:original,values},'linked.env');
    assert.equal(linked.status,0,linked.stderr);
    const applied=readFileSync(work+'/linked.env','utf8');
    assert.equal(applied,updateAccessSettings(original,values,authMode));
    assert.equal(statSync(work+'/linked.env').mode&0o777,0o600);
    const legacy=run(authMode==='oidc'?'--oidc':undefined,values,'legacy.env');
    assert.equal(legacy.status,0,legacy.stderr);
    assert.equal(readFileSync(work+'/legacy.env','utf8'),applied);
    writeFileSync(source,applied);
    const denied=run('--link-owned-'+authMode,{expected:original,values},'denied.env');
    assert.equal(denied.status,1);assert.equal(existsSync(work+'/denied.env'),false);
    const restored=run('--restore-owned-'+authMode,{expected:applied,original},'restored.env');
    assert.equal(restored.status,0,restored.stderr);
    assert.equal(readFileSync(work+'/restored.env','utf8'),original);
    const malformed=run('--restore-owned-'+authMode,'{"expected":"synthetic-cli-secret-preserve','malformed.env');
    assert.equal(malformed.status,1);assert.equal(existsSync(work+'/malformed.env'),false);
    const oversized=run('--restore-owned-'+authMode,'x'.repeat(524289),'oversized.env');
    assert.equal(oversized.status,1);assert.equal(existsSync(work+'/oversized.env'),false);
    assert.equal(readFileSync(source,'utf8'),applied,'staging itself never updates the live ENV');
    const full='#'+'x'.repeat(65535);writeFileSync(source,full);
    const tooLarge=run('--link-owned-'+authMode,{expected:full,values},'too-large.env');
    assert.equal(tooLarge.status,1);assert.equal(existsSync(work+'/too-large.env'),false);assert.equal(readFileSync(source,'utf8'),full);
    for(const child of [linked,legacy,denied,restored,malformed,oversized,tooLarge])assert.equal((child.stdout+child.stderr).includes('synthetic-cli-secret-preserve'),false);
  } finally {
    assert.equal(statSync(source).ino,inode,'only remove the source created by this fixture');
    unlinkSync(source);
    assert.ok(work.startsWith('/fixture/admin-access-cli-'));
    rmSync(work,{recursive:true});
  }
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
