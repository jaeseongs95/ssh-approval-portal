import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export async function fixtureServer(root) {
  const state = { jobs: [], requests: [], reads: 0, bridgeDisplayName: '시험 <bridge>', targetDisplayName: '운영 & target' };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fixture.invalid');
      if (url.pathname === '/api/requests') {
        state.reads++; state.requests.push({ method: request.method, authorization: request.headers.authorization ?? null });
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(state.jobs)); return;
      }
      if (url.pathname === '/cdn-cgi/access/logout') { response.end('Synthetic signed out'); return; }
      let text, type = 'text/javascript';
      if (url.pathname === '/fixture/card') {
        text = (await readFile(resolve(root, 'ui/card.html'), 'utf8')).replace('<!-- SCRIPT -->', '<script type="module" src="/fixture/card-bootstrap.js"></script>'); type = 'text/html';
      } else if (url.pathname === '/fixture/card-bootstrap.js') text = await readFile(new URL('./card-bootstrap.js', import.meta.url), 'utf8');
      else if (url.pathname === '/fixture/card-source' || url.pathname === '/fixture/legacy-card.js') {
        text = await readFile(resolve(root, 'ui/card.js'), 'utf8');
        if (url.pathname.endsWith('legacy-card.js')) text = text.replace("import { App } from '@modelcontextprotocol/ext-apps';", 'const App = window.FixtureApp;');
      } else if (url.pathname === '/' || url.pathname === '/fixture/web') {
        text = (await readFile(resolve(root, 'web/index.html'), 'utf8')).replace('data-auth-mode="token"', () => `data-auth-mode="access" data-bridge-display-name="${escape(state.bridgeDisplayName)}" data-target-display-name="${escape(state.targetDisplayName)}"`).replace('<script src="/app.js" defer></script>', '<script type="module" src="/web/app.js"></script>'); type = 'text/html';
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
