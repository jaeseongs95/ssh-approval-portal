import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Duplex, PassThrough } from 'node:stream';
import { parseProvisionArgs, generateGuiPassword, runProvisionGuiAccount, createWindowsProvisionPort, WINDOWS_PROVISION_SOURCE } from '../scripts/provision-gui-account.mjs';
import { createLocalSecretStore } from '../src/adapters/secrets/local-file.mjs';

const revision = 'a'.repeat(64), reference = 'secret://local-file/windows-agent', sid = 'S-1-5-21-123-456-789-1001';
const password = 'Synthetic9!private-test-value-no-output';
const baseArgs = ['--expected-revision', revision, '--secret-ref', reference];
async function fixture(t, extra = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'gui-provision-'));
  await fs.chmod(parent, 0o700);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'secrets'), output = [], calls = [];
  const target = { id: 'windows', platform: 'windows', enabled: true, identity: {}, revision, writeProfile: 'win-write', verify() {} };
  let closed = 0;
  const context = { settings: { secretStoreDir: directory }, targets: [target], runtime: { registry: {
    getProfile: () => ({ trustedHostKey: 'sha256:fixture-pin' }), closeAll: async () => { closed++; },
  } } };
  const deps = { loadRuntime: async () => context, write: value => output.push(value), passwordFactory: () => password,
    windowsPort: () => async value => {
      calls.push(value);
      if (value.mode === 'probe') return { phase: 'probe', accountExists: false, ready: true, domain: 'WINTEST', code: 'OK' };
      await value.onStage({ phase: 'created', sid });
      return { phase: 'complete', sid, domain: 'WINTEST' };
    }, ...extra };
  return { parent, directory, output, calls, context, target, deps, closed: () => closed };
}

test('argument parser fixes Windows target, requires revision/ref and rejects secret argv', () => {
  assert.equal(parseProvisionArgs(baseArgs).apply, false);
  for (const args of [[], [...baseArgs, '--password', password], [...baseArgs, '--target', 'default'], [...baseArgs, '--apply', '--apply'], [...baseArgs, '--secret-ref', 'secret://local-file/other'], [...baseArgs, '--username', 'administrator'], [...baseArgs, '--status', 'bad']]) {
    assert.throws(() => parseProvisionArgs(args), { code: 'INVALID_ARGUMENTS' });
  }
  const generated = new Set(Array.from({ length: 64 }, generateGuiPassword));
  assert.equal(generated.size, 64);
  for (const value of generated) assert.match(value, /^Aa9![A-Za-z0-9_-]{48}$/);
});

test('default dry-run leaves filesystem unchanged and emits no store path/password', async t => {
  const f = await fixture(t);
  const result = await runProvisionGuiAccount(baseArgs, f.deps);
  assert.equal(result.stage, 'dry_run'); assert.equal(result.ready, true);
  assert.deepEqual(await fs.readdir(f.parent), []);
  assert.deepEqual(f.calls.map(x => x.mode), ['probe']); assert.equal(f.closed(), 1);
  assert.ok(!JSON.stringify(f.output).includes(f.directory)); assert.ok(!JSON.stringify(f.output).includes(password));
});

test('unconfigured/mismatched store, changed revision and unpinned target refuse before probing', async t => {
  for (const [change, args, code] of [
    [f => { f.context.settings.secretStoreDir = ''; }, baseArgs, 'SECRET_STORE_UNCONFIGURED'],
    [() => {}, [...baseArgs, '--store', '/different/store'], 'SECRET_STORE_MISMATCH'],
    [f => { f.target.revision = 'b'.repeat(64); }, baseArgs, 'TARGET_CHANGED'],
    [f => { f.context.runtime.registry.getProfile = () => ({}); }, baseArgs, 'INVALID_TARGET'],
  ]) {
    const f = await fixture(t); change(f);
    assert.equal((await runProvisionGuiAccount(args, f.deps)).code, code);
    assert.equal(f.calls.length, 0); assert.deepEqual(await fs.readdir(f.parent), []);
  }
});

