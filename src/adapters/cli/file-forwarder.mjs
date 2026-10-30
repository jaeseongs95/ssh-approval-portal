import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validateOrigin } from '../config/settings.mjs';
import { validateLocalPath } from './local-files.mjs';
import { remotePath } from '../../domain/validation.mjs';
import { MAX_BYTES } from '../../contracts/ports.mjs';

const fail = code => Object.assign(new Error(code), { code });
const id = z.string().regex(/^[a-f0-9]{48}$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
const common = { id, publicName: z.string().regex(/^[\p{L}\p{N}._ -]{1,128}$/u), target: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  targetRevision: digest, remotePath: z.string(), size: z.number().int().min(0).max(MAX_BYTES), sha256: digest,
  expiresAt: z.number().int().positive().refine(Number.isSafeInteger), elevate: z.boolean() };
const capability = z.discriminatedUnion('direction', [
  z.strictObject({ ...common, direction: z.literal('upload'), source: z.string(), overwrite: z.boolean() }),
  z.strictObject({ ...common, direction: z.literal('download'), destination: z.string() }),
]);
const manifestSchema = z.strictObject({ version: z.literal(1), origin: z.string(), capabilities: z.array(capability).min(1).max(128) });
const hash = value => createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
export function validateFileManifest(value) {
  try {
    const parsed = manifestSchema.parse(value); validateOrigin(parsed.origin);
    const seen = new Set();
    const capabilities = parsed.capabilities.map(item => {
      if (seen.has(item.id)) throw Error(); seen.add(item.id);
      remotePath(item.remotePath); validateLocalPath(item.direction === 'upload' ? item.source : item.destination);
      return Object.freeze(item);
    });
    return Object.freeze({ version: 1, origin: parsed.origin, capabilities: Object.freeze(capabilities) });
  } catch { throw fail('INVALID_FILE_MANIFEST'); }
}
export async function readPrivateJson(path, maxBytes) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes ||
      (process.platform !== 'win32' && (before.mode & 0o077))) throw fail('PRIVATE_FILE_UNAVAILABLE');
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await fd.stat();
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.size > maxBytes) throw fail('PRIVATE_FILE_UNAVAILABLE');
    const bytes = Buffer.alloc(maxBytes + 1); let size = 0;
    for (;;) {
      const { bytesRead } = await fd.read(bytes, size, bytes.length - size, null);
      size += bytesRead;
      if (size > maxBytes) throw fail('PRIVATE_FILE_UNAVAILABLE');
      if (!bytesRead) break;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } finally { await fd.close(); }
}
export async function loadFileManifest(path) {
  try { validateLocalPath(path); return validateFileManifest(await readPrivateJson(path, 1024 * 1024)); }
  catch { throw fail('INVALID_FILE_MANIFEST'); }
}
const recordBase = { version: z.literal(1), binding: digest };
const recordSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...recordBase, kind: z.literal('claim') }),
  z.strictObject({ ...recordBase, kind: z.literal('save-claim') }),
  z.strictObject({ ...recordBase, kind: z.literal('transfer'), transferId: id }),
  z.strictObject({ ...recordBase, kind: z.literal('request'), requestId: id }),
  z.strictObject({ ...recordBase, kind: z.literal('saved'), requestId: id, size: z.number().int().nonnegative(), sha256: digest }),
]);
const states = new Set(['pending', 'evaluating', 'running', 'completed', 'failed', 'denied', 'expired', 'unknown']);
const safeErrors = new Set(['OWNER_REAUTH_REQUIRED', 'ACCESS_CREDENTIAL_UNAVAILABLE', 'PORTAL_REQUEST_REFUSED',
  'INVALID_TRANSFER_ACK', 'RESUME_SOURCE_MISMATCH', 'RESUME_INTENT_MISMATCH', 'UPLOAD_NOT_RESUMABLE',
  'UPLOAD_SOURCE_MISMATCH', 'DOWNLOAD_EXPECTATION_MISMATCH', 'DOWNLOAD_NOT_READY', 'DOWNLOAD_INTEGRITY_MISMATCH', 'CAPABILITY_TARGET_UNAVAILABLE', 'CAPABILITY_EXPIRED']);
/** Private manifest and journal are controlled by the local user. This is not a
 * same-UID/root sandbox or a power-loss/external exactly-once guarantee. */
