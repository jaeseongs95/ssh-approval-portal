import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalQueue } from '../src/domain/approval-queue.mjs';
import { hash } from '../src/domain/validation.mjs';
import { Tickets } from '../src/adapters/security/tickets.mjs';
import { writeAll } from '../src/adapters/audit/jsonl.mjs';
import { createCommandService } from '../src/application/commands.mjs';
import { decisionText } from '../ui/src/decision.js';
const classify = command => ({ class: command.startsWith('cat ') ? 'read-only' : command.startsWith('sudo ') ? 'privileged' : 'destructive' });
test('all non-read classes reserve exactly one execution after audit, shared by web and UI', async () => {
  let finish, executions = 0; const events = [];
  const queue = new ApprovalQueue({ classify, profile: 'aws-local', target: 'host', audit: e => events.push(e.action), executeOperation: async op => { executions++; return new Promise(resolve => { finish = resolve; }); } });
  const commands = createCommandService({ queue, classify, executeCommand: () => assert.fail('read bypass'), audit: () => {}, target: 'host', readProfile: 'aws-readonly' });
  const { job } = await commands.run('sudo -n -l');
  assert.equal(executions, 0);
  assert.equal(queue.start(job.id).state, 'running');
  assert.throws(() => queue.start(job.id), /pending/);
  await Promise.resolve(); assert.equal(executions, 1); assert.ok(events.indexOf('approved') > events.indexOf('submitted'));
  finish({ failed: false, texts: ['ok'] });
  assert.equal((await queue.wait(job.id)).state, 'completed');
  await assert.rejects(queue.approve(job.id)); assert.equal(executions, 1);
});
test('file operation and ticket scope are immutable; expiry, denial and audit failure block side effects', async () => {
  let now = 100, executions = 0, reject = false;
  const q = new ApprovalQueue({ classify, profile: 'aws-local', target: 'host', now: () => now, audit: e => { if (reject && e.action === 'approved') throw Error('disk failed'); }, executeOperation: async () => { executions++; return { failed: false, texts: [] }; } });
  const op = { kind: 'upload', sha256: hash('x'), remotePath: '/tmp/x', size: 1, overwrite: false, elevate: true };
  const job = q.submitOperation(op); op.remotePath = '/etc/passwd'; assert.equal(q.get(job.id).operation.remotePath, '/tmp/x');
  const signer = new Tickets('a'.repeat(64), () => now), cap = signer.issue('decision', q.subject(job.id), job.expiresAt);
  signer.verify(cap, 'decision', q.subject(job.id));
  assert.throws(() => signer.verify(cap, 'upload', q.subject(job.id)));
  assert.throws(() => signer.verify(cap, 'decision', q.subject(q.submit('sudo id').id)));
  reject = true; assert.throws(() => q.start(job.id)); assert.equal(q.get(job.id).state, 'pending');
  reject = false; q.deny(job.id); assert.throws(() => q.start(job.id));
  const expired = q.submit('sudo id'); now = expired.expiresAt;
  assert.throws(() => q.start(expired.id)); assert.throws(() => signer.verify(cap, 'decision', q.subject(job.id)));
  assert.equal(executions, 0);
});
test('a boolean cannot grant automatic file authority; raw error text never reaches owner-approved results', async () => {
  const q = new ApprovalQueue({ classify, profile: 'aws-local', target: 'host', executeOperation: async () => { throw Error('secret-file-bytes'); } });
  assert.throws(() => q.start(q.submit('sudo id').id, true));
  assert.throws(() => q.start(q.submitOperation({ kind: 'download', elevate: true }).id, true));
  const job = q.submitOperation({ kind: 'download', elevate: false }); assert.throws(()=>q.start(job.id,true));assert.throws(()=>q.startDownload(job.id));q.start(job.id);
  const result = await q.wait(job.id); assert.equal(result.state, 'failed'); assert.ok(!JSON.stringify(result).includes('secret-file-bytes'));
});
test('audit partial writes complete; zero-write fails', () => {
  const chunks = [], bytes = Buffer.from('audit');
  writeAll(1, bytes, (_, data, offset, length) => { const size = Math.min(2, length); chunks.push(data.subarray(offset, offset + size)); return size; });
  assert.deepEqual(Buffer.concat(chunks), bytes); assert.throws(() => writeAll(1, bytes, () => 0));
});
test('late completed downloads remain addressable for a full hour after completion', async () => {
  let now = 0, complete;
  const q = new ApprovalQueue({ classify, profile: 'aws-local', target: 'host', now: () => now, executeOperation: () => new Promise(resolve => { complete = resolve; }) });
  const job = q.submitOperation({ kind: 'download', elevate: false });
  now = job.expiresAt - 1; q.start(job.id); await Promise.resolve();
  now = job.expiresAt + 300000; complete({ failed: false, texts: [], data: { artifactId: 'synthetic' } }); await q.wait(job.id);
  now = job.expiresAt + 3600001; q.reap(); assert.equal(q.get(job.id).state, 'completed');
  now = job.expiresAt + 300000 + 3600001; q.reap(); assert.equal(q.get(job.id), null);
});

