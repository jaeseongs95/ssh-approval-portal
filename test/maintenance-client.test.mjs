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
  let legacy = true, comparison = 'PASS'; const calls = [];
  const server = createServer((req, res) => {
    calls.push({ path: req.url, owner: req.headers['x-maintenance-owner'] });
    if (req.url.endsWith('capabilities') && legacy) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    const result = req.url.endsWith('capabilities') ? {} : req.url.endsWith('compare') ? { status: comparison, commandRequestsChecked: 1, cliRequestsChecked: 0, outputsChecked: 1, outputPayloadsVerified: 1, outputsUnavailable: comparison === 'PARTIAL' ? 1 : 0, expiredOutputsRemoved: 0 } :
      { [req.url.endsWith('reserve') ? 'reserved' : req.url.endsWith('capture') ? 'captured' : 'released']: true };
    res.end(JSON.stringify({ ownership: 'durable-v1', ...result }));
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
    for (const action of ['reserve', 'capture', 'compare', 'release']) {
      const result = await run(action); assert.equal(result.code, 0); assert.ok(!result.output.includes(owner));
    }
    assert.deepEqual(calls.map(x => x.path), ['/api/maintenance/capabilities', '/api/maintenance/reserve', '/api/maintenance/capabilities', '/api/maintenance/preservation/capture', '/api/maintenance/capabilities', '/api/maintenance/preservation/compare', '/api/maintenance/capabilities', '/api/maintenance/release']);
    assert.ok(calls.every(x => x.owner === owner));
    comparison = 'FAIL'; calls.length = 0;
    const failed = await run('compare');
    assert.notEqual(failed.code, 0);
    assert.ok(!failed.output.includes(owner));
    assert.deepEqual(calls.map(x => x.path), ['/api/maintenance/capabilities', '/api/maintenance/preservation/compare']);
    comparison = 'PARTIAL'; calls.length = 0;
    const partial = await run('compare');
    assert.notEqual(partial.code, 0);
    assert.match(partial.output, /complete payload preservation was not verified/);
    assert.deepEqual(calls.map(x => x.path), ['/api/maintenance/capabilities', '/api/maintenance/preservation/compare']);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true }); }
});
