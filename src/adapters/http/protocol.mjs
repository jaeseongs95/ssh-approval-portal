import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authenticated } from '../security/tickets.mjs';
import { createMcpAdapter } from '../mcp/server.mjs';
import { createCapabilities } from '../presentation/capabilities.mjs';
import { presentJob } from '../presentation/results.mjs';

const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };

const escapeHtml = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function createProtocolAdapters({ queue, commands, files, store, lifecycle, settings, signer, adminAccess, authorizeAdminRequest, uiHtml, webHtml, webJs, bindFileSource, shutdownSignal, targets, requestSafety, commandPolicy, commandOutputs }) {
  const capabilities = createCapabilities({ queue, store, signer, settings, targets });
  const mcpServer = createMcpAdapter({ queue, commands, files, settings, capabilities, uiHtml, bindFileSource, shutdownSignal, targets, requestSafety, commandOutputs });
  const mcpHttp = createServer(async (req, res) => {
    let server, disconnect, aborted, closed;
    try {
      if (req.url === '/health' && req.method === 'GET') return json(res, 200, { healthy: true, version: '1.1.0', uiEnabled: settings.uiEnabled, adminAuthMode: adminAccess.mode, ...lifecycle.snapshot() });
      if (req.url !== '/mcp' || !authenticated(req, settings.mcpToken)) return json(res, 401, { error: 'Unauthorized' });
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxMessageSize: 1024 * 1024 });
      disconnect = new AbortController();
      aborted = () => disconnect.abort(); closed = () => { if (!res.writableEnded) aborted(); };
      req.once('aborted', aborted); res.once('close', closed);
      server = mcpServer(disconnect.signal);
      await server.connect(transport); await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) json(res, req.url === '/health' ? 503 : 500, { error: req.url === '/health' ? 'Health check unavailable' : 'MCP request failed' });
    } finally {
      if (aborted) req.off('aborted', aborted);
      if (closed) res.off('close', closed);
      await server?.close().catch(() => {});
    }
  });
  const adminHttp = createServer(async (req, res) => {
    try {
      const authorization = await authorizeAdminRequest(req, { adminAccess, adminToken: settings.adminToken, adminOrigin: settings.adminOrigin });
      if (!authorization.allowed) return json(res, authorization.status ?? 403, { error: authorization.status === 401 ? 'Unauthorized' : authorization.status === 409 ? 'Request refused, expired, busy or unavailable' : 'Forbidden' });
      const url = new URL(req.url, settings.adminOrigin);
      const filter = url.searchParams.getAll('target');
      if (filter.length && (!['/api/requests', '/api/pending'].includes(url.pathname) || filter.length !== 1 || !targets)) throw Error('Conflicting target selector');
      if (filter.length) targets.select(filter[0]);
      const visible = jobs => filter.length ? jobs.filter(job => (job.targetId ?? 'default') === filter[0]) : jobs;
      if (req.method === 'GET' && url.pathname === '/api/targets') return json(res, 200, targets?.list() ?? { targets: [{ id: 'default', displayName: settings.targetDisplayName ?? 'SSH', enabled: true, isDefault: true }], defaultTarget: 'default' });
      if (req.method === 'GET' && url.pathname === '/api/session') return json(res, 200, { mode: adminAccess.mode });
      const output = /^\/api\/outputs\/([a-f0-9]{48})$/.exec(url.pathname);
      if (req.method === 'GET' && output) return json(res, 200, commandOutputs.read({ outputId: output[1],
        offsetBytes: Number(url.searchParams.get('offset') ?? 0), maxBytes: Number(url.searchParams.get('limit') ?? 4096), format: url.searchParams.get('format') ?? 'text' }));
      if (['/api/command-policy', '/api/command-policy/review'].includes(url.pathname) && commandPolicy) {
        if (req.method === 'GET' && url.pathname === '/api/command-policy') return json(res, 200, await commandPolicy.get());
        if (req.method === 'POST') {
          const chunks = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > 65536) throw Error('Policy too large'); chunks.push(chunk); }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (url.pathname.endsWith('/review')) return json(res, 200, await commandPolicy.review(body.policy, body.expectedRevision));
          return json(res, 200, commandPolicy.set(body.policy, body.expectedRevision, body.reviewToken, body.acknowledged));
        }
      }
      const match = /^\/downloads\/([a-f0-9]{48})\/([a-f0-9]{32})$/.exec(url.pathname);
      if (match && ['GET', 'HEAD'].includes(req.method)) {
        const item = capabilities.claimDownload(match[1], match[2], url.searchParams.get('ticket'), req.method);
        const fd = await store.verified(item.id);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': item.size, 'Content-Disposition': `attachment; filename="download.bin"; filename*=UTF-8''${encodeURIComponent(item.fileName)}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
        if (req.method === 'HEAD') { await fd.close(); res.end(); }
        else {
          const stream = fd.createReadStream({ start: 0, autoClose: true });
          res.on('close', () => stream.destroy()); stream.on('error', () => res.destroy()); stream.pipe(res);
        }
        return;
      }
      if (req.method === 'GET' && ['/', '/app.js'].includes(url.pathname)) {
        res.writeHead(200, { 'Content-Type': url.pathname === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' });
        return res.end(url.pathname === '/' ? webHtml.replace('data-auth-mode="token"', () => `data-auth-mode="${adminAccess.mode}" data-command-automation="${Boolean(commandPolicy)}" data-multi-target="${settings.targets ? 'true' : 'false'}" data-bridge-display-name="${escapeHtml(settings.bridgeDisplayName)}" data-target-display-name="${escapeHtml(settings.targetDisplayName)}"`)
          .replace('<title>SSH 승인 · Approval Portal</title>', () => `<title>${escapeHtml(settings.bridgeDisplayName)} · ${escapeHtml(settings.targetDisplayName)} · SSH Approval Portal</title>`) : webJs);
      }
      if (req.method === 'GET' && url.pathname === '/api/pending') return json(res, 200, visible(queue.list()).map(presentJob));
      if (req.method === 'GET' && url.pathname === '/api/requests') return json(res, 200, visible(queue.listAll()).map(presentJob));
      const single = /^\/api\/([a-f0-9]{48})$/.exec(url.pathname);
      if (req.method === 'GET' && single) { const job = queue.get(single[1]); return json(res, 200, job ? presentJob(job) : { error: 'Unknown request' }); }
      if (url.pathname === '/api/maintenance/reserve') { lifecycle.reserve(); return json(res, 200, { reserved: true }); }
      if (url.pathname === '/api/maintenance/release') { lifecycle.release(); return json(res, 200, { released: true }); }
      const action = /^\/api\/([a-f0-9]{48})\/(approve|deny|download)$/.exec(url.pathname);
      if (!action) return json(res, 404, { error: 'Not found' });
      if (action[2] === 'download') return json(res, 200, { downloadUrl: capabilities.downloadLink(queue.get(action[1])) });
      const result = action[2] === 'approve' ? await queue.approve(action[1]) : queue.deny(action[1]);
      json(res, 200, presentJob(result));
    } catch { if (!res.headersSent) json(res, 409, { error: 'Request refused, expired, busy or unavailable' }); }
  });
  return { mcpHttp, adminHttp, mcpServer, reapCapabilities: capabilities.reap };
}
