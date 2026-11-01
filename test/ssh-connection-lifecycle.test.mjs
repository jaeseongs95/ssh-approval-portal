import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SSHConnection } from 'ssh-mcp/build/ssh/connection.js';
import { createSshRuntime, createSshTransport } from '../src/adapters/ssh/vendor.mjs';
import { preparePythonSource } from '../src/adapters/ssh/python-source.mjs';
import { prepareAgentCliPlan } from '../src/adapters/ssh/agent-cli.mjs';

// Real pinned exec/openWithRetry/SftpClient, with only the SSH wire replaced.
// The regression oracle is externally visible: one failed request, no replay,
// a distinct future request succeeds, and an unrelated live channel survives.
const binding = { targetId: 'fixture', targetRevision: 'a'.repeat(64), profile: 'fixture-write' };
const inspection = { provider: 'codex', managed: false, installed: false, version: null, active: null, login: 'not_checked', installationRevision: 'b'.repeat(64) };
const tick = () => new Promise(resolve => setImmediate(resolve));

function channel(client, command) {
  const stream = new EventEmitter(); stream.stderr = new EventEmitter(); stream.stdin = [];
  stream.write = value => { stream.stdin.push(value); return true; };
  stream.end = () => {};
  stream.finish = (code = 0) => {
    if (stream.closed) return;
    stream.closed = true; stream.emit('data', Buffer.from(JSON.stringify(inspection))); stream.emit('close', code);
  };
  stream.close = () => stream.finish(); stream.signal = () => {};
  client.effects.push(command);
  if (command === 'hold') client.held = stream;
  else setImmediate(() => stream.finish(client.exitCode));
  return stream;
}

