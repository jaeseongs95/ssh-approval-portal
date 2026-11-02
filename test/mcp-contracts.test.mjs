import metadata from '../package.json' with { type: 'json' };
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createProtocolAdapters } from '../src/adapters/http/protocol.mjs';
import { Tickets } from '../src/adapters/security/tickets.mjs';
import { authorizeAdminRequest } from '../src/adapters/security/admin-policy.mjs';
import { CommandOutputs } from '../src/adapters/storage/command-output.mjs';
import { clientSetupOutputSchema } from '../src/adapters/mcp/client-setup.mjs';

const identifier = 'a'.repeat(48);

test('actual MCP HTTP preserves 5 KiB and 32 KiB commands with path-only context in both input forms', async () => {
  const f = await fixture(), seen = [];
  f.commands.run = async (...args) => { seen.push(args); return { type: 'job', job: f.pending }; };
  try {
    for (const size of [5025, 32768]) {
      const command = 'printf ' + 'x'.repeat(size - 7);
      assert.equal(Buffer.byteLength(command), size);
      const input = { command, context: 'Check metadata for .env, /etc/shadow, /home/operator/.ssh/id_ed25519 and /secrets/service; no file contents supplied.', displayContext: '.env 및 /etc/shadow, /home/operator/.ssh/id_ed25519, /secrets/service 경로의 메타데이터만 확인합니다.' };
      for (const args of [input, { command: 'ssh-request-v1:' + JSON.stringify(input) }]) {
        const result = await f.call('run-command', args);
        assert.equal(result.isError, undefined, JSON.stringify(result));
        assert.deepEqual(seen.at(-1), [command, undefined, undefined, input.context, input.displayContext]);
      }
    }
    assert.equal(seen.length, 4);
  } finally { await f.close(); }
});

test('actual MCP HTTP refuses secret or invalid descriptions with safe context codes and no dispatch', async () => {
  const f = await fixture(); let calls = 0;
  f.commands.run = async () => { calls++; return { type: 'job', job: f.pending }; };
  try {
    const cases = [
      ['password=synthetic-private-marker', 'COMMAND_CONTEXT_CONTAINS_SECRET'],
      ['Bearer synthetic-private-marker', 'COMMAND_CONTEXT_CONTAINS_SECRET'],
      ['-----BEGIN PRIVATE KEY-----\nsynthetic-private-marker', 'COMMAND_CONTEXT_CONTAINS_SECRET'],
      ['a'.repeat(8193), 'COMMAND_CONTEXT_TOO_LARGE'],
      ['synthetic-private-marker\0invalid', 'INVALID_COMMAND_CONTEXT'],
    ];
    for (const field of ['context', 'displayContext']) {
      for (const [value, code] of cases) {
        const input = { command: 'printf fixture', context: 'Fixture metadata inspection', [field]: value };
        for (const args of [input, { command: 'ssh-request-v1:' + JSON.stringify(input) }]) {
          const result = await f.call('run-command', args);
          assert.equal(result.isError, true);
          // Top-level oversize fields are rejected by the published JSON schema;
          // envelopes reach callerContext and therefore carry its safe error code.
          if (value.length <= 8192 || args !== input) assert.ok(result.content.some(item => item.type === 'text' && item.text.includes(code)), JSON.stringify(result));
          assert.equal(JSON.stringify(result).includes(value), false);
          assert.doesNotMatch(JSON.stringify(result), /synthetic-private-marker/);
        }
      }
    }
    assert.equal(calls, 0);
    f.commands.run = async () => { throw Error('untrusted-error synthetic-private-marker COMMAND_CONTEXT_CONTAINS_SECRET'); };
    const unknown = await f.call('run-command', { command: 'printf fixture' });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /Request refused or failed/);
    assert.doesNotMatch(JSON.stringify(unknown), /synthetic-private-marker|COMMAND_CONTEXT_CONTAINS_SECRET/);
  } finally { await f.close(); }
});
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
    assert.deepEqual(tools.map(tool => tool.name), ['get-client-capabilities', 'get-client-setup', 'list-targets', 'read-command', 'run-command', 'run-python-source', 'request-safe-command', 'get-request-status', 'wait-for-request', 'assess-request-risk', 'request-upload', 'show-ui-probe', 'show-approval', 'show-file-transfer', 'request-download', 'ui-decide-request', 'ui-upload-begin', 'ui-upload-chunk', 'ui-upload-finish', 'ui-download-link', 'read-command-output', 'ui-read-command-output']);
    for (const tool of tools) assert.equal(tool.outputSchema.type, 'object', tool.name);
    const upload = tools.find(tool => tool.name === 'request-upload');
    assert.deepEqual(upload._meta['openai/fileParams'], ['file']); assert.match(upload.description, /only that host contract/);
    assert.deepEqual(Object.keys(upload.inputSchema.properties).sort(), ['elevate', 'file', 'overwrite', 'remotePath', 'target']);
    assert.deepEqual(upload.inputSchema.required, ['file', 'remotePath']);
    assert.deepEqual(Object.keys(upload.inputSchema.properties.file.properties).sort(), ['download_url', 'file_id', 'file_name', 'mime_type']);
    assert.deepEqual(upload.inputSchema.properties.file.required, ['download_url', 'file_id']);
    assert.equal(upload.inputSchema.properties.file.additionalProperties, false);
    for (const descriptor of [upload, tools.find(tool => tool.name === 'request-download')]) {
      assert.match(descriptor.description, /scripts\/portal-client\.mjs/);
      assert.match(descriptor.description, /(?:scripts\/portal-file-mcp\.mjs|stdio)/);
      assert.match(descriptor.description, /get-client-capabilities/);
    }
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

