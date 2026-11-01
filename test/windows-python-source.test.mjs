import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
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
const replaceOnce = (text, before, after) => {
  assert.equal(text.split(before).length, 2, '진단 계측점은 원문에서 한 번만 나타나야 합니다.');
  return text.replace(before, after);
};
// 최초 원시험의 source/argv/cwd/frame은 그대로 두고 수신기 복사본만 계측한다.
// 추가 sys/time 가져오기·관측문·해시가 초기화와 시점을 바꿀 가능성은 남는다.
const diagnosticBootstrapOf = (p, { auditPath, redirectOutput = false, closeWriter = false } = {}) => {
  const audit = name => auditPath ? `with open(bytes.fromhex('${Buffer.from(auditPath).toString('hex')}').decode('utf-8'),'a',encoding='utf-8') as f:f.write(str(time.time_ns()//1000000)+'|${name}\\n');f.flush()\n` : '';
  const pyStage = name => audit(name + ':before-stderr')
    + `sys.stderr.write('AGS_PY_STAGE|'+str(time.time_ns()//1000000)+'|${name}\\n');sys.stderr.flush()\n` + audit(name + ':after-stderr');
  let receiver = replaceOnce(receiverOf(p), 'import hashlib,json,os,sys,types\n',
    `import sys,time\n${pyStage('receiver-entry')}import hashlib,json,os,sys,types\n${pyStage('receiver-imports-complete')}`);
  receiver = replaceOnce(receiver, 'b=sys.stdin.buffer.read(n+1)\n', `${pyStage('receiver-read-start')}b=sys.stdin.buffer.read(n+1)\n${pyStage('receiver-read-complete')}`);
  receiver = replaceOnce(receiver, "if v['elevate']:", `${pyStage('frame-verified')}if v['elevate']:`);
  receiver = replaceOnce(receiver, 'try:\n c=compile', `${pyStage('source-compile-start')}try:\n c=compile`);
  receiver = replaceOnce(receiver, "sys.argv=['<ssh-python-source-v1>',*v['argv']]", `${pyStage('source-compiled')}sys.argv=['<ssh-python-source-v1>',*v['argv']]`);
  receiver = replaceOnce(receiver, 'exec(c,m.__dict__)\n', `${pyStage('source-start')}exec(c,m.__dict__)\n${pyStage('source-complete')}`);
  assert.equal(receiver.split('\n').filter(line => line !== 'import sys,time'
    && !line.startsWith("sys.stderr.write('AGS_PY_STAGE|") && !line.startsWith('with open(bytes.fromhex(')).join('\n'), receiverOf(p),
    '고정 관측문과 추가 가져오기를 제거하면 제품 receiver 원문과 같아야 합니다.');
  const psStage = name => `psstage '${name}';`;
  const original = launcherOf(p);
  let launcher = original;
  launcher = replaceOnce(launcher, "$ErrorActionPreference='Stop';", "$ErrorActionPreference='Stop';function psstage([string]$stage){[Console]::Error.WriteLine('AGS_PY_STAGE|'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+'|'+$stage)};" + psStage('launcher-start'));
  launcher = replaceOnce(launcher, 'Microsoft.PowerShell.Core\\Import-Module', psStage('module-start') + 'Microsoft.PowerShell.Core\\Import-Module');
  launcher = replaceOnce(launcher, 'Microsoft.PowerShell.Utility\\Add-Type', psStage('module-complete') + psStage('add-type-start') + 'Microsoft.PowerShell.Utility\\Add-Type');
  launcher = replaceOnce(launcher, '-ErrorAction Stop};$s=', '-ErrorAction Stop;' + psStage('add-type-complete') + '};$s=');
  launcher = replaceOnce(launcher, '$p=[Diagnostics.Process]::Start($s);', psStage('child-start') + '$p=[Diagnostics.Process]::Start($s);' + psStage('child-started'));
  launcher = replaceOnce(launcher, 'try{while(($n=', "$total=0;$hash=[Security.Cryptography.SHA256]::Create();try{" + psStage('native-read-start') + 'while(($n=');
  launcher = replaceOnce(launcher, '{$i.Write($b,0,$n)}}finally{$i.Close()};$p.WaitForExit();',
    "{[void]$hash.TransformBlock($b,0,$n,$b,0);$total+=$n;psstage ('native-read-bytes:'+$n+':'+$total);$i.Write($b,0,$n);psstage ('child-written:'+$total)}[void]$hash.TransformFinalBlock([byte[]]::new(0),0,0);psstage ('native-eof:'+$total+':'+[BitConverter]::ToString($hash.Hash).Replace('-','').ToLowerInvariant())}finally{" + psStage('child-input-close') + '$i.Close();$hash.Dispose()};' + psStage('child-wait-start') + '$p.WaitForExit();' + psStage('child-exited'));
  launcher = replaceOnce(launcher, 'exit $p.ExitCode', psStage('launcher-exit') + 'exit $p.ExitCode');
  const startup = original.slice(original.indexOf('$s=[Diagnostics.ProcessStartInfo]::new();'), original.indexOf('if(-not [IO.File]::Exists'));
  assert.ok(startup.length > 0 && launcher.includes(startup), 'Python 실행파일과 전체 인수는 제품과 정확히 같아야 합니다.');
  // 제품 인수 문자열에서 고정 receiver 한 부분만 치환한다. 원문 프레임·길이·해시·옵션은 그대로다.
  launcher = replaceOnce(launcher, receiverOf(p).replaceAll("'", "''"), receiver.replaceAll("'", "''"));
  assert.ok(launcher.includes(startup.replace(receiverOf(p).replaceAll("'", "''"), receiver.replaceAll("'", "''"))),
    '계측 receiver 외의 Python 실행파일·옵션·프레임 길이와 해시는 변하면 안 됩니다.');
  launcher = replaceOnce(launcher, '$i=$p.StandardInput.BaseStream;', '$i=$p.StandardInput.BaseStream;$inputHandle=$i.SafeFileHandle;');
  launcher = replaceOnce(launcher, '$i.Close();$hash.Dispose()', (closeWriter ? '$p.StandardInput.Close();' : '$i.Close();')
    + "psstage ('child-input-handle-closed:'+$inputHandle.IsClosed);$hash.Dispose()");
  launcher = replaceOnce(launcher, '$p.WaitForExit();', "while(-not $p.WaitForExit(1000)){$p.Refresh();psstage ('child-wait-pending:pid:'+$p.Id+':cpu-ms:'+$p.TotalProcessorTime.TotalMilliseconds+':handles:'+$p.HandleCount)};");
  if (redirectOutput) {
    launcher = replaceOnce(launcher, '$s.RedirectStandardInput=$true;', '$s.RedirectStandardInput=$true;$s.RedirectStandardOutput=$true;$s.RedirectStandardError=$true;');
    launcher = replaceOnce(launcher, '$p=[Diagnostics.Process]::Start($s);', '$p=[Diagnostics.Process]::Start($s);$outTask=$p.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput());$errTask=$p.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError());');
    launcher = replaceOnce(launcher, "psstage 'child-exited';", "[Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($outTask,$errTask));psstage 'child-exited';");
  }
  const bootstrap = `& ([scriptblock]::Create([IO.StreamReader]::new([IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('${gzipSync(launcher, { level: 9 }).toString('base64')}')),[IO.Compression.CompressionMode]0)).ReadToEnd()))`;
  assert.doesNotMatch(bootstrap, /["$`%\r\n]/);
  assert.ok(bootstrap.length + p.command.length - launcherBootstrapOf(p).length <= 8000);
  return { bootstrap, receiver, launcherSha256: createHash('sha256').update(launcher).digest('hex'), receiverSha256: createHash('sha256').update(receiver).digest('hex') };
};
const observeAudit = async (t, label, path) => {
  try { t.diagnostic(JSON.stringify({ 진단: '동일 원문 수신기 독립 관측', 경로종류: label, 파일단계: (await readFile(path, 'utf8')).trim().split('\n') })); }
  catch (error) { if (error.code !== 'ENOENT') throw error; t.diagnostic(JSON.stringify({ 진단: '동일 원문 수신기 독립 관측', 경로종류: label, 파일생성: false })); }
};
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
const run = (t, label, p, input = p.transportStdin, host = 'direct', diagnosticBootstrap, diagnosticReceiver) => traceInput(t, label, p, input, () => new Promise(resolve => {
  const started = Date.now();
  // Node의 cmd.exe 셸 호출과 동일하게 바깥 따옴표를 보존하고 CRT 재인용을 막는다.
  const child = spawn(host === 'python' ? p.manifest.interpreter : host === 'cmd' ? 'cmd.exe' : 'powershell.exe', host === 'python' ? p.args.map((value, index) => index === 6 && diagnosticReceiver ? diagnosticReceiver : value)
    : host === 'cmd' ? ['/d', '/s', '/c', `"${p.command}"`]
    : powershellArguments(host === 'powershell-shell' ? p.command : diagnosticBootstrap ?? launcherBootstrapOf(p)),
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: host === 'cmd' });
  const events = [], stdout = [], stderr = [];
  const event = stage => {
    const now = Date.now();
    events.push({ 단계: stage, 세계시밀리초: now, 경과밀리초: now - started });
  };
  let error, completed = false;
  const finish = (status = child.exitCode, signal = child.signalCode) => {
    if (completed) return;
    completed = true;
    clearTimeout(deadline);
    const result = { status, signal, error, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
    if (error || diagnosticBootstrap) t.diagnostic(JSON.stringify({ 진단: 'Python 직접 실행 수명', 프로세스번호: child.pid, 시작세계시밀리초: started, 종료세계시밀리초: Date.now(), 사건: events,
      stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr), errorCode: error?.code,
      원계획BootstrapSha256: p.manifest.launcherBootstrapSha256,
      실행BootstrapSha256: createHash('sha256').update(diagnosticBootstrap ?? launcherBootstrapOf(p)).digest('hex') }));
    resolve(result);
  };
  const deadline = setTimeout(() => {
    event('20초 제한 도달');
    error = Object.assign(Error('Python direct process timed out'), { code: 'ETIMEDOUT' });
    child.kill();
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    finish();
  }, 20_000);
  child.once('spawn', () => event('프로세스 시작'));
  child.once('error', failure => { error = failure; event('프로세스 오류'); });
  child.once('exit', () => event('프로세스 종료'));
  child.once('close', (status, signal) => { event('스트림 닫힘'); finish(status, signal); });
  child.stdout.on('data', bytes => { if (!stdout.length) event('표준 출력 최초 수신'); stdout.push(bytes); });
  child.stderr.on('data', bytes => { if (!stderr.length) event('표준 오류 최초 수신'); stderr.push(bytes); });
  child.stdout.once('end', () => event('표준 출력 종료'));
  child.stderr.once('end', () => event('표준 오류 종료'));
  child.stdin.once('error', failure => { error ??= failure; event('입력 오류'); });
  child.stdin.once('finish', () => event('입력 종료 전달'));
  child.stdin.end(input);
}));

test('Windows PowerShell 5.1 forwards source bytes and literal arguments without BOM or newline transformation', {
  skip: !ciWindows, timeout: 90_000, concurrency: true,
}, async t => {
  assert.ok(pythonExecutable, 'Windows CI must supply the fixed SOLID_PYTHON or PYTHON executable');
  const cwd = await mkdtemp(join(tmpdir(), 'windows-source-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const options = { pythonExecutable, cwd };
  const attackMarker = join(cwd, 'injection.txt');
  const literal = ['한글', "a'b", 'a"b', 'C:\\tail\\', '', '‘’“”', quotePayload(attackMarker)];
  const source = "import json,os,sys\r\nassert sys.stdin.buffer.read()==b''\r\nassert '__file__' not in globals()\r\nassert __package__ is None and __spec__ is None\r\nprint(json.dumps([sys.argv[1:],os.getcwd(),__name__],ensure_ascii=False))\r\n";
  const firstPlan = plan(source, { ...options, argv: literal });
  assert.equal(firstPlan.manifest.sourceBytes, 217);
  assert.equal(firstPlan.manifest.transportBytes, 608);
  // 각 경로는 처음부터 명시한 비교 사례다. 불명 결과에 따른 자동 재실행이 아니다.
  // 병렬 시작은 같은 초기 상태의 비교를 돕지만 초기화·자원 경합에 영향을 줄 수 있다.
  await Promise.all([
    ...[
    ['원시험 상속 출력', 'direct', {}], ['Node 직접 Python', 'python', {}],
    ['명시 바이트 출력 연결', 'direct', { redirectOutput: true }], ['입력 writer 추가 닫기', 'direct', { closeWriter: true }],
  ].map(([label, host, variant]) => t.test(label, { timeout: 25_000 }, async sub => {
    const auditPath = join(cwd, 'audit-' + (host === 'python' ? 'native' : variant.redirectOutput ? 'redirect' : variant.closeWriter ? 'writer' : 'original') + '.txt');
    const instrumented = diagnosticBootstrapOf(firstPlan, { auditPath, ...variant });
    sub.diagnostic(JSON.stringify({ 진단: '최초 동일 원문 경로 비교', 경로종류: label, 기준계획Digest: firstPlan.planDigest,
      계측LauncherSha256: instrumented.launcherSha256, 계측ReceiverSha256: instrumented.receiverSha256,
      원ReceiverSha256: firstPlan.manifest.receiverSha256, sourceSha256: firstPlan.manifest.sourceSha256,
      sourceBytes: firstPlan.manifest.sourceBytes, frameBytes: firstPlan.manifest.transportBytes, 프레임변경: false,
      Python인수변경: '고정 receiver 관측 복사본만', 출력연결: variant.redirectOutput ? '명시 바이트 복사' : '기존 상속', 입력writer추가닫기: !!variant.closeWriter,
      실행방식: host, 시점영향가능: true }));
    const good = await run(sub, '동일 원문: ' + label, firstPlan, firstPlan.transportStdin, host, instrumented.bootstrap, instrumented.receiver);
    const stages = good.stderr.split(/\r?\n/).filter(line => line.startsWith('AGS_PY_STAGE|'));
    sub.diagnostic(JSON.stringify({ 진단: '최초 동일 원문 경로 비교', 경로종류: label, 관측단계: stages }));
    await observeAudit(sub, label, auditPath);
    assert.ifError(good.error);
    assert.equal(good.status, 0, good.stderr);
    assert.deepEqual(JSON.parse(good.stdout), [literal, cwd, '__main__']);
    if (host !== 'python') {
      assert.ok(stages.some(line => line.endsWith(`|native-eof:${firstPlan.manifest.transportBytes}:${firstPlan.manifest.transportSha256}`)));
      assert.ok(stages.some(line => line.endsWith('|child-input-handle-closed:True')));
      assert.ok(stages.some(line => line.endsWith('|launcher-exit')));
    }
    for (const stage of ['receiver-entry', 'receiver-imports-complete', 'receiver-read-start', 'receiver-read-complete',
      'frame-verified', 'source-compile-start', 'source-compiled', 'source-start', 'source-complete']) {
      assert.ok(stages.some(line => line.endsWith('|' + stage)), `수신기 계측 누락: ${stage}`);
    }
    await assert.rejects(access(attackMarker), { code: 'ENOENT' });
  })),
    t.test('실제 SSH 동일608프레임·원제품명령', { timeout: 25_000 }, async sub => {
      const fixture = JSON.parse(await readFile(process.env.AGS_WINDOWS_SSH_FIXTURE, 'utf8'));
      const { createSshRuntime } = await import('../src/adapters/ssh/vendor.mjs');
      const runtime = await createSshRuntime({ BRIDGE_CONFIG_PATH: fixture.adminConfigPath, BRIDGE_HOST_KEY_MODE: 'strict' });
      sub.after(() => runtime.registry.closeAll());
      const connection = await runtime.registry.getOrCreate('admin-write');
      const result = await traceInput(sub, '실제 SSH: 최초와 동일한 원문608프레임', firstPlan, firstPlan.transportStdin,
        () => connection.exec(firstPlan.command, { stdin: firstPlan.transportStdin, timeoutMs: 20_000 }));
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [literal, cwd, '__main__']);
      await assert.rejects(access(attackMarker), { code: 'ENOENT' });
    }),
  ]);
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
