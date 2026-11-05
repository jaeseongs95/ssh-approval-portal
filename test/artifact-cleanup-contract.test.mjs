import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApplication } from '../app.mjs';
import { hash } from '../src/domain/validation.mjs';

// Real Windows file service, transfer executor, approval queue, operation store and
// public MCP projection; only the remote SSH I/O is synthetic.
async function fixture(t, cleanupConfirmed) {
  const root = await mkdtemp(join(tmpdir(), 'artifact-cleanup-contract-'));
  const entry = { id: 'windows', displayName: 'Windows cleanup fixture', platform: 'windows', readProfile: 'win-read', writeProfile: 'win-write', credentialRevision: 'v1' };
  const app = await createApplication({ transferRoot: root, uiHtml: '<html></html>', audit() {},
    classify: () => ({ class: 'privileged' }), executeCommand: async () => assert.fail('No shell command operation'),
    registry: { getProfile: name => ({ host: 'windows.example.test', port: 22, user: 'fixture', readOnly: name === 'win-read', trustedHostKey: 'SHA256:fixture' }), closeAll: async () => {} },
    env: { BRIDGE_TARGETS: JSON.stringify([entry]), BRIDGE_DEFAULT_TARGET: 'windows',
      BRIDGE_MCP_TOKEN: 'cleanup-contract-fixture', BRIDGE_ADMIN_TOKEN: 'cleanup-owner-fixture',
      BRIDGE_ADMIN_ORIGIN: 'https://owner.example.test', BRIDGE_UI_TICKET_KEY: 'b'.repeat(64),
      BRIDGE_TRANSFER_MAX_BYTES: '64', BRIDGE_TRANSFER_BUDGET_BYTES: '256' } });
  let client;
  t.after(async () => { await client?.close(); await app.close(); assert.ok(root.startsWith(join(tmpdir(), 'artifact-cleanup-contract-'))); await rm(root, { recursive: true }); });
  const runtime = app.targets.select('windows'), stages = new Map(), effects = { upload: 0, publish: 0, cleanup: 0 };
  const foreign = 'C:/ProgramData/ssh-approval-transfer/incoming/' + 'f'.repeat(48) + '.part';
  stages.set(foreign, Buffer.from('foreign stage'));
  runtime.transfers.transport = { async connect(profile, { beforeDispatch, cleanup }) {
    assert.equal(profile, 'win-write'); assert.equal(cleanup.platform, 'windows');
    const ownStage = 'C:/ProgramData/ssh-approval-transfer/incoming/' + cleanup.id + '.part';
    return {
      async upload(stream, path) {
        await beforeDispatch(); assert.equal(path, ownStage);
        const parts = []; for await (const part of stream) parts.push(Buffer.from(part));
        stages.set(path, Buffer.concat(parts)); effects.upload++;
        // Revoke this approval only after remote staging. Publishing must recheck
        // normal authority; fixed own-stage cleanup retains its separate check.
        const deadline = runtime.queue.listAll()[0].expiresAt;
        runtime.queue.now = () => deadline;
      },
      async call(command, payload) {
        assert.match(command, /^powershell\.exe .*windows-file-helper\.ps1"$/);
        assert.equal(payload.action, 'publish'); assert.equal(payload.id, cleanup.id);
        await beforeDispatch(); effects.publish++;
        assert.fail('Expired approval must refuse publication');
      },
      async cleanup() {
        beforeDispatch.cleanup(); effects.cleanup++;
        if (!cleanupConfirmed) throw Error('Synthetic cleanup reply unavailable');
        stages.delete(ownStage); return { exitCode: 0, stdout: '{"cleaned":true}' };
      },
    };
  } };
  await new Promise(resolve => app.mcpHttp.listen(0, '127.0.0.1', resolve));
  client = new Client({ name: 'artifact-cleanup-contract', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + app.mcpHttp.address().port + '/mcp'),
    { requestInit: { headers: { Authorization: 'Bearer cleanup-contract-fixture', Connection: 'close' } } }));
  const ok = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
    assert.equal(response.structuredContent.ok, true); assert.equal(response.structuredContent.error, null);
    assert.doesNotMatch(JSON.stringify(response), /cleanup-contract-fixture|cleanup-owner-fixture|ticket=|approvalTicket/);
    return response.structuredContent.data;
  };
  return { app, runtime, stages, foreign, effects, ok, client };
}

