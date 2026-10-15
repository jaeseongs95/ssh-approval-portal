import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApplication } from '../app.mjs';
import { hash } from '../core.mjs';

const file = { download_url: 'https://files.example.test/source?signature=URL_SECRET_SENTINEL', file_id: 'FILE_REFERENCE_SENTINEL' };
const bytes = Buffer.from('FILE_BYTES_NEVER_IN_MODEL\0\xff');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const waitFor = async condition => {
  for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Fixture condition timed out');
};
async function fixture({ open, allowed = true, enabled = true, auditFail = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ssh-agent-file-')), events = [], calls = [];
  let opened = 0;
  const application = await createApplication({ registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'mcpops', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
    classify: () => ({ class: 'safe' }), executeCommand: async () => assert.fail('Upload must not execute a command'),
    audit: event => { if (auditFail && event.action === 'submitted') throw Error('audit unavailable'); events.push(event); }, transferRoot: root,
    env: { BRIDGE_MCP_TOKEN: 'test-mcp', BRIDGE_ADMIN_TOKEN: 'test-admin', BRIDGE_ADMIN_ORIGIN: 'https://example.test', BRIDGE_UI_TICKET_KEY: 'b'.repeat(64), BRIDGE_UI_ENABLED: String(enabled), BRIDGE_TRANSFER_MAX_BYTES: '64', BRIDGE_TRANSFER_BUDGET_BYTES: '128' },
    uiHtml: '<html>test</html>', uploadSource: { inspect: () => ({ hostname: 'files.example.test', allowed }), open: async (url, options) => {
      opened++; return open ? open(url, options) : { stream: Readable.from([bytes]), expectedSize: bytes.length, close() {} };
    } } });
  application.transfers.upload = async operation => {
    const fd = await application.store.verified(operation.artifactId); await fd.close();
    calls.push(operation); return { content: [{ type: 'text', text: 'published' }] };
  };
  await listen(application.mcpHttp); await listen(application.adminHttp);
  const client = new Client({ name: 'isolated-file-host', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${application.mcpHttp.address().port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer test-mcp' } } }));
  return { application, client, events, calls, root, get opened() { return opened; },
    call: (args = {}) => client.callTool({ name: 'request-upload', arguments: { file, remotePath: '/tmp/agent.bin', ...args } }),
    web: `http://127.0.0.1:${application.adminHttp.address().port}`,
    async close() { await client.close(); await application.close(); await rm(root, { recursive: true }); } };
}
const noPayloadLeak = value => {
  const text = JSON.stringify(value);
  for (const sentinel of [file.download_url, file.file_id, 'URL_SECRET_SENTINEL', 'FILE_BYTES_NEVER_IN_MODEL']) assert.equal(text.includes(sentinel), false);
};

test('platform file schema, optional metadata, immutable approval and private-only capabilities', async () => {
  const f = await fixture();
  try {
    const descriptor = (await f.client.listTools()).tools.find(tool => tool.name === 'request-upload');
    assert.deepEqual(descriptor._meta['openai/fileParams'], ['file']);
    assert.deepEqual(Object.keys(descriptor.inputSchema.properties.file.properties).sort(), ['download_url', 'file_id', 'file_name', 'mime_type']);
    assert.deepEqual([...descriptor.inputSchema.properties.file.required].sort(), ['download_url', 'file_id']);
    const result = await f.call(); const job = result.structuredContent;
    assert.equal(job.state, 'pending'); assert.equal(job.operation.size, bytes.length); assert.equal(job.operation.sha256, hash(bytes));
    const status = await f.client.callTool({ name: 'get-request-status', arguments: { id: job.id } });
    assert.equal(status.structuredContent.state, 'pending');
    assert.equal(job.operation.fileName, 'agent.bin'); assert.equal(job.operation.overwrite, false); assert.equal(job.operation.elevate, false);
    assert.equal(f.calls.length, 0); noPayloadLeak([result.content, job, f.events]);
    assert.ok(result._meta.sshApproval.approvalTicket); assert.equal(JSON.stringify(job).includes('Ticket'), false);
    const blind = await f.client.callTool({ name: 'ui-decide-request', arguments: { id: job.id, action: 'approve', ticket: 'blind' } });
    assert.equal(blind.isError, true); assert.equal(f.calls.length, 0);
    const approved = await f.client.callTool({ name: 'ui-decide-request', arguments: { id: job.id, action: 'approve', ticket: result._meta.sshApproval.approvalTicket } });
    assert.equal(approved.structuredContent.state, 'running'); await f.application.queue.wait(job.id); assert.equal(f.calls.length, 1);
    const duplicate = await f.client.callTool({ name: 'ui-decide-request', arguments: { id: job.id, action: 'approve', ticket: result._meta.sshApproval.approvalTicket } });
    assert.equal(duplicate.isError, true); assert.equal(f.calls.length, 1);
    noPayloadLeak([f.application.queue.get(job.id), f.events]);
    await f.application.store.reap(); assert.equal(f.application.store.reserved, 0);
  } finally { await f.close(); }
});

test('unconfigured sources report only hostname without fetching or reserving; disabled cards retain web denial', async () => {
  const disabled = await fixture({ allowed: false });
  try {
    const result = await disabled.call(); assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error, 'upload-source-not-configured'); assert.equal(result.structuredContent.sourceHost, 'files.example.test');
    assert.equal(disabled.opened, 0); assert.equal(disabled.application.store.reserved, 0); assert.equal(disabled.application.queue.jobs.size, 0);
    noPayloadLeak(result);
  } finally { await disabled.close(); }
  const f = await fixture({ enabled: false });
  try {
    const result = await f.call({ overwrite: true, elevate: true, file: { ...file, file_name: '한글.zip' } });
    assert.equal(result.structuredContent.operation.fileName, '한글.zip'); assert.equal(result._meta.sshApproval.approvalTicket, undefined);
    const id = result.structuredContent.id;
    assert.equal((await fetch(`${f.web}/api/${id}/deny`, { method: 'POST', headers: { Authorization: 'Bearer test-admin', Origin: 'https://example.test' } })).status, 200);
    assert.equal(f.application.queue.get(id).state, 'denied'); assert.equal(f.calls.length, 0);
    await f.application.store.reap(); assert.equal(f.application.store.reserved, 0);
  } finally { await f.close(); }
});

test('source/audit/queue rejection cleans private staging and never echoes source errors', async () => {
  for (const config of [{ open: async () => { throw Error(file.download_url); } }, { auditFail: true }]) {
    const f = await fixture(config);
    try {
      const result = await f.call(); assert.equal(result.isError, true); noPayloadLeak(result);
      assert.equal(f.calls.length, 0); assert.equal(f.application.store.reserved, 0); assert.equal(f.application.store.items.size, 0);
      assert.deepEqual(await readdir(f.root), []); assert.equal(f.application.queue.jobs.size, 0);
    } finally { await f.close(); }
  }
  const f = await fixture();
  try {
    for (let i = 0; i < 100; i++) f.application.queue.submit('synthetic pending');
    const result = await f.call(); assert.equal(result.isError, true); assert.equal(f.application.store.reserved, 0); assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test('in-flight imports block maintenance, cap concurrency and discard work if maintenance wins submission', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ open: async () => { await gate; return { stream: Readable.from([bytes]), expectedSize: bytes.length, close() {} }; } });
  try {
    const pending = [f.call(), f.call()];
    await waitFor(() => f.opened === 2);
    assert.equal((await f.call()).isError, true); assert.equal(f.opened, 2);
    assert.equal((await fetch(`${f.web}/api/maintenance/reserve`, { method: 'POST', headers: { Authorization: 'Bearer test-admin', Origin: 'https://example.test' } })).status, 409);
    f.application.queue.maintenance = true; release();
    for (const result of await Promise.all(pending)) assert.equal(result.isError, true);
    assert.equal(f.application.queue.jobs.size, 0); assert.equal(f.application.store.reserved, 0); assert.equal(f.calls.length, 0);
  } finally { release(); await f.close(); }
});

test('HTTP disconnect and application shutdown abort imports and release quota without remote mutation', async () => {
  for (const stop of ['disconnect', 'shutdown']) {
    let aborted = false;
    const f = await fixture({ open: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(Error(file.download_url)); }, { once: true });
    }) });
    let request;
    const call = stop === 'shutdown' ? f.call().catch(() => null) : new Promise(resolve => {
      request = httpRequest(`http://127.0.0.1:${f.application.mcpHttp.address().port}/mcp`, { method: 'POST',
        headers: { Authorization: 'Bearer test-mcp', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } }, response => response.resume());
      request.on('error', () => resolve(null)); request.on('close', () => resolve(null));
      request.end(JSON.stringify({ jsonrpc: '2.0', id: 'disconnect-test', method: 'tools/call', params: { name: 'request-upload', arguments: { file, remotePath: '/tmp/x' } } }));
    });
    try {
      await waitFor(() => f.opened === 1);
      if (stop === 'disconnect') request.destroy(); else await f.application.close();
      await call; await waitFor(() => aborted && f.application.store.items.size === 0);
      assert.equal(f.application.store.reserved, 0); assert.equal(f.application.queue.jobs.size, 0); assert.equal(f.calls.length, 0);
      assert.deepEqual(await readdir(f.root), []);
    } finally {
      await f.client.close(); if (stop === 'disconnect') await f.application.close(); await rm(f.root, { recursive: true });
    }
  }
});
