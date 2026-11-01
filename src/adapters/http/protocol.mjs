import metadata from '../../../package.json' with { type: 'json' };
import { routeFileApi } from './file-api.mjs';
import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authenticated } from '../security/tickets.mjs';
import { createMcpAdapter } from '../mcp/server.mjs';
import { createCapabilities } from '../presentation/capabilities.mjs';
import { presentJob } from '../presentation/results.mjs';
import { BASELINE_PRESERVATION_CONTRACT } from '../storage/preservation-verification.mjs';
import { createRequestAdmission, RequestAdmissionError } from '../../application/request-admission.mjs';

const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };

const escapeHtml = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function requestScope(req, res) {
  const controller = new AbortController();
  const aborted = () => controller.abort();
  const closed = () => { if (!res.writableFinished) aborted(); };
  req.once('aborted', aborted); res.once('close', closed);
  if (req.aborted || res.destroyed) aborted();
  return { signal: controller.signal, cleanup() { req.off('aborted', aborted); res.off('close', closed); } };
}

function admissionRefusal(res, error) {
  if (res.destroyed || res.writableEnded) return;
  // Do not retain or drain an unadmitted body on a reusable connection.
  res.setHeader('Retry-After', '1'); res.setHeader('Connection', 'close');
  json(res, 503, { error: error.code, executionAttempted: false, requestSubmitted: false, retryAfterMs: 1000 });
}

async function responseFinished(res) {
  if (res.writableFinished || res.destroyed) return;
  await new Promise(resolve => {
    const done = () => { res.off('finish', done); res.off('close', done); resolve(); };
    res.once('finish', done); res.once('close', done);
  });
}

