import { randomBytes } from 'node:crypto';
import { hash } from '../../domain/validation.mjs';
import { fileTargetBinding } from '../../domain/file-target-binding.mjs';
import { CHUNK_BYTES } from '../../contracts/ports.mjs';

export function createCapabilities({ queue, store, signer, settings, targets, adminAuthMode = 'token', now = () => Date.now() }) {
  const used = new Map(), epoch = randomBytes(24).toString('hex');
  const bound = (subject, target) => targets ? hash(JSON.stringify({ epoch, subject, identity: targets.select(target).identity })) : subject;
  const boundFile = (subject, item) => {
    if (item.fileTargetBound !== true) return bound(subject, item.targetId);
    if (!targets) throw Error('Bound file target unavailable');
    targets.artifactOwner(item.id);
    return hash(JSON.stringify({ epoch, subject, identity: { targetId: item.targetId, targetRevision: item.targetRevision } }));
  };
  const view = job => {
    const meta = { bridgeDisplayName: settings.bridgeDisplayName, targetDisplayName: job.targetDisplayName ?? settings.targetDisplayName, ...(job.targetId ? { targetId: job.targetId, targetRevision: job.targetRevision } : {}), uiEnabled: settings.uiEnabled, namespace: settings.prefix, maxBytes: settings.maxBytes, chunkBytes: CHUNK_BYTES, webUrl: settings.adminOrigin, downloadRequiresLogin: ['access', 'oidc'].includes(adminAuthMode) };
    if (settings.uiEnabled) {
      meta.viewTicket = signer.issue('view', queue.subject(job.id), now() + 600_000);
      if (job.state === 'pending') meta.approvalTicket = signer.issue('decision', queue.subject(job.id), job.expiresAt);
    }
    return meta;
  };
  const downloadLink = (job, expiresAt = now() + 600_000) => {
    if (job?.kind !== 'download' || job.state !== 'completed') throw Error('Download is not ready');
    const item = store.get(job.result.data.artifactId), nonce = randomBytes(16).toString('hex');
    const binding = fileTargetBinding(job.operation);
    if (binding ? item.fileTargetBound !== true || item.targetId !== binding.targetId || item.targetRevision !== binding.targetRevision : item.fileTargetBound === true) throw Error('Download does not match bound operation');
    if (job.targetId && (item.targetId !== job.targetId || item.targetRevision !== job.targetRevision)) throw Error('Download belongs to another target');
    const cap = signer.issue('file', boundFile(`${item.id}:${item.sha256}:${nonce}`, item), Math.min(expiresAt, item.expiresAt));
    return `${settings.adminOrigin}/downloads/${item.id}/${nonce}?ticket=${encodeURIComponent(cap)}`;
  };
  return {
    view, downloadLink,
    guard() { if (!settings.uiEnabled || queue.maintenance) throw Error('UI actions are disabled or maintenance is in progress'); },
    verifyJob(id, cap, purpose) { signer.verify(cap, purpose, queue.subject(id)); },
    bootstrap(transfer) { return signer.issue('bootstrap', bound(hash(JSON.stringify(transfer)), transfer.target), now() + 600_000); },
    verifyBootstrap(transfer, cap) { signer.verify(cap, 'bootstrap', bound(hash(JSON.stringify(transfer)), transfer.target)); },
    upload(item) { return signer.issue('upload', store.subject(item.id), item.expiresAt); },
    verifyUpload(id, cap) { signer.verify(cap, 'upload', store.subject(id)); },
    claimDownload(id, nonce, cap, method) {
      const item = store.get(id);
      signer.verify(cap, 'file', boundFile(`${item.id}:${item.sha256}:${nonce}`, item));
      if (now() >= item.expiresAt || used.has(hash(cap))) throw Error('Download unavailable');
      // Claim synchronously before verification opens a file; HEAD never consumes a URL.
      if (method === 'GET') used.set(hash(cap), now() + 600_000);
      return item;
    },
    reap() { for (const [key, expires] of used) if (now() >= expires) used.delete(key); },
  };
}
