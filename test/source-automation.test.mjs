import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { classifyCommand } from 'ssh-mcp/build/policy/classifier.js';
import { createApplication } from '../app.mjs';
import { createJevAssessor } from '../src/adapters/safety/jev.mjs';
import { AUTOMATION_QUESTION } from '../src/domain/command-policy.mjs';
import { createCommandAutomation } from '../src/application/command-automation.mjs';
import { ApprovalQueue } from '../src/domain/approval-queue.mjs';
import { preparePythonSource } from '../src/adapters/ssh/python-source.mjs';
import { createRequestSafety } from '../src/application/request-safety.mjs';
import { generateKeyPairSync, createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { SSHConnection } from 'ssh-mcp/build/ssh/connection.js';
import { executePythonSource } from '../src/adapters/ssh/vendor.mjs';

const source = "# PRIVATE_BODY_SOURCE_32\nprint('한글 literal source')\n";
const context = 'Synthetic local test; print a literal only, no resources mutated, no recovery needed';
const env = { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-owner', BRIDGE_UI_TICKET_KEY: 'a'.repeat(64), BRIDGE_ADMIN_ORIGIN: 'https://owner.test', BRIDGE_COMMAND_AUTOMATION: 'true', BRIDGE_TEST_SERVER_SECRET_REF: 'secret://fixture/test-server' };
const low = { status: 'assessed', model: 'jev-1.14.0', label: 'low_risk', confidence: 0.1, probabilities: { low_risk: 0.8, high_risk: 0.2 } };
const threshold = probability => ({ model: low.model, questionVersion: 'ssh-command-risk-v5', basis: 'safety-probability-v1', minLowRisk: probability, validationRef: 'synthetic:source-contract' });
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'source-product-')), executions = [], inputs = [], events = [], profiles = new Map();
  const evaluator = { model: low.model, questionVersion: 'ssh-command-risk-v5', assess: async input => { inputs.push(input); return low; } };
  const executeSource = async (plan, verify) => { verify(); executions.push(plan); return { failed: false, texts: ['synthetic output'] }; };
  const make = () => createApplication({ secretResolver: { resolve: async () => '1'.repeat(64) },
    registry: { getProfile: name => { if (!profiles.has(name)) profiles.set(name, { host: '127.0.0.1', port: 22, user: 'fixture', readOnly: name === 'aws-readonly' }); return profiles.get(name); }, closeAll: async () => {} },
    classify: classifyCommand, executeCommand: async () => ({ failed: false, texts: ['legacy'] }), executePythonSource: executeSource,
    audit: event => events.push(event), transferRoot: root, uiHtml: '<html></html>', env, riskEvaluators: { jev: evaluator }, ...options });
  let app = await make(), origin;
  const listen = async () => { await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + app.adminHttp.address().port; };
  await listen();
  const api = async (path, body, token = 'fixture-owner') => {
    const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), Origin: env.BRIDGE_ADMIN_ORIGIN, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const policy = async changes => {
    const current = (await api('/api/command-policy')).body, binding = current.bindings[0];
    const rule = { targetId: binding.targetId, targetRevision: binding.targetRevision, profile: binding.profile, commands: ['python3', 'sudo'], deniedCommands: [], automaticSudo: true,
      sourceExecutionContract: 'python-source-v1', externalDisclosure: true, modelExecution: true, fallback: null, thresholds: { jev: threshold(0.7) }, ...changes };
    const proposal = { expectedRevision: current.revision, policy: { targets: [rule] } };
    const review = await api('/api/command-policy/review', proposal); assert.equal(review.status, 200);
    assert.equal((await api('/api/command-policy', { ...proposal, reviewToken: review.body.reviewToken, acknowledged: true })).status, 200);
    return review.body;
  };
  const run = async (changes = {}) => { const result = await app.targets.commands.runSource({ source, cwd: '/tmp', context, ...changes }); await app.targets.drain(); return app.queue.get(result.job.id); };
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { root, get app() { return app; }, get origin() { return origin; }, inputs, executions, events, profiles, api, policy, run,
    async restart() { await app.close(); app = await make(); await listen(); } };
}

