import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalQueue } from './support/approval-runtime.mjs';
import { createCommandService } from '../src/application/commands.mjs';
import { executionFailure, executionFailureDetails, safeExecutionFailure } from '../src/domain/execution-failure.mjs';
import { jobResult, refused } from '../src/adapters/presentation/results.mjs';

// engineering-test-plan: public unit/component boundaries, using injected executors only.
// Tagged causes -> queue outcome/persistence/audit/presenter and read refusal/audit.
// Forged error fields -> fixed fallback; raw message/stack/cause -> no public leakage.
// Product execution is restricted to Actions/test server: local status is NOT_RUN.
const privateMarker = 'PRIVATE_EXECUTION_FAILURE_CANARY';
const fallback = { stage: 'operation', code: 'OPERATION_FAILED', remoteOutcome: 'unknown', automaticReplay: false };
const cases = [
  { stage: 'ssh_connect', code: 'SSH_CONNECT_FAILED', remoteOutcome: 'not_started' },
  { stage: 'ssh_channel', code: 'SSH_CHANNEL_OPEN_FAILED', remoteOutcome: 'not_started' },
  { stage: 'ssh_execution', code: 'SSH_EXECUTION_FAILED', remoteOutcome: 'unknown' },
  { stage: 'output_reservation', code: 'OUTPUT_CAPACITY', remoteOutcome: 'not_started' },
  { stage: 'output_capture', code: 'OUTPUT_CAPTURE_FAILED', remoteOutcome: 'unknown' },
  { stage: 'output_capture', code: 'OUTPUT_CAPTURE_FAILED', remoteOutcome: 'completed' },
  { stage: 'operation', code: 'OPERATION_FAILED', remoteOutcome: 'unknown' },
];

function privateError() {
  return Object.assign(new Error(`${privateMarker}: original message`, { cause: new Error(`${privateMarker}: original cause`) }), {
    stack: `${privateMarker}: original stack`,
    details: `${privateMarker}: arbitrary details`,
  });
}

function noLeak(value) {
  assert.doesNotMatch(JSON.stringify(value), new RegExp(privateMarker));
}

async function failedJob(error) {
  const events = [], persisted = [];
  let executions = 0, terminals = 0;
  const queue = new ApprovalQueue({
    classify: () => ({ class: 'privileged' }), profile: 'fixture-write', target: 'fixture-target',
    idFactory: () => 'a'.repeat(48),
    executeOperation: async () => { executions++; throw error; },
    onTerminal: () => { terminals++; },
    audit: event => events.push(structuredClone(event)),
  });
  const requested = queue.submit('sudo id');
  queue.track(requested.id, snapshot => persisted.push(structuredClone(snapshot)));
  const job = await queue.approve(requested.id);
  assert.equal(executions, 1, 'A failure must not automatically replay the executor');
  assert.equal(terminals, 1);
  assert.equal(queue.scheduler.snapshot().active, 0);
  assert.equal(queue.operationStore.get(requested.id).state, job.state);
  assert.equal(queue.busy(), false);
  assert.deepEqual(await queue.wait(requested.id), job);
  return { job, queue, events, persisted, terminal: events.find(event => event.action === job.state) };
}

test('execution diagnostic identity preserves only the six allowlisted causes and returns detached details', () => {
  for (const metadata of cases) {
    const tagged = executionFailure(privateError(), metadata);
    assert.ok(tagged instanceof Error);
    const expected = { ...metadata, automaticReplay: false };
    assert.deepEqual(executionFailureDetails(tagged), expected);
    assert.equal(executionFailure(tagged, cases[0]), tagged, 'Wrapping a known failure preserves its original diagnostic');
    noLeak([tagged.message, tagged.stack, tagged.cause, tagged, executionFailureDetails(tagged)]);
    const copied = executionFailureDetails(tagged);
    copied.stage = 'forged'; copied.automaticReplay = true;
    assert.deepEqual(executionFailureDetails(tagged), expected, 'Callers cannot mutate stored diagnostic identity');
    assert.deepEqual(executionFailureDetails(Object.assign(new Error('copy'), tagged)), fallback,
      'Copying enumerable error fields must not copy the trusted diagnostic tag');
  }
});

