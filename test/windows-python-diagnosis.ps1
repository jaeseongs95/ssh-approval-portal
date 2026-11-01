param(
    [Parameter(Mandatory = $true)][string] $BaselineRoot,
    [Parameter(Mandatory = $true)][string] $CandidateRoot,
    [Parameter(Mandatory = $true)][string] $EvidenceRoot
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = $OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $IsWindows) { throw '이 진단은 GitHub Actions Windows 실행기에서만 실행합니다.' }
$BaselineRoot = [IO.Path]::GetFullPath($BaselineRoot)
$CandidateRoot = [IO.Path]::GetFullPath($CandidateRoot)
$EvidenceRoot = [IO.Path]::GetFullPath($EvidenceRoot)
[IO.Directory]::CreateDirectory($EvidenceRoot) | Out-Null
$pythonExecutable = [IO.Path]::GetFullPath([string](@(Get-Command python.exe -CommandType Application -ErrorAction Stop)[0].Source))
$env:SOLID_PYTHON = $pythonExecutable
$hostFacts = [ordered]@{
    powershell = $PSVersionTable.PSVersion.ToString()
    framework = [Runtime.InteropServices.RuntimeInformation]::FrameworkDescription
    os = [Runtime.InteropServices.RuntimeInformation]::OSDescription
    pythonExecutable = $pythonExecutable
    pythonSha256 = (Get-FileHash -LiteralPath $pythonExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
    imageOS = $env:ImageOS
    imageVersion = $env:ImageVersion
    runnerOS = $env:RUNNER_OS
    runnerArch = $env:RUNNER_ARCH
}
[IO.File]::WriteAllText((Join-Path $EvidenceRoot 'host.json'), ($hostFacts | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))

# 제품과 기존 시험은 수정하지 않습니다. 아래 Node 프로그램은 실행기 임시 경로에만 씁니다.
$diagnosisSource = @'
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import os from 'node:os';

const [baselineRoot, candidateRoot, evidenceRoot, python] = process.argv.slice(2).map(value => resolve(value));
assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
const hash = value => createHash('sha256').update(value).digest('hex');
const save = async (name, value) => writeFile(join(evidenceRoot, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
const emit = value => console.log(JSON.stringify(value));
const psargs = command => ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command];
const encode = text => Buffer.from(text, 'utf16le').toString('base64');
const psliteral = value => `'${value.replaceAll("'", "''")}'`;
const bootstrapOf = command => `& ([scriptblock]::Create([IO.StreamReader]::new([IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('${gzipSync(command, { level: 9 }).toString('base64')}')),[IO.Compression.CompressionMode]0)).ReadToEnd()))`;
const snapshotCommand = rootPid => `$ErrorActionPreference='Stop';$all=@(Get-CimInstance Win32_Process);$ids=@(${rootPid});$rows=@();for($n=0;$n -lt 6;$n++){ $children=@($all|Where-Object { $ids -contains $_.ParentProcessId });if($children.Count -eq 0){break};$rows+= $children;$ids=@($children.ProcessId) };@($all|Where-Object {$_.ProcessId -eq ${rootPid}})+$rows|Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate,KernelModeTime,UserModeTime,ThreadCount,HandleCount|ConvertTo-Json -Depth 4 -Compress`;

// 수명 대조 제한은 원시험과 같은 20초입니다. 기존 시험 실행기는 원래의 90초 상한을 유지합니다.
async function run(label, executable, args, { input = '', cwd = candidateRoot, inspect = true, limitMs = 20_000 } = {}) {
  const started = Date.now(), events = [], stdout = [], stderr = [], snapshots = [];
  const event = (stage, extra = {}) => events.push({ stage, elapsedMs: Date.now() - started, ...extra });
  let result, timer, inspectTimer, sampling = Promise.resolve(), finished = false, cleaning;
  const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const observe = () => new Promise(done => {
    const probe = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encode(snapshotCommand(child.pid))], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    const deadline = setTimeout(() => { probe.kill(); done(); }, 4_000);
    probe.stdout.on('data', b => out.push(b)); probe.stderr.on('data', b => err.push(b));
    probe.once('error', e => { snapshots.push({ elapsedMs: Date.now() - started, error: e.message }); clearTimeout(deadline); done(); });
    probe.once('close', code => { clearTimeout(deadline); snapshots.push({ elapsedMs: Date.now() - started, code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }); done(); });
  });
  const finish = status => {
    if (finished) return;
    finished = true; clearTimeout(timer); clearTimeout(inspectTimer);
    result = { label, executable, argsSha256: hash(JSON.stringify(args)), inputBytes: Buffer.byteLength(input), inputSha256: hash(input), deadlineMs: limitMs, started: new Date(started).toISOString(), elapsedMs: Date.now() - started, ...status, events,
      stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), snapshots };
  };
  await new Promise(done => {
    child.once('spawn', () => { event('프로세스 시작', { pid: child.pid });
      if (inspect) inspectTimer = setTimeout(() => { sampling = observe(); }, 2_000);
    });
    child.once('error', error => { event('프로세스 오류'); finish({ state: 'SPAWN_ERROR', error: error.message, code: error.code }); done(); });
    child.once('exit', (code, signal) => event('프로세스 종료', { code, signal }));
    child.once('close', (code, signal) => { event('스트림 닫힘', { code, signal }); finish({ state: 'EXITED', code, signal }); done(); });
    child.stdout.on('data', b => { if (!stdout.length) event('표준 출력 최초 수신'); stdout.push(b); });
    child.stderr.on('data', b => { if (!stderr.length) event('표준 오류 최초 수신'); stderr.push(b); });
    child.stdin.on('error', error => event('입력 오류', { code: error.code, message: error.message }));
    child.stdin.once('finish', () => event('입력 종료 전달'));
    timer = setTimeout(() => {
      event('기존 제한 도달', { limitMs });
      // 자식 트리 전체 종료도 이 실행에서 만든 프로세스 번호에만 한정합니다.
      cleaning = new Promise(cleaned => {
        const cleanup = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        const cleanupTimer = setTimeout(() => { cleanup.kill(); cleaned(); }, 5_000);
        cleanup.once('error', () => { clearTimeout(cleanupTimer); cleaned(); });
        cleanup.once('close', code => { event('시간초과 트리 정리', { code }); clearTimeout(cleanupTimer); cleaned(); });
      });
      finish({ state: 'TIMED_OUT', code: null });
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); done();
    }, limitMs);
    child.stdin.end(input);
  });
  await sampling;
  if (cleaning) await cleaning;
  result.snapshots = snapshots;
  await save(`${label}.json`, result);
  emit({ 진단: label, 상태: result.state, 종료코드: result.code, 경과밀리초: result.elapsedMs, 출력바이트: Buffer.byteLength(result.stdout), 오류바이트: Buffer.byteLength(result.stderr) });
  return result;
}