test('SOURCE-PRODUCT-01 exact source reaches the real Jev HTTP adapter via MCP, then the identical bound executor, without public or durable body copies', async t => {
  let payload, modelCalls = 0;
  const assessor = createJevAssessor({ apiKey: 'synthetic-only', question: AUTOMATION_QUESTION, questionVersion: 'ssh-command-risk-v5', inputKind: 'execution', fetchImpl: async (_url, options) => {
    modelCalls++; payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ model: low.model, answers: { risk: { type: 'choice', choice: low.label, confidence: low.confidence, probabilities: low.probabilities } }, usage: { input_tokens: 11, output_tokens: 3 } }), { headers: { 'content-type': 'application/json' } });
  } });
  const f = await fixture(t, { riskEvaluators: { jev: assessor } }); await f.policy({});
  await new Promise(resolve => f.app.mcpHttp.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'source-contract-fixture', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + f.app.mcpHttp.address().port + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer fixture-mcp' } } }));
    const args = { source, argv: ['literal 한글'], cwd: '/tmp', elevate: true, context, displayContext: '합성 시험 · 원문 출력만 확인', requestKey: 'source-mcp-once-0001' };
    const response = await client.callTool({ name: 'run-python-source', arguments: args }); assert.equal(response.isError, undefined);
    await f.app.targets.drain(); const job = f.app.queue.get(response.structuredContent.id);
    assert.equal(job.state, 'completed'); assert.equal(job.approvalMode, 'automatic'); assert.equal(job.decision.reasonCode, 'model_passed');
    assert.equal(job.decision.threshold.minLowRisk, 0.7); assert.equal(modelCalls, 1); assert.equal(f.executions.length, 1);
    const evidence = JSON.parse(payload.state.context).submittedSource, plan = f.executions[0];
    assert.equal(evidence.source, source); assert.deepEqual(evidence.manifest, plan.manifest); assert.equal(evidence.planDigest, plan.planDigest);
    assert.equal(plan.stdin, source); assert.equal(plan.manifest.elevate, true); assert.match(plan.command, /^'sudo' '-n' '--' '\/usr\/bin\/python3'/);
    assert.equal(payload.state.userApproval.explicit, false); assert.deepEqual(payload.state.preapprovedCommands, []); assert.doesNotMatch(JSON.stringify(payload), /합성 시험/);
    const publicReply = await client.callTool({ name: 'get-request-status', arguments: { id: job.id } });
    const replay = await client.callTool({ name: 'run-python-source', arguments: args }); assert.equal(replay.structuredContent.id, job.id); assert.equal(modelCalls, 1);
    const publicText = JSON.stringify([response, publicReply, f.events, (await f.api('/api/requests')).body]);
    assert.doesNotMatch(publicText, /PRIVATE_BODY_SOURCE_32/);
    assert.equal((await readFile(join(f.root, 'command-automation.sqlite'))).includes(Buffer.from('PRIVATE_BODY_SOURCE_32')), false);
    assert.equal((await f.api('/api/' + job.id + '/source')).status, 409);
    const output = job.result.output;
    const page = (await f.api('/api/outputs/' + output.id)).body; assert.equal(page.text, 'synthetic output');
    const { DatabaseSync } = await import('node:sqlite');
    await f.app.close();
    const db = new DatabaseSync(join(f.root, 'command-outputs', 'manifest.sqlite'), { readOnly: true });
    try { const rows = db.prepare('SELECT body FROM outputs').all().map(row => JSON.parse(row.body)); assert.equal(rows.find(row => row.binding.executionId === job.id).binding.operationDigest, plan.planDigest); } finally { db.close(); }
  } finally { await client.close(); }
});

test('SOURCE-PRODUCT-02 source opt-in is independent of approved python/sudo names and disclosure; no model or execution before consent', async t => {
  const f = await fixture(t);
  for (const sourceExecutionContract of [undefined, null]) {
    await f.policy({ sourceExecutionContract });
    const job = await f.run(); assert.equal(job.state, 'pending'); assert.equal(job.decision.reasonCode, 'source_execution_not_enabled');
  }
  assert.equal(f.inputs.length, 0); assert.equal(f.executions.length, 0);
  await f.policy({ externalDisclosure: false }); const job = await f.run(); assert.equal(job.decision.reasonCode, 'disclosure_not_enabled');
  assert.equal(f.inputs.length, 0); assert.equal(f.executions.length, 0);
  const original = (await f.api('/api/command-policy')).body, proposal = { expectedRevision: original.revision, policy: { targets: [{ ...original.targets[0], sourceExecutionContract: 'unknown' }] } };
  assert.equal((await f.api('/api/command-policy/review', proposal)).status, 409);
});