test('DISPATCH-01 new failures retain only fixed cause/stage, never exception properties, and release claims once', async t => {
  const hostile = new Proxy({}, { get() { assert.fail('exception properties must not be read'); } });
  const cases = [
    ['busy', 'busy_check', q => { q.externalBusy = () => true; }],
    ['unknown', 'busy_check', q => { q.externalBusy = () => { throw hostile; }; }],
    ['claim_failed', 'execution_claim', q => { q.claimExecution = () => { throw hostile; }; }],
    ['audit_failed', 'start_audit', q => { q.audit = () => { throw hostile; }; }],
    ['unknown', 'command_guard', q => { q.beforeCommandStart = () => { throw hostile; }; }],
    ['maintenance', 'maintenance', q => { q.maintenance = true; }],
  ];
  for (const [reason, stage, change] of cases) await t.test(reason + '/' + stage, async () => {
    let effects = 0, claims = 0, releases = 0, terminals = 0; const events = [], saves = [];
    const q = new ApprovalQueue({ classify, profile:'fixture', target:'fixture', audit:e=>events.push(e), onTerminal:()=>terminals++, claimExecution:()=>{claims++;return ()=>releases++;}, executeOperation:async()=>{effects++;return {failed:false,texts:[]};} });
    const job = q.submit('sudo id'); q.setDecision(job.id,{decision:'execute',reasonCode:'test_server_bypass'});q.track(job.id, value=>saves.push(value));
    change(q); let error;try{q.startCommand(job.id);assert.fail('must reject');}catch(value){error=value;}
    const waiter = q.waitForRequest(job.id,{until:'completion'});
    const audit = q.audit;q.audit=e=>events.push(e);assert.equal(q.rejectAutomaticDispatch(job.id,error),true);q.audit=audit;
    const current = q.get(job.id); assert.equal(current.state,'failed');assert.equal(current.decision.dispatchFailure,'not_dispatched');
    assert.equal(current.decision.dispatchFailureReason,reason);assert.equal(current.decision.dispatchFailureStage,stage);
    assert.equal((await waiter).job.decision.dispatchFailureReason,reason);
    assert.equal(saves.at(-1).decision.dispatchFailureStage,stage);assert.equal(events.at(-1).dispatchFailureReason,reason);
    assert.equal(effects,0);assert.equal(terminals,1);assert.equal(releases,claims);assert.equal(q.active,null);
    assert.equal(q.rejectAutomaticDispatch(job.id,hostile),false);assert.equal(terminals,1);assert.equal(releases,claims);
    assert.ok(!JSON.stringify(current).includes('SYNTHETIC_PRIVATE'));
    const restored = new ApprovalQueue({classify,profile:'fixture',target:'fixture',executeOperation:async()=>assert.fail('no replay')});restored.restore(current,()=>{});
    assert.deepEqual(restored.get(job.id),current);assert.throws(()=>restored.startCommand(job.id));
    assert.ok(decisionText(current.decision,true).length>0);
  });
});

test('DISPATCH-02 persistence ambiguity and remote failures never become not_dispatched, claims and source release remain once', async () => {
  for(const point of ['start_persistence','execute']){
    let releases=0,terminals=0,effects=0;
    const q=new ApprovalQueue({classify,profile:'fixture',target:'fixture',claimExecution:()=>()=>releases++,onTerminal:()=>terminals++,executeOperation:async()=>{effects++;throw Error('SYNTHETIC_PRIVATE_AFTER_RUNNING');}});
    const job=q.submitOperation({kind:'command',command:'sudo id',sourceContract:'python-source-v1'});q.beforeCommandStart=()=>{};q.setDecision(job.id,{decision:'execute',reasonCode:'test_server_bypass'});
    if(point==='start_persistence')q.track(job.id,value=>{if(value.state==='running')throw Error('SYNTHETIC_PRIVATE_PERSIST');});
    if(point==='start_persistence')assert.throws(()=>q.startCommand(job.id));else{q.startCommand(job.id);await q.wait(job.id);}
    const current=q.get(job.id);assert.equal(current.state,'unknown');assert.equal(current.decision.dispatchFailure,undefined);assert.equal(q.rejectAutomaticDispatch(job.id),false);
    assert.equal(releases,1);assert.equal(terminals,1);assert.equal(effects,point==='execute'?1:0);assert.ok(!JSON.stringify(current).includes('SYNTHETIC_PRIVATE'));
  }
});

test('DISPATCH-03 old not_dispatched records remain byte-identical and forged/unknown cause text is never reflected', () => {
  const q=new ApprovalQueue({classify,profile:'fixture',target:'fixture',now:()=>100,executeOperation:async()=>assert.fail('no replay')});
  const old={...q.submit('sudo id'),state:'failed',finishedAt:123,decision:{decision:'execute',reasonCode:'test_server_bypass',dispatchFailure:'not_dispatched'}};
  let writes=0;q.restore(old,()=>writes++);const before=JSON.stringify(q.get(old.id));q.rejectAutomaticDispatch(old.id);q.listAll();q.reap();
  assert.equal(JSON.stringify(q.get(old.id)),before);assert.equal(writes,0);assert.equal(old.decision.dispatchFailureReason,undefined);
  const fallback=decisionText(old.decision,true);assert.equal(decisionText({...old.decision,dispatchFailureReason:'SYNTHETIC_PRIVATE'},true),fallback);
  assert.equal(decisionText({...old.decision,dispatchFailureReason:'toString'},true),fallback);
  assert.match(decisionText({...old.decision,dispatchFailureReason:'busy'},true),/다른 작업/);
  assert.match(decisionText({...old.decision,dispatchFailureReason:'audit_failed'},true),/감사 기록/);
});
