import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, unlinkSync, linkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CommandOutputs, OUTPUT_PAGE_BYTES } from '../src/adapters/storage/command-output.mjs';
import { createApplication } from '../app.mjs';
import { createAikSshTool } from '../src/adapters/aik/ssh-tool.mjs';
import { createCommandState } from '../src/adapters/storage/command-state.mjs';

const binding = { executionId: 'b'.repeat(48), targetId: 'default', targetRevision: 'revision1', profile: 'aws-local', operationDigest: 'c'.repeat(64) };
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'ssh-output-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); }); return root;
}
const allow = value => assert.deepEqual(value, binding);
function restore(store, id, format = 'json', maxBytes = 4096, authorize = allow) {
  const pages = []; let offsetBytes = 0;
  for (;;) {
    const page = store.read({ outputId: id, offsetBytes, maxBytes, format }, authorize);
    assert.ok(page.bytes <= maxBytes); assert.equal(Buffer.byteLength(page.text), page.bytes); assert.ok(!page.text.includes('\ufffd'));
    pages.push(page.text); if (page.eof) break; assert.ok(page.nextOffset > offsetBytes); offsetBytes = page.nextOffset;
  }
  return pages.join('');
}

test('output snapshots preserve text blocks/data exactly across UTF8 pages and restart without execution', t => {
  const root = directory(t), store = new CommandOutputs(root);
  const original = { failed: true, texts: ['', '한글🙂\r\n'.repeat(11000), ''], data: { nested: ['SENTINEL', 17] } };
  const result = store.finish(store.reserve(binding), original), id = result.output.id;
  assert.deepEqual(result.texts, []); assert.equal(result.failed, true); assert.equal(result.output.sshCompleteness, 'unknown');
  assert.deepEqual(JSON.parse(restore(store, id)), original);
  assert.equal(restore(store, id, 'text', 4093), original.texts.join('\n') + '\n' + JSON.stringify(original.data, null, 2));
  const empty = store.finish(store.reserve(binding), { failed: false, texts: [] });
  assert.equal(restore(store, empty.output.id, 'text'), '');
  assert.deepEqual(JSON.parse(restore(store, empty.output.id)), { failed: false, texts: [] });
  const small = store.finish(store.reserve(binding), { failed: false, texts: ['a한🙂z'] });
  assert.equal(restore(store, small.output.id, 'text', 7), 'a한🙂z');
  assert.throws(() => store.read({ outputId: id, offsetBytes: -1 }, allow));
  assert.throws(() => store.read({ outputId: id, maxBytes: OUTPUT_PAGE_BYTES + 1 }, allow));
  const next = store.finish(store.reserve(binding), original); assert.notEqual(next.output.id, id);
  store.close(); const restarted = new CommandOutputs(root);
  try { assert.deepEqual(JSON.parse(restore(restarted, id)), original); } finally { restarted.close(); }
});

test('capacity/expiry and interrupted capture remain independent from execution identity', t => {
  let now = 100; const root = directory(t), options = { maxBytes: 1024, budget: 1024, ttl: 50, now: () => now };
  let store = new CommandOutputs(root, options); const item = store.reserve(binding);
  assert.throws(() => store.reserve(binding), /capacity/);
  store.close(); store = new CommandOutputs(root, options);
  assert.equal(store.describe(store.get(item.id)).state, 'unavailable');
  assert.throws(() => store.read({ outputId: item.id }, allow), /unavailable/);
  now = 151; store.reap(); assert.throws(() => store.get(item.id));
  const oversized = store.finish(store.reserve(binding), { failed: false, texts: ['x'.repeat(2048)] });
  assert.equal(oversized.failed, false); assert.equal(oversized.output.state, 'unavailable'); assert.deepEqual(oversized.texts, []);
  store.close();
});

test('crash before manifest admission quarantines orphan bytes without blocking startup or replaying', t => {
  let now = 100; const root = directory(t), options = { maxBytes: 1024, budget: 2048, ttl: 50, now: () => now };
  let store = new CommandOutputs(root, options); store.close();
  const id = 'f'.repeat(48); writeFileSync(join(root, 'command-outputs', id + '.part'), '', { mode: 0o600 });
  store = new CommandOutputs(root, options);
  assert.equal(store.get(id).state, 'unavailable'); assert.equal(store.get(id).binding.targetId, null);
  assert.throws(() => store.read({ outputId: id }, () => {}), /unavailable/);
  now = 151; store.reap(); assert.throws(() => store.get(id)); store.close();
});

