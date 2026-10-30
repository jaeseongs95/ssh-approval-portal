import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalQueue } from '../src/domain/approval-queue.mjs';
import { parseSettings } from '../src/adapters/config/settings.mjs';
import { parseSecretText } from '../src/adapters/config/secrets.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../app.mjs';

const env = { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-admin', BRIDGE_ADMIN_ORIGIN: 'https://admin.example.test' };
const ports = { classify: () => ({ class: 'privileged' }), profile: 'fixture-write', target: 'fixture', executeOperation: async () => ({ failed: false, texts: ['preserved'] }) };

test('request capacity defaults to 100 and accepts only canonical bounded integers', () => {
  assert.equal(parseSettings(env).requestCapacity, 100);
  assert.equal(parseSettings({ ...env, ...parseSecretText('BRIDGE_REQUEST_CAPACITY=101\n') }).requestCapacity, 101);
  for (const value of ['100', '101', '1000']) assert.equal(parseSettings({ ...env, BRIDGE_REQUEST_CAPACITY: value }).requestCapacity, Number(value));
  for (const value of ['', '99', '1001', '0', '-100', '1e3', '100.0', '0100', ' 100', '100 ', '100\n', 'Infinity', 'NaN', '9007199254740992', 100]) {
    assert.throws(() => parseSettings({ ...env, BRIDGE_REQUEST_CAPACITY: value }), /request capacity/);
  }
  for (const requestCapacity of [99, 1001, 100.5, Infinity, NaN, '100', null]) assert.throws(() => new ApprovalQueue({ ...ports, requestCapacity }), /request capacity/);
});

test('application wiring applies the configured capacity independently to legacy and every explicit target', async () => {
  for (const explicit of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'request-capacity-'));
    const entries = ['alpha', 'beta', 'gamma'].map(id => ({ id, displayName: id, readProfile: id + '-read', writeProfile: id + '-write', credentialRevision: 'v1' }));
    const profiles = new Map((explicit ? entries : [{ id: 'default', readProfile: 'aws-readonly', writeProfile: 'aws-local' }])
      .flatMap(entry => [entry.readProfile, entry.writeProfile].map(name => [name, { name, host: entry.id + '.example.test', port: 22, user: 'fixture', readOnly: name === entry.readProfile, trustedHostKey: 'SHA256:' + entry.id }])));
    let app;
    try {
      app = await createApplication({ registry: { getProfile: name => profiles.get(name), closeAll: async () => {} }, classify: ports.classify,
        executeCommand: () => assert.fail('Capacity checks must never execute SSH'), audit: () => {}, transferRoot: root, uiHtml: '<html></html>',
        env: { ...env, BRIDGE_UI_TICKET_KEY: 'b'.repeat(64), BRIDGE_REQUEST_CAPACITY: '101', ...(explicit ? { BRIDGE_TARGETS: JSON.stringify(entries) } : {}) } });
      for (const id of explicit ? ['alpha', 'beta', 'gamma'] : ['default']) {
        const runtime = app.targets.select(id);
        for (let i = 0; i < 101; i++) runtime.queue.deny(app.queue.submit('sudo id', false, id).id);
        assert.equal(runtime.queue.jobs.size, 101);
        assert.throws(() => app.queue.submit('sudo id', false, id), /Queue full/);
      }
    } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test('default saturation refuses before allocating an ID and preserves all 100 terminal requests', async () => {
  let ids = 0;
  const queue = new ApprovalQueue({ ...ports, idFactory: () => String(++ids) });
  for (let i = 0; i < 100; i++) {
    const job = queue.submit('sudo id');
    await queue.approve(job.id);
  }
  assert.equal(queue.jobs.size, 100);
  assert.throws(() => queue.submit('sudo id'), /Queue full/);
  assert.equal(ids, 100);
  assert.ok(queue.listAll().every(job => job.state === 'completed' && job.result.texts[0] === 'preserved'));
});

test('custom capacity stays bounded, retains terminal output for one hour and never reaps running work', async () => {
  let now = 0, finish;
  const queue = new ApprovalQueue({ ...ports, requestCapacity: 1000, now: () => now,
    executeOperation: () => new Promise(resolve => { finish = resolve; }) });
  const running = queue.submit('sudo id');
  queue.start(running.id); await Promise.resolve();
  for (let i = 1; i < 1000; i++) queue.deny(queue.submit('sudo id').id);
  assert.equal(queue.jobs.size, 1000);
  assert.throws(() => queue.submit('sudo id'), /Queue full/);
  now = 3_600_000; queue.reap(); assert.equal(queue.jobs.size, 1000);
  now++; queue.reap(); assert.equal(queue.jobs.size, 1); assert.equal(queue.get(running.id).state, 'running');
  finish({ failed: false, texts: ['preserved'], output: { id: 'fixture-output' } });
  const completed = await queue.wait(running.id);
  now += 3_600_000; queue.reap(); assert.deepEqual(queue.get(running.id), completed);
  now++; queue.reap(); assert.equal(queue.get(running.id), null);
  assert.equal(queue.submit('sudo id').state, 'pending');
});

test('larger capacity preserves per-target serialization and external execution claims', async () => {
  let finish, claims = 0, releases = 0, externalBusy = false;
  const queue = new ApprovalQueue({ ...ports, requestCapacity: 101, externalBusy: () => externalBusy,
    claimExecution: () => { claims++; return () => { releases++; }; },
    executeOperation: () => new Promise(resolve => { finish = resolve; }) });
  const a = queue.submit('sudo id'), b = queue.submit('sudo id');
  externalBusy = true; assert.throws(() => queue.start(a.id), /already executing/); assert.equal(claims, 0);
  externalBusy = false; queue.start(a.id); await Promise.resolve();
  assert.throws(() => queue.start(b.id), /already executing/); assert.equal(claims, 1);
  finish({ failed: false, texts: [] }); await queue.wait(a.id); assert.equal(releases, 1);
  queue.start(b.id); await Promise.resolve(); finish({ failed: false, texts: [] }); await queue.wait(b.id);
  assert.equal(claims, 2); assert.equal(releases, 2);
});