test('provider-neutral capabilities are exact, public and read-only; core tools work with UI disabled', async () => {
  for (const enabled of [true, false]) {
    let outputReads = 0, commandRuns = 0;
    const adminOrigin = enabled ? settings.adminOrigin : 'https://owner-without-apps.example.test';
    const page = { outputId: identifier, bytes: 7, nextOffset: 7, eof: true, text: 'fixture' };
    const f = await fixture({ settings: { ...settings, adminOrigin, uiEnabled: enabled }, commandOutputs: { read: () => { outputReads++; return page; } } });
    f.commands.run = async () => { commandRuns++; return { type: 'job', job: f.pending }; };
    try {
      const tools = (await f.client.listTools()).tools;
      const descriptor = tools.find(tool => tool.name === 'get-client-capabilities');
      assert.equal(descriptor.annotations.readOnlyHint, true);
      assert.equal(descriptor.annotations.destructiveHint, false);
      assert.equal(descriptor._meta, undefined);
      assert.deepEqual(descriptor.inputSchema.properties, {});
      const expected = {
        contract: 'agent-client-capabilities-v1',
        core: { transport: 'streamable-http', input: 'json-schema', output: ['text', 'structuredContent'], uiRequired: false },
        localFiles: { cli: 'scripts/portal-client.mjs', stdio: 'scripts/portal-file-mcp.mjs', requiresLocalAccess: true },
        hostFileInput: { tool: 'request-upload', contract: 'openai/fileParams' },
        approvals: { ownerRequiredByPolicy: true, agentSelfApproval: false, adminUrl: adminOrigin },
        ui: { enabled, optional: true },
        setup: { tool: 'get-client-setup' },
        documentation: 'docs/agent-clients.ko.md',
      };
      const result = await f.call('get-client-capabilities');
      assert.deepEqual(result, { content: [{ type: 'text', text: JSON.stringify(expected) }], structuredContent: expected });
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      assert.doesNotMatch(JSON.stringify(result), /contract-mcp|contract-admin|approvalTicket|downloadUrl|PRIVATE/);
      assert.equal(commandRuns, 0); assert.equal(outputReads, 0); assert.equal(f.calls.imports.length, 0);
      const instructions = f.client.getInstructions();
      assert.match(instructions, /independent of model vendor/);
      assert.match(instructions, /get-client-capabilities/);
      assert.match(instructions, /never self-approve/);
      assert.match(instructions, /scripts\/portal-client\.mjs/);
      assert.match(instructions, /scripts\/portal-file-mcp\.mjs/);
      assert.match(instructions, /openai\/fileParams/);
      assert.equal((await f.call('list-targets')).structuredContent.defaultTarget, 'default');
      assert.equal((await f.call('read-command', { command: 'id' })).structuredContent.state, 'completed');
      assert.equal((await f.call('run-command', { command: 'sudo id' })).structuredContent.id, identifier);
      assert.equal((await f.call('get-request-status', { id: identifier })).structuredContent.state, 'pending');
      const output = await f.call('read-command-output', { outputId: identifier });
      const { text: body, ...metadata } = page;
      assert.deepEqual(output.content, [{ type: 'text', text: body }, { type: 'text', text: JSON.stringify({ type: 'output-page-metadata', ...metadata }) }]);
      assert.deepEqual(output.structuredContent, page);
      assert.equal(commandRuns, 1); assert.equal(outputReads, 1);
      if (!enabled) {
        const unavailable = await f.call('request-upload', {
          file: { download_url: 'https://files.example.test/private?signature=PRIVATE-FILE-SIGNATURE', file_id: 'PRIVATE-FILE-ID' },
          remotePath: '/tmp/input.bin',
        });
        assert.equal(unavailable.isError, true);
        assert.equal(unavailable.structuredContent.error, 'upload-source-not-configured');
        assert.match(unavailable.structuredContent.message, /get-client-capabilities/);
        assert.match(unavailable.structuredContent.message, /local CLI or stdio/);
        assert.match(unavailable.structuredContent.message, /only when supported and enabled/);
        assert.doesNotMatch(JSON.stringify(unavailable), /PRIVATE-FILE-|download_url|signature=|file_id/);
      }
    } finally { await f.close(); }
  }
});

