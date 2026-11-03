import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApplication } from '../app.mjs';
import { createCommandState } from '../src/adapters/storage/command-state.mjs';
import { parseTargets, resolveTargets } from '../src/adapters/config/targets.mjs';
import { publicOutputSchemas } from '../src/adapters/mcp/public-contract.mjs';
import { dispatchFailureDetails } from '../src/domain/dispatch-failure.mjs';
import { hash } from '../src/domain/validation.mjs';

// 1.7 baseline: test/legacy-17/test-mode-file-policy-application.test.mjs.17.
// TM-APP-07 maps list-targets to targets and validates the versioned strict response envelope.
// 실제 app closure·정책 저장소·router·MCP 경계를 사용하고 SSH만 대체한다.
// 아래 fixture는 CI에서만 실행한다. 실제 secret/계정/원격 파일은 사용하지 않는다.
const bytes = Buffer.from([0, 255, 13, 10, 128]);
const remotePath = 'C:/outside-configured-root/file.bin';
const entries = ['windows', 'other', 'linux'].map(id => ({ id, displayName: `합성 ${id}`,
  readProfile: `${id}-read`, writeProfile: `${id}-write`, credentialRevision: 'v1', platform: id === 'linux' ? 'linux' : 'windows' }));
const fixedPolicy = (mode = 'configured-root', configured = false, active = false) => ({
  testServerConfigured: configured, testServerActive: active, mode, allowedRoot: null, allowedRootObservedAt: null,
  osPermissionsEnforced: true, pathSafetyEnforced: true, elevationRequiresExplicitRequest: true,
});

async function fixture(t, { seed = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'test-mode-file-app-'));
  const profiles = new Map(entries.flatMap(entry => [entry.readProfile, entry.writeProfile].map(name => [name,
    { name, host: `${entry.id}.example.test`, port: 22, user: 'synthetic', readOnly: name === entry.readProfile, trustedHostKey: `SHA256:synthetic-${entry.id}` }])));
  const registry = { getProfile: name => profiles.get(name), closeAll: async () => {} };
  const definitions = resolveTargets({ targets: parseTargets(JSON.stringify(entries)) }, registry);
  const ruleFor = (id, changes = {}) => {
    const target = definitions.find(x => x.id === id);
    return { targetId: target.id, targetRevision: target.revision, profile: target.writeProfile,
      ...(target.platform === 'windows' ? { platform: 'windows' } : {}), commands: [], deniedCommands: [],
      externalDisclosure: false, modelExecution: false, fallback: null, thresholds: {}, ...changes };
  };
  if (seed.length) {
    const state = createCommandState(root);
    try { state.setPolicy({ targets: seed.map(({ id = 'windows', ...changes }) => ruleFor(id, changes)) }, 0); }
    finally { state.close(); }
  }
  let marker = '1'.repeat(64), interceptResolve;
  const app = await createApplication({ registry, transferRoot: root, classify: () => ({ class: 'safe' }),
    executeCommand: async () => { throw Error('Unexpected SSH command in file-policy fixture'); },
    audit() {}, uiHtml: '<html>fixture</html>',
    secretResolver: { async resolve() { await interceptResolve?.(); return marker; } },
    env: { BRIDGE_MCP_TOKEN: 'synthetic-mcp', BRIDGE_ADMIN_TOKEN: 'synthetic-owner', BRIDGE_ADMIN_ORIGIN: 'https://owner.example.test',
      BRIDGE_UI_TICKET_KEY: 'f'.repeat(64), BRIDGE_UI_ENABLED: 'true', BRIDGE_TARGETS: JSON.stringify(entries), BRIDGE_DEFAULT_TARGET: 'windows',
      BRIDGE_COMMAND_AUTOMATION: 'true', BRIDGE_TEST_SERVER_SECRET_REF: 'secret://fixture/test-server', BRIDGE_TRANSFER_MAX_BYTES: '64', BRIDGE_TRANSFER_BUDGET_BYTES: '128' } });
  await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => app.mcpHttp.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'test-mode-file-policy-fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.mcpHttp.address().port}/mcp`),
    { requestInit: { headers: { Authorization: 'Bearer synthetic-mcp' } } }));
  const api = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${app.adminHttp.address().port}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer synthetic-owner', ...(body === undefined ? {} : { Origin: 'https://owner.example.test', 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() };
  };
  const policy = async changes => {
    const current = await api('/api/command-policy'); assert.equal(current.status, 200);
    const proposal = { expectedRevision: current.body.revision, policy: { targets: [ruleFor('windows', changes)] } };
    const review = await api('/api/command-policy/review', proposal); assert.equal(review.status, 200);
    const saved = await api('/api/command-policy', { ...proposal, reviewToken: review.body.reviewToken, acknowledged: true });
    assert.equal(saved.status, 200); return saved.body;
  };
  t.after(async () => { await client.close(); await app.close(); await rm(root, { recursive: true, force: true }); });
  return { app, profiles, api, policy, client, runtime: id => app.targets.select(id ?? 'windows'),
    setMarker(value) { marker = value; }, onResolve(callback) { interceptResolve = callback; } };
}

