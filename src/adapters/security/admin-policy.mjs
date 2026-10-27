import { authenticated } from './tickets.mjs';

/** Route classification is separate from execution; these exceptions preserve the existing policy. */
export async function authorizeAdminRequest(req, { adminAccess, adminToken, adminOrigin, browserSessions }) {
  let pathname;
  try { pathname = new URL(req.url, adminOrigin).pathname; } catch { return { allowed: false, status: 409, routeKind: 'api' }; }
  const method = req.method;
  const routeKind = ['/api/maintenance/reserve', '/api/maintenance/release', '/api/maintenance/status', '/api/maintenance/capabilities', '/api/maintenance/preservation/capture', '/api/maintenance/preservation/compare'].includes(pathname) ? 'maintenance'
    : method === 'GET' && pathname === '/api/session' ? 'session'
    : ['GET', 'HEAD'].includes(method) && /^\/downloads\/[a-f0-9]{48}\/[a-f0-9]{32}$/.test(pathname) ? 'download'
    : method === 'GET' && ['/', '/settings', '/history', '/app.js', '/signed-out'].includes(pathname) ? 'static' : 'api';
  let principal;
  const deny = status => ({ allowed: false, status, routeKind });
  if (routeKind === 'maintenance') {
    if (!authenticated(req, adminToken)) return deny(401);
  } else if (['access', 'oidc'].includes(adminAccess.mode)) {
    principal=typeof adminAccess.identity==='function'?await adminAccess.identity(req):null;
    if(!principal)return deny(401);
    if(['api','download'].includes(routeKind)&&!['/api/session/start','/api/session/logout'].includes(pathname)&&!browserSessions?.authenticated(req,principal))return deny(401);
  } else if (routeKind === 'api' && !authenticated(req, adminToken)) return deny(401);
  if (pathname === '/api/agent-cli/history' && req.headers.origin && req.headers.origin !== adminOrigin) return deny(403);
  if (['api', 'maintenance'].includes(routeKind) &&
      !(method === 'GET' && (['/api/pending', '/api/requests', '/api/targets', '/api/command-policy', '/api/automation-metrics', '/api/environment','/api/agent-cli','/api/agent-cli/lookup','/api/agent-cli/history'].includes(pathname) || /^\/api\/[a-f0-9]{48}$/.test(pathname) || /^\/api\/files\/uploads\/[a-f0-9]{48}$/.test(pathname) || /^\/api\/outputs\/[a-f0-9]{48}$/.test(pathname) || /^\/api\/[a-f0-9]{48}\/source$/.test(pathname) || /^\/api\/agent-cli\/requests\/[a-f0-9]{48}$/.test(pathname))) &&
      (method !== 'POST' || req.headers.origin !== adminOrigin)) return deny(403);
  return { allowed: true, routeKind, ...(principal&&['/api/session/start','/api/session/logout'].includes(pathname)?{principal}:{}) };
}
