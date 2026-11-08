import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join, dirname, win32 } from 'node:path';
import { createSshRuntime, createSshTransport } from '../src/adapters/ssh/vendor.mjs';
import { Artifacts } from '../src/adapters/storage/artifacts.mjs';
import { createTransferExecutor } from '../src/adapters/ssh/transfers.mjs';
import { ApprovalQueue } from './support/approval-runtime.mjs';
import { prepareAgentCliPlan } from '../src/adapters/ssh/agent-cli.mjs';
import { buildWindowsCliFixtureScript } from './windows-agent-cli-fixture.mjs';
import { WINDOWS_STDIN_READER } from '../src/adapters/ssh/windows-stdin.mjs';

// 시험 계획: 실제 sshd/키/고정 호스트 키/비관리자 계정/SFTP/설치된 보조프로그램을
// 통과한다. 바이트 비교는 입력 원본과 직접 비교하며 구현의 결과를 기대값으로 쓰지 않는다.
// 정상: UTF-8·따옴표·256 KiB 초과·빈 파일. 경계: 덮어쓰기·크기·승인·시간초과.
// 오류: 인증·호스트 키·ADS·UNC·장치·상위 이동·재분석 지점. 실제 서버 없는 실행은 생략한다.
const fixturePath = process.env.AGS_WINDOWS_SSH_FIXTURE;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const absent = async path => assert.rejects(access(path), { code: 'ENOENT' });