test('TM-APP-01 일반 Windows와 Linux 대상은 경로 정책과 실제 권한 경계를 구분한다', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.runtime().transfers.pathPolicy({ bypassRoot: true, testServer: true }), { bypassRoot: false });
  assert.deepEqual(await f.runtime().filePolicy(), fixedPolicy());
  assert.deepEqual(await f.runtime('linux').filePolicy(), fixedPolicy('ssh-account-permissions'));
  const listed = await f.app.targets.listFilePolicies();
  assert.equal(listed.defaultTarget, 'windows'); assert.equal(listed.targets.length, 3);
  assert.deepEqual(listed.targets.find(x => x.id === 'windows').filePolicy, fixedPolicy());
  assert.deepEqual(listed.targets.find(x => x.id === 'linux').filePolicy, fixedPolicy('ssh-account-permissions'));
});

test('TM-APP-02 활성 testServer 정책과 유효 secret이 함께 있어야 root 우회를 허용한다', async t => {
  const f = await fixture(t, { seed: [{ testServer: true }] });
  assert.deepEqual(await f.runtime().transfers.pathPolicy({ bypassRoot: false }), { bypassRoot: true });
  assert.deepEqual(await f.runtime().filePolicy(), fixedPolicy('test-server-bypass', true, true));
  for (const marker of [undefined, '', 'invalid-marker']) {
    f.setMarker(marker);
    await assert.rejects(f.runtime().transfers.pathPolicy({ bypassRoot: true }), /Test server capability unavailable/);
    assert.deepEqual(await f.runtime().filePolicy(), fixedPolicy('configured-root', true, false));
  }
  f.setMarker('2'.repeat(64));
  assert.deepEqual(await f.runtime().transfers.pathPolicy(), { bypassRoot: true });
});

test('TM-APP-03 다른 대상의 testServer 정책이나 위조한 client 필드는 현재 대상에 권한을 주지 않는다', async t => {
  const f = await fixture(t, { seed: [{ id: 'other', testServer: true }] });
  const other = f.runtime('other');
  const forged = { bypassRoot: true, testServer: true, fileTargetId: other.id, fileTargetRevision: other.revision, profile: other.writeProfile };
  assert.deepEqual(await f.runtime().transfers.pathPolicy(forged), { bypassRoot: false });
  assert.deepEqual(await f.runtime().filePolicy(), fixedPolicy());
  assert.deepEqual(await other.transfers.pathPolicy(), { bypassRoot: true });
});

test('TM-APP-04 오래된 revision 또는 다른 profile 정책은 root 우회를 허용하지 않는다', async t => {
  for (const changes of [{ targetRevision: '0'.repeat(64) }, { profile: 'other-write' }]) {
    const f = await fixture(t, { seed: [{ testServer: true, ...changes }] });
    assert.deepEqual(await f.runtime().transfers.pathPolicy({ bypassRoot: true }), { bypassRoot: false });
    assert.deepEqual(await f.runtime().filePolicy(), fixedPolicy());
  }
});

