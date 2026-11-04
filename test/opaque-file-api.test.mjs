import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Artifacts, CHUNK_BYTES } from '../src/adapters/storage/artifacts.mjs';
import { createOpaqueFileService } from '../src/application/opaque-files.mjs';
import { routeOpaqueFileApi } from '../src/adapters/http/opaque-file-api.mjs';
import { hash } from '../src/domain/validation.mjs';

const authorization = { allowed: true, principal: { subject: 'verified-admin-subject' } };
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'opaque-api-'));
  t.after(() => rm(root, { recursive: true }));
  const store = new Artifacts(root, options); await store.init();
  const service = createOpaqueFileService({ store, ownerId: 'verified-owner-realm', queue: { maintenance: false },
    journal: { find: () => null, get: () => null }, submissions: { run() { throw Error('Not a file admission test'); } } });
  return { store, service };
}
async function request(service, path, { method = 'POST', body = {}, parts, headers = {}, permission = authorization, reauthorize = async () => authorization } = {}) {
  const req = Readable.from(parts ?? [Buffer.from(JSON.stringify(body))]);
  req.method = method; req.headers = { 'content-type': 'application/json', ...headers };
  let response;
  const routed = await routeOpaqueFileApi(req, {}, new URL(path, 'https://owner.invalid'), { opaqueFiles: service,
    json: (_res, status, value) => { response = { status, value }; }, authorize: reauthorize, authorization: permission });
  return { routed, ...response };
}
const metadata = bytes => ({ operationKey: 'http-opaque-upload-001', fileName: '한글😀.bin', size: bytes.length, sha256: hash(bytes) });

