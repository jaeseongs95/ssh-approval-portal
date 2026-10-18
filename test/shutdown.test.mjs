import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../app.mjs';

const origin = 'https://admin.example.test';
async function fixture(environmentTransport = async () => ({ available: true })) {
  const root = await mkdtemp(join(tmpdir(), 'shutdown-http-'));
  let connectionsClosed = false;
  const app = await createApplication({ transferRoot: root, uiHtml: '', audit: () => {},
    env: { BRIDGE_MCP_TOKEN: 'synthetic-mcp', BRIDGE_ADMIN_TOKEN: 'synthetic-admin',
      BRIDGE_UI_TICKET_KEY: 'b'.repeat(64), BRIDGE_ADMIN_ORIGIN: origin },
    registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'synthetic', readOnly: name === 'aws-readonly' }),
      closeAll: async () => { connectionsClosed = true; } },
    classify: () => ({ class: 'privileged' }), executeCommand: async () => ({ texts: [] }), environmentTransport });
  await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
  return { app, port: app.adminHttp.address().port, closed: () => connectionsClosed,
    cleanup: async () => { await app.close(); await rm(root, { recursive: true }); } };
}

test('shutdown bounds an unfinished HTTP body without waiting for the client to finish', async () => {
  const f = await fixture();
  const accepted = once(f.app.adminHttp, 'request');
  const pending = request({ host: '127.0.0.1', port: f.port, path: '/api/environment', method: 'POST',
    headers: { Authorization: 'Bearer synthetic-admin', Origin: origin, 'Content-Type': 'application/json', 'Content-Length': 1000 } });
  pending.on('error', () => {}); pending.write('{');
  let closing;
  try {
    await accepted;
    closing = f.app.close();
    assert.equal(f.app.close(), closing);
    assert.equal(await Promise.race([closing.then(() => true), delay(7000, false)]), true,
      'shutdown must finish within 7 seconds despite an unfinished request body');
    assert.equal(f.closed(), true);
  } finally { pending.destroy(); await closing; await f.cleanup(); }
});

test('shutdown lets a valid in-flight response finish within the grace period', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(async () => { entered(); await new Promise(resolve => { release = resolve; }); return { available: true, marker: 'response-preserved' }; });
  try {
    const response = fetch('http://127.0.0.1:' + f.port + '/api/environment', { headers: { Authorization: 'Bearer synthetic-admin' } });
    await started;
    const closing = f.app.close();
    assert.equal(f.closed(), false);
    release();
    const result = await response;
    assert.equal(result.status, 200);
    assert.equal((await result.json()).marker, 'response-preserved');
    await closing;
    assert.equal(f.closed(), true);
  } finally { await f.cleanup(); }
});