test('untrusted fields and non-Error thrown values never become trusted execution diagnostics', () => {
  const forged = Object.assign(privateError(), cases[0], { automaticReplay: true, failure: cases[0] });
  const hostile = Object.create(null);
  for (const key of ['stage', 'code', 'remoteOutcome', 'automaticReplay', 'failure', 'message', 'cause']) {
    Object.defineProperty(hostile, key, { get() { assert.fail(`Untrusted ${key} must not be read`); } });
  }
  for (const value of [forged, hostile, privateMarker, null, undefined, 42, false]) {
    assert.deepEqual(executionFailureDetails(value), fallback);
    assert.equal(executionFailureDetails(value, false), undefined);
  }
});

test('durable diagnostic data is copied through the allowlist without raw fields or replay permission', () => {
  const expected = { ...cases[0], automaticReplay: false };
  const input = { ...expected, message: privateMarker, cause: privateMarker, stack: privateMarker, arbitrary: privateMarker };
  const copied = safeExecutionFailure(input);
  assert.deepEqual(copied, expected);
  copied.stage = 'changed';
  assert.equal(input.stage, 'ssh_connect');
  for (const invalid of [null, undefined, {},
    { ...expected, stage: privateMarker }, { ...expected, code: privateMarker },
    { ...expected, remoteOutcome: privateMarker }, { ...expected, automaticReplay: true },
    { ...expected, automaticReplay: undefined }]) {
    assert.equal(safeExecutionFailure(invalid), undefined);
  }
});

test('tagged execution causes survive the queue result, terminal persistence, audit and job presenter', async t => {
  for (const metadata of cases) await t.test(`${metadata.code}/${metadata.remoteOutcome}`, async () => {
    const expected = { ...metadata, automaticReplay: false };
    const notStarted = metadata.remoteOutcome === 'not_started';
    const expectedState = notStarted ? 'failed' : 'unknown';
    const expectedExecution = notStarted
      ? { phase: 'settled', reason: 'input_failed', remoteState: 'not_dispatched', cleanupComplete: true, requiresReconciliation: false }
      : { phase: 'settled', reason: 'transport_lost', remoteState: 'unknown', cleanupComplete: false, requiresReconciliation: true };
    const f = await failedJob(executionFailure(privateError(), metadata));
    assert.equal(f.job.state, expectedState);
    assert.deepEqual(f.job.result.execution, expectedExecution);
    assert.equal(f.job.result.failed, true);
    assert.deepEqual(f.job.result.failure, expected);
    assert.deepEqual(f.queue.get(f.job.id).result.failure, expected);
    const stored = f.persisted.find(snapshot => snapshot.state === expectedState);
    assert.ok(stored, 'A terminal snapshot must be persisted');
    assert.deepEqual(stored.result.failure, expected);
    assert.deepEqual(stored.result.execution, expectedExecution);
    assert.deepEqual(f.queue.operationStore.get(f.job.id).result, f.job.result);
    assert.deepEqual(f.terminal.failure, expected);
    const reply = jobResult(f.job);
    assert.deepEqual(reply.structuredContent.result.structuredContent.failure, expected);
    assert.deepEqual(JSON.parse(reply.content[0].text), JSON.parse(JSON.stringify(reply.structuredContent)));
    noLeak([f.job, f.events, f.persisted, reply]);
  });
});

