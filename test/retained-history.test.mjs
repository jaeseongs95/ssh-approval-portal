import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRetainedHistory, HISTORY_RESPONSE_BYTES } from '../src/application/history.mjs';
import { createCommandState } from '../src/adapters/storage/command-state.mjs';
import { createAgentCliState } from '../src/adapters/storage/agent-cli-state.mjs';
import { openDormantCommandState } from '../src/adapters/storage/offline-preservation.mjs';
import { presentJob } from '../src/adapters/presentation/results.mjs';
import { authorizeAdminRequest } from '../src/adapters/security/admin-policy.mjs';
import { AGENT_CLI_CONTRACT, agentCliProviders } from '../src/domain/agent-cli.mjs';
import { hash } from '../src/domain/validation.mjs';
import { createApplication } from '../app.mjs';

const id = n => n.toString(16).padStart(48, '0');
const target = { id: 'alpha', revision: 'a'.repeat(64), enabled: true, writeProfile: 'alpha-write' };
const job = (n, changes = {}) => ({ id: id(n), kind: 'command', operation: { kind: 'command', command: 'printf history' }, command: 'printf history',
  targetId: target.id, targetRevision: target.revision, targetDisplayName: '기록 당시 대상', profile: target.writeProfile,
  commandClass: 'privileged', target: 'synthetic-host', state: 'completed', createdAt: 1000, expiresAt: 2000, finishedAt: 1500, ...changes });
const journal = jobs => ({ *historyRows() { yield* jobs; }, historyJob(key) { return structuredClone(jobs.find(value => value.id === key)); } });
const history = ({ jobs = [], saved = [], cli = [], targets = [target], verifyCliTarget = () => {}, now = () => 3 * 86400000, ...ports } = {}) =>
  createRetainedHistory({ commandJournal: journal(saved), cliJournal: journal(cli), readQueue: () => jobs, readTargets: () => targets, verifyCliTarget, present: presentJob, now, ...ports });
const query = value => new URLSearchParams(value);
const throwsCode = (run, code, status = 400) => assert.throws(run, error => error.historyCode === code && error.status === status);

test('HIST-OLD 기존 장부의 24시간 초과 명령을 기간으로 찾고 결과 원문을 공개하지 않는다', () => {
  const value = history({ saved: [job(1, { result: { failed: false, texts: ['SYNTHETIC_PRIVATE_OUTPUT'], data: { secret: 'SYNTHETIC_PRIVATE_DATA' } } })] })(query({ from: '0', to: '86400000' }));
  assert.equal(value.items[0].id, id(1));
  assert.equal(value.items[0].history.stateSource, 'journal');
  assert.equal(value.items[0].history.storage, 'command');
  assert.deepEqual(value.items[0].result.content, []);
  assert.doesNotMatch(JSON.stringify(value), /SYNTHETIC_PRIVATE/);
  assert.equal(value.coverage.snapshot, false);
  assert.equal(value.coverage.fileHistory, 'memory-only');
  assert.equal(Object.hasOwn(value, 'total'), false);
});

test('HIST-MERGE 중복 제거 뒤 메모리 현재 상태로 조건을 적용하고 결속 충돌을 거절한다', () => {
  const stored = job(1, { state: 'pending' }), current = job(1, { state: 'failed' });
  const value = history({ jobs: [current], saved: [stored] })(query({ state: 'failed' }));
  assert.equal(value.items.length, 1);
  assert.equal(value.items[0].state, 'failed');
  assert.deepEqual(value.items[0].history, { stateSource: 'memory', storage: 'command', targetStatus: 'active' });
  assert.deepEqual(history({ jobs: [job(1, { state: 'running' })], saved: [job(1)] })(query()).items, []);
  throwsCode(() => history({ jobs: [current], saved: [job(1, { command: 'other' })] })(query()), 'HISTORY_AMBIGUOUS_REQUEST', 409);
});

