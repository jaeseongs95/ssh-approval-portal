import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join, dirname, win32 } from 'node:path';
import { createSshRuntime, createSshTransport } from '../src/adapters/ssh/vendor.mjs';
import { Artifacts } from '../src/adapters/storage/artifacts.mjs';
import { createTransferExecutor } from '../src/adapters/ssh/transfers.mjs';
import { ApprovalQueue } from '../src/domain/approval-queue.mjs';
import { prepareAgentCliPlan } from '../src/adapters/ssh/agent-cli.mjs';
import { buildWindowsCliFixtureScript } from './windows-agent-cli-fixture.mjs';

// 시험 계획: 실제 sshd/키/고정 호스트 키/비관리자 계정/SFTP/설치된 보조프로그램을
// 통과한다. 바이트 비교는 입력 원본과 직접 비교하며 구현의 결과를 기대값으로 쓰지 않는다.
// 정상: UTF-8·따옴표·256 KiB 초과·빈 파일. 경계: 덮어쓰기·크기·승인·시간초과.
// 오류: 인증·호스트 키·ADS·UNC·장치·상위 이동·재분석 지점. 실제 서버 없는 실행은 생략한다.
const fixturePath = process.env.AGS_WINDOWS_SSH_FIXTURE;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const absent = async path => assert.rejects(access(path), { code: 'ENOENT' });

test('실제 Windows SSH 명령·승인·파일 전송 경계', {
  // 제품 요청과 원시험 제한은 유지한다. 실패시 native EOF 60초와 관리자 60+10초
  // 판별 자료가 중간에 취소되지 않게 180초+60초+70초와 정리 20초를 배정한다.
  skip: !fixturePath, timeout: 330_000,
}, async t => {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const { wrapWindowsCommand, prepareWindowsCommand, commandNamesForTarget } = await import('../src/domain/target-platform.mjs');
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
        const codes = ['PARENT_NOT_FOUND', 'FILE_NOT_FOUND', 'PERMISSION_DENIED', 'DESTINATION_EXISTS', 'UNSAFE_PATH', 'STAGING_UNAVAILABLE', 'FILE_CHANGED', 'FILE_TOO_LARGE', 'INVALID_REQUEST', 'OPERATION_FAILED'];
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
  // 제품의 고정 stdin→즉시 end 경로와 별개인 지연 EOF 실패 때만 클라이언트를 바꿔 판별한다.
  const nativeEofDiagnostic = async (prepared, marker) => {
    const events = [], started = Date.now();
    let stdout = '', stderr = '', timer, beforeEofAbsent = false;
    const child = spawn(fixture.sshClient, ['-F', fixture.nativeClientConfig, '-T', 'ags-fixture', prepared.command], { windowsHide: true });
    child.stdout.on('data', bytes => { stdout += bytes.toString('utf8'); });
    child.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); });
    child.stdin.on('finish', () => events.push('로컬 EOF 전송 완료'));
    child.stdin.on('error', error => events.push('로컬 입력 오류: ' + error.code));
    const finished = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', () => events.push('클라이언트 종료'));
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    finished.catch(() => {});
    try {
      child.stdin.write(Buffer.from(prepared.stdin));
      await new Promise(resolve => setTimeout(resolve, 1500));
      beforeEofAbsent = await access(marker).then(() => false, error => {
        if (error.code === 'ENOENT') return true;
        throw error;
      });
      child.stdin.end();
      const result = await Promise.race([finished, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('기본 SSH 지연 EOF 진단 시간초과')), 60_000);
      })]);
      t.diagnostic(JSON.stringify({ 진단: '기본 SSH 지연 EOF 비교', 경과밀리초: Date.now() - started,
        사건: events, ...result, stdout, stderr, EOF이전무효과: beforeEofAbsent,
        효과확인: await readFile(marker, 'utf8').then(value => value === 'once', () => false) }));
    } catch (error) {
      t.diagnostic(JSON.stringify({ 진단: '기본 SSH 지연 EOF 비교', 경과밀리초: Date.now() - started,
        사건: events, 오류: error.message, stdout, stderr, EOF이전무효과: beforeEofAbsent }));
    } finally {
      clearTimeout(timer);
      child.stdin.destroy();
      if (child.exitCode === null) child.kill();
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
      } catch (error) {
        await directDiagnostic('한글 명령 직접 경로', wrapped);
        throw error;
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
      await assert.rejects(runtime.executeCommand('windows-write', wrapWindowsCommand(`Set-Content -LiteralPath '${marker}' -Value '실행 금지'`), () => { throw Error('승인 만료'); }), /승인 만료/);
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
          효과확인: await readFile(marker, 'utf8').then(value => value === 'once', () => false) }));
        clearTimeout(deadline); channel.end();
        if (!complete) {
          try { channel.signal('KILL'); }
          catch (error) { t.diagnostic('시험 채널 중단: ' + error.message); }
          // 이 시험 프로세스에서만 쓰는 연결이다. 실패 채널이 Node 종료를 붙들지 않게 정리한다.
          try { connection.getClient().destroy(); }
          catch (error) { t.diagnostic('시험 연결 정리: ' + error.message); }
          await nativeEofDiagnostic(prepared, marker);
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

    await t.test('보조프로그램은 위험 경로·상태 변경·크기 초과를 거부한다', async () => {
      const session = await transport.connect('windows-write');
      // 전송 계층 검사에 앞서 설치된 보조프로그램의 별도 방어 경계를 직접 검사한다.
      const helperCommand = `powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${fixture.helper}"`;
      const unsafe = [remote('x:stream'), '//localhost/C$/outside.bin', '//?/C:/Windows/win.ini', 'C:/Windows/win.ini',
        remote('CON'), remote('NUL.txt'), remote('COM1.log'), remote('LPT9'), fixture.fileRoot + '/../outside.bin',
        remote('trailing.'), remote('trailing '), remote('junction/outside.bin'), remote('symlink.bin')];
      for (const remotePath of unsafe) {
        const result = await session.call(helperCommand, { action: 'snapshot', id: 'a'.repeat(48), remotePath, maxBytes: 1_048_576 });
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
