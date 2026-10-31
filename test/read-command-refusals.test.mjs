import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { classifyCommand } from 'ssh-mcp/build/policy/classifier.js';
import { createApplication } from '../app.mjs';
import { ApprovalQueue } from '../src/domain/approval-queue.mjs';
import { createCommandService } from '../src/application/commands.mjs';

const outcome = { failed: false, texts: ['합성 출력'] };
const generic = { isError: true, content: [{ type: 'text', text: 'Request refused or failed. Check authentication, state, limits and permissions.' }] };
const messages = {
  READ_COMMAND_BUSY: '유지보수 또는 다른 작업이 진행 중이어서 읽기 명령을 시작하지 않았습니다. 자동으로 재제출하지 마세요.',
  READ_COMMAND_REQUIRES_APPROVAL: '이 명령은 읽기 전용 허용 범위 밖이어서 실행하지 않았습니다. 세미콜론으로 연결한 복합 명령도 해당할 수 있습니다. 기존 작업 권한을 확인한 뒤 정확한 명령을 run-command로 제출해 서버 정책과 필요한 승인을 받으세요. 자동 전환하거나 명령을 나누어 제한을 우회하지 마세요.',
  READ_COMMAND_NOT_STARTED: '실행 자원 확보 또는 시작 감사 기록에 실패해 읽기 명령을 시작하지 않았습니다. 보호된 서버 진단을 확인하고 자동으로 재제출하지 마세요.',
  READ_COMMAND_EXECUTION_UNKNOWN: '읽기 실행기를 호출했지만 오류가 발생해 원격 실행 여부나 완료를 확정할 수 없습니다. 명령을 다시 실행하거나 다른 도구로 재제출하지 말고 보호된 서버 진단을 확인하세요.',
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function assertRefusal(reply, code) {
  const executionAttempted = code === 'READ_COMMAND_EXECUTION_UNKNOWN';
  const payload = { error_code: code, stage: executionAttempted ? 'read_execution' : 'read_admission',
    executionAttempted, requestSubmitted: false, message: messages[code] };
  assert.deepEqual(reply, { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }] });
  assert.equal(Object.hasOwn(reply, 'structuredContent'), false, '오류에는 정상 출력 스키마를 붙이지 않습니다');
  assert.deepEqual(JSON.parse(reply.content[0].text), payload);
  assert.doesNotMatch(JSON.stringify(reply), /PRIVATE_(?:COMMAND|EXCEPTION|CAUSE|DETAILS|AUDIT)_CANARY/);
}

async function mcpFixture(t, { classify = classifyCommand, executeCommand = async () => outcome, audit = () => {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'read-command-refusals-'));
  const executions = [], profiles = new Map();
  const app = await createApplication({ transferRoot: root, uiHtml: '<html></html>', classify,
    env: { BRIDGE_MCP_TOKEN: 'read-fixture', BRIDGE_ADMIN_TOKEN: 'owner-fixture', BRIDGE_UI_TICKET_KEY: 'a'.repeat(64), BRIDGE_ADMIN_ORIGIN: 'https://owner.test' },
    registry: { getProfile: name => { if (!profiles.has(name)) profiles.set(name, { host: '127.0.0.1', port: 22, user: 'fixture', readOnly: name === 'aws-readonly' }); return profiles.get(name); }, closeAll: async () => {} },
    executeCommand: (...args) => { executions.push(args); return executeCommand(...args); }, audit });
  const client = new Client({ name: 'read-refusal-fixture', version: '1' });
  t.after(async () => { await client.close(); await app.close(); await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => app.mcpHttp.listen(0, '127.0.0.1', resolve));
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + app.mcpHttp.address().port + '/mcp'),
    { requestInit: { headers: { Authorization: 'Bearer read-fixture', Connection: 'close' } } }));
  const tools = (await client.listTools()).tools;
  const tool = tools.find(item => item.name === 'read-command');
  assert.ok(tool?.outputSchema, '실제 표준 클라이언트의 출력 스키마 캐시를 먼저 채웁니다');
  return { app, executions, tool, call: (command = 'cat /tmp/PRIVATE_COMMAND_CANARY', changes = {}) => client.callTool({ name: 'read-command', arguments: { command, ...changes } }) };
}