export function createProtocolAdapters({ queue, commands, files, store, lifecycle, settings, signer, adminAccess, browserSessions, authorizeAdminRequest, uiHtml, webHtml, webJs, bindFileSource, shutdownSignal, targets, requestSafety, commandPolicy, commandOutputs, automationMetrics, environmentEditor,agentCli, preservation, retainedHistory, requestAdmission }) {
  const capabilities = createCapabilities({ queue, store, signer, settings, targets, adminAuthMode: adminAccess.mode });
  const mcpServer = createMcpAdapter({ queue, commands, files, settings, capabilities, uiHtml, bindFileSource, shutdownSignal, targets, requestSafety, commandOutputs });
  const admission = {
    mcp: createRequestAdmission(requestAdmission?.mcp),
    admin: createRequestAdmission({ maxActive: 4, maxQueued: 16, maxWaitMs: 5000, maxDetached: 8, ...requestAdmission?.admin }),
  };
  const closeAdmission = () => { admission.mcp.close(); admission.admin.close(); };
  if (shutdownSignal?.aborted) closeAdmission();
  else shutdownSignal?.addEventListener('abort', closeAdmission, { once: true });
  const mcpHttp = createServer(async (req, res) => {
    let server, scope, lease;
    try {
      if (req.url === '/health' && req.method === 'GET') return json(res, 200, { healthy: true, version: metadata.version, uiEnabled: settings.uiEnabled, adminAuthMode: adminAccess.mode, ...lifecycle.snapshot(), requestAdmission: { mcp: admission.mcp.snapshot(), admin: admission.admin.snapshot() } });
      if (req.url !== '/mcp' || !authenticated(req, settings.mcpToken)) return json(res, 401, { error: 'Unauthorized' });
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      scope = requestScope(req, res);
      lease = await admission.mcp.acquire({ signal: scope.signal });
      if (scope.signal.aborted) return;
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 1024 * 1024 });
      server = mcpServer(scope.signal, lease);
      await server.connect(transport); await transport.handleRequest(req, res);
    } catch (error) {
      if (error instanceof RequestAdmissionError) admissionRefusal(res, error);
      else if (!res.headersSent && !res.destroyed) json(res, req.url === '/health' ? 503 : 500, { error: req.url === '/health' ? 'Health check unavailable' : 'MCP request failed' });
    } finally {
      try { await server?.close().catch(() => {}); await responseFinished(res); }
      finally { scope?.cleanup(); lease?.release(); }
    }
  });
  const adminHttp = createServer(async (req, res) => {
    const scope = requestScope(req, res);
    let lease;
    try {
      // Separate from MCP saturation, including before potentially async identity verification.
      lease = await admission.admin.acquire({ signal: scope.signal });
      if (scope.signal.aborted) return;
      const authorize = () => authorizeAdminRequest(req, { adminAccess, adminToken: settings.adminToken, adminOrigin: settings.adminOrigin, browserSessions });
      const authorization = await authorize();
      if (!authorization.allowed) return json(res, authorization.status ?? 403, { error: authorization.status === 401 ? 'Unauthorized' : authorization.status === 409 ? 'Request refused, expired, busy or unavailable' : 'Forbidden' });
      const url = new URL(req.url, settings.adminOrigin);
      if (url.pathname === '/api/history') {
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
        if (!retainedHistory) return json(res, 503, { error: 'HISTORY_UNAVAILABLE' });
        try { return json(res, 200, retainedHistory(url.searchParams)); }
        catch (error) { return json(res, error.historyCode ? error.status : 503, { error: error.historyCode ?? 'HISTORY_UNAVAILABLE' }); }
      }
      if(req.method==='GET'&&url.pathname==='/signed-out'){
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});
        return res.end('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>관리자 로그아웃 · Signed out</title><style>body{font:16px system-ui;background:#f3f5fa;color:#182946;margin:0;padding:10vh 24px}main{max-width:560px;margin:auto;background:white;border:1px solid #dbe2ef;border-radius:16px;padding:32px}a{display:inline-block;margin-top:16px;color:#174db4}</style><main><h1>관리자 로그아웃 완료</h1><p>Administrator signed out.</p><p>MCP 인증은 유지됩니다. · MCP authentication is preserved.</p><a href="/">관리자 다시 연결 · Reconnect administrator</a></main></html>');
      }
      if(['/api/session/start','/api/session/logout'].includes(url.pathname)){
        if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
        if(!browserSessions||!authorization.principal||url.search)throw Error('Administrator session unavailable');
        if(req.headers['content-type']!=='application/json')return json(res,415,{error:'Content type required'});
        const chunks=[];let bytes=0;for await(const part of req){const chunk=Buffer.from(part);bytes+=chunk.length;if(bytes>256)return json(res,413,{error:'Request too large'});chunks.push(chunk);}
        let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{return json(res,400,{error:'Invalid request'});}
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)throw Error('Invalid session fields');
        if(url.pathname.endsWith('/start'))browserSessions.start(req,res,authorization.principal);else browserSessions.end(req,res,authorization.principal);
        return json(res,200,{connected:url.pathname.endsWith('/start')});
      }
      if (await routeFileApi(req, res, url, { files, store, queue, targets, json, authorize })) return;
      const filter = url.searchParams.getAll('target');
      if (filter.length && (!['/api/requests', '/api/pending', '/api/automation-metrics'].includes(url.pathname) || filter.length !== 1 || !targets)) throw Error('Conflicting target selector');
      if (filter.length) targets.select(filter[0]);
      const visible = jobs => filter.length ? jobs.filter(job => (job.targetId ?? 'default') === filter[0]) : jobs;
      if (req.method === 'GET' && url.pathname === '/api/targets') return json(res, 200, targets?.list() ?? { targets: [{ id: 'default', displayName: settings.targetDisplayName ?? 'SSH', enabled: true, isDefault: true }], defaultTarget: 'default' });
      if (req.method === 'GET' && url.pathname === '/api/session') return json(res, 200, { mode: adminAccess.mode });
      if(agentCli && req.method==='GET' && url.pathname==='/api/agent-cli')return json(res,200,agentCli.get());
      if(agentCli && req.method==='GET' && url.pathname==='/api/agent-cli/history'){
        const keys=url.searchParams.has('before')||url.searchParams.has('beforeId')?['targetId','provider','before','beforeId']:['targetId','provider'];
        if([...url.searchParams].length!==keys.length||keys.some(key=>url.searchParams.getAll(key).length!==1))throw Error('Invalid CLI history fields');
        const fields=Object.fromEntries(url.searchParams);
        if(keys.length===4){if(!/^[1-9][0-9]{0,15}$/.test(fields.before))throw Error('Invalid CLI history cursor');fields.before=Number(fields.before);}
        return json(res,200,agentCli.history(fields));
      }
      if(agentCli && req.method==='GET' && url.pathname==='/api/agent-cli/lookup'){
        const keys=['key','targetId','provider'];
        if([...url.searchParams].length!==3||keys.some(key=>url.searchParams.getAll(key).length!==1))throw Error('Invalid CLI lookup fields');
        const value=agentCli.lookup(Object.fromEntries(url.searchParams));
        return json(res,200,value.found?{...value,job:presentJob(value.job)}:value);
      }
      const cliRequest=/^\/api\/agent-cli\/requests\/([a-f0-9]{48})$/.exec(url.pathname);
      if(agentCli && req.method==='GET' && cliRequest){const value=agentCli.request(cliRequest[1]);return json(res,200,{...value,job:presentJob(value.job)});}
      const cliAction=/^\/api\/agent-cli\/(preview|submit|start|reconcile|login-status)$/.exec(url.pathname);
      if(agentCli && cliAction){
        if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
        if(req.headers['content-type']!=='application/json')return json(res,415,{error:'JSON required'});
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>8192)return json(res,413,{error:'CLI request too large'});chunks.push(chunk);}
        let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{return json(res,400,{error:'Invalid JSON'});}
        const value=await agentCli[cliAction[1]](body);return json(res,200,['submit','start'].includes(cliAction[1])?presentJob(value):value);
      }
      if (req.method === 'GET' && url.pathname === '/api/automation-metrics' && automationMetrics) return json(res,200,automationMetrics(filter[0]));
      if (['/api/environment', '/api/environment/restart'].includes(url.pathname) && environmentEditor) {
        try {
          if (req.method === 'GET' && url.pathname === '/api/environment') return json(res, 200, await environmentEditor.get());
          if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
          if (req.headers['content-type'] !== 'application/json') return json(res, 415, { error: 'JSON 형식으로 요청해 주세요.' });
          const chunks = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > 32768) return json(res, 413, { error: 'ENV 변경 내용이 너무 큽니다.' }); chunks.push(chunk); }
          let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { error: '잘못된 JSON 형식입니다.' }); }
          return json(res, 200, await environmentEditor.mutate(url.pathname.endsWith('/restart') ? 'restart' : 'save', body));
        } catch (error) { return json(res, 409, { error: (error.refused ? 'ENV 요청 거절: ' : '') + (error.publicMessage ?? 'ENV 작업을 완료하지 못했습니다. 현재 상태를 다시 조회해 주세요.') }); }
      }
      const sourceRequest = /^\/api\/([a-f0-9]{48})\/source$/.exec(url.pathname);
      if (req.method === 'GET' && sourceRequest) return json(res, 200, commands.source(sourceRequest[1]));
      const output = /^\/api\/outputs\/([a-f0-9]{48})$/.exec(url.pathname);
      if (req.method === 'GET' && output) return json(res, 200, commandOutputs.read({ outputId: output[1],
        offsetBytes: Number(url.searchParams.get('offset') ?? 0), maxBytes: Number(url.searchParams.get('limit') ?? 4096), format: url.searchParams.get('format') ?? 'text' }));
      if (['/api/command-policy', '/api/command-policy/review'].includes(url.pathname) && commandPolicy) {
        if (req.method === 'GET' && url.pathname === '/api/command-policy') return json(res, 200, await commandPolicy.get());
        if (req.method === 'POST') {
          if (queue.maintenance) throw Error('Maintenance in progress');
          const chunks = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > 65536) throw Error('Policy too large'); chunks.push(chunk); }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (url.pathname.endsWith('/review')) return json(res, 200, await commandPolicy.review(body.policy, body.expectedRevision));
          if (queue.maintenance) throw Error('Maintenance in progress');
          return json(res, 200, await commandPolicy.set(body.policy, body.expectedRevision, body.reviewToken, body.acknowledged));
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
      if (req.method === 'GET' && ['/', '/settings', '/bridge', '/preferences', '/servers', '/history', '/app.js'].includes(url.pathname)) {
        res.writeHead(200, { 'Content-Type': url.pathname !== '/app.js' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' });
        return res.end(url.pathname !== '/app.js' ? webHtml.replace('data-auth-mode="token"', () => `data-auth-mode="${adminAccess.mode}" data-command-automation="${Boolean(commandPolicy)}" data-multi-target="${settings.targets ? 'true' : 'false'}" data-bridge-display-name="${escapeHtml(settings.bridgeDisplayName)}" data-target-display-name="${escapeHtml(settings.targetDisplayName)}"`)
          .replace('<title>SSH 승인 · Approval Portal</title>', () => `<title>${escapeHtml(settings.bridgeDisplayName)} · ${escapeHtml(settings.targetDisplayName)} · SSH Approval Portal</title>`) : webJs);
      }
      if (req.method === 'GET' && url.pathname === '/api/pending') return json(res, 200, visible(queue.list()).map(presentJob));
      if (req.method === 'GET' && url.pathname === '/api/requests') return json(res, 200, visible(queue.listAll()).map(presentJob));
      const single = /^\/api\/([a-f0-9]{48})$/.exec(url.pathname);
      if (req.method === 'GET' && single) { const job = queue.get(single[1]); return json(res, 200, job ? presentJob(job) : { error: 'Unknown request' }); }
      if (url.pathname === '/api/maintenance/preservation/capture') { preservation.capture(req.headers['x-maintenance-owner']); return json(res, 200, { captured: true, ownership: 'durable-v1' }); }
      if (url.pathname === '/api/maintenance/preservation/compare') return json(res, 200, { ...preservation.compare(req.headers['x-maintenance-owner'], req.headers['x-maintenance-preservation-contract']), ownership: 'durable-v1' });
      if (url.pathname === '/api/maintenance/capabilities') return json(res, 200, { ownership: 'durable-v1', baselineComparison: BASELINE_PRESERVATION_CONTRACT });
      if (url.pathname === '/api/maintenance/reserve') { lifecycle.reserve(req.headers['x-maintenance-owner']); return json(res, 200, { reserved: true, ownership: 'durable-v1' }); }
      if (url.pathname === '/api/maintenance/status') return json(res, 200, { status: lifecycle.status(req.headers['x-maintenance-owner']), ownership: 'durable-v1' });
      if (url.pathname === '/api/maintenance/release') {
        const required = req.headers['x-maintenance-compare-required'], contract = req.headers['x-maintenance-preservation-contract'], owner = req.headers['x-maintenance-owner'];
        if (required !== undefined && required !== '1' || contract !== undefined && required !== '1') throw Error('Invalid comparison requirement');
        if (required === '1') preservation.releaseVerified(owner, contract); else lifecycle.release(owner);
        return json(res, 200, { released: true, ownership: 'durable-v1', ...(contract ? { comparisonContract: BASELINE_PRESERVATION_CONTRACT } : {}) });
      }
      const action = /^\/api\/([a-f0-9]{48})\/(approve|deny|download)$/.exec(url.pathname);
      if (!action) return json(res, 404, { error: 'Not found' });
      if (action[2] === 'download') return json(res, 200, { downloadUrl: capabilities.downloadLink(queue.get(action[1])) });
      if (action[2] === 'approve' && req.headers.prefer === 'respond-async') {
        const accepted = queue.start(action[1]);
        res.setHeader('Preference-Applied', 'respond-async');
        return json(res, 202, presentJob(accepted));
      }
      let result;
      if (action[2] === 'approve') {
        // A synchronous approval response may outlive the request-admission slot.
        // The existing queue still owns authorization, execution and its completion.
        lease.detach();
        result = await queue.approve(action[1]);
      } else result = queue.deny(action[1]);
      json(res, 200, presentJob(result));
    } catch (error) {
      if (error instanceof RequestAdmissionError) admissionRefusal(res, error);
      else if (!res.headersSent && !res.destroyed) json(res, 409, { error: 'Request refused, expired, busy or unavailable' });
    } finally {
      try { await responseFinished(res); }
      finally { scope.cleanup(); lease?.release(); }
    }
  });
  // Bound incomplete HTTP bodies/headers; these are not SSH execution deadlines.
  for (const server of [mcpHttp, adminHttp]) { server.requestTimeout = 30000; server.headersTimeout = 15000; }
  return { mcpHttp, adminHttp, mcpServer, reapCapabilities: capabilities.reap };
}
