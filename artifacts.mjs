import { randomBytes, createHash } from 'node:crypto';
import { mkdir, lstat, readdir, unlink, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { idValid, remotePath, hash } from './core.mjs';

export const CHUNK_BYTES = 256 * 1024;
export const MAX_BYTES = 64 * 1024 * 1024;
export class Artifacts {
  constructor(root, { maxBytes = MAX_BYTES, budget = 512 * 1024 * 1024, now = () => Date.now() } = {}) {
    Object.assign(this, { root, maxBytes, budget, now }); this.items = new Map(); this.reserved = 0;
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const s = await lstat(this.root);
    if (!s.isDirectory() || s.isSymbolicLink() || (process.platform !== 'win32' && ((s.mode & 0o077) || s.uid !== process.getuid()))) throw Error('Transfer root must be private and owned by the service');
    // Reboot intentionally invalidates all old IDs. Remove only our regular files.
    for (const name of await readdir(this.root)) if (/^[a-f0-9]{48}\.part$/.test(name)) {
      const path = join(this.root, name), st = await lstat(path);
      if (!st.isFile() || st.isSymbolicLink() || (process.platform !== 'win32' && st.uid !== process.getuid())) throw Error('Unsafe orphan transfer entry');
      await unlink(path);
    }
  }
  allocate(meta) {
    if (!Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size > this.maxBytes) throw Error('File exceeds transfer limit');
    if (this.reserved + meta.size > this.budget || this.items.size >= 100) throw Error('Staging budget exhausted');
    const id = randomBytes(24).toString('hex');
    const item = { ...meta, id, path: join(this.root, id + '.part'), received: 0, sequence: 0, last: null,
      state: 'staging', expiresAt: this.now() + 600_000, busy: false, pinned: false };
    this.reserved += meta.size; this.items.set(id, item); return item;
  }
  async begin(meta) {
    remotePath(meta.remotePath);
    if (typeof meta.fileName !== 'string' || !meta.fileName || meta.fileName.length > 255 || /[\x00-\x1f\x7f/\\]/.test(meta.fileName)) throw Error('Invalid filename');
    if (!/^[a-f0-9]{64}$/.test(meta.sha256)) throw Error('Invalid file hash');
    const item = this.allocate({ fileName: meta.fileName, remotePath: meta.remotePath, size: meta.size, sha256: meta.sha256, overwrite: meta.overwrite === true, elevate: meta.elevate === true });
    try { const fd = await open(item.path, 'wx', 0o600); await fd.close(); } catch (err) { await this.remove(item.id); throw err; }
    return item;
  }
  get(id) {
    if (!idValid(id)) throw Error('Invalid transfer ID');
    const item = this.items.get(id); if (!item) throw Error('Unknown transfer');
    return item;
  }
  subject(id) {
    const x = this.get(id);
    return hash(JSON.stringify({ id, size: x.size, sha256: x.sha256, remotePath: x.remotePath, overwrite: x.overwrite, elevate: x.elevate }));
  }
  async chunk(id, sequence, data) {
    const x = this.get(id);
    if (x.state !== 'staging' || this.now() >= x.expiresAt || x.busy) throw Error('Transfer is not writable');
    if (!Number.isSafeInteger(sequence) || sequence < 0 || typeof data !== 'string' || data.length > Math.ceil(CHUNK_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw Error('Invalid chunk');
    const bytes = Buffer.from(data, 'base64'), digest = hash(bytes);
    if (!bytes.length || bytes.length > CHUNK_BYTES) throw Error('Invalid chunk size');
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
    const x = this.get(id);
    if (x.state !== 'staging' || x.busy || this.now() >= x.expiresAt || x.received !== x.size) throw Error('Incomplete or expired upload');
    x.busy = true;
    try {
      const fd = await this.verified(id, false, true);
      try { await fd.sync(); } finally { await fd.close(); }
      x.state = 'ready'; x.pinned = true; return x;
    } catch (err) { await this.remove(id); throw err; } finally { x.busy = false; }
  }
  async verified(id, requireReady = true, writable = false) {
    const x = this.get(id);
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
    const x = this.items.get(id); if (!x) return;
    await unlink(x.path).catch(err => { if (err.code !== 'ENOENT') throw err; });
    this.items.delete(id); this.reserved -= x.size;
  }
  async reap() {
    for (const x of this.items.values()) if (!x.pinned && !x.busy && this.now() >= x.expiresAt) await this.remove(x.id);
  }
}
