import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApplication } from '../app.mjs';
import { authorizeAdminRequest } from '../src/adapters/security/admin-policy.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const uuidFixture = '12345678-1234-4234-8234-123456789abc';
const ownerOrigin = 'https://owner.example.test';
const headers = { authorization: 'Bearer fixture-owner', origin: ownerOrigin };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'opaque-application-'));
  const app = await createApplication({ transferRoot: root, audit() {}, uiHtml: '<html></html>',
    registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'fixture', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
    classify: () => ({ class: 'safe' }), executeCommand: async () => assert.fail('No command execution'),
    env: { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-owner', BRIDGE_ADMIN_ORIGIN: ownerOrigin,
      BRIDGE_UI_TICKET_KEY: 'b'.repeat(64), BRIDGE_TRANSFER_MAX_BYTES: '524288', BRIDGE_TRANSFER_BUDGET_BYTES: '1572864' } });
  const effects = [];
  app.transfers.upload = async operation => {
    const fd = await app.store.verified(operation.artifactId);
    try {
      const chunks = []; for await (const bytes of fd.createReadStream({ start: 0, autoClose: false })) chunks.push(bytes);
      const bytes = Buffer.concat(chunks); effects.push({ operation, bytes });
      return { failed: false, texts: ['published'], data: { published: true, size: bytes.length, sha256: sha256(bytes) } };
    } finally { await fd.close(); }
  };
  await listen(app.adminHttp); await listen(app.mcpHttp);
  const client = new Client({ name: 'opaque-application-contract', version: '2.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.mcpHttp.address().port}/mcp`),
    { requestInit: { headers: { Authorization: 'Bearer fixture-mcp' } } }));
  t.after(async () => { await client.close(); await app.close(); await rm(root, { recursive: true, force: true }); });
  const api = (path, options = {}) => fetch(`http://127.0.0.1:${app.adminHttp.address().port}${path}`, { ...options, headers: { ...headers, ...options.headers } });
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result)); assert.equal(result.structuredContent.ok, true);
    return result.structuredContent.data;
  };
  return { app, effects, api, call };
}

test('composed owner HTTP staging and MCP copy/move share durable admission and exact bytes', { timeout: 30000 }, async t => {
  const f = await fixture(t), bytes = Buffer.alloc(394240, 0xa7), digest = sha256(bytes);
  const created = await f.api('/api/artifacts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operationKey: 'composed-upload-key-200', fileName: 'sample.bin', size: bytes.length, sha256: digest }) });
  assert.equal(created.status, 200); const source = await created.json(); assert.deepEqual(Object.keys(source), ['uuid']);
  for (let offset = 0, sequence = 0; offset < bytes.length; offset += 262144, sequence++) {
    const chunk = bytes.subarray(offset, Math.min(offset + 262144, bytes.length));
    const response = await f.api(`/api/artifacts/${source.uuid}/chunks/${sequence}`, { method: 'PUT', body: chunk,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': sha256(chunk) } });
    assert.equal(response.status, 200); const ack = await response.json();
    assert.equal(ack.sequence, sequence + 1); assert.equal(ack.received, offset + chunk.length);
  }
  const completed = await f.api(`/api/artifacts/${source.uuid}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(completed.status, 200); assert.deepEqual(await completed.json(), source);
  assert.equal((await (await f.api(`/api/artifacts/${source.uuid}`)).json()).state, 'ready');
  const revision = f.app.targets.select('default').revision;
  for (const action of ['copy', 'move']) {
    const input = { action, uuid: source.uuid, operationKey: 'composed-placement-' + action, target: 'default', expectedTargetRevision: revision, remotePath: '/tmp/' + action + '.bin' };
    const pending = await f.call('files', input);
    assert.equal(pending.request.state, 'pending'); assert.equal(f.effects.length, action === 'copy' ? 0 : 1);
    assert.doesNotMatch(JSON.stringify(pending), /artifactId|sourceUUID|portal-owner-v1|\.part/);
    const accepted = await f.api(`/api/${pending.request.id}/approve`, { method: 'POST' });
    assert.ok([200, 202].includes(accepted.status)); await accepted.arrayBuffer();
    const terminal = await f.call('observe', { id: pending.request.id, waitMs: 10000 });
    assert.equal(terminal.state, 'completed'); assert.equal(terminal.failed, false);
    const settled = await f.call('files', { action: 'stat', uuid: source.uuid });
    assert.equal(settled.file.state, action === 'copy' ? 'ready' : 'moved');
    const recovered = await f.call('files', input); assert.equal(recovered.request.id, pending.request.id);
    assert.equal(f.effects.length, action === 'copy' ? 1 : 2);
    assert.deepEqual(f.effects.at(-1).bytes, bytes);
  }
});

test('artifact HTTP policy requires verified owner and exact origin for every supported method', async () => {
  const routes = [['POST', '/api/artifacts'], ['GET', `/api/artifacts/${uuidFixture}`], ['POST', `/api/artifacts/${uuidFixture}/complete`], ['PUT', `/api/artifacts/${uuidFixture}/chunks/0`]];
  const verified = { subject: 'fixture-access-owner' };
  for (const mode of ['token', 'access', 'oidc']) for (const [method, url] of routes) {
    const config = { adminToken: 'fixture-owner', adminOrigin: ownerOrigin,
      adminAccess: { mode, identity: async () => verified }, browserSessions: { authenticated: () => true } };
    const request = { method, url, headers };
    const allowed = await authorizeAdminRequest(request, config);
    assert.equal(allowed.allowed, true); assert.equal(allowed.principal.subject, mode === 'token' ? 'portal-token-owner' : verified.subject);
    assert.equal((await authorizeAdminRequest({ ...request, headers: { ...headers, origin: 'https://other.example.test' } }, config)).allowed, false);
    assert.equal((await authorizeAdminRequest({ ...request, headers: { ...headers, origin: undefined } }, config)).allowed, false);
    const unauthorized = mode === 'token' ? { ...request, headers: { ...headers, authorization: undefined, Authorization: undefined } } : request;
    const refused = await authorizeAdminRequest(unauthorized, mode === 'token' ? config : { ...config, adminAccess: { mode, identity: async () => null } });
    assert.equal(refused.allowed, false); assert.equal(refused.status, 401);
  }
});
