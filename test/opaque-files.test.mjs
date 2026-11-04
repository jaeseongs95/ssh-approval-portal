import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Artifacts } from '../src/adapters/storage/artifacts.mjs';
import { createOperationStore } from '../src/adapters/storage/operation-store.mjs';
import { createOpaqueFileService } from '../src/application/opaque-files.mjs';
import { hash } from '../src/domain/validation.mjs';

// Public application boundary + real manifests/SQLite. The file admission port
// is synthetic (no SSH): it clones through the supplied fd and accepts the exact
// AsyncLocalStorage identity, as the existing target file service does.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'opaque-files-')), submissions = new AsyncLocalStorage();
  const ownerId = 'authenticated-owner-realm', target = { id: 'alpha', revision: 'a'.repeat(64), verify() {} };
  let store, journal, service, requests = 0;
  const jobs = new Map(), queue = { maintenance: false, get: id => jobs.get(id) ?? null };
  const targets = { select: id => { if (id !== undefined && id !== target.id) throw Error('Unknown target'); return target; } };
  const binding = { targetId: target.id, targetRevision: target.revision, fileTargetBound: true };
  const files = { async requestUpload(args, options) {
    requests++;
    assert.equal(args.target, target.id); assert.equal(args.expectedTargetRevision, target.revision);
    const identity = submissions.getStore(); assert.equal(identity.owner, ownerId);
    assert.equal(options.provenance.requestId, identity.id);
    const artifact = await store.importFile({ fileName: args.fileName, remotePath: args.remotePath, overwrite: args.overwrite, elevate: args.elevate,
      ...binding, provenance: options.provenance }, () => args.source.open(), options);
    const operation = { kind: 'upload', artifactId: artifact.id, remotePath: args.remotePath, size: artifact.size, sha256: artifact.sha256 };
    journal.accept({ ...identity, kind: 'upload', ...binding, input: { operation } });
    store.recordSubmission(artifact.id, identity.id);
    const job = { id: identity.id, kind: 'upload', operation, state: 'pending' }; jobs.set(job.id, job);
    return { type: 'job', job };
  } };
  const reopen = async () => {
    if (service) await service.close(); if (journal) journal.close();
    store = new Artifacts(join(root, 'artifacts')); await store.init(); journal = createOperationStore(root);
    service = createOpaqueFileService({ store, journal, submissions, files, queue, targets, ownerId });
    return service;
  };
  await reopen();
  t.after(async () => { try { await service.close(); } finally { journal.close(); await rm(root, { recursive: true }); } });
  const stage = async (key = 'opaque-receive-key-001') => {
    const bytes = Buffer.from([0, 255, 1, 9]);
    const { uuid } = await service.begin({ operationKey: key, fileName: 'opaque.bin', size: bytes.length, sha256: hash(bytes) });
    await service.append({ uuid, sequence: 0, bytes, sha256: hash(bytes) }); await service.complete({ uuid }); return uuid;
  };
  return { root, stage, reopen, queue, target, ownerId, get service() { return service; }, get store() { return store; }, get journal() { return journal; }, get requests() { return requests; }, binding };
}
const destination = uuid => ({ uuid, operationKey: 'opaque-copy-action-01', target: 'alpha', expectedTargetRevision: 'a'.repeat(64), remotePath: '/tmp/opaque.bin' });
const success = { failed: false, data: { published: true, size: 4, sha256: hash(Buffer.from([0, 255, 1, 9])) }, execution: { phase: 'settled', reason: 'exit', remoteState: 'exited', exitCode: 0, cleanupComplete: true, requiresReconciliation: false } };

test('copy uses a target-bound fd clone and recovers one durable request after lost replies/restart', async t => {
  const f = await fixture(t), uuid = await f.stage(), args = destination(uuid);
  const [first, duplicate] = await Promise.all([f.service.copy(args), f.service.copy(args)]);
  assert.equal(first.requestId, duplicate.requestId); assert.equal(f.requests, 1);
  const original = f.store.staged(uuid, f.ownerId), clone = f.store.list().find(item => item.provenance);
  assert.notEqual(clone.id, original.id); assert.equal(clone.targetId, 'alpha'); assert.equal(original.targetId, undefined);
  assert.equal(clone.sha256, original.sha256); assert.equal(clone.provenance.sourceUUID, uuid);
  await assert.rejects(f.service.copy({ ...args, remotePath: '/tmp/different.bin' }), { code: 'OPERATION_KEY_CONFLICT' });
  await f.reopen();
  assert.equal((await f.service.copy(args)).requestId, first.requestId); assert.equal(f.requests, 1);
  const status = await f.service.stat({ uuid });
  assert.equal(status.state, 'ready'); assert.equal(status.operations[0].requestId, first.requestId);
  for (const privateKey of ['id', 'ownerId', 'path', 'targetId', 'remotePath']) assert.equal(Object.hasOwn(status, privateKey), false);
  await assert.rejects(f.service.copy({ ...args, expectedTargetRevision: 'b'.repeat(64) }), { code: 'TARGET_REVISION_CONFLICT' });
});

