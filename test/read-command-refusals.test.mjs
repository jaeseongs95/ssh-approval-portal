import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { classifyCommand } from 'ssh-mcp/build/policy/classifier.js';
import { createApplication } from '../app.mjs';

// 1.7 source retained in legacy-17/read-command-refusals.test.mjs.17.
// READ-REFUSAL-01..07 map to the unified submit/observe admission, execution,
// privacy and no-replay cases below. Removed: read-only tool refusal messages,
// separate claimExecution resource path, empty queue after reads and sync busy refusal.
// 1.8 reads share durable operations and may queue; no fabricated legacy callback.
const outcome = { failed: false, texts: ['합성 출력'] };
const terminalStates = new Set(['completed', 'failed', 'cancelled', 'denied', 'expired', 'unknown']);
async function completed(f, id) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const reply = await f.observe({ id, waitMs: 1000 });
    assert.equal(reply.isError, undefined);
    const value = reply.structuredContent.data;
    if (terminalStates.has(value.state)) return value;
    assert.ok(Date.now() < deadline, 'operation must settle');
  }
}
function safeRefusal(reply) {
  assert.equal(reply.isError, true); assert.equal(reply.structuredContent.ok, false);
  assert.match(reply.structuredContent.error.code, /^[A-Z][A-Z0-9_]+$/);
  assert.doesNotMatch(JSON.stringify(reply), /PRIVATE_(?:COMMAND|EXCEPTION|CAUSE|DETAILS|AUDIT)_CANARY/);
}

async function mcpFixture(t, { classify = classifyCommand, executeCommand = async () => outcome, audit = () => {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'read-command-refusals-'));
  const executions = [], profiles = new Map();
  const app = await createApplication({ transferRoot: root, uiHtml: '<html></html>', classify,
    env: { BRIDGE_MCP_TOKEN: 'read-fixture', BRIDGE_ADMIN_TOKEN: 'owner-fixture', BRIDGE_UI_TICKET_KEY: 'a'.repeat(64), BRIDGE_ADMIN_ORIGIN: 'https://owner.test' },
    registry: { getProfile: name => { if (!profiles.has(name)) profiles.set(name, { host: '127.0.0.1', port: 22, user: 'fixture', readOnly: name === 'aws-readonly' }); return profiles.get(name); }, closeAll: async () => {} },
    executeCommand: (...args) => { executions.push(args); return executeCommand(...args); }, audit });
  const client = new Client({ name: 'read-refusal-fixture', version: '1' });
  t.after(async () => { await client.close(); await app.close(); await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => app.mcpHttp.listen(0, '127.0.0.1', resolve));
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + app.mcpHttp.address().port + '/mcp'),
    { requestInit: { headers: { Authorization: 'Bearer read-fixture', Connection: 'close' } } }));
  const tools = (await client.listTools()).tools;
  const tool = tools.find(item => item.name === 'submit');
  assert.ok(tool?.outputSchema, '실제 표준 클라이언트의 출력 스키마 캐시를 먼저 채웁니다');
  let sequence = 0;
  return { app, executions, tool, call: (command = 'cat /tmp/PRIVATE_COMMAND_CANARY', changes = {}) => client.callTool({ name: 'submit', arguments: { kind: 'command', operationKey: 'read-migration-' + String(++sequence).padStart(8, '0'), command, ...changes } }), observe: args => client.callTool({ name: 'observe', arguments: args }) };
}


test('READ-REFUSAL-01 unified command admission keeps non-read commands pending without self-approval', async t => {
  const f = await mcpFixture(t);
  for (const command of ['stat /tmp/PRIVATE_COMMAND_CANARY;sha256sum /tmp/PRIVATE_COMMAND_CANARY;free -m;ps -ef', 'sha256sum /tmp/PRIVATE_COMMAND_CANARY', 'rm /tmp/PRIVATE_COMMAND_CANARY', 'rm -rf /', 'sudo id']) {
    const reply = await f.call(command); assert.equal(reply.isError, undefined);
    assert.equal(reply.structuredContent.data.state, 'pending'); assert.equal(reply.structuredContent.data.approvalMode, null);
  }
  await f.app.targets.drain(); assert.equal(f.executions.length, 0); assert.equal(f.app.queue.listAll().length, 5);
});

