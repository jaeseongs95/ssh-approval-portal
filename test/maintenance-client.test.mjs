import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

test('installer maintenance helper recovers a retained active owner token and cleans up its directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maintenance-recover-'));
  try {
    const ownersBase = join(dir, 'owners'), jobDir = join(ownersBase, 'job.retained'), ownerFile = join(jobDir, 'owner');
    await mkdir(jobDir, { recursive: true, mode: 0o700 });
    await writeFile(ownerFile, 'c'.repeat(64), { mode: 0o600 });
    const fakeNode = join(dir, 'fake-node.sh'), logFile = join(dir, 'calls.log');
    await writeFile(fakeNode, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'token=$(cat)',
      'printf "%s:%s\\n" "$2" "$token" >> "$CALL_LOG"',
      'if [[ "$2" == status ]]; then echo reserved; exit 0; fi',
      'if [[ "$2" == release ]]; then exit 0; fi',
      'exit 1',
    ].join('\n'), { mode: 0o755 });
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    const helper = resolve('scripts/maintenance-owner.sh').replaceAll('\\', '/');
    const baseUnix = ownersBase.replaceAll('\\', '/');
    const nodeUnix = fakeNode.replaceAll('\\', '/');
    const logUnix = logFile.replaceAll('\\', '/');
    const script = `source "${helper}"; eval "$(declare -f maintenance_recover_retained | sed 's|/var/lib/ssh-mcp/.maintenance-owners|${baseUnix}|g')"; maintenance_recover_retained "${nodeUnix}" /ignored/maintenance.mjs`;
    const result = spawnSync(bash, ['-c', script], { encoding: 'utf8', env: { ...process.env, CALL_LOG: logUnix } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
