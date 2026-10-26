import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createProtocolAdapters } from '../src/adapters/http/protocol.mjs';
import { Tickets } from '../src/adapters/security/tickets.mjs';
import { CHUNK_BYTES } from '../src/contracts/ports.mjs';

const id = 'a'.repeat(48), bodyLimit = 1024 * 1024;
const rpc = (name, args = {}, identifier = 1) => ({ jsonrpc: '2.0', id: identifier, method: 'tools/call', params: { name, arguments: args } });
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'input-limit-fixture', version: '1' } } };

async function fixture() {
  const seen = { commands: [], source: [], chunks: [], waits: [] };
  const pending = { id, kind: 'command', command: 'id', operation: { kind: 'command', command: 'id' }, profile: 'fixture', commandClass: 'read-only', target: 'fixture@localhost:22', state: 'pending', createdAt: 10, expiresAt: Date.now() + 600_000 };
  const queue = { maintenance: false, subject: () => 'fixture-job', get: () => pending, list: () => [], listAll: () => [],
    waitForRequest: async (...args) => { seen.waits.push(args); return { job: pending, event: 'timeout' }; } };
  const commands = {
    run: async (...args) => { seen.commands.push(args); return { type: 'job', job: pending }; },
    runSource: async (...args) => { seen.source.push(args); return { type: 'job', job: pending }; },
  };
  const files = { beginUpload: async () => ({ id, expiresAt: pending.expiresAt }), appendUpload: async args => { seen.chunks.push(args); return { sequence: args.sequence + 1, received: args.bytes.length }; } };
  const { mcpHttp } = createProtocolAdapters({ queue, commands, files, store: { subject: () => 'fixture-upload' },
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
      // A declared oversize body must be refused from headers, without sending its bytes.
      if (chunked || Buffer.byteLength(body) <= bodyLimit) {
        for (let offset = 0; offset < body.length; offset += 16384) outgoing.write(body.slice(offset, offset + 16384));
      }
      outgoing.end();
    });
  }
  return { seen, post, call: async (name, args) => JSON.parse((await post(rpc(name, args))).text).result,
    close: () => new Promise(resolve => mcpHttp.close(resolve)) };
}

test('MCP HTTP enforces one MiB before parsing for tool calls, initialization and batches, including chunked requests', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    for (const value of [rpc('list-targets'), initialize, [rpc('list-targets')]]) {
      const wire = JSON.stringify(value);
      const exact = wire + ' '.repeat(bodyLimit - Buffer.byteLength(wire));
      assert.equal((await f.post(exact)).status, 200, 'exact one MiB remains accepted');
      for (const chunked of [true, false]) {
        const response = await f.post(exact + ' ', { chunked });
        assert.equal(response.status, 413, `one MiB + 1 must be refused (chunked=${chunked})`);
        assert.match(response.text, /1048576 bytes/); assert.ok(response.text.length < 256);
      }
    }
    assert.equal((await f.post('x'.repeat(bodyLimit + 1))).status, 413, 'limit applies before malformed JSON parsing');
    assert.equal((await f.post('x'.repeat(bodyLimit + 1), { authenticated: false })).status, 401, 'bearer authentication still precedes transport');
    assert.equal((await f.call('list-targets')).isError, undefined, 'refusal leaves server usable');
  } finally { await f.close(); }
});

