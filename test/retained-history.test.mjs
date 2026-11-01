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
    cli.insert(cliJob(2), 'synthetic-history-2', 'c'.repeat(64));
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