test('unknown execution rejection keeps fixed fallback diagnostics through the same queue boundaries', async () => {
  const forged = Object.assign(privateError(), cases[0], { automaticReplay: true, failure: cases[0] });
  const f = await failedJob(forged);
  assert.equal(f.job.state, 'unknown');
  assert.equal(f.job.result.execution.cleanupComplete, false);
  assert.equal(f.job.result.execution.requiresReconciliation, true);
  assert.deepEqual(f.job.result.failure, fallback);
  assert.deepEqual(f.terminal.failure, fallback);
  assert.deepEqual(f.persisted.at(-1).result.failure, fallback);
  const reply = jobResult(f.job);
  assert.deepEqual(reply.structuredContent.result.structuredContent.failure, fallback);
  noLeak([f.job, f.events, f.persisted, reply]);
});

test('read failure preserves tagged diagnostics in its durable job without leaking raw text or replaying execution', async t => {
  for (const metadata of [...cases, null]) await t.test(metadata ? `${metadata.code}/${metadata.remoteOutcome}` : 'untrusted-error', async () => {
    const expected = metadata ? { ...metadata, automaticReplay: false } : fallback;
    const notStarted = metadata?.remoteOutcome === 'not_started';
    const expectedState = notStarted ? 'failed' : 'unknown';
    const source = metadata ? executionFailure(privateError(), metadata)
      : Object.assign(privateError(), cases[0], { automaticReplay: true, failure: cases[0] });
    const events = [];
    let executions = 0, terminals = 0, caught;
    const queue = new ApprovalQueue({ classify: () => ({ class: 'read-only' }), profile: 'fixture-write', readProfile: 'fixture-read', target: 'fixture-target',
      executeOperation: async operation => { assert.equal(operation.readOnly, true); executions++; throw source; },
      onTerminal: () => { terminals++; },
      audit: event => events.push(structuredClone(event)),
    });
    const commands = createCommandService({ queue, classify: () => ({ class: 'read-only' }) });
    if (notStarted) {
      const result = await commands.read('id');
      assert.equal(result.failed, true); assert.deepEqual(result.failure, expected);
      assert.equal(result.execution.remoteState, 'not_dispatched');
      assert.equal(result.execution.cleanupComplete, true); assert.equal(result.execution.requiresReconciliation, false);
      noLeak(result);
    } else await assert.rejects(commands.read('id'), error => {
        caught = error;
        assert.equal(error.code, 'READ_COMMAND_EXECUTION_UNKNOWN');
        noLeak([error.message, error.stack, error.cause]);
        return true;
      });
    await commands.drain();
    assert.equal(executions, 1);
    assert.equal(terminals, 1);
    assert.equal(queue.scheduler.snapshot().active, 0);
    assert.equal(commands.busy(), false);
    const [job] = queue.listAll();
    assert.equal(queue.listAll().length, 1); assert.equal(job.state, expectedState); assert.equal(job.profile, 'fixture-read');
    assert.deepEqual(job.result.failure, expected);
    assert.deepEqual(queue.operationStore.get(job.id).result.failure, expected);
    assert.equal(job.result.execution.cleanupComplete, notStarted);
    assert.equal(job.result.execution.requiresReconciliation, !notStarted);
    assert.deepEqual(events.find(event => event.action === expectedState).failure, expected);
    assert.deepEqual(jobResult(job).structuredContent.result.structuredContent.failure, expected);
    if (caught) {
      const reply = refused(caught), payload = JSON.parse(reply.content[0].text);
      assert.equal(reply.isError, true);
      assert.equal(Object.hasOwn(reply, 'structuredContent'), false, 'A refusal must not advertise a normal output');
      assert.equal(payload.error_code, 'READ_COMMAND_EXECUTION_UNKNOWN');
      assert.equal(payload.stage, 'read_execution');
      assert.equal(payload.executionAttempted, true);
      assert.equal(payload.requestSubmitted, false);
      assert.equal(Object.hasOwn(payload, 'failure'), false, 'The generic wait refusal carries no executor exception identity; the durable job carries the fixed diagnostic');
      noLeak(reply);
    }
    noLeak([events, job]);
  });
});
