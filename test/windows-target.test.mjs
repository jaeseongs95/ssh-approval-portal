import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApplication } from '../app.mjs';
import { parseTargets, resolveTargets } from '../src/adapters/config/targets.mjs';
import { classifyForTarget, platformOf, targetCapabilities, wrapWindowsCommand } from '../src/domain/target-platform.mjs';

// 시험 계획: WIN-CONFIG는 기존 revision 보존, WIN-ENCODE는 OB-IDENTITY/OB-BOUND,
// WIN-POLICY는 승인 경계, WIN-CAPABILITY는 TEST를 포함한 비지원 거부를 검사한다.
// 실제 app·큐·저장소·관리자 API를 사용하고 SSH·평가자만 합성 포트로 대체한다.
// 실제 PowerShell 구문 실행, helper 파일 시스템 경합과 OB-ACK 장애 주입은 별도 Windows CI 범위다.
const windows = { platform: 'windows' };
const entry = { id: 'windows', displayName: '합성 Windows 대상', readProfile: 'windows-read', writeProfile: 'windows-write', credentialRevision: 'v1' };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const profilesFor = () => new Map([entry.readProfile, entry.writeProfile].map(name => [name, {
  host: 'windows.example.test', port: 22, user: 'synthetic', trustedHostKey: 'SHA256:synthetic-windows-host', readOnly: name === entry.readProfile,
}]));
const registryFor = profiles => ({ getProfile: name => profiles.get(name), closeAll: async () => {} });
const encodedScript = command => {
  const encoded = command.split(' -EncodedCommand ')[1];
  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/);
  return Buffer.from(encoded, 'base64').toString('utf16le');
};

test('WIN-CONFIG 기존 Linux revision을 보존하고 명시 플랫폼과 Windows workdir를 검증한다', () => {
  const profiles = profilesFor(), registry = registryFor(profiles);
  const targets = parseTargets(JSON.stringify([entry]));
  const linux = resolveTargets({ targets }, registry)[0];
  // f896df9의 기존 entry·reader·writer 해시 계약을 고정한다.
  const baseline = sha256(JSON.stringify({ entry: { ...entry, enabled: true }, reader: profiles.get(entry.readProfile), writer: profiles.get(entry.writeProfile) }));
  assert.equal(linux.revision, baseline);
  assert.equal(Object.hasOwn(targets[0], 'platform'), false);
  assert.equal(platformOf(linux), 'linux');
  assert.equal(targetCapabilities(linux).commandShell, 'posix');
  const legacy = resolveTargets({ targets: null, targetDisplayName: 'SSH', readProfile: entry.readProfile, writeProfile: entry.writeProfile }, registry)[0];
  assert.equal(legacy.revision, sha256(JSON.stringify({
    entry: { id: 'default', displayName: 'SSH', readProfile: entry.readProfile, writeProfile: entry.writeProfile, enabled: true },
    reader: profiles.get(entry.readProfile), writer: profiles.get(entry.writeProfile),
  })));
  assert.equal(legacy.identity, undefined);
  const configured = platform => ({ targets: parseTargets(JSON.stringify([{ ...entry, platform }])) });
  const win = resolveTargets(configured('windows'), registry)[0];
  assert.notEqual(win.revision, baseline);
  assert.notEqual(win.revision, resolveTargets(configured('linux'), registry)[0].revision);
  assert.equal(win.identity.targetRevision, win.revision);
  for (const value of ['Windows', 'win32', '', null, true]) {
    assert.throws(() => parseTargets(JSON.stringify([{ ...entry, platform: value }])), /target configuration/);
  }
  for (const name of [entry.readProfile, entry.writeProfile]) {
    profiles.get(name).workdir = '/tmp';
    assert.throws(() => resolveTargets(configured('windows'), registry), /workdir/);
    delete profiles.get(name).workdir;
  }
  win.verify();
  profiles.get(entry.writeProfile).host = 'changed.example.test';
  assert.throws(() => win.verify(), /configuration changed/);
});

