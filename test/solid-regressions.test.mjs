import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.env.SOLID_TEST_ROOT ?? dirname(fileURLToPath(new URL('../package.json', import.meta.url))));
const fixture = new URL('./solid-regression.fixture.mjs', import.meta.url);
const cases = ['AP-01', 'AP-02', 'AUTH-01', 'DELIVERY-01', 'DELIVERY-02', 'DELIVERY-03'];
// QEMU arm64 needs more startup time; child < fixture < test deadlines remain ordered.
const deadlineScale = process.arch === 'arm64' ? 5 : 1;
for (const id of cases) test(`${id} public-boundary regression`, { timeout: 15_000 * deadlineScale }, async () => {
  const work = await mkdtemp(resolve(tmpdir(), 'solid-regression-'));
  try {
  const result = await new Promise((accept, reject) => {
    const child = fork(fixture, [id, root, work], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, NODE_TEST_CONTEXT: '' } });
    let report, stderr = '';
    child.stderr.on('data', bytes => { stderr += bytes; }); child.stdout.resume();
    child.on('message', value => { report = value; }); child.on('error', reject);
    const deadline = setTimeout(() => { child.kill(); reject(Error(id + ' isolated fixture did not settle')); }, 12_000 * deadlineScale);
    child.on('exit', (code, signal) => { clearTimeout(deadline); accept({ code, signal, report, stderr }); });
  });
  assert.equal(result.code, 0, `${id}: isolated public boundary failed\n${result.stderr}`);
  assert.equal(result.signal, null); assert.equal(result.report?.scenario, id); assert.equal(result.report?.result, 'PASS');
  } finally {
    assert.ok(work.startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    await rm(work, { recursive: true, force: true });
  }
});
