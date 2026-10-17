import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ApprovalQueue } from '../src/domain/approval-queue.mjs';
import { Tickets } from '../src/adapters/security/tickets.mjs';
import { createCapabilities } from '../src/adapters/presentation/capabilities.mjs';
import { Artifacts } from '../src/adapters/storage/artifacts.mjs';
import { createFileService } from '../src/application/files.mjs';

test('command, upload and elevated download approval tickets last one hour and execute only once', async () => {
  for (const operation of [{ kind: 'command', command: 'sudo id' }, { kind: 'upload', artifactId: 'fixture' }, { kind: 'download', remotePath: '/tmp/fixture', elevate: true }]) {
    let now = 1000, effects = 0;
    const queue = new ApprovalQueue({ classify: () => ({ class: 'privileged' }), profile: 'fixture', target: 'fixture', now: () => now,
      executeOperation: async () => { effects++; return { failed: false, texts: [] }; } });
    const job = queue.submitOperation(operation);
    assert.equal(job.expiresAt - job.createdAt, 3_600_000);
    const capabilities = createCapabilities({ queue, signer: new Tickets('a'.repeat(64), () => now), settings: { uiEnabled: true }, now: () => now });
    const card = capabilities.view(job);
    now = 1000 + 600_001;
    assert.equal(queue.get(job.id).state, 'pending');
    capabilities.verifyJob(job.id, card.approvalTicket, 'decision');
    now = job.expiresAt - 1;
    capabilities.verifyJob(job.id, card.approvalTicket, 'decision');
    await queue.approve(job.id);
    await assert.rejects(queue.approve(job.id));
    assert.equal(effects, 1);
  }
});

test('approval expires exactly at one hour and restored old requests retain their original deadline', () => {
  let now = 0, effects = 0;
  const queue = new ApprovalQueue({ classify: () => ({ class: 'privileged' }), profile: 'fixture', target: 'fixture', now: () => now,
    executeOperation: async () => { effects++; return { failed: false, texts: [] }; } });
  const job = queue.submit('sudo id'), signer = new Tickets('a'.repeat(64), () => now);
  const ticket = signer.issue('decision', queue.subject(job.id), job.expiresAt);
  queue.restore({ ...job, id: 'legacy-request', expiresAt: 600_000 }, () => {});
  now = 600_000;
  assert.equal(queue.get('legacy-request').state, 'expired');
  assert.equal(queue.get(job.id).state, 'pending');
  now = 3_600_000;
  assert.throws(() => queue.start(job.id), /pending/);
  assert.throws(() => signer.verify(ticket, 'decision', queue.subject(job.id)), /Expired/);
  assert.equal(queue.get(job.id).state, 'expired');
  assert.equal(effects, 0);
});

test('upload staging remains ten minutes while a submitted upload stays pinned through its one-hour approval window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'approval-hour-'));
  let now = 0, files, effects = 0;
  const store = new Artifacts(root, { maxBytes: 16, budget: 32, now: () => now }); await store.init();
  const transfers = { upload: async operation => { const file = await store.verified(operation.artifactId); await file.close(); effects++; return { failed: false, texts: [] }; } };
  const queue = new ApprovalQueue({ classify: () => ({ class: 'privileged' }), profile: 'fixture', target: 'fixture', now: () => now,
    executeOperation: operation => transfers.upload(operation), onTerminal: job => files.onTerminal(job) });
  files = createFileService({ store, queue, transfers, now: () => now });
  try {
    const staging = await store.begin({ fileName: 'empty', remotePath: '/tmp/empty', size: 0, sha256: '0'.repeat(64) });
    assert.equal(staging.expiresAt, 600_000);
    const payload = Buffer.from('fixture');
    const result = await files.requestUpload({ fileName: 'fixture', remotePath: '/tmp/fixture', source: {
      inspect: () => ({ allowed: true }), open: async () => ({ stream: Readable.from([payload]), expectedSize: payload.length, close() {} }) } });
    now = 600_001; await files.reap();
    assert.equal(store.has(staging.id), false);
    assert.equal(store.has(result.job.operation.artifactId), true);
    now = result.job.expiresAt - 1; await queue.approve(result.job.id);
    assert.equal(effects, 1);
    await files.reap(); assert.equal(store.has(result.job.operation.artifactId), false);
  } finally { await files.close(); await rm(root, { recursive: true }); }
});