test('SOURCE-PRODUCT-03 constrained sudo and deny policies are not silently bypassed by arbitrary code', async t => {
  const f = await fixture(t);
  await f.policy({ automaticSudo: false }); assert.equal((await f.run()).decision.reasonCode, 'source_privilege_policy_review');
  await f.policy({ deniedCommands: ['rm'] }); assert.equal((await f.run()).decision.reasonCode, 'source_command_policy_review');
  const denied = await f.run({ source: "import subprocess\nsubprocess.run(['rm','/tmp/example'])\n" });
  assert.equal(denied.state, 'denied'); assert.equal(denied.decision.reasonCode, 'policy_denied');
  assert.equal(f.inputs.length, 0); assert.equal(f.executions.length, 0);
  assert.equal((await f.api('/api/' + denied.id + '/source')).status, 409);
});

test('SOURCE-PRODUCT-04 protected pending source review is exact/no-store, unauthenticated and MCP tokens cannot read it, owner approval releases it', async t => {
  const f = await fixture(t); await f.policy({ sourceExecutionContract: null });
  const job = await f.run();
  let observerCalls = 0;
  const observer = createRequestSafety({ queue: f.app.queue, assessor: { assess: async () => { observerCalls++; return low; } } });
  await assert.rejects(observer.assess(job.id), /recorded source evaluation/); assert.equal(observerCalls, 0);
  for (const token of ['', 'fixture-mcp']) assert.equal((await f.api('/api/' + job.id + '/source', undefined, token)).status, 401);
  const result = await f.api('/api/' + job.id + '/source'); assert.equal(result.status, 200); assert.equal(result.body.source, source); assert.equal(result.headers.get('cache-control'), 'no-store');
  const observation = await f.app.targets.commands.source(job.id); assert.equal(observation.source, source);
  const approved = await f.api('/api/' + job.id + '/approve', {}); assert.equal(approved.status, 200);
  assert.equal(f.app.queue.get(job.id).approvalMode, 'owner'); assert.equal(f.executions.length, 1);
  assert.equal((await f.api('/api/' + job.id + '/source')).status, 409);
});

test('SOURCE-PRODUCT-05 source probability threshold remains per user, unfavorable valid answers are never retried through fallback', async t => {
  let fallbackCalls = 0;
  const f = await fixture(t, { riskEvaluators: { jev: { model: low.model, questionVersion: 'ssh-command-risk-v5', assess: async () => low }, luna: { model: 'luna-fixture', questionVersion: 'ssh-command-risk-v5', assess: async () => { fallbackCalls++; return { ...low, model: 'luna-fixture' }; } } } });
  for (const [probability, state] of [[0.8, 'completed'], [0.9, 'pending'], [0.7, 'completed']]) {
    await f.policy({ fallback: 'luna', thresholds: { jev: threshold(probability), luna: { ...threshold(0.7), model: 'luna-fixture' } } });
    const job = await f.run(); assert.equal(job.state, state); assert.equal(job.decision.threshold.minLowRisk, probability);
  }
  assert.equal(fallbackCalls, 0); assert.equal(f.executions.length, 2);
});

test('SOURCE-PRODUCT-06 key conflicts bind body, argv, cwd, elevation and context; restart never restores private body or replays execution', async t => {
  const f = await fixture(t); await f.policy({ sourceExecutionContract: null });
  const args = { requestKey: 'source-pending-key-0001' }, original = await f.run(args);
  for (const change of [{ source: source + '\n' }, { argv: ['different'] }, { cwd: '/' }, { elevate: true }, { context: context + '.' }]) await assert.rejects(f.run({ ...args, ...change }), /conflict/);
  assert.equal((await f.run(args)).id, original.id); const oldCommands = f.app.targets.commands; await f.restart();
  assert.throws(() => oldCommands.source(original.id), /unavailable/);
  const replay = await f.run(args); assert.equal(replay.id, original.id); assert.equal(replay.state, 'expired');
  assert.equal((await f.api('/api/' + original.id + '/source')).status, 409); assert.equal((await f.api('/api/' + original.id + '/approve', {})).status, 409);
  assert.equal(f.executions.length, 0);
});

