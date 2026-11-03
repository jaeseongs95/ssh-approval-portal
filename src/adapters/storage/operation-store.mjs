import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

export const OPERATION_STATES = Object.freeze(['accepted', 'queued', 'starting', 'running', 'terminating', 'completed', 'failed', 'cancelled', 'expired', 'denied', 'unknown']);
const terminal = new Set(['completed', 'failed', 'cancelled', 'expired', 'denied', 'unknown']);
const active = ['starting', 'running', 'terminating'];
const transitions = {
  accepted: ['queued', 'cancelled', 'expired', 'denied', 'failed', 'unknown'],
  queued: ['starting', 'cancelled', 'expired', 'denied', 'failed', 'unknown'],
  starting: ['running', 'terminating', 'cancelled', 'expired', 'completed', 'failed', 'unknown'],
  running: ['terminating', 'cancelled', 'completed', 'failed', 'unknown'],
  terminating: ['cancelled', 'completed', 'failed', 'unknown'],
  unknown: ['completed', 'failed', 'cancelled'],
};
const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});
export function operationStoreError(code) { return Object.assign(Error(code), { code, accepted: false, retryable: code === 'OPERATION_CAPACITY' }); }
const required = (value, name) => { if (typeof value !== 'string' || !value || value.length > 512) throw operationStoreError(`INVALID_${name}`); return value; };

