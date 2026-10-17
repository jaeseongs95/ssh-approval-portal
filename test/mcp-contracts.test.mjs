import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createProtocolAdapters } from '../src/adapters/http/protocol.mjs';
import { Tickets } from '../src/adapters/security/tickets.mjs';
import { authorizeAdminRequest } from '../src/adapters/security/admin-policy.mjs';

const identifier = 'a'.repeat(48);
const settings = { mcpToken: 'contract-mcp', adminToken: 'contract-admin', adminOrigin: 'https://example.test', uiEnabled: true, prefix: 'ssh-approval-bridge_', maxBytes: 64 };
const job = () => ({ id: identifier, kind: 'command', operation: { kind: 'command', command: 'sudo id' }, command: 'sudo id',
  profile: 'aws-local', commandClass: 'privileged', target: 'fixture@localhost:22', state: 'pending', createdAt: 10, expiresAt: Date.now() + 600_000 });

async function fixture(overrides = {}) {
  const calls = { append: [], imports: [] }, pending = job();
  const queue = { maintenance: false, subject: () => 'frozen-job', get: id => id === identifier ? pending : null,
    submit: () => pending, start: () => ({ ...pending, state: 'running' }), deny: () => ({ ...pending, state: 'denied' }),
    approve: async () => ({ ...pending, state: 'completed', result: { failed: false, texts: ['finished'], data: { preserved: true } } }),
    list: () => [pending], listAll: () => [pending] };
  const commands = { read: async () => ({ failed: false, texts: ['fixture-output'] }), run: async () => ({ type: 'job', job: pending }) };
  const files = { requestUpload: async args => { calls.imports.push(args); return { type: 'source-unavailable', sourceHost: 'files.example.test' }; },
    requestDownload: () => pending, beginUpload: async () => ({ id: identifier, expiresAt: Date.now() + 600_000 }),
    appendUpload: async args => { calls.append.push(args); return { sequence: args.sequence + 1, received: args.bytes.length }; }, finishUpload: async () => pending };
  const lifecycle = { snapshot: () => ({ busy: false, pending: 1, maintenance: false }), reserve() {}, release() {} };
  const source = { inspect: () => ({ allowed: false, sourceHost: 'files.example.test' }), open: async () => assert.fail('unconfigured source must not open') };
  const adapters = createProtocolAdapters({ queue, commands, files, lifecycle, store: { subject: () => 'frozen-upload' }, settings,
    signer: new Tickets('b'.repeat(64)), adminAccess: { mode: 'token' }, authorizeAdminRequest,
    uiHtml: '<html>fixture</html>', webHtml: '<html data-auth-mode="token"></html>', webJs: 'fixture', bindFileSource: () => source, ...overrides });
  await new Promise(resolve => adapters.mcpHttp.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => adapters.adminHttp.listen(0, '127.0.0.1', resolve));
  const mcpBase = `http://127.0.0.1:${adapters.mcpHttp.address().port}`, adminBase = `http://127.0.0.1:${adapters.adminHttp.address().port}`;
  const client = new Client({ name: 'contract-client', version: '1' });
  // SDK schema compilation shares this fixture's event loop and can outlast HTTP idle sockets.
  // Use fresh connections for these RPC contract checks; production HTTP settings stay unchanged.
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpBase + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer contract-mcp', Connection: 'close' } } }));
  return { client, calls, commands, pending, source, adapters, mcpBase, adminBase,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    async close() { await client.close(); await Promise.all([adapters.mcpHttp, adapters.adminHttp].map(server => new Promise(resolve => server.close(resolve)))); } };
}

