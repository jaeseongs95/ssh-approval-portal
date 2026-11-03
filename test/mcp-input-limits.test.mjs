import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createProtocolAdapters } from '../src/adapters/http/protocol.mjs';
import { Tickets } from '../src/adapters/security/tickets.mjs';
import { CHUNK_BYTES } from '../src/contracts/ports.mjs';

// engineering-test-plan: HTTP/MCP integration; fake ports exclude SSH. Remote execution only.
// legacy-17/mcp-input-limits.test.mjs.17 cases 1/2 map to cases 1/2; case 3 maps to case 3.
// Changed contract: 64 -> 647 elements; strict unknown-field refusal; native JSON replaces
// decoded envelopes; observe replaces wait-for-request. Owner UI approval is tested separately.
// Oracle: fixed byte counts and exact dispatched native values, independent of implementation.
const id = 'a'.repeat(48), revision = 'c'.repeat(64), bodyLimit = 1024 * 1024;
const rpc = (name, args = {}, identifier = 1) => ({ jsonrpc: '2.0', id: identifier, method: 'tools/call', params: { name, arguments: args } });
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'input-limit-fixture', version: '1' } } };
const data = reply => { assert.equal(reply.isError, undefined, JSON.stringify(reply)); assert.equal(reply.structuredContent.ok, true); return reply.structuredContent.data; };
function assertBatchRefused(response) {
  assert.equal(response.status, 400);
  const reply = JSON.parse(response.text);
  assert.equal(reply.jsonrpc, '2.0'); assert.equal(reply.id, null); assert.equal(reply.error.code, -32600);
  assert.deepEqual(reply.error.data, { error_code: 'MCP_BATCH_NOT_SUPPORTED', executionAttempted: false, requestSubmitted: false });
}
async function fixture() {
  const seen = { submits: [], chunks: [], waits: [], desktop: [] };
  const pending = { id, kind: 'command', operation: {}, targetId: 'fixture', targetRevision: revision, state: 'pending', createdAt: 10, expiresAt: Date.now() + 600_000 };
  const queue = { maintenance: false, subject: () => 'fixture-job', get: () => pending, list: () => [], listAll: () => [] };
  const operations = {
    submit: async input => { seen.submits.push(input); return { ...pending, kind: input.kind === 'source' ? 'command' : input.kind, operationKey: input.operationKey, operation: input.kind === 'source' ? { sourceContract: true } : {} }; },
    observe: async input => { seen.waits.push(input); return { job: pending, waitTimedOut: true }; },
  };
  const files = {
    beginAgentUpload: async args => ({ ...args, id, targetId: args.target, targetRevision: args.expectedTargetRevision, received: 0, sequence: 0, expiresAt: pending.expiresAt }),
    appendAgentUpload: async args => { seen.chunks.push(args); return { sequence: args.sequence + 1, received: args.bytes.length }; },
  };
  const desktop = { input: async args => { seen.desktop.push(args); return { sessionId: args.sessionId, sequence: args.sequence, requestKey: args.requestKey, state: 'sent' }; } };
  const { mcpHttp } = createProtocolAdapters({ queue, operations, files, desktop, store: { subject: () => 'fixture-upload' },
    settings: { mcpToken: 'fixture-mcp', uiEnabled: true, prefix: 'fixture_', adminOrigin: 'https://example.test', maxBytes: CHUNK_BYTES },
    signer: new Tickets('b'.repeat(64)), adminAccess: { mode: 'token' }, uiHtml: '<html>fixture</html>' });
  await new Promise(resolve => mcpHttp.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${mcpHttp.address().port}/mcp`;
  async function post(value, { chunked = false, authenticated = true } = {}) {
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Connection: 'close', ...(authenticated ? { Authorization: 'Bearer fixture-mcp' } : {}) };
    if (!chunked) headers['Content-Length'] = Buffer.byteLength(body);
    return new Promise((resolve, reject) => {
      const outgoing = request(url, { method: 'POST', headers }, response => {
        let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, text }));
      });
      outgoing.on('error', reject);
      // Declared oversize must be refused before the client sends any bytes.
      if (chunked || Buffer.byteLength(body) <= bodyLimit) {
        for (let offset = 0; offset < body.length; offset += 16384) outgoing.write(body.slice(offset, offset + 16384));
      }
      outgoing.end();
    });
  }
  return { seen, post, call: async (name, args) => JSON.parse((await post(rpc(name, args))).text).result,
    close: () => new Promise(resolve => mcpHttp.close(resolve)) };
}
test('MCP HTTP enforces one MiB before parsing tool calls, initialization and batches, including chunked requests', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    for (const value of [rpc('targets'), initialize, [rpc('targets')]]) {
      const wire = JSON.stringify(value), exact = wire + ' '.repeat(bodyLimit - Buffer.byteLength(wire));
      const response = await f.post(exact);
      if (Array.isArray(value)) assertBatchRefused(response); else assert.equal(response.status, 200);
      for (const chunked of [true, false]) {
        const refused = await f.post(exact + ' ', { chunked });
        assert.equal(refused.status, 413); assert.match(refused.text, /1048576 bytes/); assert.ok(refused.text.length < 256);
      }
    }
    assert.equal((await f.post('x'.repeat(bodyLimit + 1))).status, 413);
    assert.equal((await f.post('x'.repeat(bodyLimit + 1), { authenticated: false })).status, 401);
    data(await f.call('targets'));
    assert.deepEqual(f.seen, { submits: [], chunks: [], waits: [], desktop: [] });
  } finally { await f.close(); }
});
test('MCP aggregate bound precedes every schema while strict schemas reject unknown fields and desktop accepts 128 actions', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const listing = JSON.parse((await f.post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).text).result;
    const names = listing.tools.map(tool => tool.name);
    for (const name of ['targets', 'submit', 'observe', 'artifact-begin', 'artifact-chunk', 'artifact-read', 'desktop-input']) assert.ok(names.includes(name), name);
    assert.ok(!names.includes('run-command'));
    for (const name of names) {
      const result = await f.call(name, { overflow: Array(647).fill(0) });
      assert.equal(result.isError, true, name); assert.match(result.content[0].text, /maximum of 647 elements/, name);
      assert.ok(JSON.stringify(result).length < 512, name);
    }
    const schemaRefusal = await f.call('targets', { padding: Array(646).fill(0) });
    assert.equal(schemaRefusal.isError, true); assert.doesNotMatch(schemaRefusal.content[0].text, /maximum of 647 elements/);
    let nested = 0; for (let depth = 0; depth < 648; depth++) nested = { child: nested };
    for (const args of [{ context: nested }, { context: { claims: Array(647).fill('claim') } }, { constructor: Array(647).fill(0) }, { argv: Array(16384).fill(0) }]) {
      const result = await f.call('submit', args); assert.equal(result.isError, true); assert.match(result.content[0].text, /maximum of 647 elements/);
    }
    const prototypeKey = await f.call('submit', JSON.parse('{"__proto__":' + JSON.stringify(Array(647).fill(0)) + '}'));
    assert.equal(prototypeKey.isError, true); assert.ok(JSON.stringify(prototypeKey).length < 4096);
    const members = [rpc('submit', { argv: Array(647).fill(0) }, 1), rpc('targets', {}, 2)];
    const refused = JSON.parse((await f.post(members[0])).text); assert.equal(refused.id, 1); assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /maximum of 647 elements/);
    const valid = JSON.parse((await f.post(members[1])).text); assert.equal(valid.id, 2); data(valid.result);
    for (const batch of [members, [rpc('submit', { kind: 'command', command: 'never-dispatch', operationKey: 'batch-never-submit-1' }), rpc('observe', { id, waitMs: 1 })], Array.from({ length: 101 }, (_, index) => rpc('targets', {}, index))]) assertBatchRefused(await f.post(batch));
    assert.deepEqual(f.seen, { submits: [], chunks: [], waits: [], desktop: [] }, 'rejected inputs must not dispatch');
    const desktop = { sessionId: '12345678-1234-4234-8234-123456789abc', epoch: 1, frameId: 'frame', geometryRevision: 1, sequence: 1, requestKey: 'input', actions: Array.from({ length: 128 }, () => ({ type: 'pointer', x: 0, y: 0, buttons: 0 })) };
    assert.equal(data(await f.call('desktop-input', desktop)).state, 'sent'); assert.deepEqual(f.seen.desktop, [desktop]);
    assert.equal((await f.call('desktop-input', { ...desktop, actions: [...desktop.actions, desktop.actions[0]] })).isError, true); assert.equal(f.seen.desktop.length, 1);
  } finally { await f.close(); }
});
test('native JSON preserves exact command/source bytes, sixteen literal arguments, full artifact chunks and bounded observations', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const command = 'x'.repeat(32768), context = 'Synthetic test context', displayContext = '합성 시험입니다.';
    const input = { kind: 'command', command, context, displayContext, operationKey: 'native-command-limit-1' };
    data(await f.call('submit', input)); assert.deepEqual(f.seen.submits[0], input);
    const literal = { ...input, command: 'ssh-request-v1:{"command":"id"}', operationKey: 'native-literal-envelope-1' };
    data(await f.call('submit', literal)); assert.deepEqual(f.seen.submits[1], literal, 'legacy-looking text is native command data');
    const source = { kind: 'source', target: 'fixture', source: 'x'.repeat(16384), argv: Array.from({ length: 16 }, (_, index) => `${index}: literal; $HOME ` + 'x'.repeat(480)), cwd: '/tmp', elevate: false, context, displayContext, operationKey: 'native-source-limit-1' };
    data(await f.call('submit', source)); assert.deepEqual(f.seen.submits[2], source);
    for (const invalid of [{ ...input, command: command + 'x' }, { ...input, command: '가'.repeat(10923) }, { ...source, source: source.source + 'x' }, { ...source, source: '가'.repeat(5462) }, { ...source, argv: [...source.argv, '17'] }, { ...source, argv: ['x'.repeat(513)] }, { ...input, operationKey: 'too-short' }]) assert.equal((await f.call('submit', invalid)).isError, true);
    assert.equal(f.seen.submits.length, 3);
    const conflict = await f.call('submit', { ...input, remotePath: '/tmp/conflict' });
    assert.equal(conflict.structuredContent.error.code, 'OPERATION_INPUT_CONFLICT'); assert.equal(f.seen.submits.length, 3);
    const bytes = Buffer.alloc(CHUNK_BYTES, 0xff);
    const begin = data(await f.call('artifact-begin', { target: 'fixture', expectedTargetRevision: revision, operationKey: 'native-upload-limit-1', fileName: 'fixture.bin', remotePath: '/tmp/fixture.bin', size: CHUNK_BYTES, sha256: revision }));
    assert.equal(begin.maxChunkBytes, CHUNK_BYTES);
    assert.deepEqual(data(await f.call('artifact-chunk', { id, sequence: 0, data: bytes.toString('base64') })), { sequence: 1, received: CHUNK_BYTES });
    assert.deepEqual(f.seen.chunks[0].bytes, bytes);
    for (const encoded of ['!!!!', 'AB==', Buffer.alloc(CHUNK_BYTES + 1).toString('base64')]) assert.equal((await f.call('artifact-chunk', { id, sequence: 1, data: encoded })).isError, true);
    assert.equal(f.seen.chunks.length, 1);
    assert.equal(data(await f.call('observe', { id, waitMs: 60000 })).waitTimedOut, true);
    assert.equal(f.seen.waits[0].waitMs, 60000); assert.equal(f.seen.waits[0].id, id);
    assert.equal((await f.call('observe', { id, waitMs: 60001 })).isError, true); assert.equal(f.seen.waits.length, 1);
  } finally { await f.close(); }
});