test('WIN-ENCODE UTF-16LE 래퍼가 원문과 셸 특수문자를 보존하고 제어문자를 거부한다', () => {
  const raw = "Write-Output '한글 😀 \"따옴표\" %PATH% !X! $env:TEMP'; Write-Output 'x`y'; exit 7";
  const wrapped = wrapWindowsCommand(raw), script = encodedScript(wrapped);
  assert.match(wrapped, /^powershell\.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -InputFormat Text -OutputFormat Text -EncodedCommand /);
  assert.equal(script.includes(raw), true);
  assert.equal(script.indexOf(raw), script.lastIndexOf(raw));
  assert.equal(wrapped.includes(raw), false);
  assert.match(script, /\[Console\]::OutputEncoding=/);
  assert.match(script, /exit \$LASTEXITCODE/);
  for (const raw of ['', ' ', 'x\0y', 'x\ny', 'x\ry', 'x\ty', 'x\x1by', 'x\x7fy', 'x\x85y', '\ud800']) {
    assert.throws(() => wrapWindowsCommand(raw), /Invalid Windows command/);
  }
});

test('WIN-BOUND ASCII·한글·이모지 모두 실제 인코딩 명령 8000자 경계를 적용하고 자르지 않는다', () => {
  for (const unit of ['x', '가', '😀']) {
    let low = 1, high = 4096;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      try { wrapWindowsCommand(unit.repeat(middle)); low = middle; }
      catch (error) { assert.equal(error.code, 'WINDOWS_COMMAND_TOO_LARGE'); high = middle; }
    }
    const raw = unit.repeat(low), wrapped = wrapWindowsCommand(raw);
    assert.ok(wrapped.length <= 8000);
    assert.ok(wrapped.length >= 7993, 'Base64 네 글자 묶음보다 큰 여유를 남겨서는 안 된다');
    assert.equal(encodedScript(wrapped).includes(raw), true);
    assert.throws(() => wrapWindowsCommand(unit.repeat(high)), { code: 'WINDOWS_COMMAND_TOO_LARGE' });
  }
});

test('WIN-CLASSIFY POSIX 분류를 우회하지 않고 모듈 한정 무인수 읽기 두 개만 허용한다', () => {
  let calls = 0;
  const posix = () => { calls++; return { class: 'read-only' }; };
  assert.equal(classifyForTarget({}, posix), posix);
  const classify = classifyForTarget(windows, posix);
  for (const raw of ['Microsoft.PowerShell.Utility\\Get-Date', 'Microsoft.PowerShell.Management\\Get-Location', '  microsoft.powershell.utility\\get-date  ']) {
    assert.equal(classify(raw).class, 'read-only', raw);
  }
  for (const raw of ['Get-Date', 'Get-Location', 'Get-Command', 'hostname', 'ls', 'pwd',
    'Microsoft.PowerShell.Utility\\Get-Date -Format o', 'Microsoft.PowerShell.Utility\\Get-Date; Remove-Item x',
    'Microsoft.PowerShell.Management\\Get-Location | Set-Content x', '& { Get-Date }', 'Write-Output $(Get-Date)']) {
    assert.equal(classify(raw).class, 'safe', raw);
  }
  assert.equal(calls, 0, 'Windows 분류에서 POSIX 분류 결과를 승인 근거로 사용하면 안 된다');
});

