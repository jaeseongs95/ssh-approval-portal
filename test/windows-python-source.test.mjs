import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preparePythonSource, preparePythonHelper, WINDOWS_PYTHON_SOURCE_ENVIRONMENT_REVISION } from '../src/adapters/ssh/python-source.mjs';

const binding = { platform: 'windows', cwd: 'C:\\', pythonExecutable: 'C:\\Program Files\\Python\\python.exe',
  targetId: 'fixture', targetRevision: 'a'.repeat(64), profile: 'fixture-write' };
const plan = (source, options = {}) => preparePythonSource({ ...binding, source, ...options });
const launcherOf = p => Buffer.from(p.command.split(' ').at(-1), 'base64').toString('utf16le');

test('Windows source binds its exact runtime, bytes, environment, argv and administrator-token requirement', () => {
  const source = "print('한글 source stays on stdin')\r\n";
  const argv = ['a"b', '한글', 'C:\\tail\\', "a'b", '$(ignored); &'];
  const p = plan(source, { argv });
  assert.equal(p.stdin, source);
  assert.equal(p.manifest.sourceBytes, Buffer.byteLength(source));
  assert.equal(p.manifest.platform, 'windows');
  assert.equal(p.manifest.interpreter, binding.pythonExecutable);
  assert.equal(p.manifest.environmentRevision, WINDOWS_PYTHON_SOURCE_ENVIRONMENT_REVISION);
  assert.match(p.command, /^powershell\.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand [A-Za-z0-9+/=]+$/);
  assert.ok(p.command.length <= 8000);
  assert.doesNotMatch(launcherOf(p), /source stays on stdin|WriteLine|\|/);
  assert.match(launcherOf(p), /OpenStandardInput\(\)\.CopyTo\(\$p\.StandardInput\.BaseStream\)/);
  assert.match(launcherOf(p), /StandardInput\.BaseStream\.Close\(\)/);
  assert.doesNotMatch(launcherOf(p), /StandardInput\.Close\(\)/);
  assert.doesNotMatch(JSON.stringify(p.manifest), /source stays on stdin/);
  for (const options of [{ source: source + '\n' }, { argv: ['changed'] }, { cwd: 'C:\\Temp' },
    { pythonExecutable: 'D:\\Runtime\\python.exe' }, { elevate: true }, { profile: 'other' },
    { targetRevision: 'b'.repeat(64) }, { targetId: 'other' }]) {
    assert.notEqual(plan(source, { argv, ...options }).planDigest, p.planDigest);
  }
  assert.match(launcherOf(plan('pass', { elevate: true })), /WindowsPrincipal.*WindowsIdentity.*Administrator/);
  assert.doesNotMatch(launcherOf(plan('pass', { elevate: true })), /RunAs|Verb|sudo/);
  assert.equal(Object.isFrozen(p), true);
  assert.equal(Object.isFrozen(p.args), true);
  assert.equal(Object.isFrozen(p.manifest), true);
});

test('Windows source rejects ambiguous runtime/platform, invalid input and command overflow; source and helper bounds remain separate', () => {
  for (const options of [{ platform: 'unknown' }, { pythonExecutable: undefined }, { pythonExecutable: 'python.exe' },
    { pythonExecutable: 'C:python.exe' }, { pythonExecutable: '\\\\host\\share\\python.exe' },
    { pythonExecutable: 'C:\\x\\..\\python.exe' }, { pythonExecutable: 'C:\\x:stream\\python.exe' },
    { pythonExecutable: 'C:\\x\\py.exe' }, { cwd: '/' }, { cwd: 'C:relative' }, { cwd: 'C:\\a\\..\\b' },
    { environmentRevision: '0'.repeat(64) }, { elevate: 'true' }, { argv: ['\n'] }, { argv: ['\ud800'] },
    { argv: Array(17).fill('x') }, { argv: ['x'.repeat(513)] }, { argv: Array(7).fill('x'.repeat(512)) }]) {
    assert.throws(() => plan('pass', options));
  }
  for (const source of ['', '\ud800', 'x\0x', 'x'.repeat(16_385)]) assert.throws(() => plan(source));
  assert.equal(plan('x'.repeat(16_384)).manifest.sourceBytes, 16_384);
  const helper = preparePythonHelper({ ...binding, source: 'x'.repeat(65_536) });
  assert.equal(helper.manifest.sourceBytes, 65_536);
  assert.notEqual(helper.manifest.receiverSha256, plan('pass').manifest.receiverSha256);
  assert.throws(() => preparePythonHelper({ ...binding, source: 'x'.repeat(65_537) }));
});

const pythonExecutable = process.env.SOLID_PYTHON ?? process.env.PYTHON;
const ciWindows = process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true';
const run = (p, input = p.stdin) => spawnSync('powershell.exe', p.command.split(' ').slice(1), {
  input, encoding: 'utf8', windowsHide: true, timeout: 20_000,
});

