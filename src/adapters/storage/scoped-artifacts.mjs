/** A target owns every allocated artifact; the backing store retains the one global quota. */
export function scopedArtifacts(store, identity) {
  const cleanedDownloads = new Set();
  const verifyOwner = item => {
    if (item.targetId !== identity.targetId || item.targetRevision !== identity.targetRevision) throw Error('Artifact belongs to another target');
    return item;
  };
  const owned = id => verifyOwner(store.get(id));
  return {
    maxBytes: store.maxBytes,
    get: owned,
    subject(id) { owned(id); return store.subject(id); },
    begin: meta => store.begin({ ...meta, ...identity }),
    importFile: (meta, open, options) => store.importFile({ ...meta, ...identity }, open, options),
    reserveDownload: meta => store.reserveDownload({ ...meta, ...identity }),
    append(id, sequence, bytes) { owned(id); return store.append(id, sequence, bytes); },
    finish(id) { owned(id); return store.finish(id); },
    recordSubmission(id, submissionId) { owned(id); return store.recordSubmission(id, submissionId); },
    async receiveDownload(id, metadata, writeTo) {
      owned(id);
      try { return await store.receiveDownload(id, metadata, writeTo); }
      catch (error) {
        // The backing receiver removes its own failed download before throwing.
        if (!store.has(id)) cleanedDownloads.add(id);
        throw error;
      }
    },
    verified(id) { owned(id); return store.verified(id); },
    remove(id) { if (cleanedDownloads.delete(id)) return; owned(id); return store.remove(id); },
    releaseUpload(id, options) { return store.releaseUpload(id, options, verifyOwner); },
    reap: () => store.reap(),
  };
}
