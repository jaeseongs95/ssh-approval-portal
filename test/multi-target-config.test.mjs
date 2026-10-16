import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSettings } from '../src/adapters/config/settings.mjs';
import { parseTargets, resolveTargets } from '../src/adapters/config/targets.mjs';

const entry = (id = 'alpha') => ({ id, displayName: `대상 ${id}`, readProfile: `${id}-read`, writeProfile: `${id}-write`, credentialRevision: 'v1' });
const base = { BRIDGE_MCP_TOKEN: 'synthetic-mcp', BRIDGE_ADMIN_TOKEN: 'synthetic-admin', BRIDGE_ADMIN_ORIGIN: 'https://admin.example.test' };
const registry = { getProfile: name => ({ host: name.split('-')[0]+'.example.test', port: 22, user: 'fixture', readOnly: name.endsWith('-read'), trustedHostKey: 'SHA256:'+name.split('-')[0] }) };

test('registered target configuration is bounded, immutable, optional, with an explicit fixed default only', () => {
  assert.equal(parseSettings(base).targets, null);
  assert.doesNotThrow(()=>resolveTargets(parseSettings(base),{getProfile:name=>({host:'legacy.example',port:22,user:'fixture',readOnly:name==='aws-readonly',keyRef:name+'-key'})}));
  assert.throws(() => parseSettings({ ...base, BRIDGE_DEFAULT_TARGET: 'alpha' }));
  const settings = parseSettings({ ...base, BRIDGE_TARGETS: JSON.stringify([entry(), entry('beta')]), BRIDGE_DEFAULT_TARGET: 'beta' });
  assert.equal(settings.defaultTarget, 'beta'); assert.ok(Object.isFrozen(settings.targets)); assert.ok(Object.isFrozen(settings.targets[0]));
  assert.equal(parseSettings({ ...base, BRIDGE_TARGETS: JSON.stringify([entry()]) }).defaultTarget, undefined);
  for (const value of ['null', '{}', '[]', '[', ' '.repeat(65537), JSON.stringify(Array.from({length:33},(_,i)=>entry('target'+i))), JSON.stringify([entry(),entry()])]) assert.throws(() => parseTargets(value));
  for (const invalid of [
    {id:'../escape'}, {id:'__proto__'}, {id:'https://unregistered.example'}, {displayName:'bad\u202ename'}, {displayName:'A'.repeat(81)},
    {enabled:'true'}, {credentialRevision:''}, {readProfile:'aws-local',writeProfile:'aws-local'}, {privateKey:'not-permitted'},
  ]) assert.throws(() => parseTargets(JSON.stringify([{...entry(),...invalid}])));
  assert.throws(() => parseTargets(JSON.stringify([entry(),{...entry('beta'),writeProfile:entry().writeProfile}])));
  assert.throws(() => parseTargets(JSON.stringify([{...entry(),enabled:false}]),'alpha'));
  assert.throws(() => parseTargets(JSON.stringify([entry()]),'unknown'));
});

test('target snapshots require matching profile pairs, distinct pinned identities and revisions that fence changes', () => {
  const settings = {...parseSettings(base),targets:parseTargets(JSON.stringify([entry(),entry('beta')]))};
  const [alpha,beta] = resolveTargets(settings,registry);
  assert.notEqual(alpha.revision,beta.revision); assert.equal(alpha.identity.targetId,'alpha');
  assert.equal(alpha.target,'fixture@alpha.example.test:22');
  const revision = patch => resolveTargets({...settings,targets:parseTargets(JSON.stringify([{...entry(),...patch}]))},registry)[0].revision;
  assert.notEqual(revision({credentialRevision:'v2'}),alpha.revision);
  for (const patch of [{trustedHostKey:undefined},{readOnly:false},{host:'wrong.example'}]) {
    assert.throws(() => resolveTargets(settings,{getProfile:name=>({...registry.getProfile(name),...(name==='alpha-read'?patch:{})})}));
  }
  assert.throws(() => resolveTargets(settings,{getProfile:name=>({...registry.getProfile(name),trustedHostKey:'SHA256:same'})}));
  assert.throws(() => resolveTargets(settings,{getProfile:name=>({...registry.getProfile(name),host:'same.example'})}));
  const profiles = new Map(['alpha-read','alpha-write','beta-read','beta-write'].map(name=>[name,registry.getProfile(name)]));
  const resolved = resolveTargets(settings,{getProfile:name=>profiles.get(name)});
  profiles.get('alpha-write').host='changed.example'; assert.throws(resolved[0].verify); resolved[1].verify();
});
