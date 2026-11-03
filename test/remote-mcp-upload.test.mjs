import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApplication } from '../app.mjs';
import { Artifacts } from '../src/adapters/storage/artifacts.mjs';
import { createFileService } from '../src/application/files.mjs';
import { CHUNK_BYTES, MAX_BYTES } from '../src/contracts/ports.mjs';
import { hash } from '../src/domain/validation.mjs';

// Standard remote MCP -> real application/router/store/queue; only SSH is synthetic.
// No local file chooser, local MCP process, real credentials or external source URL.
const names = ['artifact-begin', 'artifact-chunk', 'artifact-status', 'artifact-finish'];
const privateMarker = 'SYNTHETIC-PRIVATE-CHUNK-CREDENTIAL';
async function fixture(t, { maxBytes = CHUNK_BYTES * 2, uiEnabled = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'remote-mcp-json-')), effects = [], published = [];
  const entries = ['linux', 'windows', 'offline'].map(id => ({ id, displayName: id, platform: id === 'windows' ? 'windows' : 'linux',
    readProfile: id + '-read', writeProfile: id + '-write', credentialRevision: 'v1', enabled: id !== 'offline' }));
  const profiles = new Map(entries.flatMap(entry => [entry.readProfile, entry.writeProfile].map(name => [name,
    { host: entry.id + '.example.test', port: 22, user: 'fixture', readOnly: name === entry.readProfile, trustedHostKey: 'SHA256:' + entry.id }])));
  const app = await createApplication({ registry: { getProfile: name => profiles.get(name), closeAll: async () => {} },
    classify: () => ({ class: 'privileged' }), executeCommand: async () => assert.fail('JSON upload must not execute shell commands'),
    audit() {}, transferRoot: root, uiHtml: '<html>fixture</html>',
    uploadSource: { inspect() { assert.fail('JSON bytes must not use a URL source'); }, open() { assert.fail('No URL import'); } },
    env: { BRIDGE_MCP_TOKEN: 'remote-json-fixture-mcp', BRIDGE_ADMIN_TOKEN: 'remote-json-fixture-admin',
      BRIDGE_ADMIN_ORIGIN: 'https://owner.example.test', BRIDGE_UI_TICKET_KEY: 'b'.repeat(64), BRIDGE_UI_ENABLED: String(uiEnabled),
      BRIDGE_TRANSFER_MAX_BYTES: String(maxBytes), BRIDGE_TRANSFER_BUDGET_BYTES: String(maxBytes * 4),
      BRIDGE_TARGETS: JSON.stringify(entries), BRIDGE_DEFAULT_TARGET: 'linux' } });
  for (const runtime of entries.filter(entry => entry.enabled).map(entry => app.targets.select(entry.id))) {
    runtime.transfers.transport = { async connect(profile) {
      runtime.verify(); effects.push({ action: 'connect', target: runtime.id, profile });
      let bytes;
      return { async upload(stream) { const parts = []; for await (const part of stream) parts.push(Buffer.from(part)); bytes = Buffer.concat(parts); },
        async call(_command, payload) {
          effects.push({ action: payload.action, target: runtime.id });
          if (payload.action === 'publish') {
            assert.equal(bytes.length, payload.size); assert.equal(hash(bytes), payload.sha256);
            published.push({ target: runtime.id, path: payload.remotePath, bytes });
            return { exitCode: 0, stdout: JSON.stringify({ size: bytes.length, sha256: hash(bytes) }) };
          }
          assert.equal(payload.action, 'cleanup'); return { exitCode: 0, stdout: '{}' };
        } };
    } };
  }
  let client;
  t.after(async () => { await client?.close(); await app.close(); assert.ok(root.startsWith(join(tmpdir(), 'remote-mcp-json-'))); await rm(root, { recursive: true }); });
  await Promise.all([app.mcpHttp, app.adminHttp].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const url = new URL('http://127.0.0.1:' + app.mcpHttp.address().port + '/mcp');
  client = new Client({ name: 'provider-independent-json-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer remote-json-fixture-mcp', Connection: 'close' } } }));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15000 });
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC-PRIVATE-CHUNK-CREDENTIAL|remote-json-fixture-(?:mcp|admin)|approvalTicket|uploadTicket|bootstrapTicket/);
    return result;
  };
  const ok = async (name, args) => { const result = await call(name, args); assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent); return result.structuredContent.data; };
  let operationSequence = 0;
  const meta = (bytes, { target = 'linux', remotePath = target === 'windows' ? 'C:/upload/fixture.bin' : '/tmp/fixture.bin', ...extra } = {}) => ({
    operationKey: 'remote-upload-contract-' + (++operationSequence), target, expectedTargetRevision: app.targets.list().targets.find(item => item.id === target)?.revision,
    fileName: 'fixture.bin', remotePath, size: bytes.length, sha256: hash(bytes), ...extra });
  return { root, app, client, url, call, ok, meta, profiles, effects, published,
    jobs: () => app.queue.listAll().filter(job => job.kind === 'upload'),
    bytes: id => readFile(join(root, id + '.part')) };
}
const transferKeys = ['id', 'received', 'sequence', 'size', 'sha256', 'expiresAt', 'targetId', 'targetRevision'].sort();
const refusalCode = result => { assert.equal(result.isError, true); return JSON.parse(result.content[0].text).error.code; };

