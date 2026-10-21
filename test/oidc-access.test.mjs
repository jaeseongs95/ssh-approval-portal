import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { accessConfiguration, createAdminAccess } from '../src/adapters/security/admin-access.mjs';
import { authorizeAdminRequest } from '../src/adapters/security/admin-policy.mjs';
const env = { BRIDGE_ADMIN_AUTH_MODE: 'oidc', BRIDGE_OIDC_ISSUER: 'https://idp.example.test/realms/portal', BRIDGE_OIDC_JWKS_URL: 'https://idp.example.test/realms/portal/certs', BRIDGE_OIDC_CLIENT_ID: 'portal-client', BRIDGE_OIDC_OWNER_EMAILS: 'Owner@example.test' };
const {privateKey, publicKey} = await generateKeyPair('RS256');
const keys = createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'fixture'}]});
const sign = (claims={}, key=privateKey, alg='RS256') => new SignJWT({email:'owner@example.test',email_verified:true,...claims}).setProtectedHeader({alg,kid:'fixture'}).setIssuer(claims.iss??env.BRIDGE_OIDC_ISSUER).setAudience(claims.aud??env.BRIDGE_OIDC_CLIENT_ID).setSubject(claims.sub??'owner').setIssuedAt(claims.iat??Math.floor(Date.now()/1000)).setExpirationTime(claims.exp??'5m').sign(key);

test('OIDC configuration pins HTTPS issuer, independent JWKS, client and exact owners',()=>{
  assert.equal(accessConfiguration(env).mode,'oidc');
  for(const field of ['BRIDGE_OIDC_ISSUER','BRIDGE_OIDC_JWKS_URL'])for(const value of ['', 'http://idp.example.test', 'https://owner@idp.example.test', 'https://idp.example.test?key=1', 'https://idp.example.test#x', 'https://IDP.example.test', 'https://idp.example.test/a/../b', 'https://idp.example.test\n'])assert.throws(()=>accessConfiguration({...env,[field]:value}));
  for(const value of ['', 'wild*@example.test','owner@example.test,','@example.test','x\n@example.test'])assert.throws(()=>accessConfiguration({...env,BRIDGE_OIDC_OWNER_EMAILS:value}));
  for(const value of ['', 'client\nvalue','a'.repeat(513)])assert.throws(()=>accessConfiguration({...env,BRIDGE_OIDC_CLIENT_ID:value}));
});

test('OIDC enforces signature, issuer, audience/authorized party, verified human owner and claim times',async()=>{
  const auth=createAdminAccess(env,keys),check=token=>auth.authenticated({headers:{authorization:'Bearer '+token}});
  assert.equal(await check(await sign()),true);
  assert.equal(await check(await sign({aud:['portal-client','other'],azp:'portal-client'})),true);
  for(const claims of [{iss:'https://evil.example.test'}, {aud:'other'}, {aud:['portal-client','other']}, {azp:'other'}, {exp:1}, {iat:Math.floor(Date.now()/1000)+600}, {nbf:Math.floor(Date.now()/1000)+600}, {sub:''}, {email:'foreign@example.test'}, {email_verified:false}, {email_verified:'true'}, {email:null}])assert.equal(await check(await sign(claims)),false,JSON.stringify(claims));
  const foreign=await generateKeyPair('RS256');assert.equal(await check(await sign({},foreign.privateKey)),false);
  const token=await sign(),parts=token.split('.');parts[1]=Buffer.from('{"email":"owner@example.test","email_verified":true}').toString('base64url');assert.equal(await check(parts.join('.')),false);
  for(const token of ['malformed','x'.repeat(16385)])assert.equal(await check(token),false);
  for(const headers of [{authorization:'Bearer administrator-token'}, {'cf-access-jwt-assertion':token}, {'x-auth-request-email':'owner@example.test'}, {authorization:['Bearer '+token]}, {authorization:'Basic '+token}])assert.equal(await auth.authenticated({headers}),false);
});

test('OIDC requires exp, iat, sub, verified email and rejects symmetric token substitution',async()=>{
  const auth=createAdminAccess(env,keys);
  const claims={iss:env.BRIDGE_OIDC_ISSUER,aud:env.BRIDGE_OIDC_CLIENT_ID,sub:'owner',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300,email:'owner@example.test',email_verified:true};
  for(const field of ['exp','iat','sub','email','email_verified']){const bad={...claims};delete bad[field];const token=await new SignJWT(bad).setProtectedHeader({alg:'RS256',kid:'fixture'}).sign(privateKey);assert.equal(await auth.authenticated({headers:{authorization:'Bearer '+token}}),false,field);}
  const token=await new SignJWT(claims).setProtectedHeader({alg:'HS256',kid:'fixture'}).sign(new Uint8Array(32));assert.equal(await auth.authenticated({headers:{authorization:'Bearer '+token}}),false);
});

test('OIDC route guard rejects administrator bearer fallback and protects static/download routes',async()=>{
  const adminAccess=createAdminAccess(env,keys),options={adminAccess,adminToken:'fixture-admin',adminOrigin:'https://admin.example.test'};
  for(const url of ['/','/api/session','/api/requests','/downloads/'+'a'.repeat(48)+'/'+'b'.repeat(32)])assert.equal((await authorizeAdminRequest({url,method:'GET',headers:{authorization:'Bearer fixture-admin'}},options)).allowed,false,url);
  const token=await sign();assert.equal((await authorizeAdminRequest({url:'/api/requests',method:'GET',headers:{authorization:'Bearer '+token}},options)).allowed,true);
});

test('OIDC ES256 tokens are verified using the configured key set',async()=>{
  const pair=await generateKeyPair('ES256'),keySet=createLocalJWKSet({keys:[{...await exportJWK(pair.publicKey),kid:'fixture'}]});
  const token=await sign({},pair.privateKey,'ES256');
  assert.equal(await createAdminAccess(env,keySet).authenticated({headers:{authorization:'Bearer '+token}}),true);
});