test('client setup chooses routes from reported abilities, never from product names or server UI, without execution', async () => {
  const cases = [
    [{}, 'unavailable'],
    [{ client: {} }, 'unavailable'],
    [{ client: { localProcess: false, localStdio: false, hostFileInput: false, ui: false } }, 'unavailable'],
    [{ client: { localProcess: true } }, 'local-cli'],
    [{ client: { localStdio: true } }, 'local-stdio'],
    [{ client: { hostFileInput: true } }, 'host-file-input'],
    [{ client: { ui: true } }, 'owner-ui'],
    [{ client: { localProcess: true, localStdio: true, hostFileInput: true, ui: true } }, 'local-cli'],
    [{ client: { localStdio: true, hostFileInput: true, ui: true } }, 'local-stdio'],
    [{ client: { hostFileInput: true, ui: true } }, 'host-file-input'],
  ];
  for (const enabled of [false, true]) {
    const adminOrigin = enabled ? 'https://enabled-admin.example.test' : 'https://no-cards.example.test';
    const forbidden = () => assert.fail('setup must not execute commands, access files, approve or create tickets');
    const f = await fixture({ settings: { ...settings, uiEnabled: enabled, adminOrigin },
      queue: { get: forbidden, submit: forbidden, start: forbidden, deny: forbidden },
      files: { requestUpload: forbidden, requestDownload: forbidden },
      signer: { issue: forbidden }, commandOutputs: { read: forbidden }, bindFileSource: forbidden });
    f.commands.read = f.commands.run = forbidden;
    try {
      const descriptor = (await f.client.listTools()).tools.find(tool => tool.name === 'get-client-setup');
      assert.equal(descriptor.annotations.readOnlyHint, true);
      assert.equal(descriptor.annotations.destructiveHint, false);
      assert.equal(descriptor._meta, undefined);
      assert.equal(descriptor.inputSchema.additionalProperties, false);
      assert.equal(descriptor.inputSchema.properties.client.additionalProperties, false);
      assert.deepEqual(Object.keys(descriptor.inputSchema.properties.client.properties).sort(), ['hostFileInput', 'localProcess', 'localStdio', 'ui']);
      assert.equal(descriptor.outputSchema.type, 'object');
      assert.equal(descriptor.outputSchema.additionalProperties, false);
      assert.deepEqual(descriptor.outputSchema.properties.recommendedRoute.enum, ['local-cli', 'local-stdio', 'host-file-input', 'owner-ui', 'unavailable']);
      assert.equal(descriptor.outputSchema.properties.local.properties.doctor.properties.argv.maxItems, 4);
      assert.equal(descriptor.outputSchema.properties.local.properties.prerequisites.maxItems, 5);
      for (const [input, route] of cases) {
        const response = await f.call('get-client-setup', input);
        assert.equal(response.isError, undefined, JSON.stringify(response));
        const result = response.structuredContent;
        assert.deepEqual(clientSetupOutputSchema.parse(result), result);
        assert.deepEqual(Object.keys(result).sort(), Object.keys(descriptor.outputSchema.properties).sort());
        assert.deepEqual([...descriptor.outputSchema.required].sort(), Object.keys(result).sort());
        // A text-only host can discard structuredContent and still receive the complete setup.
        assert.deepEqual(JSON.parse(response.content[0].text), result);
        assert.equal(result.contract, 'agent-client-setup-v1');
        assert.deepEqual(result.client, { localProcess: false, localStdio: false, hostFileInput: false, ui: false, ...input.client });
        assert.equal(result.recommendedRoute, route);
        assert.equal(result.localReadiness, 'requires-local-check');
        assert.deepEqual(result.serverUi, { enabled, clientRenderingVerified: false });
        assert.deepEqual(result.local.doctor, { executable: 'node', argv: ['scripts/portal-client.mjs', '--origin', adminOrigin, 'doctor'],
          optionalArgs: ['--cloudflared', '<existing absolute executable>'], cwd: '<trusted package root>' });
        assert.deepEqual(result.local.cloudflared.precedence, ['--cloudflared', 'PORTAL_CLOUDFLARED', 'PATH']);
        assert.match(result.local.cloudflared.guidance, /portable installation outside PATH needs an explicit/);
        assert.match(result.local.cloudflared.guidance, /PATH miss does not prove cloudflared is uninstalled/);
        assert.equal(result.core.uiRequired, false);
        assert.deepEqual(result.core.tools, ['list-targets', 'run-command', 'run-python-source', 'get-request-status', 'wait-for-request', 'read-command-output']);
        assert.match(result.core.guidance, /SAME ID/);
        assert.equal(result.approvals.adminUrl, adminOrigin);
        assert.equal(result.approvals.ownerRequiredByPolicy, true);
        assert.equal(result.approvals.agentSelfApproval, false);
        assert.match(result.approvals.guidance, /no approval link or token/);
        assert.match(result.limitations.join(' '), /cannot inspect client package installation/);
        assert.match(result.limitations.join(' '), /Never place file bytes in shell commands/);
        assert.doesNotMatch(JSON.stringify(response), /contract-mcp|contract-admin|approvalTicket|bootstrapTicket|downloadUrl|PRIVATE/);
        assert.equal(response._meta, undefined);
      }
      assert.equal(f.calls.imports.length, 0);
      assert.equal(f.calls.append.length, 0);
    } finally { await f.close(); }
  }
});

