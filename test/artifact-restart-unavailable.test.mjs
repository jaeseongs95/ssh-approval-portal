import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApplication } from '../app.mjs';
import { Artifacts } from '../src/adapters/storage/artifacts.mjs';
import { scopedArtifacts } from '../src/adapters/storage/scoped-artifacts.mjs';
import { hash } from '../src/domain/validation.mjs';

// Real application, HTTP MCP, SQLite journal, scheduler and durable artifact files.
// Only SSH transport is synthetic; its publication counter must survive app replacement.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'artifact-restart-f4-')), effects = [], published = [];
  const entries = ['alpha', 'beta'].map(id => ({ id, displayName: id, readProfile: id + '-read',
    writeProfile: id + '-write', credentialRevision: 'v1', enabled: true }));
  const profiles = new Map(entries.flatMap(entry => [entry.readProfile, entry.writeProfile].map(name => [name,
    { host: entry.id + '.example.test', port: 22, user: 'fixture', readOnly: name === entry.readProfile, trustedHostKey: 'SHA256:' + entry.id }])));
  let app, client, sequence = 0;
  const stop = async () => { await client?.close(); client = undefined; await app?.close(); app = undefined; };
  t.after(async () => { await stop(); assert.ok(root.startsWith(join(tmpdir(), 'artifact-restart-f4-'))); await rm(root, { recursive: true }); });
  const start = async () => {
    app = await createApplication({ registry: { getProfile: name => profiles.get(name), closeAll: async () => {} },
      classify: () => ({ class: 'privileged' }), executeCommand: async () => assert.fail('Upload restore must not execute a command'),
      audit() {}, transferRoot: root, uiHtml: '<html>fixture</html>', env: {
        BRIDGE_MCP_TOKEN: 'restart-fixture-mcp', BRIDGE_ADMIN_TOKEN: 'restart-fixture-admin',
        BRIDGE_ADMIN_ORIGIN: 'https://owner.example.test', BRIDGE_UI_TICKET_KEY: 'b'.repeat(64), BRIDGE_UI_ENABLED: 'false',
        BRIDGE_TRANSFER_MAX_BYTES: '64', BRIDGE_TRANSFER_BUDGET_BYTES: '256',
        BRIDGE_TARGETS: JSON.stringify(entries), BRIDGE_DEFAULT_TARGET: 'alpha' } });
    for (const entry of entries) {
      const runtime = app.targets.select(entry.id);
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
            assert.equal(payload.action, 'cleanup'); return { exitCode: 0, stdout: JSON.stringify({ cleaned: true }) };
          } };
      } };
    }
    await Promise.all([app.mcpHttp, app.adminHttp].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
    client = new Client({ name: 'artifact-restart-f4', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + app.mcpHttp.address().port + '/mcp'),
      { requestInit: { headers: { Authorization: 'Bearer restart-fixture-mcp', Connection: 'close' } } }));
  };
  const ok = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15000 });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.doesNotMatch(JSON.stringify(result), /restart-fixture-(?:mcp|admin)|approvalTicket|uploadTicket/);
    return result.structuredContent.data;
  };
  const stage = async (bytes, { finish = true, partial = false } = {}) => {
    const operationKey = 'artifact-restart-f4-' + (++sequence), target = 'alpha';
    const meta = { operationKey, target, expectedTargetRevision: app.targets.select(target).revision,
      fileName: 'fixture.bin', remotePath: '/tmp/f4-' + sequence + '.bin', size: bytes.length, sha256: hash(bytes) };
    const artifact = await ok('artifact-begin', meta);
    const chunk = partial ? bytes.subarray(0, 1) : bytes;
    if (chunk.length) await ok('artifact-chunk', { id: artifact.id, sequence: 0, data: chunk.toString('base64') });
    const job = finish ? await ok('artifact-finish', { id: artifact.id }) : undefined;
    if (job) assert.equal(job.state, 'pending');
    return { artifact, job, operationKey, bytes, meta };
  };
  await start();
  return { root, effects, published, ok, stage, get app() { return app; },
    restart: async () => { await stop(); await start(); },
    bytes: id => readFile(join(root, id + '.part')),
    manifest: id => readFile(join(root, id + '.json')) };
}