test('move keeps the source for unknown outcomes and consumes once only after confirmed publication', async t => {
  const f = await fixture(t), uuid = await f.stage(), args = destination(uuid), first = await f.service.move(args);
  const original = f.store.staged(uuid, f.ownerId);
  f.journal.update(first.requestId, { state: 'unknown', requiresReconciliation: true });
  f.service.onTerminal({ id: first.requestId });
  assert.equal((await f.service.stat({ uuid })).state, 'ready');
  assert.equal((await lstat(join(f.root, 'artifacts', original.id + '.part'))).size, 4);
  await assert.rejects(f.service.remove({ uuid }), /busy/);
  assert.equal((await f.service.move(args)).requestId, first.requestId); assert.equal(f.requests, 1);
  await assert.rejects(f.service.move({ ...args, operationKey: 'other-move-action-01' }), /unavailable/);
  f.journal.outcome(first.requestId, success);
  f.service.onTerminal({ id: first.requestId });
  const moved = await f.service.stat({ uuid });
  assert.equal(moved.state, 'moved'); assert.equal(moved.operations[0].requestId, first.requestId);
  await assert.rejects(lstat(join(f.root, 'artifacts', original.id + '.part')), { code: 'ENOENT' });
  await f.reopen(); await f.service.reconcile();
  assert.equal((await f.service.stat({ uuid })).state, 'moved');
  assert.equal((await f.service.move(args)).requestId, first.requestId); assert.equal(f.requests, 1);
  await assert.rejects(f.service.copy({ ...args, operationKey: 'after-move-copy-0001' }), { code: 'STAGED_FILE_CONSUMED' });
});

test('completed without a publication acknowledgement never consumes the move source', async t => {
  const f = await fixture(t), uuid = await f.stage(), first = await f.service.move(destination(uuid));
  f.journal.update(first.requestId, { state: 'queued' }); f.journal.update(first.requestId, { state: 'starting' });
  f.journal.outcome(first.requestId, { ...success, data: {} });
  assert.equal((await f.service.stat({ uuid })).state, 'ready');
  assert.equal((await f.service.move(destination(uuid))).requestId, first.requestId); assert.equal(f.requests, 1);
});

test('publication checks bind source bytes, audit status and optional execution metadata', async t => {
  for (const scenario of ['no-execution', 'wrong-size', 'wrong-hash', 'audit-failed', 'uncertain-execution']) await t.test(scenario, async child => {
    const f = await fixture(child), uuid = await f.stage(), first = await f.service.move(destination(uuid));
    const result = structuredClone(success);
    if (scenario === 'no-execution') delete result.execution;
    if (scenario === 'wrong-size') result.data.size++;
    if (scenario === 'wrong-hash') result.data.sha256 = '0'.repeat(64);
    if (scenario === 'audit-failed') f.queue.get(first.requestId).auditError = 'Final audit write failed';
    if (scenario === 'uncertain-execution') result.execution.cleanupComplete = false;
    f.journal.update(first.requestId, { state: 'queued' }); f.journal.update(first.requestId, { state: 'starting' });
    // A durable completed record from the existing file publication contract may
    // predate execution-envelope normalization. Optional metadata cannot waive
    // byte identity, audit certainty, or an explicit contrary execution result.
    f.journal.update(first.requestId, { state: 'completed', result });
    assert.equal((await f.service.stat({ uuid })).state, scenario === 'no-execution' ? 'moved' : 'ready');
    assert.equal(f.requests, 1);
  });
});

test('recovery removes only proven unaccepted clone provenance; missing-journal queue identity is preserved', async t => {
  const f = await fixture(t), uuid = await f.stage(), original = f.store.staged(uuid, f.ownerId);
  const action = { action: 'copy', operationKey: 'crash-before-accept-01', requestKey: 'opaque:crash-before-accept-01', inputDigest: 'd'.repeat(64),
    requestId: 'e'.repeat(48), targetId: 'alpha', targetRevision: 'a'.repeat(64), remotePath: '/tmp/crash.bin', overwrite: false, elevate: false };
  f.store.reserveStagedAction(uuid, f.ownerId, action);
  const clone = await f.store.importFile({ fileName: original.fileName, remotePath: action.remotePath, ...f.binding,
    provenance: { sourceUUID: uuid, ownerId: f.ownerId, requestId: action.requestId } }, async () => {
    const fd = await f.store.verified(original.id);
    return { stream: fd.createReadStream({ start: 0, autoClose: false }), expectedSize: original.size, close: () => fd.close() };
  });
  await f.reopen();
  // A queue identity without its journal is contradictory, not proof of refusal.
  const savedGet = f.queue.get; f.queue.get = id => id === action.requestId ? { id } : savedGet(id);
  await assert.rejects(f.service.reconcile(), { code: 'OPAQUE_ACTION_RECONCILIATION_REQUIRED' });
  assert.equal(f.store.has(clone.id), true); assert.equal(f.store.staged(uuid, f.ownerId).pinned, true);
  f.queue.get = savedGet; await f.service.reconcile();
  assert.equal(f.store.has(clone.id), false);
  assert.equal(f.store.staged(uuid, f.ownerId).actions[0].state, 'refused');
  assert.equal(f.store.staged(uuid, f.ownerId).pinned, false); assert.equal(f.requests, 0);
});

test('chunk hash failure and wrong-owner UUID access do not change accepted bytes', async t => {
  const f = await fixture(t), uuid = await f.stage();
  const before = await f.service.stat({ uuid });
  await assert.rejects(f.service.append({ uuid, sequence: 0, bytes: Buffer.from('wrong'), sha256: hash('different') }), { code: 'CHUNK_HASH_MISMATCH' });
  assert.deepEqual(await f.service.stat({ uuid }), before);
  assert.throws(() => f.store.staged(uuid, 'unverified-request-owner'), /unavailable/);
  assert.equal((await f.service.remove({ uuid })).state, 'removed');
  assert.equal((await f.service.remove({ uuid })).state, 'removed');
});
