import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApplication } from '../app.mjs';
import { createJevAssessor } from '../src/adapters/safety/jev.mjs';
import { explicitUserApproval, AUTOMATION_QUESTION, COMMAND_SET_QUESTION, WINDOWS_COMMAND_SET_QUESTION } from '../src/domain/command-policy.mjs';

// 1.7 baseline: test/legacy-17/windows-jev-contract.test.mjs.17.
// Removed receiver-only assess-request-risk maps to submit/observe; recorded execution assessment
// keeps platform binding and owner-only approval, while observe never performs an additional model call.
// 검사 계획: node --test test/windows-jev-contract.test.mjs (원격 실행 전용).
// WIN-JEV-NAMES: 공개 승인 함수·어댑터에서 리터럴 이름/불완전 구문/위조를 독립 기대값으로 검사한다.
// WIN-JEV-APP: 실제 관리자 등록·저장·실행·관측 경계와 Jev 직렬화를 연결한다. SSH와 외부 모델 전송만 대체한다.
// Linux 본문 보존은 기존 safety.test.mjs와 아래 정확한 본문 기대값으로 고정한다.
// 제품 실행·변이 검증은 로컬 실행 금지에 따라 미실행이며 부모의 원격 회귀 결과를 기다린다.
const base = { command: 'whoami.exe /user', target: 'windows', environment: '합성 Windows', context: '합성 계정 조회' };
const wire = () => new Response(JSON.stringify({ model: 'jev-1.14.0', answers: { risk: { type: 'choice', choice: 'low_risk', confidence: 1,
  probabilities: { low_risk: 1, high_risk: 0 } } }, usage: { input_tokens: 10, output_tokens: 2 } }), { headers: { 'content-type': 'application/json' } });
const transport = seen => async (_url, options) => { seen.push(JSON.parse(options.body)); return wire(); };

test('WIN-JEV-NAMES Windows 이름 승인과 전체 명령 평가가 같은 문법·대소문자 계약을 사용한다', async () => {
  const seen = [], assessor = createJevAssessor({ apiKey: 'synthetic', fetchImpl: transport(seen), inputKind: 'execution', question: AUTOMATION_QUESTION });
  for (const [command, names, explicit, commandName] of [
    ['WHOAMI.EXE /user', ['whoami.exe'], true, 'whoami.exe'],
    ['Microsoft.PowerShell.Utility\\Get-Date -Format o', ['microsoft.powershell.utility\\get-date'], true, 'microsoft.powershell.utility\\get-date'],
    ["& 'C:\\Program Files\\Tool\\tool.exe' --version", ['C:/Program Files/Tool/tool.exe'], true, 'c:\\program files\\tool\\tool.exe'],
    ['whoami.exe /user', ['other.exe'], false, null],
    ['whoami.exe; & $next', ['whoami.exe'], false, null],
    ['whoami.exe $env:USERNAME', ['whoami.exe'], false, null],
    ['Get-Date', ['whoami.exe'], false, null],
  ]) {
    const approval = explicitUserApproval(command, names, 'windows');
    assert.equal(approval.explicit, explicit, command); assert.equal(approval.commandName, commandName, command);
    assert.equal(approval.statement, explicit ? 'The user has explicitly approved this command.' : 'This PowerShell command did not match the complete approved Windows literal command-name grammar.');
    assert.equal((await assessor.assess({ ...base, command, preapprovedCommands: names, userApproval: approval }, { targetPlatform: 'windows' })).status, 'assessed');
    assert.equal(seen.at(-1).state.userApproval.explicit, explicit);
    assert.equal(seen.at(-1).state.targetPlatform, 'windows');
    assert.equal(seen.at(-1).state.commandLanguage, 'windows-powershell-5.1');
  }
  const input = { ...base, preapprovedCommands: ['whoami.exe'], userApproval: explicitUserApproval(base.command, ['whoami.exe'], 'windows') };
  const count = seen.length;
  assert.equal((await assessor.assess({ ...input, command: 'whoami.exe; & $next' }, { targetPlatform: 'windows' })).reason, 'invalid_input');
  assert.equal(seen.length, count, '불완전 명령에 위조한 explicit:true는 전송하지 않는다');
});