test('SOURCE-PRODUCT-07 async evaluation policy changes withhold dispatch and async connection verification refuses a revoked grant', async t => {
  let complete;
  const f = await fixture(t, { riskEvaluators: { jev: { model: low.model, questionVersion: 'ssh-command-risk-v5', assess: () => new Promise(resolve => { complete = resolve; }) } } });
  await f.policy({}); const result = await f.app.targets.commands.runSource({ source, cwd: '/tmp', context });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.app.queue.get(result.job.id).state, 'evaluating');
  await f.policy({ sourceExecutionContract: null }); complete(low); await f.app.targets.drain();
  assert.equal(f.app.queue.get(result.job.id).decision.reasonCode, 'policy_changed'); assert.equal(f.executions.length, 0);
  let reached, release, dispatched = 0;
  const acquired = new Promise(resolve => { reached = resolve; });
  const g = await fixture(t, { executePythonSource: async (_plan, verify) => { reached(); await new Promise(resolve => { release = resolve; }); verify(); dispatched++; return { failed: false, texts: ['ok'] }; } });
  await g.policy({}); const request = await g.app.targets.commands.runSource({ source, cwd: '/tmp', context }); await acquired;
  await g.policy({ sourceExecutionContract: null }); release(); await g.app.targets.drain();
  assert.equal(g.app.queue.get(request.job.id).state, 'unknown'); assert.equal(dispatched, 0);
});

test('SOURCE-PRODUCT-08 transport ambiguity is unknown and stable request key never replays', async t => {
  let calls = 0;
  const f = await fixture(t, { executePythonSource: async () => { calls++; throw Error('PRIVATE_BODY_SOURCE_32 transport ambiguous'); } }); await f.policy({});
  const args = { requestKey: 'source-unknown-key-0001' }, job = await f.run(args);
  assert.equal(job.state, 'unknown'); assert.doesNotMatch(JSON.stringify(job), /PRIVATE_BODY_SOURCE_32/);
  assert.equal((await f.run(args)).id, job.id); await f.restart(); assert.equal((await f.run(args)).state, 'unknown'); assert.equal(calls, 1);
});

test('SOURCE-PRODUCT-09 reject credentials/arguments/cwd before admission and keep bounded source evidence complete', async t => {
  const f = await fixture(t); await f.policy({});
  for (const changes of [{ source: "x='Bearer synthetic-only'\n" }, { source: "api_key='synthetic-only'\n" }, { argv: ['api_key=synthetic'] }, { argv: ['.env'] }, { cwd: '/tmp/.env' }]) await assert.rejects(f.run(changes), /Sensitive/);
  assert.equal(f.app.queue.listAll().length, 0);
  const job = await f.run({ source: '# ' + 'x'.repeat(15500) + '\npass\n' });
  assert.equal(job.state, 'completed'); assert.equal(f.inputs.length, 1); assert.equal(f.executions.length, 1);
  assert.equal(JSON.parse(f.inputs[0].context).submittedSource.source.length, 15508);
  const held = await f.run({ context: '"'.repeat(8192) });
  assert.equal(held.state, 'pending'); assert.equal(held.decision.reasonCode, 'source_evidence_too_large');
  assert.equal(f.inputs.length, 1); assert.equal((await f.api('/api/' + held.id + '/source')).body.source, source);
  await assert.rejects(f.run({ source: 'x'.repeat(16385) }), /Invalid Python source/);
});