test('REMOTE-JSON schemas expose strict model tools without Apps or private upload tickets', { timeout: 30000 }, async t => {
  for (const uiEnabled of [false, true]) {
    const f = await fixture(t, { uiEnabled }), tools = (await f.client.listTools()).tools;
    for (const name of names) {
      const descriptor = tools.find(tool => tool.name === name); assert.ok(descriptor, name + ' must be available on the existing remote MCP connection');
      assert.equal(descriptor.inputSchema.additionalProperties, false); assert.notDeepEqual(descriptor._meta?.ui?.visibility, ['app']);
      assert.equal(descriptor._meta?.['openai/fileParams'], undefined);
    }
    const begin = tools.find(tool => tool.name === 'artifact-begin').inputSchema;
    assert.deepEqual([...begin.required].sort(), ['operationKey', 'target', 'expectedTargetRevision', 'fileName', 'remotePath', 'size', 'sha256'].sort());
    assert.deepEqual(Object.keys(begin.properties).sort(), ['operationKey', 'target', 'expectedTargetRevision', 'fileName', 'remotePath', 'size', 'sha256', 'overwrite', 'elevate'].sort());
    assert.equal(begin.properties.size.maximum, MAX_BYTES);
    const input = f.meta(Buffer.alloc(0)), selected = await f.ok('artifact-begin', input);
    assert.equal((await f.ok('artifact-begin', input)).id, selected.id);
    assert.equal((await f.call('artifact-begin', { ...input, remotePath: '/tmp/conflicting-key.bin' })).isError, true);
    assert.deepEqual(Object.keys(selected).sort(), ['id', 'received', 'sequence', 'size', 'sha256', 'expiresAt', 'targetId', 'targetRevision', 'maxChunkBytes'].sort());
    assert.equal(selected.maxChunkBytes, CHUNK_BYTES); assert.equal(selected.sequence, 0); assert.equal(selected.received, 0);
    const status = await f.ok('artifact-status', { id: selected.id });
    assert.equal(status.state, 'staging'); assert.deepEqual(Object.keys(status.transfer).sort(), transferKeys);
    assert.equal(f.effects.length, 0); assert.equal(f.jobs().length, 0);
  }
});