test('client setup rejects unknown keys, nonboolean abilities and malformed client objects', async () => {
  const f = await fixture();
  try {
    for (const input of [
      { client: { localProcess: true, vendor: 'assumed-capability' } },
      { client: { localProcess: 'true' } },
      { client: { localStdio: 1 } },
      { client: { hostFileInput: null } },
      { client: { ui: [] } },
      { client: null }, { client: [] }, { client: 'local-cli' },
      { client: {}, autoApprove: true },
      { client: { extra: Array(65).fill('not-a-capability') } },
    ]) {
      const response = await f.call('get-client-setup', input);
      assert.equal(response.isError, true, JSON.stringify(input));
      assert.equal(response.structuredContent, undefined);
    }
    assert.equal((await f.call('get-client-setup')).structuredContent.recommendedRoute, 'unavailable');
    assert.equal(f.calls.imports.length, 0);
  } finally { await f.close(); }
});

test('file transfer text points card-less clients to setup and local capabilities with matching output schema', async () => {
  for (const enabled of [false, true]) {
    const f = await fixture({ settings: { ...settings, uiEnabled: enabled } });
    try {
      const descriptor = (await f.client.listTools()).tools.find(tool => tool.name === 'show-file-transfer');
      assert.ok(descriptor.outputSchema.required.includes('setup'));
      assert.equal(descriptor.outputSchema.properties.setup.properties.tool.const, 'get-client-setup');
      const response = await f.call('show-file-transfer', { direction: 'upload', remotePath: '/tmp/input.bin' });
      const textOnly = JSON.parse(response.content[0].text);
      assert.deepEqual(textOnly, response.structuredContent);
      assert.equal(textOnly.setup.tool, 'get-client-setup');
      assert.match(textOnly.setup.guidance, /First check.*local process access.*local CLI.*local stdio MCP/);
      assert.match(textOnly.setup.guidance, /not evidence of actual client rendering/);
      assert.match(textOnly.setup.guidance, /Core requests, status, output and approval waiting need no card/);
      assert.equal(textOnly.uiEnabled, enabled);
      assert.doesNotMatch(response.content[0].text, /bootstrapTicket|contract-mcp|contract-admin/);
    } finally { await f.close(); }
  }
});

