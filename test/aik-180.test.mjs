import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpAdapter } from '../src/adapters/mcp/server.mjs';
import { createAikSshTool } from '../src/adapters/aik/ssh-tool.mjs';

const id = 'a'.repeat(48), outputId = 'b'.repeat(48), revision = 'c'.repeat(64);
const call = { tool_call_id: 'aik-call-180', effect_id: 'aik-effect-180', arguments: { target: 'default', expectedTargetRevision: revision,
  command: "printf '한글'\r\n", context: '테스트 서버의 출력을 확인합니다.' } };
const digest = text => createHash('sha256').update(text).digest('hex');

async function fixture(options = {}) {
  const events = [], calls = [], receipts = [], bindings = new Map();
  const authorization = { status: 'authorized', binding_digest: 'PRIVATE_BINDING', authorization_revision: 1 };
  const text = '정제된 출력\n[REDACTED]';
  const expiry = Date.now() + 60000;
  const job = { id, kind: 'command', state: 'queued', targetId: 'default', targetRevision: revision, createdAt: Date.now(), expiresAt: expiry,
    result: { failed: false, texts: ['PRIVATE_STATUS_BODY'], output: { id: outputId, executionId: id, state: 'ready', expiresAt: expiry, bytes: Buffer.byteLength(text) } } };
  const operations = {
    async submit(input) { events.push('submit'); job.operationKey = input.operationKey; options.onSubmit?.(input); return job; },
    async observe(input) {
      events.push(input.includeOutput ? 'read-output' : 'observe');
      options.onObserve?.(input, job);
      const bytes = Buffer.from(text), end = Math.min(bytes.length, input.cursor + input.maxBytes);
      return { job, ...(input.includeOutput ? { outputPage: { text: bytes.subarray(input.cursor, end).toString('utf8'),
        cursor: input.cursor, nextCursor: end, bytes: end - input.cursor, totalBytes: bytes.length, sha256: digest(text), eof: end === bytes.length, expiresAt: expiry } } : {}) };
    },
  };
  const authority = {
    async authorize() { events.push('authorize'); return authorization; },
    async revalidate(value) { assert.equal(value, authorization); events.push('revalidate'); },
    async recordDispatch(value, key) { assert.equal(value, authorization); events.push('intent'); assert.match(key, /^aik:[a-f0-9]{64}$/); },
    async bindRequest(value, binding) { assert.equal(value, authorization); events.push('bind'); bindings.set(binding.requestId, value); },
    async lookupRequest(requestId) { return bindings.get(requestId); },
    async recordReceipt(value, receipt) { assert.equal(value, authorization); receipts.push(receipt); events.push('receipt'); },
    async revalidateObservation(value, observation) { assert.equal(value, authorization); events.push('observation-authority'); options.onObservation?.(observation); },
  };
  const server = createMcpAdapter({ operations, files: {}, queue: {}, capabilities: {}, uiHtml: '<html></html>',
    settings: { adminOrigin: 'https://owner.example', maxBytes: 65536 } })();
  const client = new Client({ name: 'aik-180-contract', version: '1.0.0' });
  const [consumer, provider] = InMemoryTransport.createLinkedPair();
  await server.connect(provider); await client.connect(consumer);
  const mcp = { async call(name, args) {
    calls.push({ name, args: structuredClone(args) });
    const reply = await client.callTool({ name, arguments: args });
    if (options.replyMode === 'text') return { content: reply.content };
    if (options.replyMode === 'envelope') return reply.structuredContent;
    return reply;
  } };
  return { adapter: createAikSshTool({ authority, mcp }), authority, mcp, calls, events, receipts, job, text,
    close: async () => { await client.close(); await server.close(); } };
}

