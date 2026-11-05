import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApplication } from '../app.mjs';
import { Artifacts } from '../src/adapters/storage/artifacts.mjs';
import { hash } from '../src/domain/validation.mjs';
import { createFileSource } from '../src/adapters/sources/file-source.mjs';

// The original URL/App-only MCP cases are archived verbatim in legacy-17/agent-upload.test.mjs.17.
// Native uploads recover authorized bytes by transfer ID; the retained application
// source port still checks URL host policy, import cancellation and source concurrency.
const file = { download_url: 'https://files.example.test/source?signature=URL_SECRET_SENTINEL', file_id: 'FILE_REFERENCE_SENTINEL' };
const bytes = Buffer.from('FILE_BYTES_NEVER_IN_MODEL\0\xff');
const publicNames = ['targets', 'submit', 'observe', 'cancel', 'files', 'artifact-begin', 'artifact-chunk', 'artifact-status', 'artifact-finish', 'artifact-read'];
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const ownerHeaders = { Authorization: 'Bearer test-admin', Origin: 'https://example.test' };
const waitFor = async condition => {
  for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Fixture condition timed out');
};
const noPayloadLeak = value => {
  const text = JSON.stringify(value);
  for (const sentinel of [file.download_url, file.file_id, 'URL_SECRET_SENTINEL', 'FILE_BYTES_NEVER_IN_MODEL']) assert.equal(text.includes(sentinel), false);
};
async function fixture({ open, allowed = true, enabled = true, auditFail = false, uploadSource, requestCapacity = 16 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ssh-agent-file-')), events = [], calls = [];
  let opened = 0, sequence = 0;
  const provider = uploadSource ?? { inspect: () => ({ hostname: 'files.example.test', allowed }), open: async (url, options) => {
    opened++; return open ? open(url, options) : { stream: Readable.from([bytes]), expectedSize: bytes.length, close() {} };
  } };
  const application = await createApplication({ registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'mcpops', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
    classify: () => ({ class: 'safe' }), executeCommand: async () => assert.fail('Upload must not execute a command'),
    audit: event => { if (auditFail && event.action === 'submitted') throw Error('audit unavailable'); events.push(event); }, transferRoot: root,
    env: { BRIDGE_MCP_TOKEN: 'test-mcp', BRIDGE_ADMIN_TOKEN: 'test-admin', BRIDGE_ADMIN_ORIGIN: 'https://example.test', BRIDGE_UI_TICKET_KEY: 'b'.repeat(64),
      BRIDGE_UI_ENABLED: String(enabled), BRIDGE_TRANSFER_MAX_BYTES: '64', BRIDGE_TRANSFER_BUDGET_BYTES: '128', BRIDGE_REQUEST_CAPACITY: String(requestCapacity) },
    uiHtml: '<html>test</html>', uploadSource: provider });
  application.transfers.upload = async operation => {
    const fd = await application.store.verified(operation.artifactId); await fd.close();
    calls.push(operation); return { failed: false, texts: ['published'] };
  };
  await listen(application.mcpHttp); await listen(application.adminHttp);
  const url = new URL(`http://127.0.0.1:${application.mcpHttp.address().port}/mcp`);
  const connect = async name => {
    const client = new Client({ name, version: '1' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer test-mcp' } } })); return client;
  };
  const client = await connect('isolated-file-host');
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const ok = async (name, args) => {
    const result = await call(name, args); assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.contractVersion, '2.0'); assert.equal(result.structuredContent.ok, true);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent); noPayloadLeak(result); return result.structuredContent.data;
  };
  const input = extra => ({ operationKey: `agent-upload-contract-${++sequence}`, target: 'default',
    expectedTargetRevision: application.targets.select('default').revision, fileName: 'agent.bin', remotePath: '/tmp/agent.bin', size: bytes.length, sha256: hash(bytes), ...extra });
  const stage = async extra => {
    const transfer = await ok('artifact-begin', input(extra));
    await ok('artifact-chunk', { id: transfer.id, sequence: 0, data: bytes.toString('base64') }); return transfer;
  };
  const importFile = ({ file: sourceFile = file, remotePath = '/tmp/agent.bin', fileName = sourceFile.file_name ?? 'agent.bin', ...extra } = {}, options) => {
    const source = provider.bind?.(sourceFile.download_url) ?? {
      inspect: () => { const policy = provider.inspect(sourceFile.download_url); return { allowed: policy.allowed, sourceHost: policy.hostname }; },
      open: sourceOptions => provider.open(sourceFile.download_url, sourceOptions),
    };
    return application.targets.files.requestUpload({ source, remotePath, fileName, ...extra }, options);
  };
  const assertNoStaging = async () => {
    assert.equal(application.store.reserved, 0); assert.equal(application.store.size, 0);
    assert.deepEqual((await readdir(root)).filter(name => /^[a-f0-9]{48}\.(?:part|json)$/.test(name)), []);
  };
  return { application, client, events, calls, root, call, ok, input, stage, connect, importFile, assertNoStaging, get opened() { return opened; },
    web: `http://127.0.0.1:${application.adminHttp.address().port}`,
    async close() { await client.close(); await application.close(); await rm(root, { recursive: true }); } };
}

test('native upload schema freezes metadata and keeps approval authority private to the owner', async () => {
  const f = await fixture();
  try {
    const tools = (await f.client.listTools()).tools;
    assert.deepEqual(tools.filter(tool => !tool._meta?.ui).map(tool => tool.name).sort(), [...publicNames].sort());
    assert.equal(tools.some(tool => tool.name === 'request-upload'), false);
    const descriptor = tools.find(tool => tool.name === 'artifact-begin');
    assert.equal(descriptor._meta?.['openai/fileParams'], undefined); assert.equal(descriptor.inputSchema.additionalProperties, false);
    for (const key of ['operationKey', 'target', 'expectedTargetRevision', 'fileName', 'size', 'sha256']) assert.ok(descriptor.inputSchema.required.includes(key));
    const transfer = await f.stage(), result = await f.call('artifact-finish', { id: transfer.id }), job = result.structuredContent.data;
    assert.equal(job.state, 'pending'); assert.equal(job.kind, 'upload');
    const frozen = f.application.queue.get(job.id).operation;
    assert.equal(frozen.size, bytes.length); assert.equal(frozen.sha256, hash(bytes)); assert.equal(frozen.fileName, 'agent.bin');
    assert.equal(frozen.overwrite, false); assert.equal(frozen.elevate, false);
    assert.equal((await f.ok('observe', { id: job.id })).state, 'pending'); assert.equal(f.calls.length, 0);
    assert.equal(result._meta, undefined); assert.doesNotMatch(JSON.stringify(result), /approvalTicket|uploadTicket|bootstrapTicket/);
    const blind = await f.call('ui-decide-request', { id: job.id, action: 'approve', ticket: 'blind' });
    assert.equal(blind.isError, true); assert.equal(f.calls.length, 0);
    assert.equal((await fetch(`${f.web}/api/${job.id}/approve`, { method: 'POST', headers: { Authorization: 'Bearer test-mcp', Origin: 'https://example.test' } })).status, 401);
    assert.equal((await fetch(`${f.web}/api/${job.id}/approve`, { method: 'POST', headers: { ...ownerHeaders, Origin: 'https://untrusted.example.test' } })).status, 403);
    assert.equal(f.calls.length, 0);
    assert.equal((await fetch(`${f.web}/api/${job.id}/approve`, { method: 'POST', headers: ownerHeaders })).status, 200);
    assert.equal((await f.ok('observe', { id: job.id })).state, 'completed'); assert.equal(f.calls.length, 1);
    assert.equal((await f.ok('artifact-finish', { id: transfer.id })).id, job.id); assert.equal(f.calls.length, 1);
    assert.equal((await fetch(`${f.web}/api/${job.id}/approve`, { method: 'POST', headers: ownerHeaders })).status, 409); assert.equal(f.calls.length, 1);
    noPayloadLeak([f.application.queue.get(job.id), f.events]); await f.application.store.reap(); await f.assertNoStaging();
  } finally { await f.close(); }
});

test('URL/file references cannot enter native staging; blocked sources stay offline and UI-disabled uploads retain owner denial', async () => {
  const disabled = await fixture({ allowed: false });
  try {
    const result = await disabled.call('artifact-begin', { ...disabled.input(), file });
    assert.equal(result.isError, true); noPayloadLeak(result); assert.equal(disabled.opened, 0); await disabled.assertNoStaging();
    assert.deepEqual(await disabled.importFile(), { type: 'source-unavailable', sourceHost: 'files.example.test' });
    assert.equal(disabled.opened, 0); assert.equal(disabled.application.queue.listAll().length, 0); await disabled.assertNoStaging();
  } finally { await disabled.close(); }
  const f = await fixture({ enabled: false });
  try {
    const transfer = await f.stage({ overwrite: true, elevate: true, fileName: '한글.zip' });
    const result = await f.call('artifact-finish', { id: transfer.id }), job = result.structuredContent.data;
    assert.equal(f.application.queue.get(job.id).operation.fileName, '한글.zip'); assert.equal(result._meta, undefined);
    assert.equal((await fetch(`${f.web}/api/${job.id}/deny`, { method: 'POST', headers: ownerHeaders })).status, 200);
    assert.equal((await f.ok('observe', { id: job.id })).state, 'denied'); assert.equal(f.calls.length, 0);
    await f.application.store.reap(); await f.assertNoStaging();
  } finally { await f.close(); }
});

test('native input rejects provider URLs while the retained source boundary permits exact and regional hosts only', async () => {
  let requests = 0;
  const uploadSource = createFileSource({ hosts: ['direct.example.test', '*.files.example.test'], resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    request: (_url, _options, callback) => {
      requests++; const request = new EventEmitter(); request.destroy = () => {};
      request.end = () => queueMicrotask(() => callback(Object.assign(Readable.from([bytes]), { statusCode: 200, headers: {}, rawHeaders: [] }))); return request;
    } });
  const f = await fixture({ uploadSource });
  try {
    for (const host of ['files.example.test', 'evil-files.example.test', 'us.files.example.test.evil.test', 'sub.direct.example.test']) {
      const sourceFile = { ...file, download_url: `https://${host}/source?signature=URL_SECRET_SENTINEL` };
      const native = await f.call('artifact-begin', { ...f.input(), file: sourceFile }); assert.equal(native.isError, true); noPayloadLeak(native);
      assert.deepEqual(await f.importFile({ file: sourceFile }), { type: 'source-unavailable', sourceHost: host });
      assert.equal(requests, 0); await f.assertNoStaging(); assert.equal(f.application.queue.listAll().length, 0);
    }
    for (const host of ['direct.example.test', 'us.files.example.test', 'eu.files.example.test']) {
      const result = await f.importFile({ file: { ...file, download_url: `https://${host}/source?signature=URL_SECRET_SENTINEL` } });
      assert.equal(result.type, 'job'); assert.equal(result.job.state, 'pending'); assert.equal(result.job.operation.sha256, hash(bytes));
      assert.equal(result.job.operation.size, bytes.length); assert.equal(f.calls.length, 0); noPayloadLeak(result);
    }
    assert.equal(requests, 3); assert.equal(f.application.queue.listAll().length, 3); noPayloadLeak(f.events);
  } finally { await f.close(); }
});

test('source, public error, audit and configured queue refusals clean staging without remote mutation or private error leaks', async () => {
  const sourceFailure = await fixture({ open: async () => { throw Error(file.download_url); } });
  try {
    await assert.rejects(sourceFailure.importFile(), error => error.message === file.download_url);
    await sourceFailure.assertNoStaging(); assert.equal(sourceFailure.calls.length, 0); assert.equal(sourceFailure.application.queue.listAll().length, 0);
    sourceFailure.application.targets.files.beginAgentUpload = async () => { throw Error(file.download_url); };
    const result = await sourceFailure.call('artifact-begin', sourceFailure.input()); assert.equal(result.isError, true); noPayloadLeak(result);
    assert.equal(result.structuredContent.error.code, 'REQUEST_REFUSED'); await sourceFailure.assertNoStaging();
  } finally { await sourceFailure.close(); }
  const rejectedAudit = await fixture({ auditFail: true });
  try {
    const transfer = await rejectedAudit.stage();
    const result = await rejectedAudit.call('artifact-finish', { id: transfer.id }); assert.equal(result.isError, true); noPayloadLeak(result);
    assert.equal(rejectedAudit.calls.length, 0); assert.equal(rejectedAudit.application.queue.listAll().length, 0); await rejectedAudit.assertNoStaging();
  } finally { await rejectedAudit.close(); }
  const full = await fixture({ requestCapacity: 2 });
  try {
    for (let i = 0; i < 2; i++) full.application.queue.submit('synthetic pending');
    const transfer = await full.stage(), result = await full.call('artifact-finish', { id: transfer.id });
    assert.equal(result.isError, true); noPayloadLeak(result); assert.equal(full.application.queue.listAll().length, 2); assert.equal(full.calls.length, 0); await full.assertNoStaging();
  } finally { await full.close(); }
});

test('in-flight source imports and native partial staging block maintenance without granting submission authority', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ open: async () => { await gate; return { stream: Readable.from([bytes]), expectedSize: bytes.length, close() {} }; } });
  try {
    const pending = [f.importFile(), f.importFile()], rejected = pending.map(work => assert.rejects(work, /Maintenance/));
    await waitFor(() => f.opened === 2); await assert.rejects(f.importFile(), /busy/); assert.equal(f.opened, 2);
    assert.equal((await fetch(`${f.web}/api/maintenance/reserve`, { method: 'POST', headers: { ...ownerHeaders, 'x-maintenance-owner': 'c'.repeat(64) } })).status, 409);
    f.application.queue.maintenance = true; release(); await Promise.all(rejected);
    assert.equal(f.application.queue.listAll().length, 0); assert.equal(f.calls.length, 0); await f.assertNoStaging();
    f.application.queue.maintenance = false;
    const partial = await f.ok('artifact-begin', f.input());
    assert.equal((await fetch(`${f.web}/api/maintenance/reserve`, { method: 'POST', headers: { ...ownerHeaders, 'x-maintenance-owner': 'c'.repeat(64) } })).status, 409);
    f.application.queue.maintenance = true;
    assert.equal((await f.call('artifact-chunk', { id: partial.id, sequence: 0, data: bytes.toString('base64') })).isError, true);
    assert.equal(f.application.store.get(partial.id).received, 0); assert.equal(f.calls.length, 0);
  } finally { release(); await f.close(); }
});