test('each output read checks current authorization and only returns verified payload bytes', t => {
  const root = directory(t), store = new CommandOutputs(root);
  try {
  const result = store.finish(store.reserve(binding), { failed: false, texts: ['SAFE '.repeat(20000)] }), id = result.output.id;
  let allowed = true, checks = 0;
  const authorize = () => { checks++; if (!allowed) throw Error('revoked'); };
  store.read({ outputId: id }, authorize); assert.equal(checks, 2);
  allowed = false; assert.throws(() => store.read({ outputId: id }, authorize), /revoked/);
  assert.throws(() => store.read({ outputId: '../unsafe' }, allow));
  const path = join(root, 'command-outputs', id + '.out'), bytes = readFileSync(path);
  const damaged = Buffer.from(bytes); damaged[10] ^= 1; writeFileSync(path, damaged);
  assert.throws(() => store.read({ outputId: id, format: 'json' }, allow), /integrity/);
  writeFileSync(path, bytes);
  const hardlink = join(root, 'extra-link'); linkSync(path, hardlink);
  assert.throws(() => store.read({ outputId: id }, allow), /Unsafe/); unlinkSync(hardlink);
  if (process.platform !== 'win32') {
    chmodSync(path, 0o644); assert.throws(() => store.read({ outputId: id }, allow), /Unsafe/); chmodSync(path, 0o600);
  }
  } finally { store.close(); }
});

test('actual MCP/HTTP defaults omit sentinel and arbitrary command data; explicit reads alone expose bounded body', async t => {
  const root = directory(t), marker = 'OUTPUT_SENTINEL_UNTRUSTED', body = marker + '한글🙂'.repeat(20000); let calls = 0, failStorage = false;
  const app = await createApplication({ registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'fixture', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
    classify: command => ({ class: command === 'id' ? 'read-only' : 'privileged' }), executeCommand: async () => {
      calls++;
      if (failStorage) for (const name of readdirSync(join(root, 'command-outputs'))) if (name.endsWith('.part')) unlinkSync(join(root, 'command-outputs', name));
      return { failed: false, texts: [body], data: { private: marker } };
    }, audit: () => {}, transferRoot: root, env: { BRIDGE_MCP_TOKEN: 'synthetic-mcp', BRIDGE_ADMIN_TOKEN: 'synthetic-owner', BRIDGE_UI_TICKET_KEY: 'a'.repeat(64), BRIDGE_ADMIN_ORIGIN: 'https://owner.test', BRIDGE_UI_ENABLED: 'true' }, uiHtml: '<html>fixture</html>' });
  await new Promise(resolve => app.mcpHttp.listen(0, '127.0.0.1', resolve)); await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'output-fixture', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.mcpHttp.address().port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer synthetic-mcp', Connection: 'close' } } }));
    const call = (name, args) => client.callTool({ name, arguments: args });
    const immediate = await call('read-command', { command: 'id' });
    assert.equal(JSON.stringify(immediate).includes(marker), false); assert.ok(Buffer.byteLength(JSON.stringify(immediate)) < 2048);
    const page = await call('read-command-output', { outputId: immediate.structuredContent.output.id, maxBytes: 128 });
    assert.ok(page.content[0].text.includes(marker));
    assert.equal(page.structuredContent.text, page.content[0].text, 'structured-only consumers must receive the explicit output body');
    assert.ok(page.structuredContent.bytes <= 128);
    const advertised = (await client.listTools()).tools;
    assert.ok(advertised.find(tool => tool.name === 'read-command-output').outputSchema.required.includes('text'));
    assert.ok(!advertised.find(tool => tool.name === 'ui-read-command-output').outputSchema.required.includes('text'));
    for (const format of ['text', 'json']) {
      const pages = []; let offsetBytes = 0;
      for (;;) {
        const read = await call('read-command-output', { outputId: immediate.structuredContent.output.id, format, offsetBytes, maxBytes: OUTPUT_PAGE_BYTES - 1 });
        assert.equal(read.isError, undefined);
        const value = read.structuredContent;
        assert.equal(value.text, read.content[0].text);
        assert.equal(Buffer.byteLength(value.text), value.bytes); assert.ok(value.bytes <= OUTPUT_PAGE_BYTES - 1);
        assert.ok(!value.text.includes('\ufffd')); pages.push(value.text);
        if (value.eof) break;
        assert.ok(value.nextOffset > offsetBytes); offsetBytes = value.nextOffset;
      }
      const complete = pages.join('');
      if (format === 'json') assert.deepEqual(JSON.parse(complete), { failed: false, texts: [body], data: { private: marker } });
      else assert.equal(complete, body + '\n' + JSON.stringify({ private: marker }, null, 2));
    }
    assert.equal((await call('read-command-output', { outputId: immediate.structuredContent.output.id, maxBytes: OUTPUT_PAGE_BYTES + 1 })).isError, true);
    assert.equal((await call('read-command-output', { outputId: immediate.structuredContent.output.id, target: 'wrong' })).isError, true);
    const requested = await call('run-command', { command: 'sudo id' }); const id = requested.structuredContent.id;
    await app.queue.approve(id);
    for (const name of ['get-request-status', 'show-approval']) assert.equal(JSON.stringify(await call(name, { id })).includes(marker), false);
    const card = await call('show-approval', { id }); const outputId = card.structuredContent.result.structuredContent.output.id;
    const uiPage = await call('ui-read-command-output', { id, outputId, ticket: card._meta.sshApproval.viewTicket });
    assert.ok(uiPage._meta.sshOutput.text.includes(marker)); assert.equal(JSON.stringify([uiPage.content, uiPage.structuredContent]).includes(marker), false);
    assert.equal((await call('ui-read-command-output', { id, outputId: immediate.structuredContent.output.id, ticket: card._meta.sshApproval.viewTicket })).isError, true);
    const web = `http://127.0.0.1:${app.adminHttp.address().port}`;
    const history = await fetch(web + '/api/requests', { headers: { Authorization: 'Bearer synthetic-owner' } }); assert.equal((await history.text()).includes(marker), false);
    assert.equal((await fetch(web + `/api/outputs/${outputId}`)).status, 401);
    const ownerPage = await fetch(web + `/api/outputs/${outputId}`, { headers: { Authorization: 'Bearer synthetic-owner' } });
    assert.equal(ownerPage.status, 200); assert.ok((await ownerPage.json()).text.includes(marker));
    for (let n = 0; n < 2; n++) assert.equal((await call('read-command-output', { outputId })).isError, undefined);
    assert.equal(calls, 2);
    failStorage = true;
    const failedCapture = await call('read-command', { command: 'id' });
    assert.equal(failedCapture.structuredContent.state, 'completed'); assert.equal(failedCapture.structuredContent.output.state, 'unavailable'); assert.equal(JSON.stringify(failedCapture).includes(marker), false); assert.equal(calls, 3);
  } finally { await client.close(); await app.close(); }
});