async function fixture(t, { automation = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'windows-target-')), profiles = profilesFor();
  const executions = [], inputs = [], events = [], unsupported = [];
  const env = { BRIDGE_MCP_TOKEN: 'synthetic-mcp', BRIDGE_ADMIN_TOKEN: 'synthetic-owner',
    BRIDGE_ADMIN_ORIGIN: 'https://owner.example.test', BRIDGE_UI_TICKET_KEY: 'd'.repeat(64),
    BRIDGE_TARGETS: JSON.stringify([{ ...entry, platform: 'windows' }]), BRIDGE_DEFAULT_TARGET: entry.id,
    BRIDGE_COMMAND_AUTOMATION: String(automation), BRIDGE_TEST_SERVER_SECRET_REF: 'secret://fixture/test-server' };
  const app = await createApplication({ registry: registryFor(profiles), transferRoot: root, env,
    classify: () => ({ class: 'read-only' }), audit: event => events.push(event), uiHtml: '<html>합성 시험</html>',
    secretResolver: { resolve: async () => '1'.repeat(64) },
    executeCommand: async (profile, command, beforeDispatch) => {
      await beforeDispatch(); executions.push({ profile, command }); return { failed: false, texts: ['synthetic-outcome'] };
    },
    executePythonSource: async () => { unsupported.push('source'); throw Error('비지원 경로가 실행되었습니다'); },
    executeAgentCli: async () => { unsupported.push('agent-cli'); throw Error('비지원 경로가 실행되었습니다'); },
    riskEvaluators: { jev: { model: 'synthetic-assessor', questionVersion: 'ssh-command-risk-v5', async assess(input) {
      inputs.push(input); return { status: 'assessed', model: 'synthetic-assessor', label: 'low_risk', confidence: 1, probabilities: { low_risk: 1, high_risk: 0 } };
    } } },
  });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.adminHttp.address().port}`;
  const api = async (path, body) => {
    const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer synthetic-owner', ...(body === undefined ? {} : { Origin: env.BRIDGE_ADMIN_ORIGIN, 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const policy = async changes => {
    const current = (await api('/api/command-policy')).body, binding = current.bindings[0];
    const rule = { targetId: binding.targetId, targetRevision: binding.targetRevision, profile: binding.profile,
      commands: ['Write-Output'], deniedCommands: [], automaticSudo: false, externalDisclosure: true,
      modelExecution: false, fallback: null, thresholds: {}, ...changes };
    const proposal = { expectedRevision: current.revision, policy: { targets: [rule] } };
    const review = await api('/api/command-policy/review', proposal);
    assert.equal(review.status, 200);
    assert.equal((await api('/api/command-policy', { ...proposal, reviewToken: review.body.reviewToken, acknowledged: true })).status, 200);
  };
  const run = async command => {
    const result = await app.targets.commands.run(command, entry.id, undefined, '합성 대상의 동작만 확인하며 외부 자원은 사용하지 않습니다.');
    await app.targets.drain();
    return app.queue.get(result.job.id);
  };
  return { app, executions, inputs, events, unsupported, api, policy, run };
}

test('WIN-APP safe 명령은 소유자 승인을 거치고 원문·출력 수명과 실제 래퍼를 보존한다', async t => {
  const f = await fixture(t), raw = "Write-Output '한글 %PATH% !X! $env:TEMP'";
  await assert.rejects(f.app.targets.commands.read('hostname', entry.id), { code: 'READ_COMMAND_REQUIRES_APPROVAL' });
  const job = await f.run(raw);
  assert.equal(job.state, 'pending');
  assert.equal(job.commandClass, 'safe');
  assert.equal(job.command, raw);
  assert.equal(job.operation.command, raw);
  assert.equal(f.executions.length, 0);
  const completed = await f.app.queue.approve(job.id);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.command, raw);
  assert.equal(completed.result.output.state, 'ready');
  assert.equal(f.executions[0].profile, entry.writeProfile);
  assert.equal(encodedScript(f.executions[0].command).includes(raw), true);
  assert.ok(f.events.some(event => event.action === 'approved' && event.command === raw));
  const output = await f.api('/api/outputs/' + completed.result.output.id);
  assert.equal(output.status, 200);
  assert.equal(output.body.text, 'synthetic-outcome');
  assert.equal(f.executions.length, 1, '출력 읽기는 명령을 재실행하지 않는다');
  const read = await f.app.targets.commands.read('Microsoft.PowerShell.Utility\\Get-Date', entry.id);
  assert.equal(read.failed, false);
  assert.equal(f.executions[1].profile, entry.readProfile);
  assert.equal(encodedScript(f.executions[1].command).includes('Microsoft.PowerShell.Utility\\Get-Date'), true);
  const admitted = f.app.queue.listAll().length;
  for (const raw of ['x'.repeat(4000), 'x\ny', 'x\u202ey']) await assert.rejects(f.run(raw));
  assert.equal(f.app.queue.listAll().length, admitted);
  assert.equal(f.executions.length, 2);
});

test('WIN-POLICY 이름 사전승인과 명시승인을 무효화하고 플랫폼 문맥·대소문자 거부를 적용한다', async t => {
  const f = await fixture(t, { automation: true });
  await f.policy({ commands: ['Write-Output'] });
  const raw = 'Write-Output "synthetic"', job = await f.run(raw);
  assert.equal(job.state, 'pending');
  assert.equal(job.decision.reasonCode, 'observation_only');
  assert.equal(f.executions.length, 0);
  assert.equal(f.inputs.length, 1);
  assert.equal(f.inputs[0].command, raw);
  assert.deepEqual(f.inputs[0].preapprovedCommands, []);
  assert.equal(f.inputs[0].userApproval.explicit, false);
  const facts = JSON.parse(f.inputs[0].context).serverFacts;
  assert.equal(facts.targetPlatform, 'windows');
  assert.equal(facts.commandLanguage, 'windows-powershell-5.1');
  assert.equal(facts.targetRevision, job.targetRevision);
  await f.policy({ commands: ['Remove-Item'], deniedCommands: ['Remove-Item'] });
  for (const raw of ['rEmOvE-iTeM C:\\synthetic\\never', 'Microsoft.PowerShell.Management\\REMOVE-ITEM C:\\synthetic\\never']) {
    const denied = await f.run(raw);
    assert.equal(denied.state, 'denied');
    assert.equal(denied.decision.reasonCode, 'policy_denied');
  }
  assert.equal(f.inputs.length, 1);
  assert.equal(f.executions.length, 0);
});

test('WIN-CAPABILITY source·agent CLI 비지원은 TEST에서도 동일하며 지원 행렬과 일치한다', async t => {
  const f = await fixture(t, { automation: true });
  const listed = (await f.api('/api/targets')).body.targets[0];
  assert.equal(listed.platform, 'windows');
  assert.deepEqual(listed.capabilities, { commandShell: 'windows-powershell-5.1', fileTransfer: true,
    elevatedFileTransfer: false, pythonSource: false, agentCli: false, commandNameApproval: false });
  const cli = (await f.api('/api/agent-cli')).body.bindings[0];
  assert.equal(cli.platform, 'windows');
  assert.equal(cli.supported, false);
  for (const testServer of [false, true]) {
    await f.policy({ testServer, commands: [], externalDisclosure: false });
    if (testServer) {
      const control = await f.run('Write-Output synthetic');
      assert.equal(control.state, 'completed');
      assert.equal(control.decision.reasonCode, 'test_server_bypass');
    }
    const before = f.app.queue.listAll().length;
    assert.throws(() => f.app.targets.commands.runSource({ source: 'print(1)', cwd: '/tmp' }, entry.id), { code: 'TARGET_CAPABILITY_UNSUPPORTED' });
    for (const [action, body] of [
      ['login-status', { targetId: entry.id, provider: 'codex' }],
      ['preview', { targetId: entry.id, provider: 'codex', action: 'install' }],
      ['submit', { request: { targetId: entry.id } }],
    ]) assert.equal((await f.api('/api/agent-cli/' + action, body)).status, 409, action);
    await assert.rejects(f.run('x'.repeat(4000)), { code: 'WINDOWS_COMMAND_TOO_LARGE' });
    assert.equal(f.app.queue.listAll().length, before);
  }
  assert.deepEqual(f.unsupported, []);
  assert.equal(f.executions.length, 1, '정상 TEST 명령만 한 번 실행되고 비지원 요청은 실행되지 않는다');
});
