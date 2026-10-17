import { remotePath } from '../domain/validation.mjs';

/** File use cases know metadata and ports; bytes never become host protocol objects. */
export function createFileService({ store, queue, transfers, maxConcurrent = 2, now = () => Date.now(), claimImport = () => () => {} }) {
  const shutdown = new AbortController(), imports = new Set();
  const guard = () => { if (shutdown.signal.aborted || queue.maintenance) throw Error('Maintenance or file service closed'); };
  const submitUpload = artifact => {
    const job = queue.submitOperation({ kind: 'upload', artifactId: artifact.id, remotePath: artifact.remotePath,
      fileName: artifact.fileName, size: artifact.size, sha256: artifact.sha256, overwrite: artifact.overwrite, elevate: artifact.elevate }, artifact.elevate ? 'privileged' : 'safe');
    if (!artifact.elevate && !artifact.overwrite) {
      try { queue.startUpload(job.id); } catch { /* No current policy authority or execution slot: retain the owner request. */ }
    }
    return queue.get(job.id);
  };
  return {
    async requestUpload({ source, fileName, remotePath: path, overwrite = false, elevate = false }, { signal } = {}) {
      remotePath(path); guard(); signal?.throwIfAborted();
      if (imports.size >= maxConcurrent) throw Error('File imports busy');
      const policy = source.inspect();
      if (!policy.allowed) return { type: 'source-unavailable', sourceHost: policy.sourceHost };
      const release = claimImport();
      const combined = AbortSignal.any([shutdown.signal, signal].filter(Boolean));
      const work = (async () => {
        let artifact, submitted = false;
        try {
          artifact = await store.importFile({ fileName, remotePath: path, overwrite, elevate }, () => source.open({ signal: combined }), { signal: combined });
          combined.throwIfAborted(); guard();
          const job = submitUpload(artifact); submitted = true;
          return { type: 'job', job };
        } finally { if (artifact && !submitted) await store.remove(artifact.id); }
      })();
      imports.add(work);
      try { return await work; } finally { imports.delete(work); release(); }
    },
    requestDownload({ remotePath: path, elevate = false }) {
      remotePath(path); guard();
      if (!elevate && queue.busy()) throw Error('Execution busy');
      const job = queue.submitOperation({ kind: 'download', remotePath: path, elevate }, elevate ? 'privileged' : 'read-only');
      if (!elevate) queue.start(job.id, true);
      return queue.get(job.id);
    },
    async beginUpload(meta) { guard(); return store.begin(meta); },
    async appendUpload({ id, sequence, bytes }) { guard(); return store.append(id, sequence, bytes); },
    async finishUpload(id) {
      guard(); const artifact = await store.finish(id);
      try { guard(); return submitUpload(artifact); } catch (err) { await store.remove(id); throw err; }
    },
    onTerminal(job) { if (job.operation.kind === 'upload') store.releaseUpload(job.operation.artifactId, { expiresAt: now() }); },
    busy() { return imports.size > 0; },
    reap() { return store.reap(); },
    async close() { shutdown.abort(); await Promise.allSettled([...imports]); },
  };
}
