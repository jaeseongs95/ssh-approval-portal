import { randomBytes } from 'node:crypto';
import { hash } from '../../domain/validation.mjs';
import { CHUNK_BYTES } from '../../contracts/ports.mjs';

export function createCapabilities({ queue, store, signer, settings, now = () => Date.now() }) {
  const used = new Map();
  const view = job => {
    const meta = { bridgeDisplayName: settings.bridgeDisplayName, targetDisplayName: settings.targetDisplayName, uiEnabled: settings.uiEnabled, namespace: settings.prefix, maxBytes: settings.maxBytes, chunkBytes: CHUNK_BYTES, webUrl: settings.adminOrigin };
    if (settings.uiEnabled) {
      meta.viewTicket = signer.issue('view', queue.subject(job.id), now() + 600_000);
      if (job.state === 'pending') meta.approvalTicket = signer.issue('decision', queue.subject(job.id), job.expiresAt);
    }
    return meta;
  };
  const downloadLink = (job, expiresAt = now() + 600_000) => {
    if (job?.kind !== 'download' || job.state !== 'completed') throw Error('Download is not ready');
    const item = store.get(job.result.data.artifactId), nonce = randomBytes(16).toString('hex');
    const cap = signer.issue('file', `${item.id}:${item.sha256}:${nonce}`, Math.min(expiresAt, item.expiresAt));
    return `${settings.adminOrigin}/downloads/${item.id}/${nonce}?ticket=${encodeURIComponent(cap)}`;
  };
  return {
    view, downloadLink,
    guard() { if (!settings.uiEnabled || queue.maintenance) throw Error('UI actions are disabled or maintenance is in progress'); },
    verifyJob(id, cap, purpose) { signer.verify(cap, purpose, queue.subject(id)); },
    bootstrap(transfer) { return signer.issue('bootstrap', hash(JSON.stringify(transfer)), now() + 600_000); },
    verifyBootstrap(transfer, cap) { signer.verify(cap, 'bootstrap', hash(JSON.stringify(transfer))); },
    upload(item) { return signer.issue('upload', store.subject(item.id), item.expiresAt); },
    verifyUpload(id, cap) { signer.verify(cap, 'upload', store.subject(id)); },
    claimDownload(id, nonce, cap, method) {
      const item = store.get(id);
      signer.verify(cap, 'file', `${item.id}:${item.sha256}:${nonce}`);
      if (now() >= item.expiresAt || used.has(hash(cap))) throw Error('Download unavailable');
      // Claim synchronously before verification opens a file; HEAD never consumes a URL.
      if (method === 'GET') used.set(hash(cap), now() + 600_000);
      return item;
    },
    reap() { for (const [key, expires] of used) if (now() >= expires) used.delete(key); },
  };
}
