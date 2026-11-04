import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPublicTools, publicInputSchemas, publicOutputSchemas } from '../src/adapters/mcp/public-contract.mjs';
import { transportDesktopState } from '../src/domain/desktop-state.mjs';

const sessionId = '20000000-0000-4000-8000-000000000001', revision = 'a'.repeat(64);
const issuedKey = 'a'.repeat(32) + '_1100_' + 'b'.repeat(32) + '_' + 'c'.repeat(43);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const session = { sessionId, epoch: 1, targetId: 'linux', targetRevision: revision, expiresAt: 200, idleExpiresAt: 150,
  kind: 'desktop', readiness: { ...transportDesktopState(100), sessionRef: 'linux:display-17', resourceGeneration: 'b'.repeat(64) },
  lifecycle: 'managed', capabilities: { observe: true, pointer: true, key: true, text: true }, nextInputSequence: 2,
  lastInputReceipt: { sessionId, sequence: 1, requestKey: 'prior-input', state: 'sent' } };
function fixture(desktop) {
  const tools = new Map();
  registerPublicTools({ registerTool(name, options, handler) { tools.set(name, { options, handler }); } }, {
    desktop, settings: { adminOrigin: 'https://owner.example.test', maxBytes: 64 },
    targets: { list: () => ({ defaultTarget: 'linux', targets: [{ id: 'linux', revision, displayName: 'Linux', enabled: true,
      isDefault: true, platform: 'linux', capabilities: { desktop: true } }] }) },
  });
  return tools;
}

test('GUI-CONTRACT agents receive actual image content without an owner UI card', async () => {
  const tools = fixture({ observe: async () => ({ ...session, frameId: sessionId + ':1', width: 1, height: 1,
    geometryRevision: 1, coordinateSpace: 'physical-pixels', mimeType: 'image/png', data: png }) });
  const tool = tools.get('desktop-observe');
  assert.equal(tool.options._meta, undefined);
  const reply = await tool.handler({ sessionId, epoch: 1 });
  assert.equal(reply.structuredContent.ok, true);
  assert.equal(reply.structuredContent.data.imageContentIndex, 1);
  assert.deepEqual(reply.content[1], { type: 'image', mimeType: 'image/png', data: png });
  assert.equal(reply.structuredContent.data.readiness.sessionRef, 'linux:display-17');
  assert.equal(reply.structuredContent.data.lastInputReceipt.requestKey, 'prior-input');
  assert.doesNotMatch(reply.content[0].text, /ownerId|iVBOR/);
  assert.equal(tools.has('desktop-authenticate'), false);
});

test('GUI-CONTRACT discovery advertises server configuration without opening a desktop', async () => {
  let opens = 0, capabilityInput;
  const descriptor = { configured: true, backend: 'xvnc', lifecycle: 'managed', status: 'configured',
    reason: null, actions: ['observe', 'pointer', 'key', 'text'], requiresUserClient: false, openRequest: { requestKey: issuedKey, expiresAt: 1100 } };
  const tools = fixture({ open: async () => { opens++; }, capabilities: async args => { capabilityInput = args; return descriptor; } });
  const reply = await tools.get('targets').handler({});
  assert.equal(reply.structuredContent.ok, true);
  assert.deepEqual(reply.structuredContent.data.targets[0].gui, descriptor);
  assert.deepEqual(capabilityInput, { target: 'linux', expectedTargetRevision: revision });
  assert.equal(opens, 0);
  const description = tools.get('desktop-open').options.description;
  assert.match(description, /server-issued requestKey/); assert.doesNotMatch(description, /one-time authentication|RDP window|portal/);
});

test('GUI-CONTRACT open request key and status recovery metadata use the common schema', async () => {
  assert.equal(publicInputSchemas['desktop-open'].safeParse({ target: 'linux', expectedTargetRevision: revision, requestKey: issuedKey }).success, true);
  assert.equal(publicInputSchemas['desktop-open'].safeParse({ target: 'linux', expectedTargetRevision: revision, requestKey: 'bad key' }).success, false);
  assert.equal(publicInputSchemas['desktop-open'].safeParse({ target: 'linux', expectedTargetRevision: revision }).success, true);
  const reply = await fixture({ status: async () => session }).get('desktop-status').handler({ sessionId, epoch: 1 });
  assert.equal(reply.structuredContent.ok, true);
  assert.equal(reply.structuredContent.data.nextInputSequence, 2);
  assert.deepEqual(reply.structuredContent.data.lastInputReceipt, session.lastInputReceipt);
  assert.equal(reply.content.length, 1);
});

test('GUI-CONTRACT cleanup receipts preserve each provider outcome and typed refusals', async () => {
  for (const sessionState of ['terminated', 'preserved', 'unknown']) {
    const reply = await fixture({ close: async () => ({ sessionId, closed: true, releaseSent: true, logout: false, sessionState }) })
      .get('desktop-close').handler({ sessionId, epoch: 1 });
    assert.equal(reply.structuredContent.ok, true); assert.equal(reply.structuredContent.data.sessionState, sessionState);
    assert.equal(publicOutputSchemas['desktop-close'].safeParse(reply.structuredContent).success, true);
  }
  const failure = await fixture({ open: async () => { throw Object.assign(Error('private detail'), { code: 'DESKTOP_OPEN_CONFLICT' }); } })
    .get('desktop-open').handler({ target: 'linux', expectedTargetRevision: revision, requestKey: issuedKey });
  assert.equal(failure.isError, true); assert.equal(failure.structuredContent.error.code, 'DESKTOP_OPEN_CONFLICT');
  assert.doesNotMatch(JSON.stringify(failure), /private detail/);
});
