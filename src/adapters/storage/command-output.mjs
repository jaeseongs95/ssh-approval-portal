import { DatabaseSync } from 'node:sqlite';
import { constants, mkdirSync, lstatSync, openSync, closeSync, fstatSync, readSync, writeSync, fsyncSync, renameSync, unlinkSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

import { OUTPUT_PAGE_BYTES } from '../../contracts/ports.mjs';
export { OUTPUT_PAGE_BYTES } from '../../contracts/ports.mjs';
const TTL = 3_600_000, MAX = 16 * 1024 * 1024, BUDGET = 128 * 1024 * 1024;
const validId = value => typeof value === 'string' && /^[a-f0-9]{48}$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const capture = { version: 1, captureSource: 'redacted-adapter-outcome', sshCompleteness: 'unknown' };
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
  constructor(root, { now = Date.now, maxBytes = MAX, budget = BUDGET, ttl = TTL } = {}) {
    if (![maxBytes, budget, ttl].every(n => Number.isSafeInteger(n) && n > 0) || budget < maxBytes) throw Error('Invalid output limits');
    this.root = join(root, 'command-outputs'); this.now = now; this.maxBytes = maxBytes; this.budget = budget; this.ttl = ttl;
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
        const match = /^([a-f0-9]{48})\.(out|part)$/.exec(name);
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
        if (item.state === 'pending') { item.state = 'unavailable'; this.persist(item, this.maxBytes); }
      }
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
  persist(item, charge) {
    const body = JSON.stringify(item);
    if (Buffer.byteLength(body) > 256 * 1024) throw Error('Output manifest too large');
    this.db.prepare('INSERT INTO outputs VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,digest=excluded.digest,charge=excluded.charge').run(item.id, body, digest(body), charge);
  }
  describe(item) {
    return { ...capture, id: item.id, executionId: item.binding.executionId,
      state: this.now() >= item.expiresAt ? 'expired' : item.state === 'ready' ? 'ready' : 'unavailable',
      expiresAt: item.expiresAt,
      ...(item.formats ? { bytes: item.formats.text.bytes, snapshotBytes: item.formats.json.bytes, sha256: item.formats.json.sha256 } : {}) };
  }
  reserve(binding) {
    this.checkRoot(); this.reap();
    const usage = this.db.prepare('SELECT count(*) AS n,coalesce(sum(charge),0) AS bytes FROM outputs').get();
    const disk = statfsSync(this.root);
    if (usage.n >= 1000 || usage.bytes + this.maxBytes > this.budget || disk.bavail * disk.bsize < this.maxBytes + 1024 * 1024) throw Error('Output storage capacity unavailable before dispatch');
    const id = randomBytes(24).toString('hex'), item = { ...capture, id, binding: { ...binding }, state: 'pending', expiresAt: this.now() + this.ttl };
    const path = join(this.root, id + '.part');
    const fd = openSync(path, 'wx', 0o600);
    try { fsyncSync(fd); this.persist(item, this.maxBytes); }
    catch (error) { closeSync(fd); unlinkSync(path); throw error; }
    closeSync(fd); return item;
  }
  finish(item, outcome) {
    // Never throw a capture error across an already executed SSH effect.
    try {
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
      if (process.platform !== 'win32') { const directory = openSync(this.root, constants.O_RDONLY); try { fsyncSync(directory); } finally { closeSync(directory); } }
      Object.assign(item, { state: 'ready', formats, size: bytes, expiresAt: this.now() + this.ttl }); this.persist(item, bytes);
    } catch {
      item.state = 'unavailable'; delete item.formats; delete item.size; item.expiresAt = this.now() + this.ttl;
      try { this.persist(item, this.maxBytes); } catch { /* The durable pending row remains charged and unavailable after restart. */ }
    }
    return { failed: outcome.failed, texts: [], output: this.describe(item) };
  }
  abandon(item) {
    item.state = 'unavailable'; item.expiresAt = this.now() + this.ttl;
    try { this.persist(item, this.maxBytes); } catch { /* Interrupted admission stays charged. */ }
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
    for (const { id } of this.db.prepare('SELECT id FROM outputs').all()) {
      const item = this.get(id); if (item.state === 'pending' || this.now() < item.expiresAt) continue;
      for (const suffix of ['.part', '.out']) {
        const path = join(this.root, id + suffix);
        try { if (!safe(lstatSync(path))) throw Error('Unsafe expired output'); unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      this.db.prepare('DELETE FROM outputs WHERE id=?').run(id);
    }
  }
  close() { this.db.close(); }
}