const facts = { node: process.version, nodeExecutable: process.execPath, nodeSha256: hash(await readFile(process.execPath)), osRelease: os.release(), osVersion: os.version(), arch: os.arch(), python, pythonSha256: hash(await readFile(python)), roots: { baselineRoot, candidateRoot } };
const tracked = ['src/adapters/ssh/python-source.mjs', 'src/adapters/ssh/windows-python-source.mjs', 'src/adapters/ssh/windows-stdin.mjs', 'src/contracts/ports.mjs', 'test/windows-python-source.test.mjs'];
const fingerprints = {};
for (const [label, root] of [['baseline', baselineRoot], ['candidate', candidateRoot]]) {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  fingerprints[label] = { commit: git.stdout.trim(), files: {} };
  for (const path of tracked) fingerprints[label].files[path] = hash(await readFile(join(root, path)));
}
assert.equal(fingerprints.baseline.commit, '8c437e62157ed501a5029632d084a24d030902ca');
fingerprints.filesEqual = tracked.every(path => fingerprints.baseline.files[path] === fingerprints.candidate.files[path]);
await save('fingerprints.json', fingerprints); await save('runtime.json', facts); emit({ 지문: fingerprints });
await run('python-runtime', python, ['-I', '-B', '-S', '-X', 'utf8', '-c', "import json,os,platform,sys; print(json.dumps({'executable':sys.executable,'version':sys.version,'winVersion':str(sys.getwindowsversion()),'architecture':platform.machine(),'prefix':sys.prefix,'basePrefix':sys.base_prefix}));"], { inspect: false });
await run('powershell-runtime', 'powershell.exe', psargs("[ordered]@{version=$PSVersionTable.PSVersion.ToString();clr=[Environment]::Version.ToString();os=[Environment]::OSVersion.VersionString;bitness=[Environment]::Is64BitProcess}|ConvertTo-Json -Compress"), { inspect: false });