test('HTTP create/raw chunks/complete expose only UUID and explicit public metadata', async t => {
  const { service } = await fixture(t), bytes = Buffer.from([0, 0xff, 0xc3, 0x28, 0x0d, 0x0a]);
  const created = await request(service, '/api/artifacts', { body: metadata(bytes) });
  assert.equal(created.status, 200); assert.deepEqual(Object.keys(created.value), ['uuid']);
  const { uuid } = created.value, path = '/api/artifacts/' + uuid;
  assert.deepEqual((await request(service, '/api/artifacts', { body: metadata(bytes) })).value, { uuid });
  const chunk = () => request(service, path + '/chunks/0', { method: 'PUT', parts: [bytes.subarray(0, 3), bytes.subarray(3)],
    headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': hash(bytes) } });
  assert.deepEqual((await chunk()).value, { uuid, sequence: 1, received: bytes.length });
  assert.deepEqual((await chunk()).value, { uuid, sequence: 1, received: bytes.length });
  assert.deepEqual((await request(service, path + '/complete')).value, { uuid });
  assert.deepEqual((await request(service, path + '/complete')).value, { uuid });
  assert.deepEqual((await chunk()).value, { uuid, sequence: 1, received: bytes.length });
  const status = (await request(service, path, { method: 'GET' })).value;
  assert.equal(status.state, 'ready'); assert.equal(status.received, bytes.length); assert.equal(status.sequence, 1);
  assert.deepEqual(Object.keys(status).sort(), ['uuid', 'state', 'fileName', 'size', 'sha256', 'expiresAt', 'received', 'sequence'].sort());
  const changed = Buffer.alloc(bytes.length, 1);
  assert.deepEqual(await request(service, path + '/chunks/0', { method: 'PUT', parts: [changed],
    headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': hash(changed) } }),
  { routed: true, status: 409, value: { error: 'ARTIFACT_CHUNK_CONFLICT' } });
});

test('route requires verified principal and same authorization after body I/O', async t => {
  const { service, store } = await fixture(t), body = metadata(Buffer.from('x'));
  for (const permission of [undefined, { allowed: true }, { allowed: false, status: 401 }, { allowed: true, principal: { subject: '' } }]) {
    // Explicit null avoids the request helper's default authorization.
    const response = await request(service, '/api/artifacts', { body, permission: permission ?? null });
    assert.ok([401, 403].includes(response.status)); assert.equal(store.size, 0);
  }
  for (const changed of [{ allowed: false, status: 401 }, { allowed: true }, { allowed: true, principal: { subject: 'different-subject' } }]) {
    const result = await request(service, '/api/artifacts', { body, reauthorize: async () => changed });
    assert.ok([401, 403].includes(result.status)); assert.equal(store.size, 0);
  }
  assert.equal((await request(service, '/unrelated', { permission: null })).routed, false);
});

test('strict staging fields forbid destination, target, owner and extra completion inputs', async t => {
  const { service, store } = await fixture(t), body = metadata(Buffer.from('x'));
  for (const extra of [{ remotePath: '/tmp/forbidden' }, { target: 'alpha' }, { ownerId: 'client' }, { publicUUID: 'client' }, { overwrite: true }]) {
    assert.equal((await request(service, '/api/artifacts', { body: { ...body, ...extra } })).status, 400);
    assert.equal(store.size, 0);
  }
  const { uuid } = (await request(service, '/api/artifacts', { body })).value;
  assert.equal((await request(service, '/api/artifacts/' + uuid + '/complete', { body: { remotePath: '/tmp/no' } })).status, 400);
  assert.equal((await request(service, '/api/artifacts/' + uuid + '?path=bad', { method: 'GET' })).status, 400);
  assert.equal((await request(service, '/api/artifacts/not-a-uuid', { method: 'GET' })).status, 400);
});

test('binary request bounds, chunk digest and method/content admission protect unchanged progress', async t => {
  const { service } = await fixture(t), bytes = Buffer.from('x'), { uuid } = (await request(service, '/api/artifacts', { body: metadata(bytes) })).value;
  const path = '/api/artifacts/' + uuid;
  const raw = { method: 'PUT', parts: [bytes], headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': hash(bytes) } };
  assert.equal((await request(service, path + '/chunks/0', { ...raw, parts: [Buffer.alloc(CHUNK_BYTES), Buffer.from('x')] })).status, 413);
  assert.equal((await request(service, path + '/chunks/0', { ...raw, parts: [] })).status, 400);
  assert.equal((await request(service, path + '/chunks/0', { ...raw, headers: { ...raw.headers, 'content-encoding': 'gzip' } })).status, 415);
  assert.equal((await request(service, path + '/chunks/0', { ...raw, method: 'POST' })).status, 405);
  assert.equal((await request(service, path + '/chunks/01', raw)).status, 400);
  assert.equal((await request(service, path + '/chunks/9007199254740992', raw)).status, 400);
  const badHash = await request(service, path + '/chunks/0', { ...raw, headers: { ...raw.headers, 'x-chunk-sha256': hash('wrong') } });
  assert.deepEqual(badHash, { routed: true, status: 422, value: { error: 'CHUNK_HASH_MISMATCH' } });
  assert.equal((await service.stat({ uuid })).received, 0);
  assert.equal((await request(service, '/api/artifacts', { parts: [Buffer.from([0xff])] })).status, 400);
});

test('public API distinguishes quota, absent UUID, full-file hash and unavailable service safely', async t => {
  const absent = '/api/artifacts/11111111-1111-4111-8111-111111111111';
  await t.test('quota admission preserves accepted bytes and returns its exact cause', async child => {
    const { service, store } = await fixture(child, { maxBytes: 4, budget: 4 });
    assert.equal((await request(service, '/api/artifacts', { body: metadata(Buffer.from('test')) })).status, 200);
    const over = await request(service, '/api/artifacts', { body: { ...metadata(Buffer.from('x')), operationKey: 'quota-second-upload-01' } });
    assert.deepEqual(over, { routed: true, status: 507, value: { error: 'ARTIFACT_QUOTA' } });
    assert.equal(store.size, 1); assert.equal(store.reserved, 4);
  });
  await t.test('absent and another-owner UUID have the same non-disclosing code', async child => {
    const { service, store } = await fixture(child);
    const expected = { routed: true, status: 404, value: { error: 'ARTIFACT_NOT_FOUND' } };
    assert.deepEqual(await request(service, absent, { method: 'GET' }), expected);
    const foreign = await store.beginStaged({ ...metadata(Buffer.from('x')), ownerId: 'another-owner-realm' });
    assert.deepEqual(await request(service, '/api/artifacts/' + foreign.publicUUID, { method: 'GET' }), expected);
  });
  await t.test('full-file verification is a separate code from chunk SHA rejection', async child => {
    const { service } = await fixture(child), { uuid } = (await request(service, '/api/artifacts', { body: metadata(Buffer.from('test')) })).value;
    const path = '/api/artifacts/' + uuid, wrong = Buffer.from('diff');
    assert.equal((await request(service, path + '/chunks/0', { method: 'PUT', parts: [wrong],
      headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': hash(wrong) } })).status, 200);
    assert.deepEqual(await request(service, path + '/complete'), { routed: true, status: 422, value: { error: 'ARTIFACT_HASH_MISMATCH' } });
  });
  await t.test('missing service is explicit and still requires authorization first', async () => {
    assert.deepEqual(await request(undefined, absent, { method: 'GET' }), { routed: true, status: 503, value: { error: 'OPAQUE_FILES_UNAVAILABLE' } });
    assert.equal((await request(undefined, absent, { method: 'GET', permission: null })).status, 403);
  });
});

test('only allowlisted typed codes and exact legacy literals cross the public error boundary', async () => {
  const path = '/api/artifacts/11111111-1111-4111-8111-111111111111';
  for (const scenario of [
    { error: Object.assign(Error('private backing path /srv/private/data.part'), { code: 'ARTIFACT_QUOTA' }), status: 507, code: 'ARTIFACT_QUOTA' },
    { error: Error('Staged file unavailable'), status: 404, code: 'ARTIFACT_NOT_FOUND' },
    { error: Error('Staged file unavailable /srv/private/data.part'), status: 500, code: 'ARTIFACT_INTERNAL_ERROR' },
    { error: Object.assign(Error('ENOENT /srv/private/data.part'), { code: 'ENOENT', path: '/srv/private/data.part', provenance: { ownerId: 'private-owner' } }), status: 500, code: 'ARTIFACT_INTERNAL_ERROR' },
    { error: Object.assign(Error('private stack and credentials'), { code: 'ARBITRARY_PRIVATE_ERROR' }), status: 500, code: 'ARTIFACT_INTERNAL_ERROR' },
  ]) {
    const service = { stat: () => { throw scenario.error; } };
    assert.deepEqual(await request(service, path, { method: 'GET' }), { routed: true, status: scenario.status, value: { error: scenario.code } });
  }
});

test('HTTP identifiers and hash fields reject CR/LF suffixes rather than trimming them', async t => {
  const { service, store } = await fixture(t), bytes = Buffer.from('test'), body = metadata(bytes);
  for (const suffix of ['\r', '\n', '\r\n']) {
    assert.deepEqual(await request(service, '/api/artifacts', { body: { ...body, operationKey: body.operationKey + suffix } }),
      { routed: true, status: 400, value: { error: 'INVALID_OPERATION_KEY' } });
    assert.deepEqual(await request(service, '/api/artifacts', { body: { ...body, sha256: body.sha256 + suffix } }),
      { routed: true, status: 400, value: { error: 'INVALID_FILE_HASH' } });
    assert.equal(store.size, 0);
  }
  const { uuid } = (await request(service, '/api/artifacts', { body })).value;
  for (const suffix of ['\r', '\n', '\r\n']) {
    assert.equal((await request(service, '/api/artifacts/' + encodeURIComponent(uuid + suffix), { method: 'GET' })).status, 400);
    assert.equal((await request(service, '/api/artifacts/' + uuid + '/chunks/0', { method: 'PUT', parts: [bytes],
      headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': hash(bytes) + suffix } })).status, 400);
  }
  assert.equal((await service.stat({ uuid })).received, 0);
});