test('Windows PowerShell 5.1 forwards source bytes and literal arguments without BOM or newline transformation', {
  skip: !ciWindows, timeout: 90_000,
}, async t => {
  assert.ok(pythonExecutable, 'Windows CI must supply the fixed SOLID_PYTHON or PYTHON executable');
  const cwd = await mkdtemp(join(tmpdir(), 'windows-source-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const options = { pythonExecutable, cwd };
  const literal = ['한글', "a'b", 'a"b', 'C:\\tail\\', '', '$env:PATH; & ignored'];
  const source = "import json,os,sys\r\nassert sys.stdin.buffer.read()==b''\r\nassert '__file__' not in globals()\r\nprint(json.dumps([sys.argv[1:],os.getcwd(),__name__],ensure_ascii=False))\r\n";
  const good = run(plan(source, { ...options, argv: literal }));
  assert.ifError(good.error);
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(JSON.parse(good.stdout), [literal, cwd, '__main__']);
  const longSource = '# 한글 원본\r\n' + '# padding\n'.repeat(6000) + 'print("helper exact bytes")\n';
  const helper = run(preparePythonHelper({ ...binding, ...options, source: longSource }));
  assert.ifError(helper.error);
  assert.equal(helper.status, 0, helper.stderr);
  assert.match(helper.stdout, /helper exact bytes/);
  const missing = run(plan('pass', { ...options, pythonExecutable: join(cwd, 'missing', 'python.exe') }));
  assert.ifError(missing.error);
  assert.equal(missing.status, 127);
  assert.match(missing.stderr, /Configured Python executable unavailable/);
});

test('Windows source rejects truncated, altered and trailing bytes before effects and waits for EOF', {
  skip: !ciWindows, timeout: 90_000,
}, async t => {
  assert.ok(pythonExecutable, 'Windows CI must supply the fixed SOLID_PYTHON or PYTHON executable');
  const cwd = await mkdtemp(join(tmpdir(), 'windows-source-integrity-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const marker = join(cwd, 'effect.txt');
  const prefix = 'import pathlib,sys\npathlib.Path(sys.argv[1]).write_text("once",encoding="utf-8")\n';
  const p = plan(prefix + "print('한글')\n", { pythonExecutable, cwd, argv: [marker] });
  const bytes = Buffer.from(p.stdin), altered = Buffer.from(bytes);
  altered[0] = 'x'.charCodeAt(0);
  for (const input of [Buffer.from(prefix), altered, Buffer.concat([bytes, Buffer.from('\n')]), Buffer.alloc(0)]) {
    const result = run(p, input);
    assert.ifError(result.error);
    assert.equal(result.status, 125, result.stderr);
    await assert.rejects(access(marker), { code: 'ENOENT' });
  }
  const child = spawn('powershell.exe', p.command.split(' ').slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.resume(); child.stderr.resume();
  const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const deadline = setTimeout(() => child.kill(), 20_000);
  t.after(() => { clearTimeout(deadline); if (child.exitCode === null) child.kill(); });
  child.stdin.write(p.stdin);
  await new Promise(resolve => setTimeout(resolve, 1000));
  await assert.rejects(access(marker), { code: 'ENOENT' });
  assert.equal(child.exitCode, null);
  child.stdin.end();
  assert.equal(await finished, 0);
  assert.equal(await readFile(marker, 'utf8'), 'once');
});

test('실제 Windows SSH의 Python 실행·비관리자 상승 거부·전송 전 승인·원문 무결성', {
  skip: !process.env.AGS_WINDOWS_SSH_FIXTURE, timeout: 180_000,
}, async t => {
  assert.equal(ciWindows, true);
  const fixture = JSON.parse(await readFile(process.env.AGS_WINDOWS_SSH_FIXTURE, 'utf8'));
  const runtimePath = fixture.pythonExecutable ?? pythonExecutable;
  assert.ok(runtimePath, 'Windows SSH fixture must provide the fixed Python executable');
  const { createSshRuntime } = await import('../src/adapters/ssh/vendor.mjs');
  const runtime = await createSshRuntime({ BRIDGE_CONFIG_PATH: fixture.configPath, BRIDGE_HOST_KEY_MODE: 'strict' });
  t.after(() => runtime.registry.closeAll());
  const fixed = { ...binding, pythonExecutable: runtimePath, cwd: fixture.fileRoot, profile: 'windows-write' };
  const prepare = (source, rest = {}) => preparePythonSource({ ...fixed, source, ...rest });
  const verify = () => ({ targetId: fixed.targetId, targetRevision: fixed.targetRevision,
    profile: fixed.profile, platform: fixed.platform, pythonExecutable: fixed.pythonExecutable });
  const result = await runtime.executePythonSource(prepare("print('원문 실행 성공')\n"), verify);
  assert.equal(result.failed, false);
  assert.deepEqual(result.texts, ['원문 실행 성공\n']);

  const marker = join(fixture.fileRoot, 'python-source-effect.txt');
  const effect = 'import pathlib,sys\npathlib.Path(sys.argv[1]).write_text("executed",encoding="utf-8")\n';
  const operation = prepare(effect, { argv: [marker] });
  await assert.rejects(runtime.executePythonSource(operation, verify, () => { throw Error('승인 만료'); }), /승인 만료|unknown/i);
  await assert.rejects(access(marker), { code: 'ENOENT' });
  const denied = await runtime.executePythonSource(prepare(effect, { argv: [marker], elevate: true }), verify);
  assert.equal(denied.failed, true);
  assert.match(denied.texts.join(''), /Administrator connection token required/);
  await assert.rejects(access(marker), { code: 'ENOENT' });

  const connection = await runtime.registry.getOrCreate('windows-write');
  const bytes = Buffer.from(operation.stdin);
  for (const input of [bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from('\n')])]) {
    const rejected = await connection.exec(operation.command, { stdin: input });
    assert.equal(rejected.exitCode, 125);
    await assert.rejects(access(marker), { code: 'ENOENT' });
  }
  const longSource = '# 한글 원본\r\n' + '# padding\n'.repeat(6000) + "print('SSH helper bytes intact')\n";
  const helper = preparePythonHelper({ ...fixed, source: longSource });
  const raw = await connection.exec(helper.command, { stdin: helper.stdin });
  assert.equal(raw.exitCode, 0, raw.stderr);
  assert.equal(raw.stdout, 'SSH helper bytes intact\n');
});