test('MCP bounds aggregate input before every registered tool schema, including unknown fields and nested arrays', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const listing = JSON.parse((await f.post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).text).result;
    assert.equal(listing.tools.length, 20);
    for (const { name } of listing.tools) {
      const result = await f.call(name, { overflow: Array(64).fill(0) });
      assert.equal(result.isError, true, name); assert.match(result.content[0].text, /maximum of 64 elements/, name);
      assert.ok(JSON.stringify(result).length < 512, name);
    }
    assert.equal((await f.call('list-targets', { padding: Array(63).fill(0) })).isError, undefined, '64 aggregate elements accepted');
    const numeric = await f.call('run-python-source', { argv: Array(16384).fill(0) });
    assert.match(numeric.content[0].text, /maximum of 64 elements/); assert.ok(JSON.stringify(numeric).length < 512);
    let nested = 0; for (let depth = 0; depth < 65; depth++) nested = { child: nested };
    for (const args of [{ context: nested }, { context: { claims: Array(64).fill('claim') } }, { constructor: Array(64).fill(0) }]) {
      assert.match((await f.call('run-command', args)).content[0].text, /maximum of 64 elements/);
    }
    // The SDK protocol schema discards __proto__ before tool validation.
    const prototypeKey = await f.call('run-command', JSON.parse('{"__proto__":' + JSON.stringify(Array(64).fill(0)) + '}'));
    assert.equal(prototypeKey.isError, true); assert.ok(JSON.stringify(prototypeKey).length < 512);
    const batch = JSON.parse((await f.post([rpc('run-python-source', { argv: Array(64).fill(0) }, 1), rpc('list-targets', {}, 2)])).text);
    assert.match(batch.find(reply => reply.id === 1).result.content[0].text, /maximum of 64 elements/);
    assert.equal(batch.find(reply => reply.id === 2).result.isError, undefined);
    assert.equal((await f.post(Array.from({ length: 101 }, (_, index) => rpc('list-targets', {}, index)))).status, 400, 'SDK batch ceiling preserved');
    assert.deepEqual(f.seen, { commands: [], source: [], chunks: [], waits: [] }, 'rejected tools never dispatch');
  } finally { await f.close(); }
});

test('MCP limits preserve long command envelopes, sixteen literal arguments, full upload chunks and approval callbacks', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const command = 'x'.repeat(32768), context = 'Synthetic test context', displayContext = '합성 시험입니다.';
    assert.equal((await f.call('run-command', { command, context, displayContext })).isError, undefined);
    const prefix = 'ssh-request-v1:', encoded = JSON.stringify({ command, context, displayContext });
    const envelope = prefix + ' '.repeat(524288 - prefix.length - Buffer.byteLength(encoded)) + encoded;
    assert.equal(Buffer.byteLength(envelope), 524288);
    assert.equal((await f.call('run-command', { command: envelope })).isError, undefined);
    assert.equal(f.seen.commands.length, 2); assert.equal(f.seen.commands[1][0], command);
    const source = { target: 'fixture', source: 'x'.repeat(16384), argv: Array.from({ length: 16 }, (_, index) => `${index}: literal; $HOME ` + 'x'.repeat(480)), cwd: '/tmp', elevate: false, context, displayContext, requestKey: 'synthetic-input-limits-1' };
    assert.equal((await f.call('run-python-source', source)).isError, undefined);
    const { target, ...sourceArgs } = source;
    assert.deepEqual(f.seen.source[0], [sourceArgs, target]);
    const transfer = { direction: 'upload', remotePath: '/tmp/fixture.bin', elevate: false, overwrite: false };
    const shown = await f.call('show-file-transfer', transfer);
    const begin = await f.call('ui-upload-begin', { transfer, ticket: shown._meta.sshApproval.bootstrapTicket, fileName: 'fixture.bin', size: CHUNK_BYTES, sha256: 'c'.repeat(64) });
    const bytes = Buffer.alloc(CHUNK_BYTES, 0xff);
    const chunk = await f.call('ui-upload-chunk', { id, ticket: begin._meta.sshApproval.uploadTicket, sequence: 0, data: bytes.toString('base64') });
    assert.deepEqual(chunk.structuredContent, { sequence: 1, received: CHUNK_BYTES }); assert.deepEqual(f.seen.chunks[0].bytes, bytes);
    const waited = await f.call('wait-for-request', { id, until: 'completion', timeoutMs: 60000 });
    assert.equal(waited.structuredContent.callback.event, 'timeout'); assert.equal(waited.structuredContent.callback.approved, false);
    assert.equal(f.seen.waits[0][0], id); assert.equal(f.seen.waits[0][1].timeoutMs, 60000);
  } finally { await f.close(); }
});
