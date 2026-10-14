import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { ApprovalQueue, Tickets, routeCommand, validateCommand, equalSecret, idValid, remotePath, hash } from './core.mjs';
import { Artifacts, CHUNK_BYTES, MAX_BYTES } from './artifacts.mjs';
import { Transfers } from './transfers.mjs';
import { createAdminAccess } from './admin-access.mjs';

const outputSchema = z.object({}).passthrough();
const id = z.string().regex(/^[a-f0-9]{48}$/);
const ticket = z.string().min(1).max(8192);
const publicResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const refused = () => ({ isError: true, content: [{ type: 'text', text: 'Request refused or failed. Check authentication, state, limits and permissions.' }] });
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
const authenticated = (req, secret) => equalSecret(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1], secret);

export async function createApplication({ registry, classify, executeCommand, audit, transferRoot, env = process.env, uiHtml, accessKeySet }) {
  const URI = `ui://ssh-approval/card-${hash(uiHtml)}.html`;
  const mcpToken = env.BRIDGE_MCP_TOKEN, adminToken = env.BRIDGE_ADMIN_TOKEN;
  const adminOrigin = env.BRIDGE_ADMIN_ORIGIN;
  if (!mcpToken || !adminToken || equalSecret(mcpToken, adminToken) || !/^https:\/\/[^/]+$/.test(adminOrigin ?? '')) throw Error('Configure distinct tokens and one HTTPS admin origin');
  const adminAccess = createAdminAccess(env, accessKeySet);
  const signer = new Tickets(env.BRIDGE_UI_TICKET_KEY);
  const enabled = env.BRIDGE_UI_ENABLED === 'true';
  const prefix = env.BRIDGE_UI_TOOL_PREFIX ?? 'ssh-approval-bridge_';
  if (!/^[A-Za-z0-9_-]*$/.test(prefix)) throw Error('Invalid UI namespace');
  const maxBytes = Number(env.BRIDGE_TRANSFER_MAX_BYTES ?? MAX_BYTES), budget = Number(env.BRIDGE_TRANSFER_BUDGET_BYTES ?? 512 * 1024 * 1024);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BYTES || !Number.isSafeInteger(budget) || budget < maxBytes) throw Error('Invalid staging limits');
  const store = new Artifacts(transferRoot, { maxBytes, budget }); await store.init();
  const reader = registry.getProfile('aws-readonly'), writer = registry.getProfile('aws-local');
  if (!reader.readOnly || writer.readOnly || ['host', 'port', 'user'].some(k => reader[k] !== writer[k])) throw Error('Expected matching writable and read-only SSH targets');
  const target = `${writer.user}@${writer.host}:${writer.port}`;
  const transfers = new Transfers(registry, store);
  let activeReads = 0;
  const queue = new ApprovalQueue({ classify, target, audit, externalBusy: () => activeReads > 0, executeOperation: op => op.kind === 'command' ? executeCommand('aws-local', op.command) : op.kind === 'upload' ? transfers.upload(op) : transfers.download(op),
    onTerminal: job => {
      if (job.operation.kind === 'upload') {
        const artifact = store.items.get(job.operation.artifactId);
        if (artifact) { artifact.pinned = false; artifact.expiresAt = Date.now(); }
      }
    },
  });
  const uiGuard = () => { if (!enabled || queue.maintenance) throw Error('UI actions are disabled or maintenance is in progress'); };
  const checkJob = (requestId, cap, purpose) => signer.verify(cap, purpose, queue.subject(requestId));
  const privateView = job => {
    const meta = { uiEnabled: enabled, namespace: prefix, maxBytes, chunkBytes: CHUNK_BYTES, webUrl: adminOrigin };
    if (enabled) {
      meta.viewTicket = signer.issue('view', queue.subject(job.id), Date.now() + 600_000);
      if (job.state === 'pending') meta.approvalTicket = signer.issue('decision', queue.subject(job.id), job.expiresAt);
    }
    return meta;
  };
  const readCommand = async command => {
    if (queue.maintenance || queue.busy()) throw Error('Maintenance or another operation is in progress');
    if (validateCommand(command, classify).class !== 'read-only') throw Error('Approval required');
    audit({ action: 'read-started', command, profile: 'aws-readonly', target });
    activeReads++;
    let result;
    try { result = await executeCommand('aws-readonly', command); } finally { activeReads--; }
    audit({ action: result.isError ? 'read-failed' : 'read-completed', profile: 'aws-readonly', target });
    return { ...result, structuredContent: { state: result.isError ? 'failed' : 'completed', kind: 'command' } };
  };
  const downloadsUsed = new Map();
  const downloadLink = (job, expiresAt = Date.now() + 600_000) => {
    if (job?.kind !== 'download' || job.state !== 'completed') throw Error('Download is not ready');
    const x = store.get(job.result.structuredContent.artifactId);
    const nonce = randomBytes(16).toString('hex');
    const cap = signer.issue('file', `${x.id}:${x.sha256}:${nonce}`, Math.min(expiresAt, x.expiresAt));
    return `${adminOrigin}/downloads/${x.id}/${nonce}?ticket=${encodeURIComponent(cap)}`;
  };
  function mcpServer() {
    const server = new McpServer({ name: 'SSH Approval Portal', version: '0.3.0' });
    server.registerResource('SSH approval card', URI, { mimeType: 'text/html;profile=mcp-app' }, async () => ({ contents: [{ uri: URI, mimeType: 'text/html;profile=mcp-app', text: uiHtml, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } } }] }));
    const tool = (name, schema, handler, { ui = false, appOnly = false, description = name, readOnly = false } = {}) => server.registerTool(name, {
      description, inputSchema: schema, outputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly },
      _meta: (ui || appOnly) ? { ui: { ...(ui ? { resourceUri: URI } : {}), visibility: appOnly ? ['app'] : ['model', 'app'] } } : undefined,
    }, async args => { try { return await handler(args); } catch { return refused(); } });
    tool('read-command', { command: z.string().min(1).max(2000) }, ({ command }) => readCommand(command), { readOnly: true, description: 'Execute proven read-only commands immediately.' });
    tool('run-command', { command: z.string().min(1).max(2000) }, async ({ command }) => {
      const result = await routeCommand(command, classify, readCommand, queue); return result?.content ? result : publicResult(result);
    }, { description: 'Run read-only immediately; queue all other commands for approval. If pending, call show-approval with its id to show the owner the approval card.' });
    tool('request-safe-command', { command: z.string().min(1).max(2000) }, ({ command }) => publicResult(queue.submit(command, true)), { description: 'Legacy safe-only owner approval request.' });
    tool('get-request-status', { id }, ({ id }) => publicResult(queue.get(id) ?? { error: 'Unknown request; server may have restarted' }), { readOnly: true });
    tool('show-ui-probe', {}, () => ({ ...publicResult({ probe: 'SSH_UI_PUBLIC_PROBE', uiEnabled: enabled }), _meta: { sshApproval: { privateMarker: 'SSH_UI_PRIVATE_PROBE_NOT_FOR_MODEL', uiEnabled: false, namespace: prefix, webUrl: adminOrigin } } }), { ui: true, readOnly: true, description: 'Display a harmless UI compatibility probe. No command, approval ticket or file data.' });
    tool('show-approval', { id }, ({ id }) => {
      const job = queue.get(id); if (!job) throw Error('Unknown request');
      return { ...publicResult(job), _meta: { sshApproval: privateView(job) } };
    }, { ui: true, readOnly: true });
    tool('show-file-transfer', { direction: z.enum(['upload', 'download']), remotePath: z.string().max(4096), elevate: z.boolean().default(false), overwrite: z.boolean().default(false) }, args => {
      remotePath(args.remotePath);
      return { ...publicResult({ transfer: args, uiEnabled: enabled, maxBytes }), _meta: { sshApproval: { uiEnabled: enabled, namespace: prefix, maxBytes, chunkBytes: CHUNK_BYTES, webUrl: adminOrigin, ...(enabled ? { bootstrapTicket: signer.issue('bootstrap', hash(JSON.stringify(args)), Date.now() + 600_000) } : {}) } } };
    }, { ui: true, readOnly: true });
    tool('request-download', { remotePath: z.string().max(4096), elevate: z.boolean().default(false) }, args => {
      remotePath(args.remotePath);
      if (!args.elevate && queue.busy()) throw Error('Execution busy');
      const job = queue.submitOperation({ kind: 'download', remotePath: args.remotePath, elevate: args.elevate }, args.elevate ? 'privileged' : 'read-only');
      if (!args.elevate) queue.start(job.id, true);
      return publicResult(queue.get(job.id));
    }, { description: 'Read a regular remote file, or queue a sudo download. Call show-approval for the returned id to display status and save button.' });
    tool('ui-decide-request', { id, action: z.enum(['approve', 'deny']), ticket }, ({ id, action, ticket }) => {
      uiGuard(); checkJob(id, ticket, 'decision');
      const job = action === 'approve' ? queue.start(id) : queue.deny(id);
      return { ...publicResult(job), _meta: { sshApproval: privateView(job) } };
    }, { appOnly: true });
    tool('ui-upload-begin', { transfer: z.object({ direction: z.literal('upload'), remotePath: z.string().max(4096), elevate: z.boolean(), overwrite: z.boolean() }), ticket, fileName: z.string().max(255), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }, async ({ transfer, ticket, ...meta }) => {
      uiGuard(); signer.verify(ticket, 'bootstrap', hash(JSON.stringify(transfer)));
      const x = await store.begin({ ...transfer, ...meta });
      return { ...publicResult({ transferId: x.id, received: 0 }), _meta: { sshApproval: { uploadTicket: signer.issue('upload', store.subject(x.id), x.expiresAt) } } };
    }, { appOnly: true });
    tool('ui-upload-chunk', { id, ticket, sequence: z.number().int().nonnegative(), data: z.string().max(Math.ceil(CHUNK_BYTES / 3) * 4) }, async ({ id, ticket, sequence, data }) => {
      uiGuard(); signer.verify(ticket, 'upload', store.subject(id)); return publicResult(await store.chunk(id, sequence, data));
    }, { appOnly: true });
    tool('ui-upload-finish', { id, ticket }, async ({ id, ticket }) => {
      uiGuard(); signer.verify(ticket, 'upload', store.subject(id));
      const x = await store.finish(id);
      try {
        const job = queue.submitOperation({ kind: 'upload', artifactId: x.id, remotePath: x.remotePath, fileName: x.fileName, size: x.size, sha256: x.sha256, overwrite: x.overwrite, elevate: x.elevate }, x.elevate ? 'privileged' : 'safe');
        return { ...publicResult(job), _meta: { sshApproval: privateView(job) } };
      } catch (err) { await store.remove(x.id); throw err; }
    }, { appOnly: true });
    tool('ui-download-link', { id, ticket }, ({ id, ticket }) => {
      uiGuard(); checkJob(id, ticket, 'view');
      const job = queue.get(id);
      return { ...publicResult({ ready: true, fileName: job.result?.structuredContent?.fileName }), _meta: { sshApproval: { downloadUrl: downloadLink(job), fileName: job.result.structuredContent.fileName } } };
    }, { appOnly: true, readOnly: true });
    return server;
  }
  const mcpHttp = createServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'GET') return json(res, 200, { healthy: true, version: '0.3.0', uiEnabled: enabled, adminAuthMode: adminAccess.mode, busy: queue.busy() || activeReads > 0, pending: queue.list().length, maintenance: queue.maintenance });
    if (req.url !== '/mcp' || !authenticated(req, mcpToken)) return json(res, 401, { error: 'Unauthorized' });
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxMessageSize: 1024 * 1024 });
    const server = mcpServer();
    try { await server.connect(transport); await transport.handleRequest(req, res); }
    catch { if (!res.headersSent) json(res, 500, { error: 'MCP request failed' }); }
    finally { await server.close().catch(() => {}); }
  });
  const webHtml = await readFile(new URL('./web/index.html', import.meta.url), 'utf8');
  const webJs = await readFile(new URL('./web/app.js', import.meta.url), 'utf8');
  const adminHttp = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, adminOrigin);
      // Local deployment tooling keeps its server-only token; it cannot approve jobs in Access mode.
      const maintenance = ['/api/maintenance/reserve', '/api/maintenance/release'].includes(url.pathname);
      if (maintenance && !authenticated(req, adminToken)) return json(res, 401, { error: 'Unauthorized' });
      if (!maintenance && adminAccess.mode === 'access' && !await adminAccess.authenticated(req)) return json(res, 401, { error: 'Unauthorized' });
      if (req.method === 'GET' && url.pathname === '/api/session') return json(res, 200, { mode: adminAccess.mode });
      const match = /^\/downloads\/([a-f0-9]{48})\/([a-f0-9]{32})$/.exec(url.pathname);
      if (match && ['GET', 'HEAD'].includes(req.method)) {
        const x = store.get(match[1]), cap = url.searchParams.get('ticket');
        signer.verify(cap, 'file', `${x.id}:${x.sha256}:${match[2]}`);
        if (Date.now() >= x.expiresAt || downloadsUsed.has(hash(cap))) throw Error('Download unavailable');
        // Claim before the first await. A failed read consumes this URL too; the UI can mint a new one.
        if (req.method === 'GET') downloadsUsed.set(hash(cap), Date.now() + 600_000);
        const fd = await store.verified(x.id);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': x.size, 'Content-Disposition': `attachment; filename="download.bin"; filename*=UTF-8''${encodeURIComponent(x.fileName)}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
        if (req.method === 'HEAD') { await fd.close(); res.end(); }
        else {
          const stream = fd.createReadStream({ start: 0, autoClose: true });
          res.on('close', () => stream.destroy()); stream.on('error', () => res.destroy()); stream.pipe(res);
        }
        return;
      }
      if (req.method === 'GET' && ['/', '/app.js'].includes(url.pathname)) {
        res.writeHead(200, { 'Content-Type': url.pathname === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' });
        return res.end(url.pathname === '/' ? webHtml.replace('data-auth-mode="token"', `data-auth-mode="${adminAccess.mode}"`) : webJs);
      }
      if (!maintenance && adminAccess.mode === 'token' && !authenticated(req, adminToken)) return json(res, 401, { error: 'Unauthorized' });
      if (req.method === 'GET' && url.pathname === '/api/pending') return json(res, 200, queue.list());
      if (req.method === 'GET' && url.pathname === '/api/requests') return json(res, 200, [...queue.jobs.keys()].map(id => queue.get(id)));
      const single = /^\/api\/([a-f0-9]{48})$/.exec(url.pathname);
      if (req.method === 'GET' && single) return json(res, 200, queue.get(single[1]) ?? { error: 'Unknown request' });
      if (req.method !== 'POST' || req.headers.origin !== adminOrigin) return json(res, 403, { error: 'Forbidden' });
      if (url.pathname === '/api/maintenance/reserve') {
        if (activeReads || [...store.items.values()].some(x => x.busy || x.pinned || x.state === 'staging')) throw Error('Transfer or read in progress');
        queue.reserveMaintenance(); return json(res, 200, { reserved: true });
      }
      if (url.pathname === '/api/maintenance/release') { queue.releaseMaintenance(); return json(res, 200, { released: true }); }
      const action = /^\/api\/([a-f0-9]{48})\/(approve|deny|download)$/.exec(url.pathname);
      if (!action) return json(res, 404, { error: 'Not found' });
      if (action[2] === 'download') return json(res, 200, { downloadUrl: downloadLink(queue.get(action[1])) });
      const result = action[2] === 'approve' ? await queue.approve(action[1]) : queue.deny(action[1]);
      json(res, 200, result);
    } catch { if (!res.headersSent) json(res, 409, { error: 'Request refused, expired, busy or unavailable' }); }
  });
  const timer = setInterval(() => {
    try { queue.reap(); } catch { /* Expiry remains non-executable even if its audit failed. */ }
    store.reap().catch(() => {});
    for (const [key, expires] of downloadsUsed) if (Date.now() >= expires) downloadsUsed.delete(key);
  }, 30_000); timer.unref();
  return { mcpHttp, adminHttp, queue, store, transfers, mcpServer, enabled,
    async close() {
      queue.maintenance = true; clearInterval(timer);
      await Promise.all([mcpHttp, adminHttp].map(server => new Promise(resolve => server.close(resolve))));
      await queue.active?.completion;
      await registry.closeAll();
    } };
}
