import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { windowsCommandLineNames, windowsPolicyName } from '../src/domain/windows-command-line.mjs';
import { commandNamesForTarget, classifyForTarget, prepareWindowsCommand, targetCapabilities } from '../src/domain/target-platform.mjs';
import { commandLineNames } from '../src/domain/command-line.mjs';

const decode = command => Buffer.from(command.split(' -EncodedCommand ')[1], 'base64').toString('utf16le');

test('WIN-STDIN 최대 32KiB 원문은 짧은 수신기의 길이·해시에 결속되고 본문으로 전송된다', () => {
  const prefix = "Write-Output '한글 😀 %PATH% !X! ` $literal'; #";
  const raw = prefix + 'x'.repeat(32768 - Buffer.byteLength(prefix));
  const plan = prepareWindowsCommand(raw), script = decode(plan.command);
  assert.equal(Buffer.byteLength(plan.stdin), 32768);
  assert.equal(plan.stdin, raw);
  assert.ok(plan.command.length < 8000);
  assert.equal(script.includes(raw), false);
  assert.ok(script.includes(createHash('sha256').update(raw).digest('hex')));
  assert.match(script, /OpenStandardInput\(\)/);
  assert.match(script, /CreateInstance\(\[byte\],32769\)/);
  assert.match(script, /\$count -ne 32768/);
  assert.match(script, /\[Text.UTF8Encoding\]::new\(\$false,\$true\)/);
  assert.match(script, /Microsoft.PowerShell.Core\\Out-Default/);
  assert.match(script, /exit \$LASTEXITCODE/);
  assert.doesNotMatch(script, /Exception\.Message/);
  assert.equal(classifyForTarget({ platform: 'windows' }, () => { throw Error('POSIX 호출 금지'); })(raw).class, 'safe');
  assert.throws(() => prepareWindowsCommand(raw + 'x'), /Invalid Windows command/);
});

test('WIN-WORKDIR 관리자 경로를 데이터로 결속하고 읽기 전용 모듈 고정을 보존한다', () => {
  const workdir = "C:\\한글\\owner's files";
  const script = decode(prepareWindowsCommand('Microsoft.PowerShell.Utility\\Get-Date', { workdir }).command);
  assert.ok(script.includes(`$workdir=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(workdir, 'utf16le').toString('base64')}'))`));
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
    const encoded = /\$workdir=\[Text.Encoding\]::Unicode.GetString\(\[Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)\)/.exec(script)?.[1];
    assert.ok(encoded, '작업 경로는 고정 Base64 복원식의 데이터여야 한다');
    assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), workdir);
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
