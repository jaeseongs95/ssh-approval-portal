import { randomBytes, createHash } from 'node:crypto';
import { mkdir, lstat, readdir, unlink, open, rename } from 'node:fs/promises';
import { constants, openSync, closeSync, writeFileSync, fsyncSync, renameSync, lstatSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { idValid, anyRemotePath, hash } from '../../domain/validation.mjs';
import { CHUNK_BYTES, MAX_BYTES, EXPIRES_MS } from '../../contracts/ports.mjs';

export { CHUNK_BYTES, MAX_BYTES } from '../../contracts/ports.mjs';
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validKey = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{16,128}$/.test(value);
const privateFile = st => st.isFile() && !st.isSymbolicLink() && st.nlink === 1 &&
  (process.platform === 'win32' || (!(st.mode & 0o077) && st.uid === process.getuid()));
const privateDirectory = st => st.isDirectory() && !st.isSymbolicLink() &&
  (process.platform === 'win32' || (!(st.mode & 0o077) && st.uid === process.getuid()));
const charge = item => Math.max(1, item.size);
const validateUpload = meta => {
  anyRemotePath(meta.remotePath);
  if (typeof meta.fileName !== 'string' || !meta.fileName || meta.fileName.length > 255 || /[\x00-\x1f\x7f/\\]/.test(meta.fileName)) throw Error('Invalid filename');
};
const ownership = meta => ({
  ...(meta.targetId === undefined ? {} : { targetId: meta.targetId, targetRevision: meta.targetRevision,
    ...(meta.fileTargetBound === true ? { fileTargetBound: true } : {}) }),
  ...(meta.uploadProtocol === 'mcp-json-v1' ? { uploadProtocol: meta.uploadProtocol } : {}),
  ...(meta.operationKey === undefined ? {} : { operationKey: meta.operationKey }),
});
const snapshot = item => {
  const { path, last, chunks, ...metadata } = item;
  return Object.freeze(metadata);
};

/** Owns staging bytes, accounting and their complete lifecycle. All metadata is copied. */
export class Artifacts {
  #items = new Map();
  #removing = new Map();
  #reserved = 0;
  #orphans = [];
  #root;
  #now;
  constructor(root, { maxBytes = MAX_BYTES, budget = 512 * 1024 * 1024, now = () => Date.now() } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BYTES || !Number.isSafeInteger(budget) || budget < maxBytes) throw Error('Invalid staging limits');
    this.#root = resolve(root); this.#now = now;
    Object.defineProperties(this, { maxBytes: { value: maxBytes, enumerable: true }, budget: { value: budget, enumerable: true } });
  }
  get reserved() { return this.#reserved; }
  get size() { return this.#items.size; }
  has(id) { return this.#items.has(id); }
  list() { return Object.freeze([...this.#items.values()].map(snapshot)); }
  recoveryStatus() { return Object.freeze({ state: this.#orphans.length ? 'recovery-required' : 'clear',
    reservedBytes: this.#orphans.reduce((n, x) => n + x.reservedBytes, 0), entries: Object.freeze(this.#orphans.map(x => Object.freeze({ ...x }))) }); }
  hasActiveWork() { return [...this.#items.values()].some(x => x.busy || x.pinned || x.state === 'staging'); }
  async init() {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const s = await lstat(this.#root);
    if (!privateDirectory(s)) throw Error('Transfer root must be private and owned by the service');
    if (this.#items.size) throw Error('Artifact store already initialized');
    // Each synced manifest is the commit point. A crash may leave an unacknowledged
    // byte tail, which is rolled back before accepting another chunk.
    const names = await readdir(this.#root), entries = new Set(names);
    for (const name of names) if (/^[a-f0-9]{48}\.part$/.test(name) && !entries.has(name.slice(0, -5) + '.json')) {
      await this.#quarantine(name);
    }
    await this.#restoreOrphans();
    for (const name of names) if (/^[a-f0-9]{48}\.json$/.test(name)) {
      const path = join(this.#root, name), st = await lstat(path);
      if (!privateFile(st) || st.size > 256 * 1024) throw Error('Unsafe transfer metadata');
      const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let record;
      try {
        const actual = await fd.stat();
        if (!privateFile(actual) || actual.ino !== st.ino || actual.dev !== st.dev) throw Error('Transfer metadata changed');
        record = JSON.parse(await fd.readFile('utf8'));
      } finally { await fd.close(); }
      const { version, ...item } = record;
      if (version !== 1 || item.id !== name.slice(0, -5) || !['staging', 'ready', 'deleting'].includes(item.state) ||
          !Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_BYTES ||
          !Number.isSafeInteger(item.received) || item.received < 0 || item.received > item.size ||
          !Number.isSafeInteger(item.sequence) || item.sequence < 0 || !Array.isArray(item.chunks) || item.chunks.length !== item.sequence ||
          !Number.isSafeInteger(item.expiresAt) || typeof item.pinned !== 'boolean' ||
          (item.sha256 !== undefined && !validHash(item.sha256)) || (item.operationKey !== undefined && !validKey(item.operationKey)) ||
          (item.submissionId !== undefined && !idValid(item.submissionId))) throw Error('Invalid transfer metadata');
      validateUpload(item);
      if (item.chunks.some(c => !validHash(c.sha256) || !Number.isSafeInteger(c.size) || c.size < 1 || c.size > CHUNK_BYTES) ||
          (item.sequence && item.chunks.reduce((n, c) => n + c.size, 0) !== item.received)) throw Error('Invalid transfer chunk history');
      if (item.state === 'deleting') {
        await this.#unlinkOwned(join(this.#root, item.id + '.part'));
        await this.#unlinkOwned(path); this.#syncRoot(); continue;
      }
      item.path = join(this.#root, item.id + '.part'); item.busy = false;
      if (item.direction === 'download' && item.state === 'staging') item.pinned = false;
      let data;
      try { data = await this.#openOwned(item.path, constants.O_RDWR); }
      catch (error) {
        if (error.code !== 'ENOENT' || item.received || item.state !== 'staging') throw error;
        data = await open(item.path, 'wx', 0o600);
      }
      try {
        const size = (await data.stat()).size;
        if (size < item.received || (item.state === 'ready' && size !== item.size)) throw Error('Restored artifact size mismatch');
        if (item.state === 'staging' && size > item.received) { await data.truncate(item.received); await data.sync(); }
        let position = 0;
        for (const chunk of item.chunks) {
          const bytes = Buffer.alloc(chunk.size);
          const { bytesRead } = await data.read(bytes, 0, bytes.length, position);
          if (bytesRead !== bytes.length || hash(bytes) !== chunk.sha256) throw Error('Restored artifact chunk mismatch');
          position += bytes.length;
        }
      } finally { await data.close(); }
      this.#items.set(item.id, item); this.#reserved += charge(item);
      if (item.state === 'ready') { const verified = await this.#verified(item.id); await verified.close(); }
    }
  }
  #persist(item) {
    const { path, busy, ...metadata } = item;
    this.#writeManifest(join(this.#root, item.id + '.json'), { version: 1, ...metadata });
  }
  #writeManifest(destination, metadata) {
    const body = JSON.stringify(metadata);
    if (Buffer.byteLength(body) > 256 * 1024) throw Error('Transfer metadata budget exhausted; use larger chunks');
    const temporary = destination + '.' + randomBytes(8).toString('hex') + '.tmp';
    let created = false;
    try {
      const fd = openSync(temporary, 'wx', 0o600); created = true;
      try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
      try { const st = lstatSync(destination); if (!privateFile(st)) throw Error('Unsafe transfer metadata'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      renameSync(temporary, destination); this.#syncRoot(dirname(destination));
    } finally {
      if (created) try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  #syncRoot(path = this.#root) {
    if (process.platform !== 'win32') {
      const directory = openSync(path, constants.O_RDONLY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  }
  async #quarantine(name) {
    const source = join(this.#root, name), st = await lstat(source);
    // Unsafe entries are neither followed nor made resumable. Charge the full
    // budget and expose recovery diagnostics while allowing non-file work.
    if (!privateFile(st)) {
      const entry = { id: name.slice(0, -5), size: st.size, reservedBytes: this.budget, reason: 'unsafe_legacy_entry', resumable: false };
      this.#orphans.push(entry); this.#reserved += entry.reservedBytes; return;
    }
    const directory = join(this.#root, 'orphans');
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (!privateDirectory(await lstat(directory))) throw Error('Unsafe artifact recovery directory');
    let id = name.slice(0, -5);
    const occupied = new Set(await readdir(directory));
    while (occupied.has(id + '.part') || occupied.has(id + '.json')) id = randomBytes(24).toString('hex');
    const recovery = { version: 1, id, originalId: name.slice(0, -5), size: st.size,
      reservedBytes: Math.max(this.maxBytes, st.size), reason: 'legacy_metadata_missing', resumable: false };
    this.#writeManifest(join(directory, id + '.json'), recovery);
    await rename(source, join(directory, id + '.part'));
    this.#syncRoot(directory); this.#syncRoot();
  }
  async #restoreOrphans() {
    const directory = join(this.#root, 'orphans');
    let st;
    try { st = await lstat(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!privateDirectory(st)) throw Error('Unsafe artifact recovery directory');
    for (const name of await readdir(directory)) if (/^[a-f0-9]{48}\.part$/.test(name)) {
      const info = await lstat(join(directory, name));
      const entry = { version: 1, id: name.slice(0, -5), size: info.size, reservedBytes: privateFile(info) ? Math.max(this.maxBytes, info.size) : this.budget,
        reason: privateFile(info) ? 'legacy_metadata_missing' : 'unsafe_legacy_entry', resumable: false };
      const metadata = join(directory, entry.id + '.json');
      try { if (!privateFile(await lstat(metadata))) entry.metadataUnsafe = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; this.#writeManifest(metadata, entry); }
      this.#orphans.push(entry); this.#reserved += entry.reservedBytes;
    }
  }
  async #unlinkOwned(path) {
    try { if (!privateFile(await lstat(path))) throw Error('Unsafe artifact removal'); await unlink(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async #openOwned(path, flags) {
    const before = await lstat(path);
    if (!privateFile(before)) throw Error('Unsafe artifact file');
    const fd = await open(path, flags | (constants.O_NOFOLLOW ?? 0));
    try {
      const actual = await fd.stat();
      if (!privateFile(actual) || actual.ino !== before.ino || actual.dev !== before.dev) throw Error('Artifact file changed');
      return fd;
    } catch (error) { await fd.close(); throw error; }
  }
  #allocate(meta, pinned = false) {
    if (!Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size > this.maxBytes) throw Error('File exceeds transfer limit');
    if (this.#reserved + charge(meta) > this.budget) throw Error('Staging budget exhausted');
    const id = randomBytes(24).toString('hex');
    const item = { ...meta, id, path: join(this.#root, id + '.part'), received: 0, sequence: 0, last: null, chunks: [],
      state: 'staging', expiresAt: this.#now() + EXPIRES_MS, busy: false, pinned };
    this.#reserved += charge(item); this.#items.set(id, item); return item;
  }
  #get(id) {
    if (!idValid(id)) throw Error('Invalid transfer ID');
    const item = this.#items.get(id); if (!item) throw Error('Unknown transfer');
    return item;
  }
  get(id) { return snapshot(this.#get(id)); }
  subject(id) {
    const x = this.#get(id);
    return hash(JSON.stringify({ ...ownership(x), id, size: x.size, sha256: x.sha256, remotePath: x.remotePath, overwrite: x.overwrite, elevate: x.elevate }));
  }
  async begin(meta) {
    validateUpload(meta);
    if (!validHash(meta.sha256)) throw Error('Invalid file hash');
    if (meta.operationKey !== undefined && !validKey(meta.operationKey)) throw Error('Invalid operation key');
    const contract = { ...ownership(meta), fileName: meta.fileName, remotePath: meta.remotePath, size: meta.size, sha256: meta.sha256, overwrite: meta.overwrite === true, elevate: meta.elevate === true };
    if (meta.operationKey !== undefined) {
      const previous = [...this.#items.values()].find(x => x.operationKey === meta.operationKey);
      if (previous) {
        if (Object.keys(contract).some(key => previous[key] !== contract[key])) throw Error('Operation key conflicts with upload contract');
        if (this.#now() >= previous.expiresAt && !previous.pinned) throw Error('Upload operation key expired');
        return snapshot(previous);
      }
    }
    const item = this.#allocate({ ...contract, direction: 'upload' });
    try { this.#persist(item); const fd = await open(item.path, 'wx', 0o600); await fd.close(); } catch (err) { await this.remove(item.id); throw err; }
    return snapshot(item);
  }
  async append(id, sequence, bytes) {
    const x = this.#get(id);
    if (x.state !== 'staging' || this.#now() >= x.expiresAt || x.busy || x.pinned) throw Error('Transfer is not writable');
    if (!Number.isSafeInteger(sequence) || sequence < 0 || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > CHUNK_BYTES) throw Error('Invalid chunk');
    const digest = hash(bytes);
    if (sequence < x.sequence && x.chunks[sequence]?.sha256 === digest && x.chunks[sequence]?.size === bytes.length) return { sequence: x.sequence, received: x.received };
    if (sequence !== x.sequence || x.received + bytes.length > x.size) throw Error('Chunk sequence or size mismatch');
    x.busy = true;
    try {
      const fd = await this.#openOwned(x.path, constants.O_WRONLY);
      try {
        await fd.truncate(x.received);
        let offset = 0;
        while (offset < bytes.length) { const { bytesWritten } = await fd.write(bytes, offset, bytes.length - offset, x.received + offset); if (!bytesWritten) throw Error('Incomplete staging write'); offset += bytesWritten; }
        await fd.sync();
      } finally { await fd.close(); }
      const previous = { received: x.received, sequence: x.sequence, last: x.last };
      x.received += bytes.length; x.sequence++; x.last = digest; x.chunks.push({ sha256: digest, size: bytes.length });
      try { this.#persist(x); } catch (error) { Object.assign(x, previous); x.chunks.pop(); throw error; }
      return { sequence: x.sequence, received: x.received };
    } finally { x.busy = false; }
  }
  async finish(id) {
    const x = this.#get(id);
    if (x.state === 'ready' && x.pinned) return snapshot(x);
    if (x.state !== 'staging' || x.busy || this.#now() >= x.expiresAt || x.received !== x.size) throw Error('Incomplete or expired upload');
    x.busy = true;
    try {
      const fd = await this.#verified(id, false, true);
      try { await fd.sync(); } finally { await fd.close(); }
      x.state = 'ready'; x.pinned = true; this.#persist(x); x.busy = false; return snapshot(x);
    } catch (err) { await this.remove(id); throw err; } finally { x.busy = false; }
  }
  async importFile(meta, openSource, { signal } = {}) {
    validateUpload(meta); signal?.throwIfAborted();
    const item = this.#allocate({ ...ownership(meta), direction: 'upload', fileName: meta.fileName, remotePath: meta.remotePath, size: this.maxBytes,
      overwrite: meta.overwrite === true, elevate: meta.elevate === true });
    item.busy = true;
    let fd, source;
    try {
      this.#persist(item); fd = await open(item.path, 'wx', 0o600);
      source = await openSource();
      const digest = createHash('sha256'); let received = 0;
      for await (const bytes of source.stream) {
        signal?.throwIfAborted();
        if (!(bytes instanceof Uint8Array) || received + bytes.length > this.maxBytes) throw Error('Invalid or excessive source bytes');
        await fd.writeFile(bytes); digest.update(bytes); received += bytes.length;
      }
      signal?.throwIfAborted();
      if (source.expectedSize != null && received !== source.expectedSize) throw Error('Incomplete source file');
      this.#resize(item, received); item.received = received; item.sha256 = digest.digest('hex');
      await fd.close(); fd = null; item.busy = false;
      const ready = await this.finish(item.id); signal?.throwIfAborted();
      return ready;
    } catch (err) {
      try { if (fd) await fd.close(); }
      finally { await this.remove(item.id); }
      throw err;
    } finally {
      item.busy = false;
      try { await source?.close(); } catch (err) { await this.remove(item.id); throw err; }
    }
  }
  #resize(item, size) { this.#reserved += charge({ size }) - charge(item); item.size = size; }
  reserveDownload(meta) {
    validateUpload(meta);
    const item = this.#allocate({ ...ownership(meta), direction: 'download', fileName: meta.fileName, remotePath: meta.remotePath, elevate: meta.elevate === true, size: this.maxBytes }, true);
    try { this.#persist(item); } catch (error) { this.#items.delete(item.id); this.#reserved -= charge(item); throw error; }
    return snapshot(item);
  }
  async receiveDownload(id, metadata, writeTo) {
    const x = this.#get(id);
    if (!x.pinned || x.state !== 'staging' || x.busy) throw Error('Download is not writable');
    x.busy = true;
    let fd, destination, completed;
    try {
      if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > this.maxBytes || !validHash(metadata.sha256)) throw Error('Invalid snapshot metadata');
      fd = await open(x.path, 'wx', 0o600);
      // The store owns the descriptor even when a transport destroys its writable.
      let received = 0;
      destination = new Writable({ write: (bytes, _encoding, done) => {
        received += bytes.length;
        if (received > this.maxBytes) done(Error('File exceeds transfer limit'));
        else fd.writeFile(bytes).then(() => done(), done);
      } });
      completed = finished(destination, { cleanup: true });
      // Attach rejection immediately: a write may fail before writeTo settles.
      completed.catch(() => {});
      await writeTo(destination); await completed; await fd.sync();
      await fd.close(); fd = null;
      this.#resize(x, metadata.size); x.sha256 = metadata.sha256;
      const verified = await this.#verified(id, false); await verified.close();
      x.received = x.size; x.state = 'ready'; x.pinned = false; x.busy = false; x.expiresAt = this.#now() + 3_600_000;
      this.#persist(x);
      return snapshot(x);
    } catch (err) {
      destination?.destroy();
      await completed?.catch(() => {});
      try { if (fd) await fd.close(); } finally { await this.remove(id); }
      throw err;
    } finally { x.busy = false; }
  }
  releaseUpload(id, { expiresAt = this.#now() } = {}) {
    const x = this.#items.get(id); if (!x) return;
    x.pinned = false; x.expiresAt = expiresAt;
    this.#persist(x);
  }
  recordSubmission(id, submissionId) {
    const x = this.#get(id);
    if (!idValid(submissionId) || (x.submissionId && x.submissionId !== submissionId)) throw Error('Upload submission conflict');
    x.submissionId = submissionId; this.#persist(x);
  }
  verified(id) { return this.#verified(id); }
  async #verified(id, requireReady = true, writable = false) {
    const x = this.#get(id);
    if (requireReady && x.state !== 'ready') throw Error('Artifact not ready');
    const fd = await this.#openOwned(x.path, writable ? constants.O_RDWR : constants.O_RDONLY);
    try {
      const st = await fd.stat(); if (!st.isFile() || st.size !== x.size) throw Error('Artifact changed');
      const digest = createHash('sha256');
      for await (const bytes of fd.createReadStream({ autoClose: false })) digest.update(bytes);
      if (digest.digest('hex') !== x.sha256) throw Error('Artifact hash mismatch');
      return fd;
    } catch (err) { await fd.close(); throw err; }
  }
  async remove(id) {
    if (this.#removing.has(id)) return this.#removing.get(id);
    const x = this.#items.get(id); if (!x) return;
    const work = (async () => {
      this.#persist({ ...x, state: 'deleting' });
      await this.#unlinkOwned(x.path);
      await this.#unlinkOwned(join(this.#root, id + '.json')); this.#syncRoot();
      this.#items.delete(id); this.#reserved -= charge(x);
    })();
    this.#removing.set(id, work);
    try { await work; } finally { this.#removing.delete(id); }
  }
  async reap() {
    for (const x of this.#items.values()) if (!x.pinned && !x.busy && this.#now() >= x.expiresAt) await this.remove(x.id);
  }
}