test('READ-REFUSAL-01 실제 분류기의 복합 명령과 단독 안전 등급은 승인 사유로 거부한다', { timeout: 20000 }, async t => {
  const f = await mcpFixture(t);
  for (const command of [
    'stat /tmp/PRIVATE_COMMAND_CANARY;sha256sum /tmp/PRIVATE_COMMAND_CANARY;free -m;ps -ef',
    'sha256sum /tmp/PRIVATE_COMMAND_CANARY',
    'rm /tmp/PRIVATE_COMMAND_CANARY',
    'sudo id',
  ]) {
    assert.notEqual(classifyCommand(command).class, 'read-only');
    if (command.startsWith('stat') || command.startsWith('sha256sum')) assert.equal(classifyCommand(command).class, 'safe');
    if (command.startsWith('rm')) assert.equal(classifyCommand(command).class, 'destructive');
    assertRefusal(await f.call(command), 'READ_COMMAND_REQUIRES_APPROVAL');
  }
  await f.app.targets.drain();
  assert.equal(f.executions.length, 0); assert.deepEqual(f.app.queue.listAll(), []);
  for (const code of Object.keys(messages)) assert.ok(f.tool.description.includes(code));
  assert.match(f.tool.description, /never rerun or switch tools to resubmit/);
});

test('READ-REFUSAL-02 유지보수와 실행 중 잠금은 실행 전에 구별하고 요청을 만들지 않는다', { timeout: 20000 }, async t => {
  const entered = deferred(), gate = deferred();
  t.after(() => gate.resolve());
  const f = await mcpFixture(t, { executeCommand: async () => { entered.resolve(); await gate.promise; return outcome; } });
  f.app.queue.reserveMaintenance();
  assertRefusal(await f.call(), 'READ_COMMAND_BUSY');
  assert.equal(f.executions.length, 0); f.app.queue.releaseMaintenance();
  const first = f.call();
  try {
    await entered.promise;
    assertRefusal(await f.call('cat /tmp/second'), 'READ_COMMAND_BUSY');
    assert.equal(f.executions.length, 1);
    assert.deepEqual(f.app.queue.listAll(), []);
  } finally { gate.resolve(); }
  assert.equal((await first).isError, undefined);
  await f.app.targets.drain(); assert.equal(f.app.targets.commands.busy(), false);
});

test('READ-REFUSAL-03 시작 감사 실패는 미시작이고 실행·종료 감사 실패는 재실행 금지다', { timeout: 20000 }, async t => {
  for (const failure of ['read-started', 'executor', 'read-completed', 'read-failed']) await t.test(failure, async t => {
    const f = await mcpFixture(t, {
      audit: event => { if (event.action === failure) throw Error('PRIVATE_AUDIT_CANARY'); },
      executeCommand: () => {
        if (failure === 'executor' || failure === 'read-failed') throw Error('PRIVATE_EXCEPTION_CANARY');
        return Promise.resolve(outcome);
      },
    });
    const code = failure === 'read-started' ? 'READ_COMMAND_NOT_STARTED' : 'READ_COMMAND_EXECUTION_UNKNOWN';
    assertRefusal(await f.call(), code);
    await f.app.targets.drain();
    assert.equal(f.executions.length, failure === 'read-started' ? 0 : 1);
    assert.equal(f.app.targets.commands.busy(), false); assert.deepEqual(f.app.queue.listAll(), []);
  });
});

test('READ-REFUSAL-04 알 수 없는 코드·분류 예외·잘못된 명령과 대상은 일반 오류를 유지한다', { timeout: 20000 }, async t => {
  let classifierFails = false;
  const f = await mcpFixture(t, { classify: command => { if (classifierFails) throw Error('PRIVATE_EXCEPTION_CANARY'); return classifyCommand(command); } });
  assert.deepEqual(await f.call('cat /tmp/x\0'), generic);
  assert.deepEqual(await f.call(undefined, { target: 'not-registered' }), generic);
  classifierFails = true; assert.deepEqual(await f.call(), generic); classifierFails = false;
  const original = f.app.targets.commands.read;
  try {
    for (const code of [undefined, 'READ_COMMAND_FUTURE_UNKNOWN']) {
      f.app.targets.commands.read = () => { throw Object.assign(Error('PRIVATE_EXCEPTION_CANARY'), { code, cause: 'PRIVATE_CAUSE_CANARY', details: 'PRIVATE_DETAILS_CANARY' }); };
      assert.deepEqual(await f.call(), generic);
    }
    for (const code of Object.keys(messages)) {
      f.app.targets.commands.read = () => { throw Object.assign(Error('PRIVATE_EXCEPTION_CANARY'), { code, stage: 'untrusted', executionAttempted: false, requestSubmitted: true, cause: 'PRIVATE_CAUSE_CANARY', details: 'PRIVATE_DETAILS_CANARY' }); };
      assertRefusal(await f.call(), code);
    }
  } finally { f.app.targets.commands.read = original; }
  assert.equal(f.executions.length, 0); assert.deepEqual(f.app.queue.listAll(), []);
});

