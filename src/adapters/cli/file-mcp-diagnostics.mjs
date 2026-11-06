import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const publicCodes = new Set([
  'INVALID_CAPABILITY_ARGUMENTS', 'CAPABILITY_UNAVAILABLE', 'CAPABILITY_SELECTION_MISMATCH',
  'CAPABILITY_JOURNAL_UNAVAILABLE', 'CAPABILITY_JOURNAL_UNKNOWN', 'CAPABILITY_CLIENT_UNAVAILABLE',
  'CAPABILITY_TARGET_UNAVAILABLE', 'CAPABILITY_EXPIRED', 'CAPABILITY_ACTION_REFUSED',
  'INVALID_REMOTE_PATH', 'INVALID_LOCAL_PATH', 'INVALID_LOCAL_SOURCE', 'LOCAL_SOURCE_CHANGED',
  'INVALID_LOCAL_LIMIT', 'INVALID_FILE_MANIFEST', 'PRIVATE_FILE_UNAVAILABLE', 'UPLOAD_SOURCE_MISMATCH',
  'INCOMPLETE_LOCAL_WRITE', 'INCOMPLETE_SNAPSHOT', 'SNAPSHOT_UNAVAILABLE',
  'ACCESS_CREDENTIAL_UNAVAILABLE', 'ACCESS_CREDENTIAL_TIMEOUT', 'ACCESS_CREDENTIAL_TOO_LARGE',
  'OWNER_REAUTH_REQUIRED', 'ACCESS_MODE_REQUIRED', 'INVALID_OWNER_SESSION',
  'PORTAL_REQUEST_REFUSED', 'PORTAL_READ_FAILED', 'PORTAL_RESULT_UNKNOWN',
  'INVALID_PORTAL_RESPONSE', 'PORTAL_RESPONSE_TOO_LARGE', 'OWNER_SESSION_CLEANUP_UNKNOWN',
]);
const localCodes = {
  ENOENT: 'CAPABILITY_LOCAL_NOT_FOUND', EACCES: 'CAPABILITY_LOCAL_ACCESS_DENIED', EPERM: 'CAPABILITY_LOCAL_ACCESS_DENIED',
  ENOSPC: 'CAPABILITY_LOCAL_STORAGE_FULL', EDQUOT: 'CAPABILITY_LOCAL_STORAGE_FULL',
  EBUSY: 'CAPABILITY_LOCAL_BUSY', ETXTBSY: 'CAPABILITY_LOCAL_BUSY',
  EXDEV: 'CAPABILITY_LOCAL_LINK_UNSUPPORTED', ENOTSUP: 'CAPABILITY_LOCAL_LINK_UNSUPPORTED', EOPNOTSUPP: 'CAPABILITY_LOCAL_LINK_UNSUPPORTED',
  ENOTDIR: 'CAPABILITY_LOCAL_IO_FAILED', EIO: 'CAPABILITY_LOCAL_IO_FAILED',
};
for (const code of Object.values(localCodes)) publicCodes.add(code);
const stages = new Set(['selection-load', 'owner-session', 'target-query', 'local-snapshot', 'selection-publish',
  'owner-session-cleanup', 'capability-load', 'capability-status', 'capability-upload', 'capability-resume',
  'capabilities', 'arguments', 'startup', 'runtime']);

// Only fixed codes and local stage labels cross the MCP boundary, never error text.
export function fileMcpFailure(error, stage) {
  const key = typeof error?.code === 'string' ? error.code : '';
  const code = publicCodes.has(key) ? key : Object.hasOwn(localCodes, key) ? localCodes[key] : 'CAPABILITY_REQUEST_REFUSED';
  return { state: 'refused', error: code, stage: stages.has(error?.stage) ? error.stage : stages.has(stage) ? stage : 'arguments',
    ...(error?.cleanupError === 'OWNER_SESSION_CLEANUP_UNKNOWN' ? { cleanupError: 'OWNER_SESSION_CLEANUP_UNKNOWN' } : {}) };
}
export async function atFileStage(stage, action) {
  try { return await action(); }
  catch (error) {
    const result = fileMcpFailure(error, stage);
    throw Object.assign(new Error(result.error), { code: result.error, stage: result.stage,
      ...(result.cleanupError ? { cleanupError: result.cleanupError } : {}) });
  }
}

export async function fileRuntime() {
  try {
    const paths = ['../../../scripts/portal-file-mcp.mjs', './agent-file-forwarder.mjs', './file-forwarder.mjs', './local-files.mjs', './file-mcp-diagnostics.mjs'];
    const bytes = await Promise.all(paths.map(path => readFile(new URL(path, import.meta.url))));
    const { version } = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw Error();
    const hash = value => createHash('sha256').update(value).digest('hex');
    return { state: 'ready', runtime: { productVersion: version, node: process.versions.node, platform: process.platform,
      entrypointSha256: hash(bytes[0]), implementationSha256: hash(JSON.stringify(bytes.map(hash))), sourceObservation: 'startup-files' } };
  } catch { return { state: 'unavailable', error: 'CAPABILITY_RUNTIME_UNAVAILABLE' }; }
}
