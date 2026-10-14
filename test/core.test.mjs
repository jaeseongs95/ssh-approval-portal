import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalQueue, Tickets, routeCommand, hash, writeAll } from '../core.mjs';
const classify = command => ({ class: command.startsWith('cat ') ? 'read-only' : command.startsWith('sudo ') ? 'privileged' : 'destructive' });
test('all non-read classes reserve exactly one execution after audit, shared by web and UI', async () => {
  let finish, executions = 0; const events = [];
  const queue = new ApprovalQueue({ classify, target: 'host', audit: e => events.push(e.action), executeOperation: async op => { executions++; return new Promise(resolve => { finish = resolve; }); } });
  const job = await routeCommand('sudo -n -l', classify, () => assert.fail('read bypass'), queue);
  assert.equal(executions, 0);
  assert.equal(queue.start(job.id).state, 'running');
  assert.throws(() => queue.start(job.id), /pending/);
  await Promise.resolve(); assert.equal(executions, 1); assert.ok(events.indexOf('approved') > events.indexOf('submitted'));
  finish({ content: [{ type: 'text', text: 'ok' }] });
  assert.equal((await queue.wait(job.id)).state, 'completed');
  await assert.rejects(queue.approve(job.id)); assert.equal(executions, 1);
});
test('file operation and ticket scope are immutable; expiry, denial and audit failure block side effects', async () => {
  let now = 100, executions = 0, reject = false;
  const q = new ApprovalQueue({ classify, target: 'host', now: () => now, audit: e => { if (reject && e.action === 'approved') throw Error('disk failed'); }, executeOperation: async () => { executions++; return {}; } });
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
test('automatic execution is restricted to ordinary downloads; raw error text never reaches results', async () => {
  const q = new ApprovalQueue({ classify, target: 'host', executeOperation: async () => { throw Error('secret-file-bytes'); } });
  assert.throws(() => q.start(q.submit('sudo id').id, true));
  assert.throws(() => q.start(q.submitOperation({ kind: 'download', elevate: true }).id, true));
  const job = q.submitOperation({ kind: 'download', elevate: false }); q.start(job.id, true);
  const result = await q.wait(job.id); assert.equal(result.state, 'failed'); assert.ok(!JSON.stringify(result).includes('secret-file-bytes'));
});
test('audit partial writes complete; zero-write fails', () => {
  const chunks = [], bytes = Buffer.from('audit');
  writeAll(1, bytes, (_, data, offset, length) => { const size = Math.min(2, length); chunks.push(data.subarray(offset, offset + size)); return size; });
  assert.deepEqual(Buffer.concat(chunks), bytes); assert.throws(() => writeAll(1, bytes, () => 0));
});
test('late completed downloads remain addressable for a full hour after completion', async () => {
  let now = 0, complete;
  const q = new ApprovalQueue({ classify, target: 'host', now: () => now, executeOperation: () => new Promise(resolve => { complete = resolve; }) });
  const job = q.submitOperation({ kind: 'download', elevate: false });
  now = job.expiresAt - 1; q.start(job.id, true); await Promise.resolve();
  now = job.expiresAt + 300000; complete({ structuredContent: { artifactId: 'synthetic' } }); await q.wait(job.id);
  now = job.expiresAt + 3600001; q.reap(); assert.equal(q.get(job.id).state, 'completed');
  now = job.expiresAt + 300000 + 3600001; q.reap(); assert.equal(q.get(job.id), null);
});