test('READ-REFUSAL-05 정상 결과와 명령의 중립 실패 결과는 기존 출력 계약을 유지한다', { timeout: 20000 }, async t => {
  let failed = false;
  const f = await mcpFixture(t, { executeCommand: async () => ({ failed, texts: ['합성 출력'] }) });
  for (const expectedState of ['completed', 'failed']) {
    const reply = await f.call();
    assert.equal(reply.isError, expectedState === 'failed' ? true : undefined); assert.equal(reply.structuredContent.state, expectedState);
    assert.equal(reply.structuredContent.kind, 'command'); assert.equal(reply.structuredContent.output.state, 'ready');
    assert.deepEqual(JSON.parse(reply.content[0].text), reply.structuredContent);
    assert.equal('error_code' in reply.structuredContent, false); failed = true;
  }
  assert.equal(f.executions.length, 2); assert.deepEqual(f.app.queue.listAll(), []);
});

function serviceFixture({ claimFails = false, failedAction, executorFails = false } = {}) {
  const gate = deferred(), events = [], counts = { claims: 0, releases: 0, executions: 0 };
  let commands, held = false, failing = true;
  const queue = new ApprovalQueue({ profile: 'writer', target: 'fixture', classify: classifyCommand,
    executeOperation: async () => outcome, externalBusy: () => commands?.busy() ?? false });
  commands = createCommandService({ queue, target: 'fixture', readProfile: 'reader', classify: classifyCommand,
    claimExecution: () => {
      counts.claims++; assert.equal(held, false);
      if (failing && claimFails) throw Error('PRIVATE_EXCEPTION_CANARY');
      held = true; return () => { assert.equal(held, true, '실행 자원은 정확히 한 번 반환합니다'); held = false; counts.releases++; };
    },
    audit: event => { events.push(event.action); if (failing && event.action === failedAction) throw Error('PRIVATE_AUDIT_CANARY'); },
    executeCommand: async () => { counts.executions++; if (failing) { await gate.promise; if (executorFails) throw Error('PRIVATE_EXCEPTION_CANARY'); } return outcome; },
  });
  return { commands, queue, gate, events, counts, held: () => held, recover: () => { failing = false; } };
}

test('READ-REFUSAL-06 자원 확보와 시작 감사 실패는 실행 없이 반환하고 다음 작업을 막지 않는다', async () => {
  for (const options of [{ claimFails: true }, { failedAction: 'read-started' }]) {
    const f = serviceFixture(options);
    await assert.rejects(f.commands.read('cat /tmp/PRIVATE_COMMAND_CANARY'), error => {
      assert.equal(error.code, 'READ_COMMAND_NOT_STARTED');
      assert.equal(error.message, 'Read command was not started; check the protected server diagnostics.'); return true;
    });
    await f.commands.drain();
    assert.equal(f.counts.executions, 0); assert.equal(f.counts.claims, 1);
    assert.equal(f.counts.releases, options.claimFails ? 0 : 1);
    assert.equal(f.held(), false); assert.equal(f.commands.busy(), false); assert.equal(f.queue.busy(), false);
    f.recover(); assert.equal(await f.commands.read('cat /tmp/recovery'), outcome);
    assert.equal(f.counts.executions, 1); assert.equal(f.counts.releases, options.claimFails ? 1 : 2);
  }
});

test('READ-REFUSAL-07 실행·종료 감사 실패도 대기를 끝내고 실행·종료 기록·자원 반환을 한 번만 한다', async () => {
  for (const options of [{ executorFails: true }, { failedAction: 'read-completed' }, { executorFails: true, failedAction: 'read-failed' }]) {
    const f = serviceFixture(options);
    const read = f.commands.read('cat /tmp/PRIVATE_COMMAND_CANARY');
    const rejected = assert.rejects(read, error => {
      assert.equal(error.code, 'READ_COMMAND_EXECUTION_UNKNOWN');
      assert.doesNotMatch(error.message, /PRIVATE_/); return true;
    });
    assert.equal(f.commands.busy(), true); assert.equal(f.queue.busy(), true); assert.equal(f.held(), true);
    let drained = false;
    const drains = Promise.all([f.commands.drain(), f.commands.drain()]).then(() => { drained = true; });
    await Promise.resolve(); assert.equal(drained, false);
    f.gate.resolve(); await rejected; await drains;
    assert.equal(drained, true); assert.equal(f.commands.busy(), false); assert.equal(f.queue.busy(), false); assert.equal(f.held(), false);
    assert.deepEqual(f.counts, { claims: 1, releases: 1, executions: 1 });
    assert.deepEqual(f.events, ['read-started', options.executorFails ? 'read-failed' : 'read-completed']);
    assert.deepEqual(f.queue.listAll(), []);
    f.recover(); assert.equal(await f.commands.read('cat /tmp/recovery'), outcome);
    assert.deepEqual(f.counts, { claims: 2, releases: 2, executions: 2 });
  }
});
