import { remotePath, windowsRemotePath } from '../domain/validation.mjs';
import { fileTargetFields, fileTargetBinding } from '../domain/file-target-binding.mjs';
import { CHUNK_BYTES } from '../contracts/ports.mjs';
import { callerContext } from '../domain/execution-context.mjs';

/** File use cases know metadata and ports; bytes never become host protocol objects. */
export function createFileService({ store, queue, transfers, platform = 'linux', maxConcurrent = 2, now = () => Date.now(), claimImport = () => () => {} }) {
  if (!['linux', 'windows'].includes(platform)) throw Error('Unsupported remote platform');
  const validate = (path, elevate) => {
    (platform === 'windows' ? windowsRemotePath : remotePath)(path);
  };
  const shutdown = new AbortController(), imports = new Set(), submissions = new Map();
  const guard = () => { if (shutdown.signal.aborted || queue.maintenance) throw Error('Maintenance or file service closed'); };
  const submittedUpload = id => queue.listAll().find(job => job.kind === 'upload' && job.operation.artifactId === id);
  const originalUpload = artifact => {
    const matches = queue.listAll().filter(job => job.kind === 'upload' && job.operation.artifactId === artifact.id);
    if (matches.length > 1) throw Error('Ambiguous upload request');
    const job = matches[0];
    if (artifact.submissionId && (!job || job.id !== artifact.submissionId || !queue.get(artifact.submissionId))) throw Error('Original upload request unavailable; do not replay');
    if (!job) return;
    const operation = job.operation, binding = fileTargetBinding(operation), identity = artifact.targetId === undefined ? queue.identity : artifact;
    if (['fileName', 'remotePath', 'size', 'sha256', 'overwrite', 'elevate', 'uploadProtocol', 'operationKey'].some(key => operation[key] !== artifact[key]) ||
        (artifact.fileTargetBound === true ? !binding || binding.targetId !== artifact.targetId || binding.targetRevision !== artifact.targetRevision : binding !== undefined) ||
        (job.targetId !== undefined && (job.targetId !== identity?.targetId || job.targetRevision !== identity?.targetRevision))) throw Error('Upload does not match original request');
    return job;
  };
  const submitUpload = artifact => {
    validate(artifact.remotePath, artifact.elevate);
    const job = queue.submitOperation({ kind: 'upload', artifactId: artifact.id, remotePath: artifact.remotePath,
      fileName: artifact.fileName, size: artifact.size, sha256: artifact.sha256, overwrite: artifact.overwrite, elevate: artifact.elevate,
      ...(artifact.fileTargetBound === true ? fileTargetFields(artifact) : {}),
      ...(artifact.uploadProtocol === 'mcp-json-v1' ? { uploadProtocol: artifact.uploadProtocol, operationKey: artifact.operationKey } : {}) }, artifact.elevate ? 'privileged' : 'safe');
    store.recordSubmission?.(artifact.id, job.id);
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
    async requestUpload({ source, fileName, remotePath: path, overwrite = false, elevate = false }, { signal, binding, verifyTarget, provenance } = {}) {
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
            ...(provenance === undefined ? {} : { provenance }),
            ...(binding ? { ...binding, fileTargetBound: true } : {}) }, () => source.open({ signal: combined }), { signal: combined });
          combined.throwIfAborted(); guard();
          if (binding) verifyTarget();
          const job = submitUpload(artifact); submitted = true;
          return { type: 'job', job };
        } finally { if (artifact && !submitted && !submittedUpload(artifact.id)) await store.remove(artifact.id); }
      })();
      imports.add(work);
      try { return await work; } finally { imports.delete(work); release(); }
    },
    requestDownload({ remotePath: path, elevate = false, context = '', displayContext = '' }, binding) {
      validate(path, elevate); guard();
      context = callerContext(context); displayContext = callerContext(displayContext);
      const job = queue.submitOperation({ kind: 'download', remotePath: path, elevate,
        ...(context ? { context } : {}), ...(displayContext ? { displayContext } : {}), ...fileTargetFields(binding) }, elevate ? 'privileged' : 'read-only');
      try { queue.startDownload(job.id); } catch (error) { if (!queue.rejectAutomaticDispatch(job.id, error)) { /* Normal policy keeps the owner request; never auto-retry. */ } }
      return queue.get(job.id);
    },
    async beginUpload(meta, binding) { validate(meta.remotePath, meta.elevate); guard(); return store.begin({ ...meta, ...(binding ? { ...binding, fileTargetBound: true } : {}) }); },
    async appendUpload({ id, sequence, bytes }) { guard(); return store.append(id, sequence, bytes); },
    async finishUpload(id, verifyTarget) {
      guard();
      // Legacy HTTP/UI completion keeps its one-shot contract. Check durable
      // submission identity before allocating another approval request.
      if (originalUpload(store.get(id))) throw Error('Upload already submitted');
      const artifact = await store.finish(id);
      try {
        guard();
        if (originalUpload(artifact)) throw Error('Upload already submitted');
        if (artifact.fileTargetBound === true) {
          if (typeof verifyTarget !== 'function') throw Error('Bound file target verifier unavailable');
          verifyTarget();
        }
        return submitUpload(artifact);
      } catch (err) { if (!submittedUpload(id)) await store.remove(id); throw err; }
    },
    beginAgentUpload(meta, binding) {
      if (!binding) throw Error('MCP upload requires a bound target');
      if (typeof meta.operationKey !== 'string' || !/^[A-Za-z0-9_.:-]{16,128}$/.test(meta.operationKey)) throw Error('MCP upload requires an operation key');
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
    async finishAgentUpload(id, verifyTarget) {
      const existing = agentUploadJob(id);
      if (existing) return existing;
      if (submissions.has(id)) return submissions.get(id);
      const artifact = agentArtifact(id);
      if (artifact.submissionId) {
        const job = queue.get(artifact.submissionId);
        if (!job || job.kind !== 'upload' || job.operation.artifactId !== id) throw Error('Original upload request unavailable; do not replay');
        return job;
      }
      const work = service.finishUpload(id, verifyTarget);
      submissions.set(id, work);
      try { return await work; } finally { submissions.delete(id); }
    },
    async readAgentDownload({ id, offsetBytes = 0, maxBytes = CHUNK_BYTES }, verifyTarget) {
      guard();
      if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > CHUNK_BYTES) throw Error('Invalid download page');
      const job = queue.get(id), result = job?.result?.data, binding = job && fileTargetBinding(job.operation);
      if (job?.kind !== 'download' || job.state !== 'completed' || job.result.failed || !binding || !result?.artifactId) throw Error('Download is not ready');
      if (typeof verifyTarget !== 'function') throw Error('Bound file target verifier unavailable');
      verifyTarget();
      const item = store.get(result.artifactId);
      if (item.fileTargetBound !== true || item.targetId !== binding.targetId || item.targetRevision !== binding.targetRevision ||
          item.remotePath !== job.operation.remotePath || item.elevate !== job.operation.elevate || item.state !== 'ready' ||
          item.size !== result.size || item.sha256 !== result.sha256 || item.fileName !== result.fileName || now() >= item.expiresAt) throw Error('Download artifact binding or retention mismatch');
      if (offsetBytes > item.size) throw Error('Download offset exceeds artifact');
      const fd = await store.verified(item.id);
      try {
        // The descriptor verified above is also the one read below; replacing the
        // path after verification cannot substitute another file into this page.
        const bytes = Buffer.alloc(Math.min(maxBytes, item.size - offsetBytes));
        let received = 0;
        while (received < bytes.length) {
          const part = await fd.read(bytes, received, bytes.length - received, offsetBytes + received);
          if (!part.bytesRead) throw Error('Download artifact changed');
          received += part.bytesRead;
        }
        verifyTarget();
        return { id, artifactId: item.id, fileName: item.fileName, encoding: 'base64', data: bytes.toString('base64'),
          offsetBytes, bytes: bytes.length, nextOffset: offsetBytes + bytes.length, totalBytes: item.size, sha256: item.sha256,
          eof: offsetBytes + bytes.length === item.size, expiresAt: item.expiresAt };
      } finally { await fd.close(); }
    },
    onTerminal(job) { if (job.operation.kind === 'upload') store.releaseUpload(job.operation.artifactId, { expiresAt: now() }); },
    busy() { return imports.size > 0; },
    reap() { return store.reap(); },
    async close() { shutdown.abort(); await Promise.allSettled([...imports]); },
  };
  return service;
}