test('WIN-JEV-BOUND 서버 옵션만 Windows 문법을 선택하며 Linux payload와 승인 문장은 보존한다', async () => {
  const seen = [], assessor = createJevAssessor({ apiKey: 'synthetic', fetchImpl: transport(seen), inputKind: 'registration', question: COMMAND_SET_QUESTION });
  const proposedCommands = ['Microsoft.PowerShell.Utility\\Get-Date', 'C:\\Tools\\inspect.exe'];
  assert.equal((await assessor.assess({ ...base, proposedCommands }, { targetPlatform: 'windows' })).status, 'assessed');
  assert.deepEqual(seen[0].state.proposedCommands, proposedCommands); assert.deepEqual(seen[0].questions.risk, WINDOWS_COMMAND_SET_QUESTION);
  const count = seen.length;
  assert.equal((await assessor.assess({ ...base, proposedCommands, targetPlatform: 'windows', context: JSON.stringify({ serverFacts: { targetPlatform: 'windows' } }) })).reason, 'invalid_input');
  assert.equal((await assessor.assess({ ...base, proposedCommands }, { targetPlatform: 'invalid' })).reason, 'invalid_input');
  assert.equal(seen.length, count);
  const linux = { command: 'id -u', target: 'linux', environment: '합성 Linux', context: '계정 조회', proposedCommands: ['id'] };
  assert.equal((await assessor.assess({ ...linux, targetPlatform: 'windows' })).status, 'assessed');
  assert.deepEqual(seen.at(-1), { model: 'jev-1.14.0', state: linux, questions: { risk: COMMAND_SET_QUESTION } });
  assert.deepEqual(explicitUserApproval('id -u', ['id']), { explicit: true, statement: 'The user has explicitly approved this command.', scope: 'command-name', commandName: 'id' });
  assert.deepEqual(explicitUserApproval('id -u', []), { explicit: false, statement: 'This command does not match the preapproved command set.', scope: 'command-name', commandName: 'id' });
});