test('HIST-PAGE 같은 생성시각 41개를 고정 상한과 복합 커서로 한 번씩 방문한다', () => {
  const saved = Array.from({ length: 41 }, (_, n) => job(n + 1));
  let clock = 2000;
  const read = history({ saved, now: () => clock }), first = read(query());
  assert.deepEqual(first.items.map(value => value.id), Array.from({ length: 20 }, (_, n) => id(41 - n)));
  saved.push(job(99, { createdAt: 3000 })); clock = 5000;
  const second = read(query({ cursor: first.nextCursor })), third = read(query({ cursor: second.nextCursor }));
  assert.deepEqual(second.items.map(value => value.id), Array.from({ length: 20 }, (_, n) => id(21 - n)));
  assert.deepEqual(third.items.map(value => value.id), [id(1)]);
  assert.equal(third.nextCursor, null);
  assert.equal(second.asOf, 2000);
  assert.equal(second.observedAt, 5000);
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map(value => value.id)).size, 41);
});

test('HIST-RANGE 기간은 포함 하한과 제외 상한이며 조건 변경 커서를 거절한다', () => {
  const read = history({ saved: [job(1, { createdAt: 999 }), job(2), job(3, { createdAt: 2000 })] });
  assert.deepEqual(read(query({ from: '1000', to: '2000' })).items.map(value => value.id), [id(2)]);
  const cursor = history({ saved: Array.from({ length: 21 }, (_, n) => job(n + 1)) })(query()).nextCursor;
  throwsCode(() => read(query({ cursor, q: 'changed' })), 'HISTORY_INVALID_CURSOR');
  for (const value of [{ from: '1.5' }, { from: '9007199254740992' }, { from: '2', to: '2' }]) throwsCode(() => read(query(value)), 'HISTORY_INVALID_RANGE');
});

test('HIST-INPUT 알 수 없는 필드와 중복, 비정규 커서, 검색 상한을 거절한다', () => {
  const read = history();
  for (const value of ['target=alpha&target=alpha', 'limit=100']) throwsCode(() => read(query(value)), 'HISTORY_INVALID_FIELDS');
  for (const cursor of ['', 'a=', 'a'.repeat(2049), Buffer.from('{}').toString('base64url')]) throwsCode(() => read(query({ cursor })), 'HISTORY_INVALID_CURSOR');
  throwsCode(() => read(query({ q: '가'.repeat(201) })), 'HISTORY_SEARCH_TOO_LARGE');
  assert.deepEqual(read(query({ q: '😀'.repeat(200) })).items, []);
  throwsCode(() => read(query({ state: 'running' })), 'HISTORY_INVALID_FILTER');
});

test('HIST-TARGET 현재 미등록 대상은 제외하며 변경·사용 중지된 일반 명령은 기록 당시 결속으로 표시한다', () => {
  const changed = { ...target, revision: 'b'.repeat(64) };
  const value = history({ saved: [job(1), job(2, { targetId: 'removed' })], targets: [changed] })(query());
  assert.deepEqual(value.items.map(value => value.id), [id(1)]);
  assert.equal(value.items[0].targetRevision, target.revision);
  assert.equal(value.items[0].history.targetStatus, 'changed');
  assert.equal(value.coverage.registeredTargetsOnly, true);
  assert.equal(history({ saved: [job(1)], targets: [{ ...target, enabled: false }] })(query()).items[0].history.targetStatus, 'disabled');
});

const cliJob = (n, changes = {}) => job(n, { operation: { kind: 'command', command: 'printf history', agentCliContract: AGENT_CLI_CONTRACT,
  agentCliTargetId: target.id, agentCliTargetRevision: target.revision, agentCliProfile: target.writeProfile, agentCliProvider: agentCliProviders()[0].id, ...changes } });