async function history(f, upload) {
  const byId = await f.ok('observe', { id: upload.job.id }), byKey = await f.ok('observe', { operationKey: upload.operationKey });
  assert.deepEqual(byId, byKey);
  return { observed: byId, status: await f.ok('artifact-status', { id: upload.artifact.id }) };
}

test('F4-REAP completed upload survives two real application restarts after TTL artifact removal without replay', { timeout: 60000 }, async t => {
  const f = await fixture(t), upload = await f.stage(Buffer.from([0, 255, 128, 13, 10]));
  assert.equal((await f.app.queue.approve(upload.job.id)).state, 'completed');
  assert.deepEqual(f.published, [{ target: 'alpha', path: upload.meta.remotePath, bytes: upload.bytes }]);
  const before = await history(f, upload), effects = structuredClone(f.effects);
  await f.app.store.reap();
  assert.equal(f.app.store.has(upload.artifact.id), false); assert.equal(f.app.store.reserved, 0);
  await assert.rejects(f.bytes(upload.artifact.id), { code: 'ENOENT' });
  await assert.rejects(f.manifest(upload.artifact.id), { code: 'ENOENT' });
  for (let restart = 0; restart < 2; restart++) {
    await f.restart();
    assert.deepEqual(await history(f, upload), before);
    assert.equal((await f.ok('artifact-finish', { id: upload.artifact.id })).id, upload.job.id);
    assert.equal(f.app.queue.listAll().length, 1); assert.equal(f.app.store.size, 0); assert.equal(f.app.store.reserved, 0);
    assert.deepEqual(f.effects, effects); assert.equal(f.published.length, 1);
  }
});

test('F4-MISSING denied upload history survives explicit artifact removal and restart without creating execution', { timeout: 60000 }, async t => {
  const f = await fixture(t), upload = await f.stage(Buffer.from('never-publish'));
  assert.equal(f.app.queue.deny(upload.job.id).state, 'denied');
  const before = await history(f, upload);
  await f.app.store.remove(upload.artifact.id);
  await f.restart();
  assert.deepEqual(await history(f, upload), before);
  assert.equal((await f.ok('artifact-finish', { id: upload.artifact.id })).id, upload.job.id);
  assert.equal(f.app.queue.listAll().length, 1); assert.equal(f.app.store.size, 0);
  assert.deepEqual(f.effects, []); assert.deepEqual(f.published, []);
});

test('F4-PRESERVE restart keeps pending pinned and partial artifacts while cleaning present terminal artifacts', { timeout: 60000 }, async t => {
  const f = await fixture(t), terminal = await f.stage(Buffer.from('terminal'));
  assert.equal((await f.app.queue.approve(terminal.job.id)).state, 'completed');
  const pending = await f.stage(Buffer.from([0, 128, 255])), partial = await f.stage(Buffer.from('partial'), { finish: false, partial: true });
  const retained = [pending, partial], snapshots = await Promise.all(retained.map(async item => ({
    metadata: f.app.store.get(item.artifact.id), manifest: await f.manifest(item.artifact.id), bytes: await f.bytes(item.artifact.id) })));
  assert.equal(snapshots[0].metadata.pinned, true); assert.equal(snapshots[1].metadata.state, 'staging');
  const quota = f.app.store.reserved, before = await history(f, terminal), effects = structuredClone(f.effects);
  await f.restart();
  assert.deepEqual(await history(f, terminal), before); assert.deepEqual(f.effects, effects);
  assert.equal(f.app.store.reserved, quota); assert.equal(f.app.store.size, 3);
  assert.equal(f.app.store.get(terminal.artifact.id).pinned, false);
  assert.deepEqual(await f.bytes(terminal.artifact.id), terminal.bytes);
  for (const [index, item] of retained.entries()) {
    assert.deepEqual(f.app.store.get(item.artifact.id), snapshots[index].metadata);
    assert.deepEqual(await f.manifest(item.artifact.id), snapshots[index].manifest);
    assert.deepEqual(await f.bytes(item.artifact.id), snapshots[index].bytes);
  }
  assert.equal((await f.ok('artifact-status', { id: pending.artifact.id })).request.state, 'pending');
  assert.equal((await f.ok('artifact-status', { id: partial.artifact.id })).state, 'staging');
  await f.app.store.reap();
  assert.equal(f.app.store.has(terminal.artifact.id), false);
  assert.equal(f.app.store.reserved, pending.bytes.length + partial.bytes.length);
  assert.equal((await f.app.queue.approve(pending.job.id)).state, 'completed');
  assert.deepEqual(f.published.map(item => item.bytes), [terminal.bytes, pending.bytes]);
  assert.equal(f.app.store.has(partial.artifact.id), true);
});