test('READ-REFUSAL-02 maintenance refuses before execution and leaves admission usable after release', async t => {
  const f = await mcpFixture(t);
  f.app.queue.reserveMaintenance(); safeRefusal(await f.call());
  assert.equal(f.executions.length, 0); assert.equal(f.app.queue.listAll().length, 0);
  f.app.queue.releaseMaintenance(); const reply = await f.call('id');
  assert.equal((await completed(f, reply.structuredContent.data.id)).state, 'completed'); assert.equal(f.executions.length, 1);
});

test('READ-REFUSAL-03 admission audit failure is private and never starts an operation', async t => {
  const f = await mcpFixture(t, { audit: event => { if (event.action === 'submitted') throw Error('PRIVATE_AUDIT_CANARY'); } });
  safeRefusal(await f.call()); await f.app.targets.drain();
  assert.equal(f.executions.length, 0); assert.equal(f.app.queue.listAll().length, 0);
});

test('READ-REFUSAL-04 malformed commands, target and classifier errors never expose private exception details', async t => {
  let broken = false;
  const f = await mcpFixture(t, { classify: command => { if (broken) throw Error('PRIVATE_EXCEPTION_CANARY'); return classifyCommand(command); } });
  safeRefusal(await f.call('cat /tmp/x\0')); safeRefusal(await f.call(undefined, { target: 'not-registered' }));
  broken = true; safeRefusal(await f.call());
  assert.equal(f.executions.length, 0); assert.equal(f.app.queue.listAll().length, 0);
});

test('READ-REFUSAL-05 completed and neutral command failure expose references and explicit bounded output only', async t => {
  let failed = false;
  const f = await mcpFixture(t, { executeCommand: async () => ({ failed, texts: ['합성 출력'] }) });
  for (const expected of ['completed', 'failed']) {
    const submitted = await f.call('id'); const result = await completed(f, submitted.structuredContent.data.id);
    assert.equal(result.state, expected); assert.equal(result.failed, failed); assert.equal(result.output.state, 'ready');
    assert.equal(JSON.stringify(result).includes('합성 출력'), false);
    const read = await f.observe({ id: result.id, includeOutput: true, maxBytes: 64 });
    assert.equal(read.structuredContent.data.outputPage.text, '합성 출력'); failed = true;
  }
  assert.equal(f.executions.length, 2);
});

test('READ-REFUSAL-06 failed start guard releases execution capacity and a later operation can complete', async t => {
  let broken = true;
  const f = await mcpFixture(t, { audit: event => { if (broken && event.action === 'policy-execution-started') throw Error('PRIVATE_AUDIT_CANARY'); } });
  const first = await f.call('id'); const refused = await completed(f, first.structuredContent.data.id);
  assert.equal(refused.state, 'failed'); assert.equal(f.executions.length, 0);
  broken = false; const next = await f.call('id'); assert.equal((await completed(f, next.structuredContent.data.id)).state, 'completed');
  assert.equal(f.executions.length, 1);
});

test('READ-REFUSAL-07 uncertain executor outcome is observed by the same key without replay', async t => {
  const f = await mcpFixture(t, { executeCommand: async () => { throw Error('PRIVATE_EXCEPTION_CANARY'); } });
  const input = { operationKey: 'read-unknown-stable-0001' };
  const first = await f.call('id', input); const result = await completed(f, first.structuredContent.data.id);
  assert.equal(result.state, 'unknown'); assert.equal(f.executions.length, 1);
  const again = await f.call('id', input); assert.equal(again.structuredContent.data.id, result.id);
  assert.equal((await f.observe({ operationKey: input.operationKey })).structuredContent.data.state, 'unknown');
  assert.equal(f.executions.length, 1); assert.doesNotMatch(JSON.stringify([again, result]), /PRIVATE_EXCEPTION_CANARY/);
});