test('REMOTE-JSON real binary and empty uploads bind bytes and target without effects before owner approval', { timeout: 60000 }, async t => {
  const binary = Buffer.alloc(CHUNK_BYTES + 17); for (let i = 0; i < binary.length; i++) binary[i] = i % 256;
  for (const [target, bytes, remotePath] of [['linux', binary, '/tmp/binary.bin'], ['linux', Buffer.alloc(0), '/tmp/empty.bin'],
    ['windows', Buffer.from([0, 255, 128, 13, 10]), 'C:/upload/binary.bin'], ['windows', Buffer.alloc(0), 'C:\\upload\\empty.bin']]) {
    const f = await fixture(t), input = f.meta(bytes, { target, remotePath }), begin = await f.ok('artifact-begin', input), id = begin.id;
    assert.match(id, /^[a-f0-9]{48}$/); assert.equal(begin.size, bytes.length); assert.equal(begin.sha256, hash(bytes));
    assert.equal(begin.targetId, target); assert.equal(begin.targetRevision, input.expectedTargetRevision);
    assert.equal(f.app.store.get(id).uploadProtocol, 'mcp-json-v1'); assert.equal(f.app.store.get(id).fileTargetBound, true);
    for (let offset = 0, sequence = 0; offset < bytes.length; offset += CHUNK_BYTES, sequence++) {
      const part = bytes.subarray(offset, offset + CHUNK_BYTES), ack = await f.ok('artifact-chunk', { id, sequence, data: part.toString('base64') });
      assert.deepEqual(ack, { sequence: sequence + 1, received: Math.min(offset + CHUNK_BYTES, bytes.length) });
    }
    assert.deepEqual(await f.bytes(id), bytes); assert.equal(f.effects.length, 0); assert.equal(f.jobs().length, 0);
    const pending = await f.ok('artifact-finish', { id }); assert.equal(pending.state, 'pending'); assert.equal(pending.kind, 'upload');
    assert.equal(f.app.queue.get(pending.id).operation.artifactId, id); assert.equal(f.app.queue.get(pending.id).operation.fileTargetId, target);
    assert.equal(f.app.queue.get(pending.id).operation.fileTargetRevision, input.expectedTargetRevision); assert.equal(f.app.queue.get(pending.id).operation.uploadProtocol, 'mcp-json-v1');
    assert.equal(f.app.queue.get(pending.id).operation.overwrite, false); assert.equal(f.app.queue.get(pending.id).operation.elevate, false); assert.equal(f.effects.length, 0);
    const submitted = await f.ok('artifact-status', { id }); assert.equal(submitted.state, 'submitted'); assert.equal(submitted.request.id, pending.id);
    assert.equal(f.jobs().length, 1); assert.equal(f.effects.length, 0);
    const completed = await f.app.queue.approve(pending.id); assert.equal(completed.state, 'completed');
    assert.deepEqual(f.published, [{ target, path: remotePath, bytes }]);
    const completedStatus = await f.ok('artifact-status', { id });
    assert.equal(completedStatus.request.id, pending.id); assert.equal(completedStatus.request.state, 'completed');
    const effectsAfterCompletion = structuredClone(f.effects);
    await f.app.store.reap();
    assert.equal(f.app.store.has(id), false); assert.equal(f.app.store.reserved, 0);
    await assert.rejects(f.bytes(id), { code: 'ENOENT' });
    assert.deepEqual(await f.ok('artifact-status', { id }), completedStatus);
    assert.equal((await f.ok('artifact-finish', { id })).id, pending.id);
    assert.equal(f.jobs().length, 1); assert.equal(f.published.length, 1); assert.deepEqual(f.effects, effectsAfterCompletion);
  }
});

test('REMOTE-JSON missing binding invalid metadata and extra authority allocate nothing', { timeout: 30000 }, async t => {
  const f = await fixture(t, { maxBytes: 16 }), input = f.meta(Buffer.from([0, 255]));
  assert.equal(refusalCode(await f.call('artifact-begin', { ...input, expectedTargetRevision: 'f'.repeat(64) })), 'ARTIFACT_STALE_TARGET');
  const { target, ...noTarget } = input, { expectedTargetRevision, ...noRevision } = input, { operationKey, ...noKey } = input;
  for (const bad of [noKey, noTarget, noRevision, { ...input, expectedTargetRevision: 'f'.repeat(64) }, { ...input, target: 'offline' },
    { ...input, target: 'missing' }, { ...input, size: -1 }, { ...input, size: MAX_BYTES + 1 }, { ...input, size: 17 },
    { ...input, sha256: 'INVALID' }, { ...input, fileName: '../unsafe' }, { ...input, remotePath: 'C:/wrong-platform.bin' },
    { ...input, remotePath: 'relative' }, { ...input, overwrite: 'true' }, { ...input, elevate: 'true' }, { ...input, approve: true }]) {
    assert.equal((await f.call('artifact-begin', bad)).isError, true); assert.equal(f.app.store.size, 0); assert.equal(f.app.store.reserved, 0);
  }
  for (const name of names.slice(1)) {
    for (const bad of [{ id: 'z'.repeat(48) }, { id: 'a'.repeat(48), approve: true }]) assert.equal((await f.call(name, bad)).isError, true);
  }
  assert.equal(f.jobs().length, 0); assert.equal(f.effects.length, 0);
});

