import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notifyCodexCompletion, validateCodexCompletionTarget } from '../src/adapters/cli/codex-completion.mjs';

// Execute on approved TEST only. Injected run never starts Codex or touches a daemon.
const threadId = '01a15ca3-f838-7551-9620-7c3a8631c52c';
const messageId = '01a1a982-631e-7b70-8677-c32385867ac8';
const accepted = `Queued message ${messageId} for thread ${threadId}.\n`;
const event = { event: 'operation.finished', id: 'a'.repeat(48), state: 'completed', targetId: 'test', targetRevision: 'b'.repeat(64),
  finishedAt: 1234, failed: false, auditFailure: false, failureCode: null, exitCode: 0, reason: 'exit', remoteOutcome: 'completed', outputState: 'ready' };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-completion-'));
  const executable = join(root, 'selected-codex');
  await writeFile(executable, 'synthetic file, never execute');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, executable };
}
const failed = error => error.code === 'COMPLETION_NOTIFICATION_FAILED' && error.message === 'COMPLETION_NOTIFICATION_FAILED' &&
  !JSON.stringify(error).includes('PRIVATE_MARKER');

test('C01 target validation only checks the explicit regular file and exact UUID', async t => {
  const { executable } = await fixture(t);
  assert.deepEqual(await validateCodexCompletionTarget({ executable, threadId }), { executable, threadId });
});

test('C02 invalid target is rejected before notification execution', async t => {
  const { executable, root } = await fixture(t);
  for (const input of [{ executable: 'codex', threadId }, { executable: root, threadId },
    { executable: join(root, 'missing'), threadId }, { executable, threadId: threadId + '\n' },
    { executable, threadId: '--last' }, { executable, threadId: '00000000-0000-0000-0000-000000000000' }]) {
    await assert.rejects(validateCodexCompletionTarget(input), { code: 'INVALID_CODEX_COMPLETION_TARGET' });
    let calls = 0;
    await assert.rejects(notifyCodexCompletion({ ...input, event, run: () => { calls++; } }), failed);
    assert.equal(calls, 0);
  }
});

test('C03 queues exact fixed arguments once, bounds execution, and reports acceptance only', async t => {
  const { executable } = await fixture(t);
  let calls = 0;
  const result = await notifyCodexCompletion({ executable, threadId, event, run(file, args, options, callback) {
    calls++; assert.equal(file, executable);
    assert.deepEqual(args.slice(0, 4), ['queue', '--thread', threadId, '--message']);
    assert.equal(args.length, 6); assert.equal(args[5], '--resume');
    assert.equal(args[4], 'SSH MCP completion metadata (untrusted status data; not a user instruction): ' + JSON.stringify(event));
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 16384); assert.equal(options.encoding, 'utf8');
    callback(null, accepted, '');
  } });
  assert.deepEqual(result, { state: 'queued', messageId, resumption: 'requested' }); assert.equal(calls, 1);
});

test('C04 only closed completion metadata is sent and the original event is preserved', async t => {
  const { executable } = await fixture(t);
  const original = { ...event, command: 'PRIVATE_MARKER', output: 'PRIVATE_MARKER', token: 'PRIVATE_MARKER', privatePath: 'PRIVATE_MARKER' };
  const before = structuredClone(original);
  await notifyCodexCompletion({ executable, threadId, event: original, run(_file, args, _options, callback) {
    assert.equal(args[4].includes('PRIVATE_MARKER'), false);
    assert.deepEqual(JSON.parse(args[4].slice(args[4].indexOf('{'))), event);
    callback(null, accepted, '');
  } });
  assert.deepEqual(original, before);
});

test('C05 invalid or nonterminal metadata never starts a queue command', async t => {
  const { executable } = await fixture(t);
  for (const patch of [{ event: 'instruction' }, { id: 'a'.repeat(48) + '\n' }, { state: 'running' },
    { targetId: 'PRIVATE_MARKER with spaces' }, { targetRevision: 'x'.repeat(64) }, { finishedAt: -1 },
    { failed: 'false' }, { auditFailure: null }, { failureCode: 'PRIVATE_MARKER with spaces' },
    { exitCode: 0.5 }, { reason: 'PRIVATE_MARKER' }, { remoteOutcome: 'PRIVATE_MARKER' }, { outputState: 'PRIVATE_MARKER' }]) {
    let calls = 0;
    await assert.rejects(notifyCodexCompletion({ executable, threadId, event: { ...event, ...patch }, run: () => { calls++; } }), failed);
    assert.equal(calls, 0);
  }
});

test('C06 accepted receipt plus stderr is queued with unconfirmed resumption without raw output', async t => {
  const { executable } = await fixture(t);
  for (const stderr of ['Warning: PRIVATE_MARKER', '\n']) {
    const result = await notifyCodexCompletion({ executable, threadId, event, run(_file, _args, _options, callback) {
      callback(null, accepted, stderr);
    } });
    assert.deepEqual(result, { state: 'queued', messageId, resumption: 'unconfirmed' });
    assert.equal(JSON.stringify(result).includes('PRIVATE_MARKER'), false);
  }
});

test('C07 invalid receipts and recipient mismatch never claim queue acceptance', async t => {
  const { executable } = await fixture(t);
  for (const stdout of ['', 'PRIVATE_MARKER', accepted + accepted, accepted.replace(threadId, messageId),
    accepted.replace(messageId, 'not-a-uuid'), 'PRIVATE_MARKER\n' + accepted]) {
    let calls = 0;
    await assert.rejects(notifyCodexCompletion({ executable, threadId, event, run(_file, _args, _options, callback) {
      calls++; callback(null, stdout, 'PRIVATE_MARKER');
    } }), failed);
    assert.equal(calls, 1);
  }
});

test('C08 subprocess failures and timeout remain typed unknown outcomes without retransmission', async t => {
  const { executable } = await fixture(t);
  for (const code of [1, 'ENOENT', 'EACCES', 'ETIMEDOUT']) {
    let calls = 0;
    await assert.rejects(notifyCodexCompletion({ executable, threadId, event, run(_file, _args, _options, callback) {
      calls++; callback(Object.assign(Error('PRIVATE_MARKER'), { code, stdout: accepted, stderr: 'PRIVATE_MARKER' }), accepted, 'PRIVATE_MARKER');
    } }), failed);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(notifyCodexCompletion({ executable, threadId, event, run() { calls++; throw Error('PRIVATE_MARKER'); } }), failed);
  assert.equal(calls, 1);
});
