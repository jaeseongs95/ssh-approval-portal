import { posix } from 'node:path';
import { remotePath } from '../../domain/validation.mjs';
import { createSshTransport } from './vendor.mjs';

export class Transfers {
  constructor(registry, store, { helper = '/usr/local/libexec/ssh-approval-file-helper', remoteStage = '/var/lib/ssh-approval-transfer/incoming', readProfile = 'aws-readonly', writeProfile = 'aws-local', transport = createSshTransport(registry) } = {}) {
    if (!/^\/[A-Za-z0-9_./-]+$/.test(helper) || !/^\/[A-Za-z0-9_./-]+$/.test(remoteStage)) throw Error('Invalid installed helper paths');
    Object.assign(this, { store, helper, remoteStage, readProfile, writeProfile, transport });
  }
  async call(session, action, op) {
    const command = `${op.elevate ? 'sudo -n ' : ''}${this.helper}`;
    const result = await session.call(command, { action, id: op.artifactId, remotePath: op.remotePath, overwrite: op.overwrite, sha256: op.sha256, size: op.size, maxBytes: this.store.maxBytes });
    if (result.exitCode !== 0 || result.signal) throw Error('Remote helper failed');
    const data = JSON.parse(result.stdout);
    if (!data || typeof data !== 'object' || data.error) throw Error('Remote helper refused operation');
    return data;
  }
  async upload(op) {
    const item = this.store.get(op.artifactId);
    if (item.sha256 !== op.sha256 || item.size !== op.size || item.remotePath !== op.remotePath || item.overwrite !== op.overwrite || item.elevate !== op.elevate) throw Error('Upload does not match frozen operation');
    const session = await this.transport.connect(this.writeProfile);
    const fd = await this.store.verified(item.id);
    const staged = { ...op, artifactId: item.id };
    try {
      // Approval has already reserved execution; the helper alone publishes the destination.
      await session.upload(fd.createReadStream({ start: 0, autoClose: false }), `${this.remoteStage}/${item.id}.part`, { maxBytes: this.store.maxBytes });
      const data = await this.call(session, 'publish', staged);
      return { failed: false, texts: ['Upload completed'], data };
    } finally {
      try { await fd.close(); }
      finally { await this.call(session, 'cleanup', { ...staged, elevate: false }).catch(() => {}); }
    }
  }
  async download(op) {
    remotePath(op.remotePath);
    const item = this.store.reserveDownload({ fileName: posix.basename(op.remotePath), remotePath: op.remotePath, elevate: op.elevate });
    let session;
    const staged = { ...op, artifactId: item.id };
    try {
      session = await this.transport.connect(op.elevate ? this.writeProfile : this.readProfile);
      const metadata = await this.call(session, 'snapshot', staged);
      const ready = await this.store.receiveDownload(item.id, metadata, destination => session.download(`${this.remoteStage}/${item.id}.part`, destination, { maxBytes: this.store.maxBytes }));
      return { failed: false, texts: ['Download ready; use the file card to save it.'], data: { artifactId: ready.id, fileName: ready.fileName, size: ready.size, sha256: ready.sha256 } };
    } catch (err) { await this.store.remove(item.id); throw err; }
    finally { if (session) await this.call(session, 'cleanup', { ...staged, elevate: false }).catch(() => {}); }
  }
}

export const createTransferExecutor = (registry, store, options) => new Transfers(registry, store, options);