for (const cleanupConfirmed of [true, false]) test('MCP observes Windows staged refusal with ' + (cleanupConfirmed ? 'confirmed' : 'unconfirmed') + ' cleanup without replay', { timeout: 30000 }, async t => {
  const f = await fixture(t, cleanupConfirmed), bytes = Buffer.from([0, 255, 128, 13, 10]);
  const operationKey = 'cleanup-contract-' + (cleanupConfirmed ? 'confirmed' : 'unconfirmed');
  const transfer = await f.ok('artifact-begin', { operationKey, target: 'windows', expectedTargetRevision: f.runtime.revision,
    fileName: 'cleanup.bin', remotePath: 'C:/approved/cleanup.bin', size: bytes.length, sha256: hash(bytes) });
  await f.ok('artifact-chunk', { id: transfer.id, sequence: 0, data: bytes.toString('base64') });
  const pending = await f.ok('artifact-finish', { id: transfer.id }); assert.equal(pending.state, 'pending');
  assert.deepEqual(f.effects, { upload: 0, publish: 0, cleanup: 0 });
  const terminal = await f.app.queue.approve(pending.id);
  const expectedState = cleanupConfirmed ? 'failed' : 'unknown', expectedCleanup = cleanupConfirmed ? 'confirmed' : 'unconfirmed';
  assert.equal(terminal.state, expectedState); assert.equal(terminal.result.data.remoteCleanup, expectedCleanup);
  f.runtime.queue.now = () => Date.now();
  const observed = await f.ok('observe', { id: pending.id });
  assert.equal(observed.id, pending.id); assert.equal(observed.operationKey, operationKey);
  assert.equal(observed.state, expectedState); assert.equal(observed.remoteCleanup, expectedCleanup);
  assert.equal(observed.failed, true); assert.equal(observed.failureCode, 'OPERATION_FAILED');
  assert.equal(observed.execution.automaticReplay, false);
  assert.equal(observed.execution.cleanupComplete, cleanupConfirmed);
  assert.equal(observed.execution.requiresReconciliation, !cleanupConfirmed);
  assert.equal(observed.execution.remoteState, cleanupConfirmed ? 'exited' : 'unknown');
  assert.equal(observed.execution.reason, cleanupConfirmed ? 'input_failed' : 'transport_lost');
  assert.equal(observed.execution.exitCode, cleanupConfirmed ? 1 : null);
  assert.deepEqual(await f.ok('observe', { operationKey }), observed);
  assert.deepEqual((await f.ok('artifact-status', { id: transfer.id })).request, observed);
  assert.deepEqual(await f.ok('artifact-finish', { id: transfer.id }), observed);
  assert.equal(f.app.queue.listAll().length, 1); assert.deepEqual(f.effects, { upload: 1, publish: 0, cleanup: 1 });
  const ownStage = 'C:/ProgramData/ssh-approval-transfer/incoming/' + transfer.id + '.part';
  assert.equal(f.stages.has(ownStage), !cleanupConfirmed);
  if (!cleanupConfirmed) assert.deepEqual(f.stages.get(ownStage), bytes);
  assert.deepEqual(f.stages.get(f.foreign), Buffer.from('foreign stage'));
  assert.throws(() => f.app.queue.start(pending.id));
  await f.app.store.reap(); assert.equal(f.app.store.has(transfer.id), false);
  assert.deepEqual(await f.ok('observe', { id: pending.id }), observed);
  assert.deepEqual(f.effects, { upload: 1, publish: 0, cleanup: 1 });
});

test('MCP records local download quota as failed and not dispatched while preserving the exact quota cause', { timeout: 30000 }, async t => {
  const f = await fixture(t, true);
  for (let index = 0; index < 4; index++) await f.app.store.begin({ fileName: 'reserved.bin', remotePath: 'C:/approved/reserved-' + index + '.bin',
    size: 64, sha256: hash(Buffer.alloc(64)), operationKey: 'quota-pressure-blocker-' + index });
  const baseline = f.app.store.list(); assert.equal(f.app.store.reserved, 256);
  const refused = await f.client.callTool({ name: 'artifact-begin', arguments: { operationKey: 'quota-small-upload-contract', target: 'windows',
    expectedTargetRevision: f.runtime.revision, fileName: 'small.bin', remotePath: 'C:/approved/small.bin', size: 1, sha256: hash(Buffer.from([1])) } });
  assert.equal(refused.isError, true); assert.equal(refused.structuredContent.error.code, 'ARTIFACT_QUOTA');
  assert.equal(f.app.queue.listAll().length, 0); assert.deepEqual(f.app.store.list(), baseline);
  const input = { kind: 'download', operationKey: 'quota-before-ssh-contract', target: 'windows', expectedTargetRevision: f.runtime.revision,
    remotePath: 'C:/approved/input.bin' };
  const pending = await f.ok('submit', input); assert.equal(pending.state, 'pending');
  const terminal = await f.app.queue.approve(pending.id); assert.equal(terminal.state, 'failed');
  const observed = await f.ok('observe', { id: pending.id });
  assert.equal(observed.state, 'failed'); assert.equal(observed.failed, true); assert.equal(observed.failureCode, 'ARTIFACT_QUOTA');
  assert.equal(observed.remoteOutcome, 'not_started'); assert.equal(observed.execution.remoteState, 'not_dispatched');
  assert.equal(observed.execution.reason, 'input_failed'); assert.equal(observed.execution.cleanupComplete, true);
  assert.equal(observed.execution.requiresReconciliation, false); assert.equal(terminal.result.failure.automaticReplay, false);
  assert.deepEqual(await f.ok('observe', { operationKey: input.operationKey }), observed);
  assert.deepEqual(await f.ok('submit', input), observed);
  assert.deepEqual(f.app.store.list(), baseline); assert.equal(f.app.store.reserved, 256);
  assert.deepEqual(f.effects, { upload: 0, publish: 0, cleanup: 0 }); assert.equal(f.app.queue.listAll().length, 1);
});
