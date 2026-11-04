import { createHash } from 'node:crypto';
import { CHUNK_BYTES, MAX_BYTES } from '../../contracts/ports.mjs';
import { withUploadSnapshot } from './local-files.mjs';
import { createOwnerHttpSession, readPortalJson } from './owner-http-session.mjs';

const fail = (code, details = {}) => Object.assign(new Error(code), { code, ...details });
export const opaqueUuidValid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const keyValid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value);
const states = new Set(['staging', 'ready', 'expired', 'consuming', 'moved', 'removed']);
const publicErrors = new Set(['OWNER_REAUTH_REQUIRED', 'PORTAL_REQUEST_REFUSED', 'PORTAL_READ_FAILED', 'PORTAL_RESULT_UNKNOWN',
  'INVALID_PORTAL_RESPONSE', 'PORTAL_RESPONSE_TOO_LARGE', 'INVALID_ARTIFACT_RESPONSE', 'INVALID_ARTIFACT_ACK',
  'ARTIFACT_SOURCE_MISMATCH', 'ARTIFACT_ALREADY_STAGING', 'ARTIFACT_EXPIRED', 'ARTIFACT_NOT_READY',
  'INVALID_LOCAL_SOURCE', 'LOCAL_SOURCE_CHANGED', 'INCOMPLETE_SNAPSHOT', 'SNAPSHOT_UNAVAILABLE']);

function metadata(value, uuid) {
  if (!value || value.uuid !== uuid || !states.has(value.state) || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_BYTES ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0 ||
      !Number.isSafeInteger(value.received) || value.received < 0 || value.received > value.size ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 0 || value.sequence > value.received ||
      (value.state === 'ready' && value.received !== value.size)) throw fail('INVALID_ARTIFACT_RESPONSE');
  return Object.freeze(Object.fromEntries(['uuid', 'state', 'size', 'sha256', 'expiresAt', 'received', 'sequence'].map(key => [key, value[key]])));
}

/** PC bytes stay in this process and owner HTTP. Only completed staging UUIDs
 * cross the model boundary; no SSH target, remote path or approval lives here. */
export function createOpaqueFilesClient(options) {
  const session = createOwnerHttpSession(options);
  async function status(uuid) {
    session.ready();
    if (!opaqueUuidValid(uuid)) throw fail('INVALID_ARTIFACT_UUID');
    return metadata(await session.json('/api/artifacts/' + uuid), uuid);
  }
  return {
    connect: session.connect, close: session.close, status,
    async upload(file, operationKey, onArtifact = () => {}) {
      session.ready();
      if (!keyValid(operationKey)) throw fail('INVALID_OPERATION_KEY');
      if (typeof onArtifact !== 'function') throw fail('INVALID_PROGRESS_CALLBACK');
      let uuid, phase = 'snapshot';
      try {
        return await withUploadSnapshot(file, async snapshot => {
          phase = 'begin';
          const begin = await session.json('/api/artifacts', { operationKey, fileName: snapshot.fileName, size: snapshot.size, sha256: snapshot.sha256 });
          if (!begin || !opaqueUuidValid(begin.uuid)) throw fail('INVALID_ARTIFACT_RESPONSE');
          uuid = begin.uuid;
          await onArtifact({ uuid, phase: 'staging' });
          const current = await status(uuid);
          if (current.size !== snapshot.size || current.sha256 !== snapshot.sha256) throw fail('ARTIFACT_SOURCE_MISMATCH');
          if (current.expiresAt <= Date.now()) throw fail('ARTIFACT_EXPIRED');
          if (current.state === 'ready') return { uuid };
          if (current.state !== 'staging') throw fail('ARTIFACT_NOT_READY');
          if (current.received !== 0 || current.sequence !== 0) throw fail('ARTIFACT_ALREADY_STAGING');
          let sequence = 0, received = 0;
          phase = 'chunks';
          for await (const bytes of snapshot.chunks()) {
            const hash = createHash('sha256').update(bytes).digest('hex');
            const ack = await readPortalJson(await session.request('/api/artifacts/' + uuid + '/chunks/' + sequence,
              { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': hash } }));
            received += bytes.length;
            if (!ack || ack.uuid !== uuid || ack.sequence !== sequence + 1 || ack.received !== received) throw fail('INVALID_ARTIFACT_ACK');
            sequence++;
          }
          if (received !== snapshot.size) throw fail('INVALID_ARTIFACT_ACK');
          phase = 'complete';
          const completed = await session.json('/api/artifacts/' + uuid + '/complete', {});
          if (!completed || completed.uuid !== uuid) throw fail('INVALID_ARTIFACT_ACK');
          const final = await status(uuid);
          if (final.state !== 'ready' || final.size !== snapshot.size || final.sha256 !== snapshot.sha256 ||
              final.received !== received || final.sequence !== sequence) throw fail('INVALID_ARTIFACT_RESPONSE');
          return { uuid };
        }, { signal: session.signal });
      } catch (error) {
        // Read the same UUID once after uncertainty; never replay a mutation or
        // allocate another artifact to discover what happened to the first one.
        let progress;
        if (uuid) { try { progress = await status(uuid); } catch { /* Original failure and UUID stay authoritative. */ } }
        throw fail(publicErrors.has(error.code) ? error.code : 'ARTIFACT_UPLOAD_FAILED', { phase, ...(uuid ? { uuid } : {}), ...(progress ? { progress } : {}) });
      }
    },
  };
}