test('REMOTE-JSON canonical chunk bounds duplicate ACK and rejected sequence preserve staged bytes', { timeout: 30000 }, async t => {
  const f = await fixture(t), bytes = Buffer.from([0, 255, 128, 65]), begin = await f.ok('artifact-begin', f.meta(bytes)), id = begin.id;
  for (const data of ['', 'AA', 'AA==\n', '__8=', 'Zh==', privateMarker, Buffer.alloc(CHUNK_BYTES + 1).toString('base64')]) {
    assert.equal((await f.call('artifact-chunk', { id, sequence: 0, data })).isError, true);
    assert.deepEqual(await f.bytes(id), Buffer.alloc(0));
  }
  for (const sequence of [-1, 0.5, 1]) assert.equal((await f.call('artifact-chunk', { id, sequence, data: 'AP8=' })).isError, true);
  const first = { id, sequence: 0, data: bytes.subarray(0, 2).toString('base64') };
  assert.deepEqual(await f.ok('artifact-chunk', first), { sequence: 1, received: 2 });
  assert.deepEqual(await f.ok('artifact-chunk', first), { sequence: 1, received: 2 });
  for (const bad of [{ id, sequence: 0, data: 'Zm8=' }, { id, sequence: 3, data: 'gEE=' }, { id, sequence: 1, data: 'gEEA' }, { ...first, approve: true }]) {
    assert.equal((await f.call('artifact-chunk', bad)).isError, true); assert.deepEqual(await f.bytes(id), bytes.subarray(0, 2));
  }
  const status = await f.ok('artifact-status', { id }); assert.equal(status.transfer.received, 2); assert.equal(status.transfer.sequence, 1);
  await f.ok('artifact-chunk', { id, sequence: 1, data: bytes.subarray(2).toString('base64') });
  assert.equal((await f.ok('artifact-finish', { id })).state, 'pending'); assert.equal(f.jobs().length, 1); assert.equal(f.effects.length, 0);
});

test('REMOTE-JSON incomplete and hash-mismatched finishes create no upload job', { timeout: 30000 }, async t => {
  const f = await fixture(t), bytes = Buffer.from([0, 255, 128, 65]);
  const incomplete = await f.ok('artifact-begin', f.meta(bytes));
  await f.ok('artifact-chunk', { id: incomplete.id, sequence: 0, data: bytes.subarray(0, 2).toString('base64') });
  assert.equal(refusalCode(await f.call('artifact-finish', { id: incomplete.id })), 'ARTIFACT_INCOMPLETE_OR_EXPIRED');
  const staging = await f.ok('artifact-status', { id: incomplete.id }); assert.equal(staging.state, 'staging'); assert.equal(staging.transfer.received, 2);
  const corrupt = await f.ok('artifact-begin', f.meta(bytes, { sha256: hash(Buffer.from('different')) }));
  await f.ok('artifact-chunk', { id: corrupt.id, sequence: 0, data: bytes.toString('base64') });
  assert.equal(refusalCode(await f.call('artifact-finish', { id: corrupt.id })), 'ARTIFACT_HASH_MISMATCH');
  assert.equal(f.app.store.has(corrupt.id), false);
  assert.equal(refusalCode(await f.call('artifact-status', { id: corrupt.id })), 'ARTIFACT_UNKNOWN');
  assert.equal(f.jobs().length, 0); assert.equal(f.effects.length, 0); assert.equal(f.app.store.reserved, bytes.length);
});

test('REMOTE-JSON simultaneous finish and lost reply recover one immutable request through status', { timeout: 30000 }, async t => {
  const f = await fixture(t), bytes = Buffer.from([0, 255]), begin = await f.ok('artifact-begin', f.meta(bytes, { overwrite: true, elevate: true })), id = begin.id;
  await f.ok('artifact-chunk', { id, sequence: 0, data: bytes.toString('base64') });
  const finished = await Promise.all([f.call('artifact-finish', { id }), f.call('artifact-finish', { id })]);
  const successes = finished.filter(result => result.isError !== true); assert.equal(successes.length, 2); assert.equal(successes[0].structuredContent.data.id, successes[1].structuredContent.data.id);
  const job = successes[0].structuredContent.data; assert.equal(job.state, 'pending'); assert.equal(f.app.queue.get(job.id).operation.overwrite, true); assert.equal(f.app.queue.get(job.id).operation.elevate, true);
  assert.equal(f.jobs().length, 1); assert.equal((await f.ok('artifact-status', { id })).request.id, job.id);
  assert.equal((await f.ok('artifact-finish', { id })).id, job.id); assert.equal(f.jobs().length, 1); assert.equal(f.effects.length, 0);
});

