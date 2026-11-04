import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

export const OPERATION_STATES = Object.freeze(['accepted', 'queued', 'starting', 'running', 'terminating', 'completed', 'failed', 'cancelled', 'expired', 'denied', 'unknown']);
export const LEGACY_IMPORT_BATCH_SIZE = 128;
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
const validateRecord = record => {
  for (const key of ['requestKey', 'owner', 'targetId', 'targetRevision', 'kind']) required(record?.[key], key.toUpperCase());
  if (!record.input || typeof record.input !== 'object' || Array.isArray(record.input)) throw operationStoreError('INVALID_OPERATION_INPUT');
};
const operationContract = record => canonical({ owner: record.owner, targetId: record.targetId, targetRevision: record.targetRevision,
  kind: record.kind, input: record.input, inputDigest: record.inputDigest ?? null,
  conflictKey: record.conflictKey ?? null, generation: record.generation ?? null,
  expiresAt: record.expiresAt ?? null, deadline: record.deadline ?? null,
  policyRevision: record.policyRevision ?? null, approval: record.approval ?? null });
const legacyRecord = (job, { source, requestKey, digest }) => ({ id: job.id, requestKey, owner: job.owner ?? 'legacy-owner',
  targetId: job.targetId ?? job.target ?? 'legacy-unbound', targetRevision: job.targetRevision ?? 'legacy-unbound',
  kind: job.kind ?? job.operation?.kind ?? 'command', input: job.operation ?? job.input ?? {},
  inputDigest: digest ?? null, createdAt: job.createdAt, outputRef: job.outputRef ?? { requestId: job.id },
  legacy: { source, digest: digest ?? null, original: structuredClone(job) } });

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
      CREATE INDEX IF NOT EXISTS operations_state_identity ON operations(state,id);
      CREATE TABLE IF NOT EXISTS operation_events (sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL,
        version INTEGER NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE(operation_id,version));
      CREATE TABLE IF NOT EXISTS operation_legacy_budget (operation_id TEXT PRIMARY KEY, source TEXT NOT NULL,
        original_bytes INTEGER NOT NULL, reserved_bytes INTEGER NOT NULL);`);
    const versions = db.prepare('SELECT version FROM operation_schema').all();
    if (versions.length !== 1 || versions[0].version !== 1) throw operationStoreError('UNSUPPORTED_OPERATION_SCHEMA');
  } catch (error) { db.close(); throw error; }
  const usage = () => db.prepare('SELECT count(*) AS count,coalesce(sum(length(CAST(body AS BLOB))+length(CAST(contract AS BLOB))),0) AS bytes FROM operations').get();
  // This connection holds SQLite's exclusive lock until close. Keep exact totals
  // here instead of rescanning every prior body for every imported row.
  let budget = { ...usage(), events: db.prepare('SELECT count(*) AS count FROM operation_events').get().count };
  let legacyRows = 0, legacyBytes = 0, legacySources = new Map();
  let legacyCredit = db.prepare('SELECT coalesce(sum(min(length(CAST(o.body AS BLOB))+length(CAST(o.contract AS BLOB)),b.reserved_bytes)),0) AS bytes FROM operations o JOIN operation_legacy_budget b ON b.operation_id=o.id').get().bytes;
  for (const row of db.prepare('SELECT source,count(*) AS count,sum(original_bytes) AS originalBytes,sum(reserved_bytes) AS bytes FROM operation_legacy_budget GROUP BY source').all()) {
    if (typeof row.source !== 'string' || !row.source || row.source.length > 512 || row.count > 10000 || row.originalBytes > 64 * 1024 * 1024 || row.originalBytes < 0 || row.bytes < 0) { db.close(); throw operationStoreError('LEGACY_HISTORY_CAPACITY'); }
    legacySources.set(row.source, { count: row.count, originalBytes: row.originalBytes }); legacyRows += row.count; legacyBytes += row.bytes;
  }
  if (legacySources.size > 2) { db.close(); throw operationStoreError('LEGACY_HISTORY_CAPACITY'); }
  let poisoned = false;
  const transaction = fn => {
    if (poisoned) throw operationStoreError('OPERATION_TRANSACTION_UNCERTAIN');
    db.exec('BEGIN IMMEDIATE');
    const before = { budget: { ...budget }, legacyRows, legacyBytes, legacyCredit, legacySources: new Map([...legacySources].map(([key, value]) => [key, { ...value }])) };
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) {
      try { db.exec('ROLLBACK'); }
      catch {
        poisoned = true;
        try { db.close(); } catch { /* The poisoned connection is never reused. */ }
        throw Object.assign(operationStoreError('OPERATION_TRANSACTION_UNCERTAIN'), { cause: error });
      } finally { ({ budget, legacyRows, legacyBytes, legacyCredit, legacySources } = before); }
      throw error;
    }
  };
  const get = id => { const row = db.prepare('SELECT body FROM operations WHERE id=?').get(id); return row ? JSON.parse(row.body) : null; };
  const checkBudget = (extraBytes = 0, extraRows = 0, extraEvents = 1, creditDelta = 0) => {
    if (budget.count + extraRows > maxRows + legacyRows || budget.bytes + extraBytes - legacyCredit - creditDelta > maxBytes
      || budget.events + extraEvents > (maxRows + legacyRows) * 64) throw operationStoreError('OPERATION_CAPACITY');
  };
  const reserveLegacy = (job, bytes) => {
    const source = required(job.legacy?.source, 'LEGACY_SOURCE'), originalBytes = Buffer.byteLength(JSON.stringify(job.legacy.original));
    const previous = legacySources.get(source) ?? { count: 0, originalBytes: 0 };
    if (job.legacy.original?.id !== job.id || originalBytes > 256 * 1024) throw operationStoreError('OPERATION_TOO_LARGE');
    if (previous.count >= 10000 || previous.originalBytes + originalBytes > 64 * 1024 * 1024 || (!legacySources.has(source) && legacySources.size >= 2)) throw operationStoreError('LEGACY_HISTORY_CAPACITY');
    db.prepare('INSERT INTO operation_legacy_budget VALUES(?,?,?,?)').run(job.id, source, originalBytes, bytes);
    legacyRows++; legacyBytes += bytes; legacyCredit += bytes;
    legacySources.set(source, { count: previous.count + 1, originalBytes: previous.originalBytes + originalBytes });
  };
  // Earlier interrupted imports already contain exact legacy evidence. Add their
  // allowance atomically without rewriting those rows, versions or event history.
  try {
    transaction(() => {
      for (const row of db.prepare('SELECT o.*,length(CAST(o.body AS BLOB))+length(CAST(o.contract AS BLOB)) AS bytes FROM operations o LEFT JOIN operation_legacy_budget b ON b.operation_id=o.id WHERE b.operation_id IS NULL').iterate()) {
        const job = JSON.parse(row.body);
        if (job.recoveryReason !== 'legacy_import' || typeof job.legacy?.source !== 'string' || job.legacy?.original?.id !== job.id) continue;
        const original = job.legacy.original, state = terminal.has(original.state) ? original.state : 'unknown';
        const record = legacyRecord(original, { source: job.legacy.source, requestKey: job.requestKey, digest: job.legacy.digest });
        try { validateRecord(record); required(record.id, 'OPERATION_ID'); }
        catch { throw operationStoreError('INVALID_LEGACY_IMPORT_BASELINE'); }
        const contract = operationContract(record), digest = createHash('sha256').update(contract).digest('hex');
        const expected = { ...record, state, version: 2, contractDigest: digest, createdAt: original.createdAt ?? job.acceptedAt,
          acceptedAt: job.acceptedAt, updatedAt: job.acceptedAt, result: original.result, finishedAt: original.finishedAt ?? job.finishedAt,
          requiresReconciliation: state === 'unknown', recoveryReason: 'legacy_import' };
        if (!Number.isSafeInteger(job.acceptedAt) || (original.finishedAt == null && (!Number.isSafeInteger(job.finishedAt) || job.finishedAt < job.acceptedAt))
          || canonical(job) !== canonical(expected) || row.contract !== contract || row.digest !== digest || row.id !== job.id
          || row.request_key !== job.requestKey || row.version !== 2 || row.state !== state || row.target_id !== job.targetId
          || row.target_revision !== job.targetRevision || row.conflict_key !== null || row.ready_sequence !== null) throw operationStoreError('INVALID_LEGACY_IMPORT_BASELINE');
        reserveLegacy(job, row.bytes);
      }
    });
  } catch (error) { if (!poisoned) db.close(); throw error; }
  const save = (job, previousVersion) => {
    const body = JSON.stringify(job);
    const previous = db.prepare('SELECT length(CAST(o.body AS BLOB)) AS bytes,length(CAST(o.body AS BLOB))+length(CAST(o.contract AS BLOB)) AS totalBytes,coalesce(b.reserved_bytes,0) AS retainedBytes FROM operations o LEFT JOIN operation_legacy_budget b ON b.operation_id=o.id WHERE o.id=?').get(job.id);
    if (Buffer.byteLength(body) > 256 * 1024 + (previous?.retainedBytes ?? 0)) throw operationStoreError('OPERATION_TOO_LARGE');
    const delta = Buffer.byteLength(body) - (previous?.bytes ?? 0);
    const creditDelta = Math.min((previous?.totalBytes ?? 0) + delta, previous?.retainedBytes ?? 0) - Math.min(previous?.totalBytes ?? 0, previous?.retainedBytes ?? 0);
    checkBudget(delta, 0, 1, creditDelta);
    const result = db.prepare('UPDATE operations SET body=?,version=?,state=?,ready_sequence=? WHERE id=? AND version=?')
      .run(body, job.version, job.state, job.readySequence ?? null, job.id, previousVersion);
    if (result.changes !== 1) throw operationStoreError('OPERATION_VERSION_CONFLICT');
    db.prepare('INSERT INTO operation_events(operation_id,version,state,at) VALUES (?,?,?,?)').run(job.id, job.version, job.state, now());
    budget.bytes += delta; legacyCredit += creditDelta; budget.events++;
    return job;
  };
  const update = (id, patch, { expectedVersion, expectedState } = {}) => transaction(() => {
    const job = get(id);
    if (!job) throw operationStoreError('OPERATION_NOT_FOUND');
    if ((expectedVersion !== undefined && job.version !== expectedVersion) || (expectedState !== undefined && ![].concat(expectedState).includes(job.state))) throw operationStoreError('OPERATION_VERSION_CONFLICT');
    for (const key of ['id', 'requestKey', 'owner', 'targetId', 'targetRevision', 'kind', 'input', 'inputDigest', 'contractDigest', 'createdAt', 'conflictKey', 'generation', 'expiresAt', 'deadline', 'policyRevision', 'approval', 'version', 'legacy']) {
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
  const insert = (record, legacyOutcome) => {
    validateRecord(record);
    // Preserve exact primitive strings/bytes: canonicalization only sorts JSON object keys.
    const contract = operationContract(record), digest = createHash('sha256').update(contract).digest('hex');
    if (!legacyOutcome && Buffer.byteLength(contract) > 256 * 1024) throw operationStoreError('OPERATION_TOO_LARGE');
    const previous = db.prepare('SELECT digest,contract,body FROM operations WHERE request_key=?').get(record.requestKey);
    if (previous) {
      if (previous.digest !== digest || previous.contract !== contract) throw operationStoreError('OPERATION_KEY_CONFLICT');
      return JSON.parse(previous.body);
    }
    const at = now(), id = record.id ?? randomBytes(24).toString('hex'); required(id, 'OPERATION_ID');
    const job = { ...structuredClone(record), id, state: 'accepted', version: 1, contractDigest: digest, createdAt: record.createdAt ?? at, acceptedAt: at, updatedAt: at, ...legacyOutcome };
    if (legacyOutcome) job.finishedAt ??= now();
    const body = JSON.stringify(job), bytes = Buffer.byteLength(contract) + Buffer.byteLength(body);
    if (legacyOutcome) reserveLegacy(job, bytes);
    checkBudget(bytes, 1, legacyOutcome ? 2 : 1);
    db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, record.requestKey, digest, contract, job.version, job.state, job.targetId, job.targetRevision, job.conflictKey ?? null, null, body);
    db.prepare('INSERT INTO operation_events(operation_id,version,state,at) VALUES (?,?,?,?)').run(id, 1, 'accepted', at);
    if (legacyOutcome) db.prepare('INSERT INTO operation_events(operation_id,version,state,at) VALUES (?,?,?,?)').run(id, 2, job.state, now());
    budget.count++; budget.bytes += bytes; budget.events += legacyOutcome ? 2 : 1;
    return legacyOutcome ? JSON.parse(body) : job;
  };
  const accept = record => transaction(() => insert(record));
  const importLegacy = (job, { source, requestKey, digest, requireExisting = false } = {}) => {
    required(source, 'LEGACY_SOURCE');
    const key = requestKey ?? `legacy:${source}:${job.id}`;
    const existing = api.find(key);
    if (existing) {
      if (existing.job.id !== job.id || existing.job.legacy?.source !== source || canonical(existing.job.legacy?.original) !== canonical(job) || existing.job.legacy?.digest !== (digest ?? null)) throw operationStoreError('OPERATION_KEY_CONFLICT');
      return existing.job;
    }
    if (get(job.id)) throw operationStoreError('OPERATION_KEY_CONFLICT');
    if (requireExisting) throw operationStoreError('LEGACY_MIGRATION_RECORD_MISSING');
    const state = terminal.has(job.state) ? job.state : 'unknown';
    return insert(legacyRecord(job, { source, requestKey: key, digest }),
    { state, version: 2, result: job.result, finishedAt: job.finishedAt, requiresReconciliation: state === 'unknown', recoveryReason: 'legacy_import' });
  };
  const api = {
    filePath, accept, get, update,
    // Private evidence port: SELECT only on the already exclusive service connection.
    // Consume synchronously while admission/dispatch are fenced; never expose these rows.
    preservationRows() {
      if (poisoned) throw operationStoreError('OPERATION_TRANSACTION_UNCERTAIN');
      if (db.prepare("SELECT 1 FROM operations WHERE state NOT IN ('completed','failed','cancelled','expired','denied','unknown') LIMIT 1").get()) throw operationStoreError('OPERATION_PRESERVATION_NOT_IDLE');
      return {
        schema: { definitions: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(), versions: db.prepare('SELECT * FROM operation_schema ORDER BY version').all() },
        operations: db.prepare('SELECT * FROM operations ORDER BY id').iterate(),
        events: db.prepare('SELECT * FROM operation_events ORDER BY sequence').iterate(),
        legacyBudget: db.prepare('SELECT * FROM operation_legacy_budget ORDER BY operation_id').iterate(),
      };
    },
    find(requestKey) { const row = db.prepare('SELECT digest,body FROM operations WHERE request_key=?').get(requestKey); return row ? { digest: row.digest, job: JSON.parse(row.body) } : null; },
    countStates({ includeLegacy = true } = {}) {
      if (typeof includeLegacy !== 'boolean') throw operationStoreError('INVALID_OPERATION_FILTER');
      const counts = Object.fromEntries(OPERATION_STATES.map(state => [state, 0]));
      const where = includeLegacy ? '' : 'WHERE id NOT IN (SELECT operation_id FROM operation_legacy_budget)';
      for (const row of db.prepare(`SELECT state,count(*) AS count FROM operations ${where} GROUP BY state`).all()) counts[row.state] = row.count;
      return counts;
    },
    list({ states, state, targetId, limit = maxRows + legacyRows } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxRows + legacyRows) throw operationStoreError('INVALID_OPERATION_LIMIT');
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
        const unknown = db.prepare("SELECT count(*) AS n FROM operations WHERE state='unknown' AND id NOT IN (SELECT operation_id FROM operation_legacy_budget)").get().n;
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
    importLegacy(job, options) { return transaction(() => importLegacy(job, options)); },
    importLegacyBatch(rows, { source, requireExisting = false } = {}) {
      if (!Array.isArray(rows) || rows.length > LEGACY_IMPORT_BATCH_SIZE || typeof requireExisting !== 'boolean') throw operationStoreError('INVALID_LEGACY_BATCH');
      return transaction(() => rows.map(({ job, digest, requestKey }) => importLegacy(job, { source, digest, requestKey, requireExisting })));
    },
    legacyUsage() { return { count: legacyRows, bytes: legacyBytes, sources: [...legacySources].sort(([a], [b]) => a.localeCompare(b)).map(([source, value]) => ({ source, ...value })) }; },
    events(id) { return db.prepare('SELECT sequence,version,state,at FROM operation_events WHERE operation_id=? ORDER BY sequence').all(id); },
    usage, close() { if (!poisoned) db.close(); },
  };
  return api;
}
