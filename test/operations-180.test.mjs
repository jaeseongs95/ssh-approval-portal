import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperations } from '../src/application/operations.mjs';
import { createOperationStore } from '../src/adapters/storage/operation-store.mjs';
import { createOperationScheduler } from '../src/domain/operation-scheduler.mjs';
import { ApprovalQueue } from '../src/domain/approval-queue.mjs';
import { createCommandService } from '../src/application/commands.mjs';
import { createFileService } from '../src/application/files.mjs';

// TEST/Actions only. Actual journal, approval policy, command/file services and scheduler own admission.
const tick = () => new Promise(resolve => setImmediate(resolve));
const outcome = { failed: false, texts: [], execution: { phase: 'settled', reason: 'exit', remoteState: 'exited', cleanupComplete: true, requiresReconciliation: false, exitCode: 0 } };
const input = (operationKey = 'parallel-operation-0001', extra = {}) => ({ kind: 'command', operationKey, target: 'alpha', command: 'printf once', ...extra });

function fixture(t, { beforeAdmission = () => {}, beforeExecute, commandResult } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'operations-api-')), journal = createOperationStore(root), submissions = new AsyncLocalStorage();
  const admissions = [], effects = [], readPages = [], outputBindings = new Map(), executions = [];
  const classify = () => ({ class: 'read-only' });
  let queue;
  const scheduler = createOperationScheduler({ store: journal, globalConcurrency: 1,
    execute: (job, options) => queue.executeScheduled(job.id, options), onChange: job => queue?.syncOperation(job) });
  const target = { id: 'alpha', revision: 'a'.repeat(64), verify() {}, get queue() { return queue; } };
  queue = new ApprovalQueue({ classify, target: target.id, profile: 'test', identity: { targetId: target.id, targetRevision: target.revision },
    scheduler, operationStore: journal, submissionIdentity: () => submissions.getStore(),
    executeOperation: async (operation, id, options) => {
      assert.equal(journal.get(id).state, 'running'); effects.push({ operation, id, signal: options.signal });
      if (beforeExecute) { const execution = Promise.withResolvers(); executions.push(execution); await beforeExecute(execution, options); }
      const value = { ...outcome, output: { id: `output-${id}`, state: 'ready' } };
      outputBindings.set(value.output.id, { targetId: target.id, targetRevision: target.revision, executionId: id });
      return value;
    } });
  queue.beforeDownloadStart = () => ({ decision: 'execute' });
  const commandService = createCommandService({ queue, classify });
  const fileService = createFileService({ store: {}, queue, transfers: {} });
  const targets = { select(id) { if (id !== undefined && id !== target.id) throw Error('Unknown target'); return target; } };
  const commands = {
    async run(command, targetId, key, context, displayContext) {
      admissions.push({ kind: 'command', key, targetId }); await beforeAdmission(key);
      if (commandResult) return commandResult;
      return commandService.run(command, key, context, displayContext);
    },
    async runSource(args, targetId) {
      admissions.push({ kind: 'source', key: args.requestKey, targetId }); await beforeAdmission(args.requestKey);
      // Source preparation is a distinct port; the actual approval/store linkage remains shared.
      return { type: 'job', job: queue.submitOperation({ kind: 'command', command: args.source, argv: args.argv }, 'privileged') };
    },
  };
  const files = { async requestDownload(args) {
    admissions.push({ kind: 'download', key: submissions.getStore().requestKey, targetId: args.target });
    await beforeAdmission(submissions.getStore().requestKey);
    return fileService.requestDownload(args, { targetId: args.target, targetRevision: args.expectedTargetRevision });
  } };
  const outputs = { read(args, authorize) { readPages.push(args); authorize(outputBindings.get(args.outputId)); return { text: 'redacted output', nextOffsetBytes: args.offsetBytes + 15 }; } };
  const operations = createOperations({ targets, queue, commands, files, journal, scheduler, submissions, outputs });
  t.after(async () => {
    scheduler.configure({ paused: true }); for (const execution of executions) execution.resolve();
    await tick(); scheduler.close(); journal.close(); rmSync(root, { recursive: true, force: true });
  });
  return { operations, journal, queue, scheduler, target, admissions, effects, readPages, outputBindings, executions };
}

test('parallel same-key submissions share one durable identity and one approval/execution admission', { timeout: 5000 }, async t => {
  const gate = Promise.withResolvers(), f = fixture(t, { beforeAdmission: () => gate.promise });
  const first = f.operations.submit(input()); await tick();
  const second = f.operations.submit(input()); await tick();
  assert.equal(f.admissions.length, 1); assert.equal(f.journal.usage().count, 0);
  gate.resolve(); const [one, two] = await Promise.all([first, second]); await tick();
  assert.equal(one.id, two.id); assert.equal(f.journal.find(input().operationKey).job.id, one.id);
  assert.equal(f.journal.usage().count, 1); assert.equal(f.queue.jobs.size, 1); assert.equal(f.effects.length, 1);
  assert.equal((await f.operations.submit(input())).id, one.id); assert.equal(f.admissions.length, 1);
});