test('SOURCE-PRODUCT-15 sensitive-path guard lists in a 12712-byte source reach the exact bound evaluator and executor', async t => {
  const prefix = "# SYNTHETIC_ADMISSION_BODY_15 .env /etc/shadow /home/operator/.ssh/id_ed25519 /secrets/service\n# ";
  const suffix = '\npass\n';
  const submitted = prefix + '가'.repeat(447) + 'x'.repeat(11818 - prefix.length - 447 - suffix.length) + suffix;
  const situation = 'Synthetic bounded source evidence. ' + 'x'.repeat(1277 - 'Synthetic bounded source evidence. '.length);
  assert.equal(submitted.length, 11818); assert.equal(Buffer.byteLength(submitted), 12712); assert.equal(situation.length, 1277);
  let wire, calls = 0;
  const evaluator = createJevAssessor({ apiKey:'synthetic-only', question:AUTOMATION_QUESTION, questionVersion:'ssh-command-risk-v5', inputKind:'execution', fetchImpl:async (_url, options) => {
    calls++; wire = JSON.parse(options.body);
    return new Response(JSON.stringify({model:low.model, answers:{risk:{type:'choice',choice:low.label,confidence:low.confidence,probabilities:low.probabilities}},usage:{input_tokens:11,output_tokens:3}}), {headers:{'content-type':'application/json'}});
  }});
  const f = await fixture(t, {riskEvaluators:{jev:evaluator}}); await f.policy({});
  const job = await f.run({source:submitted,context:situation,requestKey:'source-full-admission-15'});
  assert.equal(job.state,'completed'); assert.equal(calls,1); assert.equal(f.executions.length,1);
  assert.ok(wire.state.context.length > 12288);
  assert.equal(JSON.parse(wire.state.context).submittedSource.source,submitted);
  assert.equal(JSON.parse(wire.state.context).callerSituation,situation);
  assert.equal(f.executions[0].stdin,submitted);
  assert.doesNotMatch(JSON.stringify([job,f.events,(await f.api('/api/requests')).body]),/SYNTHETIC_ADMISSION_BODY_15/);
  assert.equal((await readFile(join(f.root,'command-automation.sqlite'))).includes(Buffer.from('SYNTHETIC_ADMISSION_BODY_15')),false);
  assert.equal((await f.api('/api/'+job.id+'/source')).status,409);
});

test('SOURCE-PRODUCT-10 denial/expiry release the shared byte budget; absent runtime capability fails before admission', async t => {
  const f = await fixture(t); await f.policy({ sourceExecutionContract: null });
  const large = { source: '# ' + 'x'.repeat(16000) + '\npass\n' };
  const jobs = []; for (let i = 0; i < 65; i++) jobs.push(await f.run(large));
  await assert.rejects(f.run(large), /memory limit/);
  await f.api('/api/' + jobs[0].id + '/deny', {}); assert.equal((await f.run(large)).state, 'pending');
  const runtime = f.app.targets.select(); runtime.queue.now = () => Date.now() + 3_700_000;
  assert.equal((await f.run(large)).state, 'pending', 'Admission reaps expired sources before applying its budget');
  assert.equal((await f.api('/api/' + jobs[1].id + '/source')).status, 409);
  runtime.queue.now = Date.now; assert.equal((await f.run(large)).state, 'pending');
  const unavailable = await fixture(t, { executePythonSource: undefined }); await assert.rejects(unavailable.run(), /unavailable/); assert.equal(unavailable.app.queue.listAll().length, 0);
});

test('SOURCE-PRODUCT-11 admission journal failures and terminal persistence failures release private source', async () => {
  const definition = { id: 'fixture', revision: 'a'.repeat(64), writeProfile: 'fixture-write', verify() {} }, budget = { bytes: 0, count: 0 };
  let automation;
  const queue = new ApprovalQueue({ classify: classifyCommand, target: 'fixture', profile: definition.writeProfile, executeOperation: async () => ({ failed: false, texts: [] }), onTerminal: job => automation.onTerminal(job) });
  const state = { policy: () => ({ revision: 0, targets: [] }), find() {}, insert() { throw Error('journal unavailable'); } };
  automation = createCommandAutomation({ queue, state, definition, classify: classifyCommand, evaluators: {}, audit() {}, prepareSource: preparePythonSource, sourceBudget: budget });
  assert.throws(() => automation.runSource({ source, cwd: '/tmp', context }), /journal/); assert.deepEqual(budget, { bytes: 0, count: 0 });
  for (const id of queue.jobs.keys()) assert.throws(() => automation.source(id), /pending/);
  state.insert = () => {}; state.save = () => { throw Error('terminal journal unavailable'); };
  const result = await automation.runSource({ source, cwd: '/tmp', context }); await automation.drain();
  assert.equal(queue.get(result.job.id).state, 'unknown'); assert.deepEqual(budget, { bytes: 0, count: 0 });
});