test('REMOTE-JSON status distinguishes ready while UI artifacts and stale targets cannot enter the JSON path', { timeout: 30000 }, async t => {
  const f = await fixture(t), bytes = Buffer.from([0, 255]), input = f.meta(bytes);
  const { operationKey: _unusedKey, ...legacyInput } = input;
  const legacy = await f.app.targets.files.beginUpload(legacyInput);
  for (const name of ['artifact-status', 'artifact-finish']) assert.equal(refusalCode(await f.call(name, { id: legacy.id })), 'ARTIFACT_WRONG_PROTOCOL');
  assert.equal(refusalCode(await f.call('artifact-chunk', { id: legacy.id, sequence: 0, data: bytes.toString('base64') })), 'ARTIFACT_WRONG_PROTOCOL');
  assert.equal(f.app.store.get(legacy.id).received, 0); assert.equal(f.jobs().length, 0);
  const ready = await f.ok('artifact-begin', input); await f.ok('artifact-chunk', { id: ready.id, sequence: 0, data: bytes.toString('base64') });
  await f.app.store.finish(ready.id);
  assert.equal((await f.ok('artifact-status', { id: ready.id })).state, 'ready');
  assert.equal(refusalCode(await f.call('artifact-finish', { id: ready.id })), 'ARTIFACT_INCOMPLETE_OR_EXPIRED'); assert.equal(f.jobs().length, 0);
  const stale = await f.ok('artifact-begin', { ...input, operationKey: input.operationKey + '-stale' }), runtime = f.app.targets.select('linux');
  f.profiles.get(runtime.writeProfile).host = 'changed.example.test';
  for (const name of ['artifact-status', 'artifact-finish']) assert.equal(refusalCode(await f.call(name, { id: stale.id })), 'ARTIFACT_STALE_TARGET');
  assert.equal(refusalCode(await f.call('artifact-chunk', { id: stale.id, sequence: 0, data: bytes.toString('base64') })), 'ARTIFACT_STALE_TARGET');
  assert.equal(f.app.store.get(stale.id).received, 0); assert.equal(f.effects.length, 0); assert.equal(f.jobs().length, 0);
});

test('REMOTE-JSON authentication and opaque public failures never echo bytes or allocate uploads', { timeout: 30000 }, async t => {
  const f = await fixture(t), input = f.meta(Buffer.from([0, 255]));
  const response = await fetch(f.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'artifact-begin', arguments: input } }) });
  assert.equal(response.status, 401); await response.body?.cancel();
  for (const name of ['artifact-status', 'artifact-finish']) assert.equal(refusalCode(await f.call(name, { id: 'a'.repeat(48) })), 'ARTIFACT_UNKNOWN');
  f.app.targets.files.beginAgentUpload = async () => { throw Object.assign(Error(privateMarker), { code: privateMarker, cause: Error('/PRIVATE-BACKING-PATH') }); };
  const refused = await f.call('artifact-begin', input); assert.equal(refusalCode(refused), 'REQUEST_REFUSED'); assert.doesNotMatch(JSON.stringify(refused), /PRIVATE-BACKING-PATH/);
  assert.equal(f.app.store.size, 0); assert.equal(f.jobs().length, 0); assert.equal(f.effects.length, 0);
});

test('REMOTE-JSON real service and artifact clock report expiry without writing or submitting', async t => {
  const root = await mkdtemp(join(tmpdir(), 'remote-mcp-json-clock-')); let now = 1000;
  const store = new Artifacts(root, { maxBytes: 16, budget: 32, now: () => now }); await store.init();
  const service = createFileService({ store, queue: { listAll: () => [], maintenance: false }, now: () => now });
  t.after(async () => { await service.close(); assert.ok(root.startsWith(join(tmpdir(), 'remote-mcp-json-clock-'))); await rm(root, { recursive: true }); });
  const bytes = Buffer.from([0, 255]), item = await service.beginAgentUpload({ operationKey: 'remote-upload-clock-180', fileName: 'clock.bin', remotePath: '/tmp/clock.bin', size: bytes.length, sha256: hash(bytes) },
    { targetId: 'linux', targetRevision: 'd'.repeat(64) });
  assert.equal(service.agentUploadStatus(item.id).state, 'staging'); now = item.expiresAt;
  assert.equal(service.agentUploadStatus(item.id).state, 'expired');
  await assert.rejects(service.appendAgentUpload({ id: item.id, sequence: 0, bytes })); await assert.rejects(service.finishAgentUpload(item.id));
  assert.equal(store.get(item.id).received, 0); await store.reap(); assert.equal(store.size, 0); assert.equal(store.reserved, 0);
});
