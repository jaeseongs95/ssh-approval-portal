import test from 'node:test';
import assert from 'node:assert/strict';
import {agentCliProviders,agentCliProvider,validateAgentRelease,agentCliIntent} from '../src/domain/agent-cli.mjs';

const integrity='sha512-'+Buffer.alloc(64,7).toString('base64');
const metadata=(id='codex',version='1.2.3')=>{const p=agentCliProvider(id);return{name:p.packageName,version,dist:{tarball:'https://registry.npmjs.org/'+p.packageName+'/-/'+p.packageName.split('/')[1]+'-'+version+'.tgz',integrity}};};
const binding={targetId:'alpha',targetRevision:'a'.repeat(64),profile:'ssh-write',enabled:true};
const release=validateAgentRelease('codex',metadata());
const body=()=>({targetId:binding.targetId,targetRevision:binding.targetRevision,profile:binding.profile,provider:'codex',action:'install',releaseDigest:release.releaseDigest,expectedInstallationRevision:'b'.repeat(64),requestKey:'cli-request-fixed-0001'});
const options=()=>({binding,release,expiresAt:1001,now:1000});

test('fixed provider catalog rejects property names and shell input',()=>{
  assert.deepEqual(agentCliProviders().map(x=>x.id),['codex','claude']);
  for(const id of ['__proto__','constructor','toString','Codex','codex;id','',null,{},['codex']])assert.throws(()=>agentCliProvider(id));
  assert.ok(Object.isFrozen(agentCliProvider('codex')));
});
for(const provider of ['codex','claude'])test('official public release projection '+provider,()=>{
  const raw=metadata(provider),before=structuredClone(raw);
  const normal=validateAgentRelease(provider,raw);
  raw.privateData='SYNTHETIC_DO_NOT_PERSIST';raw.dist.extra='other-private';
  const projected=validateAgentRelease(provider,raw);
  assert.deepEqual(projected,normal);assert.ok(Object.isFrozen(projected));assert.ok(!JSON.stringify(projected).includes('private'));
  assert.equal(projected.packageName,before.name);assert.equal(projected.version,'1.2.3');
});
for(const version of ['latest','^1.2.3','1.2','01.2.3','1.2.3-rc.1','1.2.3+build','1.2.3;id','1.2.3\n','9999999.2.3','../../etc'])test('release rejects unstable or unbounded version '+JSON.stringify(version),()=>assert.throws(()=>validateAgentRelease('codex',metadata('codex',version))));
for(const url of ['http://registry.npmjs.org/@openai/codex/-/codex-1.2.3.tgz','https://evil.test/@openai/codex/-/codex-1.2.3.tgz','https://registry.npmjs.org.evil.test/@openai/codex/-/codex-1.2.3.tgz','https://u:p@registry.npmjs.org/@openai/codex/-/codex-1.2.3.tgz','https://registry.npmjs.org:444/@openai/codex/-/codex-1.2.3.tgz','https://registry.npmjs.org/@openai/codex/-/codex-1.2.3.tgz?token=private','https://registry.npmjs.org/@openai/codex/-/codex-1.2.3.tgz#part','https://registry.npmjs.org/@openai/codex/-/other.tgz'])test('release refuses alternative distribution '+url,()=>{const raw=metadata();raw.dist.tarball=url;assert.throws(()=>validateAgentRelease('codex',raw));});
test('release rejects malformed metadata and checksum',()=>{
  for(const raw of [null,[],{}, {...metadata(),name:'@other/codex'}, {...metadata(),dist:null}])assert.throws(()=>validateAgentRelease('codex',raw));
  for(const value of [undefined,'sha1-abcd','sha512-'+Buffer.alloc(63).toString('base64'),'sha512-'+Buffer.alloc(65).toString('base64'),integrity+' ',integrity.slice(0,-3)+'B==']){const raw=metadata();raw.dist.integrity=value;assert.throws(()=>validateAgentRelease('codex',raw));}
});
test('intent binds release, action, target and installation snapshot but not replay key',()=>{
  const first=agentCliIntent(body(),options());
  assert.ok(Object.isFrozen(first));assert.equal(first.contract,'agent-cli-install-v1');
  assert.equal(first.intentDigest,agentCliIntent({...body(),requestKey:'cli-request-fixed-0002'},options()).intentDigest);
  for(const change of [{action:'update'},{expectedInstallationRevision:'c'.repeat(64)}])assert.notEqual(agentCliIntent({...body(),...change},options()).intentDigest,first.intentDigest);
  assert.equal(first.expiresAt,1001);
  assert.notEqual(agentCliIntent(body(),{...options(),expiresAt:1002}).intentDigest,first.intentDigest);
  const next=validateAgentRelease('codex',metadata('codex','1.2.4'));
  assert.notEqual(agentCliIntent({...body(),releaseDigest:next.releaseDigest},{...options(),release:next}).intentDigest,first.intentDigest);
  assert.ok(!JSON.stringify(first).includes('SYNTHETIC_DO_NOT_PERSIST'));
});
test('intent refuses stale, disabled and malformed targets',()=>{
  for(const change of [{targetId:'beta'},{targetRevision:'f'.repeat(64)},{profile:'other'}])assert.throws(()=>agentCliIntent({...body(),...change},options()));
  for(const change of [{enabled:false},{targetId:'../server'},{targetRevision:'not-a-revision'},{profile:'x;id'}])assert.throws(()=>agentCliIntent(body(),{...options(),binding:{...binding,...change}}));
});
test('intent refuses additional, missing and malformed request fields',()=>{
  for(const change of [{command:'id'},{packageName:'@other/cli'},{url:'https://evil.test'},{action:'uninstall'},{provider:'constructor'},{requestKey:'short'},{requestKey:'x'.repeat(129)},{expectedInstallationRevision:null}])assert.throws(()=>agentCliIntent({...body(),...change},options()));
  for(const key of Object.keys(body())){const raw=body();delete raw[key];assert.throws(()=>agentCliIntent(raw,options()));}
  for(const raw of [null,[],{}])assert.throws(()=>agentCliIntent(raw,options()));
});
test('intent detects tampering in every release identity field',()=>{
  for(const change of [{releaseDigest:'sha256:'+'f'.repeat(64)},{version:'1.2.4'},{provider:'claude'},{integrity:'sha512-'+Buffer.alloc(64,8).toString('base64')},{tarball:'https://evil.test/code.tgz'}])assert.throws(()=>agentCliIntent(body(),{...options(),release:{...release,...change}}));
  assert.throws(()=>agentCliIntent({...body(),releaseDigest:'sha256:'+'f'.repeat(64)},options()));
});
test('expiry boundary never gains an epsilon or implicit clock extension',()=>{
  assert.doesNotThrow(()=>agentCliIntent(body(),options()));
  for(const expiresAt of [1000,999,NaN,Infinity,'1001',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>agentCliIntent(body(),{...options(),expiresAt}));
  for(const now of [NaN,Infinity,'1000'])assert.throws(()=>agentCliIntent(body(),{...options(),now}));
});
