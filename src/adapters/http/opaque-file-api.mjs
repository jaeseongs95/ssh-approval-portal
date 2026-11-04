import { CHUNK_BYTES } from '../../contracts/ports.mjs';
import { opaqueFileErrorCode } from '../../application/opaque-files.mjs';

const uuidPattern = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const routePattern = new RegExp('^/api/artifacts/(' + uuidPattern + ')(?:/(complete)|/chunks/(0|[1-9][0-9]*))?$');
const authenticated = permission => permission?.allowed === true && typeof permission.principal?.subject === 'string' && permission.principal.subject.length > 0;
const fields = (body, names) => body && typeof body === 'object' && !Array.isArray(body) &&
  Object.keys(body).length === names.length && names.every(key => Object.hasOwn(body, key));
const errorStatus = new Map([
  ...['INVALID_OPERATION_KEY', 'INVALID_FILE_NAME', 'INVALID_FILE_SIZE', 'INVALID_FILE_HASH', 'INVALID_ARTIFACT_CHUNK', 'INVALID_FILE_FLAG', 'INVALID_REMOTE_PATH'].map(code => [code, 400]),
  ['ARTIFACT_NOT_FOUND', 404],
  ...['ARTIFACT_INCOMPLETE', 'ARTIFACT_NOT_WRITABLE', 'ARTIFACT_NOT_READY', 'ARTIFACT_BUSY', 'ARTIFACT_CHUNK_CONFLICT', 'OPERATION_KEY_CONFLICT', 'TARGET_REVISION_CONFLICT',
    'STAGED_FILE_CONSUMED', 'STAGED_FILE_CHANGED', 'OPAQUE_ADMISSION_BUSY', 'OPAQUE_ACTION_CONFLICT', 'OPAQUE_ACTION_RECONCILIATION_REQUIRED'].map(code => [code, 409]),
  ['ARTIFACT_EXPIRED', 410], ['STAGED_FILE_EXPIRED', 410], ['FILE_TOO_LARGE', 413],
  ['CHUNK_HASH_MISMATCH', 422], ['ARTIFACT_HASH_MISMATCH', 422], ['ARTIFACT_QUOTA', 507],
  ...['MAINTENANCE', 'OPAQUE_FILES_CLOSED', 'OPAQUE_FILES_UNAVAILABLE', 'ARTIFACT_STORAGE_UNSAFE', 'OPERATION_ACCEPTANCE_NOT_CONFIRMED'].map(code => [code, 503]),
]);

/** The shared owner authorization/Origin policy runs before this adapter. Its
 * verified principal is mandatory, and is checked again after reading a body. */
export async function routeOpaqueFileApi(req, res, url, { opaqueFiles, json, authorize, authorization }) {
  if (url.pathname !== '/api/artifacts' && !url.pathname.startsWith('/api/artifacts/')) return false;
  if (!authenticated(authorization) || typeof authorize !== 'function') {
    json(res, authorization?.status === 401 ? 401 : 403, { error: authorization?.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' }); return true;
  }
  try {
    const route = routePattern.exec(url.pathname), create = url.pathname === '/api/artifacts';
    if (url.search || (!create && !route)) { json(res, 400, { error: 'INVALID_ARTIFACT_ROUTE' }); return true; }
    if (!opaqueFiles) { json(res, 503, { error: 'OPAQUE_FILES_UNAVAILABLE' }); return true; }
    if (route && !route[2] && route[3] === undefined && req.method === 'GET') {
      json(res, 200, await opaqueFiles.stat({ uuid: route[1] })); return true;
    }
    const chunk = route?.[3] !== undefined;
    if ((create || route?.[2]) ? req.method !== 'POST' : !chunk || req.method !== 'PUT') {
      json(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return true;
    }
    if (req.headers['content-type'] !== (chunk ? 'application/octet-stream' : 'application/json') ||
        (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity')) {
      json(res, 415, { error: 'UNSUPPORTED_ARTIFACT_CONTENT_TYPE' }); return true;
    }
    const limit = chunk ? CHUNK_BYTES : 8192;
    const parts = []; let length = 0;
    for await (const part of req) {
      length += part.length;
      if (length > limit) { json(res, 413, { error: 'ARTIFACT_REQUEST_TOO_LARGE' }); return true; }
      parts.push(part);
    }
    const permission = await authorize();
    if (!authenticated(permission) || permission.principal.subject !== authorization.principal.subject) {
      json(res, permission?.status === 401 ? 401 : 403, { error: 'ARTIFACT_AUTHORIZATION_CHANGED' }); return true;
    }
    const bytes = Buffer.concat(parts);
    let value;
    if (chunk) {
      const sequence = Number(route[3]);
      if (!Number.isSafeInteger(sequence) || !bytes.length || !/^[a-f0-9]{64}$/.test(req.headers['x-chunk-sha256'] ?? '')) {
        json(res, 400, { error: 'INVALID_ARTIFACT_CHUNK' }); return true;
      }
      value = await opaqueFiles.append({ uuid: route[1], sequence, bytes, sha256: req.headers['x-chunk-sha256'] });
    } else {
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { json(res, 400, { error: 'INVALID_JSON' }); return true; }
      if (!fields(body, create ? ['operationKey', 'fileName', 'size', 'sha256'] : [])) {
        json(res, 400, { error: 'INVALID_ARTIFACT_FIELDS' }); return true;
      }
      value = create ? await opaqueFiles.begin(body) : await opaqueFiles.complete({ uuid: route[1] });
    }
    json(res, 200, value); return true;
  } catch (error) {
    const code = opaqueFileErrorCode(error);
    json(res, errorStatus.get(code) ?? 500, { error: code }); return true;
  }
}
