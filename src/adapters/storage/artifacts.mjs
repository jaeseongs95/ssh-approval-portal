import { randomBytes, createHash } from 'node:crypto';
import { mkdir, lstat, readdir, unlink, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { idValid, remotePath, hash } from '../../domain/validation.mjs';
import { CHUNK_BYTES, MAX_BYTES, EXPIRES_MS } from '../../contracts/ports.mjs';

export { CHUNK_BYTES, MAX_BYTES } from '../../contracts/ports.mjs';
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validateUpload = meta => {
  remotePath(meta.remotePath);
  if (typeof meta.fileName !== 'string' || !meta.fileName || meta.fileName.length > 255 || /[\x00-\x1f\x7f/\\]/.test(meta.fileName)) throw Error('Invalid filename');
};
const snapshot = item => {
  const { path, last, ...metadata } = item;
  return Object.freeze(metadata);
};

/** Owns staging bytes, accounting and their complete lifecycle. All metadata is copied. */
export class Artifacts {
  #items = new Map();
  #removing = new Map();
  #reserved = 0;
  #root;
  #now;
  constructor(root, { maxBytes = MAX_BYTES, budget = 512 * 1024 * 1024, now = () => Date.now() } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BYTES || !Number.isSafeInteger(budget) || budget < maxBytes) throw Error('Invalid staging limits');
    this.#root = root; this.#now = now;
    Object.defineProperties(this, { maxBytes: { value: maxBytes, enumerable: true }, budget: { value: budget, enumerable: true } });
  }
  get reserved() { return this.#reserved; }
  get size() { return this.#items.size; }
  has(id) { return this.#items.has(id); }
  list() { return Object.freeze([...this.#items.values()].map(snapshot)); }
  hasActiveWork() { return [...this.#items.values()].some(x => x.busy || x.pinned || x.state === 'staging'); }
  async init() {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const s = await lstat(this.#root);
    if (!s.isDirectory() || s.isSymbolicLink() || (process.platform !== 'win32' && ((s.mode & 0o077) || s.uid !== process.getuid()))) throw Error('Transfer root must be private and owned by the service');
    // Restart invalidates IDs; only service-owned regular staging files are removed.
    for (const name of await readdir(this.#root)) if (/^[a-f0-9]{48}\.part$/.test(name)) {
      const path = join(this.#root, name), st = await lstat(path);
      if (!st.isFile() || st.isSymbolicLink() || (process.platform !== 'win32' && st.uid !== process.getuid())) throw Error('Unsafe orphan transfer entry');
      await unlink(path);
    }
  }
  #allocate(meta, pinned = false) {
    if (!Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size > this.maxBytes) throw Error('File exceeds transfer limit');
    if (this.#reserved + meta.size > this.budget || this.#items.size >= 100) throw Error('Staging budget exhausted');
    const id = randomBytes(24).toString('hex');
    const item = { ...meta, id, path: join(this.#root, id + '.part'), received: 0, sequence: 0, last: null,
      state: 'staging', expiresAt: this.#now() + EXPIRES_MS, busy: false, pinned };
    this.#reserved += meta.size; this.#items.set(id, item); return item;
  }
  #get(id) {
    if (!idValid(id)) throw Error('Invalid transfer ID');
    const item = this.#items.get(id); if (!item) throw Error('Unknown transfer');
    return item;
  }
  get(id) { return snapshot(this.#get(id)); }
  subject(id) {
    const x = this.#get(id);
    return hash(JSON.stringify({ id, size: x.size, sha256: x.sha256, remotePath: x.remotePath, overwrite: x.overwrite, elevate: x.elevate }));
  }
  async begin(meta) {
    validateUpload(meta);
    if (!validHash(meta.sha256)) throw Error('Invalid file hash');
    const item = this.#allocate({ fileName: meta.fileName, remotePath: meta.remotePath, size: meta.size, sha256: meta.sha256, overwrite: meta.overwrite === true, elevate: meta.elevate === true });
    try { const fd = await open(item.path, 'wx', 0o600); await fd.close(); } catch (err) { await this.remove(item.id); throw err; }
    return snapshot(item);
  }
  async append(id, sequence, bytes) {
    const x = this.#get(id);
    if (x.state !== 'staging' || this.#now() >= x.expiresAt || x.busy || x.pinned) throw Error('Transfer is not writable');
    if (!Number.isSafeInteger(sequence) || sequence < 0 || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > CHUNK_BYTES) throw Error('Invalid chunk');
    const digest = hash(bytes);
    if (sequence === x.sequence - 1 && x.last === digest) return { sequence: x.sequence, received: x.received };
    if (sequence !== x.sequence || x.received + bytes.length > x.size) throw Error('Chunk sequence or size mismatch');
    x.busy = true;
    try {
      const fd = await open(x.path, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
      try {
        let offset = 0;
        while (offset < bytes.length) { const { bytesWritten } = await fd.write(bytes, offset, bytes.length - offset); if (!bytesWritten) throw Error('Incomplete staging write'); offset += bytesWritten; }
      } finally { await fd.close(); }
      x.received += bytes.length; x.sequence++; x.last = digest;
      return { sequence: x.sequence, received: x.received };
    } finally { x.busy = false; }
  }
  async finish(id) {
    const x = this.#get(id);
    if (x.state !== 'staging' || x.busy || this.#now() >= x.expiresAt || x.received !== x.size) throw Error('Incomplete or expired upload');
    x.busy = true;
    try {
      const fd = await this.#verified(id, false, true);
      try { await fd.sync(); } finally { await fd.close(); }
      x.state = 'ready'; x.pinned = true; x.busy = false; return snapshot(x);
    } catch (err) { await this.remove(id); throw err; } finally { x.busy = false; }
  }
  async importFile(meta, openSource, { signal } = {}) {
    validateUpload(meta); signal?.throwIfAborted();
    const item = this.#allocate({ fileName: meta.fileName, remotePath: meta.remotePath, size: this.maxBytes,
      overwrite: meta.overwrite === true, elevate: meta.elevate === true });
    item.busy = true;
    let fd, source;
    try {
      fd = await open(item.path, 'wx', 0o600);
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
  #resize(item, size) { this.#reserved -= item.size - size; item.size = size; }
  reserveDownload(meta) {
    validateUpload(meta);
    return snapshot(this.#allocate({ fileName: meta.fileName, remotePath: meta.remotePath, elevate: meta.elevate === true, size: this.maxBytes }, true));
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
  }
  verified(id) { return this.#verified(id); }
  async #verified(id, requireReady = true, writable = false) {
    const x = this.#get(id);
    if (requireReady && x.state !== 'ready') throw Error('Artifact not ready');
    const fd = await open(x.path, (writable ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0));
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
      await unlink(x.path).catch(err => { if (err.code !== 'ENOENT') throw err; });
      this.#items.delete(id); this.#reserved -= x.size;
    })();
    this.#removing.set(id, work);
    try { await work; } finally { this.#removing.delete(id); }
  }
  async reap() {
    for (const x of this.#items.values()) if (!x.pinned && !x.busy && this.#now() >= x.expiresAt) await this.remove(x.id);
  }
}