test('AIK output observation requires original binding and revalidates after delayed reads', async () => {
  const id = 'a'.repeat(48), outputId = 'b'.repeat(48), events = []; let revoked = false;
  const authority = Object.fromEntries(['authorize', 'revalidate', 'recordDispatch', 'bindRequest', 'recordReceipt'].map(name => [name, async () => {}]));
  authority.lookupRequest = async value => { assert.equal(value, id); return { bound: true }; };
  const mcp = { async call(name) { events.push(name); if (name === 'get-request-status') return { id, result: { structuredContent: { output: { id: outputId, executionId: id, state: 'ready' } } } }; revoked = true; return { content: [{ type: 'text', text: 'PRIVATE' }], structuredContent: { outputId, executionId: id } }; } };
  await assert.rejects(createAikSshTool({ authority, mcp }).output(id), /capability unavailable/); assert.deepEqual(events, []);
  authority.revalidateObservation = async () => { if (revoked) throw Error('observation revoked'); };
  await assert.rejects(createAikSshTool({ authority, mcp }).output(id), /observation revoked/);
  assert.deepEqual(events, ['get-request-status', 'read-command-output']);
});

test('legacy journal conversion preserves snapshot; expiry and restart retain durable replay protection', async t => {
  const root = directory(t), realNow = Date.now; let clock = realNow(), executions = 0, app;
  Date.now = () => clock;
  const id = 'd'.repeat(48), original = { failed: false, texts: ['LEGACY_SENTINEL', ''], data: { preserved: true } };
  const state = createCommandState(root);
  state.insert({ id, kind: 'command', operation: { kind: 'command', command: 'sudo id' }, command: 'sudo id', profile: 'aws-local', commandClass: 'privileged', target: 'fixture@127.0.0.1:22', state: 'completed', createdAt: clock, finishedAt: clock, expiresAt: clock + 3600000, result: original }, null, 'legacy'); state.close();
  const make = () => createApplication({ registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'fixture', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
    classify: () => ({ class: 'privileged' }), executeCommand: async () => { executions++; return { failed: false, texts: ['new-output'] }; }, audit: () => {}, transferRoot: root,
    env: { BRIDGE_MCP_TOKEN: 'synthetic-mcp', BRIDGE_ADMIN_TOKEN: 'synthetic-owner', BRIDGE_UI_TICKET_KEY: 'a'.repeat(64), BRIDGE_ADMIN_ORIGIN: 'https://owner.test', BRIDGE_COMMAND_AUTOMATION: 'true' }, uiHtml: '<html>fixture</html>' });
  try {
    app = await make(); const migrated = app.queue.get(id).result;
    assert.deepEqual(migrated.texts, []); assert.equal(migrated.output.state, 'ready'); assert.equal(executions, 0);
    await app.close(); app = null;
    const outputs = new CommandOutputs(root); try { assert.deepEqual(JSON.parse(restore(outputs, migrated.output.id, 'json', 4096, value => assert.equal(value.executionId, id))), original); } finally { outputs.close(); }
    app = await make();
    const key = 'synthetic-output-replay-0001', first = await app.targets.commands.run('sudo id', undefined, key);
    await app.queue.approve(first.job.id); assert.equal(executions, 1);
    const output = app.queue.get(first.job.id).result.output;
    await app.close(); app = null; clock += 3600001;
    app = await make();
    const replay = await app.targets.commands.run('sudo id', undefined, key);
    assert.equal(replay.job.id, first.job.id); assert.equal(replay.job.state, 'completed'); assert.equal(executions, 1);
    assert.equal(replay.job.result.output.id, output.id);
  } finally { await app?.close(); Date.now = realNow; }
});