test('실제 Windows SSH 명령·승인·파일 전송 경계', {
  // 제품·원시험 제한은 유지한다. 실패시 .NET/ReadFile 각16.5초와 관리자70초,
  // 로그읽기최대30초를 더해 180+33+70+30+정리20=333초의 진단 예산을 분리한다.
  skip: !fixturePath, timeout: 350_000,
}, async t => {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const { commandNamesForTarget } = await import('../src/domain/target-platform.mjs');
  const { wrapWindowsCommand, prepareWindowsCommand } = await import('../src/adapters/ssh/windows-command.mjs');
  const runtime = await createSshRuntime({ BRIDGE_CONFIG_PATH: fixture.configPath, BRIDGE_HOST_KEY_MODE: 'strict' });
  const transport = createSshTransport(runtime.registry);
  const helperFailures = [];
  const observedTransport = { async connect(...args) {
    const session = await transport.connect(...args);
    return { ...session, async call(command, payload) {
      const result = await session.call(command, payload);
      if (result.exitCode !== 0) {
        let data;
        try { data = JSON.parse(result.stdout); } catch { data = {}; }
        const steps = ['write_security', 'write_times', 'verify_security', 'verify_owner', 'verify_dacl', 'verify_control', 'verify_times', 'read_label', 'write_label', 'verify_label'];
        const codes = ['PARENT_NOT_FOUND', 'FILE_NOT_FOUND', 'PERMISSION_DENIED', 'DESTINATION_EXISTS', 'UNSAFE_PATH', 'PATH_OUTSIDE_ALLOWED_ROOT', 'STAGING_UNAVAILABLE', 'FILE_CHANGED', 'FILE_TOO_LARGE', 'INVALID_REQUEST', 'OPERATION_FAILED'];
        helperFailures.push({ ...(['authorize', 'publish', 'snapshot', 'cleanup'].includes(payload.action) ? { action: payload.action } : {}),
          ...(codes.includes(data.errorCode) ? { errorCode: data.errorCode } : {}),
          ...(steps.includes(data.nativeStep) ? { nativeStep: data.nativeStep } : {}),
          ...(Number.isSafeInteger(data.nativeError) && data.nativeError >= 0 && data.nativeError <= 0xffffffff ? { nativeError: data.nativeError } : {}),
          ...(['verify_owner', 'verify_dacl', 'verify_control'].includes(data.nativeStep) &&
            [data.securityControl?.before, data.securityControl?.after].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 5388)
            ? { securityControl: { before: data.securityControl.before, after: data.securityControl.after } } : {}) });
      }
      return result;
    } };
  } };
  const store = new Artifacts(fixture.artifactRoot, { maxBytes: 1_048_576, budget: 8_388_608 });
  await store.init();
  const transfers = createTransferExecutor(runtime.registry, store, {
    platform: 'windows', helper: fixture.helper, remoteStage: fixture.stageRoot,
    readProfile: 'windows-read', writeProfile: 'windows-write',
    transport: observedTransport,
  });
  const remote = name => win32.join(fixture.fileRoot, name).replaceAll('\\', '/');
  const connection = await runtime.registry.getOrCreate('windows-write');
  const call = script => connection.exec(wrapWindowsCommand(script));
  const serverLogWindow = async (fromLine = 0) => {
    // Node 파일 열기가 sshd의 공유 모드와 충돌하므로 전용 공유 읽기를 사용한다.
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./windows-ssh-log-read.ps1', import.meta.url)),
      '-LogPath', fixture.serverLog, '-FromLine', String(fromLine)], { windowsHide: true, timeout: 5000, maxBuffer: 262_144, encoding: 'utf8' }).catch(error => {
        try {
          const report = JSON.parse(error.stdout);
          if (report.errorCode === 'LOG_READ_FAILED' && /^[a-z]+$/i.test(report.errorType) && Number.isInteger(report.hresult)) {
            error.code = 'LOG_READ_FAILED:' + report.errorType + ':' + report.hresult
              + (Number.isInteger(report.nativeError) ? ':' + report.nativeError : '');
          }
        } catch { /* 구조화하지 못한 경우 원래 프로세스 오류 코드를 보존한다. */ }
        throw error;
      });
    const snapshot = JSON.parse(stdout.trim());
    assert.ok(Number.isSafeInteger(snapshot.lineCount));
    assert.ok(Array.isArray(snapshot.events));
    return { 줄수: snapshot.lineCount, 사건: snapshot.events.map(row => ({ 줄: row.line, 사건: row.event })) };
  };
  const eofBoundaryDiagnostic = async (native = false) => {
    // 756a277에서 통과한 직접PS/SSH-Python 대조는 반복하지 않는다.
    // 진단 전용 marker를 쓰고 제품의 길이·해시·UTF-8·EOF 검사는 그대로 둔다.
    const prefix = native ? 'command-eof-win32' : 'command-eof-probe';
    const marker = remote(prefix + '-marker.txt');
    const phases = remote(prefix + '-phases.txt');
    await absent(marker);
    await absent(phases);
    const prepared = prepareWindowsCommand(`[IO.File]::WriteAllText('${marker}', 'once');[Console]::Write('EOF 완료')`);
    const args = prepared.command.split(' ').slice(1);
    const encodedIndex = args.indexOf('-EncodedCommand') + 1;
    assert.ok(encodedIndex > 0);
    const stub = Buffer.from(args[encodedIndex], 'base64').toString('utf16le');
    const compressed = stub.match(/\[Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)/);
    assert.ok(compressed, '압축 수신기 경계가 변경됨');
    let script = gunzipSync(Buffer.from(compressed[1], 'base64')).toString('utf8');
    const instrument = (before, after) => {
      assert.ok(script.includes(before), '진단 수신기 경계가 변경됨'); script = script.replace(before, after);
    };
    instrument(WINDOWS_STDIN_READER, "Write-CiPhase 'PROBE_BEFORE_OPEN';" + WINDOWS_STDIN_READER + "Write-CiPhase 'PROBE_AFTER_OPEN';");
    instrument('$read=[SshApproval.Stdin]::Read(', "Write-CiPhase ('PROBE_BEFORE_READ|'+$count);$read=[SshApproval.Stdin]::Read(");
    instrument('if($read -eq 0){break}', "if($read -eq 0){Write-CiPhase ('PROBE_EOF|'+$count);break}");
    instrument('$count+=$read', "$count+=$read;Write-CiPhase ('PROBE_COUNT|'+$count)");
    instrument('$stage=1;$code=', "Write-CiPhase 'PROBE_VERIFIED';$stage=1;$code=");
    instrument('& $code |', "Write-CiPhase 'PROBE_EXECUTE';& $code |");
    if (native) {
      const nativePath = remote('command-eof-native-reader.cs');
      assert.doesNotMatch(nativePath, /[?*\[\]]/);
      await absent(nativePath);
      await writeFile(nativePath, 'using System;using System.Runtime.InteropServices;public static class CiNativeRead{[DllImport("kernel32.dll",SetLastError=true)]public static extern IntPtr GetStdHandle(int n);[DllImport("kernel32.dll",SetLastError=true)]public static extern uint GetFileType(IntPtr h);[DllImport("kernel32.dll",SetLastError=true)]public static extern bool ReadFile(IntPtr h,[Out] byte[] b,uint n,out uint r,IntPtr o);}', 'utf8');
      const encodedPath = Buffer.from(nativePath, 'utf8').toString('base64');
      instrument(WINDOWS_STDIN_READER, `$PSModuleAutoLoadingPreference='None';Microsoft.PowerShell.Core\\Import-Module ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop;Microsoft.PowerShell.Utility\\Add-Type -Path ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))) -ErrorAction Stop;$handle=[CiNativeRead]::GetStdHandle(-10);$valid=$handle -ne [IntPtr]::Zero -and $handle -ne [IntPtr]::new(-1);$type=[CiNativeRead]::GetFileType($handle);Write-CiPhase ('PROBE_HANDLE|'+[int]$valid+'|'+$type);if(!$valid -or $type -ne 3){exit 125};`);
      instrument('$read=[SshApproval.Stdin]::Read($buffer,$count,$buffer.Length-$count);', "Write-CiPhase ('PROBE_NATIVE_BEFORE_READ|'+$count);$piece=[Array]::CreateInstance([byte],$buffer.Length-$count);[uint32]$taken=0;$ok=[CiNativeRead]::ReadFile($handle,$piece,[uint32]$piece.Length,[ref]$taken,[IntPtr]::Zero);$errorCode=[Runtime.InteropServices.Marshal]::GetLastWin32Error();Write-CiPhase ('PROBE_NATIVE_RESULT|'+[int]$ok+'|'+$taken+'|'+$(if($ok){0}else{$errorCode}));if(!$ok){if($errorCode -ne 109){exit 125};$read=0}else{if($taken -eq 0){[Threading.Thread]::Sleep(10);continue};$read=[int]$taken;[Buffer]::BlockCopy($piece,0,$buffer,$count,$read)};");
    }
    const phasePath = Buffer.from(phases, 'utf8').toString('base64');
    script = `function Write-CiPhase([string]$value){$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${phasePath}'));[IO.File]::AppendAllText($path,$value+[Environment]::NewLine,[Text.UTF8Encoding]::new($false));[Console]::Error.WriteLine($value);[Console]::Error.Flush()};Write-CiPhase ('PROBE_ENTRY|'+$PID+'|'+$env:SSH_CONNECTION);` + script;
    const repacked = stub.replace(compressed[1], gzipSync(Buffer.from(script, 'utf8')).toString('base64'));
    args[encodedIndex] = Buffer.from(repacked, 'utf16le').toString('base64');
    const command = 'powershell.exe ' + args.join(' '), stdin = Buffer.from(prepared.stdin);
    assert.ok(command.length < 8000, '진단 런처가 Windows 명령 길이를 초과함: ' + command.length);
    let fromLine = 0;
    try { fromLine = Math.max(0, (await serverLogWindow()).줄수 - 1); }
    catch (error) { t.diagnostic('서버 진단 시작점 읽기 실패: ' + error.code); }
    const probe = await createSshRuntime({ BRIDGE_CONFIG_PATH: fixture.configPath, BRIDGE_HOST_KEY_MODE: 'strict' });
    const events = [], started = Date.now();
    let channel, direct, timer, stdout = '', stderr = '', pending = '', result, failure;
    let localPort, incomingChannel, outgoingChannel, beforeEofAbsent;
    const event = 단계 => events.push({ 단계, 경과밀리초: Date.now() - started });
    try {
      direct = await probe.registry.getOrCreate('windows-write');
      await direct.ensureConnected();
      // 고정된 ssh2 버전의 관측 필드다. 제품 동작이나 성공 판정에는 쓰지 않는다.
      const port = direct.getClient()._sock?.localPort;
      localPort = Number.isSafeInteger(port) ? port : undefined;
      channel = await new Promise((resolve, reject) => direct.getClient().exec(command, (error, stream) => error ? reject(error) : resolve(stream)));
      incomingChannel = Number.isSafeInteger(channel.incoming?.id) ? channel.incoming.id : undefined;
      outgoingChannel = Number.isSafeInteger(channel.outgoing?.id) ? channel.outgoing.id : undefined;
      channel.on('data', bytes => { stdout += bytes.toString('utf8'); });
      channel.stderr.on('data', bytes => {
        stderr += bytes.toString('utf8'); pending += bytes.toString('utf8');
        const lines = pending.split(/\r?\n/); pending = lines.pop();
        for (const line of lines) {
          if (/^PROBE_(?:ENTRY\|\d+\|127\.0\.0\.1 \d+ 127\.0\.0\.1 \d+|BEFORE_OPEN|AFTER_OPEN|BEFORE_READ\|\d+|EOF\|\d+|COUNT\|\d+|VERIFIED|EXECUTE|HANDLE\|[01]\|\d+|NATIVE_BEFORE_READ\|\d+|NATIVE_RESULT\|[01]\|\d+\|\d+)$/.test(line)) event(line);
        }
      });
      const finished = new Promise((resolve, reject) => {
        channel.on('error', reject);
        channel.on('finish', () => event('로컬 EOF 전송 완료'));
        channel.on('exit', (code, signal) => { event('원격 종료 코드'); result = { code, signal }; });
        channel.on('end', () => { event('원격 출력 EOF'); if (result) channel.close(); });
        channel.on('close', (code, signal) => resolve({ code: code ?? result?.code, signal: signal ?? result?.signal }));
      });
      finished.catch(() => {});
      channel.write(stdin); event('입력 write 호출');
      await new Promise(resolve => setTimeout(resolve, 1500));
      beforeEofAbsent = await access(marker).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });
      event('입력 end 호출'); channel.end();
      result = await Promise.race([finished, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('SSH PowerShell 단계 진단 시간초과')), 15_000); })]);
    } catch (error) { failure = error.message; }
    finally {
      clearTimeout(timer);
      const filePhases = await readFile(phases, 'utf8').then(text => text.split(/\r?\n/)
        .filter(line => /^PROBE_(?:ENTRY\|\d+\|127\.0\.0\.1 \d+ 127\.0\.0\.1 \d+|BEFORE_OPEN|AFTER_OPEN|BEFORE_READ\|\d+|EOF\|\d+|COUNT\|\d+|VERIFIED|EXECUTE|HANDLE\|[01]\|\d+|NATIVE_BEFORE_READ\|\d+|NATIVE_RESULT\|[01]\|\d+\|\d+)$/.test(line)).slice(0, 64), error => ['단계 파일 읽기: ' + error.code]);
      t.diagnostic(JSON.stringify({ 진단: native ? 'SSH PowerShell 별도 ReadFile 대조' : 'SSH PowerShell 공통 ReadFile 단계와 채널', 사건: events, 경과밀리초: Date.now() - started,
        localPort, incomingChannel, outgoingChannel, ...result, 오류: failure, stdout, stderr,
        파일단계: filePhases,
        EOF이전무효과: beforeEofAbsent, 효과확인: await readFile(marker, 'utf8').then(value => value === 'once', () => false),
        입력바이트: stdin.length, 입력해시: digest(stdin) }));
      try { t.diagnostic(JSON.stringify({ 진단: 'SSH PowerShell 서버 로그 구간', fromLine: fromLine + 1, localPort, ...(await serverLogWindow(fromLine)) })); }
      catch (error) { t.diagnostic('서버 진단 구간 읽기 실패: ' + error.code); }
      // KILL 요청을 종료 영수증으로 취급하지 않는다. 전용 연결만 닫고 원격 정리는 fixture가 맡는다.
      direct?.getClient().destroy(); channel?.close();
      await probe.registry.closeAll();
    }
  };
  // 실패 때만 동일 합성 명령의 원시 결과와 준비 후 재실행을 관측한다. 원시험 제한은 유지한다.
  const directDiagnostic = async (label, command, profile = 'windows-write') => {
    const started = Date.now();
    let phase = '최초 직접 실행';
    try {
      const direct = await runtime.registry.getOrCreate(profile);
      const result = await direct.exec(command, { timeoutMs: 60_000 });
      t.diagnostic(JSON.stringify({ 진단: label, 단계: phase, 경과밀리초: Date.now() - started,
        exitCode: result.exitCode, signal: result.signal,
        stdoutBytes: Buffer.byteLength(result.stdout ?? ''), stderrBytes: Buffer.byteLength(result.stderr ?? ''),
        stdout: result.stdout?.slice(0, 2048), stderr: result.stderr?.slice(0, 2048) }));
      if (result.exitCode === 0 && !result.signal) {
        phase = '같은 명령 10초 제한 재실행';
        const warmStarted = Date.now();
        const warm = await direct.exec(command, { timeoutMs: 10_000 });
        t.diagnostic(JSON.stringify({ 진단: label, 단계: phase, 경과밀리초: Date.now() - warmStarted,
          exitCode: warm.exitCode, signal: warm.signal,
          stdoutBytes: Buffer.byteLength(warm.stdout ?? ''), stderrBytes: Buffer.byteLength(warm.stderr ?? ''),
          stdout: warm.stdout?.slice(0, 2048), stderr: warm.stderr?.slice(0, 2048) }));
      }
    } catch (error) {
      t.diagnostic(JSON.stringify({ 진단: label, 단계: phase, 경과밀리초: Date.now() - started, 오류: error.message }));
    }
  };
  const uploadOperation = async (name, bytes, overwrite = false, elevate = false) => {
    const meta = { fileName: name, remotePath: remote(name), size: bytes.length, sha256: digest(bytes), overwrite, elevate };
    const item = await store.begin(meta);
    for (let offset = 0, sequence = 0; offset < bytes.length; offset += 262_144, sequence++) {
      await store.append(item.id, sequence, bytes.subarray(offset, offset + 262_144));
    }
    await store.finish(item.id);
    return { kind: 'upload', artifactId: item.id, ...meta };
  };
  const queue = new ApprovalQueue({ classify: () => ({ class: 'privileged' }), profile: 'windows-write', target: 'Windows 시험', executeOperation: op => transfers.upload(op) });
  try {
    await t.test('한글·공백·양쪽 따옴표와 종료 코드가 원문대로 전달된다', async () => {
      const marker = `한글 공백 '작은따옴표' "큰따옴표"`;
      const wrapped = wrapWindowsCommand(`[Console]::Write('${marker.replaceAll("'", "''")}')`);
      try {
        const result = await runtime.executeCommand('windows-write', wrapped);
        assert.equal(result.failed, false);
        assert.deepEqual(result.texts, [marker]);
        const failed = await call('[Console]::Error.Write("예상 실패"); exit 7');
        assert.equal(failed.exitCode, 7);
        assert.equal(failed.stderr, '예상 실패');
        const streamed = prepareWindowsCommand('[Console]::Error.Write("예상 실패"); exit 7');
        const streamedFailure = await connection.exec(streamed.command, { stdin: streamed.stdin });
        assert.equal(streamedFailure.exitCode, 7, '압축 수신기가 원문의 종료 코드를 보존하지 못함');
        assert.equal(streamedFailure.stderr, '예상 실패');
      } catch (error) {
        await directDiagnostic('한글 명령 직접 경로', wrapped);
        throw error;
      }
    });

    await t.test('ML-WIN 실제 SSH가 LF·CRLF here-string과 탭을 실행한다', async () => {
      const cases = [
        ["$value = @'\n한글 $env:PATH 'literal'\n'@\n\t[Console]::Write($value)\n[Console]::Write('|second')\n", "한글 $env:PATH 'literal'|second"],
        ["$word = 'expanded'\r\n$value = @\"\r\n$word 한글\r\n\"@\r\n\t[Console]::Write($value)\r\n[Console]::Write('|second')\r\n", 'expanded 한글|second'],
      ];
      for (const [raw, expected] of cases) {
        const prepared = prepareWindowsCommand(raw);
        assert.equal(prepared.stdin, raw);
        assert.equal(digest(Buffer.from(prepared.stdin, 'utf8')), digest(Buffer.from(raw, 'utf8')));
        const result = await runtime.executeCommand('windows-write', prepared.command, async () => {}, { stdin: prepared.stdin });
        assert.equal(result.failed, false);
        assert.deepEqual(result.texts, [expected]);
      }
    });

    await t.test('정확한 기본 읽기 명령은 외부 모듈 검색 경로에 있는 동명 합성 모듈을 불러오지 않는다', async () => {
      for (const command of ['Microsoft.PowerShell.Utility\\Get-Date', 'Microsoft.PowerShell.Management\\Get-Location']) {
        const inner = wrapWindowsCommand(command);
        // 외부 명령의 환경만 오염시킨다. 자식은 제품의 실제 기본 읽기 명령 런처다.
        const outer = wrapWindowsCommand(`$env:PSModulePath = '${fixture.modulesRoot.replaceAll("'", "''")}'; ${inner}`);
        try {
          const result = await runtime.executeCommand('windows-read', outer);
          assert.equal(result.failed, false);
          assert.ok(result.texts.join('').trim(), '기본 명령의 정상 출력이 없음');
          assert.doesNotMatch(result.texts.join(''), /untrusted module loaded/);
          for (const marker of fixture.moduleMarkers) await absent(marker);
        } catch (error) {
          await directDiagnostic('기본 읽기 직접 경로: ' + command, outer, 'windows-read');
          throw error;
        }
      }
    });

    await t.test('연결 후 승인 검사 거부는 명령을 실행하지 않는다', async () => {
      const marker = remote('dispatch-refused.txt');
      await assert.rejects(runtime.executeCommand('windows-write', wrapWindowsCommand(`Set-Content -LiteralPath '${marker}' -Value '실행 금지'`), () => { throw Error('승인 만료'); }), /승인 만료|SSH execution unavailable before dispatch/);
      await absent(marker);
    });

    await t.test('전송 직전 승인 검사가 거부되면 원격 파일과 임시 바이트가 생기지 않는다', async () => {
      const op = await uploadOperation('upload-dispatch-refused.bin', Buffer.from('실행 금지'));
      await assert.rejects(transfers.upload(op, () => { throw Error('승인 만료'); }), /승인 만료/);
      await absent(op.remotePath);
      assert.deepEqual(await readdir(fixture.stageRoot), []);
    });

    await t.test('시간초과는 성공으로 취급되지 않는다', async () => {
      const started = Date.now();
      let result;
      try { result = await connection.exec(wrapWindowsCommand('Start-Sleep -Seconds 30'), { timeoutMs: 500 }); }
      catch (error) { assert.match(String(error), /timeout|timed out|시간/i); }
      if (result) assert.ok(result.exitCode !== 0 || result.signal, '시간초과 명령이 성공으로 반환됨');
      assert.ok(Date.now() - started < 15_000, '시간초과가 실행 시간을 제한하지 못함');
    });

    await t.test('32KiB 한글 명령은 표준입력으로 전달하고 작업 폴더를 함께 적용한다', async () => {
      const prefix = `[Console]::Write('한글 작업 폴더:'+[IO.Directory]::GetCurrentDirectory());#`;
      const remaining = 32_768 - Buffer.byteLength(prefix);
      const raw = prefix + '한'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3);
      assert.equal(Buffer.byteLength(raw), 32_768);
      const prepared = prepareWindowsCommand(raw, { workdir: fixture.fileRoot });
      assert.ok(prepared.command.length < 8000);
      const result = await connection.exec(prepared.command, { stdin: prepared.stdin });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, '한글 작업 폴더:' + fixture.fileRoot);
    });

    await t.test('곡선 따옴표는 실제 PowerShell 구문 분석과 명령 이름 승인에서 보수적으로 처리한다', async () => {
      const text = "whoami.exe 'ok’; calc.exe; #'";
      assert.equal(commandNamesForTarget({ platform: 'windows' }, text).complete, false);
      const encoded = Buffer.from(text, 'utf16le').toString('base64');
      const script = `$source=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'));$tokens=$null;$errors=$null;$ast=[System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);$commands=$ast.FindAll({param($node)$node -is [System.Management.Automation.Language.CommandAst]},$true);foreach($node in $commands){[Console]::WriteLine($node.GetCommandName())}`;
      const result = await call(script);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(result.stdout.trim().split(/\r?\n/), ['whoami.exe', 'calc.exe']);
    });

    await t.test('한글·작은따옴표·네 곡선 따옴표 작업 폴더는 데이터로 복원된다', async () => {
      const cwd = win32.join(fixture.fileRoot, "한글 owner's ‘왼쪽’ “오른쪽”");
      await mkdir(cwd);
      const prepared = prepareWindowsCommand('[Console]::Write((Microsoft.PowerShell.Management\\Get-Location).Path+"|"+[IO.Directory]::GetCurrentDirectory())', { workdir: cwd });
      const result = await connection.exec(prepared.command, { stdin: prepared.stdin });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, cwd + '|' + cwd);
    });

    await t.test('명령 수신기는 입력 손상·추가·잘림을 거부하고 EOF 전에는 실행하지 않는다', async () => {
      const marker = remote('command-eof-marker.txt');
      const raw = `[IO.File]::WriteAllText('${marker}', 'once');[Console]::Write('EOF 완료')`;
      const prepared = prepareWindowsCommand(raw);
      const exact = Buffer.from(prepared.stdin), changed = Buffer.from(exact);
      changed[0] ^= 1;
      for (const stdin of [changed, exact.subarray(0, exact.length - 1), Buffer.concat([exact, Buffer.from('x')])]) {
        const result = await connection.exec(prepared.command, { stdin });
        assert.equal(result.exitCode, 125);
        await absent(marker);
      }
      await connection.ensureConnected();
      const rawStarted = Date.now(), rawPort = connection.getClient()._sock?.localPort;
      let rawLogLine = 0;
      try { rawLogLine = Math.max(0, (await serverLogWindow()).줄수 - 1); }
      catch (error) { t.diagnostic('원시험 서버 시작점 읽기 실패: ' + error.code); }
      const channel = await new Promise((resolve, reject) => connection.getClient().exec(prepared.command,
        (error, stream) => error ? reject(error) : resolve(stream)));
      const events = [];
      let stdout = '', stderr = '', exitCode, signal, outputEnded = false;
      const closeAfterExit = () => { if (exitCode !== undefined && outputEnded) channel.close(); };
      const finished = new Promise((resolve, reject) => {
        channel.on('error', reject);
        channel.on('data', bytes => { stdout += bytes.toString('utf8'); });
        channel.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); });
        channel.on('finish', () => events.push('로컬 EOF 전송 완료'));
        channel.on('exit', (code, value) => { events.push('원격 종료 코드'); exitCode = code; signal = value; closeAfterExit(); });
        channel.on('end', () => { events.push('원격 표준출력 EOF'); outputEnded = true; closeAfterExit(); });
        channel.on('close', (code, value) => { events.push('SSH 채널 닫힘'); resolve({ code: code ?? exitCode, signal: value ?? signal }); });
      });
      finished.catch(() => {});
      let deadline;
      const bounded = Promise.race([finished, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(Error('명령 EOF 수신기 응답 시간초과')), 60_000);
      })]);
      bounded.catch(() => {});
      let complete = false;
      try {
        channel.write(exact);
        await new Promise(resolve => setTimeout(resolve, 1500));
        await absent(marker);
        channel.end();
        const result = await bounded;
        assert.equal(result.code, 0); assert.ok(!result.signal);
        assert.equal(stdout, 'EOF 완료'); assert.equal(stderr, '');
        assert.ok(outputEnded, '원격 표준출력 EOF가 확인되지 않음');
        assert.equal(await readFile(marker, 'utf8'), 'once');
        complete = true;
      } finally {
        t.diagnostic(JSON.stringify({ 진단: '명령 EOF 수명', 사건: events, exitCode, signal, stdout, stderr,
          시작시각: new Date(rawStarted).toISOString(), 경과밀리초: Date.now() - rawStarted,
          localPort: Number.isSafeInteger(rawPort) ? rawPort : undefined,
          incomingChannel: Number.isSafeInteger(channel.incoming?.id) ? channel.incoming.id : undefined,
          outgoingChannel: Number.isSafeInteger(channel.outgoing?.id) ? channel.outgoing.id : undefined,
          효과확인: await readFile(marker, 'utf8').then(value => value === 'once', () => false) }));
        clearTimeout(deadline); channel.end();
        if (!complete) {
          try { t.diagnostic(JSON.stringify({ 진단: '원시험 서버 로그 구간', fromLine: rawLogLine + 1, localPort: rawPort, ...(await serverLogWindow(rawLogLine)) })); }
          catch (error) { t.diagnostic('원시험 서버 구간 읽기 실패: ' + error.code); }
          // EOF 뒤 signal은 라이브러리에서 무시될 수 있다. 호출 성공을 원격 종료 증거로 삼지 않는다.
          try { channel.signal('KILL'); t.diagnostic('시험 채널 KILL 요청: 원격 전달·종료는 확인되지 않음'); }
          catch (error) { t.diagnostic('시험 채널 중단: ' + error.message); }
          // 이 시험 프로세스에서만 쓰는 연결이다. 실패 채널이 Node 종료를 붙들지 않게 정리한다.
          try { connection.getClient().destroy(); }
          catch (error) { t.diagnostic('시험 연결 정리: ' + error.message); }
          try { await eofBoundaryDiagnostic(); }
          catch (error) { t.diagnostic('입력 종료 판별 준비 실패: ' + error.message); }
          try { await eofBoundaryDiagnostic(true); }
          catch (error) { t.diagnostic('직접 ReadFile 판별 준비 실패: ' + error.message); }
        }
        channel.close();
      }
    });

    await t.test('대기·거부 요청은 파일을 만들지 않고 승인 요청은 정확한 바이트를 왕복한다', async () => {
      const bytes = Buffer.alloc(262_161);
      for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
      const op = await uploadOperation('한글 공백.bin', bytes);
      const pending = queue.submitOperation(op);
      assert.equal(pending.state, 'pending');
      await absent(op.remotePath);
      queue.deny(pending.id);
      await assert.rejects(queue.approve(pending.id), /not pending/);
      await absent(op.remotePath);
      const approved = queue.submitOperation(op);
      const result = await queue.approve(approved.id);
      assert.equal(result.state, 'completed');
      assert.deepEqual(await readFile(op.remotePath), bytes);
      const downloaded = await transfers.download({ kind: 'download', remotePath: op.remotePath, elevate: false });
      assert.equal(downloaded.failed, false);
      assert.equal(downloaded.data.sha256, digest(bytes));
      assert.equal(downloaded.data.size, bytes.length);
      assert.deepEqual(await readFile(join(fixture.artifactRoot, downloaded.data.artifactId + '.part')), bytes);
      await assert.rejects(queue.approve(approved.id), /not pending/);
    });

    await t.test('빈 파일과 명시한 덮어쓰기는 성공하고 묵시적 덮어쓰기는 보존된다', async () => {
      const op = await uploadOperation('empty.bin', Buffer.alloc(0));
      assert.equal((await transfers.upload(op)).failed, false);
      const downloaded = await transfers.download({ kind: 'download', remotePath: op.remotePath, elevate: false });
      assert.equal(downloaded.failed, false);
      assert.equal(downloaded.data.size, 0);
      assert.deepEqual(await readFile(join(fixture.artifactRoot, downloaded.data.artifactId + '.part')), Buffer.alloc(0));
      const refused = await transfers.upload(await uploadOperation('empty.bin', Buffer.from('거부')));
      assert.equal(refused.failed, true);
      assert.equal(refused.data.errorCode, 'DESTINATION_EXISTS');
      assert.deepEqual(await readFile(op.remotePath), Buffer.alloc(0));
      const replaced = await transfers.upload(await uploadOperation('empty.bin', Buffer.from('승인된 교체'), true));
      assert.equal(replaced.failed, false, JSON.stringify({ errorCode: replaced.data?.errorCode, helper: helperFailures.slice(-3) }));
      assert.deepEqual(await readFile(op.remotePath), Buffer.from('승인된 교체'));
    });

    await t.test('파일 권한 상승은 비관리자에서 전송 전에 거부하고 관리자 토큰에서 왕복한다', async () => {
      const denied = await uploadOperation('nonadmin-elevated.bin', Buffer.from('거부'), false, true);
      const result = await transfers.upload(denied);
      assert.equal(result.failed, true);
      assert.equal(result.data.errorCode, 'PERMISSION_DENIED');
      await absent(denied.remotePath);
      assert.deepEqual(await readdir(fixture.stageRoot), []);
      const admin = await createSshRuntime({ BRIDGE_CONFIG_PATH: fixture.adminConfigPath, BRIDGE_HOST_KEY_MODE: 'strict' });
      try {
        const adminStore = new Artifacts(join(fixture.artifactRoot, 'admin'), { maxBytes: 1_048_576, budget: 2_097_152 });
        await adminStore.init();
        const adminTransfers = createTransferExecutor(admin.registry, adminStore, {
          platform: 'windows', helper: fixture.adminHelper, remoteStage: fixture.adminStageRoot,
          readProfile: 'admin-read', writeProfile: 'admin-write',
        });
        const bytes = Buffer.from([0, 255, 128, 32, 13, 10]);
        const meta = { fileName: 'admin-elevated.bin', remotePath: win32.join(fixture.adminFileRoot, 'admin-elevated.bin'),
          size: bytes.length, sha256: digest(bytes), overwrite: false, elevate: true };
        const item = await adminStore.begin(meta);
        await adminStore.append(item.id, 0, bytes); await adminStore.finish(item.id);
        let uploaded;
        try {
          uploaded = await adminTransfers.upload({ kind: 'upload', artifactId: item.id, ...meta });
          assert.equal(uploaded.failed, false, JSON.stringify(uploaded.data));
        } catch (error) {
          // 원시험의 10초 실패는 보존한다. 파일을 바꾸지 않는 같은 helper authorize로
          // 첫 계정/컴파일 준비 지연과 계속되는 stdin 수명 문제를 다음 후보에서 구분한다.
          const direct = await admin.registry.getOrCreate('admin-write');
          for (const timeoutMs of [60_000, 10_000]) {
            const started = Date.now();
            try {
              const result = await direct.exec(`powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${fixture.adminHelper}"`, {
                stdin: JSON.stringify({ action: 'authorize', id: 'd'.repeat(48), remotePath: meta.remotePath, elevate: true }), timeoutMs,
              });
              let data;
              try { data = JSON.parse(result.stdout); } catch { data = {}; }
              t.diagnostic(JSON.stringify({ 진단: '관리자 helper authorize 준비 지연', timeoutMs,
                경과밀리초: Date.now() - started, exitCode: result.exitCode, signal: result.signal,
                stdoutBytes: Buffer.byteLength(result.stdout ?? ''), stderrBytes: Buffer.byteLength(result.stderr ?? ''),
                authorized: data.authorized === true, elevated: data.elevated === true }));
              if (result.exitCode !== 0 || result.signal) break;
            } catch (probeError) {
              t.diagnostic(JSON.stringify({ 진단: '관리자 helper authorize 준비 지연', timeoutMs,
                경과밀리초: Date.now() - started, 오류: probeError.message }));
              break;
            }
          }
          throw error;
        }
        assert.deepEqual(await readFile(meta.remotePath), bytes);
        const downloaded = await adminTransfers.download({ kind: 'download', remotePath: meta.remotePath, elevate: true });
        assert.equal(downloaded.failed, false, JSON.stringify(downloaded.data));
        assert.equal(downloaded.data.sha256, digest(bytes));
        assert.deepEqual(await readFile(join(fixture.artifactRoot, 'admin', downloaded.data.artifactId + '.part')), bytes);
      } finally { await admin.registry.closeAll(); }
    });

    await t.test('고정 CLI 관리자는 실제 SSH에서 inspect와 로그인 상태를 반환한다', async () => {
      const binding = { targetId: 'windows-cli', targetRevision: 'e'.repeat(64), profile: 'windows-write', platform: 'windows' };
      const inspect = await runtime.executeAgentCli(prepareAgentCliPlan({ action: 'inspect', provider: 'codex', binding }), () => binding);
      assert.equal(inspect.failed, false);
      assert.equal(inspect.data.agentCli.action, 'inspect');
      assert.equal(typeof inspect.data.agentCli.installed, 'boolean');
      const login = await runtime.executeAgentCli(prepareAgentCliPlan({ action: 'login-status', provider: 'codex', binding }), () => binding);
      assert.equal(login.failed, false);
      assert.ok(['signed_in', 'signed_out', 'not_installed', 'unavailable'].includes(login.data.agentCli.state));
    });

    await t.test('고정 가짜 공급망으로 실제 SSH CLI 설치·갱신·보존·상태·실패 제한을 검증한다', async () => {
      const scriptPath = remote('cli-supply-fixture.ps1');
      const nodeDirectory = dirname(process.execPath).replaceAll("'", "''");
      await writeFile(scriptPath, `$env:PATH = '${nodeDirectory};' + $env:PATH\n${buildWindowsCliFixtureScript()}`, 'utf8');
      const result = await connection.exec(`powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${scriptPath}"`, { timeoutMs: 120_000 });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'ok');
      assert.equal(result.stderr, '');
    });

    await t.test('WRITER-ACL-01/02/03 실제 SSH는 IO-only와 effective inherited writer를 구분한다', async () => {
      assert.equal(fixture.writerAclFixtures.length, 2);
      const [io, inherited] = fixture.writerAclFixtures;
      const ioCreators = io.aces.filter(ace => ace.actor === 'creator-owner' && ace.kind === 'AccessAllowed');
      assert.ok(ioCreators.length > 0);
      assert.ok(ioCreators.every(ace => (ace.flags & 8) !== 0));
      const effectiveCreates = inherited.aces.filter(ace => ace.actor === 'users' && ace.kind === 'AccessAllowed'
        && (ace.flags & 16) !== 0 && (ace.flags & 8) === 0);
      assert.equal(effectiveCreates.reduce((mask, ace) => mask | ace.mask, 0) & 6, 6);
      assert.ok(inherited.aces.some(ace => ace.actor === 'creator-owner' && (ace.flags & 8) !== 0));
      // The snapshot is fixture metadata; compare the actual post-transfer ACL via
      // the connected SSH identity as well, without printing SID/SDDL or repairing it.
      const aclHash = async directory => {
        const encoded = Buffer.from(directory, 'utf8').toString('base64');
        const result = await call(`$ErrorActionPreference='Stop';$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$sddl=[string](Get-Acl -LiteralPath $path).Sddl;$sha=[Security.Cryptography.SHA256]::Create();try{[Console]::Write([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($sddl))).Replace('-','').ToLowerInvariant())}finally{$sha.Dispose()}`);
        assert.equal(result.exitCode, 0);
        const value = result.stdout.trim();
        assert.match(value, /^[a-f0-9]{64}$/);
        return value;
      };
      for (const entry of [io, inherited]) assert.equal(await aclHash(entry.directory), entry.aclSha256);
      const bypass = createTransferExecutor(runtime.registry, store, { platform: 'windows', helper: fixture.helper,
        remoteStage: fixture.stageRoot, readProfile: 'windows-read', writeProfile: 'windows-write', transport,
        pathPolicy: async () => ({ bypassRoot: true }) });
      const binary = Buffer.from([0, 255, 13, 10, 128]);
      const operationAt = async directory => {
        const meta = { fileName: 'writer-contract.bin', remotePath: win32.join(directory, 'writer-contract.bin'),
          size: binary.length, sha256: digest(binary), overwrite: false, elevate: false };
        const item = await store.begin(meta);
        await store.append(item.id, 0, binary); await store.finish(item.id);
        return { kind: 'upload', artifactId: item.id, ...meta };
      };
      const positive = await operationAt(io.directory);
      assert.equal((await bypass.upload(positive)).failed, false);
      assert.deepEqual(await readFile(positive.remotePath), binary);
      const snapshot = await bypass.download({ kind: 'download', remotePath: positive.remotePath, elevate: false });
      assert.equal(snapshot.failed, false);
      assert.equal(snapshot.data.sha256, digest(binary));
      const fd = await store.verified(snapshot.data.artifactId);
      const received = Buffer.alloc(binary.length);
      try { await fd.read(received, 0, received.length, 0); } finally { await fd.close(); }
      assert.deepEqual(received, binary);
      const refused = await operationAt(inherited.directory);
      const policyFailure = await bypass.upload(refused);
      assert.equal(policyFailure.failed, true);
      assert.deepEqual(policyFailure.data, { errorCode: 'PERMISSION_DENIED',
        diagnostic: { origin: 'policy', policyReason: 'UNTRUSTED_WRITER' } });
      await absent(refused.remotePath);
      const osRefused = await operationAt(fixture.adminFileRoot);
      const osFailure = await bypass.upload(osRefused);
      assert.equal(osFailure.failed, true);
      assert.deepEqual(osFailure.data, { errorCode: 'PERMISSION_DENIED', diagnostic: { origin: 'os', nativeStep: 'open', nativeError: 5 } });
      await absent(osRefused.remotePath);
      for (const entry of [io, inherited]) assert.equal(await aclHash(entry.directory), entry.aclSha256);
      assert.deepEqual(await readdir(fixture.stageRoot), []);
    });

    await t.test('테스트 모드의 루트 우회는 실제 SSH 계정 권한을 유지한다', async () => {
      const session = await transport.connect('windows-write');
      const helperCommand = `powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${fixture.helper}"`;
      const invoke = async payload => {
        const result = await session.call(helperCommand, payload);
        return { ...result, data: JSON.parse(result.stdout) };
      };
      const outsidePath = win32.join(win32.dirname(fixture.outsideFile), 'testmode-upload.bin');
      const bytes = Buffer.from([0, 255, 17, 13, 10]);
      const id = '1'.repeat(48), snapshotId = '2'.repeat(48), deniedId = '3'.repeat(48);
      const payload = { action: 'publish', id, remotePath: outsidePath, size: bytes.length,
        sha256: digest(bytes), maxBytes: 1_048_576, overwrite: false, elevate: false };
      const policy = await invoke({ action: 'policy', id, bypassRoot: true });
      assert.equal(policy.exitCode, 0);
      assert.equal(policy.data.protocol, 'file-path-policy-v1');
      assert.equal(policy.data.allowedRoot, fixture.fileRoot);
      assert.equal(policy.data.rootPolicyApplied, 'test-server-bypass');
      try {
        await writeFile(join(fixture.stageRoot, id + '.part'), bytes);
        const deniedRoot = await invoke({ ...payload, allowedRoot: win32.dirname(fixture.outsideFile) });
        assert.equal(deniedRoot.exitCode, 1);
        assert.equal(deniedRoot.data.errorCode, 'PATH_OUTSIDE_ALLOWED_ROOT');
        assert.equal(deniedRoot.data.allowedRoot, fixture.fileRoot);
        await absent(outsidePath);
        const published = await invoke({ ...payload, bypassRoot: true });
        assert.equal(published.exitCode, 0, JSON.stringify(published.data));
        assert.equal(published.data.published, true);
        assert.equal(published.data.rootPolicyApplied, 'test-server-bypass');
        assert.deepEqual(await readFile(outsidePath), bytes);
        const snapshot = await invoke({ action: 'snapshot', id: snapshotId, remotePath: outsidePath,
          maxBytes: 1_048_576, bypassRoot: true });
        assert.equal(snapshot.exitCode, 0, JSON.stringify(snapshot.data));
        assert.equal(snapshot.data.rootPolicyApplied, 'test-server-bypass');
        assert.deepEqual(await readFile(join(fixture.stageRoot, snapshotId + '.part')), bytes);
        await writeFile(join(fixture.stageRoot, deniedId + '.part'), bytes);
        const forbiddenPath = win32.join(fixture.adminFileRoot, 'testmode-must-not-exist.bin');
        const denied = await invoke({ ...payload, id: deniedId, remotePath: forbiddenPath, bypassRoot: true });
        assert.equal(denied.exitCode, 1);
        assert.equal(denied.data.errorCode, 'PERMISSION_DENIED');
        assert.equal(denied.data.nativeStep, 'open');
        assert.equal(denied.data.nativeError, 5);
        assert.equal(denied.data.origin, 'os');
        assert.equal(denied.data.policyReason, undefined);
        assert.notEqual(denied.data.published, true);
        await absent(forbiddenPath);
      } finally {
        for (const stagedId of [id, snapshotId, deniedId]) {
          const cleaned = await invoke({ action: 'cleanup', id: stagedId, bypassRoot: true });
          assert.equal(cleaned.exitCode, 0, JSON.stringify(cleaned.data));
        }
      }
      assert.deepEqual(await readdir(fixture.stageRoot), []);
    });

    await t.test('보조프로그램은 위험 경로·상태 변경·크기 초과를 거부한다', async () => {
      const session = await transport.connect('windows-write');
      // 전송 계층 검사에 앞서 설치된 보조프로그램의 별도 방어 경계를 직접 검사한다.
      const helperCommand = `powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${fixture.helper}"`;
      const unsafe = [remote('x:stream'), '//localhost/C$/outside.bin', '//?/C:/Windows/win.ini',
        remote('CON'), remote('NUL.txt'), remote('COM1.log'), remote('LPT9'), fixture.fileRoot + '/../outside.bin',
        remote('trailing.'), remote('trailing '), remote('junction/outside.bin'), remote('symlink.bin')];
      // 일반 정책과 우회 정책의 전체 문법/링크 대조는 PowerShell helper suite가 맡는다.
      for (const remotePath of unsafe) {
        const result = await session.call(helperCommand, { action: 'snapshot', id: 'a'.repeat(48), remotePath, maxBytes: 1_048_576, bypassRoot: true });
        assert.equal(result.exitCode, 1, `위험 경로 허용: ${remotePath}`);
        assert.equal(JSON.parse(result.stdout).errorCode, 'UNSAFE_PATH');
      }
      const id = 'b'.repeat(48), bytes = Buffer.from('고정된 입력');
      await writeFile(join(fixture.stageRoot, id + '.part'), bytes);
      const changed = await session.call(helperCommand, { action: 'publish', id, remotePath: remote('changed.bin'), size: bytes.length, sha256: '0'.repeat(64), maxBytes: 1_048_576, overwrite: false });
      assert.equal(changed.exitCode, 1);
      assert.equal(JSON.parse(changed.stdout).errorCode, 'FILE_CHANGED');
      await absent(remote('changed.bin'));
      const tooLarge = await session.call(helperCommand, { action: 'snapshot', id: 'c'.repeat(48), remotePath: remote('한글 공백.bin'), maxBytes: 4 });
      assert.equal(tooLarge.exitCode, 1);
      assert.equal(JSON.parse(tooLarge.stdout).errorCode, 'FILE_TOO_LARGE');
      await session.call(helperCommand, { action: 'cleanup', id });
      assert.deepEqual(await readdir(fixture.stageRoot), []);
      assert.equal(await readFile(fixture.outsideFile, 'utf8'), '영역 밖 원본');
    });

    await t.test('틀린 클라이언트 키와 호스트 키는 인증을 통과하지 못한다', async () => {
      for (const configPath of [fixture.wrongClientConfig, fixture.wrongHostConfig]) {
        const rejected = await createSshRuntime({ BRIDGE_CONFIG_PATH: configPath, BRIDGE_HOST_KEY_MODE: 'strict' });
        try { await assert.rejects(rejected.executeCommand('windows-write', wrapWindowsCommand('[Console]::Write("금지")'))); }
        finally { await rejected.registry.closeAll(); }
      }
    });
  } finally {
    await runtime.registry.closeAll();
  }
});
