import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../app.mjs';
import { parseTargets, resolveTargets } from '../src/adapters/config/targets.mjs';
import { validateCommandPolicy } from '../src/domain/command-policy.mjs';
import { executeAgentCli, executePythonSource } from '../src/adapters/ssh/vendor.mjs';
import { prepareAgentCliPlan } from '../src/adapters/ssh/agent-cli.mjs';
import { preparePythonSource } from '../src/adapters/ssh/python-source.mjs';

const entry = { id: 'windows', displayName: 'Windows 합성 대상', platform: 'windows', readProfile: 'win-read', writeProfile: 'win-write', credentialRevision: 'v1' };
const profiles = new Map(['win-read', 'win-write'].map(name => [name, { name, host: 'windows.example.test', port: 22, user: 'synthetic', readOnly: name === 'win-read', tty: false, trustedHostKey: 'SHA256:synthetic' }]));
const registry = { getProfile: name => profiles.get(name), closeAll: async () => {} };
const definition = patch => resolveTargets({ targets: parseTargets(JSON.stringify([{ ...entry, ...patch }])) }, registry)[0];

test('Windows 런타임 설정은 대상 revision에 결속되고 TTY·POSIX 작업 폴더를 거부한다', () => {
  const original = definition({}), configured = definition({ pythonExecutable: 'C:/Python313/python.exe', workdir: 'C:/work' });
  assert.notEqual(configured.revision, original.revision);
  assert.notEqual(configured.revision, definition({ pythonExecutable: 'C:/Python313/python.exe', workdir: 'C:/other' }).revision);
  for (const patch of [{ platform: 'linux', pythonExecutable: 'C:/Python313/python.exe' }, { pythonExecutable: 'python.exe' }, { pythonExecutable: 'C:/Python313/python.cmd' }, { pythonExecutable: 'C:/Python313/other.exe' }, { workdir: 'C:/work/../other' }, { workdir: 'C:/work\u202e' }]) assert.throws(() => definition(patch));
  for (const name of profiles.keys()) {
    profiles.get(name).tty = true;
    try { assert.throws(() => definition({}), /non-TTY/); }
    finally { profiles.get(name).tty = false; }
  }
});

test('Windows 정책의 명령 이름은 플랫폼을 명시하고 정규화 중복을 거부한다', () => {
  const rule = { targetId: 'windows', targetRevision: 'a'.repeat(64), profile: 'win-write', platform: 'windows', commands: ['Microsoft.PowerShell.Utility\\Get-Date', 'C:/Program Files/tool.exe'], deniedCommands: [], externalDisclosure: false, modelExecution: false, fallback: null, thresholds: {} };
  assert.deepEqual(validateCommandPolicy({ targets: [rule] }).targets[0].commands, rule.commands);
  for (const commands of [['WHOAMI.EXE', 'whoami.exe'], ['C:/work/tool.exe', 'c:\\work\\tool.exe'], ['Get-Date'], ['$(evil)'], ['tool.exe;Remove-Item']]) assert.throws(() => validateCommandPolicy({ targets: [{ ...rule, commands }] }));
  const { platform, ...linux } = rule;
  assert.throws(() => validateCommandPolicy({ targets: [linux] }));
});

test('Windows source와 CLI 고정 계획은 같은 SSH 검증 경계를 통과하고 변조 시 미실행한다', async () => {
  const binding = { targetId: 'windows', targetRevision: 'a'.repeat(64), profile: 'win-write', platform: 'windows' };
  const calls = [];
  let stdout = 'source-ok';
  const connection = { profile: profiles.get('win-write'), async exec(command, options) { calls.push({ command, options }); return { stdout, stderr: '', exitCode: 0 }; } };
  const fake = { getProfile: () => connection.profile, getOrCreate: async () => connection };
  const source = preparePythonSource({ ...binding, source: "print('한글')\n", cwd: 'C:/', pythonExecutable: 'C:/Python313/python.exe' });
  assert.equal((await executePythonSource(fake, source, () => binding)).failed, false);
  assert.equal(calls[0].options.stdin, source.transportStdin);
  const cli = prepareAgentCliPlan({ action: 'inspect', provider: 'codex', binding });
  stdout = JSON.stringify({ provider: 'codex', installed: false, managed: false, version: null, active: null, installationRevision: 'b'.repeat(64), login: 'not_checked' });
  assert.equal((await executeAgentCli(fake, cli, () => binding)).data.agentCli.installed, false);
  assert.equal(calls[1].options.stdin, cli.stdin);
  await assert.rejects(executeAgentCli(fake, { ...cli, stdin: cli.stdin + '# changed' }, () => binding));
  await assert.rejects(executePythonSource(fake, { ...source, manifest: { ...source.manifest, interpreter: 'C:/other/python.exe' } }, () => binding));
  await assert.rejects(executePythonSource(fake, { ...source, transportStdin: source.transportStdin + 'x' }, () => binding));
  await assert.rejects(executePythonSource(fake, { ...source, transportStdin: undefined }, () => binding));
  const linux = preparePythonSource({ ...binding, platform: 'linux', source: 'pass', cwd: '/' });
  await assert.rejects(executePythonSource(fake, { ...linux, transportStdin: 'extra' }, () => binding));
  assert.equal(calls.length, 2);
});