test('text-only MCP consumers recover UTF-8 pages, completion, hash and expiry without structuredContent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-text-output-'));
  let now = 1000, commandExecutions = 0, f;
  const outputs = new CommandOutputs(root, { now: () => now });
  try {
    const text = 'a가나', executionId = 'b'.repeat(48);
    const reserved = outputs.reserve({ executionId, targetId: null });
    const reference = outputs.finish(reserved, { failed: false, texts: [text] }).output;
    f = await fixture({ settings: { ...settings, uiEnabled: false }, commandOutputs: {
      read: args => outputs.read(args, binding => assert.deepEqual(binding, { executionId, targetId: null })),
    } });
    f.commands.read = f.commands.run = async () => { commandExecutions++; throw Error('Output reads must not execute commands'); };
    let offsetBytes = 0, reconstructed = '';
    const pages = [];
    do {
      const response = await f.call('read-command-output', { outputId: reference.id, offsetBytes, maxBytes: 5 });
      assert.equal(response.isError, undefined);
      // Simulate a host that exposes only standard text content, discarding all other fields.
      const content = response.content.filter(item => item.type === 'text').map(item => item.text);
      assert.equal(content.length, 2);
      const metadata = JSON.parse(content[1]);
      assert.equal(metadata.type, 'output-page-metadata');
      assert.equal(metadata.outputId, reference.id);
      assert.equal(metadata.executionId, executionId);
      assert.equal(metadata.format, 'text');
      assert.equal(metadata.offsetBytes, offsetBytes);
      assert.equal(metadata.bytes, Buffer.byteLength(content[0]));
      assert.equal(metadata.nextOffset, offsetBytes + metadata.bytes);
      assert.equal(metadata.totalBytes, Buffer.byteLength(text));
      assert.equal(metadata.expiresAt, reference.expiresAt);
      assert.equal(metadata.expiresAt > now, true);
      assert.equal(metadata.eof, metadata.nextOffset === metadata.totalBytes);
      assert.equal(Object.hasOwn(metadata, 'text'), false);
      reconstructed += content[0]; pages.push(metadata); offsetBytes = metadata.nextOffset;
      assert.ok(pages.length <= 2, 'text-only pagination must advance and terminate');
    } while (!pages.at(-1).eof);
    assert.equal(reconstructed, text);
    assert.deepEqual(pages.map(page => [page.bytes, page.nextOffset, page.eof]), [[4, 4, false], [3, 7, true]]);
    for (const page of pages) assert.equal(page.sha256, createHash('sha256').update(reconstructed).digest('hex'));
    now = reference.expiresAt;
    const expired = await f.call('read-command-output', { outputId: reference.id });
    assert.equal(expired.isError, true);
    assert.ok(expired.content.some(item => item.type === 'text'));
    assert.equal(commandExecutions, 0);
  } finally {
    await f?.close(); outputs.close(); await rm(root, { recursive: true, force: true });
  }
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

