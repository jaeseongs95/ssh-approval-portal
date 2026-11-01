import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { windowsCommandLineNames, windowsPolicyName } from '../src/domain/windows-command-line.mjs';
import { commandNamesForTarget, classifyForTarget, targetCapabilities } from '../src/domain/target-platform.mjs';
import { prepareWindowsCommand } from '../src/adapters/ssh/windows-command.mjs';
import { commandLineNames } from '../src/domain/command-line.mjs';
import { WINDOWS_STDIN_READER } from '../src/adapters/ssh/windows-stdin.mjs';

const decode = command => {
  const stub = Buffer.from(command.split(' -EncodedCommand ')[1], 'base64').toString('utf16le');
  const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(stub)?.[1];
  return stub.includes('[IO.Compression.GZipStream]') ? gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8') : stub;
};

test('WIN-STDIN 최대 32KiB 원문은 짧은 수신기의 길이·해시에 결속되고 본문으로 전송된다', () => {
  const prefix = "Write-Output '한글 😀 %PATH% !X! ` $literal'; #";
  const raw = prefix + 'x'.repeat(32768 - Buffer.byteLength(prefix));
  const plan = prepareWindowsCommand(raw), script = decode(plan.command);
  assert.equal(Buffer.byteLength(plan.stdin), 32768);
  assert.equal(plan.stdin, raw);
  assert.ok(plan.command.length < 8000);
  assert.equal(script.includes(raw), false);
  assert.ok(script.includes(createHash('sha256').update(raw).digest('hex')));
  assert.ok(script.includes(WINDOWS_STDIN_READER));
  assert.doesNotMatch(script, /OpenStandardInput|Console\]::In/);
  assert.match(script, /\[SshApproval.Stdin\]::Read\(\$buffer,\$count,\$buffer.Length-\$count\)/);
  assert.match(script, /CreateInstance\(\[byte\],32769\)/);
  assert.match(script, /\$count -ne 32768/);
  assert.match(script, /\[Text.UTF8Encoding\]::new\(\$false,\$true\)/);
  assert.match(script, /Microsoft.PowerShell.Core\\Out-Default/);
  assert.match(script, /exit \$LASTEXITCODE/);
  assert.doesNotMatch(script, /Exception\.Message/);
  assert.equal(classifyForTarget({ platform: 'windows' }, () => { throw Error('POSIX 호출 금지'); })(raw).class, 'safe');
  assert.throws(() => prepareWindowsCommand(raw + 'x'), /Invalid Windows command/);
});

