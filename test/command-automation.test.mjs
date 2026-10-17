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
import { createJevAssessor } from '../src/adapters/safety/jev.mjs';

const low = { status: 'assessed', model: 'jev-1.14.0', label: 'low_risk', confidence: 1,
  probabilities: { low_risk: 1, high_risk: 0, uncertain: 0 } };
const env = { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-owner', BRIDGE_UI_TICKET_KEY: 'a'.repeat(64), BRIDGE_ADMIN_ORIGIN: 'https://owner.test', BRIDGE_COMMAND_AUTOMATION: 'true' };
const threshold = model => ({ model, questionVersion: 'ssh-command-risk-v4', basis: 'safety-probability-v1', minLowRisk: 0.9, validationRef: 'synthetic:test-only' });
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'command-automation-')), executions = [], inputs = [], events = [];
  const evaluator = { model: 'jev-1.14.0', questionVersion: 'ssh-command-risk-v4', async assess(input) { inputs.push(input); return low; } };
  const make = () => createApplication({ registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'fixture', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
    classify: classifyCommand, executeCommand: async (profile, command) => { executions.push({ profile, command }); return { failed: false, texts: ['ok'] }; },
    audit: event => events.push(event), transferRoot: root, uiHtml: '<html>fixture</html>', env,
    riskEvaluators: { jev: evaluator }, ...options,
    ...(options.riskEvaluators ? { riskEvaluators: Object.fromEntries(Object.entries(options.riskEvaluators).map(([key, value]) => [key, { questionVersion: 'ssh-command-risk-v4', ...value }])) } : {}) });
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
      commands: ['ls', 'rm', 'id'], deniedCommands: [], automaticSudo: true, externalDisclosure: true, modelExecution: false, fallback: null, thresholds: {}, ...changes };
    const proposal = { expectedRevision: current.revision, policy: { targets: [rule] } };
    const review = await api('/api/command-policy/review', proposal); assert.equal(review.status, 200);
    const result = await api('/api/command-policy', { ...proposal, reviewToken: review.body.reviewToken, acknowledged: true });
    assert.equal(result.status, 200); return result.body;
  };
  const run = async (command, key, context = 'Synthetic test instance; fixture effects only; no external resources; restore the fixture after checking') => {
    const result = await app.targets.commands.run(command, undefined, key, context);
    await app.targets.drain();
    return app.queue.get(result.job.id);
  };
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { root, get app() { return app; }, executions, inputs, events, api, policy, run,
    async restart() { await app.close(); app = await make(); await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${app.adminHttp.address().port}`; } };
}

test('every registered command bypasses argument-risk evaluation; all segments and nested names must match', async t => {
  const f = await fixture(t); await f.policy({commands:['ls','rm','id']});
  for (const command of ['ls /tmp', 'rm -rf /tmp/fixture', 'sudo -n rm -rf /tmp/fixture', 'ls && id', 'ls $(id)', 'ls; rm /tmp/fixture']) {
    const job = await f.run(command, undefined, ''); assert.equal(job.state,'completed',command);assert.equal(job.decision.reasonCode,'command_set');assert.equal(job.approvalMode,'automatic');
  }
  assert.equal(f.inputs.length,0);assert.equal(f.executions.length,6);
  await f.policy({commands:['ls']});
  for (const command of ['ls && rm /tmp/fixture','ls | grep x','ls $(id)','ls '+String.fromCharCode(96)+'id'+String.fromCharCode(96)]) {
    const job = await f.run(command);assert.equal(job.state,'pending',command);assert.equal(job.decision.reasonCode,'observation_only');
    assert.equal(f.inputs.at(-1).command,command);assert.equal(f.inputs.at(-1).userApproval.explicit,false);
  }
  assert.equal(f.inputs.length,4);assert.equal(f.executions.length,6);
});

test('model OR path executes sudo and unmatched commands only with explicit provider-specific safety probability policy', async t => {
  const f = await fixture(t); await f.policy({ commands: [], modelExecution: true, thresholds: { jev: threshold('jev-1.14.0') } });
  const job = await f.run('sudo systemctl restart synthetic.service');
  assert.equal(job.state, 'completed'); assert.equal(job.decision.reasonCode, 'model_passed');
  assert.equal(job.approvalMode, 'automatic');
  assert.equal(f.executions[0].command, 'sudo systemctl restart synthetic.service');
  assert.deepEqual(Object.keys(f.inputs[0]).sort(), ['command', 'context', 'environment', 'preapprovedCommands', 'target', 'userApproval']);
  assert.deepEqual(f.inputs[0].preapprovedCommands, ['sudo']); assert.equal(f.inputs[0].userApproval.explicit, false);
  assert.doesNotMatch(JSON.stringify(f.inputs), /threshold|fixture-owner/);
  const details = JSON.parse(f.inputs[0].context);
  assert.equal(details.serverFacts.sshTarget, 'fixture@127.0.0.1:22');
  assert.match(details.callerSituation, /Synthetic test instance/);
});

test('safety probability0.9 is inclusive and confidence is diagnostic rather than a second gate', async t => {
  let answer;
  const f = await fixture(t, { riskEvaluators: { jev: { model: 'jev-1.14.0', assess: async () => answer } } });
  await f.policy({ commands: [], modelExecution: true, thresholds: { jev: threshold('jev-1.14.0') } });
  for (const [probability, confidence, expected] of [[0.899, 1, 'pending'], [0.9, 0.1, 'completed'], [0.91, 0.86, 'completed']]) {
    answer = { ...low, confidence, probabilities: { low_risk: probability, high_risk: 1 - probability, uncertain: 0 } };
    const job = await f.run('sudo id'); assert.equal(job.state, expected);
    if (expected === 'completed') { assert.equal(job.decision.threshold.basis, 'safety-probability-v1'); assert.equal(Object.hasOwn(job.decision.threshold, 'minConfidence'), false); }
  }
  assert.equal(f.executions.length, 2);
});

test('legacy combined-confidence policy stays readable but never silently gains probability-only authority', async t => {
  const f = await fixture(t);
  const legacy = { model: 'jev-1.14.0', questionVersion: 'ssh-command-risk-v3', minLowRisk: 0.9, minConfidence: 0.9, validationRef: 'synthetic:legacy-combined' };
  const current = await f.policy({ commands: [], modelExecution: true, thresholds: { jev: legacy } });
  assert.equal((await f.run('sudo id')).state, 'pending');
  await f.restart(); assert.equal((await f.run('sudo id')).state, 'pending');
  assert.equal(f.executions.length, 0);
  const rule = current.targets[0];
  for (const value of [{ ...threshold('jev-1.14.0'), minConfidence: 0.99 }, { ...threshold('jev-1.14.0'), basis: 'unknown' }]) {
    assert.throws(() => validateCommandPolicy({ targets: [{ ...rule, thresholds: { jev: value } }] }));
  }
  await f.policy({ commands: [], modelExecution: true, thresholds: { jev: threshold('jev-1.14.0') } });
  assert.equal((await f.run('sudo id')).state, 'completed');
});

test('explanations identify the first failed gate and preserve usage without changing authority', async t => {
  let answer = { ...low, inputTokens: 17, outputTokens: 3 };
  const f = await fixture(t, { riskEvaluators: { jev: { model: 'jev-1.14.0', assess: async () => answer } } });
  const cases = [
    [{}, answer, 'execution_disabled'],
    [{ modelExecution: true }, answer, 'threshold_missing'],
    [{ modelExecution: true, thresholds: { jev: threshold('other-model') } }, answer, 'model_mismatch'],
    [{ modelExecution: true, thresholds: { jev: { model: 'jev-1.14.0', questionVersion: 'ssh-command-risk-v3', minLowRisk: 0.9, minConfidence: 0.9, validationRef: 'synthetic:legacy' } } }, answer, 'question_mismatch'],
    [{ modelExecution: true, thresholds: { jev: threshold('jev-1.14.0') } }, { ...answer, label: 'high_risk', probabilities: { low_risk: 0, high_risk: 0.6, uncertain: 0.4 }, confidence: 0.4 }, 'high_risk'],
    [{ modelExecution: true, thresholds: { jev: threshold('jev-1.14.0') } }, { ...answer, label: 'uncertain', probabilities: { low_risk: 0, high_risk: 0.4, uncertain: 0.6 } }, 'uncertain'],
    [{ modelExecution: true, thresholds: { jev: threshold('jev-1.14.0') } }, { ...answer, probabilities: { low_risk: 0.8, high_risk: 0.1, uncertain: 0.1 } }, 'below_threshold'],
  ];
  for (const [changes, value, reason] of cases) {
    answer = value; await f.policy({ commands: [], ...changes });
    const job = await f.run('sudo id', undefined, 'Synthetic purpose and known impact');
    assert.equal(job.state, 'pending'); assert.equal(job.decision.reviewReason, reason);
    assert.equal(job.decision.decisionRuleVersion, 'command-explanation-v1');
    assert.equal(job.decision.assessment.inputTokens, 17); assert.equal(job.decision.assessment.outputTokens, 3);
    assert.equal(job.decision.evaluation.purpose, 'execution'); assert.equal(job.decision.evaluation.callerContextProvided, true);
  }
  assert.equal(f.executions.length, 0);
});

test('missing thresholds, denied names, disclosure and sensitive-input guards never autoexecute', async t => {
  const f = await fixture(t);
  await f.policy({ commands: [], modelExecution: true });
  assert.equal((await f.run('sudo id')).state, 'pending');
  await f.policy({ deniedCommands: ['rm'], modelExecution: true, thresholds: { jev: threshold('jev-1.14.0') } });
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
  const f = await fixture(t, { riskEvaluators: { jev: { model: 'jev-1.14.0', assess: async () => primary },
    luna: { model: 'luna-fixture', assess: async () => { calls++; return { ...low, model: 'luna-fixture' }; } } } });
  await f.policy({ commands: [], fallback: 'luna', modelExecution: true, thresholds: { luna: threshold('luna-fixture') } });
  assert.equal((await f.run('sudo id')).state, 'completed'); assert.equal(calls, 1);
  primary = { ...low, label: 'high_risk', probabilities: { low_risk: 0, high_risk: 1, uncertain: 0 } };
  assert.equal((await f.run('sudo id')).state, 'pending'); assert.equal(calls, 1);
});

test('policy revision change during evaluation discards the old automatic decision', async t => {
  let complete;
  const f = await fixture(t, { riskEvaluators: { jev: { model: 'jev-1.14.0', assess: () => new Promise(resolve => { complete = resolve; }) } } });
  await f.policy({ commands: [], modelExecution: true, thresholds: { jev: threshold('jev-1.14.0') } });
  const { job } = await f.app.targets.commands.run('sudo id', undefined, undefined, 'Synthetic identity inspection; no mutation');
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
  const restored = await f.run('sudo id', key); assert.equal(restored.id, job.id); assert.equal(restored.approvalMode, 'automatic'); assert.equal(f.executions.length, 1);
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
  assert.equal((await f.api('/api/command-policy/review', { expectedRevision: 0, policy: { targets: [] } }, { Authorization: 'Bearer fixture-mcp' })).status, 401);
  assert.equal((await f.api('/api/command-policy/review', { expectedRevision: 0, policy: { targets: [] } }, { Origin: 'https://other.test' })).status, 403);
  assert.equal((await f.api('/api/command-policy', { expectedRevision: 0, policy: { targets: [] }, acknowledged: true })).status, 409);
  assert.equal((await f.api('/api/command-policy', { expectedRevision: 0, policy: { targets: [] } }, { Origin: 'https://other.test' })).status, 403);
  await f.policy({});
  assert.equal((await f.api('/api/command-policy', { expectedRevision: initial.body.revision, policy: { targets: [] } })).status, 409);
  const rule = { ...(await f.api('/api/command-policy')).body.targets[0], targetRevision: '0'.repeat(64) };
  assert.equal((await f.api('/api/command-policy', { expectedRevision: 1, policy: { targets: [rule] } })).status, 409);
  assert.throws(() => validateCommandPolicy({ targets: [{ ...rule, commands: ['ls -la'] }] }));
});

test('a stored v2 threshold is loadable but cannot approve execution under the changed v4 question', async t => {
  const f = await fixture(t);
  await f.policy({ commands: [], modelExecution: true, thresholds: { jev: { ...threshold('jev-1.14.0'), questionVersion: 'ssh-command-risk-v2' } } });
  assert.equal((await f.run('sudo id')).state, 'pending'); assert.equal(f.executions.length, 0);
  await f.restart(); assert.equal((await f.run('sudo id')).state, 'pending');
});

test('partial name approval never tells Jev the whole mixed line was explicitly approved', async t => {
  const f=await fixture(t,{riskEvaluators:{jev:{model:'jev-1.14.0',assess:async()=>({...low,label:'high_risk',probabilities:{low_risk:0,high_risk:1,uncertain:0}})}}});
  await f.policy({commands:['ls'],modelExecution:true,thresholds:{jev:threshold('jev-1.14.0')}});
  const job=await f.run('ls && rm -rf /tmp/fixture');assert.equal(job.state,'pending');assert.equal(job.decision.assessment.label,'high_risk');assert.equal(f.executions.length,0);
});

test('AIK adapter never dispatches before authority and keeps host authorization out of MCP', async () => {
  const events = [], auth = { status: 'authorized', binding_digest: 'fixture', authorization_revision: 1 };
  const adapter = createAikSshTool({ authority: { authorize: async () => { events.push('authorize'); return auth; },
    revalidate: async value => { assert.equal(value, auth); events.push('revalidate'); }, recordReceipt: async () => events.push('receipt'),
    recordDispatch: async () => events.push('intent'), bindRequest: async () => events.push('bind'), lookupRequest: async () => auth },
    mcp: { call: async (name, args) => { events.push(name); assert.equal(JSON.stringify(args).includes('binding_digest'), false); if (name === 'run-command') assert.equal(args.context, 'Inspect test identity; no changes'); return { id: 'a'.repeat(48), state: 'completed' }; } } });
  const job = await adapter.run({ tool_call_id: 'fixture-call', effect_id: 'fixture-effect', arguments: { target: 'test', command: 'sudo id', context: 'Inspect test identity; no changes' } });
  await adapter.status(job.id);
  assert.deepEqual(events, ['authorize', 'revalidate', 'intent', 'revalidate', 'run-command', 'bind', 'get-request-status', 'receipt']);
  let calls = 0;
  const denied = createAikSshTool({ authority: { authorize: async () => { throw Error('AIK denied'); }, revalidate() {}, recordReceipt() {}, recordDispatch() {}, bindRequest() {}, lookupRequest() {} }, mcp: { call: () => calls++ } });
  await assert.rejects(denied.run({}), /AIK denied/); assert.equal(calls, 0);
});

test('uncertain, subthreshold and malformed model results require human review', async t => {
  let answer;
  const f = await fixture(t, { riskEvaluators: { jev: { model: 'jev-1.14.0', assess: async () => answer } } });
  await f.policy({ commands: [], modelExecution: true, thresholds: { jev: threshold('jev-1.14.0') } });
  for (const value of [
    { ...low, label: 'uncertain', probabilities: { low_risk: 0, high_risk: 0, uncertain: 1 } },
    { ...low, probabilities: { low_risk: 0.899, high_risk: 0.101, uncertain: 0 } },
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
  const f = await fixture(t, { riskEvaluators: { jev: { model: 'jev-1.14.0', assess: () => { calls++; return new Promise(resolve => { complete = resolve; }); } } } });
  await f.policy({ commands: [] });
  const key = 'fixture-same-key-0001';
  const first = await f.app.targets.commands.run('sudo id', undefined, key, 'Synthetic identity inspection; no mutation');
  const second = await f.app.targets.commands.run('sudo id', undefined, key, 'Synthetic identity inspection; no mutation');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.job.id, second.job.id); assert.equal(calls, 1);
  complete(low); await f.app.targets.drain(); assert.equal(f.executions.length, 0);
});

test('execution admission audit failure cannot dispatch a preapproved command', async t => {
  const f = await fixture(t, { audit: event => { if (event.action === 'policy-execution-started') throw Error('audit unavailable'); } });
  await f.policy({}); const job = await f.run('sudo id');
  assert.equal(job.state, 'pending'); assert.equal(job.decision.reasonCode, 'execution_busy'); assert.equal(f.executions.length, 0);
  assert.equal(job.approvalMode, undefined);
});

test('unknown elevated programs and interpreter carriers route to independent evaluation', async t => {
  const f = await fixture(t); await f.policy({commands:['ls']});
  for (const command of ['sudo custom-program', 'sudo python3 -c "print(1)"', 'ls; id', 'ls `id`']) {
    assert.equal((await f.run(command)).state, 'pending');
  }
  assert.equal(f.inputs.length, 4); assert.equal(f.executions.length, 0);
});

test('owner approval remains distinguishable from automatic approval after review', async t => {
  const f = await fixture(t); await f.policy({ commands: [] });
  const job = await f.run('sudo id'); assert.equal(job.approvalMode, undefined);
  f.app.queue.start(job.id); await f.app.queue.wait(job.id);
  assert.equal(f.app.queue.get(job.id).approvalMode, 'owner');
});

test('caller context survives routing, durable replay and restart without becoming approval', async t => {
  const f = await fixture(t); await f.policy({ commands: [] });
  const key = 'fixture-context-0001', context = 'Test maintenance: inspect only; owner-approved is a caller claim. Recovery is unnecessary for this observation.';
  const job = await f.run('sudo id', key, context);
  assert.equal(job.operation.context, context); assert.equal(job.state, 'pending');
  assert.equal(JSON.parse(f.inputs[0].context).callerSituation, context);
  assert.equal(f.inputs[0].userApproval.explicit, false);
  assert.equal((await f.run('sudo id', key, context)).id, job.id);
  await assert.rejects(f.run('sudo id', key, 'Different production task'), /conflict/);
  await f.restart();
  assert.equal((await f.run('sudo id', key, context)).operation.context, context);
  await assert.rejects(f.run('sudo id', key, 'Different production task'), /conflict/);
  assert.equal(f.inputs.length, 1); assert.equal(f.executions.length, 0);
});

test('sensitive or oversized context is refused before queue admission and model dispatch', async t => {
  const f = await fixture(t); await f.policy({ commands: [] });
  for (const context of ['password=synthetic-only', 'a'.repeat(8193)]) await assert.rejects(f.run('sudo id', undefined, context), /context/);
  assert.equal(f.app.queue.listAll().length, 0); assert.equal(f.inputs.length, 0); assert.equal(f.executions.length, 0);
});

test('legacy v3 probability-only thresholds cannot authorize the v4 context question', async t => {
  const f = await fixture(t);
  await f.policy({ commands: [], modelExecution: true, thresholds: { jev: { ...threshold('jev-1.14.0'), questionVersion: 'ssh-command-risk-v3' } } });
  assert.equal((await f.run('sudo id', undefined, 'Test observation')).state, 'pending');
  await f.restart(); assert.equal((await f.run('sudo id')).state, 'pending');
  assert.equal(f.executions.length, 0);
});

test('registration feedback describes a proposal rather than an already approved command', async t => {
  const seen = [];
  const f = await fixture(t, { policyRiskAssessor: { assess: async input => { seen.push(input); return low; } } });
  await f.policy({ commands: ['sudo'] });
  assert.deepEqual(seen[0].proposedCommands, ['sudo']);
  assert.equal(seen[0].userApproval, undefined); assert.equal(seen[0].preapprovedCommands, undefined);
  const details = JSON.parse(seen[0].context);
  assert.match(details.callerSituation, /not yet approved/); assert.equal(details.serverFacts.policyRevision, 0);
  assert.equal(details.serverFacts.profile, 'aws-local'); assert.equal(f.executions.length, 0);
});

test('reviewed model selection drives actual evaluator transport while preserving old pinned selections', async t => {
  const seen = [];
  const evaluator = createJevAssessor({ apiKey: 'synthetic', questionVersion: 'ssh-command-risk-v4', inputKind: 'execution', fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); seen.push(body.model);
    return new Response(JSON.stringify({ model: body.model, answers: { risk: { type: 'choice', choice: 'low_risk', confidence: 1, probabilities: low.probabilities } }, usage: { input_tokens: 3, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
  } });
  const f = await fixture(t, { riskEvaluators: { jev: evaluator } });
  for (const model of ['jev-1.13.0', 'jev-1.14.0']) {
    await f.policy({ commands: [], modelExecution: true, thresholds: { jev: threshold(model) } });
    const job = await f.run('sudo id'); assert.equal(job.state, 'completed'); assert.equal(job.decision.assessment.model, model);
  }
  assert.deepEqual(seen, ['jev-1.13.0', 'jev-1.14.0']);
});

test('missing or whitespace-only task context withholds the model call and execution; explicit command-name authority is unchanged', async t => {
  const f = await fixture(t); await f.policy({ commands: ['ls'], modelExecution: true, thresholds: { jev: threshold('jev-1.14.0') } });
  for (const context of ['', '   ']) {
    const job = await f.run('sudo id', undefined, context);
    assert.equal(job.state, 'pending'); assert.equal(job.decision.reasonCode, 'context_required');
    assert.equal(job.decision.evaluation.modelCalled, false); assert.equal(job.decision.assessment, undefined);
  }
  assert.equal(f.inputs.length, 0); assert.equal(f.executions.length, 0);
  assert.equal((await f.run('ls /tmp', undefined, '')).state, 'completed');
  assert.equal(f.inputs.length, 0);
});

test('the legacy command-only MCP path delivers exact task context through automation into the Jev HTTP body', async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { AUTOMATION_QUESTION } = await import('../src/domain/command-policy.mjs');
  let payload, calls = 0;
  const assessor = createJevAssessor({ apiKey: 'synthetic-only-key', question: AUTOMATION_QUESTION, questionVersion: 'ssh-command-risk-v4', inputKind: 'execution', fetchImpl: async (_url, options) => {
    calls++; payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ model: 'jev-1.14.0', answers: { risk: { type: 'choice', choice: 'uncertain', confidence: 1, probabilities: { low_risk: 0, high_risk: 0, uncertain: 1 } } }, usage: { input_tokens: 10, output_tokens: 4 } }), { headers: { 'content-type': 'application/json' } });
  } });
  const f = await fixture(t, { riskEvaluators: { jev: assessor } });
  await f.policy({ commands: [], modelExecution: true, thresholds: { jev: threshold('jev-1.14.0') } });
  await new Promise(resolve => f.app.mcpHttp.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'command-only-host-fixture', version: '1' });
  const command = 'sudo id', context = 'Test only; inspect effective identity to verify the SSH account; no writes or restart; no recovery required';
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + f.app.mcpHttp.address().port + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer fixture-mcp' } } }));
    const response = await client.callTool({ name: 'run-command', arguments: { command: 'ssh-request-v1:' + JSON.stringify({ command, context }) } });
    assert.equal(response.isError, undefined); await f.app.targets.drain();
    const job = f.app.queue.get(response.structuredContent.id);
    assert.equal(job.operation.command, command); assert.equal(job.operation.context, context);
    assert.equal(payload.state.command, command); assert.equal(JSON.parse(payload.state.context).callerSituation, context);
    assert.equal(payload.state.userApproval.explicit, false); assert.deepEqual(payload.state.preapprovedCommands, ['sudo']);
    assert.equal(job.decision.evaluation.callerContextProvided, true); assert.equal(job.decision.threshold.minLowRisk, 0.9);
    assert.equal(job.state, 'pending'); assert.equal(calls, 1); assert.equal(f.executions.length, 0);
  } finally { await client.close(); }
});

test('sudo defaults to individual owner approval even if its name was saved; opt-in is separate and revocable',async t=>{
  const f=await fixture(t);
  for(const automaticSudo of [undefined,false]){
    await f.policy({commands:['sudo','id'],automaticSudo,modelExecution:true,thresholds:{jev:threshold('jev-1.14.0')}});
    const job=await f.run('sudo -n id');assert.equal(job.state,'pending');assert.equal(job.decision.reasonCode,'sudo_not_enabled');
  }
  assert.equal(f.inputs.length,0);assert.equal(f.executions.length,0);
  await f.policy({commands:['id'],automaticSudo:true});assert.equal((await f.run('sudo -n id')).state,'completed');assert.equal(f.inputs.length,0);
  await f.policy({commands:[],automaticSudo:true,modelExecution:true,thresholds:{jev:threshold('jev-1.14.0')}});
  assert.equal((await f.run('sudo -n id')).state,'completed');assert.equal(f.inputs.length,1);
  await f.policy({commands:['id'],automaticSudo:false});assert.equal((await f.run('sudo -n id')).decision.reasonCode,'sudo_not_enabled');assert.equal(f.executions.length,2);
});

// Quoting cannot hide a denied name from the new bypass grammar.
test('denied names remain prior to full-line bypass after shell quote removal', async t => {
 const f=await fixture(t);await f.policy({commands:['ls','rm'],deniedCommands:['rm']});
 for(const line of ["r'm' /tmp/fixture","ls && r'm' /tmp/fixture"]){const job=await f.run(line);assert.equal(job.state,'denied');}
 assert.equal(f.executions.length,0);assert.equal(f.inputs.length,0);
});

test('combined shell flags cannot hide unregistered or disabled sudo names',async t=>{
 const f=await fixture(t);await f.policy({commands:['bash','ls'],automaticSudo:false});
 assert.equal((await f.run('bash -lc "sudo id"')).decision.reasonCode,'sudo_not_enabled');
 const mixed=await f.run('bash -lc "ls && id"');assert.equal(mixed.state,'pending');assert.equal(f.inputs.at(-1).command,'bash -lc "ls && id"');
 assert.equal(f.executions.length,0);
});
