import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateOrigin } from '../config/settings.mjs';
import { validateLocalPath } from './local-files.mjs';
import { projectCompletionEvent } from './completion-event.mjs';

const codes = new Set(['COMPLETION_INBOX_INVALID_INPUT', 'COMPLETION_INBOX_INVALID_PATH',
  'COMPLETION_INBOX_UNSAFE_PATH', 'COMPLETION_INBOX_OPEN_FAILED', 'COMPLETION_INBOX_BUSY',
  'COMPLETION_INBOX_STORAGE_FAILED', 'COMPLETION_INBOX_CORRUPT', 'COMPLETION_INBOX_SCHEMA_MISMATCH',
  'COMPLETION_INBOX_CLOSED', 'COMPLETION_INBOX_BINDING_NOT_FOUND', 'COMPLETION_INBOX_INVALID_ORIGIN',
  'COMPLETION_INBOX_EVENT_CONFLICT', 'COMPLETION_INBOX_RECEIPT_NOT_FOUND', 'COMPLETION_INBOX_STALE_CLAIM']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/;
const applicationId = 0x53434d50;

export class CompletionInboxError extends Error {
  constructor(code) {
    const safe = codes.has(code) ? code : 'COMPLETION_INBOX_STORAGE_FAILED';
    super(safe); this.name = 'CompletionInboxError'; this.code = safe;
  }
}
const fail = code => new CompletionInboxError(code);
function sanitize(error, fallback = 'COMPLETION_INBOX_STORAGE_FAILED') {
  if (error instanceof CompletionInboxError) return fail(error.code);
  if (error?.code === 'INVALID_COMPLETION_EVENT') return Object.assign(Error('INVALID_COMPLETION_EVENT'), { code: 'INVALID_COMPLETION_EVENT' });
  if ([5, 6].includes(error?.errcode & 255)) return fail('COMPLETION_INBOX_BUSY');
  if ([11, 26].includes(error?.errcode & 255)) return fail('COMPLETION_INBOX_CORRUPT');
  return fail(fallback);
}
function identifier(value) {
  if (typeof value !== 'string' || !uuid.test(value)) throw fail('COMPLETION_INBOX_INVALID_INPUT');
  return value;
}
function argumentsObject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('COMPLETION_INBOX_INVALID_INPUT');
  return input;
}
function session(input) {
  const { host, sessionId } = argumentsObject(input);
  if (typeof host !== 'string' || !/^[a-z][a-z0-9_-]{0,63}(?![\s\S])/.test(host) ||
      typeof sessionId !== 'string' || !sessionId.length || Buffer.byteLength(sessionId) > 256 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(sessionId)) {
    throw fail('COMPLETION_INBOX_INVALID_INPUT');
  }
  return { host, sessionId };
}
function privateEntry(info, directory = false) {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) {
    throw fail('COMPLETION_INBOX_UNSAFE_PATH');
  }
  // Windows mode bits do not describe ACLs. Keep the caller's profile ACL inheritance;
  // ownership/mode guarantees below apply only where the OS exposes POSIX identities.
  if (typeof process.getuid === 'function' && (info.uid !== process.getuid() || (info.mode & 0o777) !== (directory ? 0o700 : 0o600))) {
    throw fail('COMPLETION_INBOX_UNSAFE_PATH');
  }
}
function checkParents(filePath, allowMissing = false) {
  const parent = dirname(filePath);
  for (let ancestor = parent;; ancestor = dirname(ancestor)) {
    try {
      const info = lstatSync(ancestor);
      if (!info.isDirectory() || info.isSymbolicLink()) throw fail('COMPLETION_INBOX_UNSAFE_PATH');
    } catch (error) { if (!allowMissing || error.code !== 'ENOENT') throw error; }
    if (ancestor === parse(ancestor).root) break;
  }
}
function checkPath(filePath, expected) {
  const parent = dirname(filePath);
  checkParents(filePath);
  privateEntry(lstatSync(parent), true);
  const info = lstatSync(filePath);
  privateEntry(info);
  if (expected && (info.dev !== expected.dev || info.ino !== expected.ino)) throw fail('COMPLETION_INBOX_UNSAFE_PATH');
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try { privateEntry(lstatSync(filePath + suffix)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return info;
}

/** Synchronous, local metadata inbox. No host transport or SSH execution belongs here.
 * The private leaf directory excludes other OS users on POSIX; this is not a same-UID
 * sandbox. On Windows, file checks cannot establish the inherited ACL's exclusivity. */
export function openCompletionInbox(options = {}) {
  let filePath, now;
  try { ({ filePath, now = Date.now } = argumentsObject(options)); }
  catch { throw fail('COMPLETION_INBOX_INVALID_INPUT'); }
  try { validateLocalPath(filePath); }
  catch { throw fail('COMPLETION_INBOX_INVALID_PATH'); }
  if (typeof now !== 'function') throw fail('COMPLETION_INBOX_INVALID_INPUT');
  filePath = resolve(filePath);
  let db, descriptor, expected;
  try {
    checkParents(filePath, true);
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    // Check the parent chain before creating/opening any file through it.
    checkParents(filePath);
    privateEntry(lstatSync(dirname(filePath)), true);
    const flags = constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    try { descriptor = openSync(filePath, flags | constants.O_CREAT | constants.O_EXCL, 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      privateEntry(lstatSync(filePath));
      descriptor = openSync(filePath, flags);
    }
    expected = fstatSync(descriptor); privateEntry(expected); checkPath(filePath, expected);
    db = new DatabaseSync(filePath, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
    checkPath(filePath, expected);
    closeSync(descriptor); descriptor = undefined;
    db.exec('PRAGMA busy_timeout = 100; PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
    db.exec('BEGIN IMMEDIATE');
    try {
      const app = db.prepare('PRAGMA application_id').get().application_id;
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (app !== applicationId && (app !== 0 || version !== 0 || db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get())) {
        throw fail('COMPLETION_INBOX_SCHEMA_MISMATCH');
      }
      if (app === applicationId && ![1, 2].includes(version)) throw fail('COMPLETION_INBOX_SCHEMA_MISMATCH');
      if (app === 0) {
        db.exec(`
          CREATE TABLE completion_bindings (
            binding_id TEXT PRIMARY KEY, host TEXT NOT NULL, session_id TEXT NOT NULL,
            UNIQUE(host, session_id)
          ) STRICT;
          CREATE TABLE completion_events (
            sequence INTEGER PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE,
            binding_id TEXT NOT NULL REFERENCES completion_bindings(binding_id),
            origin TEXT NOT NULL, operation_id TEXT NOT NULL, revision TEXT NOT NULL, payload TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'claimed', 'acknowledged')),
            claim_token TEXT, lease_until INTEGER, attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
            UNIQUE(binding_id, origin, operation_id, revision),
            CHECK((state = 'pending' AND claim_token IS NULL AND lease_until IS NULL AND attempt = 0) OR
                  (state = 'claimed' AND claim_token IS NOT NULL AND lease_until IS NOT NULL AND attempt > 0) OR
                  (state = 'acknowledged' AND claim_token IS NOT NULL AND lease_until IS NULL AND attempt > 0))
          ) STRICT;
          CREATE INDEX completion_claims ON completion_events(binding_id, state, lease_until, sequence);
          PRAGMA application_id = ${applicationId}; PRAGMA user_version = 1;
        `);
      }
      if (version < 2) {
        db.exec(`
          CREATE TABLE completion_waiters (
            binding_id TEXT PRIMARY KEY REFERENCES completion_bindings(binding_id),
            owner_id TEXT, generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
            lease_until INTEGER NOT NULL DEFAULT 0 CHECK(lease_until >= 0),
            ended INTEGER NOT NULL DEFAULT 0 CHECK(ended IN (0, 1)),
            CHECK((owner_id IS NULL AND lease_until = 0) OR (owner_id IS NOT NULL AND lease_until > 0)),
            CHECK(ended = 0 OR owner_id IS NULL)
          ) STRICT;
          INSERT INTO completion_waiters(binding_id) SELECT binding_id FROM completion_bindings;
          PRAGMA user_version = 2;
        `);
      }
      // Additive metadata only: retain schema2 so existing installed hook clients keep reading their inbox.
        db.exec(`CREATE TABLE IF NOT EXISTS completion_watches (
          binding_id TEXT NOT NULL REFERENCES completion_bindings(binding_id), watch_key TEXT NOT NULL,
          owner_token TEXT NOT NULL, lease_until INTEGER NOT NULL CHECK(lease_until >= 0),
          PRIMARY KEY(binding_id, watch_key)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS completion_deferred_watches (
          binding_id TEXT NOT NULL REFERENCES completion_bindings(binding_id),
          origin TEXT NOT NULL, operation_key TEXT NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY(binding_id, origin, operation_key)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS completion_settled_operations (
          binding_id TEXT NOT NULL REFERENCES completion_bindings(binding_id),
          operation_id TEXT NOT NULL,
          PRIMARY KEY(binding_id, operation_id)
        ) STRICT;`);
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    // Rollback journal keeps the metadata local without long-lived WAL sidecars.
    if (db.prepare('PRAGMA journal_mode = DELETE').get().journal_mode !== 'delete') throw fail('COMPLETION_INBOX_OPEN_FAILED');
    db.exec('PRAGMA synchronous = FULL;');
    checkPath(filePath, expected);
  } catch (error) {
    try { if (descriptor !== undefined) closeSync(descriptor); } catch {}
    try { db?.close(); } catch {}
    throw sanitize(error, 'COMPLETION_INBOX_OPEN_FAILED');
  }
  let closed = false;
  function call(action) {
    if (closed) throw fail('COMPLETION_INBOX_CLOSED');
    try { checkPath(filePath, expected); return action(); }
    catch (error) { throw sanitize(error); }
  }
  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }
  function binding(bindingId) {
    identifier(bindingId);
    if (!db.prepare('SELECT 1 FROM completion_bindings WHERE binding_id = ?').get(bindingId)) throw fail('COMPLETION_INBOX_BINDING_NOT_FOUND');
  }
  function timeWithLease(leaseMs) {
    const time = now();
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 600000 ||
        !Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(time + leaseMs)) throw fail('COMPLETION_INBOX_INVALID_INPUT');
    return time;
  }
  function claimMessages(bindingId, { limit = 8, leaseMs = 30000, pendingOnly = false } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || typeof pendingOnly !== 'boolean') throw fail('COMPLETION_INBOX_INVALID_INPUT');
    const time = timeWithLease(leaseMs);
    const rows = db.prepare(`SELECT receipt_id, origin, payload, attempt FROM completion_events WHERE binding_id = ? AND
      ${pendingOnly ? "state = 'pending'" : "(state = 'pending' OR (state = 'claimed' AND lease_until <= ?))"} ORDER BY sequence LIMIT ?`)
      .all(...(pendingOnly ? [bindingId, limit] : [bindingId, time, limit]));
    return rows.map(row => {
      if (!Number.isSafeInteger(row.attempt + 1)) throw fail('COMPLETION_INBOX_CORRUPT');
      const claimToken = randomUUID();
      const event = projectCompletionEvent(JSON.parse(row.payload));
      db.prepare("UPDATE completion_events SET state = 'claimed', claim_token = ?, lease_until = ?, attempt = attempt + 1 WHERE receipt_id = ? AND binding_id = ?")
        .run(claimToken, time + leaseMs, row.receipt_id, bindingId);
      return { receiptId: row.receipt_id, claimToken, attempt: row.attempt + 1, origin: row.origin, event };
    });
  }
  function waiterInput(input) {
    const { bindingId, ownerId, generation } = argumentsObject(input);
    identifier(bindingId); identifier(ownerId);
    if (!Number.isSafeInteger(generation) || generation < 1) throw fail('COMPLETION_INBOX_INVALID_INPUT');
    return { bindingId, ownerId, generation };
  }
  const registration = row => row ? { bindingId: row.binding_id, host: row.host, sessionId: row.session_id } : null;
  return Object.freeze({
    acquireWatch({ bindingId, watchKey, leaseMs = 600000 }) {
      return call(() => {
        binding(bindingId);
        if (typeof watchKey !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/.test(watchKey)) throw fail('COMPLETION_INBOX_INVALID_INPUT');
        const time = timeWithLease(leaseMs);
        return transaction(() => {
          const current = db.prepare('SELECT lease_until FROM completion_watches WHERE binding_id = ? AND watch_key = ?').get(bindingId, watchKey);
          if (current && current.lease_until > time) return { acquired: false };
          const ownerToken = randomUUID();
          db.prepare(`INSERT INTO completion_watches VALUES (?, ?, ?, ?)
            ON CONFLICT(binding_id, watch_key) DO UPDATE SET owner_token = excluded.owner_token, lease_until = excluded.lease_until`)
            .run(bindingId, watchKey, ownerToken, time + leaseMs);
          return { acquired: true, ownerToken };
        });
      });
    },
    releaseWatch({ bindingId, watchKey, ownerToken }) {
      return call(() => {
        binding(bindingId); identifier(ownerToken);
        return { released: db.prepare('UPDATE completion_watches SET lease_until = 0 WHERE binding_id = ? AND watch_key = ? AND owner_token = ?')
          .run(bindingId, watchKey, ownerToken).changes === 1 };
      });
    },
    register(input) {
      return call(() => {
        const { host, sessionId } = session(input);
        return transaction(() => {
          db.prepare('INSERT INTO completion_bindings(binding_id, host, session_id) VALUES (?, ?, ?) ON CONFLICT(host, session_id) DO NOTHING').run(randomUUID(), host, sessionId);
          const registered = registration(db.prepare('SELECT * FROM completion_bindings WHERE host = ? AND session_id = ?').get(host, sessionId));
          db.prepare('INSERT INTO completion_waiters(binding_id) VALUES (?) ON CONFLICT(binding_id) DO NOTHING').run(registered.bindingId);
          return registered;
        });
      });
    },
    findBinding(input) {
      return call(() => {
        if (input && typeof input === 'object' && !Array.isArray(input) && input.bindingId !== undefined && input.host === undefined && input.sessionId === undefined) {
          identifier(input.bindingId);
          return registration(db.prepare('SELECT * FROM completion_bindings WHERE binding_id = ?').get(input.bindingId));
        }
        const { host, sessionId } = session(input);
        return registration(db.prepare('SELECT * FROM completion_bindings WHERE host = ? AND session_id = ?').get(host, sessionId));
      });
    },
    deferWatch({ bindingId, origin, operationKey, payload }) {
      return call(() => {
        binding(bindingId);
        try { validateOrigin(origin); } catch { throw fail('COMPLETION_INBOX_INVALID_ORIGIN'); }
        if (typeof operationKey !== 'string' || !operationKey.length || Buffer.byteLength(operationKey) > 256 || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throw fail('COMPLETION_INBOX_INVALID_INPUT');
        }
        return transaction(() => {
          if ((typeof payload.operationId === 'string' && db.prepare('SELECT 1 FROM completion_settled_operations WHERE binding_id = ? AND operation_id = ?').get(bindingId, payload.operationId)) ||
              db.prepare('SELECT 1 FROM completion_settled_operations WHERE binding_id = ? AND operation_id = ?').get(bindingId, operationKey)) {
            return { deferred: false, settled: true };
          }
          db.prepare(`INSERT INTO completion_deferred_watches(binding_id, origin, operation_key, payload) VALUES (?, ?, ?, ?)
            ON CONFLICT(binding_id, origin, operation_key) DO UPDATE SET payload = excluded.payload`)
            .run(bindingId, origin, operationKey, JSON.stringify(payload));
          return { deferred: true };
        });
      });
    },
    consumeDeferredWatches({ bindingId, operationKey } = {}) {
      return call(() => transaction(() => {
        binding(bindingId);
        const rows = db.prepare('SELECT origin, operation_key, payload FROM completion_deferred_watches WHERE binding_id = ?').all(bindingId);
        const matched = [], retained = [];
        for (const row of rows) {
          const item = { origin: row.origin, operationKey: row.operation_key, ...JSON.parse(row.payload) };
          const settled = (typeof item.operationId === 'string' && db.prepare('SELECT 1 FROM completion_settled_operations WHERE binding_id = ? AND operation_id = ?').get(bindingId, item.operationId)) ||
            db.prepare('SELECT 1 FROM completion_settled_operations WHERE binding_id = ? AND operation_id = ?').get(bindingId, row.operation_key);
          if (settled) {
            db.prepare('DELETE FROM completion_deferred_watches WHERE binding_id = ? AND origin = ? AND operation_key = ?')
              .run(bindingId, row.origin, row.operation_key);
            continue;
          }
          if (operationKey === undefined || row.operation_key === operationKey || item.operationId === operationKey || item.operationKey === operationKey) {
            db.prepare('DELETE FROM completion_deferred_watches WHERE binding_id = ? AND origin = ? AND operation_key = ?')
              .run(bindingId, row.origin, row.operation_key);
            matched.push(item);
          } else {
            retained.push(item);
          }
        }
        return matched;
      }));
    },
    enqueue(input = {}) {
      return call(() => {
        const { bindingId, origin, event } = argumentsObject(input);
        identifier(bindingId);
        try { validateOrigin(origin); } catch { throw fail('COMPLETION_INBOX_INVALID_ORIGIN'); }
        const projected = projectCompletionEvent(event), payload = JSON.stringify(projected);
        return transaction(() => {
          binding(bindingId);
          const previous = db.prepare('SELECT receipt_id, state, payload FROM completion_events WHERE binding_id = ? AND origin = ? AND operation_id = ? AND revision = ?')
            .get(bindingId, origin, projected.id, projected.targetRevision);
          if (previous) {
            if (previous.payload !== payload) throw fail('COMPLETION_INBOX_EVENT_CONFLICT');
            return { receiptId: previous.receipt_id, state: previous.state, duplicate: true };
          }
          const settled = Boolean(db.prepare('SELECT 1 FROM completion_settled_operations WHERE binding_id = ? AND operation_id = ?').get(bindingId, projected.id));
          const receiptId = randomUUID();
          if (settled) {
            db.prepare("INSERT INTO completion_events(receipt_id, binding_id, origin, operation_id, revision, payload, state, claim_token, lease_until, attempt) VALUES (?, ?, ?, ?, ?, ?, 'acknowledged', ?, NULL, 1)")
              .run(receiptId, bindingId, origin, projected.id, projected.targetRevision, payload, randomUUID());
            return { receiptId, state: 'acknowledged', duplicate: false };
          }
          db.prepare('INSERT INTO completion_events(receipt_id, binding_id, origin, operation_id, revision, payload) VALUES (?, ?, ?, ?, ?, ?)')
            .run(receiptId, bindingId, origin, projected.id, projected.targetRevision, payload);
          return { receiptId, state: 'pending', duplicate: false };
        });
      });
    },
    claim(input = {}) {
      return call(() => {
        const { bindingId, ...options } = argumentsObject(input);
        return transaction(() => {
          binding(bindingId);
          return claimMessages(bindingId, options);
        });
      });
    },
    activateWaiter(input = {}) {
      return call(() => transaction(() => {
        const { bindingId } = argumentsObject(input); binding(bindingId);
        db.prepare('UPDATE completion_waiters SET ended = 0 WHERE binding_id = ?').run(bindingId);
        return { active: true };
      }));
    },
    pauseWaiter(input = {}) {
      return call(() => transaction(() => {
        const { bindingId } = argumentsObject(input); binding(bindingId);
        db.prepare('UPDATE completion_waiters SET owner_id = NULL, lease_until = 0, generation = generation + 1 WHERE binding_id = ? AND ended = 0 AND generation < 9007199254740991').run(bindingId);
        return { paused: true };
      }));
    },
    invalidateWaiter(input = {}) {
      return call(() => transaction(() => {
        const { bindingId } = argumentsObject(input); binding(bindingId);
        db.prepare('UPDATE completion_waiters SET ended = 1, owner_id = NULL, lease_until = 0 WHERE binding_id = ?').run(bindingId);
        return { invalidated: true };
      }));
    },
    acquireWaiter(input = {}) {
      return call(() => transaction(() => {
        const { bindingId, ownerId, leaseMs = 30000 } = argumentsObject(input);
        binding(bindingId); identifier(ownerId);
        const time = timeWithLease(leaseMs);
        const row = db.prepare(`UPDATE completion_waiters SET owner_id = ?, lease_until = ?, generation = generation + 1
          WHERE binding_id = ? AND ended = 0 AND (owner_id IS NULL OR lease_until <= ?) AND generation < 9007199254740991 RETURNING generation`)
          .get(ownerId, time + leaseMs, bindingId, time);
        return row ? { acquired: true, generation: row.generation } : { acquired: false };
      }));
    },
    pollWaiter(input = {}) {
      return call(() => transaction(() => {
        const { bindingId, ownerId, generation } = waiterInput(input);
        const { heartbeat = false, leaseMs = 30000 } = input;
        if (typeof heartbeat !== 'boolean') throw fail('COMPLETION_INBOX_INVALID_INPUT');
        const time = timeWithLease(leaseMs);
        const row = db.prepare('SELECT 1 FROM completion_waiters WHERE binding_id = ? AND owner_id = ? AND generation = ? AND ended = 0 AND lease_until > ?')
          .get(bindingId, ownerId, generation, time);
        if (!row) return { active: false, messages: [] };
        if (heartbeat) db.prepare('UPDATE completion_waiters SET lease_until = ? WHERE binding_id = ? AND owner_id = ? AND generation = ?')
          .run(time + leaseMs, bindingId, ownerId, generation);
        return { active: true, messages: claimMessages(bindingId, { pendingOnly: true }) };
      }));
    },
    releaseWaiter(input = {}) {
      return call(() => transaction(() => {
        const { bindingId, ownerId, generation } = waiterInput(input);
        const result = db.prepare('UPDATE completion_waiters SET owner_id = NULL, lease_until = 0 WHERE binding_id = ? AND owner_id = ? AND generation = ?')
          .run(bindingId, ownerId, generation);
        return { released: result.changes === 1 };
      }));
    },
    acknowledge(input = {}) {
      return call(() => {
        const { bindingId, receiptId, claimToken } = argumentsObject(input);
        if (bindingId !== undefined) identifier(bindingId);
        identifier(receiptId); identifier(claimToken);
        return transaction(() => {
          if (bindingId !== undefined) binding(bindingId);
          const row = bindingId !== undefined
            ? db.prepare('SELECT binding_id, state, claim_token FROM completion_events WHERE binding_id = ? AND receipt_id = ?').get(bindingId, receiptId)
            : db.prepare('SELECT binding_id, state, claim_token FROM completion_events WHERE receipt_id = ?').get(receiptId);
          if (!row) throw fail('COMPLETION_INBOX_RECEIPT_NOT_FOUND');
          if (row.state === 'pending' || row.claim_token !== claimToken) throw fail('COMPLETION_INBOX_STALE_CLAIM');
          const duplicate = row.state === 'acknowledged';
          if (!duplicate) db.prepare("UPDATE completion_events SET state = 'acknowledged', lease_until = NULL WHERE binding_id = ? AND receipt_id = ? AND claim_token = ?")
            .run(row.binding_id, receiptId, claimToken);
          return { acknowledged: true, duplicate };
        });
      });
    },
    acknowledgeOperation(input = {}) {
      return call(() => {
        const { bindingId, operationId } = argumentsObject(input);
        identifier(bindingId);
        if (typeof operationId !== 'string' || !/^[a-f0-9]{48}(?![\s\S])/.test(operationId)) throw fail('COMPLETION_INBOX_INVALID_INPUT');
        return transaction(() => {
          binding(bindingId);
          db.prepare('INSERT INTO completion_settled_operations(binding_id, operation_id) VALUES (?, ?) ON CONFLICT(binding_id, operation_id) DO NOTHING')
            .run(bindingId, operationId);
          for (const row of db.prepare('SELECT origin, operation_key, payload FROM completion_deferred_watches WHERE binding_id = ?').all(bindingId)) {
            let parsed;
            try { parsed = JSON.parse(row.payload); } catch { parsed = null; }
            if (row.operation_key === operationId || parsed?.operationId === operationId) {
              db.prepare('DELETE FROM completion_deferred_watches WHERE binding_id = ? AND origin = ? AND operation_key = ?')
                .run(bindingId, row.origin, row.operation_key);
            }
          }
          const autoToken = randomUUID();
          const updated = db.prepare(`UPDATE completion_events SET state = 'acknowledged',
            claim_token = coalesce(claim_token, ?), lease_until = NULL, attempt = max(attempt, 1)
            WHERE binding_id = ? AND operation_id = ? AND state != 'acknowledged'`)
            .run(autoToken, bindingId, operationId);
          return { acknowledged: updated.changes > 0, count: updated.changes };
        });
      });
    },
    hasOperationEvent(input = {}) {
      return call(() => {
        const { bindingId, operationId } = argumentsObject(input);
        binding(bindingId);
        if (typeof operationId !== 'string' || !/^[a-f0-9]{48}(?![\s\S])/.test(operationId)) return false;
        return Boolean(db.prepare('SELECT 1 FROM completion_events WHERE binding_id = ? AND operation_id = ?').get(bindingId, operationId) ||
          db.prepare('SELECT 1 FROM completion_settled_operations WHERE binding_id = ? AND operation_id = ?').get(bindingId, operationId));
      });
    },
    pending(input = {}) {
      return call(() => {
        const { bindingId } = argumentsObject(input);
        binding(bindingId);
        const counts = { pending: 0, claimed: 0, acknowledged: 0 };
        for (const row of db.prepare('SELECT state, count(*) AS count FROM completion_events WHERE binding_id = ? GROUP BY state').all(bindingId)) counts[row.state] = row.count;
        return counts;
      });
    },
    close() {
      if (closed) return;
      try { db.close(); closed = true; } catch (error) { throw sanitize(error); }
    },
  });
}
