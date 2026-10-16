/** A target owns every allocated artifact; the backing store retains the one global quota. */
export function scopedArtifacts(store, identity) {
  const owned = id => {
    const item = store.get(id);
    if (item.targetId !== identity.targetId || item.targetRevision !== identity.targetRevision) throw Error('Artifact belongs to another target');
    return item;
  };
  return {
    maxBytes: store.maxBytes,
    get: owned,
    subject(id) { owned(id); return store.subject(id); },
    begin: meta => store.begin({ ...meta, ...identity }),
    importFile: (meta, open, options) => store.importFile({ ...meta, ...identity }, open, options),
    reserveDownload: meta => store.reserveDownload({ ...meta, ...identity }),
    append(id, sequence, bytes) { owned(id); return store.append(id, sequence, bytes); },
    finish(id) { owned(id); return store.finish(id); },
    receiveDownload(id, metadata, writeTo) { owned(id); return store.receiveDownload(id, metadata, writeTo); },
    verified(id) { owned(id); return store.verified(id); },
    remove(id) { owned(id); return store.remove(id); },
    releaseUpload(id, options) { owned(id); return store.releaseUpload(id, options); },
    reap: () => store.reap(),
  };
}
