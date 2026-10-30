import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { classifyCommand } from 'ssh-mcp/build/policy/classifier.js';
import { createApplication } from '../app.mjs';

const source = "print('정상 원문')\n";
const context = 'Synthetic source admission regression; no real SSH or model request; no resources changed.';
const defaults = { source, cwd: '/tmp', context };
const generic = { isError: true, content: [{ type: 'text', text: 'Request refused or failed. Check authentication, state, limits and permissions.' }] };
const refusals = {
  source: { code: 'SOURCE_CREDENTIAL_MATERIAL', ruleId: 'credential-material-v1', text: '제출 원문이 인증정보 입력 금지 규칙에 일치합니다.' },
  argv: { code: 'SOURCE_ARGUMENTS_SENSITIVE', ruleId: 'sensitive-input-v1', text: '제출 인수가 민감 입력 금지 규칙에 일치합니다.' },
  cwd: { code: 'SOURCE_WORKDIR_SENSITIVE', ruleId: 'sensitive-input-v1', text: '작업 경로가 민감 입력 금지 규칙에 일치합니다.' },
};
function expected(field) {
  const { code, ruleId, text } = refusals[field];
  return { isError: true, content: [{ type: 'text', text: `${code}: ${text} 요청은 등록되지 않았습니다.` }],
    structuredContent: { error_code: code, inputField: field, ruleId, stage: 'source_admission', requestSubmitted: false } };
}