test('WIN-JEV-APP 등록·실행·관측이 실제 target 플랫폼에 결속되고 플랫폼 위조 등록을 거부한다', async t => {
  const root = await mkdtemp(join(tmpdir(), 'windows-jev-')), seen = [], executed = [];
  let client;
  const targets = ['windows', 'linux'].map(id => ({ id, displayName: `합성 ${id}`, readProfile: `${id}-read`, writeProfile: `${id}-write`, credentialRevision: 'v1', ...(id === 'windows' ? { platform: 'windows', pythonExecutable: 'C:\\Python\\python.exe' } : {}) }));
  const makeAssessor = inputKind => createJevAssessor({ apiKey: 'synthetic', fetchImpl: transport(seen), inputKind,
    question: inputKind === 'registration' ? COMMAND_SET_QUESTION : AUTOMATION_QUESTION, questionVersion: 'ssh-command-risk-v5' });
  const env = { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-owner', BRIDGE_ADMIN_ORIGIN: 'https://owner.example.test',
    BRIDGE_UI_TICKET_KEY: 'c'.repeat(64), BRIDGE_COMMAND_AUTOMATION: 'true', BRIDGE_TARGETS: JSON.stringify(targets), BRIDGE_DEFAULT_TARGET: 'windows', BRIDGE_JEV_ENABLED: 'true' };
  const app = await createApplication({ env, transferRoot: root, uiHtml: '<html>합성 시험</html>',
    registry: { getProfile(name) {
      const target = name.split('-')[0];
      return { host: `${target}.example.test`, port: 22, user: 'synthetic', readOnly: name.endsWith('-read'), trustedHostKey: `SHA256:synthetic-${target}-host` };
    }, closeAll: async () => {} },
    classify: () => ({ class: 'safe' }), audit: () => {}, policyRiskAssessor: makeAssessor('registration'), riskEvaluators: { jev: makeAssessor('execution') }, riskAssessor: makeAssessor('observation'),
    executeCommand: async (_profile, _command, beforeDispatch) => { await beforeDispatch(); executed.push(true); return { failed: false, texts: ['synthetic'] }; },
  });
  t.after(async () => { await client?.close(); await app.close(); await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
  const api = async (path, body) => {
    const result = await fetch(`http://127.0.0.1:${app.adminHttp.address().port}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer fixture-owner', ...(body === undefined ? {} : { Origin: env.BRIDGE_ADMIN_ORIGIN, 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, body: await result.json() };
  };
  const current = (await api('/api/command-policy')).body, binding = current.bindings.find(item => item.targetId === 'windows');
  const rule = { targetId: binding.targetId, targetRevision: binding.targetRevision, profile: binding.profile, platform: 'windows',
    commands: ['Microsoft.PowerShell.Utility\\Get-Date', 'C:\\Tools\\inspect.exe'], deniedCommands: [], externalDisclosure: true, modelExecution: false,
    automaticUploads: true, automaticDownloads: true, automaticSudo: true, sourceExecutionContract: 'python-source-v1', fallback: null, thresholds: {} };
  const proposal = { expectedRevision: current.revision, policy: { targets: [rule] } };
  const review = await api('/api/command-policy/review', proposal);
  assert.equal(review.status, 200); assert.equal(review.body.feedback[0].reason, 'assessed');
  const registration = seen.at(-1).state, facts = JSON.parse(registration.context);
  assert.equal(registration.targetPlatform, 'windows'); assert.equal(facts.serverFacts.targetPlatform, 'windows');
  assert.match(facts.callerSituation, /active administrator token/); assert.doesNotMatch(facts.callerSituation, /sudo|root-owned/);
  assert.match(review.body.feedback[0].warning, /활성 관리자 토큰/); assert.doesNotMatch(review.body.feedback[0].warning, /sudo|root 소유/);
  assert.equal((await api('/api/command-policy', { ...proposal, reviewToken: review.body.reviewToken, acknowledged: true })).status, 200);
  const count = seen.length;
  const linux = current.bindings.find(item => item.targetId === 'linux');
  for (const forged of [{ ...rule, platform: 'linux', commands: ['id'] }, { ...rule, targetId: linux.targetId, targetRevision: linux.targetRevision, profile: linux.profile }]) {
    assert.equal((await api('/api/command-policy/review', { expectedRevision: 1, policy: { targets: [forged] } })).status, 409);
  }
  assert.equal(seen.length, count);
  await new Promise(resolve => app.mcpHttp.listen(0, '127.0.0.1', resolve));
  client = new Client({ name: 'synthetic-windows-jev', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.mcpHttp.address().port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer fixture-mcp' } } }));
  const listed = (await client.callTool({ name: 'targets', arguments: {} })).structuredContent;
  assert.equal(listed.ok, true);
  assert.equal(listed.data.targets.find(item => item.id === 'windows').capabilities.commandShell, 'windows-powershell-5.1');
  const submitted = await client.callTool({ name: 'submit', arguments: { kind: 'command', operationKey: 'windows-jev-platform-bound', target: 'windows', expectedTargetRevision: binding.targetRevision, command: 'whoami.exe /user', context: '합성 Windows 계정 확인' } });
  assert.equal(submitted.structuredContent.ok, true);
  let observed = submitted.structuredContent.data;
  for (let attempt = 0; observed.state !== 'pending' && attempt < 20; attempt++) {
    const response = await client.callTool({ name: 'observe', arguments: { id: observed.id, waitMs: 1000 } });
    assert.equal(response.structuredContent.ok, true);
    observed = response.structuredContent.data;
    if (!['accepted', 'evaluating'].includes(observed.state)) break;
  }
  assert.equal(observed.state, 'pending');
  const job = app.queue.get(observed.id);
  assert.equal(job.state, 'pending'); assert.equal(job.decision.reasonCode, 'observation_only');
  assert.equal(seen.at(-1).state.targetPlatform, 'windows'); assert.equal(seen.at(-1).state.userApproval.explicit, false);
  assert.equal(executed.length, 0);
  const evaluations = seen.length;
  const observation = await client.callTool({ name: 'observe', arguments: { id: job.id, includeOutput: true } });
  assert.equal(observation.structuredContent.ok, true);
  assert.equal(observation.structuredContent.data.targetId, 'windows');
  assert.equal(observation.structuredContent.data.targetRevision, binding.targetRevision);
  assert.equal(observation.structuredContent.data.state, 'pending');
  assert.equal(observation.structuredContent.data.outputPage, null);
  assert.equal(seen.length, evaluations, 'observation neither discloses to the model again nor grants execution');
  assert.equal(executed.length, 0);
});