test('WIN-EOF 표준입력은 실제 파이프 종료만 EOF로 취급하고 준비 범위를 격리한다', () => {
  assert.match(WINDOWS_STDIN_READER, /new SafeFileHandle\(GetStdHandle\(-10\),false\)/);
  assert.match(WINDOWS_STDIN_READER, /ReadFile\(SafeFileHandle h,\[Out\]byte\[\] b/);
  assert.match(WINDOWS_STDIN_READER, /bool ok=ReadFile\([^;]+;int e=Marshal.GetLastWin32Error\(\);if\(!ok\)\{if\(e==109\)return 0;throw new System\.ComponentModel\.Win32Exception\(e\);\}if\(r>0\)/);
  assert.match(WINDOWS_STDIN_READER, /for\(;;\)/);
  assert.doesNotMatch(WINDOWS_STDIN_READER, /CloseHandle|\.Dispose|PSModuleAutoLoadingPreference|SetCurrentDirectory/);
  assert.match(WINDOWS_STDIN_READER, /^&\{\$ProgressPreference='SilentlyContinue';Microsoft.PowerShell.Core\\Import-Module/);
  assert.match(WINDOWS_STDIN_READER, /-Scope Local -Force -ErrorAction Stop/);
  assert.match(WINDOWS_STDIN_READER, /\$PSHOME,'Modules','Microsoft.PowerShell.Utility'/);
  const raw = 'Microsoft.PowerShell.Utility\\Get-Date';
  const workdir = 'C:\\' + "'".repeat(509);
  const plan = prepareWindowsCommand(raw, { workdir });
  assert.ok(plan.command.length < 8000);
  assert.equal(plan.stdin, raw);
  const script = decode(plan.command);
  assert.ok(script.indexOf('$read=[SshApproval.Stdin]::Read') < script.indexOf('$hash='));
  assert.ok(script.indexOf('if($count -ne ') < script.indexOf('$source='));
  assert.match(script, /if\(\$read -eq 0\)\{break\}/);
});

test('WIN-EOF 실제 0바이트 쓰기는 건너뛰고 뒤따르는 바이트와 파이프 종료를 구분한다', {
  skip: process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true', timeout: 15000,
}, async t => {
  // 준비/컴파일과 실제 읽기를 고정 단계로 분리한다. 프로세스 10초 상한은 유지한다.
  // 제품 준비 뒤에만 쓰기를 시작하고, 데이터 단언 뒤에만 EOF를 허용한다.
  // 성공한 0바이트 읽기를 EOF로 바꾸면 첫 번째 길이 단언에서 실패한다.
  // 단계 파일만 관측에 쓰며 실제 stdout/stderr/종료·부모 설정 단언은 완화하지 않는다.
  const root = await mkdtemp(join(tmpdir(), 'windows-stdin-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && basename(root).startsWith('windows-stdin-'));
    await rm(root, { recursive: true, force: true });
  });
  const phasePath = join(root, 'powershell-phases.txt'), writerPath = join(root, 'writer-phases.txt');
  const fixture = `using System;using System.IO;using System.Text;using System.Runtime.InteropServices;using System.Threading;
public static class StdinFixture {
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr r,out IntPtr w,IntPtr a,uint n);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetStdHandle(int n,IntPtr h);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(IntPtr h,byte[] b,uint n,out uint w,IntPtr o);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
 static IntPtr read,write,original;static Thread thread;static int error;static bool failed;static string path;
 static readonly ManualResetEventSlim eofAllowed=new ManualResetEventSlim(false);
 static void Mark(string value){File.AppendAllText(path,value+"|"+(DateTime.UtcNow.Ticks/TimeSpan.TicksPerMillisecond)+"\\n",new UTF8Encoding(false));}
 public static void Setup(string phasePath){path=phasePath;original=GetStdHandle(-10);if(!CreatePipe(out read,out write,IntPtr.Zero,0)||!SetStdHandle(-10,read))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
 public static void StartWriter(){thread=new Thread(()=>{try{uint n;Mark("WRITER_STARTED");Thread.Sleep(150);Mark("ZERO_WRITE_BEGIN");if(!WriteFile(write,new byte[0],0,out n,IntPtr.Zero))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());Mark("ZERO_WRITE_END");Thread.Sleep(150);Mark("DATA_WRITE_BEGIN");if(!WriteFile(write,new byte[]{237,149,156},3,out n,IntPtr.Zero))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());if(n!=3)throw new Exception("SHORT_WRITE");Mark("DATA_WRITE_END");if(!eofAllowed.Wait(5000)){Mark("EOF_WAIT_TIMEOUT");throw new Exception("EOF_NOT_ALLOWED");}Mark("EOF_ALLOWED");}catch(System.ComponentModel.Win32Exception ex){failed=true;error=ex.NativeErrorCode;Mark("WRITER_NATIVE_ERROR_"+error);}catch{failed=true;error=-1;Mark("WRITER_FAILED");}finally{bool closed=CloseHandle(write);int e=Marshal.GetLastWin32Error();write=IntPtr.Zero;if(closed)Mark("WRITER_CLOSED");else{failed=true;error=e;Mark("WRITER_CLOSE_ERROR_"+e);}}});thread.IsBackground=true;thread.Start();}
 public static void AllowEof(){eofAllowed.Set();}
 public static void Stop(){eofAllowed.Set();bool joined=thread==null||thread.Join(2000);SetStdHandle(-10,original);CloseHandle(read);if(thread==null&&write!=IntPtr.Zero)CloseHandle(write);if(failed&&error>=0)throw new System.ComponentModel.Win32Exception(error);if(!joined||failed)throw new Exception("PIPE_WRITE");}
}`;
  const replaceOnce = (text, before, after) => {
    assert.equal(text.split(before).length, 2, '표준입력 준비의 고정 계측 경계가 바뀜');
    return text.replace(before, after);
  };
  let reader = replaceOnce(WINDOWS_STDIN_READER, 'Microsoft.PowerShell.Core\\Import-Module ', "Write-FixturePhase 'MODULE_BEGIN';Microsoft.PowerShell.Core\\Import-Module ");
  reader = replaceOnce(reader, 'Microsoft.PowerShell.Utility\\Add-Type ', "Write-FixturePhase 'MODULE_END';Write-FixturePhase 'READER_COMPILE_BEGIN';Microsoft.PowerShell.Utility\\Add-Type ");
  reader = replaceOnce(reader, ' -ErrorAction Stop};', " -ErrorAction Stop;Write-FixturePhase 'READER_COMPILE_END'};");
  const encodedPath = value => Buffer.from(value, 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$phasePath=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath(phasePath)}'));$watch=[Diagnostics.Stopwatch]::StartNew();$self=[Diagnostics.Process]::GetCurrentProcess();function Write-FixturePhase([string]$value){$self.Refresh();[IO.File]::AppendAllText($phasePath,$value+'|'+([DateTime]::UtcNow.Ticks/[TimeSpan]::TicksPerMillisecond)+'|'+$watch.ElapsedMilliseconds+'|'+[int]$self.TotalProcessorTime.TotalMilliseconds+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))};Write-FixturePhase 'ENTRY';Write-FixturePhase 'FIXTURE_COMPILE_BEGIN';Add-Type -TypeDefinition '${fixture}';Write-FixturePhase 'FIXTURE_COMPILE_END';[StdinFixture]::Setup([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath(writerPath)}')));Write-FixturePhase 'PIPE_SETUP';try{$ProgressPreference='Continue';${reader}if($ProgressPreference -cne 'Continue'){throw 'PROGRESS_SCOPE_CHANGED'};Write-FixturePhase 'PREPARED';$b=[byte[]]::new(4);Write-FixturePhase 'READ_DATA_BEGIN';[StdinFixture]::StartWriter();$n=[SshApproval.Stdin]::Read($b,0,4);Write-FixturePhase ('READ_DATA_END_'+$n);if($n -ne 3 -or $b[0] -ne 237 -or $b[1] -ne 149 -or $b[2] -ne 156){throw 'ZERO_WRITE_WAS_EOF'};Write-FixturePhase 'BYTES_VERIFIED';[StdinFixture]::AllowEof();Write-FixturePhase 'READ_EOF_BEGIN';$e=[SshApproval.Stdin]::Read($b,3,1);Write-FixturePhase ('READ_EOF_END_'+$e);if($e -ne 0){throw 'PIPE_END_NOT_EOF'};Write-FixturePhase 'EOF_VERIFIED'}finally{[StdinFixture]::Stop()};Write-FixturePhase 'DONE';[Console]::Write('ok')`;
  const started = Date.now();
  let result, failure, spawnedAt;
  const pending = promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000, encoding: 'utf8' });
  pending.child?.once('spawn', () => { spawnedAt = Date.now(); });
  try { result = await pending; } catch (error) { failure = error; }
  const phases = async (path, pattern) => readFile(path, 'utf8').then(text => text.split(/\r?\n/).filter(line => pattern.test(line)).slice(0, 64), error => ['파일 읽기 오류: ' + error.code]);
  t.diagnostic(JSON.stringify({ 진단: '0바이트쓰기 준비와 실제 읽기 경계', 시작시각: new Date(started).toISOString(),
    프로세스시작밀리초: spawnedAt === undefined ? null : spawnedAt - started, 경과밀리초: Date.now() - started,
    exitCode: failure ? failure.code : 0, signal: failure?.signal ?? null, killed: failure?.killed ?? false,
    stdout: result?.stdout ?? failure?.stdout ?? '', stderr: result?.stderr ?? failure?.stderr ?? '',
    준비와읽기: await phases(phasePath, /^(?:ENTRY|FIXTURE_COMPILE_BEGIN|FIXTURE_COMPILE_END|PIPE_SETUP|MODULE_BEGIN|MODULE_END|READER_COMPILE_BEGIN|READER_COMPILE_END|PREPARED|READ_DATA_BEGIN|READ_DATA_END_\d+|BYTES_VERIFIED|READ_EOF_BEGIN|READ_EOF_END_\d+|EOF_VERIFIED|DONE)\|[\d.]+\|\d+\|\d+$/),
    쓰기: await phases(writerPath, /^(?:WRITER_STARTED|ZERO_WRITE_BEGIN|ZERO_WRITE_END|DATA_WRITE_BEGIN|DATA_WRITE_END|EOF_ALLOWED|EOF_WAIT_TIMEOUT|WRITER_NATIVE_ERROR_\d+|WRITER_CLOSE_ERROR_\d+|WRITER_FAILED|WRITER_CLOSED)\|\d+$/) }));
  if (failure) throw Object.assign(Error('0바이트쓰기 프로세스 실패: ' + failure.code + '/' + failure.signal), { code: failure.code, signal: failure.signal, killed: failure.killed });
  assert.equal(result.stdout, 'ok');
  assert.equal(result.stderr, '');
});

test('WIN-LIMIT 다양한 512바이트 경로와 32KiB 원문도 8000자 시작 명령 안에 든다', () => {
  const chars = Array.from({ length: 94 }, (_, i) => String.fromCharCode(i + 33)).filter(c => !'<>"|?*:/\\'.includes(c));
  let seed = 25;
  const workdir = 'C:\\' + Array.from({ length: 508 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return chars[seed % chars.length];
  }).join('') + 'x';
  assert.equal(Buffer.byteLength(workdir), 512);
  const prefix = "[Console]::Write('ok');#";
  const raw = prefix + 'x'.repeat(32768 - Buffer.byteLength(prefix));
  for (const command of [raw, 'Microsoft.PowerShell.Utility\\Get-Date', 'Microsoft.PowerShell.Management\\Get-Location']) {
    const plan = prepareWindowsCommand(command, { workdir });
    assert.ok(plan.command.length <= 8000);
    assert.equal(plan.stdin, command);
    const script = decode(plan.command);
    assert.ok(script.includes(Buffer.from(workdir, 'utf8').toString('base64')));
    assert.equal(script.includes(workdir), false);
  }
});

test('WIN-WORKDIR 관리자 경로를 데이터로 결속하고 읽기 전용 모듈 고정을 보존한다', () => {
  const workdir = "C:\\한글\\owner's files";
  const script = decode(prepareWindowsCommand('Microsoft.PowerShell.Utility\\Get-Date', { workdir }).command);
  assert.ok(script.includes(`$workdir=[Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String('${Buffer.from(workdir, 'utf8').toString('base64')}'))`));
  assert.equal(script.includes(workdir), false);
  assert.ok(script.includes('Set-Location -LiteralPath $workdir'));
  assert.ok(script.includes('SetCurrentDirectory($workdir)'));
  assert.ok(script.includes("$PSHOME,'Modules','Microsoft.PowerShell.Utility'"));
  assert.ok(script.includes("$PSModuleAutoLoadingPreference='None'"));
  for (const workdir of ['C:relative', '\\\\host\\share', '/tmp', 'C:\\a\\..\\b', 'C:\\a:stream', 'C:\\a?', 'C:\\a\n', 'C:\\a.', 'C:\\a"b']) {
    assert.throws(() => prepareWindowsCommand('whoami.exe', { workdir }), /working directory/);
  }
  const normal = decode(prepareWindowsCommand('whoami.exe', { workdir: 'C:\\work' }).command);
  assert.equal(normal.includes("$PSModuleAutoLoadingPreference='None'"), false, '일반 명령의 모듈 자동 로딩을 workdir가 바꾸지 않는다');
  assert.ok(prepareWindowsCommand('whoami.exe', { workdir: 'C:\\' + "'".repeat(509) }).command.length < 8000);
});

test('SEC-WIN-001 관리자 경로의 일반·곡선 작은따옴표와 곡선 큰따옴표를 코드로 삽입하지 않는다', () => {
  for (const quote of ["'", '\u2018', '\u2019', '\u201c', '\u201d']) {
    const workdir = `C:\\한글\\owner${quote}; calc.exe; # files`;
    const plan = prepareWindowsCommand('whoami.exe', { workdir }), script = decode(plan.command);
    const encoded = /\$workdir=\[Text.UTF8Encoding\]::new\(\$false,\$true\)\.GetString\(\[Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)\)/.exec(script)?.[1];
    assert.ok(encoded, '작업 경로는 고정 Base64 복원식의 데이터여야 한다');
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), workdir);
    assert.equal(script.includes(workdir), false);
    assert.equal(script.includes('calc.exe'), false);
    assert.equal(plan.stdin, 'whoami.exe');
  }
});

