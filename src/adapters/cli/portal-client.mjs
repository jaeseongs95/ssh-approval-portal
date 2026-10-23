import { withUploadSnapshot, saveDownload } from './local-files.mjs';
import { CHUNK_BYTES, OUTPUT_PAGE_BYTES, MAX_BYTES } from '../../contracts/ports.mjs';
import { createHash } from 'node:crypto';
import { validateOrigin } from '../config/settings.mjs';

const fail = (code, details = {}) => Object.assign(new Error(code), { code, ...details });
const identifier = value => { if (typeof value !== 'string' || !/^[a-f0-9]{48}$/.test(value)) throw fail('INVALID_REQUEST_ID'); return value; };
const jobStates = new Set(['pending', 'evaluating', 'running', 'completed', 'failed', 'denied', 'expired', 'unknown']);
export function validateUploadExpectation(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, 'size') || !Object.hasOwn(value, 'sha256')) throw fail('INVALID_UPLOAD_EXPECTATION');
  const { size, sha256 } = value;
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw fail('INVALID_UPLOAD_EXPECTATION');
  return Object.freeze({ size, sha256 });
}
export function validateOutputOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['offsetBytes', 'maxBytes', 'format'].includes(key))) throw fail('INVALID_OUTPUT_OPTIONS');
  const { offsetBytes = 0, maxBytes = 4096, format = 'text' } = options;
  if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > OUTPUT_PAGE_BYTES || !['text', 'json'].includes(format)) throw fail('INVALID_OUTPUT_OPTIONS');
  return { offsetBytes, maxBytes, format };
}
const captured = value => value?.version === 1 && value.captureSource === 'redacted-adapter-outcome' && value.sshCompleteness === 'unknown';
async function readJson(response) {
  if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw fail('INVALID_PORTAL_RESPONSE');
  const parts = []; let size = 0;
  for await (const bytes of response.body) {
    size += bytes.length;
    if (size > 1024 * 1024) { await response.body.cancel?.().catch(() => {}); throw fail('PORTAL_RESPONSE_TOO_LARGE'); }
    parts.push(bytes);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); }
  catch { throw fail('INVALID_PORTAL_RESPONSE'); }
}

/** Access user JWT comes from an explicit private input, never a service/admin token.
 * Existing server owner verification remains authoritative on EVERY request.
 * fetch injection is for isolated tests/embedders, not a CLI insecure-TLS option. */