test('HIST-CLI 도구 장부는 현재 활성 대상·연결 버전·프로필·공급자 범위를 유지한다', () => {
  const cli = [cliJob(1), cliJob(2, { agentCliTargetRevision: 'b'.repeat(64) }), cliJob(3, { agentCliProfile: 'other' }),
    cliJob(4, { agentCliProvider: 'unknown-provider' }), cliJob(5, { agentCliTargetId: 'removed' })];
  let verifies = 0;
  const value = history({ cli, verifyCliTarget: () => { verifies++; } })(query());
  assert.deepEqual(value.items.map(value => value.id), [id(1)]);
  assert.equal(value.items[0].history.storage, 'cli');
  assert.equal(verifies, 1);
  assert.equal(value.coverage.cliCurrentBindingOnly, true);
  assert.deepEqual(history({ cli, targets: [{ ...target, enabled: false }] })(query()).items, []);
  const unavailable = history({ cli, verifyCliTarget: () => { throw Error('synthetic configuration changed'); } })(query());
  assert.deepEqual(unavailable.items, []);
  assert.equal(unavailable.coverage.metadataIncomplete, true);
});

test('HIST-COVERAGE 잘못된 관측 메타데이터를 완전한 이력으로 표시하지 않는다', () => {
  const value = history({ saved: [job(1, { state: 'future-unknown' }), job(2, { createdAt: null })], commandJournal: undefined, cliJournal: undefined })(query());
  assert.equal(value.coverage.commandJournal, false);
  assert.equal(value.coverage.cliJournal, false);
  const invalid = history({ saved: [job(1, { state: 'future-unknown' })] })(query());
  assert.deepEqual(invalid.items, []);
  assert.equal(invalid.coverage.metadataIncomplete, true);
});

test('HIST-BYTES 응답 전체 바이트 상한에서 부분 페이지를 반환하고 단일 거대 행을 거절한다', () => {
  const command = '가'.repeat(9000), saved = Array.from({ length: 20 }, (_, n) => job(n + 1, { command, operation: { kind: 'command', command } }));
  const read = history({ saved }), ids = [];
  let cursor;
  do {
    const value = read(query(cursor ? { cursor } : {}));
    assert.ok(Buffer.byteLength(JSON.stringify(value), 'utf8') <= HISTORY_RESPONSE_BYTES);
    assert.ok(value.items.length > 0 && value.items.length < 20);
    ids.push(...value.items.map(value => value.id)); cursor = value.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, Array.from({ length: 20 }, (_, n) => id(20 - n)));
  throwsCode(() => history({ saved: [job(1, { operation: { kind: 'command', command: 'printf history', extra: 'x'.repeat(HISTORY_RESPONSE_BYTES) } })] })(query()), 'HISTORY_ENTRY_TOO_LARGE', 413);
});

test('HIST-HYDRATE 후보 메타데이터만 순회하고 반환하는 장부 행만 본문으로 읽는다', () => {
  const saved = Array.from({ length: 100 }, (_, n) => job(n + 1)), readBodies = [];
  const port = { ...journal(saved), historyJob(key) { readBodies.push(key); return structuredClone(saved.find(value => value.id === key)); } };
  const before = JSON.stringify(saved);
  const value = history({ commandJournal: port })(query());
  assert.equal(value.items.length, 20);
  assert.deepEqual(readBodies, Array.from({ length: 20 }, (_, n) => id(100 - n)));
  assert.equal(JSON.stringify(saved), before);
});

async function storageFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'retained-history-'));
  t.after(async () => { assert.ok(root.startsWith(join(tmpdir(), 'retained-history-'))); await rm(root, { recursive: true, force: true }); });
  return root;
}

test('HIST-SQL 기존 명령·도구 장부 조회는 스키마·내용을 바꾸지 않으며 비활성 장부에서도 읽는다', async t => {
  const root = await storageFixture(t), command = createCommandState(root), cli = createAgentCliState(root);
  try {
    command.insert(job(1), 'synthetic-history-1', 'b'.repeat(64));
    cli.insert(cliJob(2), 'agent-cli:synthetic-history-2', 'c'.repeat(64));
    const beforeCommand = command.preservationRows(), beforeCli = cli.preservationRows();
    const value = history({ commandJournal: command, cliJournal: cli })(query());
    assert.deepEqual(value.items.map(value => value.id), [id(2), id(1)]);
    assert.deepEqual(command.preservationRows(), beforeCommand);
    assert.deepEqual(cli.preservationRows(), beforeCli);
  } finally { command.close(); cli.close(); }
  const path = join(root, 'command-automation.sqlite'), before = await readFile(path), files = await readdir(root), dormant = openDormantCommandState(root);
  try { assert.equal(history({ commandJournal: dormant, cliJournal: undefined })(query()).items[0].id, id(1)); }
  finally { dormant.close(); }
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await readdir(root), files);
});

