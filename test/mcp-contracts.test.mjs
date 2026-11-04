import metadata from '../package.json' with { type: 'json' };
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createProtocolAdapters } from '../src/adapters/http/protocol.mjs';
import { Tickets } from '../src/adapters/security/tickets.mjs';
import { authorizeAdminRequest } from '../src/adapters/security/admin-policy.mjs';
import { callerContext } from '../src/domain/execution-context.mjs';

// Contract 1.8 replaces legacy setup and command envelopes. Retain their HTTP,
// strict-schema, exact-byte, context, redaction, cardless, paging and private UI coverage.
const identifier = 'a'.repeat(48), revision = 'b'.repeat(64), operationKey = 'contract-fixture-key-180';
const publicNames = ['targets', 'submit', 'observe', 'cancel', 'artifact-begin', 'artifact-chunk', 'artifact-status', 'artifact-finish', 'artifact-read'];
const settings = { mcpToken: 'contract-mcp', adminToken: 'contract-admin', adminOrigin: 'https://example.test', uiEnabled: true, prefix: 'ssh-approval-bridge_', maxBytes: 64 };
const job = () => ({ id: identifier, operationKey, kind: 'command', operation: { kind: 'command', command: 'sudo id' }, command: 'sudo id',
  profile: 'aws-local', commandClass: 'privileged', target: 'fixture@localhost:22', state: 'pending', createdAt: 10, expiresAt: Date.now() + 600_000 });