test('TM-APP-05 secret 검사 중 정책이 바뀌면 이전 root 우회 권한을 반환하지 않는다', async t => {
  const f = await fixture(t, { seed: [{ testServer: true }] });
  let entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  f.onResolve(async () => { f.onResolve(undefined); entered(); await paused; });
  const pending = f.runtime().transfers.pathPolicy();
  await reached;
  await f.policy({ testServer: false });
  const rejected = assert.rejects(pending, error => {
    assert.deepEqual(dispatchFailureDetails(error), { dispatchFailureReason: 'policy_changed', dispatchFailureStage: 'policy_guard' });
    return true;
  });
  release(); await rejected;
  assert.deepEqual(await f.runtime().transfers.pathPolicy(), { bypassRoot: false });
});

test('TM-APP-06 SFTP 뒤 secret 철회는 publish를 막고 원래 연결 정리는 유지한다', async t => {
  const f = await fixture(t, { seed: [{ testServer: true }] });
  const runtime = f.runtime(), actions = [], effects = [];
  runtime.transfers.transport = { async connect(profile) {
    assert.equal(profile, 'windows-write');
    return {
      async call(command, payload) {
        actions.push(payload.action);
        if (payload.action === 'policy') return { exitCode: 0, stdout: JSON.stringify({ protocol: 'file-path-policy-v1', rootPolicyApplied: 'test-server-bypass', allowedRoot: 'C:/approved' }) };
        if (payload.action === 'publish') effects.push('published');
        return { exitCode: 0, stdout: JSON.stringify({ published: true, rootPolicyApplied: 'test-server-bypass' }) };
      },
      async upload(stream) { for await (const chunk of stream) assert.deepEqual(chunk, bytes); effects.push('sftp-uploaded'); f.setMarker(undefined); },
      async cleanup() { effects.push('cleanup'); return { exitCode: 0, stdout: JSON.stringify({ cleaned: true }) }; },
    };
  } };
  const metadata = { fileName: 'file.bin', remotePath, size: bytes.length, sha256: hash(bytes), overwrite: false, elevate: false, fileTargetBound: true };
  const item = await runtime.store.begin(metadata); await runtime.store.append(item.id, 0, bytes); await runtime.store.finish(item.id);
  await assert.rejects(runtime.transfers.upload({ ...metadata, artifactId: item.id, fileTargetId: runtime.id, fileTargetRevision: runtime.revision }), /Test server capability unavailable/);
  assert.deepEqual(actions, ['policy']);
  assert.deepEqual(effects, ['sftp-uploaded', 'cleanup']);
  assert.deepEqual(await runtime.filePolicy(), { ...fixedPolicy('configured-root', true, false),
    allowedRoot: 'C:/approved', allowedRootObservedAt: runtime.transfers.rootObservation.observedAt });
});

test('TM-APP-07 MCP targets 출력은 활성 정책을 strict filePolicy 스키마로 공개한다', async t => {
  const f = await fixture(t, { seed: [{ testServer: true }] });
  const tools = await f.client.listTools();
  assert.ok(tools.tools.find(x => x.name === 'targets').outputSchema);
  let result = await f.client.callTool({ name: 'targets', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(publicOutputSchemas.targets.parse(result.structuredContent), result.structuredContent);
  assert.deepEqual(result.structuredContent.data.targets.find(x => x.id === 'windows').filePolicy, fixedPolicy('test-server-bypass', true, true));
  assert.equal(publicOutputSchemas.targets.safeParse({ ...result.structuredContent, data: { ...result.structuredContent.data, targets: result.structuredContent.data.targets.map(x => x.id === 'windows'
    ? { ...x, filePolicy: { ...x.filePolicy, bypassRoot: true } } : x) } }).success, false);
  f.setMarker(undefined);
  result = await f.client.callTool({ name: 'targets', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.data.targets.find(x => x.id === 'windows').filePolicy, fixedPolicy('configured-root', true, false));
  assert.doesNotMatch(JSON.stringify(result), /synthetic-owner|secret:\/\/|windows-write|SHA256/);
});

test('TM-APP-08 실제 대상 설정 변경은 policy 조회와 우회 권한을 모두 중단한다', async t => {
  const f = await fixture(t, { seed: [{ testServer: true }] });
  f.profiles.get('windows-write').host = 'changed.example.test';
  await assert.rejects(f.runtime().transfers.pathPolicy(), /configuration changed/);
  await assert.rejects(f.runtime().filePolicy(), /configuration changed/);
});