test('HIST-ABSENT  없는 비활성 장부를 만들지 않고 과도한 저장 본문을 읽지 않는다', async t => {
  const root = await storageFixture(t);
  assert.equal(openDormantCommandState(root), undefined);
  assert.deepEqual(await readdir(root), []);
  const state = createCommandState(root);
  state.insert(job(1), 'synthetic-large-1', 'b'.repeat(64)); state.close();
  const db = new DatabaseSync(join(root, 'command-automation.sqlite'));
  try { db.prepare('UPDATE requests SET body=? WHERE id=?').run(JSON.stringify({ ...job(1), extra: 'x'.repeat(600000) }), id(1)); }
  finally { db.close(); }
  const dormant = openDormantCommandState(root);
  try { throwsCode(() => history({ commandJournal: dormant })(query()), 'HISTORY_ENTRY_TOO_LARGE', 413); }
  finally { dormant.close(); }
});

test('HIST-AUTH 기존 관리자 인증·브라우저 세션·출처를 보존하고 새 문서 경로를 분류한다', async () => {
  const options = { adminAccess: { mode: 'token' }, adminToken: 'synthetic-token', adminOrigin: 'https://admin.example' };
  const request = (url = '/api/history', headers = {}, method = 'GET') => ({ url, method, headers });
  assert.equal((await authorizeAdminRequest(request(), options)).status, 401);
  assert.equal((await authorizeAdminRequest(request('/api/history', { authorization: 'Bearer synthetic-token' }), options)).allowed, true);
  assert.equal((await authorizeAdminRequest(request('/api/history', { authorization: 'Bearer synthetic-token', origin: 'https://other.example' }), options)).status, 403);
  const access = { ...options, adminAccess: { mode: 'access', identity: async () => ({ id: 'synthetic-admin' }) }, browserSessions: { authenticated: () => false } };
  assert.equal((await authorizeAdminRequest(request(), access)).status, 401);
  for (const path of ['/settings', '/bridge', '/preferences', '/servers']) assert.deepEqual(await authorizeAdminRequest(request(path), options), { allowed: true, routeKind: 'static' });
});

// OB-COST·OB-READONLY·OB-BOUNDS의 실제 HTTP 비교 계측 계획이다.
// 기준 75c4dfd의 /api/requests 처리행, queue.listAll/get, target-router, presentJob은
// b1612ab와 같다(git show와 해당 파일 diff로 확인). 같은 앱·같은 N개 복원 자료를 사용한다.
// 기존 조회는 전체 큐, 보관 조회는 첫 20개이므로 속도 개선이나 같은 기능의 비교를 주장하지 않는다.
// seed·기동·검증·JSON 해석은 지연 측정 밖이다. 지연은 응답 본문을 모두 읽을 때까지다.
// RSS/heap은 서버·클라이언트가 같은 프로세스인 전후 관측값이며 호출별 최고점은 아니다.
// 비교 경로의 순서를 번갈아 쓰며 강제 GC·인위적 배수 문턱을 넣지 않는다.
// 독립 기대값: N개 보관 행 불변, 추가 대기 요청 1개, 보관 첫 페이지 20개,
// 읽기만으로 감사·실행 0회, 함께 보낸 승인은 202 후 실행 1회·완료한다.
// 실행: 지정 시험 환경에서 node --test --test-name-pattern=HIST-MEASURE test/retained-history.test.mjs
// 로컬 제품 시험·표적 변이는 미실행이며 원시 숫자는 node:test 진단 JSON으로 남긴다.
const memorySample = () => {
  const { rss, heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage();
  return { rssBytes: rss, heapUsedBytes: heapUsed, heapTotalBytes: heapTotal, externalBytes: external, arrayBufferBytes: arrayBuffers };
};
const sampleSummary = samples => {
  const sorted = samples.map(sample => sample.elapsedMs).sort((a, b) => a - b);
  return { repetitions: samples.length, sampleMedianMs: sorted[Math.ceil(sorted.length * 0.5) - 1], sampleP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], sampleMaxMs: sorted.at(-1),
    observedMaxRssBytes: Math.max(...samples.flatMap(sample => [sample.before.rssBytes, sample.after.rssBytes])),
    observedMaxHeapUsedBytes: Math.max(...samples.flatMap(sample => [sample.before.heapUsedBytes, sample.after.heapUsedBytes])) };
};

