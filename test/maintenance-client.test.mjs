import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('client verifies durable capability before mutation and passes the same owner on reserve and release', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maintenance-client-'));
  const secret = join(dir, 'env'); await writeFile(secret, '');
  let legacy = true; const calls = [];
  const server = createServer((req, res) => {
    calls.push({ path: req.url, owner: req.headers['x-maintenance-owner'] });
    if (req.url.endsWith('capabilities') && legacy) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('capabilities') ? { ownership: 'durable-v1' } :
      { ownership: 'durable-v1', [req.url.endsWith('reserve') ? 'reserved' : 'released']: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const owner = 'a'.repeat(64);
  const run = action => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/maintenance.mjs', import.meta.url)), action], {
      env: { ...process.env, BRIDGE_SECRET_ENV_FILE: secret, BRIDGE_ADMIN_PORT: String(server.address().port),
        BRIDGE_ADMIN_TOKEN: 'test-admin', BRIDGE_MCP_TOKEN: 'test-mcp', BRIDGE_ADMIN_ORIGIN: 'https://example.test' },
    });
    let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    child.on('error', reject); child.on('close', code => resolve({ code, output })); child.stdin.end(owner);
  });
  try {
    assert.notEqual((await run('reserve')).code, 0);
    assert.deepEqual(calls.map(x => x.path), ['/api/maintenance/capabilities']);
    legacy = false; calls.length = 0;
    for (const action of ['reserve', 'release']) {
      const result = await run(action); assert.equal(result.code, 0); assert.ok(!result.output.includes(owner));
    }
    assert.deepEqual(calls.map(x => x.path), ['/api/maintenance/capabilities', '/api/maintenance/reserve', '/api/maintenance/capabilities', '/api/maintenance/release']);
    assert.ok(calls.every(x => x.owner === owner));
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true }); }
});
