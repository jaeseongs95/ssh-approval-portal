import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, win32 } from 'node:path';
import { createSshRuntime, createSshTransport } from '../src/adapters/ssh/vendor.mjs';
import { Artifacts } from '../src/adapters/storage/artifacts.mjs';
import { createTransferExecutor } from '../src/adapters/ssh/transfers.mjs';
import { ApprovalQueue } from '../src/domain/approval-queue.mjs';

// 시험 계획: 실제 sshd/키/고정 호스트 키/비관리자 계정/SFTP/설치된 보조프로그램을
// 통과한다. 바이트 비교는 입력 원본과 직접 비교하며 구현의 결과를 기대값으로 쓰지 않는다.
// 정상: UTF-8·따옴표·256 KiB 초과·빈 파일. 경계: 덮어쓰기·크기·승인·시간초과.
// 오류: 인증·호스트 키·ADS·UNC·장치·상위 이동·재분석 지점. 실제 서버 없는 실행은 생략한다.
const fixturePath = process.env.AGS_WINDOWS_SSH_FIXTURE;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const absent = async path => assert.rejects(access(path), { code: 'ENOENT' });

test('실제 Windows SSH 명령·승인·파일 전송 경계', {
  skip: !fixturePath, timeout: 180_000,
}, async t => {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const { wrapWindowsCommand } = await import('../src/domain/target-platform.mjs');
  const runtime = await createSshRuntime({ BRIDGE_CONFIG_PATH: fixture.configPath, BRIDGE_HOST_KEY_MODE: 'strict' });
  const transport = createSshTransport(runtime.registry);
  const store = new Artifacts(fixture.artifactRoot, { maxBytes: 1_048_576, budget: 8_388_608 });
  await store.init();
  const transfers = createTransferExecutor(runtime.registry, store, {
    platform: 'windows', helper: fixture.helper, remoteStage: fixture.stageRoot,
    readProfile: 'windows-read', writeProfile: 'windows-write',
  });
  const remote = name => win32.join(fixture.fileRoot, name).replaceAll('\\', '/');
  const connection = await runtime.registry.getOrCreate('windows-write');
  const call = script => connection.exec(wrapWindowsCommand(script));
  const uploadOperation = async (name, bytes, overwrite = false) => {
    const meta = { fileName: name, remotePath: remote(name), size: bytes.length, sha256: digest(bytes), overwrite, elevate: false };
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
      const result = await runtime.executeCommand('windows-write', wrapWindowsCommand(`[Console]::Write('${marker.replaceAll("'", "''")}')`));
      assert.equal(result.failed, false);
      assert.deepEqual(result.texts, [marker]);
      const failed = await call('[Console]::Error.Write("예상 실패"); exit 7');
      assert.equal(failed.exitCode, 7);
      assert.equal(failed.stderr, '예상 실패');
    });

    await t.test('정확한 기본 읽기 명령은 외부 모듈 검색 경로에 있는 동명 합성 모듈을 불러오지 않는다', async () => {
      for (const command of ['Microsoft.PowerShell.Utility\\Get-Date', 'Microsoft.PowerShell.Management\\Get-Location']) {
        const inner = wrapWindowsCommand(command);
        // 외부 명령의 환경만 오염시킨다. 자식은 제품의 실제 기본 읽기 명령 런처다.
        const outer = wrapWindowsCommand(`$env:PSModulePath = '${fixture.modulesRoot.replaceAll("'", "''")}'; ${inner}`);
        const result = await runtime.executeCommand('windows-read', outer);
        assert.equal(result.failed, false);
        assert.ok(result.texts.join('').trim(), '기본 명령의 정상 출력이 없음');
        assert.doesNotMatch(result.texts.join(''), /untrusted module loaded/);
        for (const marker of fixture.moduleMarkers) await absent(marker);
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
      assert.equal((await transfers.upload(await uploadOperation('empty.bin', Buffer.from('승인된 교체'), true))).failed, false);
      assert.deepEqual(await readFile(op.remotePath), Buffer.from('승인된 교체'));
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