/** One durable intent/outcome journal shared by every operation kind. No executor lives here. */
export function createOperationStore(rootOrOptions) {
  const options = typeof rootOrOptions === 'string' ? { filePath: join(rootOrOptions, 'operations.sqlite') } : rootOrOptions;
  const { filePath, now = Date.now, maxRows = 10000, maxBytes = 64 * 1024 * 1024 } = options ?? {};
  required(filePath, 'OPERATION_PATH');
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw operationStoreError('INVALID_OPERATION_BUDGET');
  try { closeSync(openSync(filePath, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) throw operationStoreError('UNSAFE_OPERATION_STORE');
  const db = new DatabaseSync(filePath);
  try {
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='operation_schema'").get()) {
      const versions = db.prepare('SELECT version FROM operation_schema').all();
      if (versions.length !== 1 || versions[0].version !== 1) throw operationStoreError('UNSUPPORTED_OPERATION_SCHEMA');
    }
    // A second bridge fails closed; claims still use a transactional version compare.
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;
      PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;
      CREATE TABLE IF NOT EXISTS operation_schema (version INTEGER NOT NULL);
      INSERT INTO operation_schema SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM operation_schema);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL,
        digest TEXT NOT NULL, contract TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL,
        target_id TEXT NOT NULL, target_revision TEXT NOT NULL, conflict_key TEXT, ready_sequence INTEGER, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS operations_ready ON operations(state,ready_sequence);
      CREATE TABLE IF NOT EXISTS operation_events (sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL,
        version INTEGER NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE(operation_id,version));`);
    const versions = db.prepare('SELECT version FROM operation_schema').all();
    if (versions.length !== 1 || versions[0].version !== 1) throw operationStoreError('UNSUPPORTED_OPERATION_SCHEMA');
  } catch (error) { db.close(); throw error; }
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const get = id => { const row = db.prepare('SELECT body FROM operations WHERE id=?').get(id); return row ? JSON.parse(row.body) : null; };
  const usage = () => db.prepare('SELECT count(*) AS count,coalesce(sum(length(CAST(body AS BLOB))+length(CAST(contract AS BLOB))),0) AS bytes FROM operations').get();
  const checkBudget = (extraBytes = 0, extraRows = 0) => {
    const value = usage();
    if (value.count + extraRows > maxRows || value.bytes + extraBytes > maxBytes
      || db.prepare('SELECT count(*) AS count FROM operation_events').get().count >= maxRows * 64) throw operationStoreError('OPERATION_CAPACITY');
  };
  const save = (job, previousVersion) => {
    const body = JSON.stringify(job);
    if (Buffer.byteLength(body) > 256 * 1024) throw operationStoreError('OPERATION_TOO_LARGE');
    const previous = db.prepare('SELECT length(CAST(body AS BLOB)) AS bytes FROM operations WHERE id=?').get(job.id);
    checkBudget(Math.max(0, Buffer.byteLength(body) - (previous?.bytes ?? 0)));
    const result = db.prepare('UPDATE operations SET body=?,version=?,state=?,ready_sequence=? WHERE id=? AND version=?')
      .run(body, job.version, job.state, job.readySequence ?? null, job.id, previousVersion);
    if (result.changes !== 1) throw operationStoreError('OPERATION_VERSION_CONFLICT');
    db.prepare('INSERT INTO operation_events(operation_id,version,state,at) VALUES (?,?,?,?)').run(job.id, job.version, job.state, now());
    return job;
  };
  const update = (id, patch, { expectedVersion, expectedState } = {}) => transaction(() => {
    const job = get(id);
    if (!job) throw operationStoreError('OPERATION_NOT_FOUND');
    if ((expectedVersion !== undefined && job.version !== expectedVersion) || (expectedState !== undefined && ![].concat(expectedState).includes(job.state))) throw operationStoreError('OPERATION_VERSION_CONFLICT');
    for (const key of ['id', 'requestKey', 'owner', 'targetId', 'targetRevision', 'kind', 'input', 'inputDigest', 'contractDigest', 'createdAt', 'conflictKey', 'generation', 'expiresAt', 'deadline', 'policyRevision', 'approval', 'version']) {
      if (Object.hasOwn(patch, key) && canonical(patch[key]) !== canonical(job[key])) throw operationStoreError('OPERATION_CONTRACT_IMMUTABLE');
    }
    const state = patch.state ?? job.state;
    if (state !== job.state && !transitions[job.state]?.includes(state)) throw operationStoreError('INVALID_OPERATION_TRANSITION');
    const value = { ...job, ...patch, state, version: job.version + 1, updatedAt: now() };
    if (state === 'queued' && job.state !== 'queued') {
      value.readyAt = now(); value.readySequence = db.prepare('SELECT coalesce(max(sequence),0)+1 AS n FROM operation_events').get().n;
    }
    if (terminal.has(state)) value.finishedAt ??= now();
    return save(value, job.version);
  });
  const insert = record => {
    for (const key of ['requestKey', 'owner', 'targetId', 'targetRevision', 'kind']) required(record?.[key], key.toUpperCase());
    if (!record.input || typeof record.input !== 'object' || Array.isArray(record.input)) throw operationStoreError('INVALID_OPERATION_INPUT');
    // Preserve exact primitive strings/bytes: canonicalization only sorts JSON object keys.
    const contractValue = { owner: record.owner, targetId: record.targetId, targetRevision: record.targetRevision,
      kind: record.kind, input: record.input, inputDigest: record.inputDigest ?? null,
      conflictKey: record.conflictKey ?? null, generation: record.generation ?? null,
      expiresAt: record.expiresAt ?? null, deadline: record.deadline ?? null,
      policyRevision: record.policyRevision ?? null, approval: record.approval ?? null };
    const contract = canonical(contractValue), digest = createHash('sha256').update(contract).digest('hex');
    if (Buffer.byteLength(contract) > 256 * 1024) throw operationStoreError('OPERATION_TOO_LARGE');
    const previous = db.prepare('SELECT digest,contract,body FROM operations WHERE request_key=?').get(record.requestKey);
    if (previous) {
      if (previous.digest !== digest || previous.contract !== contract) throw operationStoreError('OPERATION_KEY_CONFLICT');
      return JSON.parse(previous.body);
    }
    const at = now(), id = record.id ?? randomBytes(24).toString('hex'); required(id, 'OPERATION_ID');
    const job = { ...structuredClone(record), id, state: 'accepted', version: 1, contractDigest: digest, createdAt: record.createdAt ?? at, acceptedAt: at, updatedAt: at };
    const body = JSON.stringify(job); checkBudget(Buffer.byteLength(contract) + Buffer.byteLength(body), 1);
    db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, record.requestKey, digest, contract, 1, job.state, job.targetId, job.targetRevision, job.conflictKey ?? null, null, body);
    db.prepare('INSERT INTO operation_events(operation_id,version,state,at) VALUES (?,?,?,?)').run(id, 1, job.state, at);
    return job;
  };
  const accept = record => transaction(() => insert(record));
  const api = {
    filePath, accept, get, update,
    find(requestKey) { const row = db.prepare('SELECT digest,body FROM operations WHERE request_key=?').get(requestKey); return row ? { digest: row.digest, job: JSON.parse(row.body) } : null; },
    list({ states, state, targetId, limit = maxRows } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxRows) throw operationStoreError('INVALID_OPERATION_LIMIT');
      const where = [], args = [], selected = states ?? (state ? [state] : null);
      if (selected) { if (!selected.length || selected.some(value => !OPERATION_STATES.includes(value))) throw operationStoreError('INVALID_OPERATION_STATE'); where.push(`state IN (${selected.map(() => '?').join(',')})`); args.push(...selected); }
      if (targetId !== undefined) { where.push('target_id=?'); args.push(targetId); }
      return db.prepare(`SELECT body FROM operations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY coalesce(ready_sequence,9223372036854775807),rowid LIMIT ?`).all(...args, limit).map(row => JSON.parse(row.body));
    },
    claim(id, { expectedVersion, globalConcurrency = 1, targetConcurrency = 1, unknownBudget = 32 } = {}) {
      return transaction(() => {
        if ([globalConcurrency, targetConcurrency, unknownBudget].some(value => !Number.isSafeInteger(value) || value < 1)) throw operationStoreError('INVALID_OPERATION_CLAIM_LIMIT');
        const job = get(id);
        if (!job || job.state !== 'queued' || (expectedVersion !== undefined && job.version !== expectedVersion)) return null;
        const running = db.prepare("SELECT count(*) AS n FROM operations WHERE state IN ('starting','running','terminating')").get().n;
        const target = db.prepare("SELECT count(*) AS n FROM operations WHERE target_id=? AND state IN ('starting','running','terminating')").get(job.targetId).n;
        const unknown = db.prepare("SELECT count(*) AS n FROM operations WHERE state='unknown'").get().n;
        if (running >= globalConcurrency || target >= targetConcurrency || running + unknown >= unknownBudget) return null;
        if (job.conflictKey && db.prepare("SELECT id FROM operations WHERE state IN ('unknown','starting','running','terminating') AND target_id=? AND target_revision=? AND conflict_key=? LIMIT 1").get(job.targetId, job.targetRevision, job.conflictKey)) return null;
        return save({ ...job, state: 'starting', version: job.version + 1, startedAt: now(), updatedAt: now() }, job.version);
      });
    },
    outcome(id, result) {
      const execution = result?.execution;
      const remote = execution?.remoteState;
      const settled = execution?.phase === 'settled' && execution.cleanupComplete === true;
      const state = !settled || !['not_dispatched', 'exited'].includes(remote) || execution.requiresReconciliation === true ? 'unknown'
        : execution.reason === 'cancel' ? 'cancelled'
        : result.failed || remote !== 'exited' || execution.reason !== 'exit' || execution.exitCode !== 0 ? 'failed' : 'completed';
      return update(id, { state, result, outcomeCertainty: state === 'unknown' ? 'unknown' : remote, requiresReconciliation: state === 'unknown' });
    },
    recover() {
      const recovered = [];
      for (const job of api.list({ states: active })) recovered.push(update(job.id, { state: 'unknown', requiresReconciliation: true, recoveryReason: 'bridge_restart', outcomeCertainty: 'unknown' }, { expectedVersion: job.version }));
      return recovered;
    },
    importLegacy(job, { source, requestKey, digest } = {}) { return transaction(() => {
      required(source, 'LEGACY_SOURCE');
      const key = requestKey ?? `legacy:${source}:${job.id}`;
      const existing = api.find(key);
      if (existing) {
        if (canonical(existing.job.legacy?.original) !== canonical(job) || existing.job.legacy?.digest !== (digest ?? null)) throw operationStoreError('OPERATION_KEY_CONFLICT');
        return existing.job;
      }
      // Legacy running/queued data lacks a durable dispatch authority; retain it as evidence only.
      const value = insert({ id: job.id, requestKey: key, owner: job.owner ?? 'legacy-owner',
        targetId: job.targetId ?? job.target ?? 'legacy-unbound', targetRevision: job.targetRevision ?? 'legacy-unbound',
        kind: job.kind ?? job.operation?.kind ?? 'command', input: job.operation ?? job.input ?? {},
        inputDigest: digest ?? null, createdAt: job.createdAt, outputRef: job.outputRef ?? { requestId: job.id },
        legacy: { source, digest: digest ?? null, original: structuredClone(job) } });
      const state = terminal.has(job.state) ? job.state : 'unknown';
      return save({ ...value, state, version: value.version + 1, result: job.result, finishedAt: job.finishedAt ?? now(),
        requiresReconciliation: state === 'unknown', recoveryReason: 'legacy_import' }, value.version);
    }); },
    events(id) { return db.prepare('SELECT sequence,version,state,at FROM operation_events WHERE operation_id=? ORDER BY sequence').all(id); },
    usage, close() { db.close(); },
  };
  return api;
}