test('SOURCE-PRODUCT-12 owner revocation during unavailable primary prevents fallback disclosure', async t => {
  for (const change of [{ externalDisclosure: false }, { sourceExecutionContract: null }]) await t.test(Object.keys(change)[0], async t => {
    let release, entered, fallbackCalls = 0;
    const started = new Promise(resolve => { entered = resolve; });
    const f = await fixture(t, { riskEvaluators: {
      jev: { model: low.model, questionVersion: 'ssh-command-risk-v5', assess: () => { entered(); return new Promise(resolve => { release = resolve; }); } },
      luna: { model: 'luna-fixture', questionVersion: 'ssh-command-risk-v5', assess: async () => { fallbackCalls++; return { ...low, model: 'luna-fixture' }; } },
    } });
    const initial = { fallback: 'luna', thresholds: { jev: threshold(0.7), luna: { ...threshold(0.7), model: 'luna-fixture' } } };
    await f.policy(initial);
    const result = await f.app.targets.commands.runSource({ source, cwd: '/tmp', context }); await started;
    await f.policy({ ...initial, ...change }); release(null); await f.app.targets.drain();
    assert.equal(fallbackCalls, 0, 'SOURCE-PRODUCT-12: revoked source must not reach fallback');
    assert.equal(f.executions.length, 0); assert.equal(f.app.queue.get(result.job.id).state, 'pending');
    assert.equal(f.app.queue.get(result.job.id).decision.reasonCode, 'policy_changed');
    assert.equal((await f.api('/api/' + result.job.id + '/source')).body.source, source);
    await f.api('/api/' + result.job.id + '/deny', {});
    assert.equal((await f.api('/api/' + result.job.id + '/source')).status, 409);
  });
});