test('an in-flight key rejects changed bytes before the second port call while independent keys progress', { timeout: 5000 }, async t => {
  const gate = Promise.withResolvers(), firstKey = 'blocked-operation-0001';
  const f = fixture(t, { beforeAdmission: key => key === firstKey ? gate.promise : undefined });
  const first = f.operations.submit(input(firstKey)); await tick();
  await assert.rejects(f.operations.submit(input(firstKey, { command: 'printf changed' })), { code: 'OPERATION_KEY_CONFLICT' });
  const independent = await f.operations.submit(input('independent-operation-0001'));
  assert.equal(independent.operationKey, 'independent-operation-0001'); assert.equal(f.admissions.length, 2);
  gate.resolve(); await first; await tick(); assert.equal(f.effects.length, 2);
});

test('source/download admission uses the same key guard and snapshots mutable source arguments', { timeout: 5000 }, async t => {
  const sourceGate = Promise.withResolvers(), f = fixture(t, { beforeAdmission: () => sourceGate.promise });
  const source = input('source-operation-0001', { kind: 'source', source: 'print(1)', argv: ['original'] });
  const first = f.operations.submit(source), repeated = f.operations.submit(structuredClone(source));
  source.argv[0] = 'changed after submission'; sourceGate.resolve();
  const [one, two] = await Promise.all([first, repeated]);
  assert.equal(one.id, two.id); assert.deepEqual(f.journal.get(one.id).input.operation.argv, ['original']);
  const download = input('download-operation-0001', { kind: 'download', remotePath: '/tmp/report.txt' });
  const [downloadOne, downloadTwo] = await Promise.all([f.operations.submit(download), f.operations.submit(download)]);
  assert.equal(downloadOne.id, downloadTwo.id); assert.equal(f.admissions.filter(item => item.kind === 'download').length, 1);
});

test('a failed admission releases its key without inventing acceptance or replaying accepted work', { timeout: 5000 }, async t => {
  let attempts = 0;
  const f = fixture(t, { beforeAdmission: () => { if (++attempts === 1) throw Object.assign(Error('refused'), { code: 'PRE_ADMISSION_REFUSAL' }); } });
  await assert.rejects(f.operations.submit(input()), { code: 'PRE_ADMISSION_REFUSAL' });
  assert.equal(f.journal.find(input().operationKey), null); assert.equal(f.effects.length, 0);
  const accepted = await f.operations.submit(input()); await tick();
  assert.equal(f.journal.find(input().operationKey).job.id, accepted.id); assert.equal(f.effects.length, 1);
});

test('a port returning a different journal identity cannot confirm this operation key', { timeout: 5000 }, async t => {
  const f = fixture(t, { commandResult: { type: 'job', job: { id: 'unrelated' } } });
  f.journal.accept({ id: 'unrelated', requestKey: 'unrelated-operation-0001', owner: 'mcp', targetId: 'alpha', targetRevision: f.target.revision,
    kind: 'command', input: { command: 'other' }, inputDigest: 'unrelated' });
  await assert.rejects(f.operations.submit(input()), { code: 'OPERATION_KEY_CONFLICT' });
  assert.equal(f.journal.find(input().operationKey), null); assert.equal(f.effects.length, 0);
});

test('observation reads output only on explicit request and preserves target/revision/execution authorization', { timeout: 5000 }, async t => {
  const f = fixture(t), accepted = await f.operations.submit(input()); await tick();
  const ordinary = await f.operations.observe({ id: accepted.id });
  assert.equal(ordinary.outputPage, undefined); assert.deepEqual(f.readPages, []);
  const explicit = await f.operations.observe({ id: accepted.id, includeOutput: true, cursor: 2, maxBytes: 128 });
  assert.equal(explicit.outputPage.text, 'redacted output'); assert.equal(f.readPages[0].offsetBytes, 2); assert.equal(f.readPages[0].maxBytes, 128);
  const outputId = f.journal.get(accepted.id).result.output.id;
  f.outputBindings.set(outputId, { targetId: 'alpha', targetRevision: f.target.revision, executionId: 'wrong-execution' });
  await assert.rejects(f.operations.observe({ id: accepted.id, includeOutput: true }), { code: 'OUTPUT_BINDING_CONFLICT' });
  f.target.revision = 'b'.repeat(64);
  await assert.rejects(f.operations.observe({ id: accepted.id }), { code: 'TARGET_REVISION_CONFLICT' });
  assert.throws(() => f.operations.cancel({ id: accepted.id }), { code: 'TARGET_REVISION_CONFLICT' });
});

test('cancellation targets the original operation and never submits a replacement', { timeout: 5000 }, async t => {
  const f = fixture(t, { beforeExecute: execution => execution.promise }), accepted = await f.operations.submit(input()); await tick();
  assert.equal(f.operations.cancel({ id: accepted.id }).state, 'terminating');
  assert.equal(f.effects[0].signal.aborted, true); assert.equal(f.admissions.length, 1);
  f.executions[0].resolve(); await tick();
  assert.equal(f.journal.usage().count, 1); assert.equal(f.effects.length, 1);
});
