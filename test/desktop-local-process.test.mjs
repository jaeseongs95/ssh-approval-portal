import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openLocalDesktopProcess } from '../src/adapters/desktop/local-process.mjs';
import { executionFailureDetails } from '../src/domain/execution-failure.mjs';

const command = source => '/usr/bin/python3 -I -B -S -X utf8 -c ' + "'" + source.replaceAll("'", "'\"'\"'") + "'";
const open = (source, options = {}) => openLocalDesktopProcess({ command: command(source), ...options });
const all = async stream => { const chunks = []; for await (const bytes of stream) chunks.push(bytes); return Buffer.concat(chunks); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('local helper preserves binary stdin/stdout and buffers early stderr separately', async () => {
  const lease = await open('import os,sys\nos.write(2,b"ready\\n")\ndata=sys.stdin.buffer.read()\nsys.stdout.buffer.write(data)\n');
  const bytes = Buffer.from([0, 255, 13, 10, 128, 0]);
  lease.stream.end(bytes);
  const stdout = await all(lease.stream), stderr = await all(lease.stderr), result = await lease.exitPromise;
  assert.deepEqual(stdout, bytes); assert.equal(stderr.toString(), 'ready\n');
  assert.equal(result.exitCode, 0); assert.equal(result.reason, 'exit'); assert.equal(result.remoteState, 'exited');
  assert.equal(result.cleanupComplete, true); assert.equal(result.error, undefined);
});

test('fixed minimal environment excludes parent credentials and bootstrap stays in stdin', async () => {
  const name = 'LOCAL_DESKTOP_TEST_PRIVATE_TOKEN';
  const previous = process.env[name]; process.env[name] = 'synthetic-parent-secret';
  try {
    const source = 'import os,sys,json\ndata=sys.stdin.buffer.read()\nprint(json.dumps({"env":dict(os.environ),"argv":sys.argv,"bytes":len(data)}))\n';
    const lease = await open(source), bootstrap = Buffer.from('synthetic-stdin-only-password');
    lease.stream.end(bootstrap);
    const output = JSON.parse((await all(lease.stream)).toString()), result = await lease.exitPromise;
    assert.equal(output.env[name], undefined); assert.equal(output.env.HOME, undefined);
    assert.equal(output.env.PATH, '/usr/bin:/bin'); assert.equal(output.env.LANG, 'C.UTF-8');
    assert.ok(Object.keys(output.env).every(key => ['PATH', 'LANG', 'PWD', 'LC_CTYPE'].includes(key)));
    assert.deepEqual(output.argv, ['-c']); assert.equal(output.bytes, bootstrap.length);
    assert.doesNotMatch(JSON.stringify(output), /synthetic-stdin-only-password|synthetic-parent-secret/);
    assert.doesNotMatch(result.stderr.text, /synthetic-/); assert.equal(result.cleanupComplete, true);
  } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
});

test('beforeDispatch refusal and cancellation during its await never start a process', async () => {
  let calls = 0;
  await assert.rejects(open('raise SystemExit(77)', { beforeDispatch: async () => { calls++; throw Error('denied fixture guard'); } }), /denied fixture guard/);
  assert.equal(calls, 1);
  let release; const waiting = new Promise(resolve => { release = resolve; }), controller = new AbortController();
  const pending = open('raise SystemExit(77)', { beforeDispatch: () => waiting, signal: controller.signal });
  controller.abort(); release();
  await assert.rejects(pending, error => executionFailureDetails(error).remoteOutcome === 'not_started');
  const pre = new AbortController(); pre.abort();
  await assert.rejects(open('raise SystemExit(77)', { signal: pre.signal }), error => executionFailureDetails(error).remoteOutcome === 'not_started');
  await assert.rejects(openLocalDesktopProcess({ command: 'printf unsupported' }), /invalid fixed helper command/);
});

test('idempotent close observes delayed TERM cleanup and an isolated child process group', async () => {
  const source = 'import os,sys,signal,time,json\ndef stop(*args):\n time.sleep(.12)\n print("stopped",file=sys.stderr,flush=True)\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nprint(json.dumps({"pid":os.getpid(),"group":os.getpgrp()}),flush=True)\nwhile True: time.sleep(.05)\n';
  const lease = await open(source), metadata = JSON.parse((await once(lease.stream, 'data'))[0].toString());
  assert.equal(metadata.pid, metadata.group); assert.notEqual(metadata.group, process.pid);
  const first = lease.close(); assert.equal(first, lease.close()); assert.equal(first, lease.exitPromise);
  let settled = false; first.then(() => { settled = true; }); await tick(); assert.equal(settled, false);
  const result = await first;
  assert.equal(result.reason, 'close'); assert.equal(result.remoteState, 'exited'); assert.equal(result.cleanupComplete, true);
  assert.equal(result.exitCode, 0); assert.equal(alive(metadata.pid), false);
  assert.equal(await lease.close(), result); assert.match(result.stderr.text, /stopped/);
});

test('abort terminates only the helper group and preserves the cancelling result', async () => {
  const controller = new AbortController();
  const lease = await open('import os,time\nprint(os.getpid(),flush=True)\nwhile True: time.sleep(1)\n', { signal: controller.signal });
  const pid = Number((await once(lease.stream, 'data'))[0].toString()); controller.abort();
  const result = await lease.exitPromise;
  assert.equal(result.reason, 'cancel'); assert.equal(result.signal, 'SIGTERM'); assert.equal(result.cleanupComplete, true);
  assert.equal(alive(pid), false); assert.equal(executionFailureDetails(result.error).automaticReplay, false);
});

test('uncooperative TERM handler is killed after the bounded grace window', async () => {
  const lease = await open('import os,signal,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nprint(os.getpid(),flush=True)\nwhile True: time.sleep(1)\n');
  const pid = Number((await once(lease.stream, 'data'))[0].toString());
  const result = await lease.close();
  assert.equal(result.reason, 'close'); assert.equal(result.signal, 'SIGKILL'); assert.equal(result.cleanupComplete, true);
  assert.equal(alive(pid), false);
});

test('owned descendants are terminated and reaped before cleanup is reported complete', async () => {
  const source = 'import os,sys,signal,subprocess,time,json\nchild=subprocess.Popen(["/usr/bin/python3","-I","-B","-S","-c","import time;time.sleep(60)"])\ndef stop(*args):\n child.terminate()\n child.wait(timeout=1)\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nprint(json.dumps({"pid":os.getpid(),"child":child.pid}),flush=True)\nwhile True: time.sleep(.1)\n';
  const lease = await open(source), pids = JSON.parse((await once(lease.stream, 'data'))[0].toString());
  const result = await lease.close();
  assert.equal(result.cleanupComplete, true); assert.equal(alive(pids.pid), false); assert.equal(alive(pids.child), false);
});

test('nonzero exit and stderr overflow remain typed and diagnostics stay bounded', async () => {
  const failed = await open('raise SystemExit(7)');
  const result = await failed.exitPromise;
  assert.equal(result.exitCode, 7); assert.equal(result.remoteState, 'exited'); assert.equal(result.cleanupComplete, true);
  assert.equal(executionFailureDetails(result.error).code, 'OPERATION_FAILED');
  const noisy = await open('import os,time\nos.write(2,b"!"*20480)\ntime.sleep(60)\n');
  const limited = await noisy.exitPromise;
  assert.equal(limited.reason, 'stderr_limit'); assert.equal(limited.stderr.retainedBytes, 16 * 1024);
  assert.ok(limited.stderr.receivedBytes > 16 * 1024); assert.equal(limited.stderr.truncated, true);
  assert.equal(limited.cleanupComplete, true); assert.equal((await all(noisy.stderr)).length, 16 * 1024);
});