test('native disconnect and shutdown retain acknowledged bytes; source cancellation still releases unsubmitted imports', async () => {
  for (const stop of ['disconnect', 'shutdown']) {
    let aborted = false;
    const f = await fixture({ open: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(Error(file.download_url)); }, { once: true });
    }) });
    let recoveredClient;
    try {
      const controller = new AbortController(), importing = f.importFile({}, { signal: controller.signal });
      const rejected = assert.rejects(importing, error => error.message === file.download_url);
      await waitFor(() => f.opened === 1); controller.abort(); await rejected;
      assert.equal(aborted, true); await f.assertNoStaging();
      const transfer = await f.ok('artifact-begin', f.input());
      await f.ok('artifact-chunk', { id: transfer.id, sequence: 0, data: bytes.subarray(0, 4).toString('base64') });
      if (stop === 'disconnect') {
        await f.client.close(); recoveredClient = await f.connect('another-authorized-agent');
        const call = async (name, args) => {
          const reply = await recoveredClient.callTool({ name, arguments: args }); assert.notEqual(reply.isError, true, JSON.stringify(reply));
          noPayloadLeak(reply); return reply.structuredContent.data;
        };
        const status = await call('artifact-status', { id: transfer.id });
        assert.equal(status.transfer.id, transfer.id); assert.equal(status.transfer.sequence, 1); assert.equal(status.transfer.received, 4);
        await call('artifact-chunk', { id: transfer.id, sequence: 1, data: bytes.subarray(4).toString('base64') });
        assert.equal((await call('artifact-finish', { id: transfer.id })).state, 'pending');
        assert.deepEqual(await readFile(join(f.root, transfer.id + '.part')), bytes);
      } else {
        await f.application.close();
        const restored = new Artifacts(f.root, { maxBytes: 64, budget: 128 }); await restored.init();
        assert.equal(restored.get(transfer.id).received, 4); assert.equal(restored.get(transfer.id).sequence, 1);
        assert.deepEqual(await readFile(join(f.root, transfer.id + '.part')), bytes.subarray(0, 4));
      }
      assert.equal(f.calls.length, 0);
    } finally { await recoveredClient?.close(); await f.close(); }
  }
});
