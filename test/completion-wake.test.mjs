import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wakeCompletion } from '../src/adapters/cli/completion-wake.mjs';

// Execute on approved TEST only. All host processes and sockets are injected.
const sessionId = '01a15ca3-f838-7551-9620-7c3a8631c52c';
const receiptId = '01a1a982-631e-7b70-8677-c32385867ac8';
const marker = '[ssh-mcp:completion:01a1a982-631e-7b70-8677-c32385867ac8]';
const target = { sessionId, receiptId };
const unavailable = reasonCode => ({ state: 'unavailable', reasonCode });
const unknown = reasonCode => ({ state: 'unknown', reasonCode });
const secret = 'PRIVATE_MARKER';
const meta = projectId => JSON.stringify({ response: { conversationMetadata: { metadata: { projectId } } } });
const error = (code, extra = {}) => Object.assign(Error(secret), { code, ...extra });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'completion-wake-'));
  const executable = join(root, process.platform === 'win32' ? 'selected.exe' : 'selected');
  await writeFile(executable, 'inert test fixture; never execute');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, executable };
}

function runner(specs = [{}], inspect = () => {}) {
  const calls = [];
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  function run(file, args, options, callback) {
    const child = new EventEmitter();
    child.kills = [];
    child.kill = signal => { child.kills.push(signal); };
    calls.push({ file, args, options, child });
    inspect(calls.at(-1));
    const spec = specs.shift();
    assert.ok(spec, 'unexpected subprocess/retry');
    started();
    queueMicrotask(() => {
      if (!spec.noSpawn) child.emit('spawn');
      if (!spec.never) callback(spec.error ?? null, spec.stdout ?? secret, spec.stderr ?? secret);
    });
    return child;
  }
  return { run, calls, ready };
}

function bounds(options) {
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.windowsVerbatimArguments, false);
  assert.equal(options.timeout, 5000);
  assert.equal(options.maxBuffer, 16384);
  assert.equal(options.encoding, 'utf8');
  assert.equal(options.killSignal, 'SIGKILL');
}

test('W01 invalid destinations and unsupported hosts never dispatch', async () => {
  let calls = 0;
  const forbidden = () => { calls++; throw Error('must not dispatch'); };
  for (const patch of [{ sessionId: '--last' }, { receiptId: receiptId + '\n' }, { sessionId: null },
    { receiptId: '00000000-0000-0000-0000-000000000000' }]) {
    assert.deepEqual(await wakeCompletion({ host: 'codex', ...target, ...patch, run: forbidden, connect: forbidden }),
      unavailable('INVALID_WAKE_TARGET'));
  }
  for (const host of ['generic', 'gemini', 'claude', null]) {
    assert.deepEqual(await wakeCompletion({ host, ...target, run: forbidden, connect: forbidden }), unavailable('HOST_WAKE_UNSUPPORTED'));
  }
  for (const environment of [null, 'PRIVATE_MARKER', []]) {
    assert.deepEqual(await wakeCompletion({ host: 'codex', ...target, environment, run: forbidden }), unavailable('INVALID_WAKE_ENVIRONMENT'));
  }
  assert.equal(calls, 0);
});