for (const records of [100, 1000, 10000]) test('HIST-MEASURE 기존 조회·보관 조회와 동시 승인 응답 계측 '+records, { timeout: 120000 }, async t => {
  const root = await storageFixture(t), createdAt = Date.now() - 1000;
  const fixtureJob = (key, state = 'completed') => ({ id: key, kind: 'command', command: 'printf history-measure', operation: { kind: 'command', command: 'printf history-measure' },
    targetId: 'default', profile: 'aws-local', commandClass: 'privileged', target: 'fixture@127.0.0.1:22', state, createdAt,
    expiresAt: createdAt + 600000, ...(state === 'completed' ? { finishedAt: createdAt + 1 } : {}) });
  const retained = Array.from({ length: records }, (_, index) => fixtureJob(id(index + 1)));
  // 기존 생성자가 만든 스키마에 한 트랜잭션으로 합성 자료만 넣는다. seed 비용은 측정하지 않는다.
  createCommandState(root).close();
  const db = new DatabaseSync(join(root, 'command-automation.sqlite'));
  try {
    db.exec('BEGIN'); const insert = db.prepare('INSERT INTO requests VALUES (?,?,?,?)');
    for (const value of retained) insert.run(value.id, null, 'b'.repeat(64), JSON.stringify(value));
    db.exec('COMMIT');
  } finally { db.close(); }
  let app, executions = 0, audits = 0, release = () => {}, executionGate;
  try {
    app = await createApplication({ registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'fixture', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
      classify: () => ({ class: 'privileged' }), executeCommand: async () => { executions++; await executionGate; return { failed: false, texts: [] }; }, audit: () => { audits++; },
      transferRoot: root, uiHtml: '<html></html>', env: { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-admin', BRIDGE_ADMIN_ORIGIN: 'https://example.test', BRIDGE_UI_TICKET_KEY: 'd'.repeat(64) } });
    const queue = app.targets.select('default').queue;
    // 승인 서비스의 정상 복원 포트를 사용한다. 생성·입장 상한 변경은 시험 범위가 아니다.
    for (const value of retained) queue.restore(value);
    await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:'+app.adminHttp.address().port, headers = { Authorization: 'Bearer fixture-admin' };
    const databasePath = join(root, 'command-automation.sqlite'), databaseBefore = hash(await readFile(databasePath));
    const retainedSnapshot = () => hash(JSON.stringify(retained.map(value => queue.jobs.get(value.id))));
    const retainedBefore = retainedSnapshot(), filesBefore = await readdir(root);
    let pendingId, sequence = 0;
    const installPending = () => {
      if (pendingId) queue.jobs.delete(pendingId);
      pendingId = id(1000000 + sequence++); queue.restore(fixtureJob(pendingId, 'pending'));
      executionGate = new Promise(resolve => { release = resolve; });
    };
    const requestSample = async (path, approve = false) => {
      const before = memorySample(), startedMs = performance.now();
      const response = await fetch(base+path, { method: approve ? 'POST' : 'GET', headers: { ...headers, ...(approve ? { Origin: 'https://example.test', Prefer: 'respond-async' } : {}) }, signal: AbortSignal.timeout(30000) });
      const bytes = Buffer.from(await response.arrayBuffer()), finishedMs = performance.now(), after = memorySample();
      const sample = { startedMs, finishedMs, elapsedMs: finishedMs - startedMs, responseBytes: bytes.length, status: response.status, before, after };
      assert.equal(response.status, approve ? 202 : 200);
      const value = JSON.parse(bytes.toString('utf8'));
      if (approve) { assert.equal(value.id, pendingId); assert.equal(value.state, 'running'); }
      else if (path === '/api/requests') assert.equal(value.length, records + 1);
      else { assert.equal(value.items.length, 20); assert.ok(sample.responseBytes <= HISTORY_RESPONSE_BYTES); assert.equal(value.coverage.snapshot, false); }
      return sample;
    };
    installPending();
    const requests = [], history = [];
    for (let index = 0; index < 7; index++) for (const path of index % 2 ? ['/api/history', '/api/requests'] : ['/api/requests', '/api/history']) {
      const beforeAudits = audits, beforeExecutions = executions;
      (path === '/api/requests' ? requests : history).push(await requestSample(path));
      assert.equal(audits, beforeAudits); assert.equal(executions, beforeExecutions);
    }
    assert.equal(retainedSnapshot(), retainedBefore); assert.equal(hash(await readFile(databasePath)), databaseBefore);
    assert.deepEqual(await readdir(root), filesBefore);
    const approval = [], requestsWithApproval = [], historyWithApproval = [];
    const approveSample = async path => {
      installPending(); const executionBefore = executions, auditBefore = audits;
      let read, accepted;
      try {
        // 두 fetch를 기다림 없이 함께 보낸다. 단일 서버 이벤트 루프의 대기 영향도 응답에 포함한다.
        const reading = path ? requestSample(path) : undefined;
        const approving = requestSample('/api/'+pendingId+'/approve', true);
        [read, accepted] = await Promise.all([reading, approving]);
      } finally { release(); }
      await app.queue.wait(pendingId);
      assert.equal(queue.jobs.get(pendingId).state, 'completed'); assert.equal(executions, executionBefore + 1); assert.equal(audits, auditBefore + 2);
      assert.equal(retainedSnapshot(), retainedBefore);
      if (!path) return accepted;
      const inFlightOverlap = Number(read.startedMs <= accepted.finishedMs && accepted.startedMs <= read.finishedMs);
      assert.equal(inFlightOverlap, 1, '조회와 승인 HTTP 요청의 대기 구간이 겹쳐야 한다');
      return { read, approval: accepted, inFlightOverlap };
    };
    for (let index = 0; index < 3; index++) {
      approval.push(await approveSample());
      for (const path of index % 2 ? ['/api/history', '/api/requests'] : ['/api/requests', '/api/history']) {
        (path === '/api/requests' ? requestsWithApproval : historyWithApproval).push(await approveSample(path));
      }
    }
    assert.equal(hash(await readFile(databasePath)), databaseBefore);
    // 원문·토큰·요청 식별자를 출력하지 않는다. 표본 상위값은 모집단 지연 보장이 아니다.
    t.diagnostic(JSON.stringify({ historyMeasurement: 1, retainedRecords: records, pendingRecords: 1, sameProcessClientAndServer: 1,
      requests: { samples: requests, summary: sampleSummary(requests) }, history: { samples: history, summary: sampleSummary(history) },
      approvalAlone: { samples: approval, summary: sampleSummary(approval) },
      requestsWithApproval: { samples: requestsWithApproval, approvalSummary: sampleSummary(requestsWithApproval.map(value => value.approval)) },
      historyWithApproval: { samples: historyWithApproval, approvalSummary: sampleSummary(historyWithApproval.map(value => value.approval)) },
      retainedUnchanged: 1, databaseUnchanged: 1, executions, audits }));
  } finally { release(); await app?.close(); }
});
