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

test('WIN-WORKDIR 관리자 경로를 리터럴로 결속하고 읽기 전용 모듈 고정을 보존한다', () => {
  const workdir = "C:\\한글\\owner's files";
  const script = decode(prepareWindowsCommand('Microsoft.PowerShell.Utility\\Get-Date', { workdir }).command);
  assert.ok(script.includes("$workdir='C:\\한글\\owner''s files'"));
  assert.ok(script.includes('Set-Location -LiteralPath $workdir'));
  assert.ok(script.includes('SetCurrentDirectory($workdir)'));
  assert.ok(script.includes("$PSHOME,'Modules','Microsoft.PowerShell.Utility'"));
  assert.ok(script.includes("$PSModuleAutoLoadingPreference='None'"));
  for (const workdir of ['C:relative', '\\\\host\\share', '/tmp', 'C:\\a\\..\\b', 'C:\\a:stream', 'C:\\a?', 'C:\\a\n', 'C:\\a.']) {
    assert.throws(() => prepareWindowsCommand('whoami.exe', { workdir }), /working directory/);
  }
  const normal = decode(prepareWindowsCommand('whoami.exe', { workdir: 'C:\\work' }).command);
  assert.equal(normal.includes("$PSModuleAutoLoadingPreference='None'"), false, '일반 명령의 모듈 자동 로딩을 workdir가 바꾸지 않는다');
  assert.ok(prepareWindowsCommand('whoami.exe', { workdir: 'C:\\' + "'".repeat(509) }).command.length < 8000);
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