test('W02 W10 Codex sends one exact marker with bounded argv and no resume or body', async t => {
  const { executable } = await fixture(t);
  const h = runner([{}]);
  const result = await wakeCompletion({ host: 'codex', ...target, executable, environment: {}, run: h.run,
    event: { output: secret }, message: secret });
  assert.deepEqual(result, { state: 'requested' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].file, executable);
  assert.deepEqual(h.calls[0].args, ['queue', '--thread', sessionId, '--message', marker]);
  bounds(h.calls[0].options);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('W03 Codex uses only an explicit file or official managed launcher', async t => {
  const { root } = await fixture(t);
  const launcher = join(root, 'bin', 'codex.js');
  await mkdir(join(root, 'bin'));
  await writeFile(launcher, 'inert launcher');
  const h = runner();
  assert.deepEqual(await wakeCompletion({ host: 'codex', ...target, environment: { CODEX_MANAGED_PACKAGE_ROOT: root }, run: h.run }),
    { state: 'requested' });
  assert.equal(h.calls[0].file, process.execPath);
  assert.deepEqual(h.calls[0].args, [launcher, 'queue', '--thread', sessionId, '--message', marker]);
  const never = () => assert.fail('invalid target must not dispatch');
  for (const executable of ['codex', root, join(root, 'missing'), join(root, 'codex.cmd')]) {
    assert.deepEqual(await wakeCompletion({ host: 'codex', ...target, executable, environment: {}, run: never }),
      unavailable('CODEX_EXECUTABLE_MISSING'));
  }
  for (const environment of [{ PATH: root }, { CODEX_MANAGED_PACKAGE_ROOT: 'relative' }]) {
    assert.deepEqual(await wakeCompletion({ host: 'codex', ...target, environment, run: never }), unavailable('CODEX_EXECUTABLE_MISSING'));
  }
  assert.deepEqual(await wakeCompletion({ host: 'codex', ...target, environment: { CODEX_MANAGED_PACKAGE_ROOT: join(root, 'bin') }, run: never }),
    unavailable('CODEX_NPM_LAUNCHER_MISSING'));
});

test('W04 Codex distinguishes spawn/no-active/uncertain failures without retransmission', async t => {
  const { executable } = await fixture(t);
  const cases = [
    [{ noSpawn: true, error: error('ENOENT') }, unavailable('CODEX_QUEUE_EXECUTABLE_MISSING')],
    [{ noSpawn: true, error: error('EACCES') }, unavailable('CODEX_QUEUE_SPAWN_FAILED')],
    [{ error: error(1), stderr: 'No active session found' }, unavailable('CODEX_NO_ACTIVE_SESSION')],
    [{ error: error(1) }, unknown('CODEX_QUEUE_EXIT_NONZERO')],
    [{ error: error('ETIMEDOUT') }, unknown('CODEX_QUEUE_TIMEOUT')],
    [{ error: error(null, { killed: true }), stderr: 'No active session found' }, unknown('CODEX_QUEUE_TIMEOUT')],
  ];
  for (const [spec, expected] of cases) {
    const h = runner([spec]);
    const result = await wakeCompletion({ host: 'codex', ...target, executable, environment: {}, run: h.run });
    assert.deepEqual(result, expected);
    assert.equal(h.calls.length, 1);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.deepEqual(await wakeCompletion({ host: 'codex', ...target, executable, environment: {}, run() { throw error('EACCES'); } }),
    unavailable('CODEX_QUEUE_SPAWN_FAILED'));
});

// NW11 replaces the obsolete private-socket success oracle with native-hook deferral.
test('W05 NW11 Claude defers to its native hook without reading private env or dispatching', async () => {
  const environment = {};
  for (const name of ['CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'UNRELATED_SECRET']) {
    Object.defineProperty(environment, name, { enumerable: true, get() { assert.fail('must not read private env'); } });
  }
  const result = await wakeCompletion({ host: 'claude-code', ...target, environment,
    run: () => assert.fail('no subprocess'), connect: () => assert.fail('no socket'), message: secret });
  assert.deepEqual(result, { state: 'deferred', reasonCode: 'CLAUDE_NATIVE_HOOK_WAITING' });
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('W06 Claude requires no messaging environment and never reports requested delivery', async () => {
  const result = await wakeCompletion({ host: 'claude-code', ...target, environment: {},
    run: () => assert.fail('no process'), connect: () => assert.fail('no socket') });
  assert.deepEqual(result, { state: 'deferred', reasonCode: 'CLAUDE_NATIVE_HOOK_WAITING' });
  assert.notEqual(result.state, 'requested');
});

const agyEnv = executable => ({ ANTIGRAVITY_PROJECT_ID: 'project-A', ANTIGRAVITY_AGENTAPI_EXE: executable,
  ANTIGRAVITY_LS_ADDRESS: 'current-ls', ANTIGRAVITY_CSRF_TOKEN: secret });
test('W07 agy verifies exact project before sending exact marker', async t => {
  const { executable } = await fixture(t);
  for (const host of ['antigravity', 'agy']) {
    const environment = agyEnv(executable), h = runner([{ stdout: meta('project-A') }, {}]);
    assert.deepEqual(await wakeCompletion({ host, ...target, environment, run: h.run }), { state: 'requested' });
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[0].args, ['agentapi', 'get-conversation-metadata', sessionId]);
    assert.deepEqual(h.calls[1].args, ['agentapi', 'send-message', sessionId, marker]);
    for (const call of h.calls) {
      assert.equal(call.file, executable);
      bounds(call.options);
      assert.deepEqual(call.options.env, environment);
      assert.notEqual(call.options.env, environment);
    }
  }
});

// W07b predeclared regression: explicit absolute file wins over absent/different env EXE.
// Procedure: inject matching metadata then send; assert both commands select that file.
// Reject invalid explicit files and mismatched projects without fallback/send. Actual: NOT_RUN.
test('W07b agy honors an explicit executable while preserving preflight and project checks', async t => {
  const { root, executable } = await fixture(t);
  for (const envExecutable of [undefined, join(root, 'different-env-executable')]) {
    const environment = agyEnv(envExecutable), h = runner([{ stdout: meta('project-A') }, {}]);
    delete environment.ANTIGRAVITY_AGENTAPI_EXE;
    if (envExecutable !== undefined) environment.ANTIGRAVITY_AGENTAPI_EXE = envExecutable;
    assert.deepEqual(await wakeCompletion({ host: 'antigravity', ...target, executable, environment, run: h.run }), { state: 'requested' });
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls.map(call => call.file), [executable, executable]);
    assert.deepEqual(h.calls[0].args, ['agentapi', 'get-conversation-metadata', sessionId]);
    assert.deepEqual(h.calls[1].args, ['agentapi', 'send-message', sessionId, marker]);
  }
  const never = () => assert.fail('invalid explicit executable must not fall back to env');
  for (const selected of ['agentapi', root, join(root, 'missing-explicit')]) {
    assert.deepEqual(await wakeCompletion({ host: 'antigravity', ...target, executable: selected, environment: agyEnv(executable), run: never }),
      unavailable('ANTIGRAVITY_AGENTAPI_UNAVAILABLE'));
  }
  const environment = agyEnv(undefined), h = runner([{ stdout: meta('project-B') }]);
  delete environment.ANTIGRAVITY_AGENTAPI_EXE;
  assert.deepEqual(await wakeCompletion({ host: 'antigravity', ...target, executable, environment, run: h.run }),
    unavailable('ANTIGRAVITY_PROJECT_MISMATCH'));
  assert.equal(h.calls.length, 1);
});

test('W08 agy requires current env without executable/auth discovery', async t => {
  const { executable } = await fixture(t);
  for (const [key, reason] of [['ANTIGRAVITY_PROJECT_ID', 'ANTIGRAVITY_PROJECT_ID_MISSING'],
    ['ANTIGRAVITY_AGENTAPI_EXE', 'ANTIGRAVITY_AGENTAPI_UNAVAILABLE'],
    ['ANTIGRAVITY_LS_ADDRESS', 'ANTIGRAVITY_LS_CONNECTION_MISSING'],
    ['ANTIGRAVITY_CSRF_TOKEN', 'ANTIGRAVITY_LS_CONNECTION_MISSING']]) {
    const environment = agyEnv(executable);
    delete environment[key];
    assert.deepEqual(await wakeCompletion({ host: 'antigravity', ...target, environment, run: () => assert.fail('must not run') }), unavailable(reason));
  }
});

test('W08 agy lookup failures and project mismatch never start send-message', async t => {
  const { executable } = await fixture(t);
  const cases = [
    [{ stdout: secret }, unavailable('ANTIGRAVITY_METADATA_INVALID')],
    [{ stdout: '{}' }, unavailable('ANTIGRAVITY_METADATA_PROJECT_MISSING')],
    [{ stdout: meta('project-B') }, unavailable('ANTIGRAVITY_PROJECT_MISMATCH')],
    [{ noSpawn: true, error: error('ENOENT') }, unavailable('ANTIGRAVITY_METADATA_EXECUTABLE_MISSING')],
    [{ error: error(1) }, unknown('ANTIGRAVITY_METADATA_EXIT_NONZERO')],
    [{ error: error('ETIMEDOUT') }, unknown('ANTIGRAVITY_METADATA_TIMEOUT')],
  ];
  for (const [spec, expected] of cases) {
    const h = runner([spec]);
    assert.deepEqual(await wakeCompletion({ host: 'antigravity', ...target, environment: agyEnv(executable), run: h.run }), expected);
    assert.equal(h.calls.length, 1);
  }
});

test('W09 W10 agy send failures do not retry or expose raw diagnostics', async t => {
  const { executable } = await fixture(t);
  for (const [spec, expected] of [
    [{ noSpawn: true, error: error('EACCES') }, unavailable('ANTIGRAVITY_SEND_SPAWN_FAILED')],
    [{ error: error(1) }, unknown('ANTIGRAVITY_SEND_EXIT_NONZERO')],
    [{ error: error('ETIMEDOUT') }, unknown('ANTIGRAVITY_SEND_TIMEOUT')],
  ]) {
    const h = runner([{ stdout: meta('project-A') }, spec]);
    const result = await wakeCompletion({ host: 'antigravity', ...target, environment: agyEnv(executable), run: h.run });
    assert.deepEqual(result, expected);
    assert.equal(h.calls.length, 2);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('W11 missing subprocess callback has a strict deadline and one kill', async t => {
  const { executable } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = runner([{ never: true }]);
  const pending = wakeCompletion({ host: 'codex', ...target, executable, environment: {}, run: h.run });
  await h.ready;
  await Promise.resolve();
  t.mock.timers.tick(4999);
  assert.equal(h.calls[0].child.kills.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, unknown('CODEX_QUEUE_TIMEOUT'));
  assert.deepEqual(h.calls[0].child.kills, ['SIGKILL']);
  assert.equal(h.calls.length, 1);
});
