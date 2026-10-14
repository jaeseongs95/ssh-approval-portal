import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../app.mjs';

test('maintenance atomically excludes pending/running jobs and blocks new execution during deployment preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-maint-'));
  let complete; const execution = new Promise(resolve => { complete = resolve; });
  const app = await createApplication({
    registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'mcpops', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
    classify: () => ({ class: 'privileged' }), executeCommand: () => execution, audit: () => {}, transferRoot: root,
    env: { BRIDGE_MCP_TOKEN: 'test-mcp', BRIDGE_ADMIN_TOKEN: 'test-admin', BRIDGE_ADMIN_ORIGIN: 'https://example.test', BRIDGE_UI_TICKET_KEY: 'b'.repeat(64), BRIDGE_UI_ENABLED: 'true' }, uiHtml: '<html></html>',
  });
  await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${app.adminHttp.address().port}/api/maintenance/`;
  const post = action => fetch(endpoint + action, { method: 'POST', headers: { Authorization: 'Bearer test-admin', Origin: 'https://example.test' } });
  try {
    const job = app.queue.submit('sudo id');
    assert.equal((await post('reserve')).status, 409);
    app.queue.start(job.id);
    assert.equal((await post('reserve')).status, 409);
    complete({ content: [{ type: 'text', text: 'done' }] }); await app.queue.wait(job.id);
    const reservations = await Promise.all([post('reserve'), post('reserve')]);
    assert.deepEqual(reservations.map(x => x.status).sort(), [200, 409]);
    assert.throws(() => app.queue.submit('sudo new'));
    assert.throws(() => app.queue.submitOperation({ kind: 'download', remotePath: '/tmp/x', elevate: false }));
    assert.equal(app.queue.maintenance, true);
    assert.equal((await post('release')).status, 200);
    const staged = await app.store.begin({ fileName: 'x', remotePath: '/tmp/x', size: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
    assert.equal((await post('reserve')).status, 409, 'An incomplete upload must survive until completed/expired');
    await app.store.remove(staged.id);
    assert.equal((await post('reserve')).status, 200);
  } finally { complete({}); await app.close(); await rm(root, { recursive: true }); }
});
