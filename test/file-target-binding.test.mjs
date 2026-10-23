import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createApplication } from '../app.mjs';
import { hash } from '../src/domain/validation.mjs';
import { createCapabilities } from '../src/adapters/presentation/capabilities.mjs';

const bytes = Buffer.from([0, 255, 13, 10, 128]), otherRevision = 'f'.repeat(64);
async function fixture(t, explicit = false) {
  const root = await mkdtemp(join(tmpdir(), 'file-target-binding-')), calls = [], uploaded = [];
  const entries = ['alpha', 'beta', 'offline'].map(id => ({ id, displayName: id, readProfile: id + '-read', writeProfile: id + '-write', credentialRevision: 'v1', enabled: id !== 'offline' }));
  const profiles = new Map((explicit ? entries : [{ id: 'default', readProfile: 'aws-readonly', writeProfile: 'aws-local' }]).flatMap(e =>
    [e.readProfile, e.writeProfile].map(name => [name, { host: e.id + '.example.test', port: 22, user: 'fixture', readOnly: name === e.readProfile, trustedHostKey: 'SHA256:' + e.id }])));
  const app = await createApplication({ registry: { getProfile: name => profiles.get(name), closeAll: async () => {} },
    classify: () => ({ class: 'privileged' }), executeCommand: async () => ({ failed: false, texts: [] }), audit() {}, transferRoot: root,
    env: { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-admin', BRIDGE_ADMIN_ORIGIN: 'https://admin.example.test', BRIDGE_UI_TICKET_KEY: 'b'.repeat(64), BRIDGE_UI_ENABLED: 'true', BRIDGE_TRANSFER_MAX_BYTES: '64', BRIDGE_TRANSFER_BUDGET_BYTES: '256',
      ...(explicit ? { BRIDGE_TARGETS: JSON.stringify(entries), BRIDGE_DEFAULT_TARGET: 'alpha' } : {}) }, uiHtml: '<html>fixture</html>' });
  await Promise.all([app.adminHttp, app.mcpHttp].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const origin = 'http://127.0.0.1:' + app.adminHttp.address().port, target = explicit ? 'alpha' : 'default';
  const runtime = app.targets.select(target), revision = runtime.revision;
  runtime.transfers.transport = { async connect(profile) {
    runtime.verify(); calls.push({ action: 'connect', profile });
    return { async call(command, payload) {
      calls.push({ action: payload.action, payload });
      assert.equal(Object.hasOwn(payload, 'fileTargetId'), false);
      assert.equal(Object.hasOwn(payload, 'expectedTargetRevision'), false);
      return { exitCode: 0, stdout: JSON.stringify(payload.action === 'snapshot' ? { size: bytes.length, sha256: hash(bytes) } : { ok: true }) };
    }, async upload(stream) { for await (const part of stream) uploaded.push(Buffer.from(part)); }, async download(path, destination) { destination.end(bytes); } };
  } };
  const http = (path, method = 'GET', body, authorized = true) => fetch(origin + path, { method, headers: {
    ...(authorized ? { Authorization: 'Bearer fixture-admin' } : {}), Origin: 'https://admin.example.test', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  t.after(async () => { await app.close(); assert.ok(root.startsWith(join(tmpdir(), 'file-target-binding-'))); await rm(root, { recursive: true }); });
  return { app, target, revision, runtime, profiles, calls, uploaded, http, origin,
    binding: { target, expectedTargetRevision: revision },
    meta: data => ({ fileName: 'bound.bin', remotePath: '/tmp/bound.bin', size: data.length, sha256: hash(data), elevate: false, overwrite: false }) };
}
async function uploadJob(f, data = bytes, bound = true) {
  const begin = await f.http('/api/files/uploads', 'POST', { ...f.meta(data), ...(bound ? f.binding : { target: f.target }) });
  assert.equal(begin.status, 200); const { transferId } = await begin.json();
  if (data.length) assert.equal((await f.http('/api/files/uploads/' + transferId + '/chunks', 'POST', { sequence: 0, data: data.toString('base64') })).status, 200);
  const finish = await f.http('/api/files/uploads/' + transferId + '/finish', 'POST', {});
  assert.equal(finish.status, 200); return { transferId, job: await finish.json() };
}

test('owner target metadata exposes the exact opaque revision in legacy and explicit modes', async t => {
  for (const explicit of [false, true]) {
    const f = await fixture(t, explicit), response = await f.http('/api/targets');
    const item = (await response.json()).targets.find(x => x.id === f.target);
    assert.equal(item.revision, f.revision); assert.match(item.revision, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(item, 'readProfile'), false); assert.equal(Object.hasOwn(item, 'trustedHostKey'), false);
  }
});

test('stale malformed missing-target and disabled bindings create no artifact job or SSH effect', async t => {
  for (const explicit of [false, true]) {
    const f = await fixture(t, explicit);
    const invalid = [{ expectedTargetRevision: f.revision }, { ...f.binding, expectedTargetRevision: otherRevision },
      ...[null, 0, '', 'A'.repeat(64), ['a'.repeat(64)]].map(expectedTargetRevision => ({ target: f.target, expectedTargetRevision })),
      { target: 'missing', expectedTargetRevision: f.revision }, ...(explicit ? [{ target: 'offline', expectedTargetRevision: f.app.targets.list().targets.find(x => x.id === 'offline')?.revision }] : [])];
    for (const binding of invalid) {
      assert.equal((await f.http('/api/files/uploads', 'POST', { ...f.meta(bytes), ...binding })).status, 409);
      assert.equal((await f.http('/api/files/downloads', 'POST', { remotePath: '/tmp/bound.bin', ...binding })).status, 409);
      assert.equal(f.app.store.size, 0); assert.equal(f.app.queue.listAll().length, 0); assert.equal(f.calls.length, 0);
    }
  }
});

test('bound binary and empty uploads retain server identity inside immutable approval operations', async t => {
  for (const explicit of [false, true]) for (const data of [bytes, Buffer.alloc(0)]) {
    const f = await fixture(t, explicit), { transferId, job } = await uploadJob(f, data);
    const item = f.app.store.get(transferId);
    assert.equal(item.targetId, f.target); assert.equal(item.targetRevision, f.revision); assert.equal(item.fileTargetBound, true);
    assert.equal(job.operation.fileTargetId, f.target); assert.equal(job.operation.fileTargetRevision, f.revision);
    assert.equal(Object.hasOwn(job.operation, 'expectedTargetRevision'), false); assert.equal(job.state, 'pending');
    assert.equal(Object.isFrozen(f.runtime.queue.jobs.get(job.id).operation), true);
    const subject = op => hash(JSON.stringify({ ...f.runtime.queue.identity, id: job.id, operation: op, profile: job.profile, target: job.target, expiresAt: job.expiresAt }));
    assert.equal(f.app.queue.subject(job.id), subject(job.operation));
    assert.notEqual(subject(job.operation), subject({ ...job.operation, fileTargetRevision: otherRevision }));
    assert.equal((await f.http('/api/' + job.id + '/approve', 'POST', {})).status, 200);
    assert.deepEqual(Buffer.concat(f.uploaded), data); assert.equal(f.app.queue.get(job.id).state, 'completed');
  }
});

test('bound downloads preserve artifact identity and require the same ticket before delivering exact bytes', async t => {
  for (const explicit of [false, true]) {
    const f = await fixture(t, explicit), response = await f.http('/api/files/downloads', 'POST', { remotePath: '/tmp/bound.bin', ...f.binding });
    assert.equal(response.status, 200); const pending = await response.json();
    assert.equal(pending.operation.fileTargetId, f.target); assert.equal(pending.operation.fileTargetRevision, f.revision);
    await f.http('/api/' + pending.id + '/approve', 'POST', {});
    const job = f.app.queue.get(pending.id), item = f.app.store.get(job.result.data.artifactId);
    assert.equal(job.state, 'completed'); assert.equal(item.targetId, f.target); assert.equal(item.targetRevision, f.revision); assert.equal(item.fileTargetBound, true);
    const link = new URL((await (await f.http('/api/' + job.id + '/download', 'POST', {})).json()).downloadUrl), path = link.pathname + link.search;
    assert.equal((await f.http(path, 'HEAD')).status, 200);
    const delivery = await f.http(path); assert.equal(delivery.status, 200); assert.deepEqual(Buffer.from(await delivery.arrayBuffer()), bytes);
    assert.equal((await f.http(path)).status, 409);
  }
});

test('a bound upload operation cannot substitute another revision or omit its declared binding before SSH', async t => {
  for (const explicit of [false, true]) {
    const f = await fixture(t, explicit), { job } = await uploadJob(f);
    await assert.rejects(f.runtime.transfers.upload({ ...job.operation, fileTargetRevision: otherRevision }));
    const { fileTargetId, fileTargetRevision, ...unbound } = job.operation;
    await assert.rejects(f.runtime.transfers.upload(unbound)); assert.equal(f.calls.length, 0);
  }
});

test('changed registry refuses new bound admission and existing bound append finish and ticket claims', async t => {
  for (const explicit of [false, true]) {
    const f = await fixture(t, explicit);
    const beginResponse = await f.http('/api/files/uploads', 'POST', { ...f.meta(bytes), ...f.binding });
    assert.equal(beginResponse.status, 200); const begin = await beginResponse.json();
    const downloadResponse = await f.http('/api/files/downloads', 'POST', { remotePath: '/tmp/bound.bin', ...f.binding });
    assert.equal(downloadResponse.status, 200); const download = await downloadResponse.json();
    await f.http('/api/' + download.id + '/approve', 'POST', {});
    const link = new URL((await (await f.http('/api/' + download.id + '/download', 'POST', {})).json()).downloadUrl);
    const size = f.app.store.size, jobs = f.app.queue.listAll().length, calls = f.calls.length;
    f.profiles.get(f.runtime.writeProfile).host = 'changed.example.test';
    assert.equal((await f.http('/api/files/uploads', 'POST', { ...f.meta(bytes), ...f.binding })).status, 409);
    assert.equal((await f.http('/api/files/uploads/' + begin.transferId + '/chunks', 'POST', { sequence: 0, data: bytes.toString('base64') })).status, 409);
    assert.equal((await f.http('/api/files/uploads/' + begin.transferId + '/finish', 'POST', {})).status, 409);
    assert.equal((await f.http(link.pathname + link.search)).status, 409);
    assert.equal(f.app.store.size, size); assert.equal(f.app.queue.listAll().length, jobs); assert.equal(f.calls.length, calls);
  }
});

test('owner file fields reject identity injection and unauthenticated requests before allocation', async t => {
  const f = await fixture(t);
  for (const extra of [{ targetId: f.target }, { targetRevision: f.revision }, { fileTargetId: f.target }, { fileTargetRevision: f.revision }, { fileTargetBound: true }]) {
    assert.equal((await f.http('/api/files/uploads', 'POST', { ...f.meta(bytes), ...f.binding, ...extra })).status, 409);
  }
  assert.equal((await f.http('/api/files/uploads', 'POST', { ...f.meta(bytes), ...f.binding }, false)).status, 401);
  assert.equal(f.app.store.size, 0); assert.equal(f.app.queue.listAll().length, 0);
});

test('old unbound transfers retain their original operation and legacy metadata contracts', async t => {
  for (const explicit of [false, true]) {
    const f = await fixture(t, explicit), { transferId, job } = await uploadJob(f, bytes, false), item = f.app.store.get(transferId);
    assert.equal(Object.hasOwn(job.operation, 'fileTargetId'), false); assert.equal(Object.hasOwn(job.operation, 'fileTargetRevision'), false);
    assert.equal(Object.hasOwn(item, 'fileTargetBound'), false);
    if (!explicit) assert.equal(Object.hasOwn(item, 'targetId'), false);
    await f.http('/api/' + job.id + '/approve', 'POST', {}); assert.deepEqual(Buffer.concat(f.uploaded), bytes);
  }
});

test('bound download tickets reject mismatched job identity and old IDs after a fresh application epoch', async t => {
  const f = await fixture(t), response = await f.http('/api/files/downloads', 'POST', { remotePath: '/tmp/bound.bin', ...f.binding });
  assert.equal(response.status, 200); const pending = await response.json();
  await f.http('/api/' + pending.id + '/approve', 'POST', {}); const job = f.app.queue.get(pending.id);
  const caps = createCapabilities({ queue: f.app.queue, store: f.app.store, targets: f.app.targets, signer: { issue() { assert.fail('Do not issue a ticket for mismatched identity'); } }, settings: { adminOrigin: 'https://admin.example.test' } });
  assert.throws(() => caps.downloadLink({ ...job, operation: { ...job.operation, fileTargetRevision: otherRevision } }));
  const link = new URL((await (await f.http('/api/' + job.id + '/download', 'POST', {})).json()).downloadUrl);
  const fresh = await fixture(t);
  assert.equal((await fresh.http('/api/files/uploads/' + 'a'.repeat(48))).status, 409);
  assert.equal((await fresh.http(link.pathname + link.search)).status, 409);
  assert.equal(fresh.app.store.size, 0); assert.equal(fresh.app.queue.listAll().length, 0); assert.equal(fresh.calls.length, 0);
});

test('the internal binding builder refuses an empty or partial binding instead of downgrading it', async () => {
  const { fileTargetFields } = await import('../src/domain/file-target-binding.mjs');
  assert.deepEqual(fileTargetFields(undefined), {});
  for (const binding of [{}, { targetId: 'default' }, { targetRevision: 'a'.repeat(64) }]) assert.throws(() => fileTargetFields(binding));
});

test('bound source imports preserve identity and reject a configuration change before queue submission', async t => {
  for (const explicit of [false, true]) {
    const valid = await fixture(t, explicit);
    const source = { inspect: () => ({ allowed: true, sourceHost: 'synthetic.example.test' }), open: async () => ({ stream: Readable.from([bytes]), expectedSize: bytes.length, close() {} }) };
    const result = await valid.app.targets.files.requestUpload({ ...valid.binding, source, fileName: 'source.bin', remotePath: '/tmp/source.bin' });
    assert.equal(result.job.operation.fileTargetId, valid.target); assert.equal(result.job.operation.fileTargetRevision, valid.revision);
    await valid.http('/api/' + result.job.id + '/approve', 'POST', {}); assert.deepEqual(Buffer.concat(valid.uploaded), bytes);

    const f = await fixture(t, explicit); let started, release;
    const opened = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const delayed = { inspect: () => ({ allowed: true, sourceHost: 'synthetic.example.test' }), async open() {
      started(); await gate; return { stream: Readable.from([bytes]), expectedSize: bytes.length, close() {} };
    } };
    const pending = f.app.targets.files.requestUpload({ ...f.binding, source: delayed, fileName: 'source.bin', remotePath: '/tmp/source.bin' });
    await opened; f.profiles.get(f.runtime.writeProfile).host = 'changed-during-import.example.test'; release();
    await assert.rejects(pending);
    assert.equal(f.app.queue.listAll().length, 0); assert.equal(f.app.store.size, 0); assert.equal(f.app.store.reserved, 0); assert.equal(f.calls.length, 0);
  }
});

test('bound finish rechecks the target after asynchronous file verification and before creating its job', async t => {
  for (const explicit of [false, true]) {
    const f = await fixture(t, explicit), beginResponse = await f.http('/api/files/uploads', 'POST', { ...f.meta(bytes), ...f.binding });
    assert.equal(beginResponse.status, 200); const { transferId } = await beginResponse.json();
    assert.equal((await f.http('/api/files/uploads/' + transferId + '/chunks', 'POST', { sequence: 0, data: bytes.toString('base64') })).status, 200);
    const finish = f.app.store.finish.bind(f.app.store);
    f.app.store.finish = async id => { const item = await finish(id); f.profiles.get(f.runtime.writeProfile).host = 'changed-during-finish.example.test'; return item; };
    assert.equal((await f.http('/api/files/uploads/' + transferId + '/finish', 'POST', {})).status, 409);
    assert.equal(f.app.queue.listAll().length, 0); assert.equal(f.app.store.size, 0); assert.equal(f.app.store.reserved, 0); assert.equal(f.calls.length, 0);
  }
});
