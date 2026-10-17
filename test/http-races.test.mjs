import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { finished } from 'node:stream/promises';
import { createApplication } from '../app.mjs';
import { hash } from '../src/domain/validation.mjs';
test('malformed raw HTTP target is contained; isolated server remains healthy', async () => {
  const child = fork(new URL('./malformed-server.fixture.mjs', import.meta.url), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    const [ports] = await once(child, 'message');
    for (const path of ['//[', '//%']) {
      const status = await new Promise((resolve, reject) => {
        const r = request({ hostname: '127.0.0.1', port: ports.adminPort, path, method: 'GET' }, response => { response.resume(); resolve(response.statusCode); }); r.on('error', reject); r.end();
      });
      assert.ok(status >= 400 && status < 500);
      assert.equal((await fetch(`http://127.0.0.1:${ports.mcpPort}/health`)).status, 200);
      assert.equal(child.exitCode, null);
    }
    child.send('stop'); const [code] = await once(child, 'exit'); assert.equal(code, 0);
  } finally { if (child.exitCode === null) child.kill(); }
});
test('one download URL is claimed before verification await; simultaneous replay receives no bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-download-race-'));
  const profile = { host: 'localhost', port: 22, user: 'mcpops' };
  const app = await createApplication({ registry: { getProfile: name => ({ ...profile, readOnly: name === 'aws-readonly' }), closeAll: async () => {} }, classify: () => ({ class: 'read-only' }), executeCommand: async () => ({}), audit: () => {}, transferRoot: root,
    env: { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-admin', BRIDGE_ADMIN_ORIGIN: 'https://example.test', BRIDGE_UI_TICKET_KEY: 'd'.repeat(64) }, uiHtml: '<html>test</html>' });
  try {
    await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
    const data = Buffer.from([0, 255, 1]);
    const reserved = app.store.reserveDownload({ remotePath: '/tmp/race.bin', fileName: 'race.bin', elevate: false });
    const artifact = await app.store.receiveDownload(reserved.id, { size: data.length, sha256: hash(data) }, async writable => {
      writable.end(data); await finished(writable);
    });
    app.transfers.download = async () => ({ failed: false, texts: [], data: { artifactId: artifact.id, fileName: artifact.fileName } });
    const job = app.queue.submitOperation({ kind: 'download', remotePath: '/tmp/race.bin', elevate: false }); app.queue.start(job.id); await app.queue.wait(job.id);
    const base = `http://127.0.0.1:${app.adminHttp.address().port}`;
    const reply = await fetch(`${base}/api/${job.id}/download`, { method: 'POST', headers: { Authorization: 'Bearer fixture-admin', Origin: 'https://example.test' } });
    const url = new URL((await reply.json()).downloadUrl); const local = base + url.pathname + url.search;
    const head = await fetch(local, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    const real = app.store.verified.bind(app.store); let entered, release, checks = 0;
    const begun = new Promise(resolve => { entered = resolve; }), barrier = new Promise(resolve => { release = resolve; });
    app.store.verified = async id => { checks++; entered(); await barrier; return real(id); };
    const first = fetch(local); await begun;
    const rejected = await fetch(local); assert.equal(rejected.status, 409); assert.equal(checks, 1);
    release(); const accepted = await first; assert.equal(accepted.status, 200); assert.deepEqual(Buffer.from(await accepted.arrayBuffer()), data);
  } finally { await app.close(); await rm(root, { recursive: true }); }
});