async function retryTransport(t) {
  const key = () => generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const hostKey = key(), clients = new Set(), received = [];
  let sessionAttempts = 0, rejected = false, release, reached, passed = false;
  const retry = new Promise(resolve => { reached = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const server = new ssh2.Server({ hostKeys: [hostKey] }, client => {
    clients.add(client); client.on('error', () => {}); client.once('close', () => clients.delete(client));
    client.on('authentication', request => request.accept());
    client.on('ready', () => client.on('session', (accept, reject) => {
      sessionAttempts++;
      if (!rejected) { rejected = true; reject(); return; }
      const session = accept(); session.on('env', accept => accept?.());
      session.on('exec', (accept, _reject, info) => {
        const stream = accept(), chunks = []; stream.on('error', () => {});
        stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
        stream.once('end', () => { received.push({ command: info.command, source: Buffer.concat(chunks).toString('utf8') }); stream.write('fixture output'); stream.exit(0); stream.end(); });
      });
    }));
  });
  let connection;
  t.after(async () => { release(); await connection?.close(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const trustedHostKey = 'SHA256:' + createHash('sha256').update(ssh2.utils.parseKey(hostKey).getPublicSSH()).digest('base64').replace(/=+$/, '');
  const profile = { name: 'aws-local', host: '127.0.0.1', port: server.address().port, user: 'synthetic', auth: 'key', trustedHostKey,
    readOnly: false, tty: false, announceAgent: false, timeout: 8000, maxOutputBytes: 65536 };
  connection = new SSHConnection(profile, { privateKey: key() }, new Map(), 'strict');
  const ensure = connection.ensureConnected.bind(connection);
  connection.ensureConnected = async () => { if (rejected && !passed) { reached(); await barrier; passed = true; } return ensure(); };
  const registry = { getProfile: name => name === 'aws-local' ? profile : { ...profile, name, readOnly: true },
    async getOrCreate() { await connection.ensureConnected(); return connection; }, closeAll: () => connection.close() };
  return { registry, profile, received, retry, release, get attempts() { return sessionAttempts; } };
}

test('SOURCE-PRODUCT-13 pinned SSH channel retry rechecks actual owner policy and target before dispatch', { timeout: 30000 }, async t => {
  for (const mode of ['source-grant', 'disclosure', 'target', 'unchanged']) await t.test(mode, async t => {
    const wire = await retryTransport(t);
    const f = await fixture(t, { registry: wire.registry, executePythonSource: (plan, verify) => executePythonSource(wire.registry, plan, verify) });
    await f.policy({});
    const args = { source, cwd: '/tmp', context, requestKey: 'source-retry-once-0001' };
    const result = await f.app.targets.commands.runSource(args); await wire.retry;
    assert.equal(wire.attempts, 1); assert.equal(wire.received.length, 0);
    if (mode === 'source-grant') await f.policy({ sourceExecutionContract: null });
    if (mode === 'disclosure') await f.policy({ externalDisclosure: false });
    if (mode === 'target') wire.profile.user = 'changed-target';
    wire.release(); await f.app.targets.drain();
    const job = f.app.queue.get(result.job.id);
    if (mode === 'unchanged') {
      assert.equal(job.state, 'completed'); assert.equal(wire.attempts, 2); assert.equal(wire.received.length, 1);
      assert.equal(wire.received[0].source, source); assert.equal(wire.received[0].command, job.command);
      assert.equal((await f.app.targets.commands.runSource(args)).job.id, job.id); assert.equal(wire.received.length, 1);
    } else {
      assert.equal(wire.attempts, 1, 'SOURCE-PRODUCT-13: changed policy/target must prevent the second actual SSH channel');
      assert.equal(wire.received.length, 0); assert.equal(job.state, 'unknown');
      assert.equal((await f.api('/api/' + job.id + '/source')).status, 409);
      if (mode !== 'target') assert.equal((await f.app.targets.commands.runSource(args)).job.id, job.id);
      assert.equal(wire.received.length, 0);
    }
  });
});

test('SOURCE-PRODUCT-14 source request keys cannot collide with a legacy string equal to its public plan digest', async t => {
  for (const sourceFirst of [true, false]) await t.test(String(sourceFirst), async t => {
    const f = await fixture(t); await f.policy({ sourceExecutionContract: null });
    const args = { source, cwd: '/tmp', context, requestKey: 'source-domain-key-0001' };
    const current = (await f.api('/api/command-policy')).body, binding = current.bindings[0];
    const plan = preparePythonSource({ ...args, ...binding });
    const submitSource = () => f.app.targets.commands.runSource(args);
    const submitLegacy = () => f.app.targets.commands.run(plan.planDigest, undefined, args.requestKey, context, '');
    if (sourceFirst) { await submitSource(); await assert.rejects(Promise.resolve().then(submitLegacy), /conflict/); }
    else { await submitLegacy(); await assert.rejects(Promise.resolve().then(submitSource), /conflict/); }
    await f.app.targets.drain(); assert.equal(f.app.queue.listAll().length, 1);
  });
});


test('test server executes source without disclosure, model, source opt-in or sudo opt-in and revocation restores review', async t => {
  const f = await fixture(t);
  const review = await f.policy({ testServer: true, sourceExecutionContract: null, automaticSudo: false, deniedCommands: ['python3'], externalDisclosure: false, modelExecution: false, thresholds: {} });
  assert.equal(review.feedback[0].reason, 'test_server_bypass'); assert.equal(review.feedback[0].level, 'high_risk');
  const job = await f.run({ context: '', elevate: true });
  assert.equal(job.state, 'completed'); assert.equal(job.approvalMode, 'automatic'); assert.equal(job.decision.reasonCode, 'test_server_bypass');
  assert.equal(f.executions.length, 1); assert.equal(f.inputs.length, 0);
  await f.policy({ testServer: false, sourceExecutionContract: null, externalDisclosure: false });
  assert.equal((await f.run()).decision.reasonCode, 'source_execution_not_enabled');
  assert.equal(f.executions.length, 1);
});


test('test server source busy rejection releases the private plan without owner approval or replay',async t=>{
 const f=await fixture(t);await f.policy({testServer:true});
 const q=f.app.targets.select('default').queue, busy=q.externalBusy;q.externalBusy=()=>true;
 const args={requestKey:'test-source-busy-key-0001',context:''};const job=await f.run(args);
 assert.equal(job.state,'failed');assert.equal(job.decision.dispatchFailure,'not_dispatched');assert.equal(job.decision.dispatchFailureReason,'busy');assert.equal(job.decision.dispatchFailureStage,'busy_check');assert.equal(job.decision.dispatchFailureReason,'busy');assert.equal(job.decision.dispatchFailureStage,'busy_check');assert.equal(f.executions.length,0);
 assert.throws(()=>f.app.targets.commands.source(job.id));q.externalBusy=busy;
 assert.equal((await f.run(args)).id,job.id);assert.equal(f.executions.length,0);
});
