import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { preparePythonSource, preparePythonHelper, WINDOWS_PYTHON_SOURCE_ENVIRONMENT_REVISION } from '../src/adapters/ssh/python-source.mjs';

const binding = { platform: 'windows', cwd: 'C:\\', pythonExecutable: 'C:\\Program Files\\Python\\python.exe',
  targetId: 'fixture', targetRevision: 'a'.repeat(64), profile: 'fixture-write' };
const plan = (source, options = {}) => preparePythonSource({ ...binding, source, ...options });
const launcherBootstrapOf = p => p.command.slice(p.command.indexOf('-Command "') + 10, -1);
const powershellArguments = command => ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command];
const launcherOf = p => {
  const bootstrap = launcherBootstrapOf(p);
  assert.equal(createHash('sha256').update(bootstrap).digest('hex'), p.manifest.launcherBootstrapSha256);
  const launcher = gunzipSync(Buffer.from(bootstrap.match(/FromBase64String\('([^']+)'\)/)[1], 'base64')).toString('utf8');
  assert.equal(createHash('sha256').update(launcher).digest('hex'), p.manifest.launcherSha256);
  return launcher;
};
const receiverOf = p => p.args[6];
const quotePayload = marker => `’;[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}','injected');}catch{};#`;
const maximumArgv = Array.from({ length: 8 }, (_, index) => 'x'.repeat(index === 7 ? 508 : 509));
const traceInput = async (t, label, p, input, execute) => {
  const started = Date.now();
  const context = { 진단: 'Python 입력 단계', 단계: label, 시작시각: new Date(started).toISOString(),
    commandSha256: createHash('sha256').update(p.command).digest('hex'),
    frameBytes: Buffer.byteLength(input), frameSha256: createHash('sha256').update(input).digest('hex'),
    expectedFrameBytes: p.manifest.transportBytes, expectedFrameSha256: p.manifest.transportSha256,
    sourceBytes: p.manifest.sourceBytes, receiverSha256: p.manifest.receiverSha256 };
  t.diagnostic(JSON.stringify({ ...context, 사건: '시작' }));
  try {
    const result = await execute();
    t.diagnostic(JSON.stringify({ ...context, 사건: result?.error ? '실행 오류' : '종료', 종료시각: new Date().toISOString(),
      경과밀리초: Date.now() - started, exitCode: result?.exitCode ?? result?.status ?? (typeof result === 'number' ? result : undefined), signal: result?.signal,
      errorCode: result?.error?.code, stdoutBytes: Buffer.byteLength(result?.stdout ?? result?.texts?.join('') ?? ''),
      stderrBytes: Buffer.byteLength(result?.stderr ?? '') }));
    return result;
  } catch (error) {
    t.diagnostic(JSON.stringify({ ...context, 사건: '호출 오류', 종료시각: new Date().toISOString(),
      경과밀리초: Date.now() - started, errorCode: error?.code, 오류: error?.message }));
    throw error;
  }
};

test('Windows source binds its exact runtime, bytes, environment, argv and administrator-token requirement', () => {
  const source = "print('한글 source stays on stdin')\r\n";
  const argv = ['a"b', '한글', 'C:\\tail\\', "a'b", '$(ignored); &'];
  const p = plan(source, { argv });
  assert.equal(p.stdin, source);
  assert.equal(p.manifest.sourceBytes, Buffer.byteLength(source));
  assert.equal(p.manifest.transportBytes, Buffer.byteLength(p.transportStdin));
  const frame = Buffer.from(p.transportStdin), prefixEnd = frame.indexOf(10) + 1;
  const headerBytes = Number(frame.subarray(0, prefixEnd).toString());
  assert.deepEqual(frame.subarray(prefixEnd + headerBytes), Buffer.from(source));
  assert.deepEqual(JSON.parse(frame.subarray(prefixEnd, prefixEnd + headerBytes)), {
    sourceBytes: p.manifest.sourceBytes, sourceSha256: p.manifest.sourceSha256, argv, cwd: binding.cwd, elevate: false,
  });
  assert.equal(p.manifest.platform, 'windows');
  assert.equal(p.manifest.interpreter, binding.pythonExecutable);
  assert.equal(p.manifest.environmentRevision, WINDOWS_PYTHON_SOURCE_ENVIRONMENT_REVISION);
  assert.match(p.command, /^powershell\.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "& \(.+\)"$/);
  assert.doesNotMatch(launcherBootstrapOf(p), /["$`%\r\n]/);
  assert.ok(p.command.length <= 8000);
  assert.doesNotMatch(launcherOf(p), /source stays on stdin|StandardInput\.(?:Write|WriteLine)\s*\(/);
  assert.match(launcherOf(p), /\$i=\$p\.StandardInput\.BaseStream;\$b=\[byte\[\]\]::new\(8192\);try\{while\(\(\$n=\[SshApproval\.Stdin\]::Read\(\$b,0,\$b\.Length\)\) -gt 0\)\{\$i\.Write\(\$b,0,\$n\)\}/);
  assert.doesNotMatch(launcherOf(p), /Console\]::OpenStandardInput|ConsoleStream/);
  assert.match(launcherOf(p), /finally\{\$i\.Close\(\)\}/);
  assert.doesNotMatch(launcherOf(p), /StandardInput\.Close\(\)/);
  assert.doesNotMatch(JSON.stringify(p.manifest), /source stays on stdin/);
  for (const options of [{ source: source + '\n' }, { argv: ['changed'] }, { cwd: 'C:\\Temp' },
    { pythonExecutable: 'D:\\Runtime\\python.exe' }, { elevate: true }, { profile: 'other' },
    { targetRevision: 'b'.repeat(64) }, { targetId: 'other' }]) {
    assert.notEqual(plan(source, { argv, ...options }).planDigest, p.planDigest);
  }
  assert.match(receiverOf(plan('pass', { elevate: true })), /if v\['elevate'\]:\n import ctypes\n if not ctypes\.windll\.shell32\.IsUserAnAdmin\(\)/);
  assert.ok(receiverOf(p).indexOf('IsUserAnAdmin()') < receiverOf(p).indexOf('c=compile('));
  assert.doesNotMatch(launcherOf(plan('pass', { elevate: true })), /RunAs|Verb|sudo/);
  assert.equal(Object.isFrozen(p), true);
  assert.equal(Object.isFrozen(p.args), true);
  assert.equal(Object.isFrozen(p.manifest), true);
  const smart = plan('pass', { pythonExecutable: 'C:\\‘’“”\\python.exe', cwd: 'C:\\‘’“”', argv: ['‘’“”', '’; calc.exe; }catch{};#'] });
  assert.doesNotMatch(launcherOf(smart), /[‘’“”]|calc\.exe/);
  assert.match(launcherOf(smart), /\$s\.FileName=\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('[A-Za-z0-9+/=]+'\)\)/);
  assert.match(launcherOf(smart), /\$s\.Arguments='/);
  for (const path of ['C:\\hostedtoolcache\\windows\\Python\\3.12.10\\x64\\python.exe',
    'C:/hostedtoolcache/windows/Python/3.13.9/x64/python.exe']) {
    assert.equal(plan('pass', { pythonExecutable: path }).manifest.interpreter, path);
  }
});

test('Windows source rejects ambiguous runtime/platform, invalid input and command overflow; source and helper bounds remain separate', () => {
  for (const options of [{ platform: 'unknown' }, { pythonExecutable: undefined }, { pythonExecutable: 'python.exe' },
    { pythonExecutable: 'C:python.exe' }, { pythonExecutable: '\\\\host\\share\\python.exe' },
    { pythonExecutable: 'C:\\x\\..\\python.exe' }, { pythonExecutable: 'C:\\x:stream\\python.exe' },
    { pythonExecutable: 'C:\\x\\py.exe' }, { pythonExecutable: ['C:\\Python\\python.exe'] },
    { cwd: '/' }, { cwd: 'C:relative' }, { cwd: 'C:\\a\\..\\b' },
    { environmentRevision: '0'.repeat(64) }, { elevate: 'true' }, { argv: ['\n'] }, { argv: ['\ud800'] },
    { argv: Array(17).fill('x') }, { argv: ['x'.repeat(513)] }, { argv: Array(8).fill('x'.repeat(512)) }]) {
    assert.throws(() => plan('pass', options));
  }
  for (const source of ['', '\ud800', 'x\0x', 'x'.repeat(16_385)]) assert.throws(() => plan(source));
  assert.equal(plan('x'.repeat(16_384)).manifest.sourceBytes, 16_384);
  const helper = preparePythonHelper({ ...binding, source: 'x'.repeat(65_536) });
  assert.equal(helper.manifest.sourceBytes, 65_536);
  assert.notEqual(helper.manifest.receiverSha256, plan('pass').manifest.receiverSha256);
  assert.throws(() => preparePythonHelper({ ...binding, source: 'x'.repeat(65_537) }));
  const maximum = plan('pass', { argv: maximumArgv });
  assert.equal(Buffer.byteLength(maximum.manifest.argvJson), 4096);
  assert.ok(maximum.command.length <= 8000);
  assert.ok(plan('pass', { argv: maximumArgv, elevate: true }).command.length <= 8000);
  assert.throws(() => plan('pass', { argv: maximumArgv.map((value, index) => value + (index === 7 ? 'x' : '')) }));
  const maximumPath = 'C:\\' + 'p'.repeat(498) + '\\python.exe';
  const maximumCwd = 'C:\\' + 'w'.repeat(509);
  assert.equal(Buffer.byteLength(maximumPath), 512);
  assert.equal(Buffer.byteLength(maximumCwd), 512);
  for (const prepare of [preparePythonSource, preparePythonHelper]) {
    const extreme = prepare({ ...binding, source: 'pass', argv: maximumArgv, elevate: true,
      pythonExecutable: maximumPath, cwd: maximumCwd });
    assert.ok(extreme.command.length <= 8000);
  }
});

const pythonExecutable = process.env.SOLID_PYTHON ?? process.env.PYTHON;
const ciWindows = process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true';
// 실제 SSH와 동일하게 비동기로 입력을 닫고 출력을 동시에 비운다.
// 제한은 유지하고 실패 시 어느 수명 단계가 끝났는지에 한정해 남긴다.
const run = (t, label, p, input = p.transportStdin, host = 'direct') => traceInput(t, label, p, input, () => new Promise(resolve => {
  // Node의 cmd.exe 셸 호출과 동일하게 바깥 따옴표를 보존하고 CRT 재인용을 막는다.
  const child = spawn(host === 'cmd' ? 'cmd.exe' : 'powershell.exe', host === 'cmd' ? ['/d', '/s', '/c', `"${p.command}"`]
    : powershellArguments(host === 'powershell-shell' ? p.command : launcherBootstrapOf(p)),
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: host === 'cmd' });
  const events = [], stdout = [], stderr = [];
  let error, completed = false;
  const finish = (status = child.exitCode, signal = child.signalCode) => {
    if (completed) return;
    completed = true;
    clearTimeout(deadline);
    const result = { status, signal, error, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
    if (error) t.diagnostic(JSON.stringify({ 진단: 'Python 직접 실행 수명', 사건: events,
      stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr), errorCode: error.code }));
    resolve(result);
  };
  const deadline = setTimeout(() => {
    events.push('20초 제한 도달');
    error = Object.assign(Error('Python direct process timed out'), { code: 'ETIMEDOUT' });
    child.kill();
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    finish();
  }, 20_000);
  child.once('spawn', () => events.push('프로세스 시작'));
  child.once('error', failure => { error = failure; events.push('프로세스 오류'); });
  child.once('exit', () => events.push('프로세스 종료'));
  child.once('close', (status, signal) => { events.push('스트림 닫힘'); finish(status, signal); });
  child.stdout.on('data', bytes => stdout.push(bytes));
  child.stderr.on('data', bytes => stderr.push(bytes));
  child.stdin.once('error', failure => { error ??= failure; events.push('입력 오류'); });
  child.stdin.once('finish', () => events.push('입력 종료 전달'));
  child.stdin.end(input);
}));

test('Windows PowerShell 5.1 forwards source bytes and literal arguments without BOM or newline transformation', {
  skip: !ciWindows, timeout: 90_000,
}, async t => {
  assert.ok(pythonExecutable, 'Windows CI must supply the fixed SOLID_PYTHON or PYTHON executable');
  const cwd = await mkdtemp(join(tmpdir(), 'windows-source-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const options = { pythonExecutable, cwd };
  const attackMarker = join(cwd, 'injection.txt');
  const literal = ['한글', "a'b", 'a"b', 'C:\\tail\\', '', '‘’“”', quotePayload(attackMarker)];
  const source = "import json,os,sys\r\nassert sys.stdin.buffer.read()==b''\r\nassert '__file__' not in globals()\r\nassert __package__ is None and __spec__ is None\r\nprint(json.dumps([sys.argv[1:],os.getcwd(),__name__],ensure_ascii=False))\r\n";
  const good = await run(t, '직접 실행: 한글·따옴표 인자', plan(source, { ...options, argv: literal }));
  assert.ifError(good.error);
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(JSON.parse(good.stdout), [literal, cwd, '__main__']);
  await assert.rejects(access(attackMarker), { code: 'ENOENT' });
  for (const host of ['cmd', 'powershell-shell']) {
    const throughShell = await run(t, `기본 셸 ${host}: 한글·따옴표 인자`, plan(source, { ...options, argv: literal }), undefined, host);
    assert.ifError(throughShell.error);
    assert.equal(throughShell.status, 0, throughShell.stderr);
    assert.deepEqual(JSON.parse(throughShell.stdout), [literal, cwd, '__main__']);
    await assert.rejects(access(attackMarker), { code: 'ENOENT' });
  }
  const maximum = await run(t, '직접 실행: 최대 인자 4096바이트', plan(source, { ...options, argv: maximumArgv }));
  assert.ifError(maximum.error);
  assert.equal(maximum.status, 0, maximum.stderr);
  assert.deepEqual(JSON.parse(maximum.stdout), [maximumArgv, cwd, '__main__']);
  const helperBase = '# 한글 원본\r\nprint("helper exact bytes")\n#';
  const longSource = helperBase + 'x'.repeat(65_536 - Buffer.byteLength(helperBase));
  const helper = await run(t, '직접 실행: 보조 소스 65536바이트', preparePythonHelper({ ...binding, ...options, source: longSource }));
  assert.ifError(helper.error);
  assert.equal(helper.status, 0, helper.stderr);
  assert.match(helper.stdout, /helper exact bytes/);
  const missing = await run(t, '직접 실행: 런타임 없음', plan('pass', { ...options, pythonExecutable: join(cwd, 'missing', 'python.exe') }));
  assert.ifError(missing.error);
  assert.equal(missing.status, 127);
  assert.match(missing.stderr, /Python executable unavailable/);
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
  const bytes = Buffer.from(p.transportStdin), altered = Buffer.from(bytes);
  altered[0] = 'x'.charCodeAt(0);
  for (const [label, input] of [['부분 원문', Buffer.from(prefix)], ['손상 프레임', altered],
    ['추가 바이트', Buffer.concat([bytes, Buffer.from('\n')])], ['빈 입력', Buffer.alloc(0)]]) {
    const result = await run(t, '직접 실행: ' + label, p, input);
    assert.ifError(result.error);
    assert.equal(result.status, 125, result.stderr);
    await assert.rejects(access(marker), { code: 'ENOENT' });
  }
  const closed = await traceInput(t, '직접 실행: 지연 입력 종료', p, p.transportStdin, async () => {
    const child = spawn('powershell.exe', powershellArguments(launcherBootstrapOf(p)), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.resume(); child.stderr.resume();
    const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const deadline = setTimeout(() => child.kill(), 20_000);
    t.after(() => { clearTimeout(deadline); if (child.exitCode === null) child.kill(); });
    child.stdin.write(p.transportStdin);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await assert.rejects(access(marker), { code: 'ENOENT' });
    assert.equal(child.exitCode, null);
    child.stdin.end();
    return finished;
  });
  assert.equal(closed, 0);
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
  const call = (label, p, execute, input = p.transportStdin) => traceInput(t, '실제 SSH: ' + label, p, input, execute);
  const simple = prepare("print('원문 실행 성공')\n");
  const result = await call('정상 원문', simple, () => runtime.executePythonSource(simple, verify));
  assert.equal(result.failed, false);
  assert.deepEqual(result.texts, ['원문 실행 성공\r\n']);

  const marker = join(fixture.fileRoot, 'python-source-effect.txt');
  const effect = 'import pathlib,sys\npathlib.Path(sys.argv[1]).write_text("executed",encoding="utf-8")\n';
  const operation = prepare(effect, { argv: [marker] });
  await assert.rejects(call('전송 전 승인 만료', operation,
    () => runtime.executePythonSource(operation, verify, () => { throw Error('승인 만료'); })), /승인 만료|unknown/i);
  await assert.rejects(access(marker), { code: 'ENOENT' });
  const elevatedEffect = prepare(effect, { argv: [marker], elevate: true });
  const denied = await call('비관리자 상승 거부', elevatedEffect, () => runtime.executePythonSource(elevatedEffect, verify));
  assert.equal(denied.failed, true);
  assert.match(denied.texts.join(''), /Administrator connection token required/);
  await assert.rejects(access(marker), { code: 'ENOENT' });

  const connection = await runtime.registry.getOrCreate('windows-write');
  const attackMarker = join(fixture.fileRoot, 'python-injection.txt');
  const literal = ['한글', `공백 ' "`, '‘’“”', quotePayload(attackMarker)];
  const base = 'import json,os,sys\nassert sys.stdin.buffer.read()==b""\nprint(json.dumps([sys.argv[1:],os.getcwd()],ensure_ascii=False))\n';
  const source = base + '# 한글 원본\n' + '#' + 'x'.repeat(16_384 - Buffer.byteLength(base + '# 한글 원본\n#'));
  const exact = prepare(source, { argv: literal });
  assert.equal(exact.manifest.sourceBytes, 16_384);
  assert.equal(exact.manifest.sourceSha256, createHash('sha256').update(Buffer.from(source, 'utf8')).digest('hex'));
  const literalResult = await call('원문 16384바이트·한글·따옴표 인자', exact,
    () => connection.exec(exact.command, { stdin: exact.transportStdin }));
  assert.equal(literalResult.exitCode, 0, literalResult.stderr);
  assert.deepEqual(JSON.parse(literalResult.stdout), [literal, fixture.fileRoot]);
  await assert.rejects(access(attackMarker), { code: 'ENOENT' });
  const maximum = prepare(base, { argv: maximumArgv });
  const maximumResult = await call('최대 인자 4096바이트', maximum,
    () => connection.exec(maximum.command, { stdin: maximum.transportStdin }));
  assert.equal(maximumResult.exitCode, 0, maximumResult.stderr);
  assert.deepEqual(JSON.parse(maximumResult.stdout), [maximumArgv, fixture.fileRoot]);
  await assert.rejects(call('전송 계획 변조 거부', operation,
    () => runtime.executePythonSource({ ...operation, transportStdin: operation.transportStdin + '\n' }, verify), operation.transportStdin + '\n'), /plan changed/);
  const bytes = Buffer.from(operation.transportStdin);
  for (const [label, input] of [['잘린 프레임', bytes.subarray(0, bytes.length - 1)],
    ['추가 바이트', Buffer.concat([bytes, Buffer.from('\n')])]]) {
    const rejected = await call(label, operation, () => connection.exec(operation.command, { stdin: input }), input);
    assert.equal(rejected.exitCode, 125);
    await assert.rejects(access(marker), { code: 'ENOENT' });
  }
  const helperBase = "# 한글 원본\r\nprint('SSH helper bytes intact')\n#";
  const longSource = helperBase + 'x'.repeat(65_536 - Buffer.byteLength(helperBase));
  const helper = preparePythonHelper({ ...fixed, source: longSource });
  const raw = await call('보조 소스 65536바이트', helper, () => connection.exec(helper.command, { stdin: helper.transportStdin }));
  assert.equal(raw.exitCode, 0, raw.stderr);
  assert.equal(raw.stdout, 'SSH helper bytes intact\r\n');

  assert.ok(fixture.adminConfigPath && fixture.adminFileRoot, '관리자 SSH 시험 경로가 필요합니다.');
  const admin = await createSshRuntime({ BRIDGE_CONFIG_PATH: fixture.adminConfigPath, BRIDGE_HOST_KEY_MODE: 'strict' });
  t.after(() => admin.registry.closeAll());
  const adminPlan = prepare("import json,sys\nassert len(json.dumps(sys.argv[1:],separators=(',',':')).encode())==4096\nprint('administrator token verified')\n", {
    cwd: fixture.adminFileRoot, elevate: true, profile: 'admin-write', argv: maximumArgv,
  });
  const elevated = await call('관리자 상승·최대 인자', adminPlan,
    () => admin.executePythonSource(adminPlan, () => ({ ...verify(), profile: 'admin-write' })));
  assert.equal(elevated.failed, false);
  assert.deepEqual(elevated.texts, ['administrator token verified\r\n']);
});