test('WIN-NAMES 정적인 전체 명령 이름과 리터럴 인수만 인식하고 Windows 대소문자를 정규화한다', () => {
  const cases = [
    ['WHOAMI.EXE /user', ['whoami.exe']],
    ['Microsoft.PowerShell.Utility\\Get-Date -Format "yyyy-MM-dd"', ['microsoft.powershell.utility\\get-date']],
    ["& 'C:/Program Files/Tool.EXE' 'owner''s data'", ['c:\\program files\\tool.exe']],
    ['whoami.exe | Microsoft.PowerShell.Utility\\Select-Object -First 1; hostname.exe', ['whoami.exe', 'microsoft.powershell.utility\\select-object', 'hostname.exe']],
    ["whoami.exe '$env:NAME; $(literal)'", ['whoami.exe']],
    ['whoami.exe;', ['whoami.exe']],
  ];
  for (const [raw, names] of cases) {
    assert.deepEqual(windowsCommandLineNames(raw), { names, complete: true, usesSudo: false }, raw);
    assert.deepEqual(commandNamesForTarget({ platform: 'windows' }, raw).names, names);
  }
  for (const raw of ['ls', 'Get-Date', 'customFunction arg', '$name arg', '& $name', '& {whoami.exe}',
    'whoami.exe "$env:USER"', 'whoami.exe $(hostname.exe)', 'whoami.exe `x', 'whoami.exe > out.txt',
    'whoami.exe --% %USER%', 'whoami.exe |', 'whoami.exe || hostname.exe', 'whoami.exe && hostname.exe',
    "'C:\\tool.exe'", 'function x {whoami.exe}; x', 'whoami.exe @args', 'whoami.exe # hidden',
    "whoami.exe 'closed'unquoted", 'C:\\a\\..\\whoami.exe', 'whoami.exe\n']) {
    assert.equal(windowsCommandLineNames(raw).complete, false, raw);
  }
  const linux = 'ls $(id)';
  assert.deepEqual(commandNamesForTarget({}, linux), commandLineNames(linux));
  assert.equal(windowsPolicyName('C:/Program Files/Tool.EXE'), 'c:\\program files\\tool.exe');
  assert.equal(windowsPolicyName('Microsoft.PowerShell.Utility\\Get-Date'), 'microsoft.powershell.utility\\get-date');
  for (const name of ['Get-Date', ' git.exe', 'git.exe ', 'C:\\a:stream.exe', 'C:\\' + '가'.repeat(171) + '.exe', null]) {
    assert.equal(windowsPolicyName(name), null);
  }
});