async function fixture(t, testServer = false) {
  const root = await mkdtemp(join(tmpdir(), 'source-input-refusals-'));
  const inputs = [], executions = [], events = [], profiles = new Map();
  const env = { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-owner', BRIDGE_UI_TICKET_KEY: 'a'.repeat(64),
    BRIDGE_ADMIN_ORIGIN: 'https://owner.test', BRIDGE_COMMAND_AUTOMATION: 'true', BRIDGE_TEST_SERVER_SECRET_REF: 'secret://fixture/test-server' };
  const app = await createApplication({ transferRoot: root, uiHtml: '<html></html>', env, classify: classifyCommand,
    secretResolver: { resolve: async () => '1'.repeat(64) },
    registry: { getProfile: name => { if (!profiles.has(name)) profiles.set(name, { host: '127.0.0.1', port: 22, user: 'fixture', readOnly: name === 'aws-readonly' }); return profiles.get(name); }, closeAll: async () => {} },
    executeCommand: async () => { executions.push('legacy'); return { failed: false, texts: ['합성 출력'] }; },
    executePythonSource: async (plan, verify) => { verify(); executions.push(plan); return { failed: false, texts: ['합성 출력'] }; },
    audit: event => events.push(event),
    riskEvaluators: { jev: { model: 'jev-1.14.0', questionVersion: 'ssh-command-risk-v5', assess: async input => { inputs.push(input); return null; } } },
  });
  const client = new Client({ name: 'source-input-refusals-fixture', version: '1' });
  t.after(async () => { await client.close(); await app.close(); await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + app.adminHttp.address().port;
  const api = async (path, body) => {
    const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer fixture-owner', Origin: env.BRIDGE_ADMIN_ORIGIN, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200); return response.json();
  };
  const current = await api('/api/command-policy'), binding = current.bindings[0];
  const proposal = { expectedRevision: current.revision, policy: { targets: [{ targetId: binding.targetId, targetRevision: binding.targetRevision, profile: binding.profile,
    commands: [], deniedCommands: [], automaticSudo: false, sourceExecutionContract: null,
    externalDisclosure: false, modelExecution: false, fallback: null, thresholds: {}, testServer }] } };
  const review = await api('/api/command-policy/review', proposal);
  await api('/api/command-policy', { ...proposal, reviewToken: review.reviewToken, acknowledged: true });
  await new Promise(resolve => app.mcpHttp.listen(0, '127.0.0.1', resolve));
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + app.mcpHttp.address().port + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer fixture-mcp' } } }));
  const call = (changes = {}) => client.callTool({ name: 'run-python-source', arguments: { ...defaults, ...changes } });
  const noAdmission = async () => {
    await app.targets.drain();
    assert.equal(app.queue.listAll().length, 0, '거부 입력은 큐에 등록되면 안 됩니다');
    assert.equal(inputs.length, 0, '거부 입력은 모델 경계에 도달하면 안 됩니다');
    assert.equal(executions.length, 0, '거부 입력은 실행 경계에 도달하면 안 됩니다');
  };
  return { app, call, inputs, executions, events, noAdmission };
}

test('SOURCE-REFUSAL-01 실제 MCP는 가짜 인증정보와 공개 합성값을 안전 사유로 거부한다', async t => {
  const f = await fixture(t);
  const cases = [
    ['가짜 키', "api_key='FAKE_CREDENTIAL_CANARY_01'\n"],
    ['가짜 비밀번호', "password='FAKE_CREDENTIAL_CANARY_02'\n"],
    ['가짜 토큰', "token='FAKE_CREDENTIAL_CANARY_03'\n"],
    ['가짜 PEM', "value='-----BEGIN PRIVATE KEY----- FAKE_CREDENTIAL_CANARY_04'\n"],
    ['가짜 Bearer', "value='Bearer FAKE_CREDENTIAL_CANARY_05'\n"],
    ['공개 합성값 현정책', "api_key='synthetic-only'\n"],
    ['주석도 현정책 유지', "# secret=FAKE_CREDENTIAL_CANARY_06\npass\n"],
  ];
  for (const [name, submitted] of cases) await t.test(name, async () => {
    const reply = await f.call({ source: submitted });
    assert.deepEqual(reply, expected('source'));
    assert.equal(JSON.stringify([reply, f.events]).includes(submitted), false);
    assert.doesNotMatch(JSON.stringify([reply, f.events]), /FAKE_CREDENTIAL_CANARY|synthetic-only|PRIVATE KEY/);
    await f.noAdmission();
  });
});

test('SOURCE-REFUSAL-02 인수와 작업 경로의 인증정보·민감 경로 사유를 구별한다', async t => {
  const f = await fixture(t);
  const cases = [
    ['argv', { argv: ['api_key=FAKE_ARGUMENT_CANARY'] }],
    ['argv', { argv: ['/tmp/.env'] }],
    ['argv', { argv: ['/etc/shadow', '/home/test/.ssh/id_ed25519', '/secrets/fixture'] }],
    ['cwd', { cwd: '/tmp/.env' }],
    ['cwd', { cwd: '/secrets/FAKE_WORKDIR_CANARY' }],
    ['cwd', { cwd: '/tmp/token=FAKE_WORKDIR_CANARY' }],
  ];
  for (const [index, [field, changes]] of cases.entries()) await t.test(String(index), async () => {
    const reply = await f.call(changes);
    assert.deepEqual(reply, expected(field));
    assert.doesNotMatch(JSON.stringify([reply, f.events]), /FAKE_ARGUMENT_CANARY|FAKE_WORKDIR_CANARY|\.env|\/etc\/shadow|\/secrets\//);
    await f.noAdmission();
  });
});

test('SOURCE-REFUSAL-03 내부 오류 코드는 기존 메시지와 source→argv→cwd 우선순위를 보존한다', async t => {
  const f = await fixture(t);
  for (const [field, changes] of [
    ['source', { source: "token='FAKE_PRECEDENCE_CANARY'", argv: ['.env'], cwd: '/secrets/fixture' }],
    ['argv', { argv: ['.env'], cwd: '/secrets/fixture' }],
    ['cwd', { cwd: '/secrets/fixture' }],
  ]) {
    await assert.rejects(Promise.resolve().then(() => f.app.targets.commands.runSource({ ...defaults, ...changes })), error => {
      assert.equal(error.message, 'Sensitive source input refused'); assert.equal(error.code, refusals[field].code); return true;
    });
    assert.deepEqual(await f.call(changes), expected(field));
    await f.noAdmission();
  }
});

test('SOURCE-REFUSAL-04 TEST 우회도 세 입력 거부를 건너뛰지 않는다', async t => {
  const f = await fixture(t, true);
  for (const [field, changes] of [['source', { source: "secret='FAKE_TEST_CANARY'" }], ['argv', { argv: ['.env'] }], ['cwd', { cwd: '/secrets/fixture' }]]) {
    assert.deepEqual(await f.call({ ...changes, context: '', elevate: true }), expected(field));
    await f.noAdmission();
  }
  const reply = await f.call({ context: '' });
  assert.equal(reply.isError, undefined); await f.app.targets.drain();
  const job = f.app.queue.get(reply.structuredContent.id);
  assert.equal(job.state, 'completed'); assert.equal(job.decision.reasonCode, 'test_server_bypass');
  assert.equal(f.executions.length, 1); assert.equal(f.inputs.length, 0);
});

test('SOURCE-REFUSAL-05 정상 원문과 유사 문자열 및 원문 민감 경로 설명을 침범하지 않는다', async t => {
  const f = await fixture(t);
  const submitted = "# .env /etc/shadow /home/test/.ssh/id_ed25519 /secrets/service\napi_keys = ['공개']\npassword_hint = '설명'\ntoken_count = 1\nprint('Bearerish')\n";
  const reply = await f.call({ source: submitted, argv: ['.environment', '/secretsish', 'token_count'], cwd: '/tmp/fixture' });
  assert.equal(reply.isError, undefined); await f.app.targets.drain();
  const job = f.app.queue.get(reply.structuredContent.id);
  assert.equal(job.state, 'pending'); assert.equal(job.decision.reasonCode, 'source_execution_not_enabled');
  assert.equal(f.app.targets.commands.source(job.id).source, submitted);
  assert.equal(f.app.queue.listAll().length, 1); assert.equal(f.inputs.length, 0); assert.equal(f.executions.length, 0);
  assert.equal(JSON.stringify([reply, f.events]).includes(submitted), false);
});

test('SOURCE-REFUSAL-06 기존 context 사유와 일반 예외 비반사를 유지한다', async t => {
  const f = await fixture(t);
  const reply = await f.call({ context: 'token=FAKE_CONTEXT_CANARY' });
  assert.equal(reply.isError, true); assert.equal(reply.structuredContent, undefined);
  assert.match(reply.content[0].text, /^COMMAND_CONTEXT_CONTAINS_SECRET:/);
  assert.doesNotMatch(JSON.stringify(reply), /FAKE_CONTEXT_CANARY/);
  await f.noAdmission();
  assert.deepEqual(await f.call({ source: '\0' }), generic);
  const original = f.app.targets.commands.runSource;
  try {
    for (const code of [undefined, 'UNKNOWN_SOURCE_REFUSAL']) {
      f.app.targets.commands.runSource = () => { throw Object.assign(Error('FAKE_EXCEPTION_CANARY'), { code, cause: 'FAKE_CAUSE_CANARY', details: 'FAKE_DETAILS_CANARY' }); };
      assert.deepEqual(await f.call(), generic);
    }
    for (const field of Object.keys(refusals)) {
      f.app.targets.commands.runSource = () => { throw Object.assign(Error('FAKE_EXCEPTION_CANARY'), { code: refusals[field].code, cause: 'FAKE_CAUSE_CANARY', details: 'FAKE_DETAILS_CANARY' }); };
      assert.deepEqual(await f.call(), expected(field));
    }
  } finally { f.app.targets.commands.runSource = original; }
  await f.noAdmission();
});