export function createPortalClient({ origin, accessToken, signal, timeoutMs = 120_000, fetch: send = globalThis.fetch }) {
  validateOrigin(origin);
  if (typeof accessToken !== 'string' || accessToken.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken)) throw fail('INVALID_ACCESS_CREDENTIAL');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw fail('INVALID_DEADLINE');
  const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), signal].filter(Boolean));
  let cookie, connected = false, retired = false;
  async function response(path, body) {
    if (retired) throw fail('CLIENT_CLOSED');
    const url = new URL(path, origin);
    if (url.origin !== origin || url.username || url.password || url.hash) throw fail('UNTRUSTED_PORTAL_URL');
    try {
      const r = await send(url.href, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: deadline,
        headers: { 'cf-access-token': accessToken, Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!r.ok) { await r.body?.cancel().catch(() => {}); throw fail(r.status === 401 ? 'OWNER_REAUTH_REQUIRED' : 'PORTAL_REQUEST_REFUSED', { status: r.status }); }
      return r;
    } catch (error) {
      if (['OWNER_REAUTH_REQUIRED', 'PORTAL_REQUEST_REFUSED'].includes(error.code)) throw error;
      throw fail(body === undefined ? 'PORTAL_READ_FAILED' : 'PORTAL_RESULT_UNKNOWN');
    }
  }
  const json = async (path, body) => readJson(await response(path, body));
  function ready() { if (!connected || retired) throw fail('OWNER_SESSION_REQUIRED'); }
  async function knownJob(id) {
    ready(); identifier(id);
    const job = await json('/api/' + id);
    if (job.id !== id || !jobStates.has(job.state)) throw fail('REQUEST_UNAVAILABLE', { requestId: id });
    return job;
  }
  async function sendUpload(snapshot, transferId, received = 0, sequence = 0) {
    const start = received; let position = 0;
    for await (const bytes of snapshot.chunks()) {
      const skip = Math.min(bytes.length, Math.max(0, start - position));
      position += bytes.length;
      const remaining = bytes.subarray(skip);
      if (!remaining.length) continue;
      const ack = await json('/api/files/uploads/' + transferId + '/chunks', { sequence, data: remaining.toString('base64') });
      received += remaining.length;
      if (ack.sequence !== ++sequence || ack.received !== received) throw fail('INVALID_TRANSFER_ACK');
    }
    if (received !== snapshot.size) throw fail('INVALID_TRANSFER_ACK');
    const job = await json('/api/files/uploads/' + transferId + '/finish', {});
    if (job.kind !== 'upload' || job.operation?.artifactId !== transferId || job.operation.sha256 !== snapshot.sha256 || job.operation.size !== snapshot.size) throw fail('INVALID_TRANSFER_ACK');
    return job;
  }
  return {
    async connect() {
      if (connected || retired) throw fail('OWNER_SESSION_ALREADY_USED');
      if ((await json('/api/session')).mode !== 'access') throw fail('ACCESS_MODE_REQUIRED');
      const r = await response('/api/session/start', {});
      const candidates = r.headers.getSetCookie().filter(value => value.startsWith('__Host-ssh_admin_session='));
      if (candidates.length !== 1 || !/^__Host-ssh_admin_session=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=[1-9][0-9]*$/.test(candidates[0])) throw fail('INVALID_OWNER_SESSION');
      if ((await readJson(r)).connected !== true) throw fail('INVALID_OWNER_SESSION');
      cookie = candidates[0].split(';')[0]; connected = true;
      return { connected: true, mode: 'access' };
    },
    async close() {
      try { if (connected && !retired) await json('/api/session/logout', {}); }
      finally { retired = true; connected = false; cookie = undefined; accessToken = undefined; }
    },
    targets() { ready(); return json('/api/targets'); },
    pending() { ready(); return json('/api/pending'); },
    status: knownJob,
    async output(id, options) {
      identifier(id);
      const { offsetBytes, maxBytes, format } = validateOutputOptions(options);
      let outputId;
      try {
        const job = await knownJob(id), ref = job.result?.structuredContent?.output;
        if (job.kind !== 'command' || !['completed', 'failed'].includes(job.state) || !captured(ref) || ref.executionId !== id ||
            !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || !Number.isSafeInteger(ref.snapshotBytes) || ref.snapshotBytes < 0 ||
            typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw fail('OUTPUT_NOT_READY');
        outputId = identifier(ref.id);
        if (ref.state !== 'ready' || !Number.isSafeInteger(ref.expiresAt) || ref.expiresAt <= Date.now()) throw fail('OUTPUT_NOT_READY');
        const total = format === 'text' ? ref.bytes : ref.snapshotBytes;
        if (offsetBytes > total) throw fail('INVALID_OUTPUT_OPTIONS');
        const query = new URLSearchParams({ offset: String(offsetBytes), limit: String(maxBytes), format });
        const page = await json('/api/outputs/' + outputId + '?' + query);
        if (!captured(page) || page.outputId !== outputId || page.executionId !== id || page.format !== format ||
            page.offsetBytes !== offsetBytes || page.totalBytes !== total || typeof page.text !== 'string' || !page.text.isWellFormed() ||
            page.bytes !== Buffer.byteLength(page.text) || page.bytes > maxBytes || page.nextOffset !== offsetBytes + page.bytes ||
            page.nextOffset > total || typeof page.eof !== 'boolean' || page.eof !== (page.nextOffset === total) || (!page.eof && page.bytes === 0) ||
            page.expiresAt !== ref.expiresAt || page.expiresAt <= Date.now() || typeof page.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(page.sha256) ||
            (format === 'json' && page.sha256 !== ref.sha256)) throw fail('INVALID_OUTPUT_RESPONSE');
        const wholeSha256Verified = offsetBytes === 0 && page.eof;
        if (wholeSha256Verified && createHash('sha256').update(page.text).digest('hex') !== page.sha256) throw fail('INVALID_OUTPUT_RESPONSE');
        return { ...Object.fromEntries(['text', 'version', 'captureSource', 'sshCompleteness', 'outputId', 'executionId', 'format', 'offsetBytes', 'bytes', 'nextOffset', 'eof', 'totalBytes', 'sha256', 'expiresAt'].map(key => [key, page[key]])), wholeSha256Verified };
      } catch (error) { throw fail(error.code ?? 'OUTPUT_READ_FAILED', { requestId: id, ...(outputId ? { outputId } : {}) }); }
    },
    transfer(id) { ready(); identifier(id); return json('/api/files/uploads/' + id); },
    async decide(id, action, confirm) {
      if (confirm !== true || !['approve', 'deny'].includes(action)) throw fail('EXPLICIT_OWNER_DECISION_REQUIRED');
      const job = await knownJob(id);
      if (job.state !== 'pending') return job; // Observe terminal/unknown; never replay.
      try { return await json('/api/' + id + '/' + action, {}); }
      catch (error) { throw fail(error.code ?? 'PORTAL_RESULT_UNKNOWN', { requestId: id, phase: action }); }
    },
    async requestDownload(args) { ready(); return json('/api/files/downloads', args); },
    async upload(source, args, onTransfer = () => {}, expectedSource) {
      ready(); const expected = validateUploadExpectation(expectedSource); let transferId;
      try {
        return await withUploadSnapshot(source, async snapshot => {
          if (expected && (snapshot.size !== expected.size || snapshot.sha256 !== expected.sha256)) throw fail('UPLOAD_SOURCE_MISMATCH');
          const begin = await json('/api/files/uploads', { ...args, fileName: snapshot.fileName, size: snapshot.size, sha256: snapshot.sha256 });
          transferId = identifier(begin.transferId); await onTransfer({ transferId });
          return sendUpload(snapshot, transferId);
        }, { signal: deadline });
      } catch (error) {
        throw fail(['UPLOAD_SOURCE_MISMATCH', 'INVALID_TRANSFER_ACK', 'OWNER_REAUTH_REQUIRED', 'PORTAL_REQUEST_REFUSED'].includes(error.code) ? error.code : 'UPLOAD_RESULT_UNKNOWN', { ...(transferId ? { transferId } : {}), phase: 'upload' });
      }
    },
    async resumeUpload(id, source, intent) {
      ready(); identifier(id);
      try {
        if (!intent || typeof intent !== 'object' || Array.isArray(intent) ||
            Object.keys(intent).some(key => !['remotePath', 'target', 'overwrite', 'elevate'].includes(key)) ||
            typeof intent.remotePath !== 'string' || !intent.remotePath ||
            (intent.target !== undefined && (typeof intent.target !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(intent.target))) ||
            ['overwrite', 'elevate'].some(key => intent[key] !== undefined && typeof intent[key] !== 'boolean')) throw fail('INVALID_RESUME_INTENT');
        const listed = await json('/api/targets'), target = intent.target ?? listed.defaultTarget;
        const selectedTarget = Array.isArray(listed.targets) ? listed.targets.find(item => item?.id === target) : null;
        if (typeof target !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(target) ||
            !selectedTarget || typeof selectedTarget.enabled !== 'boolean') throw fail('INVALID_RESUME_INTENT');
        return await withUploadSnapshot(source, async snapshot => {
          const record = await json('/api/files/uploads/' + id);
          if (!record || typeof record !== 'object' || Array.isArray(record) || Object.hasOwn(record, 'job') === Object.hasOwn(record, 'transfer')) throw fail('UPLOAD_NOT_RESUMABLE');
          const isJob = Object.hasOwn(record, 'job'), item = isJob ? record.job?.operation : record.transfer, binding = isJob ? record.job : item;
          if (isJob ? record.job?.kind !== 'upload' || item?.kind !== 'upload' || item.artifactId !== id || !jobStates.has(record.job.state) : item?.id !== id) throw fail('UPLOAD_NOT_RESUMABLE');
          if (item.size !== snapshot.size || item.sha256 !== snapshot.sha256) throw fail('RESUME_SOURCE_MISMATCH');
          if (item.remotePath !== intent.remotePath || item.overwrite !== (intent.overwrite ?? false) || item.elevate !== (intent.elevate ?? false) ||
              (binding.targetId === undefined ? 'default' : binding.targetId) !== target) throw fail('RESUME_INTENT_MISMATCH');
          if (isJob) { identifier(record.job.id); return record.job; } // Same job, every state: observe only.
          if (selectedTarget.enabled !== true || item.state !== 'staging' || !Number.isSafeInteger(item.expiresAt) || item.expiresAt <= Date.now() ||
              !Number.isSafeInteger(item.received) || item.received < 0 || item.received > item.size ||
              !Number.isSafeInteger(item.sequence) || item.sequence < Math.ceil(item.received / CHUNK_BYTES) || item.sequence > item.received) throw fail('UPLOAD_NOT_RESUMABLE');
          const job = await sendUpload(snapshot, id, item.received, item.sequence);
          if (job.operation.remotePath !== intent.remotePath || job.operation.overwrite !== (intent.overwrite ?? false) ||
              job.operation.elevate !== (intent.elevate ?? false) || (job.targetId === undefined ? 'default' : job.targetId) !== target) throw fail('INVALID_TRANSFER_ACK');
          return job;
        }, { signal: deadline });
      } catch (error) {
        const known = ['INVALID_RESUME_INTENT', 'RESUME_SOURCE_MISMATCH', 'RESUME_INTENT_MISMATCH', 'UPLOAD_NOT_RESUMABLE', 'INVALID_TRANSFER_ACK', 'OWNER_REAUTH_REQUIRED', 'PORTAL_REQUEST_REFUSED'];
        throw fail(known.includes(error.code) ? error.code : 'UPLOAD_RESULT_UNKNOWN', { transferId: id, phase: 'resume-upload' });
      }
    },
    async save(id, destination) {
      const job = await knownJob(id);
      const metadata = job.result?.structuredContent;
      if (job.kind !== 'download' || job.state !== 'completed' || job.result?.isError || !metadata) throw fail('DOWNLOAD_NOT_READY', { requestId: id });
      identifier(metadata.artifactId);
      const { downloadUrl } = await json('/api/' + id + '/download', {});
      let url;
      try { url = new URL(downloadUrl); } catch { throw fail('UNTRUSTED_DOWNLOAD_URL'); }
      if (url.origin !== origin || url.username || url.password || url.hash ||
          !new RegExp('^/downloads/' + metadata.artifactId + '/[a-f0-9]{32}$').test(url.pathname) ||
          [...url.searchParams].length !== 1 || !url.searchParams.get('ticket')) throw fail('UNTRUSTED_DOWNLOAD_URL');
      const r = await response(url.href);
      try {
        if (r.headers.get('content-type') !== 'application/octet-stream' || r.headers.get('content-length') !== String(metadata.size)) throw fail('INVALID_DOWNLOAD_RESPONSE');
        async function* chunks() { for await (const bytes of r.body) for (let i = 0; i < bytes.length; i += CHUNK_BYTES) yield bytes.subarray(i, i + CHUNK_BYTES); }
        const result = await saveDownload(destination, metadata, chunks(), { signal: deadline });
        return { ...result, requestId: id };
      } finally { await r.body?.cancel().catch(() => {}); }
    },
  };
}