test('WIN-CAPABILITIES Windows source는 관리자 인터프리터 설정에만 의존한다', () => {
  assert.equal(targetCapabilities({ platform: 'windows' }).pythonSource, false);
  assert.equal(targetCapabilities({ platform: 'windows', pythonExecutable: 'C:\\Python\\python.exe' }).pythonSource, true);
  assert.equal(targetCapabilities({ platform: 'windows', pythonExecutable: ' ' }).pythonSource, false);
  assert.equal(targetCapabilities({ platform: 'linux' }).pythonSource, true);
});

test('SEC-WIN-001 곡선 따옴표는 원문을 보존하면서 이름 승인 전체를 포기한다', () => {
  const attack = "whoami.exe 'ok’; calc.exe; #'";
  assert.deepEqual(windowsCommandLineNames(attack), { names: [], complete: false, usesSudo: false });
  for (const quote of ['\u2018', '\u2019', '\u201c', '\u201d']) {
    for (const raw of [
      `${quote}whoami.exe${quote}`, `C:/dir${quote}/tool.exe`, `& 'C:/dir${quote}/tool.exe'`,
      `whoami.exe bare${quote}argument`, `whoami.exe ${quote}argument${quote}`,
      `whoami.exe 'mixed${quote}; calc.exe; #'`, `whoami.exe "mixed${quote}; calc.exe; #"`,
    ]) {
      assert.deepEqual(commandNamesForTarget({ platform: 'windows' }, raw), { names: [], complete: false, usesSudo: false }, raw);
      assert.equal(prepareWindowsCommand(raw).stdin, raw, '일반 평가와 실행을 위한 원문은 변형하지 않는다');
    }
    for (const name of [`whoami${quote}.exe`, `C:/dir${quote}/tool.exe`, `C:/dir/tool${quote}.exe`]) {
      assert.equal(windowsPolicyName(name), null, name);
    }
  }
  assert.deepEqual(windowsCommandLineNames("whoami.exe 'ok'; hostname.exe"), {
    names: ['whoami.exe', 'hostname.exe'], complete: true, usesSudo: false,
  });
});
