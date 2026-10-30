import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { main } from '../scripts/portal-file-mcp.mjs';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..'), capabilityId = 'a'.repeat(48), args = { capabilityId };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-file-process-')), journal = join(root, 'journal'), source = join(root, '선택 파일.bin'), log = join(root, 'effects.jsonl');
  await mkdir(journal, { mode: 0o700 }); await writeFile(source, 'PRIVATE-source-content');
  const clients = new Set();
  t.after(async () => { for (const client of clients) await client.close(); assert.ok(root.startsWith(join(tmpdir(), 'agent-file-process-'))); await rm(root, { recursive: true, force: true }); });
  async function connect(mode = 'normal') {
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(repository, 'test/agent-file-mcp.fixture.mjs'), journal, source, log, mode], cwd: root, stderr: 'pipe' });
    let stderr = ''; transport.stderr.on('data', bytes => { stderr += bytes; });
    const client = new Client({ name: 'owned-agent-file-test', version: '1.0.0' }); await client.connect(transport); clients.add(client);
    return { client, async call(name, arguments_ = {}) {
      const result = await client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 10000 });
      const encoded = JSON.stringify(result); for (let secret of [source, '/tmp/PRIVATE-agent.bin', 'PRIVATE-source-content', 'SYNTHETIC.PRIVATE.TOKEN']) {
        for (let layer = 0; layer < 3; layer++) { assert.equal(encoded.includes(secret), false); secret = JSON.stringify(secret).slice(1, -1); }
      }
      return result;
    }, async close() { await client.close(); clients.delete(client); assert.equal(stderr.includes('PRIVATE-'), false); } };
  }
  const selection = { capabilityId, localPath: source, remotePath: '/tmp/PRIVATE-agent.bin', target: 'default' };
  const effects = () => readFile(log, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(JSON.parse), error => { if (error.code === 'ENOENT') return []; throw error; });
  return { root, journal, source, selection, connect, effects };
}

test('실제 MCP 프로세스는 명시 모드에서만 선택 도구를 노출하고 엄격 입력과 메타데이터를 지킨다', { timeout: 20000 }, async t => {
  const f = await fixture(t), p = await f.connect(), tools = (await p.client.listTools()).tools;
  assert.equal(tools.length, 5); const select = tools.find(tool => tool.name === 'file_upload_select'); assert.ok(select); assert.equal(select.inputSchema.additionalProperties, false);
  assert.equal(tools.some(tool => ['file_save', 'file_download_request'].includes(tool.name)), false);
  for (const tool of tools.filter(tool => tool.name !== 'file_upload_select')) {
    assert.equal(tool.inputSchema.additionalProperties, false); assert.deepEqual(Object.keys(tool.inputSchema.properties), tool.name === 'file_capabilities' ? [] : ['capabilityId']);
  }
  const bad = await p.call('file_upload_select', { ...f.selection, approve: true }).catch(() => ({ isError: true })); assert.equal(bad.isError, true);
  assert.deepEqual(await f.effects(), []);
  const selected = await p.call('file_upload_select', f.selection); assert.equal(selected.structuredContent.state, 'available'); assert.deepEqual(await f.effects(), []);
  assert.equal((await p.call('file_upload', args)).structuredContent.requestId, 'c'.repeat(48));
  assert.equal((await f.effects()).filter(row => row.effect === 'begin').length, 1); await p.close();
});

test('서로 다른 MCP 프로세스의 동시 claim과 재시작은 업로드를 한 번만 만든다', { timeout: 30000 }, async t => {
  const f = await fixture(t), a = await f.connect(), b = await f.connect();
  await a.call('file_upload_select', f.selection);
  const values = await Promise.all([a.call('file_upload', args), b.call('file_upload', args)]); assert.ok(values.some(value => value.structuredContent?.requestId === 'c'.repeat(48)));
  assert.equal((await f.effects()).filter(row => row.effect === 'begin').length, 1); await a.close(); await b.close();
  const c = await f.connect(); assert.equal((await c.call('file_upload', args)).structuredContent.requestId, 'c'.repeat(48)); assert.equal((await f.effects()).filter(row => row.effect === 'begin').length, 1); await c.close();
});

test('원격 시작 직후 실제 프로세스 종료는 재시작 뒤 새 업로드나 재개를 만들지 않는다', { timeout: 30000 }, async t => {
  const f = await fixture(t), a = await f.connect('crash'); await a.call('file_upload_select', f.selection);
  await assert.rejects(a.call('file_upload', args)); await a.close();
  const b = await f.connect(); for (const name of ['file_upload', 'file_upload_resume']) assert.equal((await b.call(name, args)).structuredContent.state, 'unknown');
  assert.equal((await f.effects()).filter(row => row.effect === 'begin').length, 1); await b.close();
});

test('잘못 섞은 명시 선택 모드 CLI 인자는 인증 helper 전에 거절된다', async () => {
  let helpers = 0;
  for (const argv of [
    ['--agent-uploads', '--manifest', '/manifest', '--origin', 'https://fixture.invalid', '--journal', '/journal', '--cloudflared', '/helper'],
    ['--agent-uploads', '--journal', '/journal', '--cloudflared', '/helper'],
    ['--agent-uploads', '--origin', 'http://fixture.invalid', '--journal', '/journal', '--cloudflared', '/helper'],
    ['--origin', 'https://fixture.invalid', '--manifest', '/manifest', '--journal', '/journal', '--cloudflared', '/helper'],
  ]) {
    let output = ''; assert.equal(await main(argv, { write: value => { output += value; } }, () => { helpers++; throw Error('helper should not run'); }), 1);
    assert.match(output, /FILE_MCP_START_REFUSED/);
  }
  assert.equal(helpers, 0);
});
