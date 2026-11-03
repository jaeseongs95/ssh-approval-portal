import { remotePath, windowsRemotePath } from '../domain/validation.mjs';
import { fileTargetFields } from '../domain/file-target-binding.mjs';

/** File use cases know metadata and ports; bytes never become host protocol objects. */
export function createFileService({ store, queue, transfers, platform = 'linux', maxConcurrent = 2, now = () => Date.now(), claimImport = () => () => {} }) {
  if (!['linux', 'windows'].includes(platform)) throw Error('Unsupported remote platform');
  const validate = (path, elevate) => {
    (platform === 'windows' ? windowsRemotePath : remotePath)(path);
  };
  const shutdown = new AbortController(), imports = new Set();
  const guard = () => { if (shutdown.signal.aborted || queue.maintenance) throw Error('Maintenance or file service closed'); };
  const submitUpload = artifact => {
    validate(artifact.remotePath, artifact.elevate);
    const job = queue.submitOperation({ kind: 'upload', artifactId: artifact.id, remotePath: artifact.remotePath,
      fileName: artifact.fileName, size: artifact.size, sha256: artifact.sha256, overwrite: artifact.overwrite, elevate: artifact.elevate,
      ...(artifact.fileTargetBound === true ? fileTargetFields(artifact) : {}),
      ...(artifact.uploadProtocol === 'mcp-json-v1' ? { uploadProtocol: artifact.uploadProtocol } : {}) }, artifact.elevate ? 'privileged' : 'safe');
    try { queue.startUpload(job.id); } catch (error) { if (!queue.rejectAutomaticDispatch(job.id, error)) { /* Normal policy keeps the owner request. */ } }
    return queue.get(job.id);
  };
  const agentUploadJob = id => {
    const matches = queue.listAll().filter(job => job.kind === 'upload' && job.operation.artifactId === id && job.operation.uploadProtocol === 'mcp-json-v1');
    if (matches.length > 1) throw Error('Ambiguous MCP upload request');
    return matches[0];
  };
  const agentArtifact = id => {
    const item = store.get(id);
    if (item.uploadProtocol !== 'mcp-json-v1' || item.fileTargetBound !== true) throw Error('Not a bound MCP JSON upload');
    fileTargetFields(item);
    return item;
  };
  const service = {
    async requestUpload({ source, fileName, remotePath: path, overwrite = false, elevate = false }, { signal, binding, verifyTarget } = {}) {
      validate(path, elevate); guard(); signal?.throwIfAborted();
      if (binding) {
        fileTargetFields(binding);
        if (typeof verifyTarget !== 'function') throw Error('Bound file target verifier unavailable');
        verifyTarget();
      }
      if (imports.size >= maxConcurrent) throw Error('File imports busy');
      const policy = source.inspect();
      if (!policy.allowed) return { type: 'source-unavailable', sourceHost: policy.sourceHost };
      const release = claimImport();
      const combined = AbortSignal.any([shutdown.signal, signal].filter(Boolean));
      const work = (async () => {
        let artifact, submitted = false;
        try {
          artifact = await store.importFile({ fileName, remotePath: path, overwrite, elevate,
            ...(binding ? { ...binding, fileTargetBound: true } : {}) }, () => source.open({ signal: combined }), { signal: combined });
          combined.throwIfAborted(); guard();
          if (binding) verifyTarget();
          const job = submitUpload(artifact); submitted = true;
          return { type: 'job', job };
        } finally { if (artifact && !submitted) await store.remove(artifact.id); }
      })();
      imports.add(work);
      try { return await work; } finally { imports.delete(work); release(); }
    },
    requestDownload({ remotePath: path, elevate = false }, binding) {
      validate(path, elevate); guard();
      const job = queue.submitOperation({ kind: 'download', remotePath: path, elevate, ...fileTargetFields(binding) }, elevate ? 'privileged' : 'read-only');
      try { queue.startDownload(job.id); } catch (error) { if (!queue.rejectAutomaticDispatch(job.id, error)) { /* Normal policy keeps the owner request; never auto-retry. */ } }
      return queue.get(job.id);
    },
    async beginUpload(meta, binding) { validate(meta.remotePath, meta.elevate); guard(); return store.begin({ ...meta, ...(binding ? { ...binding, fileTargetBound: true } : {}) }); },
    async appendUpload({ id, sequence, bytes }) { guard(); return store.append(id, sequence, bytes); },
    async finishUpload(id, verifyTarget) {
      guard(); const artifact = await store.finish(id);
      try {
        guard();
        if (artifact.fileTargetBound === true) {
          if (typeof verifyTarget !== 'function') throw Error('Bound file target verifier unavailable');
          verifyTarget();
        }
        return submitUpload(artifact);
      } catch (err) { await store.remove(id); throw err; }
    },
    beginAgentUpload(meta, binding) {
      if (!binding) throw Error('MCP upload requires a bound target');
      fileTargetFields(binding);
      return service.beginUpload({ ...meta, uploadProtocol: 'mcp-json-v1' }, binding);
    },
    agentUploadStatus(id) {
      const job = agentUploadJob(id);
      if (job) return { state: 'submitted', job };
      const item = agentArtifact(id);
      const state = now() >= item.expiresAt ? 'expired' : item.state;
      return { state, transfer: Object.fromEntries(['id', 'received', 'sequence', 'size', 'sha256', 'expiresAt', 'targetId', 'targetRevision'].map(key => [key, item[key]])) };
    },
    appendAgentUpload(args) { agentArtifact(args.id); return service.appendUpload(args); },
    finishAgentUpload(id, verifyTarget) {
      if (agentUploadJob(id)) throw Error('MCP upload already submitted; read its status');
      agentArtifact(id);
      return service.finishUpload(id, verifyTarget);
    },
    onTerminal(job) { if (job.operation.kind === 'upload') store.releaseUpload(job.operation.artifactId, { expiresAt: now() }); },
    busy() { return imports.size > 0; },
    reap() { return store.reap(); },
    async close() { shutdown.abort(); await Promise.allSettled([...imports]); },
  };
  return service;
}