export async function createFileForwarder({ manifest: input, journalRoot, openClient }) {
  const manifest = validateFileManifest(input);
  try {
    validateLocalPath(journalRoot);
    const st = await lstat(journalRoot);
    if (!st.isDirectory() || st.isSymbolicLink() || (process.platform !== 'win32' && (st.mode & 0o077))) throw Error();
  } catch { throw fail('CAPABILITY_JOURNAL_UNAVAILABLE'); }
  if (typeof openClient !== 'function') throw fail('CAPABILITY_CLIENT_UNAVAILABLE');
  const capabilities = new Map(manifest.capabilities.map(item => [item.id, item]));
  const select = args => {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 ||
        !Object.hasOwn(args, 'capabilityId') || !id.safeParse(args.capabilityId).success) throw fail('INVALID_CAPABILITY_ARGUMENTS');
    const item = capabilities.get(args.capabilityId);
    if (!item) throw fail('CAPABILITY_UNAVAILABLE');
    return item;
  };
  const binding = cap => hash(JSON.stringify({ origin: manifest.origin, capability: stable(cap) }));
  const path = (cap, kind) => join(journalRoot, cap.id + '.' + kind + '.json');
  async function read(cap, kind) {
    let raw;
    try { raw = await readPrivateJson(path(cap, kind), 8192); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw fail('CAPABILITY_JOURNAL_UNKNOWN'); }
    const parsed = recordSchema.safeParse(raw);
    if (!parsed.success || parsed.data.kind !== kind || parsed.data.binding !== binding(cap)) throw fail('CAPABILITY_JOURNAL_UNKNOWN');
    return parsed.data;
  }
  async function write(cap, kind, fields = {}, { claim = false } = {}) {
    const value = { version: 1, binding: binding(cap), kind, ...fields };
    recordSchema.parse(value);
    let fd;
    try { fd = await open(path(cap, kind), 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw fail('CAPABILITY_JOURNAL_UNKNOWN');
      const old = await read(cap, kind);
      if (stable(old) !== stable(value)) throw fail('CAPABILITY_JOURNAL_UNKNOWN');
      return !claim;
    }
    try { await fd.writeFile(JSON.stringify(value) + '\n', 'utf8'); await fd.sync(); }
    finally { await fd.close(); }
    return true;
  }
  const view = (cap, state, fields = {}) => ({ capabilityId: cap.id, publicName: cap.publicName, size: cap.size, sha256: cap.sha256, state, ...fields });
  function verifyJob(cap, job, transferId) {
    const op = job?.operation;
    if (!id.safeParse(job?.id).success || job.kind !== cap.direction || !states.has(job.state) || op?.kind !== cap.direction ||
        op.fileTargetId !== cap.target || op.fileTargetRevision !== cap.targetRevision ||
        op.remotePath !== cap.remotePath || op.elevate !== cap.elevate ||
        (cap.direction === 'upload' && (op.size !== cap.size || op.sha256 !== cap.sha256 || op.overwrite !== cap.overwrite || (transferId && op.artifactId !== transferId)))) throw fail('CAPABILITY_RESULT_UNKNOWN');
    if (cap.direction === 'download' && job.state === 'completed') {
      const meta = job.result?.structuredContent;
      if (job.result?.isError || !meta || !id.safeParse(meta.artifactId).success || meta.size !== cap.size || meta.sha256 !== cap.sha256) throw fail('DOWNLOAD_EXPECTATION_MISMATCH');
    }
    return job;
  }
  async function observe(cap, client) {
    const claimed = await read(cap, 'claim');
    const request = await read(cap, 'request'), transfer = await read(cap, 'transfer');
    const saveClaim = await read(cap, 'save-claim'), saved = await read(cap, 'saved');
    if (!claimed) {
      if (request || transfer || saveClaim || saved) throw fail('CAPABILITY_JOURNAL_UNKNOWN');
      return view(cap, 'unused');
    }
    if (saved) {
      if (cap.direction !== 'download' || !saveClaim || !request || saved.requestId !== request.requestId || saved.size !== cap.size || saved.sha256 !== cap.sha256) throw fail('CAPABILITY_JOURNAL_UNKNOWN');
      return view(cap, 'saved', { requestId: request.requestId, savedReceipt: true });
    }
    if (saveClaim) return view(cap, 'save-unknown', request ? { requestId: request.requestId } : {});
    if (request) {
      const job = verifyJob(cap, await (await client()).status(request.requestId), transfer?.transferId);
      if (job.id !== request.requestId) throw fail('CAPABILITY_RESULT_UNKNOWN');
      return view(cap, job.state === 'completed' && cap.direction === 'download' ? 'prepared' : job.state, { requestId: job.id, ...(transfer ? { transferId: transfer.transferId } : {}) });
    }
    if (transfer) {
      const record = await (await client()).transfer(transfer.transferId), item = record?.transfer;
      if (record?.job) {
        const job = verifyJob(cap, record.job, transfer.transferId);
        return view(cap, job.state, { requestId: job.id, transferId: transfer.transferId });
      }
      if (cap.direction !== 'upload' || item?.id !== transfer.transferId || item.fileTargetBound !== true || item.targetId !== cap.target ||
          item.targetRevision !== cap.targetRevision || item.remotePath !== cap.remotePath || item.elevate !== cap.elevate ||
          item.overwrite !== cap.overwrite || item.size !== cap.size || item.sha256 !== cap.sha256 ||
          item.state !== 'staging' || !Number.isSafeInteger(item.received) || item.received < 0 || item.received > cap.size) throw fail('CAPABILITY_RESULT_UNKNOWN');
      return view(cap, 'staging', { transferId: transfer.transferId, received: item.received });
    }
    return view(cap, 'unknown');
  }
  const active = cap => { if (Date.now() >= cap.expiresAt) throw fail('CAPABILITY_EXPIRED'); };
  async function invoke(action, args) {
    const cap = select(args);
    let clientPromise;
    const client = () => clientPromise ??= Promise.resolve().then(() => {
      if (action !== 'status') active(cap);
      const timeoutMs = action === 'status' ? 120_000 : Math.min(120_000, Math.max(1, cap.expiresAt - Date.now()));
      return openClient(manifest.origin, { timeoutMs, signal: AbortSignal.timeout(timeoutMs) });
    });
    try {
      if (action === 'status') return await observe(cap, client);
      if (!['upload', 'request-download', 'resume-upload', 'save'].includes(action) ||
          (['upload', 'resume-upload'].includes(action) ? cap.direction !== 'upload' : cap.direction !== 'download')) throw fail('CAPABILITY_ACTION_REFUSED');
      active(cap);
      if (action === 'upload' || action === 'request-download') {
        if (!await write(cap, 'claim', {}, { claim: true })) return await observe(cap, client);
        const c = await client();
        const listed = await c.targets(), matches = Array.isArray(listed?.targets) ? listed.targets.filter(item => item?.id === cap.target) : [];
        if (matches.length !== 1 || matches[0].enabled !== true || matches[0].revision !== cap.targetRevision) throw fail('CAPABILITY_TARGET_UNAVAILABLE');
        const intent = { target: cap.target, expectedTargetRevision: cap.targetRevision, remotePath: cap.remotePath, elevate: cap.elevate };
        active(cap);
        const job = action === 'upload' ?
          await c.upload(cap.source, { ...intent, overwrite: cap.overwrite }, async ({ transferId }) => { await write(cap, 'transfer', { transferId: id.parse(transferId) }); }, { size: cap.size, sha256: cap.sha256 }) :
          await c.requestDownload(intent);
        const transfer = await read(cap, 'transfer');
        verifyJob(cap, job, transfer?.transferId);
        if (cap.direction === 'upload' && !transfer) throw fail('CAPABILITY_RESULT_UNKNOWN');
        await write(cap, 'request', { requestId: job.id });
        return view(cap, job.state === 'completed' && cap.direction === 'download' ? 'prepared' : job.state, { requestId: job.id, ...(transfer ? { transferId: transfer.transferId } : {}) });
      }
      if (!await read(cap, 'claim')) throw fail('CAPABILITY_ACTION_REFUSED');
      const request = await read(cap, 'request');
      if (action === 'resume-upload') {
        if (request) return await observe(cap, client);
        const transfer = await read(cap, 'transfer');
        if (!transfer) return view(cap, 'unknown');
        const job = await (await client()).resumeUpload(transfer.transferId, cap.source,
          { target: cap.target, expectedTargetRevision: cap.targetRevision, remotePath: cap.remotePath, elevate: cap.elevate, overwrite: cap.overwrite },
          { size: cap.size, sha256: cap.sha256 });
        verifyJob(cap, job, transfer.transferId); await write(cap, 'request', { requestId: job.id });
        return view(cap, job.state, { requestId: job.id, transferId: transfer.transferId });
      }
      if (!request) return view(cap, 'unknown');
      if (await read(cap, 'save-claim')) return await observe(cap, client);
      const c = await client(), job = verifyJob(cap, await c.status(request.requestId));
      if (job.id !== request.requestId) throw fail('CAPABILITY_RESULT_UNKNOWN');
      if (job.state !== 'completed') return view(cap, job.state, { requestId: job.id });
      active(cap);
      if (!await write(cap, 'save-claim', {}, { claim: true })) return await observe(cap, client);
      active(cap);
      const saved = await c.save(request.requestId, cap.destination,
        { size: cap.size, sha256: cap.sha256, target: cap.target, targetRevision: cap.targetRevision, remotePath: cap.remotePath, elevate: cap.elevate });
      if (saved.state !== 'saved' || saved.requestId !== request.requestId || saved.size !== cap.size || saved.sha256 !== cap.sha256) throw fail('CAPABILITY_RESULT_UNKNOWN');
      await write(cap, 'saved', { requestId: request.requestId, size: cap.size, sha256: cap.sha256 });
      return view(cap, 'saved', { requestId: request.requestId, savedReceipt: true });
    } catch (error) {
      let saveClaimed = false;
      try { saveClaimed = Boolean(await read(cap, 'save-claim')); } catch {}
      return view(cap, saveClaimed ? 'save-unknown' : 'unknown', { error: safeErrors.has(error.code) ? error.code : 'CAPABILITY_RESULT_UNKNOWN' });
    } finally {
      if (clientPromise) { try { await (await clientPromise).close(); } catch {} }
    }
  }
  return {
    list(args) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw fail('INVALID_CAPABILITY_ARGUMENTS');
      return { capabilities: manifest.capabilities.map(cap => view(cap, Date.now() >= cap.expiresAt ? 'expired' : 'available', { direction: cap.direction })) };
    },
    invoke,
    async close() {}, // Each invocation closes its own owner session in finally.
  };
}