test('MCP contract families preserve tool names, JSON text, private capabilities and legacy error variants', async () => {
  const f = await fixture();
  try {
    const { tools } = await f.client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['list-targets', 'read-command', 'run-command', 'request-safe-command', 'get-request-status', 'assess-request-risk', 'request-upload', 'show-ui-probe', 'show-approval', 'show-file-transfer', 'request-download', 'ui-decide-request', 'ui-upload-begin', 'ui-upload-chunk', 'ui-upload-finish', 'ui-download-link', 'read-command-output', 'ui-read-command-output']);
    for (const tool of tools) assert.equal(tool.outputSchema.type, 'object', tool.name);
    const upload = tools.find(tool => tool.name === 'request-upload');
    assert.deepEqual(upload._meta['openai/fileParams'], ['file']); assert.match(upload.description, /only that host contract/);
    assert.deepEqual(tools.find(tool => tool.name === 'ui-upload-chunk')._meta.ui.visibility, ['app']);
    assert.ok(tools.find(tool => tool.name === 'show-approval').outputSchema.required.includes('id'));
    const immediate = await f.call('read-command', { command: 'id' });
    assert.equal(JSON.stringify(immediate).includes('fixture-output'), false); assert.deepEqual(immediate.structuredContent, { state: 'completed', kind: 'command', output: { state: 'unavailable' } });
    const result = await f.call('run-command', { command: 'sudo id' });
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent); assert.equal(result.structuredContent.id, identifier);
    const card = await f.call('show-approval', { id: identifier });
    assert.ok(card._meta.sshApproval.approvalTicket); assert.equal(JSON.stringify([card.content, card.structuredContent]).includes('Ticket'), false);
    const missing = await f.call('get-request-status', { id: 'c'.repeat(48) });
    assert.equal(missing.isError, undefined); assert.deepEqual(missing.structuredContent, { error: 'Unknown request; server may have restarted' });
    const unavailable = await f.call('request-upload', { file: { download_url: 'https://files.example.test/private?signature=SECRET', file_id: 'PRIVATE-ID' }, remotePath: '/tmp/input.bin' });
    assert.equal(unavailable.isError, true); assert.equal(unavailable.structuredContent.error, 'upload-source-not-configured');
    assert.equal(JSON.stringify(unavailable).includes('SECRET'), false); assert.equal(f.calls.imports[0].source, f.source);
    assert.equal('download_url' in f.calls.imports[0], false); assert.equal('file_id' in f.calls.imports[0], false);
    const invalid = await f.call('request-upload', { file: { download_url: '', file_uuid: 'opaque' }, remotePath: '/tmp/input.bin' });
    assert.equal(invalid.isError, true); assert.match(invalid.content[0].text, /-32602/); assert.equal(f.calls.imports.length, 1);
    f.commands.run = async () => ({ type: 'job', job: {} });
    const malformed = await f.call('run-command', { command: 'id' });
    assert.equal(malformed.isError, true); assert.match(malformed.content[0].text, /Request refused or failed/);
  } finally { await f.close(); }
});

test('app-only chunks decode canonical base64 before the application sees bytes', async () => {
  const f = await fixture();
  try {
    const transfer = { direction: 'upload', remotePath: '/tmp/input.bin', elevate: false, overwrite: false };
    const seed = await f.call('show-file-transfer', transfer);
    const begin = await f.call('ui-upload-begin', { transfer, ticket: seed._meta.sshApproval.bootstrapTicket, fileName: 'input.bin', size: 3, sha256: 'd'.repeat(64) });
    const ticket = begin._meta.sshApproval.uploadTicket;
    for (const data of ['', 'AB==', 'AA=', 'AA==\n', '_w==', 'AAAA=']) {
      const result = await f.call('ui-upload-chunk', { id: identifier, ticket, sequence: 0, data });
      assert.equal(result.isError, true, JSON.stringify(data));
    }
    assert.equal(f.calls.append.length, 0);
    const result = await f.call('ui-upload-chunk', { id: identifier, ticket, sequence: 0, data: 'AP8B' });
    assert.deepEqual(result.structuredContent, { sequence: 1, received: 3 }); assert.deepEqual(f.calls.append[0].bytes, Buffer.from([0, 255, 1]));
  } finally { await f.close(); }
});

test('health callback exceptions become controlled 503 and leave the HTTP server usable', async () => {
  let fails = true;
  const f = await fixture({ lifecycle: { snapshot() { if (fails) throw Error('PRIVATE-AUDIT-FAILURE'); return { busy: false, pending: 0, maintenance: false }; } } });
  try {
    const unavailable = await fetch(f.mcpBase + '/health'); assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: 'Health check unavailable' });
    fails = false;
    const healthy = await fetch(f.mcpBase + '/health'); assert.equal(healthy.status, 200); assert.equal((await healthy.json()).healthy, true);
    assert.equal((await f.call('show-ui-probe')).structuredContent.probe, 'SSH_UI_PUBLIC_PROBE');
  } finally { await f.close(); }
});

