import { DatabaseSync } from 'node:sqlite';
import { constants, mkdirSync, lstatSync, openSync, closeSync, fstatSync, readSync, writeSync, fsyncSync, renameSync, unlinkSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

import { OUTPUT_PAGE_BYTES } from '../../contracts/ports.mjs';
import { executionFailure, executionFailureDetails, safeExecutionFailure } from '../../domain/execution-failure.mjs';
export { OUTPUT_PAGE_BYTES } from '../../contracts/ports.mjs';
const TTL = 3_600_000, MAX = 16 * 1024 * 1024, BUDGET = 128 * 1024 * 1024;
const validId = value => typeof value === 'string' && /^[a-f0-9]{48}$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const capture = { version: 1, captureSource: 'redacted-adapter-outcome', sshCompleteness: 'unknown' };
const streamCapture = { version: 1, captureSource: 'ssh-channel-bytes', bytesEncoding: 'base64' };
const safeExecution = value => {
  if (!value || typeof value !== 'object') return undefined;
  const result = {};
  for (const [key, values] of Object.entries({ phase: ['settled'], reason: ['exit', 'deadline', 'cancel', 'transport_lost', 'channel_open_failed', 'input_failed'], remoteState: ['not_dispatched', 'exited', 'unknown'], outputState: ['partial', 'complete'] })) {
    if (values.includes(value[key])) result[key] = value[key];
  }
  if (value.exitCode === null || Number.isSafeInteger(value.exitCode)) result.exitCode = value.exitCode;
  if (value.signal === null || typeof value.signal === 'string' && /^[A-Z0-9_-]{1,32}$/.test(value.signal)) result.signal = value.signal;
  if (value.signalDelivery === null || ['requested', 'unsupported'].includes(value.signalDelivery)) result.signalDelivery = value.signalDelivery;
  for (const key of ['automaticReplay', 'cleanupComplete', 'requiresReconciliation', 'captureFailed']) if (typeof value[key] === 'boolean') result[key] = value[key];
  if (Number.isSafeInteger(value.timeoutMs) && value.timeoutMs > 0) result.timeoutMs = value.timeoutMs;
  for (const key of ['stdout', 'stderr']) if (value[key] && ['receivedBytes', 'retainedBytes', 'cursor'].every(name => Number.isSafeInteger(value[key][name]) && value[key][name] >= 0) && typeof value[key].truncated === 'boolean') {
    result[key] = Object.fromEntries(['receivedBytes', 'retainedBytes', 'cursor', 'truncated'].map(name => [name, value[key][name]]));
  }
  return Object.keys(result).length ? result : undefined;
};
const safe = st => st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && (process.platform === 'win32' || (!(st.mode & 0o077) && st.uid === process.getuid()));
const readExactly = (fd, size, position) => {
  const buffer = Buffer.alloc(size); let n = 0;
  while (n < size) { const got = readSync(fd, buffer, n, size - n, position + n); if (!got) throw Error('Incomplete output'); n += got; }
  return buffer;
};

/** One process, private immutable payloads and a separate durable manifest journal.
 * ponytail: bounded synchronous fs/SQLite removes read/GC races; move IO off-loop only if measured.
 * The OS page cache supplies byte reuse; no execution, approval or authority cache exists here.
 */
export class CommandOutputs {
  constructor(root, { now = Date.now, maxBytes = MAX, budget = BUDGET, ttl = TTL, canReap = () => true } = {}) {
    if (![maxBytes, budget, ttl].every(n => Number.isSafeInteger(n) && n > 0) || budget < maxBytes) throw Error('Invalid output limits');
    if (typeof canReap !== 'function') throw Error('Invalid output cleanup guard');
    this.root = join(root, 'command-outputs'); this.now = now; this.maxBytes = maxBytes; this.budget = budget; this.ttl = ttl;
    this.canReap = canReap;
    mkdirSync(this.root, { recursive: true, mode: 0o700 }); this.checkRoot();
    const path = join(this.root, 'manifest.sqlite');
    try { closeSync(openSync(path, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!safe(lstatSync(path))) throw Error('Unsafe output manifest');
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS outputs (id TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL, charge INTEGER NOT NULL);');
      this.db.prepare('SELECT id FROM outputs').all();
      const ids = new Set(this.db.prepare('SELECT id FROM outputs').all().map(row => row.id));
      for (const name of readdirSync(this.root)) {
        const match = /^([a-f0-9]{48})\.(out|part|stream)$/.exec(name);
        if (match && !ids.has(match[1])) {
          const st = lstatSync(join(this.root, name));
          if (!safe(st) || st.size > this.maxBytes) throw Error('Unsafe orphan output');
          // A crash can precede the admission row. Quarantine, charge and expire it;
          // file existence never reconstructs execution or observation authority.
          this.persist({ ...capture, id: match[1], binding: { executionId: match[1], targetId: null }, state: 'unavailable', expiresAt: this.now() + this.ttl }, this.maxBytes);
          ids.add(match[1]);
        }
      }
      // Interrupted publication never proves execution success and never causes replay.
      for (const row of this.db.prepare('SELECT id,body FROM outputs').all()) {
        const item = this.get(row.id);
        if (item.state === 'pending') {
          item.state = 'unavailable';
          if (item.stream) item.stream.complete = true;
          this.persist(item, this.db.prepare('SELECT charge FROM outputs WHERE id=?').get(item.id).charge);
        }
      }
      this.reconcileAccounting = true;
      this.reap();
    } catch (error) { this.db.close(); throw error; }
  }
  checkRoot() {
    const st = lstatSync(this.root);
    if (!st.isDirectory() || st.isSymbolicLink() || (process.platform !== 'win32' && ((st.mode & 0o077) || st.uid !== process.getuid()))) throw Error('Unsafe output root');
  }
  get(id) {
    if (!validId(id)) throw Error('Invalid output ID');
    const row = this.db.prepare('SELECT body,digest FROM outputs WHERE id=?').get(id);
    if (!row || digest(row.body) !== row.digest) throw Error('Output unavailable');
    const item = JSON.parse(row.body);
    if (item.id !== id || !Number.isSafeInteger(item.expiresAt)) throw Error('Invalid output manifest');
    return item;
  }
  preservationRows() {
    const usage = this.db.prepare('SELECT count(*) AS count,coalesce(sum(length(CAST(body AS BLOB))),0) AS bytes FROM outputs').get();
    if (usage.count > 1000 || usage.bytes > 64 * 1024 * 1024) throw Error('Output preservation budget exceeded');
    return {schema: this.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name').all(),
      outputs: this.db.prepare('SELECT id,body,digest,charge FROM outputs ORDER BY id').all()};
  }
  persist(item, charge) {
    const body = JSON.stringify(item);
    if (Buffer.byteLength(body) > 256 * 1024) throw Error('Output manifest too large');
    this.db.prepare('INSERT INTO outputs VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,digest=excluded.digest,charge=excluded.charge').run(item.id, body, digest(body), charge);
  }
  retainedCharge(id, previous = this.maxBytes) {
    const conservative = Math.max(this.maxBytes, previous);
    let bytes = 0, files = 0;
    try {
      this.checkRoot();
      for (const suffix of ['.part', '.out', '.stream']) {
        const path = join(this.root, id + suffix);
        let expected;
        try { expected = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!safe(expected)) throw Error('Unsafe retained output');
        const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const st = fstatSync(fd);
          if (!safe(st) || st.ino !== expected.ino || st.dev !== expected.dev || st.size !== expected.size) throw Error('Retained output changed');
          bytes += st.size; files++;
          if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error('Invalid retained output size');
        } finally { closeSync(fd); }
      }
      // Missing/unsafe evidence never proves an empty reservation. Oversize evidence
      // is retained and charged without releasing any prior reservation.
      const expectedLimit = this.get(id).stream ? 2 * this.maxBytes : this.maxBytes;
      if (files) return bytes > expectedLimit ? Math.max(bytes, conservative) : bytes;
    } catch { /* Keep the reservation when retained bytes cannot be safely measured. */ }
    return conservative;
  }
  persistUnavailable(item) {
    const previous = this.db.prepare('SELECT charge FROM outputs WHERE id=?').get(item.id)?.charge ?? this.maxBytes;
    let charge = Math.max(this.maxBytes, previous);
    if (this.canReap() === true) charge = this.retainedCharge(item.id, previous);
    else this.reconcileAccounting = true;
    this.persist(item, charge);
  }
  describe(item) {
    return { ...capture, id: item.id, executionId: item.binding.executionId,
      state: this.now() >= item.expiresAt ? 'expired' : item.state === 'ready' ? 'ready' : 'unavailable',
      expiresAt: item.expiresAt,
      ...(item.formats ? { bytes: item.formats.text.bytes, snapshotBytes: item.formats.json.bytes, sha256: item.formats.json.sha256 } : {}),
      ...(item.stream ? { stream: { bytes: item.stream.bytes, cursor: item.stream.bytes, complete: item.stream.complete, truncated: item.stream.truncated } } : {}) };
  }
  reserve(binding) {
    this.checkRoot(); this.reap();
    const usage = this.db.prepare('SELECT count(*) AS n,coalesce(sum(charge),0) AS bytes FROM outputs').get();
    const disk = statfsSync(this.root);
    if (usage.n >= 1000 || usage.bytes + this.maxBytes > this.budget || disk.bavail * disk.bsize < this.maxBytes + 1024 * 1024) {
      const error = executionFailure(undefined, { stage: 'output_reservation', code: 'OUTPUT_CAPACITY', remoteOutcome: 'not_started' });
      error.message = 'Output storage capacity unavailable before dispatch';
      throw error;
    }
    const id = randomBytes(24).toString('hex'), item = { ...capture, id, binding: { ...binding }, state: 'pending', expiresAt: this.now() + this.ttl };
    const path = join(this.root, id + '.part');
    const fd = openSync(path, 'wx', 0o600);
    try { fsyncSync(fd); this.persist(item, this.maxBytes); }
    catch (error) { closeSync(fd); unlinkSync(path); throw error; }
    closeSync(fd); return item;
  }
  beginStream(item) {
    this.checkRoot();
    const current = this.get(item.id);
    if (current.state !== 'pending' || current.stream) throw Error('Output stream already started or unavailable');
    const usage = this.db.prepare('SELECT coalesce(sum(charge),0) AS bytes FROM outputs').get();
    const disk = statfsSync(this.root);
    if (usage.bytes + this.maxBytes > this.budget || disk.bavail * disk.bsize < this.maxBytes + 1024 * 1024) {
      const error = executionFailure(undefined, { stage: 'output_reservation', code: 'OUTPUT_CAPACITY', remoteOutcome: 'not_started' });
      error.message = 'Output storage capacity unavailable before dispatch'; throw error;
    }
    const path = join(this.root, item.id + '.stream'), fd = openSync(path, 'wx', 0o600);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    this.syncDirectory();
    const stream = { bytes: 0, size: 0, sha256: digest(Buffer.alloc(0)), stdoutCursor: 0, stderrCursor: 0, truncated: false, complete: false };
    this.persist({ ...current, stream }, 2 * this.maxBytes); item.stream = stream;
    let hash = createHash('sha256');
    return { append: event => {
      if (!event || !['stdout', 'stderr'].includes(event.stream) || !Buffer.isBuffer(event.bytes)) throw Error('Invalid output stream event');
      const latest = this.get(item.id), prior = latest.stream;
      if (latest.state !== 'pending' || !prior || prior.complete) throw Error('Output stream closed');
      const sourceCursor = event.stream + 'Cursor';
      if (event.cursor !== undefined && event.cursor !== prior[sourceCursor] || event.nextCursor !== undefined && event.nextCursor !== prior[sourceCursor] + event.bytes.length) throw Error('Invalid output stream cursor');
      if (!Number.isSafeInteger(prior[sourceCursor] + event.bytes.length)) throw Error('Invalid output stream cursor');
      const retained = event.bytes.subarray(0, Math.max(0, this.maxBytes - prior.size - 5));
      const next = { ...prior, [sourceCursor]: prior[sourceCursor] + event.bytes.length, truncated: prior.truncated || retained.length < event.bytes.length };
      let nextHash = hash;
      if (retained.length) {
        const header = Buffer.alloc(5); header[0] = event.stream === 'stdout' ? 0 : 1; header.writeUInt32BE(retained.length, 1);
        const frame = Buffer.concat([header, retained]), expected = lstatSync(path);
        if (!safe(expected)) throw Error('Unsafe output stream path');
        const output = openSync(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const st = fstatSync(output);
          if (!safe(st) || st.size !== prior.size || st.ino !== expected.ino || st.dev !== expected.dev) throw Error('Unsafe output stream file');
          let n = 0; while (n < frame.length) { const written = writeSync(output, frame, n, frame.length - n, prior.size + n); if (!written) throw Error('Incomplete output write'); n += written; }
          fsyncSync(output);
        } finally { closeSync(output); }
        nextHash = hash.copy().update(frame);
        Object.assign(next, { bytes: prior.bytes + retained.length, size: prior.size + frame.length, sha256: nextHash.copy().digest('hex') });
      }
      this.persist({ ...latest, stream: next }, 2 * this.maxBytes); item.stream = next; hash = nextHash;
      return { cursor: next.bytes, truncated: next.truncated };
    } };
  }
  syncDirectory() {
    if (process.platform !== 'win32') { const directory = openSync(this.root, constants.O_RDONLY); try { fsyncSync(directory); } finally { closeSync(directory); } }
  }
  // Internal recovery only. Public observers must use the redacted legacy read()
  // after settlement; chunk-local redaction cannot protect split secret records.
  readStream({ outputId, cursor = 0, maxBytes = 4096 }, authorize) {
    this.checkRoot();
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > OUTPUT_PAGE_BYTES) throw Error('Invalid output stream range');
    const item = this.get(outputId); authorize(item.binding);
    if (!item.stream || this.now() >= item.expiresAt) throw Error('Output stream expired or unavailable; do not reexecute');
    const stream = item.stream;
    if (cursor > stream.bytes || !Number.isSafeInteger(stream.size) || stream.size < 0 || stream.size > this.maxBytes) throw Error('Invalid output stream range');
    const path = join(this.root, item.id + '.stream'), expected = lstatSync(path);
    if (!safe(expected)) throw Error('Unsafe output stream path');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let payload;
    try {
      const st = fstatSync(fd);
      // A crash may leave an uncommitted tail. Only manifest-committed bytes are readable.
      if (!safe(st) || st.size < stream.size || st.size > this.maxBytes || st.ino !== expected.ino || st.dev !== expected.dev) throw Error('Unsafe output stream payload');
      // ponytail: each page verifies at most maxBytes of spool; add indexed hashes only if measured.
      payload = readExactly(fd, stream.size, 0);
      if (digest(payload) !== stream.sha256) throw Error('Output stream integrity failed');
    } finally { closeSync(fd); }
    const events = []; let position = 0, offset = 0, remaining = maxBytes;
    const streamOffsets = { stdout: 0, stderr: 0 };
    while (position < payload.length) {
      if (payload.length - position < 5 || payload[position] > 1) throw Error('Invalid output stream frame');
      const name = payload[position] === 0 ? 'stdout' : 'stderr', length = payload.readUInt32BE(position + 1); position += 5;
      if (!length || length > payload.length - position) throw Error('Invalid output stream frame');
      const skip = Math.max(0, cursor - offset), count = Math.min(remaining, Math.max(0, length - skip));
      if (count) {
        const start = offset + skip;
        events.push({ stream: name, bytes: payload.subarray(position + skip, position + skip + count).toString('base64'), cursor: start, nextCursor: start + count, streamCursor: streamOffsets[name] + skip });
        remaining -= count;
      }
      offset += length; streamOffsets[name] += length; position += length;
    }
    if (offset !== stream.bytes) throw Error('Invalid output stream size');
    authorize(item.binding);
    if (this.now() >= item.expiresAt) throw Error('Output stream expired');
    const nextCursor = cursor + maxBytes - remaining;
    return { ...streamCapture, outputId, executionId: item.binding.executionId, events, cursor, nextCursor, totalBytes: stream.bytes,
      eof: stream.complete && nextCursor === stream.bytes, complete: stream.complete, truncated: stream.truncated,
      state: item.state === 'pending' ? 'running' : item.state, expiresAt: item.expiresAt };
  }
  finish(item, outcome) {
    // Never throw a capture error across an already executed SSH effect.
    let failure = safeExecutionFailure(outcome.failure);
    try {
      const current = this.get(item.id);
      if (current.stream) item.stream = { ...current.stream, complete: true };
      const json = Buffer.from(JSON.stringify(outcome), 'utf8');
      const text = Buffer.from(outcome.texts.join('\n') + (outcome.data === undefined ? '' : '\n' + JSON.stringify(outcome.data, null, 2)), 'utf8');
      const bytes = json.length + text.length;
      if (bytes > this.maxBytes) throw Error('Output snapshot exceeds storage reservation');
      const formats = {}; let start = 0;
      for (const [name, buffer] of [['json', json], ['text', text]]) {
        const chunks = [];
        for (let i = 0; i < buffer.length; i += OUTPUT_PAGE_BYTES) chunks.push(digest(buffer.subarray(i, i + OUTPUT_PAGE_BYTES)));
        formats[name] = { offset: start, bytes: buffer.length, sha256: digest(buffer), chunks }; start += buffer.length;
      }
      const path = join(this.root, item.id + '.part'), expected = lstatSync(path);
      if (!safe(expected)) throw Error('Unsafe output staging path');
      const fd = openSync(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const st = fstatSync(fd);
        if (!safe(st) || st.size !== 0 || st.ino !== expected.ino || st.dev !== expected.dev) throw Error('Unsafe output staging file');
        for (const buffer of [json, text]) { let n = 0; while (n < buffer.length) n += writeSync(fd, buffer, n, buffer.length - n); }
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(join(this.root, item.id + '.part'), join(this.root, item.id + '.out'));
      this.syncDirectory();
      Object.assign(item, { state: 'ready', formats, size: bytes, expiresAt: this.now() + this.ttl }); this.persist(item, bytes + (item.stream?.size ?? 0));
    } catch (error) {
      failure = executionFailureDetails(executionFailure(error, { stage: 'output_capture', code: 'OUTPUT_CAPTURE_FAILED', remoteOutcome: 'completed' }));
      item.state = 'unavailable'; delete item.formats; delete item.size; item.expiresAt = this.now() + this.ttl;
      try { this.persistUnavailable(item); } catch { /* The durable pending row remains charged and unavailable after restart. */ }
    }
    const execution = safeExecution(outcome.execution);
    return { failed: outcome.failed, texts: [], output: this.describe(item), ...(failure ? { failure } : {}), ...(execution ? { execution } : {}) };
  }
  abandon(item) {
    try {
      const current = this.get(item.id);
      if (current.stream) item.stream = { ...current.stream, complete: true };
      item.state = 'unavailable'; item.expiresAt = this.now() + this.ttl;
      this.persistUnavailable(item);
    } catch { /* Interrupted admission stays charged. */ }
  }
  read({ outputId, offsetBytes = 0, maxBytes = 4096, format = 'text' }, authorize) {
    this.checkRoot();
    if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > OUTPUT_PAGE_BYTES || !['text', 'json'].includes(format)) throw Error('Invalid output range');
    const item = this.get(outputId); authorize(item.binding);
    if (item.state !== 'ready' || this.now() >= item.expiresAt) throw Error('Output expired or unavailable; do not reexecute');
    const part = item.formats[format];
    if (offsetBytes > part.bytes || part.chunks.length !== Math.ceil(part.bytes / OUTPUT_PAGE_BYTES)) throw Error('Invalid output range');
    const path = join(this.root, item.id + '.out'), expected = lstatSync(path);
    if (!safe(expected)) throw Error('Unsafe output payload path');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let buffer;
    try {
      const st = fstatSync(fd); if (!safe(st) || st.size !== item.size || st.ino !== expected.ino || st.dev !== expected.dev) throw Error('Unsafe output payload');
      const end = Math.min(part.bytes, offsetBytes + maxBytes), first = Math.floor(offsetBytes / OUTPUT_PAGE_BYTES), last = Math.ceil(end / OUTPUT_PAGE_BYTES);
      const chunks = [];
      for (let n = first; n < last; n++) {
        const chunk = readExactly(fd, Math.min(OUTPUT_PAGE_BYTES, part.bytes - n * OUTPUT_PAGE_BYTES), part.offset + n * OUTPUT_PAGE_BYTES);
        if (digest(chunk) !== part.chunks[n]) throw Error('Output integrity failed'); chunks.push(chunk);
      }
      const relative = offsetBytes - first * OUTPUT_PAGE_BYTES;
      buffer = Buffer.concat(chunks).subarray(relative, relative + end - offsetBytes);
      if (buffer.length && (buffer[0] & 0xc0) === 0x80) throw Error('Offset must be a UTF-8 boundary');
      if (end < part.bytes && buffer.length) {
        let lead = buffer.length - 1; while (lead >= 0 && (buffer[lead] & 0xc0) === 0x80) lead--;
        const byte = buffer[lead], width = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
        if (buffer.length - lead < width) buffer = buffer.subarray(0, lead);
      }
    } finally { closeSync(fd); }
    authorize(item.binding);
    if (this.now() >= item.expiresAt) throw Error('Output expired');
    return { text: buffer.toString('utf8'), ...capture, outputId: item.id, executionId: item.binding.executionId, format,
      offsetBytes, bytes: buffer.length, nextOffset: offsetBytes + buffer.length, eof: offsetBytes + buffer.length === part.bytes,
      totalBytes: part.bytes, sha256: part.sha256, expiresAt: item.expiresAt };
  }
  reap() {
    // A reserved restart must preserve baseline rows and bytes even after their read TTL.
    if (this.canReap() !== true) return;
    if (this.reconcileAccounting) {
      for (const { id, charge } of this.db.prepare('SELECT id,charge FROM outputs').all()) {
        if (this.get(id).state !== 'unavailable') continue;
        const retained = this.retainedCharge(id, charge);
        if (retained !== charge) this.db.prepare('UPDATE outputs SET charge=? WHERE id=?').run(retained, id);
      }
      this.reconcileAccounting = false;
    }
    for (const { id } of this.db.prepare('SELECT id FROM outputs').all()) {
      const item = this.get(id); if (item.state === 'pending' || this.now() < item.expiresAt) continue;
      for (const suffix of ['.part', '.out', '.stream']) {
        const path = join(this.root, id + suffix);
        try { if (!safe(lstatSync(path))) throw Error('Unsafe expired output'); unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      this.db.prepare('DELETE FROM outputs WHERE id=?').run(id);
    }
  }
  close() { this.db.close(); }
}
