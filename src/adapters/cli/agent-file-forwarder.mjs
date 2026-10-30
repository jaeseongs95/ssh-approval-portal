import { lstat, opendir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validateOrigin } from '../config/settings.mjs';
import { remotePath } from '../../domain/validation.mjs';
import { validateLocalPath, withUploadSnapshot, saveDownload } from './local-files.mjs';
import { createFileForwarder, readPrivateJson, validateFileManifest } from './file-forwarder.mjs';

const fail = code => Object.assign(new Error(code), { code });
const identifier = z.string().regex(/^[a-f0-9]{48}$/);
export const agentUploadSelectionArgs = z.strictObject({
  capabilityId: identifier, localPath: z.string().min(1).max(4096), remotePath: z.string().min(1).max(4096),
  target: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), elevate: z.boolean().default(false), overwrite: z.boolean().default(false),
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const view = cap => ({ capabilityId: cap.id, publicName: cap.publicName, size: cap.size, sha256: cap.sha256,
  state: Date.now() >= cap.expiresAt ? 'expired' : 'available', direction: 'upload' });

/** Explicit local-user opt-in delegates file selection to the agent. Authentication,
 * immutable byte binding and server approvals still use the existing file forwarder. */
export async function createAgentUploadForwarder({ origin, journalRoot, openClient }) {
  validateOrigin(origin); validateLocalPath(journalRoot);
  const st = await lstat(journalRoot);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.platform !== 'win32' && (st.mode & 0o077))) throw fail('CAPABILITY_JOURNAL_UNAVAILABLE');
  if (typeof openClient !== 'function') throw fail('CAPABILITY_CLIENT_UNAVAILABLE');
  const path = id => join(journalRoot, id + '.selection.json');
  async function load(id) {
    let raw;
    try { raw = await readPrivateJson(path(id), 65536); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw fail('CAPABILITY_JOURNAL_UNKNOWN'); }
    const manifest = validateFileManifest(raw), cap = manifest.capabilities[0];
    if (manifest.origin !== origin || manifest.capabilities.length !== 1 || cap.id !== id || cap.direction !== 'upload') throw fail('CAPABILITY_JOURNAL_UNKNOWN');
    return cap;
  }
  function sameIntent(cap, args) {
    if (cap.source !== args.localPath || cap.remotePath !== args.remotePath || cap.target !== args.target ||
        cap.elevate !== args.elevate || cap.overwrite !== args.overwrite) throw fail('CAPABILITY_SELECTION_MISMATCH');
    return view(cap);
  }
  async function selectUpload(input) {
    const args = agentUploadSelectionArgs.parse(input);
    validateLocalPath(args.localPath); remotePath(args.remotePath);
    const existing = await load(args.capabilityId);
    if (existing) return sameIntent(existing, args);
    const signal = AbortSignal.timeout(120000);
    let client;
    try {
      client = await openClient(origin, { timeoutMs: 120000, signal });
      const listed = await client.targets(), matches = Array.isArray(listed?.targets) ? listed.targets.filter(item => item?.id === args.target) : [];
      if (matches.length !== 1 || matches[0].enabled !== true || !/^[a-f0-9]{64}$/.test(matches[0].revision)) throw fail('CAPABILITY_TARGET_UNAVAILABLE');
      return await withUploadSnapshot(args.localPath, async snapshot => {
        const publicName = [...basename(args.localPath).replace(/[^\p{L}\p{N}._ -]/gu, '-')].slice(0, 128).join('') || 'upload';
        const manifest = validateFileManifest({ version: 1, origin, capabilities: [{
          id: args.capabilityId, publicName, direction: 'upload', source: args.localPath, target: args.target,
          targetRevision: matches[0].revision, remotePath: args.remotePath, size: snapshot.size, sha256: snapshot.sha256,
          expiresAt: Date.now() + 3600000, elevate: args.elevate, overwrite: args.overwrite,
        }] });
        const bytes = Buffer.from(JSON.stringify(manifest) + '\n');
        // Reuse exclusive publication: no reader can observe a partial manifest.
        try { await saveDownload(path(args.capabilityId), { size: bytes.length, sha256: digest(bytes) },
          (async function* () { yield bytes; })(), { maxBytes: 65536, signal }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        const cap = await load(args.capabilityId);
        if (!cap) throw fail('CAPABILITY_JOURNAL_UNKNOWN');
        return sameIntent(cap, args);
      }, { signal });
    } finally { await client?.close(); }
  }
  return {
    uploadOnly: true, selectUpload,
    async list(args) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw fail('INVALID_CAPABILITY_ARGUMENTS');
      const capabilities = [];
      // Bound each tool response while retaining old receipts for explicit status reads.
      for await (const entry of await opendir(journalRoot)) {
        if (!/^[a-f0-9]{48}\.selection\.json$/.test(entry.name)) continue;
        if (capabilities.length === 128) return { capabilities, truncated: true };
        capabilities.push(view(await load(entry.name.slice(0, 48))));
      }
      return { capabilities, truncated: false };
    },
    async invoke(action, args) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 ||
          !Object.hasOwn(args, 'capabilityId') || !identifier.safeParse(args.capabilityId).success) throw fail('INVALID_CAPABILITY_ARGUMENTS');
      if (!['upload', 'status', 'resume-upload'].includes(action)) throw fail('CAPABILITY_ACTION_REFUSED');
      const cap = await load(args.capabilityId);
      if (!cap) throw fail('CAPABILITY_UNAVAILABLE');
      const forwarder = await createFileForwarder({ manifest: { version: 1, origin, capabilities: [cap] }, journalRoot, openClient });
      return forwarder.invoke(action, args);
    },
    async close() {},
  };
}
