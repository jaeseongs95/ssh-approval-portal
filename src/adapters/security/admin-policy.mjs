import { authenticated } from './tickets.mjs';

/** Route classification is separate from execution; these exceptions preserve the existing policy. */
export async function authorizeAdminRequest(req, { adminAccess, adminToken, adminOrigin }) {
  let pathname;
  try { pathname = new URL(req.url, adminOrigin).pathname; } catch { return { allowed: false, status: 409, routeKind: 'api' }; }
  const method = req.method;
  const routeKind = ['/api/maintenance/reserve', '/api/maintenance/release'].includes(pathname) ? 'maintenance'
    : method === 'GET' && pathname === '/api/session' ? 'session'
    : ['GET', 'HEAD'].includes(method) && /^\/downloads\/[a-f0-9]{48}\/[a-f0-9]{32}$/.test(pathname) ? 'download'
    : method === 'GET' && ['/', '/settings', '/history', '/app.js'].includes(pathname) ? 'static' : 'api';
  const deny = status => ({ allowed: false, status, routeKind });
  if (routeKind === 'maintenance') {
    if (!authenticated(req, adminToken)) return deny(401);
  } else if (adminAccess.mode === 'access') {
    if (!await adminAccess.authenticated(req)) return deny(401);
  } else if (routeKind === 'api' && !authenticated(req, adminToken)) return deny(401);
  if (['api', 'maintenance'].includes(routeKind) &&
      !(method === 'GET' && (['/api/pending', '/api/requests', '/api/targets', '/api/command-policy', '/api/automation-metrics', '/api/environment'].includes(pathname) || /^\/api\/[a-f0-9]{48}$/.test(pathname) || /^\/api\/outputs\/[a-f0-9]{48}$/.test(pathname))) &&
      (method !== 'POST' || req.headers.origin !== adminOrigin)) return deny(403);
  return { allowed: true, routeKind };
}
