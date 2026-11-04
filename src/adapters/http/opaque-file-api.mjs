import { CHUNK_BYTES } from '../../contracts/ports.mjs';

const uuidPattern = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const routePattern = new RegExp('^/api/artifacts/(' + uuidPattern + ')(?:/(complete)|/chunks/(0|[1-9][0-9]*))?$');
const authenticated = permission => permission?.allowed === true && typeof permission.principal?.subject === 'string' && permission.principal.subject.length > 0;
const fields = (body, names) => body && typeof body === 'object' && !Array.isArray(body) &&
  Object.keys(body).length === names.length && names.every(key => Object.hasOwn(body, key));

/** The shared owner authorization/Origin policy runs before this adapter. Its
 * verified principal is mandatory, and is checked again after reading a body. */
export async function routeOpaqueFileApi(req, res, url, { opaqueFiles, json, authorize, authorization }) {
  if (url.pathname !== '/api/artifacts' && !url.pathname.startsWith('/api/artifacts/')) return false;
  if (!authenticated(authorization) || typeof authorize !== 'function') {
    json(res, authorization?.status === 401 ? 401 : 403, { error: 'Unauthorized artifact request' }); return true;
  }
  const route = routePattern.exec(url.pathname), create = url.pathname === '/api/artifacts';
  if (url.search || (!create && !route)) { json(res, 400, { error: 'Invalid artifact route' }); return true; }
  if (route && !route[2] && route[3] === undefined && req.method === 'GET') {
    json(res, 200, await opaqueFiles.stat({ uuid: route[1] })); return true;
  }
  const chunk = route?.[3] !== undefined;
  if ((create || route?.[2]) ? req.method !== 'POST' : !chunk || req.method !== 'PUT') {
    json(res, 405, { error: 'Method not allowed' }); return true;
  }
  if (req.headers['content-type'] !== (chunk ? 'application/octet-stream' : 'application/json') ||
      (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity')) {
    json(res, 415, { error: 'Unsupported artifact content type' }); return true;
  }
  const limit = chunk ? CHUNK_BYTES : 8192;
  const parts = []; let length = 0;
  for await (const part of req) {
    length += part.length;
    if (length > limit) { json(res, 413, { error: 'Artifact request too large' }); return true; }
    parts.push(part);
  }
  const permission = await authorize();
  if (!authenticated(permission) || permission.principal.subject !== authorization.principal.subject) {
    json(res, permission?.status === 401 ? 401 : 403, { error: 'Artifact authorization changed' }); return true;
  }
  const bytes = Buffer.concat(parts);
  let value;
  if (chunk) {
    const sequence = Number(route[3]);
    if (!Number.isSafeInteger(sequence) || !bytes.length || !/^[a-f0-9]{64}$/.test(req.headers['x-chunk-sha256'] ?? '')) {
      json(res, 400, { error: 'Invalid artifact chunk' }); return true;
    }
    value = await opaqueFiles.append({ uuid: route[1], sequence, bytes, sha256: req.headers['x-chunk-sha256'] });
  } else {
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { json(res, 400, { error: 'Invalid JSON' }); return true; }
    if (!fields(body, create ? ['operationKey', 'fileName', 'size', 'sha256'] : [])) {
      json(res, 400, { error: 'Invalid artifact fields' }); return true;
    }
    value = create ? await opaqueFiles.begin(body) : await opaqueFiles.complete({ uuid: route[1] });
  }
  json(res, 200, value); return true;
}