test('health and MCP initialization report the actual package version', async () => {
 const f=await fixture();try{assert.equal((await (await fetch(f.mcpBase+'/health')).json()).version,metadata.version);assert.equal(f.client.getServerVersion().version,metadata.version);}finally{await f.close();}
});

test('MCP keeps English evaluator context separate from the Korean owner explanation, including command-only hosts', async () => {
  const seen = [], f = await fixture();
  f.commands.run = async (...args) => { seen.push(args); return { type: 'job', job: f.pending }; };
  const input = { command: 'sudo id', context: 'Inspect identity on the test host; no mutation or restart.', displayContext: '테스트 서버의 실행 계정을 조회합니다. 변경·재시작은 없습니다.', requestKey: 'synthetic-language-pair-1' };
  try {
    const listed = (await f.client.listTools()).tools.find(t => t.name === 'run-command');
    assert.equal(listed.inputSchema.properties.displayContext.maxLength, 8192);
    assert.match(listed.description, /context in English/); assert.match(listed.description, /never sent to the evaluator/);
    assert.equal((await f.call('run-command', input)).isError, undefined);
    assert.deepEqual(seen[0], [input.command, undefined, input.requestKey, input.context, input.displayContext]);
    assert.equal((await f.call('run-command', { command: 'ssh-request-v1:' + JSON.stringify(input) })).isError, undefined);
    assert.deepEqual(seen[1], seen[0]);
    for (const bad of [
      { ...input, displayContext: 'a'.repeat(8193) },
      { ...input, displayContext: 'password=synthetic-only' },
      { ...input, displayContext: false },
      { command: 'ssh-request-v1:' + JSON.stringify(input), displayContext: '' },
      { command: 'ssh-request-v1:' + JSON.stringify({ ...input, displayContext: 0 }) },
    ]) assert.equal((await f.call('run-command', bad)).isError, true);
    assert.equal(seen.length, 2);
  } finally { await f.close(); }
});

test('LIMIT-MCP actual HTTP schema and dispatch retain long command/envelope and refuse overflow',async()=>{
 const f=await fixture(),seen=[];f.commands.run=async(command,_target,_key,context)=>{seen.push({command,context});return{type:'job',job:f.pending};};
 try{
  const tools=(await f.client.listTools()).tools;
  assert.equal(tools.find(t=>t.name==='read-command').inputSchema.properties.command.maxLength,32768);
  assert.equal(tools.find(t=>t.name==='run-command').inputSchema.properties.command.maxLength,524288);
  const command='printf '+'x'.repeat(32768-7-8)+'END_TAIL';
  assert.equal(Buffer.byteLength(command),32768);
  assert.equal((await f.call('run-command',{command})).isError,undefined);assert.equal(seen.at(-1).command,command);
  const context='Synthetic purpose '.repeat(300),wire='ssh-request-v1:'+JSON.stringify({command,context});
  assert.equal((await f.call('run-command',{command:wire})).isError,undefined);assert.deepEqual(seen.at(-1),{command,context});
  for(const value of [command+'x','printf '+'가'.repeat(11000),'printf \ud800'])assert.equal((await f.call('run-command',{command:value})).isError,true);
  assert.equal(seen.length,2);
 }finally{await f.close();}
});