async function fixture(t, { via, closeMode = 'async' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ssh-lifecycle-'));
  const config = join(root, 'profiles.toml');
  await writeFile(config, `[defaults]\ndefaultProfile="fixture-write"\n[[profiles]]\nname="fixture-write"\nhost="127.0.0.1"\nuser="synthetic"\nauth="key"\nkeyRef="/synthetic-unused-key"\ntrustedHostKey="SHA256:synthetic"\nreadOnly=false\ntty=false\nannounceAgent=false\n`, { mode: 0o600 });
  const runtime = await createSshRuntime({ BRIDGE_CONFIG_PATH: config, BRIDGE_HOST_KEY_MODE: 'strict' });
  const profile = { ...runtime.registry.getProfile(binding.profile), timeout: 2000, transferTimeoutMs: 2000, ...(via ? { via } : {}) };
  const connections = [];
  let current, acquisitions = 0;
  const make = () => {
    const connection = new SSHConnection(profile, {}, new Map(), 'strict');
    const client = new EventEmitter();
    client.on('error', () => {});
    Object.assign(client, { opens: [], effects: [], failExec: false, failSftp: false, refuse: 0, ended: 0, destroyed: 0, exitCode: 0, closeMode });
    const closed = () => {
      if (connection.client === client) { connection.client = null; connection.connected = false; }
      client.emit('close');
    };
    client.end = () => { client.ended++; if (client.closeMode === 'sync') closed(); else if (client.closeMode === 'async') queueMicrotask(closed); };
    client.destroy = () => { client.destroyed++; closed(); };
    client.exec = (command, options, callback) => {
      client.opens.push({ kind: 'exec', command });
      if (client.defer) { client.deferred = callback; client.defer = false; return; }
      if (client.failExec || client.refuse-- > 0) { callback(Error('SYNTHETIC_PRIVATE channel refused')); return; }
      callback(null, channel(client, command));
    };
    client.sftp = callback => {
      client.opens.push({ kind: 'sftp' });
      if (client.failSftp) { callback(Error('SYNTHETIC_PRIVATE SFTP refused')); return; }
      const handle = new EventEmitter();
      handle.end = () => queueMicrotask(() => handle.emit('close'));
      handle.stat = (path, done) => done(client.fileError ? Object.assign(Error('SYNTHETIC_PRIVATE denied'), { code: 3 }) : null, { size: 1 });
      handle.createReadStream = () => Readable.from([Buffer.from('x')]);
      callback(null, handle);
    };
    connection.client = client; connection.connected = true;
    connection.ensureConnected = async () => { if (!connection.isConnected()) throw Error('Synthetic closed transport'); };
    connections.push(connection); return connection;
  };
  current = make();
  runtime.registry.getProfile = () => profile;
  runtime.registry.getOrCreate = async () => {
    acquisitions++;
    // The registry, not the lifecycle adapter, rebuilds a closed ProxyJump hop.
    if (!current.isConnected()) current = make();
    return current;
  };
  const transport = createSshTransport(runtime.registry);
  const invoke = async port => {
    if (port === 'command') return runtime.executeCommand(binding.profile, 'echo ok');
    if (port === 'source') return runtime.executePythonSource(preparePythonSource({ ...binding, source: "print('ok')\n", cwd: '/' }), () => binding);
    if (port === 'cli') return runtime.executeAgentCli(prepareAgentCliPlan({ action: 'inspect', provider: 'codex', binding }), () => binding);
    const session = await transport.connect(binding.profile);
    if (port === 'helper') return session.call('echo ok', {});
    if (port === 'upload') return session.upload(Readable.from(['x']), '/synthetic/file', { maxBytes: 1 });
    return session.download('/synthetic/file', new Writable({ write(chunk, encoding, done) { done(); } }), { maxBytes: 1 });
  };
  t.after(async () => {
    for (const connection of connections) {
      connection.client?.held?.finish(); connection.client?.deferred?.(Error('Fixture shutdown'));
      connection.client?.destroy();
    }
    await rm(root, { recursive: true, force: true });
  });
  return { runtime, transport, profile, invoke, connections, get connection() { return current; }, get acquisitions() { return acquisitions; } };
}

for (const port of ['command', 'source', 'cli', 'helper', 'upload', 'download']) {
  test(`SSH-RECOVER ${port}: exhausted opening fails once; a later request uses a fresh client`, async t => {
    const f = await fixture(t), old = f.connection, client = old.client;
    client[port === 'upload' || port === 'download' ? 'failSftp' : 'failExec'] = true;
    await assert.rejects(f.invoke(port));
    assert.equal(client.opens.length, 3); assert.equal(client.effects.length, 0); assert.equal(client.ended, 0);
    const result = await f.runtime.executeCommand(binding.profile, 'successor');
    assert.equal(result.failed, false);
    assert.notEqual(f.connection, old); assert.equal(client.ended, 1);
    assert.equal(client.opens.length, 3, 'The failed command must never be replayed');
    assert.deepEqual(f.connection.client.effects, ['successor']);
  });
}

test('SSH-RECOVER transient opening failure and remote nonzero do not discard the connection', async t => {
  const f = await fixture(t), old = f.connection, client = old.client;
  client.refuse = 1;
  assert.equal((await f.invoke('command')).failed, false);
  assert.equal(client.opens.length, 2); assert.equal(client.ended, 0);
  client.exitCode = 7;
  assert.equal((await f.invoke('command')).failed, true);
  client.exitCode = 0;
  assert.equal((await f.invoke('command')).failed, false);
  assert.equal(f.connection, old); assert.equal(client.ended, 0);
});

test('SSH-RECOVER a successful SFTP open followed by a file error does not discard', async t => {
  const f = await fixture(t), old = f.connection, client = old.client;
  client.fileError = true;
  await assert.rejects(f.invoke('upload'));
  await tick();
  assert.equal((await f.invoke('command')).failed, false);
  assert.equal(f.connection, old); assert.equal(client.ended, 0);
});

test('SSH-RECOVER live work blocks retirement; its completion permits future recovery', { timeout: 10000 }, async t => {
  const f = await fixture(t), old = f.connection, client = old.client;
  const running = f.runtime.executeCommand(binding.profile, 'hold');
  while (!client.held) await tick();
  client.failExec = true;
  await assert.rejects(f.invoke('command'));
  await assert.rejects(f.runtime.executeCommand(binding.profile, 'blocked'));
  assert.equal(client.ended, 0); assert.equal(client.held.closed, undefined);
  assert.ok(!client.opens.some(item => item.command === 'blocked'));
  client.held.finish(); assert.equal((await running).failed, false);
  assert.equal((await f.runtime.executeCommand(binding.profile, 'after-drain')).failed, false);
  assert.equal(client.ended, 1); assert.notEqual(f.connection, old);
});

test('SSH-RECOVER opening callback still pending after timeout prevents destroying its client', async t => {
  const f = await fixture(t), client = f.connection.client;
  f.profile.timeout = 20; client.defer = true;
  await assert.rejects(f.invoke('command'));
  assert.equal(client.ended, 0, 'A command timeout alone is not a channel refusal');
  f.profile.timeout = 2000; client.failExec = true;
  await assert.rejects(f.invoke('command'));
  await assert.rejects(f.invoke('command'));
  assert.equal(client.ended, 0, 'Unacknowledged opening may still dispatch remotely');
  client.deferred(Error('Late opening refused'));
  assert.equal((await f.runtime.executeCommand(binding.profile, 'after-late-close')).failed, false);
  assert.equal(client.ended, 1);
});

test('SSH-RECOVER original cleanup client is never replaced by a fresh connection', async t => {
  const f = await fixture(t), old = f.connection, client = old.client;
  const session = await f.transport.connect(binding.profile, { cleanup: { platform: 'linux', helper: '/synthetic/helper', id: 'c'.repeat(48) } });
  await session.call('first-stage', {});
  client.failExec = true; await assert.rejects(f.invoke('command'));
  assert.equal((await f.runtime.executeCommand(binding.profile, 'new-request')).failed, false);
  assert.notEqual(f.connection, old);
  await assert.rejects(async () => session.cleanup());
  assert.deepEqual(f.connection.client.effects, ['new-request']);
  assert.deepEqual(client.effects, ['first-stage']);
});

test('SSH-RECOVER ProxyJump reconstruction stays in registry and concurrent successors close once', async t => {
  const f = await fixture(t, { via: 'synthetic-bastion', closeMode: 'sync' }), old = f.connection, client = old.client;
  client.failExec = true; await assert.rejects(f.invoke('command'));
  const result = await Promise.all([f.runtime.executeCommand(binding.profile, 'next-a'), f.runtime.executeCommand(binding.profile, 'next-b')]);
  assert.ok(result.every(item => !item.failed)); assert.equal(client.ended, 1);
  assert.notEqual(f.connection, old); assert.equal(f.connection.profile.via, 'synthetic-bastion');
  assert.deepEqual(f.connection.client.effects.sort(), ['next-a', 'next-b']);
});

test('SSH-RECOVER a delayed close never ends a replacement client', async t => {
  const f = await fixture(t, { closeMode: 'stall' }), old = f.connection, client = old.client;
  client.failExec = true; await assert.rejects(f.invoke('command'));
  assert.equal((await f.runtime.executeCommand(binding.profile, 'after-bounded-close')).failed, false);
  assert.equal(client.ended, 1); assert.equal(client.destroyed, 1);
  const replacement = f.connection.client;
  client.emit('close'); client.emit('error', Error('late synthetic event'));
  assert.equal(replacement.ended, 0); assert.equal(replacement.destroyed, 0);
  assert.notEqual(f.connection, old);
});