test('AIK uses actual MCP 1.8 submit/observe calls with stable tracking and private authority', async () => {
  for (const replyMode of ['sdk', 'text', 'envelope']) {
    const f = await fixture({ replyMode });
    try {
      const result = await f.adapter.run(call);
      assert.equal(result.id, id); assert.equal(result.state, 'queued');
      assert.equal(f.calls[0].name, 'submit');
      assert.equal(f.calls[0].args.kind, 'command');
      assert.equal(f.calls[0].args.command, call.arguments.command);
      assert.equal(f.calls[0].args.context, call.arguments.context);
      assert.equal(f.calls[0].args.expectedTargetRevision, revision);
      assert.match(result.operationKey, /^aik:[a-f0-9]{64}$/);
      assert.equal(f.calls[0].args.operationKey, result.operationKey);
      assert.deepEqual(f.events.slice(0, 6), ['authorize', 'revalidate', 'intent', 'revalidate', 'submit', 'bind']);
      f.job.state = 'completed';
      const status = await f.adapter.status(id);
      assert.equal(status.outputPage, null);
      assert.doesNotMatch(JSON.stringify(status), /PRIVATE_STATUS_BODY/);
      assert.equal(f.receipts.at(-1).status, 'succeeded');
      const page = await f.adapter.output(id);
      assert.equal(page.text, f.text);
      assert.equal(page.sha256, digest(f.text));
      assert.deepEqual(f.calls.map(value => value.name), ['submit', 'observe', 'observe', 'observe']);
      assert.deepEqual(f.calls.slice(1).map(value => value.args.includeOutput), [false, false, true]);
      assert.doesNotMatch(JSON.stringify(f.calls), /PRIVATE_BINDING|binding_digest|authorization_revision|session/);
      assert.equal(f.events.filter(value => value === 'observation-authority').length, 3);
      const before = f.calls.length;
      await assert.rejects(f.adapter.output('d'.repeat(48)), /Original AIK binding/);
      await assert.rejects(f.adapter.output(id, { format: 'json' }), /text pages only/);
      assert.equal(f.calls.length, before);
    } finally { await f.close(); }
  }
});

test('AIK rejects authority revoked during explicit MCP output read before returning bytes', async () => {
  let revoked = false;
  const f = await fixture({ onObserve: input => { if (input.includeOutput) revoked = true; },
    onObservation: () => { if (revoked) throw Error('observation revoked'); } });
  try {
    await f.adapter.run(call); f.job.state = 'completed';
    await assert.rejects(f.adapter.output(id), /observation revoked/);
    assert.deepEqual(f.calls.map(value => value.name), ['submit', 'observe', 'observe']);
    assert.equal(f.calls.at(-1).args.includeOutput, true);
  } finally { await f.close(); }
});

test('AIK keeps audit failure distinct and never turns it into a success receipt', async () => {
  const f = await fixture();
  try {
    await f.adapter.run(call); f.job.state = 'completed'; f.job.auditError = 'PRIVATE_AUDIT';
    const status = await f.adapter.status(id);
    assert.equal(status.state, 'completed'); assert.equal(status.failed, false); assert.equal(status.auditFailure, true);
    assert.equal(f.receipts.at(-1).status, 'unknown');
    assert.doesNotMatch(JSON.stringify(status), /PRIVATE_AUDIT/);
  } finally { await f.close(); }
});

test('AIK preserves supervisor reconciliation evidence after a deadline', async () => {
  const f = await fixture();
  try {
    await f.adapter.run(call); f.job.state = 'failed'; f.job.result.failed = true;
    f.job.result.execution = { phase: 'settled', reason: 'deadline', remoteState: 'unknown', timeoutMs: 120000,
      automaticReplay: false, cleanupComplete: false, requiresReconciliation: true };
    const status = await f.adapter.status(id);
    assert.equal(status.state, 'failed'); assert.equal(status.execution.reason, 'deadline');
    assert.equal(status.execution.remoteState, 'unknown'); assert.equal(f.receipts.at(-1).status, 'unknown');
  } finally { await f.close(); }
});

test('AIK preserves uncertain dispatch without replay and refuses legacy or mismatched envelopes', async () => {
  const f = await fixture();
  try {
    const original = f.mcp.call;
    f.mcp.call = async (...args) => { await original(...args); throw Error('lost response'); };
    await assert.rejects(f.adapter.run(call), /outcome unknown/);
    assert.equal(f.calls.length, 1); assert.equal(f.receipts.at(-1).status, 'unknown');
    f.mcp.call = async () => ({ id, state: 'completed' });
    await assert.rejects(f.adapter.run(call), /outcome unknown/);
    f.mcp.call = async (...args) => {
      const reply = await original(...args);
      return { ...reply, content: [{ type: 'text', text: JSON.stringify({ ...reply.structuredContent, contractVersion: '1.7' }) }] };
    };
    await assert.rejects(f.adapter.run(call), /outcome unknown/);
    assert.equal(f.receipts.at(-1).status, 'unknown');
  } finally { await f.close(); }
});

test('AIK preserves a confirmed admission refusal without replay', async () => {
  const f = await fixture({ onSubmit: () => { throw Object.assign(Error('private detail'), { code: 'TARGET_REVISION_CONFLICT', executionAttempted: false }); } });
  try {
    await assert.rejects(f.adapter.run(call), error => error.code === 'TARGET_REVISION_CONFLICT' && !error.message.includes('private detail'));
    assert.equal(f.calls.length, 1); assert.equal(f.receipts.at(-1).status, 'failed');
  } finally { await f.close(); }
});
