import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { SftpClient } from 'ssh-mcp/build/ssh/sftp.js';
import { remotePath } from './core.mjs';

export class Transfers {
  constructor(registry, artifacts, { helper = '/usr/local/libexec/ssh-approval-file-helper', remoteStage = '/var/lib/ssh-approval-transfer/incoming', readProfile = 'aws-readonly', writeProfile = 'aws-local' } = {}) {
    if (!/^\/[A-Za-z0-9_./-]+$/.test(helper) || !/^\/[A-Za-z0-9_./-]+$/.test(remoteStage)) throw Error('Invalid installed helper paths');
    Object.assign(this, { registry, artifacts, helper, remoteStage, readProfile, writeProfile });
  }
  async call(conn, action, op) {
    const command = `${op.elevate ? 'sudo -n ' : ''}${this.helper}`;
    const result = await conn.exec(command, { stdin: JSON.stringify({ action, id: op.artifactId, remotePath: op.remotePath, overwrite: op.overwrite, sha256: op.sha256, size: op.size, maxBytes: this.artifacts.maxBytes }), timeoutMs: conn.profile.transferTimeoutMs });
    if (result.exitCode !== 0 || result.signal) throw Error('Remote helper failed');
    const data = JSON.parse(result.stdout);
    if (data.error) throw Error('Remote helper refused operation');
    return data;
  }
  async upload(op) {
    const item = this.artifacts.get(op.artifactId);
    if (item.sha256 !== op.sha256 || item.size !== op.size || item.remotePath !== op.remotePath || item.overwrite !== op.overwrite || item.elevate !== op.elevate) throw Error('Upload does not match frozen operation');
    const conn = await this.registry.getOrCreate(this.writeProfile);
    const fd = await this.artifacts.verified(item.id);
    const sftp = new SftpClient(conn);
    const staged = { ...op, artifactId: item.id };
    try {
      // All remote bytes are staged only after approval; final publication is by the helper.
      await sftp.uploadFile(fd.createReadStream({ start: 0, autoClose: false }), `${this.remoteStage}/${item.id}.part`, {
        maxBytes: this.artifacts.maxBytes, idleTimeoutMs: conn.profile.transferTimeoutMs, overwrite: false, mode: 0o600,
      });
      const result = await this.call(conn, 'publish', staged);
      return { content: [{ type: 'text', text: 'Upload completed' }], structuredContent: result };
    } finally {
      await fd.close();
      await this.call(conn, 'cleanup', { ...staged, elevate: false }).catch(() => {});
    }
  }
  async download(op) {
    remotePath(op.remotePath);
    const item = this.artifacts.allocate({ size: this.artifacts.maxBytes, fileName: basename(op.remotePath), remotePath: op.remotePath, elevate: op.elevate });
    item.pinned = true;
    let conn;
    const staged = { ...op, artifactId: item.id };
    try {
      conn = await this.registry.getOrCreate(op.elevate ? this.writeProfile : this.readProfile);
      const snapshot = await this.call(conn, 'snapshot', staged);
      if (!Number.isSafeInteger(snapshot.size) || snapshot.size < 0 || snapshot.size > this.artifacts.maxBytes || !/^[a-f0-9]{64}$/.test(snapshot.sha256)) throw Error('Invalid snapshot metadata');
      const fd = await open(item.path, 'wx', 0o600);
      try {
        // Numeric fd stream owns no FileHandle reference: close() must not wait on a finished stream.
        await new SftpClient(conn).downloadFile(`${this.remoteStage}/${item.id}.part`, createWriteStream(item.path, { fd: fd.fd, autoClose: false }), { maxBytes: this.artifacts.maxBytes, idleTimeoutMs: conn.profile.transferTimeoutMs });
        await fd.sync();
      } finally { await fd.close(); }
      const digest = createHash('sha256'); let size = 0;
      for await (const bytes of createReadStream(item.path)) { digest.update(bytes); size += bytes.length; }
      if (size !== snapshot.size || digest.digest('hex') !== snapshot.sha256) throw Error('Download hash mismatch');
      this.artifacts.reserved -= item.size - size;
      Object.assign(item, { size, sha256: snapshot.sha256, state: 'ready', pinned: false, expiresAt: this.artifacts.now() + 3_600_000 });
      return { content: [{ type: 'text', text: 'Download ready; use the file card to save it.' }], structuredContent: { artifactId: item.id, fileName: item.fileName, size, sha256: item.sha256 } };
    } catch (err) { await this.artifacts.remove(item.id); throw err; }
    finally { if (conn) await this.call(conn, 'cleanup', { ...staged, elevate: false }).catch(() => {}); }
  }
}