test('web presents neutral outcomes as legacy JSON and approval waits for completion', async () => {
  const f = await fixture();
  try {
    const reply = await fetch(f.adminBase + `/api/${identifier}/approve`, { method: 'POST', headers: { Authorization: 'Bearer contract-admin', Origin: 'https://example.test' } });
    assert.equal(reply.status, 200);
    const value = await reply.json(); assert.equal(value.state, 'completed');
    assert.deepEqual(value.result, { content: [], structuredContent: { output: { state: 'unavailable' } } });
    assert.equal('texts' in value.result, false); assert.equal('data' in value.result, false);
    const badOrigin = await fetch(f.adminBase + `/api/${identifier}/approve`, { method: 'POST', headers: { Authorization: 'Bearer contract-admin', Origin: 'https://evil.test' } });
    assert.equal(badOrigin.status, 403);
  } finally { await f.close(); }
});

test('download-ready publishes only filename while the renewed URL stays in private metadata', async () => {
  const artifactId = 'e'.repeat(48);
  const f = await fixture({ store: { subject: () => 'unused', get: id => {
    assert.equal(id, artifactId);
    return { id, fileName: 'download.bin', sha256: 'f'.repeat(64), expiresAt: Date.now() + 3_600_000 };
  } } });
  try {
    Object.assign(f.pending, { kind: 'download', operation: { kind: 'download', remotePath: '/tmp/download.bin', elevate: false }, command: undefined, state: 'completed',
      result: { failed: false, texts: ['ready'], data: { artifactId, fileName: 'download.bin', size: 3, sha256: 'f'.repeat(64) } } });
    const card = await f.call('show-approval', { id: identifier });
    assert.deepEqual(card.structuredContent.result.content, [{ type: 'text', text: 'ready' }]);
    const result = await f.call('ui-download-link', { id: identifier, ticket: card._meta.sshApproval.viewTicket });
    assert.deepEqual(result.structuredContent, { ready: true, fileName: 'download.bin' });
    assert.match(result._meta.sshApproval.downloadUrl, /^https:\/\/example\.test\/downloads\//);
    assert.equal(JSON.stringify([result.content, result.structuredContent]).includes('ticket='), false);
  } finally { await f.close(); }
});

test('MCP preserves detailed optional context and rejects oversized descriptions before dispatch', async () => {
  const seen = [], f = await fixture();
  f.commands.run = async (...args) => { seen.push(args); return { type: 'job', job: f.pending }; };
  try {
    const { tools } = await f.client.listTools();
    const tool = tools.find(item => item.name === 'run-command');
    assert.equal(tool.inputSchema.properties.context.maxLength, 8192);
    assert.equal(tool.inputSchema.required.includes('context'), false);
    assert.match(tool.description, /evidence already checked/); assert.match(tool.description, /one hour/);
    const context = 'a'.repeat(8192);
    const result = await f.call('run-command', { command: 'sudo id', context });
    assert.equal(result.isError, undefined); assert.deepEqual(seen[0], ['sudo id', undefined, undefined, context]);
    assert.equal((await f.call('run-command', { command: 'sudo id', context: context + 'a' })).isError, true);
    assert.equal(seen.length, 1);
  } finally { await f.close(); }
});

test('command-only hosts decode a strict context envelope before dispatch; invalid or conflicting fields never dispatch', async () => {
  const seen = [], f = await fixture();
  f.commands.run = async (...args) => { seen.push(args); return { type: 'job', job: f.pending }; };
  const input = { command: 'sudo id', context: 'Test instance; check identity only; no mutation; no rollback needed', requestKey: 'synthetic-context-request-1' };
  const envelope = value => 'ssh-request-v1:' + JSON.stringify(value);
  try {
    assert.equal((await f.call('run-command', { command: envelope(input) })).isError, undefined);
    assert.deepEqual(seen, [[input.command, undefined, input.requestKey, input.context]]);
    for (const args of [
      { command: envelope(input), context: 'conflicting context' },
      { command: envelope(input), requestKey: 'conflicting-request-key' },
      { command: envelope({ ...input, target: 'other-server' }) },
      { command: envelope({ ...input, userApproval: true }) },
      { command: envelope({ ...input, context: '   ' }) },
      { command: envelope({ ...input, context: 'api_key=synthetic-value' }) },
      { command: envelope({ ...input, requestKey: 12 }) },
      { command: envelope({ ...input, command: envelope(input) }) },
      { command: 'ssh-request-v1:invalid' },
    ]) assert.equal((await f.call('run-command', args)).isError, true);
    assert.equal(seen.length, 1);
  } finally { await f.close(); }
});