async function fixture(overrides = {}) {
  const calls = { submit: [], observe: [], cancel: [], append: [], imports: [] }, pending = job();
  const queue = { maintenance: false, subject: () => 'frozen-job', get: id => id === identifier ? pending : null,
    submit: () => pending, start: () => ({ ...pending, state: 'running' }), deny: () => ({ ...pending, state: 'denied' }),
    approve: async () => ({ ...pending, state: 'completed', result: { failed: false, texts: ['finished'], data: { preserved: true } } }), list: () => [pending], listAll: () => [pending] };
  const commands = { read: async () => ({ failed: false, texts: ['fixture-output'] }), run: async () => ({ type: 'job', job: pending }) };
  const operations = {
    async submit(input) { callerContext(input.context); callerContext(input.displayContext); calls.submit.push(input); return pending; },
    async observe(input) { calls.observe.push(input); return pending; },
    async cancel(input) { calls.cancel.push(input); return { ...pending, state: 'cancelled' }; },
  };
  const files = { requestUpload: async args => { calls.imports.push(args); return { type: 'source-unavailable', sourceHost: 'files.example.test' }; },
    requestDownload: () => pending, beginUpload: async () => ({ id: identifier, expiresAt: Date.now() + 600_000 }),
    appendUpload: async args => { calls.append.push(args); return { sequence: args.sequence + 1, received: args.bytes.length }; }, finishUpload: async () => pending,
    beginAgentUpload: async () => ({ id: identifier, received: 0, sequence: 0, size: 3, sha256: 'd'.repeat(64), expiresAt: Date.now() + 600_000, targetId: 'default', targetRevision: revision }),
    appendAgentUpload: async args => { calls.append.push(args); return { sequence: args.sequence + 1, received: args.bytes.length }; }, agentUploadStatus: () => ({ state: 'submitted', job: pending }), finishAgentUpload: async () => pending };
  const lifecycle = { snapshot: () => ({ busy: false, pending: 1, maintenance: false }), reserve() {}, release() {} };
  const source = { inspect: () => ({ allowed: false, sourceHost: 'files.example.test' }), open: async () => assert.fail('No source dispatch') };
  const adapters = createProtocolAdapters({ queue, commands, operations, files, lifecycle, store: { subject: () => 'frozen-upload' }, settings,
    signer: new Tickets('b'.repeat(64)), adminAccess: { mode: 'token' }, authorizeAdminRequest, uiHtml: '<html>fixture</html>',
    webHtml: '<html data-auth-mode="token"></html>', webJs: 'fixture', bindFileSource: () => source, ...overrides });
  await new Promise(resolve => adapters.mcpHttp.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => adapters.adminHttp.listen(0, '127.0.0.1', resolve));
  const mcpBase = `http://127.0.0.1:${adapters.mcpHttp.address().port}`, adminBase = `http://127.0.0.1:${adapters.adminHttp.address().port}`;
  const client = new Client({ name: 'contract-client', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpBase + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer contract-mcp', Connection: 'close' } } }));
  return { client, calls, commands, operations, pending, files, adapters, mcpBase, adminBase, call: (name, args = {}) => client.callTool({ name, arguments: args }),
    async close() { await client.close(); await Promise.all([adapters.mcpHttp, adapters.adminHttp].map(server => new Promise(resolve => server.close(resolve)))); } };
}

test('actual MCP HTTP preserves 5 KiB and 32 KiB native commands plus bilingual path-only context', async () => {
  const f = await fixture(); try {
    for (const size of [5025, 32768]) {
      const command = 'printf ' + 'x'.repeat(size - 7), input = { kind: 'command', operationKey, command,
        context: 'Check metadata for .env, /etc/shadow, /home/operator/.ssh/id_ed25519 and /secrets/service; no file contents supplied.', displayContext: '.env 및 /etc/shadow 경로 메타데이터만 확인합니다.' };
      const result = await f.call('submit', input); assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.deepEqual(f.calls.submit.at(-1), input); assert.equal(Buffer.byteLength(f.calls.submit.at(-1).command), size);
      assert.equal(result.structuredContent.data.id, identifier); assert.doesNotMatch(JSON.stringify(result), /id_ed25519|shadow|printf/);
    }
    const detailed = { kind: 'command', operationKey, command: 'printf fixture', context: 'a'.repeat(8192), displayContext: '가'.repeat(8192) };
    assert.equal((await f.call('submit', detailed)).isError, undefined);
    assert.deepEqual(f.calls.submit.at(-1), detailed);
    assert.equal(f.calls.submit.length, 3);
  } finally { await f.close(); }
});

test('actual MCP HTTP refuses invalid or secret descriptions without dispatch or secret reflection', async () => {
  const f = await fixture(); try {
    for (const field of ['context', 'displayContext']) for (const value of ['password=synthetic-private-marker', 'Bearer synthetic-private-marker', '-----BEGIN PRIVATE KEY-----\nsynthetic-private-marker', 'a'.repeat(8193), 'synthetic-private-marker\0invalid', false]) {
      const result = await f.call('submit', { kind: 'command', operationKey, command: 'printf fixture', [field]: value });
      assert.equal(result.isError, true); assert.doesNotMatch(JSON.stringify(result), /synthetic-private-marker/);
    }
    assert.equal(f.calls.submit.length, 0); f.operations.submit = async () => { throw Error('untrusted-error synthetic-private-marker'); };
    const result = await f.call('submit', { kind: 'command', operationKey, command: 'printf fixture' });
    assert.equal(result.structuredContent.error.code, 'REQUEST_REFUSED'); assert.doesNotMatch(JSON.stringify(result), /synthetic-private-marker/);
  } finally { await f.close(); }
});

// UI contract oracle: OpenAI Plugins reference _meta.ui.visibility defaults to ['model', 'app'];
// show-* launches cards from the model, while privileged ui-* actions remain app-only.
// TEST red/green: run this unchanged test against the baseline and fixed server.mjs in isolated copies.
test('public MCP surface exposes operation and card tools while owner UI actions stay app-only', async () => {
  const f = await fixture(); try {
    const tools = (await f.client.listTools()).tools, modelTools = tools.filter(tool => !tool._meta?.ui?.visibility || tool._meta.ui.visibility.includes('model'));
    const showNames = ['show-ui-probe', 'show-approval', 'show-file-transfer'];
    assert.deepEqual(modelTools.filter(tool => !tool.name.startsWith('desktop-')).map(tool => tool.name), [...publicNames, ...showNames]);
    const desktopNames = modelTools.filter(tool => tool.name.startsWith('desktop-')).map(tool => tool.name);
    if (desktopNames.length) assert.deepEqual(desktopNames, ['desktop-open', 'desktop-status', 'desktop-observe', 'desktop-input', 'desktop-close']);
    const privateTools = tools.filter(tool => tool.name.startsWith('ui-'));
    assert.deepEqual(privateTools.map(tool => tool.name), ['ui-decide-request', 'ui-upload-begin', 'ui-upload-chunk', 'ui-upload-finish', 'ui-download-link', 'ui-read-command-output']);
    // UI actions update the current card; only public show tools can render a widget.
    for (const tool of privateTools) {
      assert.deepEqual(tool._meta.ui.visibility, ['app']);
      assert.equal(tool._meta.ui.resourceUri, undefined, tool.name + ' must not render a widget');
      assert.equal(tool._meta['openai/outputTemplate'], undefined, tool.name + ' must not render a legacy widget');
    }
    assert.deepEqual(tools.filter(tool => tool._meta?.ui?.resourceUri || tool._meta?.['openai/outputTemplate']).map(tool => tool.name), showNames);
    const resources = (await f.client.listResources()).resources;
    assert.equal(resources.length, 1); assert.equal(resources[0].mimeType, 'text/html;profile=mcp-app');
    for (const name of showNames) {
      const tool = tools.find(tool => tool.name === name);
      assert.deepEqual(tool._meta.ui.visibility, ['model', 'app']);
      assert.equal(tool._meta.ui.resourceUri, resources[0].uri);
    }
    const resource = await f.client.readResource({ uri: resources[0].uri });
    assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.equal(resource.contents[0].text, '<html>fixture</html>');
    for (const old of ['get-client-capabilities', 'get-client-setup', 'run-command', 'read-command', 'run-python-source', 'request-upload', 'read-command-output']) assert.equal(tools.some(tool => tool.name === old), false, old);
    const result = await f.call('submit', { kind: 'command', operationKey, command: 'sudo id' });
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.deepEqual(Object.keys(result.structuredContent).sort(), ['contractVersion', 'data', 'error', 'ok']);
    assert.equal(result.structuredContent.contractVersion, '2.0'); assert.equal(result.structuredContent.ok, true); assert.equal(result.structuredContent.error, null); assert.equal(result._meta, undefined);
  } finally { await f.close(); }
});

test('cardless discovery stays read-only and exposes limits plus owner authority for either UI setting', async () => {
  for (const enabled of [false, true]) { const f = await fixture({ settings: { ...settings, uiEnabled: enabled } }); try {
    const descriptor = (await f.client.listTools()).tools.find(tool => tool.name === 'targets');
    assert.equal(descriptor.annotations.readOnlyHint, true); assert.equal(descriptor.annotations.destructiveHint, false);
    const reply = await f.call('targets'), result = JSON.parse(reply.content[0].text); assert.deepEqual(result, reply.structuredContent);
    assert.equal(result.data.limits.commandBytes, 32768); assert.equal(result.data.limits.sourceBytes, 16384);
    assert.equal(result.data.limits.artifactBytes, 64); assert.equal(result.data.limits.chunkBytes, 262144);
    assert.equal(result.data.approval.agentSelfApproval, false); assert.equal(result.data.approval.ownerUrl, settings.adminOrigin);
    assert.doesNotMatch(JSON.stringify(reply), /contract-mcp|contract-admin|approvalTicket|bootstrapTicket|downloadUrl/);
    assert.equal(f.calls.submit.length, 0); assert.equal(f.calls.append.length, 0); assert.equal(f.calls.imports.length, 0);
    assert.match(f.client.getInstructions(), /stable operationKey/); assert.match(f.client.getInstructions(), /No local CLI/);
  } finally { await f.close(); } }
});

test('SDK-published MCP schemas compile in draft-07 and remain structurally compatible with 2020-12', async () => {
  const f = await fixture(); try {
    const tools = (await f.client.listTools()).tools;
    for (const [index, ajv] of [new Ajv({ strict: false, allErrors: true }), new Ajv2020({ strict: false, allErrors: true })].entries()) {
      addFormats(ajv); let compiled = 0;
      for (const tool of tools) for (const key of ['inputSchema', 'outputSchema']) {
        const published = tool[key]; assert.ok(published, `${tool.name}.${key}`); assert.equal(published.$schema, 'http://json-schema.org/draft-07/schema#');
        const schema = index === 0 ? published : { ...published, $schema: 'https://json-schema.org/draft/2020-12/schema' };
        assert.doesNotThrow(() => ajv.compile(schema), `${tool.name}.${key}`); compiled++;
      }
      assert.equal(compiled, tools.length * 2);
    }
  } finally { await f.close(); }
});

test('native submit rejects unknown fields, wrong kinds, missing payload and invalid replay keys before dispatch', async () => {
  const f = await fixture(); try {
    for (const input of [{ kind: 'command', operationKey, command: 'id', autoApprove: true }, { kind: 'command', operationKey, command: 'id', remotePath: '/tmp/file' }, { kind: 'command', operationKey }, { kind: 'source', operationKey, source: 'print(1)' }, { kind: 'download', operationKey }, { kind: 'upload', operationKey }, { kind: 'command', operationKey: 'short', command: 'id' }, { kind: 'command', operationKey: 123, command: 'id' }, { kind: 'command', operationKey, command: 'id', target: '../escape' }]) assert.equal((await f.call('submit', input)).isError, true, JSON.stringify(input));
    assert.equal(f.calls.submit.length, 0);
    const source = 'print("한글")\r\n'; assert.equal((await f.call('submit', { kind: 'source', operationKey, source, cwd: '/tmp', argv: ['one'] })).structuredContent.ok, true); assert.equal(f.calls.submit[0].source, source);
    assert.equal((await f.call('submit', { kind: 'download', operationKey, remotePath: '/tmp/file' })).structuredContent.ok, true);
    for (const revision of [undefined, 'a'.repeat(64)]) {
      const download = { kind: 'download', operationKey, remotePath: '/tmp/file', context: 'Download the authorized fixture.', displayContext: '승인된 시험 파일을 내려받습니다.',
        ...(revision ? { expectedTargetRevision: revision } : {}) };
      assert.equal((await f.call('submit', download)).structuredContent.ok, true);
      assert.deepEqual(f.calls.submit.at(-1), download);
    }
  } finally { await f.close(); }
});

test('observe requires one stable lookup and explicit output reads; timeout never cancels or resubmits', async () => {
  const f = await fixture(); try {
    for (const input of [{}, { id: identifier, operationKey }, { id: identifier, cursor: 4 }, { id: identifier, maxBytes: 8 }, { id: identifier, waitMs: 60001 }]) assert.equal((await f.call('observe', input)).isError, true);
    assert.equal(f.calls.observe.length, 0); f.operations.observe = async input => { f.calls.observe.push(input); return { job: f.pending, waitTimedOut: true }; };
    const result = await f.call('observe', { operationKey, waitMs: 1 }); assert.equal(result.structuredContent.data.state, 'pending'); assert.equal(result.structuredContent.data.waitTimedOut, true);
    assert.equal(f.calls.cancel.length, 0); assert.equal(f.calls.submit.length, 0);
    assert.equal((await f.call('cancel', { id: identifier })).structuredContent.data.state, 'cancelled'); assert.deepEqual(f.calls.cancel, [{ id: identifier }]);
  } finally { await f.close(); }
});

test('text-only MCP clients reconstruct bounded UTF-8 output and digest with no status body leakage', async () => {
  const f = await fixture(), text = '가\n나', digest = createHash('sha256').update(text).digest('hex'); try {
    f.pending.state = 'completed'; f.pending.result = { failed: false, texts: [text], output: { id: identifier, state: 'ready', bytes: 7, sha256: digest } };
    f.operations.observe = async input => ({ job: f.pending, outputPage: input.cursor === 0 ? { text: '가\n', cursor: 0, nextCursor: 4, bytes: 4, totalBytes: 7, sha256: digest, eof: false, expiresAt: 100 } : { text: '나', cursor: 4, nextCursor: 7, bytes: 3, totalBytes: 7, sha256: digest, eof: true, expiresAt: 100 } });
    const status = await f.call('observe', { id: identifier }); assert.equal(JSON.stringify(status).includes(text), false); assert.equal(status.structuredContent.data.outputPage, null);
    let cursor = 0, reconstructed = '', pages = 0;
    while (true) { const reply = await f.call('observe', { id: identifier, includeOutput: true, cursor, maxBytes: 4 }), page = JSON.parse(reply.content[0].text).data.outputPage;
      assert.equal(page.cursor, cursor); assert.equal(page.bytes, Buffer.byteLength(page.text)); assert.equal(page.sha256, digest); assert.equal(page.totalBytes, 7); assert.equal(page.expiresAt, 100); assert.ok(page.nextCursor > cursor);
      reconstructed += page.text; cursor = page.nextCursor; pages++; if (page.eof) break; assert.ok(pages < 3);
    }
    assert.equal(reconstructed, text); assert.equal(pages, 2); assert.equal(createHash('sha256').update(reconstructed).digest('hex'), digest); assert.equal(f.calls.submit.length, 0);
  } finally { await f.close(); }
});

test('actual MCP observe projects signal delivery without converting a request into remote exit evidence', async () => {
  const f = await fixture(); try {
    f.pending.state = 'unknown';
    for (const [signalDelivery, expected] of [['requested', 'requested'], ['unsupported', 'unsupported'], ['claimed-terminated', null], [undefined, null]]) {
      f.pending.result = { failed: true, texts: [], execution: { phase: 'settled', reason: 'cancel', remoteState: 'unknown',
        exitCode: null, cleanupComplete: false, requiresReconciliation: true, automaticReplay: false, signalDelivery } };
      const result = await f.call('observe', { id: identifier });
      assert.equal(result.structuredContent.ok, true);
      const data = result.structuredContent.data;
      assert.equal(data.execution.signalDelivery, expected); assert.equal(data.state, 'unknown');
      assert.equal(data.execution.remoteState, 'unknown'); assert.equal(data.execution.cleanupComplete, false);
      assert.equal(data.execution.requiresReconciliation, true); assert.equal(data.execution.automaticReplay, false);
    }
    const descriptor = (await f.client.listTools()).tools.find(tool => tool.name === 'observe');
    assert.match(descriptor.description, /signalDelivery=requested.*not that remote termination was confirmed/);
  } finally { await f.close(); }
});

test('native submit keeps exact UTF-8 limits and refuses command overflow without dispatch', async () => {
  const f = await fixture(); try {
    const submit = (await f.client.listTools()).tools.find(t => t.name === 'submit'); assert.equal(submit.inputSchema.properties.command.maxLength, 32768); assert.equal(submit.inputSchema.properties.source.maxLength, 16384);
    const command = 'printf ' + 'x'.repeat(32768 - 7 - 8) + 'END_TAIL'; assert.equal(Buffer.byteLength(command), 32768);
    assert.equal((await f.call('submit', { kind: 'command', operationKey, command })).structuredContent.ok, true); assert.equal(f.calls.submit.at(-1).command, command);
    for (const value of [command + 'x', 'printf ' + '가'.repeat(11000), 'printf \ud800']) assert.equal((await f.call('submit', { kind: 'command', operationKey, command: value })).isError, true);
    assert.equal(f.calls.submit.length, 1);
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


test('health and MCP initialization report the actual package version', async () => {
 const f=await fixture();try{assert.equal((await (await fetch(f.mcpBase+'/health')).json()).version,metadata.version);assert.equal(f.client.getServerVersion().version,metadata.version);}finally{await f.close();}
});