const fixture = join(evidenceRoot, 'fixture'); await mkdir(fixture, { recursive: true });
const marker = join(fixture, 'injection.txt');
const quotePayload = `’;[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}','injected');}catch{};#`;
const argv = ['한글', "a'b", 'a"b', 'C:\\tail\\', '', '‘’“”', quotePayload];
const source = "import json,os,sys\r\nassert sys.stdin.buffer.read()==b''\r\nassert '__file__' not in globals()\r\nassert __package__ is None and __spec__ is None\r\nprint(json.dumps([sys.argv[1:],os.getcwd(),__name__],ensure_ascii=False))\r\n";
const expected = [argv, fixture, '__main__'];
const replaceOnce = (text, before, after) => { assert.equal(text.split(before).length, 2, `계측점 불일치: ${before}`); return text.replace(before, after); };
const cases = [];
for (const [label, root] of [['baseline', baselineRoot], ['candidate', candidateRoot]]) {
  const { preparePythonSource } = await import(pathToFileURL(join(root, 'src/adapters/ssh/python-source.mjs')).href);
  const p = preparePythonSource({ platform: 'windows', pythonExecutable: python, cwd: fixture, source, argv, targetId: 'fixture', targetRevision: 'a'.repeat(64), profile: 'fixture-write' });
  const bootstrap = p.command.slice(p.command.indexOf('-Command "') + 10, -1);
  assert.equal(hash(bootstrap), p.manifest.launcherBootstrapSha256);
  const launcher = gunzipSync(Buffer.from(bootstrap.match(/FromBase64String\('([^']+)'\)/)[1], 'base64')).toString('utf8');
  assert.equal(hash(launcher), p.manifest.launcherSha256); assert.equal(hash(p.args[6]), p.manifest.receiverSha256);
  await save(`${label}-plan.json`, { manifest: p.manifest, planDigest: p.planDigest, argsSha256: hash(JSON.stringify(p.args)), commandSha256: hash(p.command) });
  // 기존 시험은 원문 그대로, 이름으로 한 경계만 선택합니다. 내부20초 제한도 그대로입니다.
  const regression = await run(`${label}-original-regression`, process.execPath, ['--test', '--test-name-pattern', '^Windows PowerShell 5\\.1 forwards source bytes', 'test/windows-python-source.test.mjs'], { cwd: root, inspect: true, limitMs: 90_000 });
  regression.oraclePassed = regression.state === 'EXITED' && regression.code === 0 && /forwards source bytes/.test(regression.stdout) && !/tests 0(?:\D|$)/.test(regression.stdout);
  cases.push({ case: `${label}-original-regression`, state: regression.state, code: regression.code, oraclePassed: regression.oraclePassed });
  const original = await run(`${label}-original-launcher`, 'powershell.exe', psargs(bootstrap), { input: p.transportStdin });
  let direct = await run(`${label}-direct-receiver`, python, p.args, { input: p.transportStdin });
  const oracle = result => { try { return result.state === 'EXITED' && result.code === 0 && JSON.stringify(JSON.parse(result.stdout.trim())) === JSON.stringify(expected); } catch { return false; } };
  for (const [name, result] of [['original-launcher', original], ['direct-receiver', direct]]) cases.push({ case: `${label}-${name}`, state: result.state, code: result.code, oraclePassed: oracle(result) });
  // 파일은 상속된 stdout/stderr가 보이지 않더라도 수신기 도달 위치를 독립 관측합니다.
  const receiverTrace = join(evidenceRoot, `${label}-receiver-stages.jsonl`);
  const stage = name => `with open(${JSON.stringify(receiverTrace)},'a',encoding='utf-8') as _diagnosis: _diagnosis.write('${name}\\n')\n`;
  let receiver = stage('receiver-entry') + p.args[6];
  receiver = replaceOnce(receiver, 'b=sys.stdin.buffer.read(n+1)\n', stage('receiver-read-start') + 'b=sys.stdin.buffer.read(n+1)\n' + stage('receiver-read-complete'));
  receiver = replaceOnce(receiver, "if v['elevate']:", stage('frame-verified') + "if v['elevate']:");
  receiver = replaceOnce(receiver, 'exec(c,m.__dict__)\n', stage('source-start') + 'exec(c,m.__dict__)\n' + stage('source-complete'));
  const filtered = receiver.split('\n').filter(line => !line.startsWith('with open(')).join('\n');
  assert.equal(filtered, p.args[6], '파일 관측문 외 수신기는 원문과 같아야 합니다.');
  const instrumented = replaceOnce(launcher, p.args[6].replaceAll("'", "''"), receiver.replaceAll("'", "''"));
  const variants = [
    ['file-stages', instrumented],
    ['explicit-output-pipes', replaceOnce(replaceOnce(replaceOnce(instrumented, '$s.RedirectStandardInput=$true;', '$s.RedirectStandardInput=$true;$s.RedirectStandardOutput=$true;$s.RedirectStandardError=$true;'), '$p=[Diagnostics.Process]::Start($s);', '$p=[Diagnostics.Process]::Start($s);$out=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync();'), '$p.WaitForExit();exit $p.ExitCode', '$p.WaitForExit();[Console]::Out.Write($out.GetAwaiter().GetResult());[Console]::Error.Write($err.GetAwaiter().GetResult());exit $p.ExitCode')],
    ['writer-close', replaceOnce(instrumented, '$i.Close()', '$p.StandardInput.Close()')],
  ];
  for (const [variant, command] of variants) {
    await writeFile(receiverTrace, '');
    const diagnosticBootstrap = bootstrapOf(command);
    assert.ok(diagnosticBootstrap.length + p.command.length - bootstrap.length <= 8000, '관측 복사본도 제품 명령 길이 상한을 유지해야 합니다.');
    const result = await run(`${label}-${variant}`, 'powershell.exe', psargs(diagnosticBootstrap), { input: p.transportStdin });
    const stages = await readFile(receiverTrace, 'utf8');
    await save(`${label}-${variant}-stages.txt`, stages);
    cases.push({ case: `${label}-${variant}`, state: result.state, code: result.code, oraclePassed: oracle(result), receiverStages: stages.trim().split('\n').filter(Boolean), launcherSha256: hash(command), receiverSha256: hash(receiver), originalReceiverSha256: p.manifest.receiverSha256, inputSha256: hash(p.transportStdin) });
  }
}
const originalCases = cases.filter(c => /original-(regression|launcher)$/.test(c.case));
const summary = { status: originalCases.every(c => c.oraclePassed) ? 'ORIGINAL_BOUNDARY_PASS_DIAGNOSIS_ONLY' : 'ORIGINAL_BOUNDARY_FAILURE', fingerprints, cases,
  limitations: ['이 진단은 전체 Windows SSH 회귀나 출시 수용 판정이 아닙니다.', '파일 관측문·출력 리다이렉트·writer 닫기는 각각 수명·시점을 바꿉니다. 제품 수정으로 사용하지 않습니다.', 'writer 닫기는 인코딩 전제와 프레임 거부 결과를 함께 대조해야 합니다.', '기준판도 실패하면 새 회귀 주장은 약해지지만 기존 제품·시험·실행기 원인은 추가 판별이 필요합니다.'] };
await save('summary.json', summary); emit({ 결과: summary });
if (!originalCases.every(c => c.oraclePassed)) process.exitCode = 1;
'@
$runner = Join-Path $EvidenceRoot 'diagnosis.mjs'
[IO.File]::WriteAllText($runner, $diagnosisSource, [Text.UTF8Encoding]::new($false))
& node --check $runner
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node $runner $BaselineRoot $CandidateRoot $EvidenceRoot $pythonExecutable
exit $LASTEXITCODE
