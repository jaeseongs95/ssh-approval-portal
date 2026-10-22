import { CHUNK_BYTES } from '../../contracts/ports.mjs';
import { presentJob } from '../presentation/results.mjs';

const idPattern = '[a-f0-9]{48}';
function fields(body, required, optional = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      required.some(key => !Object.hasOwn(body, key)) ||
      Object.keys(body).some(key => ![...required, ...optional].includes(key))) throw Error('Invalid file fields');
  return body;
}
function destination(body, upload) {
  fields(body, upload ? ['fileName', 'size', 'sha256', 'remotePath'] : ['remotePath'],
    upload ? ['target', 'overwrite', 'elevate'] : ['target', 'elevate']);
  if (body.target !== undefined && (typeof body.target !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(body.target))) throw Error('Invalid target');
  for (const flag of ['overwrite', 'elevate']) if (body[flag] !== undefined && typeof body[flag] !== 'boolean') throw Error('Invalid file flag');
  return { ...body, elevate: body.elevate ?? false, ...(upload ? { overwrite: body.overwrite ?? false } : {}) };
}

/** Called only AFTER the shared administrator authorization/Origin policy. */
export async function routeFileApi(req, res, url, { files, store, queue, targets, json, authorize }) {
  const upload = new RegExp('^/api/files/uploads/(' + idPattern + ')(?:/(chunks|finish))?$').exec(url.pathname);
  if (!['/api/files/uploads', '/api/files/downloads'].includes(url.pathname) && !upload) return false;
  if (url.search) throw Error('Unexpected file query');
  if (upload && !upload[2] && req.method === 'GET') {
    const job = queue.listAll().find(job => job.kind === 'upload' && job.operation.artifactId === upload[1]);
    if (job) { json(res, 200, { job: presentJob(job) }); return true; }
    targets?.artifactOwner(upload[1]);
    const item = store.get(upload[1]);
    // Explicit metadata only: never reveal backing paths, bytes or capabilities.
    json(res, 200, { transfer: Object.fromEntries(['id', 'state', 'received', 'sequence', 'expiresAt', 'fileName', 'size', 'sha256', 'remotePath', 'overwrite', 'elevate', 'targetId', 'targetRevision'].filter(key => item[key] !== undefined).map(key => [key, item[key]])) });
    return true;
  }
  if (req.method !== 'POST' || (upload && !upload[2])) { json(res, 405, { error: 'Method not allowed' }); return true; }
  if (req.headers['content-type'] !== 'application/json') { json(res, 415, { error: 'JSON required' }); return true; }
  const parts = []; let size = 0;
  const limit = upload?.[2] === 'chunks' ? Math.ceil(CHUNK_BYTES / 3) * 4 + 512 : 8192;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) { json(res, 413, { error: 'File request too large' }); return true; }
    parts.push(chunk);
  }
  // Header admission predates body I/O. A logout/expiry while reading the body
  // must not admit a NEW file operation using that earlier authorization.
  const permission = await authorize();
  if (!permission.allowed) {
    json(res, permission.status ?? 403, { error: permission.status === 401 ? 'Unauthorized' : 'Forbidden' });
    return true;
  }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); }
  catch { json(res, 400, { error: 'Invalid JSON' }); return true; }
  let value;
  if (url.pathname === '/api/files/uploads') {
    const item = await files.beginUpload(destination(body, true));
    value = { transferId: item.id, received: 0, sequence: 0 };
  } else if (url.pathname === '/api/files/downloads') value = presentJob(files.requestDownload(destination(body, false)));
  else if (upload[2] === 'chunks') {
    fields(body, ['sequence', 'data']);
    if (typeof body.data !== 'string' || body.data.length > Math.ceil(CHUNK_BYTES / 3) * 4) throw Error('Invalid file chunk');
    const bytes = Buffer.from(body.data, 'base64');
    if (!bytes.length || bytes.length > CHUNK_BYTES || bytes.toString('base64') !== body.data) throw Error('Invalid file chunk');
    value = await files.appendUpload({ id: upload[1], sequence: body.sequence, bytes });
  } else {
    fields(body, []);
    value = presentJob(await files.finishUpload(upload[1]));
  }
  json(res, 200, value); return true;
}
