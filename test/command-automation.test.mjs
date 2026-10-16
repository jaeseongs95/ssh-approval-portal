import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyCommand } from 'ssh-mcp/build/policy/classifier.js';
import { createApplication } from '../app.mjs';
import { inspectCommand, validateCommandPolicy } from '../src/domain/command-policy.mjs';
import { createCommandState } from '../src/adapters/storage/command-state.mjs';
import { createAikSshTool } from '../src/adapters/aik/ssh-tool.mjs';

const low = { status: 'assessed', model: 'jev-1.13.0', label: 'low_risk', confidence: 1,
  probabilities: { low_risk: 1, high_risk: 0, uncertain: 0 } };
const env = { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-owner', BRIDGE_UI_TICKET_KEY: 'a'.repeat(64), BRIDGE_ADMIN_ORIGIN: 'https://owner.test', BRIDGE_COMMAND_AUTOMATION: 'true' };
const threshold = model => ({ model, questionVersion: 'ssh-command-risk-v2', minLowRisk: 0.99, minConfidence: 0.99, validationRef: 'synthetic:test-only' });
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'command-automation-')), executions = [], inputs = [], events = [];
  const evaluator = { model: 'jev-1.13.0', questionVersion: 'ssh-command-risk-v2', async assess(input) { inputs.push(input); return low; } };
  const make = () => createApplication({ registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'fixture', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
    classify: classifyCommand, executeCommand: async (profile, command) => { executions.push({ profile, command }); return { failed: false, texts: ['ok'] }; },
    audit: event => events.push(event), transferRoot: root, uiHtml: '<html>fixture</html>', env,
    riskEvaluators: { jev: evaluator }, ...options,
    ...(options.riskEvaluators ? { riskEvaluators: Object.fromEntries(Object.entries(options.riskEvaluators).map(([key, value]) => [key, { questionVersion: 'ssh-command-risk-v2', ...value }])) } : {}) });
  let app = await make();
  await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
  let url = `http://127.0.0.1:${app.adminHttp.address().port}`;
  const api = async (path, body, headers = {}) => {
    const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer fixture-owner', ...(body === undefined ? {} : { Origin: env.BRIDGE_ADMIN_ORIGIN, 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const policy = async changes => {
    const { body: current } = await api('/api/command-policy'), binding = current.bindings[0];
    const rule = { targetId: binding.targetId, targetRevision: binding.targetRevision, profile: binding.profile,
      commands: ['ls', 'sudo', 'rm'], deniedCommands: [], externalDisclosure: true, modelExecution: false, fallback: null, thresholds: {}, ...changes };
    const result = await api('/api/command-policy', { expectedRevision: current.revision, policy: { targets: [rule] } });
    assert.equal(result.status, 200); return result.body;
  };
  const run = async (command, key) => {
    const result = await app.targets.commands.run(command, undefined, key);
    await app.targets.drain();
    return app.queue.get(result.job.id);
  };
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { root, get app() { return app; }, executions, inputs, events, api, policy, run,
    async restart() { await app.close(); app = await make(); await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${app.adminHttp.address().port}`; } };
}

test('command set ignores arguments; risky arguments and nested execution do not inherit that authority', async t => {
  const f = await fixture(t); await f.policy({});
  for (const command of ['ls /tmp', 'ls -la /var', 'sudo id']) {
    const job = await f.run(command); assert.equal(job.state, 'completed'); assert.equal(job.decision.reasonCode, 'command_set');
  }
  assert.equal(f.inputs.length, 0);
  for (const command of ['ls $(touch /tmp/x)', 'rm -rf /tmp/x', 'sudo rm -rf /tmp/x']) {
    const job = await f.run(command); assert.equal(job.state, 'pending'); assert.equal(job.decision.reasonCode, 'observation_only');
  }
  assert.equal(f.executions.length, 3); assert.equal(f.inputs.length, 3);
  assert.equal(inspectCommand('sudo id', classifyCommand).risky, false);
});

test('model OR path executes sudo and unmatched commands only with measured provider-specific thresholds', async t => {
  const f = await fixture(t); await f.policy({ commands: [], modelExecution: true, thresholds: { jev: threshold('jev-1.13.0') } });
  const job = await f.run('sudo systemctl restart synthetic.service');
  assert.equal(job.state, 'completed'); assert.equal(job.decision.reasonCode, 'model_passed');
  assert.equal(f.executions[0].command, 'sudo systemctl restart synthetic.service');
  assert.deepEqual(Object.keys(f.inputs[0]).sort(), ['command', 'context', 'environment', 'target']);
  assert.doesNotMatch(JSON.stringify(f.inputs), /commands|threshold|preapprov|fixture-owner|127\.0\.0\.1/);
});

test('missing thresholds, denied names, disclosure and sensitive-input guards never autoexecute', async t => {
  const f = await fixture(t);
  await f.policy({ commands: [], modelExecution: true });
  assert.equal((await f.run('sudo id')).state, 'pending');
  await f.policy({ deniedCommands: ['rm'], modelExecution: true, thresholds: { jev: threshold('jev-1.13.0') } });
  assert.equal((await f.run('sudo /bin/rm /tmp/x')).state, 'denied');
  await f.policy({ commands: [], externalDisclosure: false });
  const calls = f.inputs.length;
  assert.equal((await f.run('sudo id')).decision.reasonCode, 'disclosure_not_enabled');
  await f.policy({});
  assert.equal((await f.run('cat /etc/shadow')).decision.reasonCode, 'sensitive_input');
  assert.equal(f.inputs.length, calls); assert.equal(f.executions.length, 0);
});

test('fallback runs only after unavailability; no score shopping after a valid risky answer', async t => {
  let primary = null, calls = 0;
  const f = await fixture(t, { riskEvaluators: { jev: { model: 'jev-1.13.0', assess: async () => primary },
    luna: { model: 'luna-fixture', assess: async () => { calls++; return { ...low, model: 'luna-fixture' }; } } } });
  await f.policy({ commands: [], fallback: 'luna', modelExecution: true, thresholds: { luna: threshold('luna-fixture') } });
  assert.equal((await f.run('sudo id')).state, 'completed'); assert.equal(calls, 1);
  primary = { ...low, label: 'high_risk', probabilities: { low_risk: 0, high_risk: 1, uncertain: 0 } };
  assert.equal((await f.run('sudo id')).state, 'pending'); assert.equal(calls, 1);
});

test('policy revision change during evaluation discards the old automatic decision', async t => {
  let complete;
  const f = await fixture(t, { riskEvaluators: { jev: { model: 'jev-1.13.0', assess: () => new Promise(resolve => { complete = resolve; }) } } });
  await f.policy({ commands: [], modelExecution: true, thresholds: { jev: threshold('jev-1.13.0') } });
  const { job } = await f.app.targets.commands.run('sudo id');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.app.queue.get(job.id).state, 'evaluating');
  assert.throws(() => f.app.queue.start(job.id), /not pending/);
  assert.throws(() => f.app.queue.reserveMaintenance());
  await f.policy({ commands: [] }); complete(low); await f.app.targets.drain();
  assert.equal(f.app.queue.get(job.id).decision.reasonCode, 'policy_changed'); assert.equal(f.executions.length, 0);
});

test('request keys survive restart, reject changed arguments, and never replay completed execution', async t => {
  const f = await fixture(t); await f.policy({}); const key = 'fixture-request-0001';
  const job = await f.run('sudo id', key); assert.equal(job.state, 'completed');
  const again = await f.run('sudo id', key); assert.equal(again.id, job.id); assert.equal(f.executions.length, 1);
  await assert.rejects(f.run('sudo pwd', key), /conflict/);
  await f.restart();
  assert.equal((await f.run('sudo id', key)).id, job.id); assert.equal(f.executions.length, 1);
});

test('durable admission restores interrupted evaluation/execution as unknown and pending as expired', async t => {
  const root = await mkdtemp(join(tmpdir(), 'command-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let state = createCommandState(root);
  for (const status of ['evaluating', 'running', 'pending']) state.insert({ id: status, state: status }, status, 'digest');
  state.close(); state = createCommandState(root);
  assert.deepEqual(state.list().map(job => job.state), ['unknown', 'unknown', 'expired']); state.close();
});

test('owner authentication, exact Origin, revision and target bindings protect policy mutations', async t => {
  const f = await fixture(t), initial = await f.api('/api/command-policy');
  assert.equal((await f.api('/api/command-policy', undefined, { Authorization: 'Bearer fixture-mcp' })).status, 401);
  assert.equal((await f.api('/api/command-policy', { expectedRevision: 0, policy: { targets: [] } }, { Origin: 'https://other.test' })).status, 403);
  await f.policy({});
  assert.equal((await f.api('/api/command-policy', { expectedRevision: initial.body.revision, policy: { targets: [] } })).status, 409);
  const rule = { ...(await f.api('/api/command-policy')).body.targets[0], targetRevision: '0'.repeat(64) };
  assert.equal((await f.api('/api/command-policy', { expectedRevision: 1, policy: { targets: [rule] } })).status, 409);
  assert.throws(() => validateCommandPolicy({ targets: [{ ...rule, commands: ['ls -la'] }] }));
});

test('AIK adapter never dispatches before authority and keeps host authorization out of MCP', async () => {
  const events = [], auth = { status: 'authorized', binding_digest: 'fixture', authorization_revision: 1 };
  const adapter = createAikSshTool({ authority: { authorize: async () => { events.push('authorize'); return auth; },
    revalidate: async value => { assert.equal(value, auth); events.push('revalidate'); }, recordReceipt: async () => events.push('receipt'),
    recordDispatch: async () => events.push('intent'), bindRequest: async () => events.push('bind'), lookupRequest: async () => auth },
    mcp: { call: async (name, args) => { events.push(name); assert.equal(JSON.stringify(args).includes('binding_digest'), false); return { id: 'a'.repeat(48), state: 'completed' }; } } });
  const job = await adapter.run({ tool_call_id: 'fixture-call', effect_id: 'fixture-effect', arguments: { target: 'test', command: 'sudo id' } });
  await adapter.status(job.id);
  assert.deepEqual(events, ['authorize', 'revalidate', 'intent', 'revalidate', 'run-command', 'bind', 'get-request-status', 'receipt']);
  let calls = 0;
  const denied = createAikSshTool({ authority: { authorize: async () => { throw Error('AIK denied'); }, revalidate() {}, recordReceipt() {}, recordDispatch() {}, bindRequest() {}, lookupRequest() {} }, mcp: { call: () => calls++ } });
  await assert.rejects(denied.run({}), /AIK denied/); assert.equal(calls, 0);
});

test('uncertain, low confidence, subthreshold and malformed model results require human review', async t => {
  let answer;
  const f = await fixture(t, { riskEvaluators: { jev: { model: 'jev-1.13.0', assess: async () => answer } } });
  await f.policy({ commands: [], modelExecution: true, thresholds: { jev: threshold('jev-1.13.0') } });
  for (const value of [
    { ...low, label: 'uncertain', probabilities: { low_risk: 0, high_risk: 0, uncertain: 1 } },
    { ...low, confidence: 0.98 }, { ...low, probabilities: { low_risk: 0.98, high_risk: 0.02, uncertain: 0 } },
    { ...low, model: 'wrong-model' }, { ...low, probabilities: { low_risk: 1, high_risk: 1, uncertain: 0 } },
  ]) { answer = value; assert.equal((await f.run('sudo id')).state, 'pending'); }
  assert.equal(f.executions.length, 0);
});

test('a newly denied command cannot execute through a previously issued owner request', async t => {
  const f = await fixture(t); await f.policy({ commands: [] }); const job = await f.run('sudo id');
  await f.policy({ commands: [], deniedCommands: ['sudo'] });
  assert.throws(() => f.app.queue.start(job.id), /denied/); assert.equal(f.executions.length, 0);
});

test('concurrent duplicate key observes the same evaluating job and does not evaluate twice', async t => {
  let complete, calls = 0;
  const f = await fixture(t, { riskEvaluators: { jev: { model: 'jev-1.13.0', assess: () => { calls++; return new Promise(resolve => { complete = resolve; }); } } } });
  await f.policy({ commands: [] });
  const key = 'fixture-same-key-0001';
  const first = await f.app.targets.commands.run('sudo id', undefined, key);
  const second = await f.app.targets.commands.run('sudo id', undefined, key);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.job.id, second.job.id); assert.equal(calls, 1);
  complete(low); await f.app.targets.drain(); assert.equal(f.executions.length, 0);
});

test('execution admission audit failure cannot dispatch a preapproved command', async t => {
  const f = await fixture(t, { audit: event => { if (event.action === 'policy-execution-started') throw Error('audit unavailable'); } });
  await f.policy({}); const job = await f.run('sudo id');
  assert.equal(job.state, 'pending'); assert.equal(job.decision.reasonCode, 'execution_busy'); assert.equal(f.executions.length, 0);
});

test('unknown elevated programs and interpreter carriers route to independent evaluation', async t => {
  const f = await fixture(t); await f.policy({});
  for (const command of ['sudo custom-program', 'sudo python3 -c "print(1)"', 'ls; id', 'ls `id`']) {
    assert.equal((await f.run(command)).state, 'pending');
  }
  assert.equal(f.inputs.length, 4); assert.equal(f.executions.length, 0);
});