test('Windows app는 명시 Python 경로로 승인된 source를 실행하고 CLI를 Python 설정과 분리한다', async t => {
  const root = await mkdtemp(join(tmpdir(), 'windows-full-app-')), sourceCalls = [], cliCalls = [];
  const app = await createApplication({ registry, transferRoot: root, classify: () => ({ class: 'safe' }), audit() {}, uiHtml: '<html></html>',
    env: { BRIDGE_MCP_TOKEN: 'synthetic-mcp', BRIDGE_ADMIN_TOKEN: 'synthetic-owner', BRIDGE_ADMIN_ORIGIN: 'https://owner.example.test', BRIDGE_UI_TICKET_KEY: 'f'.repeat(64), BRIDGE_TARGETS: JSON.stringify([{ ...entry, pythonExecutable: 'C:/Python313/python.exe' }]), BRIDGE_DEFAULT_TARGET: 'windows', BRIDGE_COMMAND_AUTOMATION: 'true', BRIDGE_TEST_SERVER_SECRET_REF: 'secret://fixture/test-server' },
    secretResolver: { resolve: async () => '1'.repeat(64) },
    executeCommand: async () => ({ failed: false, texts: ['command-ok'] }),
    executePythonSource: async (plan, verify, beforeDispatch) => { await beforeDispatch(); verify(); sourceCalls.push(plan); return { failed: false, texts: ['source-ok'] }; },
    executeAgentCli: async (plan, verify, beforeDispatch) => { await beforeDispatch(); verify(); cliCalls.push(plan); return { failed: false, texts: [], data: { agentCli: { contract: 'agent-cli-login-status-v1', provider: plan.agentCli.provider, state: 'signed_out' } } }; },
  });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
  const api = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${app.adminHttp.address().port}` + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer synthetic-owner', ...(body === undefined ? {} : { Origin: 'https://owner.example.test', 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const policy = (await api('/api/command-policy')).body, binding = policy.bindings[0];
  const proposal = { expectedRevision: policy.revision, policy: { targets: [{ targetId: binding.targetId, targetRevision: binding.targetRevision, profile: binding.profile, platform: 'windows', commands: [], deniedCommands: [], externalDisclosure: false, modelExecution: false, fallback: null, thresholds: {}, testServer: true }] } };
  const review = await api('/api/command-policy/review', proposal);
  assert.equal(review.status, 200);
  assert.equal((await api('/api/command-policy', { ...proposal, reviewToken: review.body.reviewToken, acknowledged: true })).status, 200);
  const result = await app.targets.commands.runSource({ source: "print('한글')\n", cwd: 'C:/', context: '합성 Windows Python 동작 검사' }, 'windows');
  await app.targets.drain();
  assert.equal(app.queue.get(result.job.id).state, 'completed');
  assert.equal(sourceCalls.length, 1);
  assert.equal(sourceCalls[0].manifest.platform, 'windows');
  assert.equal(sourceCalls[0].manifest.interpreter, 'C:/Python313/python.exe');
  const login = await api('/api/agent-cli/login-status', { targetId: 'windows', provider: 'codex' });
  assert.equal(login.status, 200);
  assert.equal(login.body.state, 'signed_out');
  assert.equal(cliCalls.length, 1);
  assert.equal(cliCalls[0].manifest.contract, 'agent-cli-powershell-v1');
});