test('existing account or any secret path refuses without generation, replacement or private state', async t => {
  const account = await fixture(t, { windowsPort: () => async () => ({ accountExists: true, ready: false }) });
  account.deps.passwordFactory = () => assert.fail('must not generate');
  assert.equal((await runProvisionGuiAccount([...baseArgs, '--apply'], account.deps)).code, 'ACCOUNT_EXISTS');
  assert.deepEqual(await fs.readdir(account.parent), []);
  const f = await fixture(t); const store = createLocalSecretStore(f.directory);
  await store.init(); await store.put('windows-agent', 'existing-fixture-value');
  const before = await fs.readFile(path.join(f.directory, 'windows-agent.json'));
  assert.equal((await runProvisionGuiAccount([...baseArgs, '--apply'], f.deps)).code, 'SECRET_EXISTS');
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'windows-agent.json')), before);
  assert.equal(f.calls.length, 0);
});

test('apply publishes one valid existing-provider record and status contains only public state', async t => {
  const f = await fixture(t);
  const result = await runProvisionGuiAccount([...baseArgs, '--apply'], f.deps);
  assert.equal(result.stage, 'complete'); assert.equal(result.accountSid, sid); assert.equal(result.secretState, 'published');
  const store = createLocalSecretStore(f.directory);
  assert.deepEqual(JSON.parse(await store.read('windows-agent')), { username: 'ssh-gui-agent', domain: 'WINTEST', password });
  assert.equal((await fs.stat(path.join(f.directory, 'windows-agent.json'))).nlink, 1);
  assert.equal((await fs.stat(path.join(f.directory, 'windows-agent.json'))).mode & 0o777, 0o600);
  const operation = path.join(f.directory, '.gui-operation-' + result.operationId);
  assert.equal((await fs.stat(operation)).mode & 0o777, 0o700);
  assert.ok(!(await fs.readFile(path.join(operation, 'state.jsonl'), 'utf8')).includes(password));
  const status = await runProvisionGuiAccount([...baseArgs, '--status', result.operationId], f.deps);
  assert.equal(status.stage, 'complete'); assert.equal(f.calls.length, 2);
  assert.ok(!JSON.stringify(f.output).includes(password)); assert.ok(!JSON.stringify(f.output).includes(f.directory));
});

test('unknown dispatch persists credential and stops a second attempt without automatic replay', async t => {
  let applies = 0;
  const f = await fixture(t, { windowsPort: () => async request => {
    if (request.mode === 'probe') return { accountExists: false, ready: true, domain: 'WINTEST' };
    applies++; throw Object.assign(Error(password), { code: 'REMOTE_OUTCOME_UNKNOWN' });
  } });
  const result = await runProvisionGuiAccount([...baseArgs, '--apply'], f.deps);
  assert.equal(result.code, 'REMOTE_OUTCOME_UNKNOWN'); assert.equal(result.accountState, 'unknown');
  const staging = createLocalSecretStore(path.join(f.directory, '.gui-operation-' + result.operationId, 'credential'));
  assert.equal(JSON.parse(await staging.read('windows-agent')).password, password);
  assert.equal((await runProvisionGuiAccount([...baseArgs, '--apply'], f.deps)).code, 'PROVISION_RECOVERY_REQUIRED');
  assert.equal(applies, 1); assert.ok(!JSON.stringify(f.output).includes(password));
});

test('status refuses corrupt private state without printing attacker-controlled fields', async t => {
  const f = await fixture(t);
  const result = await runProvisionGuiAccount([...baseArgs, '--apply'], f.deps);
  const file = path.join(f.directory, '.gui-operation-' + result.operationId, 'state.jsonl');
  await fs.appendFile(file, JSON.stringify({ ...result, accountSid: password }) + '\n');
  const status = await runProvisionGuiAccount([...baseArgs, '--status', result.operationId], f.deps);
  assert.equal(status.code, 'LOCAL_STATE_FAILED'); assert.ok(!JSON.stringify(f.output).includes(password));
});

