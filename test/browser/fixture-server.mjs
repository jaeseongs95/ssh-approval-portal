import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export async function fixtureServer(root) {
  const state = { jobs: [], requests: [], reads: 0, bridgeDisplayName: '시험 <bridge>', targetDisplayName: '운영 & target', multiTarget: false, beforeRequests: null, beforeDownload: null, downloadError: false };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fixture.invalid');
      if(url.pathname.startsWith('/api/agent-cli')){
        if(state.agentCli){await state.agentCli(request,response,url);return;}
        response.setHeader('Content-Type','application/json');response.end(JSON.stringify({available:false,providers:[],bindings:[]}));return;
      }
      if(['/api/session/start','/api/session/logout'].includes(url.pathname)&&request.method==='POST'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({connected:url.pathname.endsWith('/start')}));return;}
      if(url.pathname==='/api/version'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify(state.versionInfo??{currentVersion:'2.4.0',latestVersion:'2.4.0',updateAvailable:false,status:'up_to_date',releaseUrl:'https://github.com/jaeseongs95/ssh-approval-portal/releases',publishedAt:null,checkedAt:Date.now()}));return;}
      if(url.pathname==='/signed-out'){response.setHeader('Content-Type','text/html');response.end('<html><body>Administrator signed out. <a href="/">Reconnect administrator</a></body></html>');return;}
      if (url.pathname.startsWith('/api/outputs/')) {
        state.outputReads = (state.outputReads ?? 0) + 1; await state.beforeOutput?.();
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ text: 'EXPLICIT_WEB_SENTINEL', offsetBytes: 0, nextOffset: 21, totalBytes: 21, eof: true })); return;
      }
      const download = /^\/api\/([^/]+)\/download$/.exec(url.pathname);
      if (download && request.method === 'POST') {
        await state.beforeDownload?.(download[1]);
        response.setHeader('Content-Type', 'application/json');
        if (state.downloadError) { response.writeHead(409); response.end(JSON.stringify({error:'synthetic previous target error'})); }
        else response.end(JSON.stringify({downloadUrl:'/fixture/download/'+download[1]}));
        return;
      }
      if (url.pathname.startsWith('/fixture/download/')) { response.end('Synthetic download delivered'); return; }
      const decision = /^\/api\/([^/]+)\/(approve|deny)$/.exec(url.pathname);
      if (decision && request.method === 'POST') {
        state.requests.push({method:request.method,id:decision[1],action:decision[2]});
        const job = state.jobs.find(job=>job.id===decision[1]);
        if (!job || job.state !== 'pending') {response.writeHead(409);response.end('{}');return;}
        job.state=decision[2]==='approve'?'running':'denied';
        response.setHeader('Content-Type','application/json');response.end(JSON.stringify(job));return;
      }
      if (url.pathname === '/api/targets') {
        response.setHeader('Content-Type', 'application/json');response.end(JSON.stringify({ targets: state.targets ?? ['alpha','beta'].map(id=>({id,displayName:id+' 이름',enabled:true,isDefault:id==='alpha'})),defaultTarget:'alpha' }));return;
      }
      if (url.pathname === '/api/requests') {
        state.reads++; state.requests.push({ method: request.method, authorization: request.headers.authorization ?? null });
        const target = url.searchParams.get('target'), jobs = target ? state.jobs.filter(job=>job.targetId===target) : state.jobs;
        await state.beforeRequests?.(target);
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(jobs)); return;
      }
      if (url.pathname === '/api/history') {
        state.historyReads = (state.historyReads ?? 0) + 1;
        state.requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: request.headers.authorization ?? null });
        await state.beforeHistory?.(url);
        const q = url.searchParams.get('q')?.toLowerCase() ?? '', target = url.searchParams.get('target'), status = url.searchParams.get('state');
        const from = url.searchParams.has('from') ? Number(url.searchParams.get('from')) : -Infinity;
        const to = url.searchParams.has('to') ? Number(url.searchParams.get('to')) : Infinity;
        const offset = Number(url.searchParams.get('cursor') ?? 0);
        const rows = (state.historyJobs ?? state.jobs).filter(job => !['pending', 'running', 'evaluating'].includes(job.state)
          && (!target || (job.targetId ?? 'default') === target) && (!status || job.state === status)
          && (from === -Infinity && to === Infinity || Number.isFinite(job.createdAt) && job.createdAt >= from && job.createdAt < to)
          && (!q || [job.id, job.command, job.targetId, job.targetDisplayName, JSON.stringify(job.operation)].join(' ').toLowerCase().includes(q)))
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.id.localeCompare(a.id));
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ items: rows.slice(offset, offset + 20).map(job => ({ ...job, history: job.history ?? {stateSource:'memory', storage:'memory', targetStatus:'active'} })),
          nextCursor: offset + 20 < rows.length ? String(offset + 20) : null, asOf: Date.now(), observedAt: Date.now(),
          coverage: {commandJournal:true, cliJournal:true, fileHistory:'memory-only', snapshot:false} })); return;
      }
      if (['/cdn-cgi/access/logout','/oauth2/sign_out'].includes(url.pathname)) { response.end('Synthetic signed out'); return; }
      let text, type = 'text/javascript';
      if(url.pathname==='/app.js'&&state.compiled){response.setHeader('Content-Type','text/javascript');response.end(await readFile(resolve(root,'web/dist/app.js'),'utf8'));return;}
      if (url.pathname === '/fixture/card') {
        text = (await readFile(resolve(root, 'ui/card.html'), 'utf8')).replace('<!-- SCRIPT -->', '<script type="module" src="/fixture/card-bootstrap.js"></script>'); type = 'text/html';
      } else if (url.pathname === '/fixture/card-bootstrap.js') text = await readFile(new URL('./card-bootstrap.js', import.meta.url), 'utf8');
      else if (url.pathname === '/fixture/card-source' || url.pathname === '/fixture/legacy-card.js') {
        text = await readFile(resolve(root, 'ui/card.js'), 'utf8');
        if (url.pathname.endsWith('legacy-card.js')) text = text.replace("import { App } from '@modelcontextprotocol/ext-apps';", 'const App = window.FixtureApp;');
      } else if (['/src/domain/safety.mjs', '/src/domain/execution-context.mjs'].includes(url.pathname)) {
        text = await readFile(resolve(root, '.' + url.pathname), 'utf8');
      } else if (url.pathname === '/src/contracts/ports.mjs') {
        text = await readFile(resolve(root, 'src/contracts/ports.mjs'), 'utf8');
      } else if (['/src/domain/command-line.mjs', '/src/domain/windows-command-line.mjs'].includes(url.pathname)) {
        text = await readFile(resolve(root, '.' + url.pathname), 'utf8');
      } else if (url.pathname === '/src/domain/command-risks.json') {
        text = await readFile(resolve(root, 'src/domain/command-risks.json'), 'utf8'); type = 'application/json';
      } else if (['/', '/settings', '/bridge', '/preferences', '/history', '/fixture/web'].includes(url.pathname)) {
        text = (await readFile(resolve(root, 'web/index.html'), 'utf8')).replace('data-auth-mode="token"', () => `data-auth-mode="${state.oidc===true?'oidc':'access'}" data-command-automation="${state.commandAutomation === true}" data-multi-target="${state.multiTarget}" data-bridge-display-name="${escape(state.bridgeDisplayName)}" data-target-display-name="${escape(state.targetDisplayName)}"`).replace('data-command-automation="false"', () => `data-command-automation="${state.commandAutomation === true}"`).replace('<script src="/app.js" defer></script>', state.compiled?'<script src="/app.js" defer></script>':'<script type="module" src="/web/app.js"></script>'); type = 'text/html';
      } else {
        const path = resolve(root, '.' + url.pathname);
        if (!path.startsWith(resolve(root) + sep) || !/^\/(?:ui|web)\/(?:src\/[^/]+\.js|app\.js)$/.test(url.pathname)) { response.writeHead(404); response.end(); return; }
        text = await readFile(path, 'utf8');
      }
      response.setHeader('Content-Type', type); response.end(text);
    } catch { response.writeHead(500); response.end('Fixture could not serve this resource'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
