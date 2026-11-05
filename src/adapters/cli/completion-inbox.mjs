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
      if (app === applicationId && version !== 1) throw fail('COMPLETION_INBOX_SCHEMA_MISMATCH');
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
  const registration = row => row ? { bindingId: row.binding_id, host: row.host, sessionId: row.session_id } : null;
  return Object.freeze({
    register(input) {
      return call(() => {
        const { host, sessionId } = session(input);
        return transaction(() => {
          db.prepare('INSERT INTO completion_bindings(binding_id, host, session_id) VALUES (?, ?, ?) ON CONFLICT(host, session_id) DO NOTHING').run(randomUUID(), host, sessionId);
          return registration(db.prepare('SELECT * FROM completion_bindings WHERE host = ? AND session_id = ?').get(host, sessionId));
        });
      });
    },
    findBinding(input) {
      return call(() => {
        const { host, sessionId } = session(input);
        return registration(db.prepare('SELECT * FROM completion_bindings WHERE host = ? AND session_id = ?').get(host, sessionId));
      });
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
          const receiptId = randomUUID();
          db.prepare('INSERT INTO completion_events(receipt_id, binding_id, origin, operation_id, revision, payload) VALUES (?, ?, ?, ?, ?, ?)')
            .run(receiptId, bindingId, origin, projected.id, projected.targetRevision, payload);
          return { receiptId, state: 'pending', duplicate: false };
        });
      });
    },
    claim(input = {}) {
      return call(() => {
        const { bindingId, limit = 8, leaseMs = 30000 } = argumentsObject(input);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 600000) {
          throw fail('COMPLETION_INBOX_INVALID_INPUT');
        }
        return transaction(() => {
          binding(bindingId);
          const time = now();
          if (!Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(time + leaseMs)) throw fail('COMPLETION_INBOX_INVALID_INPUT');
          const rows = db.prepare("SELECT receipt_id, origin, payload, attempt FROM completion_events WHERE binding_id = ? AND (state = 'pending' OR (state = 'claimed' AND lease_until <= ?)) ORDER BY sequence LIMIT ?")
            .all(bindingId, time, limit);
          return rows.map(row => {
            if (!Number.isSafeInteger(row.attempt + 1)) throw fail('COMPLETION_INBOX_CORRUPT');
            const claimToken = randomUUID();
            const event = projectCompletionEvent(JSON.parse(row.payload));
            db.prepare("UPDATE completion_events SET state = 'claimed', claim_token = ?, lease_until = ?, attempt = attempt + 1 WHERE receipt_id = ? AND binding_id = ?")
              .run(claimToken, time + leaseMs, row.receipt_id, bindingId);
            return { receiptId: row.receipt_id, claimToken, attempt: row.attempt + 1, origin: row.origin, event };
          });
        });
      });
    },
    acknowledge(input = {}) {
      return call(() => {
        const { bindingId, receiptId, claimToken } = argumentsObject(input);
        identifier(receiptId); identifier(claimToken);
        return transaction(() => {
          binding(bindingId);
          const row = db.prepare('SELECT state, claim_token FROM completion_events WHERE binding_id = ? AND receipt_id = ?').get(bindingId, receiptId);
          if (!row) throw fail('COMPLETION_INBOX_RECEIPT_NOT_FOUND');
          if (row.state === 'pending' || row.claim_token !== claimToken) throw fail('COMPLETION_INBOX_STALE_CLAIM');
          const duplicate = row.state === 'acknowledged';
          if (!duplicate) db.prepare("UPDATE completion_events SET state = 'acknowledged', lease_until = NULL WHERE binding_id = ? AND receipt_id = ? AND claim_token = ?")
            .run(bindingId, receiptId, claimToken);
          return { acknowledged: true, duplicate };
        });
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