test('group failure preserves created SID and private credential without publishing', async t => {
  const f = await fixture(t, { windowsPort: () => async request => {
    if (request.mode === 'probe') return { accountExists: false, ready: true, domain: 'WINTEST' };
    await request.onStage({ phase: 'created', sid });
    throw Object.assign(Error(password), { code: 'WINDOWS_FAILED' });
  } });
  const result = await runProvisionGuiAccount([...baseArgs, '--apply'], f.deps);
  assert.equal(result.code, 'WINDOWS_FAILED'); assert.equal(result.accountState, 'created'); assert.equal(result.accountSid, sid);
  await assert.rejects(fs.stat(path.join(f.directory, 'windows-agent.json')), { code: 'ENOENT' });
  assert.ok(!JSON.stringify(f.output).includes(password));
});

test('racing secret writer wins without overwrite; operation keeps staged credential', async t => {
  const f = await fixture(t);
  f.deps.windowsPort = () => async request => {
    if (request.mode === 'probe') return { accountExists: false, ready: true, domain: 'WINTEST' };
    await request.onStage({ phase: 'created', sid });
    await createLocalSecretStore(f.directory).put('windows-agent', 'racing-fixture-value');
    return { phase: 'complete', sid, domain: 'WINTEST' };
  };
  const result = await runProvisionGuiAccount([...baseArgs, '--apply'], f.deps);
  assert.equal(result.code, 'SECRET_EXISTS'); assert.equal(result.accountSid, sid);
  assert.equal(await createLocalSecretStore(f.directory).read('windows-agent'), 'racing-fixture-value');
  assert.equal(JSON.parse(await createLocalSecretStore(path.join(f.directory, '.gui-operation-' + result.operationId, 'credential')).read('windows-agent')).password, password);
});

test('credential generation failure before dispatch prevents account creation', async t => {
  const f = await fixture(t);
  f.deps.passwordFactory = () => { throw Error(password); };
  const result = await runProvisionGuiAccount([...baseArgs, '--apply'], f.deps);
  assert.equal(result.code, 'LOCAL_STATE_FAILED'); assert.equal(result.accountState, 'not_created');
  assert.deepEqual(f.calls.map(x => x.mode), ['probe']); assert.ok(!JSON.stringify(f.output).includes(password));
});

test('native port sends secret only through stdin; malformed output fails closed', async () => {
  for (const malformed of [false, true]) {
    let input, command, stdinEnd;
    const channel = new Duplex({ read() {}, write(chunk, _encoding, done) { input = Buffer.from(chunk); done(); }, final(done) { stdinEnd(); done(); } });
    const stderr = new PassThrough();
    const exitPromise = new Promise(resolve => { stdinEnd = () => queueMicrotask(() => {
      channel.push(malformed ? JSON.stringify({ phase: 'complete', password }) + '\n' : JSON.stringify({ phase: 'complete', sid, domain: 'WINTEST' }) + '\n');
      resolve({ exitCode: 0, reason: 'exit', remoteState: 'exited', cleanupComplete: true });
    }); });
    const runtime = { openDesktopProcessChannel: async (_profile, options) => { command = options.command; await options.beforeDispatch(); return { stream: channel, stderr, exitPromise, close: async () => {} }; } };
    const port = createWindowsProvisionPort({ runtime, target: { writeProfile: 'win-write', verify() {} } });
    if (malformed) await assert.rejects(port({ mode: 'apply', username: 'ssh-gui-agent', password }), { code: 'REMOTE_OUTCOME_UNKNOWN' });
    else assert.equal((await port({ mode: 'apply', username: 'ssh-gui-agent', password })).sid, sid);
    assert.equal(JSON.parse(input).password, password); assert.ok(!command.includes(password));
    assert.ok(command.startsWith('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand '));
    channel.destroy(); stderr.destroy();
  }
  assert.match(WINDOWS_PROVISION_SOURCE, /Add-LocalGroupMember -SID 'S-1-5-32-555' -Member \$user/);
  assert.doesNotMatch(WINDOWS_PROVISION_SOURCE, /Set-LocalUser|Remove-LocalUser|PasswordNeverExpires|Set-ItemProperty|logoff|SendSAS/);
});