test('F4-RELEASE missing cleanup is typed and repeatable while present wrong target or revision remains forbidden', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-release-f4-'));
  t.after(async () => { assert.ok(root.startsWith(join(tmpdir(), 'artifact-release-f4-'))); await rm(root, { recursive: true }); });
  const store = new Artifacts(root, { maxBytes: 64, budget: 256, now: () => 1000 }); await store.init();
  const identity = { targetId: 'alpha', targetRevision: 'a'.repeat(64) }, owner = scopedArtifacts(store, identity);
  const foreign = scopedArtifacts(store, { ...identity, targetId: 'beta' }), stale = scopedArtifacts(store, { ...identity, targetRevision: 'b'.repeat(64) });
  const bytes = Buffer.from([0, 255, 128]), item = await owner.begin({ fileName: 'owned.bin', remotePath: '/tmp/owned.bin', size: bytes.length, sha256: hash(bytes) });
  await owner.append(item.id, 0, bytes); await owner.finish(item.id);
  const metadata = store.get(item.id), manifest = await readFile(join(root, item.id + '.json'));
  assert.equal(metadata.pinned, true);
  for (const forbidden of [foreign, stale]) {
    assert.throws(() => forbidden.releaseUpload(item.id, { expiresAt: 0 }), /Artifact belongs to another target/);
    assert.throws(() => forbidden.get(item.id), /Artifact belongs to another target/);
    assert.throws(() => forbidden.subject(item.id), /Artifact belongs to another target/);
    assert.throws(() => forbidden.verified(item.id), /Artifact belongs to another target/);
    assert.deepEqual(store.get(item.id), metadata);
    assert.deepEqual(await readFile(join(root, item.id + '.json')), manifest);
    assert.deepEqual(await readFile(join(root, item.id + '.part')), bytes);
  }
  assert.throws(() => store.releaseUpload(item.id, { expiresAt: 0 }, () => { throw Error('authorization denied'); }), /authorization denied/);
  assert.deepEqual(store.get(item.id), metadata);
  const released = owner.releaseUpload(item.id, { expiresAt: 0 });
  assert.deepEqual(released, { state: 'released' }); assert.ok(Object.isFrozen(released));
  assert.equal(store.get(item.id).pinned, false); assert.equal(store.get(item.id).expiresAt, 0);
  await store.reap(); assert.equal(store.size, 0); assert.equal(store.reserved, 0);
  for (const release of [() => owner.releaseUpload(item.id), () => owner.releaseUpload(item.id), () => store.releaseUpload(item.id)]) {
    const result = release(); assert.deepEqual(result, { state: 'unavailable' }); assert.ok(Object.isFrozen(result));
  }
  for (const method of ['get', 'subject', 'verified']) assert.throws(() => owner[method](item.id), /Unknown transfer/);
  for (const bad of ['', 'not-a-transfer-id', 'g'.repeat(48)]) assert.throws(() => owner.releaseUpload(bad), /Invalid transfer ID/);
  assert.equal(store.size, 0); assert.equal(store.reserved, 0);
  await assert.rejects(readFile(join(root, item.id + '.part')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, item.id + '.json')), { code: 'ENOENT' });
});
