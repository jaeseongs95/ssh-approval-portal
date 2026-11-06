import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { launchBrowser } from './browser.mjs';

const root = new URL('../../', import.meta.url), revision = 'a'.repeat(64);
// Valid PNG; the declared remote geometry is deliberately independent of CSS dimensions.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
async function fixture(run) {
  const calls = [], gates = new Map(), host = { text: '', clicks: [], keys: [], width: 200, height: 100, frame: 0, sequence: 1, active: 0, maxActive: 0 };
  let session, sessionNumber = 0, failInput = false, browser;
  const held = action => gates.set(action, {});
  const release = action => { const gate = gates.get(action); gates.delete(action); gate?.resolve?.(); };
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://fixture.invalid').pathname;
      if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end(`<!doctype html><html lang="en"><body data-page="settings"><div id="server-workspace"></div><button id="logout">Logout</button><script type="module">
        import { createDesktopPanel } from '/web/src/desktop.js'; import { createWebApi } from '/web/src/http.js';
        let target = 'alpha'; const api = createWebApi({ fetch, accessMode: true, getToken: () => '', isSignedOut: () => false, unauthorized() {}, t: value => value });
        window.panel = createDesktopPanel({ document, api, getTarget: () => target });
        window.setTarget = value => { target = value; panel.syncTarget(); };
        document.querySelector('img').style.cssText += ';position:absolute;left:20px;top:500px;width:200px;height:100px;border:0;z-index:1';
      </script></body></html>`); return; }
      if (['/web/src/desktop.js', '/web/src/locale.js', '/web/src/http.js'].includes(path)) { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(new URL(path.slice(1), root))); return; }
      if (path === '/api/targets') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ targets: ['alpha', 'beta'].map(id => ({ id, revision, platform: 'windows' })) })); return; }
      if (!path.startsWith('/api/desktop/')) { response.writeHead(404); response.end(); return; }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()), action = path.split('/').at(-1);
      calls.push({ action, body }); host.active++; host.maxActive = Math.max(host.maxActive, host.active);
      const gate = gates.get(action); if (gate) await new Promise(resolve => { gate.resolve = resolve; });
      let value;
      if (action === 'open') { session = { sessionId: 'session-' + ++sessionNumber, epoch: sessionNumber, targetId: body.target, readiness: { state: 'desktop_ready', generation: 1 } }; host.frame = 0; host.sequence = 1; value = session; }
      else {
        assert.equal(body.sessionId, session.sessionId); assert.equal(body.epoch, session.epoch);
        if (action === 'observe') value = { ...session, frameId: 'frame-' + ++host.frame, geometryRevision: host.width, width: host.width, height: host.height, nextInputSequence: host.sequence, mimeType: 'image/png', data: png };
        if (action === 'input') {
          assert.equal(body.sequence, host.sequence++); assert.equal(body.frameId, 'frame-' + host.frame); assert.equal(body.geometryRevision, host.width);
          for (const input of body.actions) {
            if (input.type === 'pointer' && input.buttons) host.clicks.push({ x: input.x, y: input.y, buttons: input.buttons });
            if (input.type === 'text') host.text += input.text;
            if (input.type === 'key' && input.down) { host.keys.push(input.keysym); if (input.keysym < 0xff00) host.text += String.fromCodePoint(input.keysym); else if (input.keysym === 0xff0d) host.text += '\n'; }
          }
          // Incomplete receipt after a committed effect; a closed socket before headers may be retried by Chromium itself.
          if (failInput) { failInput = false; host.active--; response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{'); return; }
          value = { sessionId: session.sessionId, sequence: body.sequence, requestKey: body.requestKey, state: 'sent' };
        }
        if (action === 'close') value = { closed: true };
        if (action === 'status') value = { readiness: session.readiness };
      }
      host.active--; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value));
    } catch (error) { host.active = Math.max(0, host.active - 1); response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    browser = await launchBrowser(); const page = await browser.newPage(); page.setDefaultTimeout(5000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const now = new Date(); await page.clock.install({ time: new Date(now.getTime() - 60000) }); await page.clock.pauseAt(now);
    await page.goto('http://127.0.0.1:' + server.address().port);
    const viewer = page.locator('#desktop-viewer'), image = viewer.locator('img'), controls = viewer.locator('.actions button'), text = viewer.locator('textarea');
    await controls.nth(0).click(); await page.waitForFunction(() => document.querySelector('img').complete && document.querySelector('img').naturalWidth > 0 && !document.querySelector('#desktop-viewer .actions button:nth-child(2)').disabled);
    const count = action => calls.filter(call => call.action === action).length;
    const waitForCount = async (action, expected) => { const deadline = Date.now() + 5000; while (count(action) < expected && Date.now() < deadline) await delay(10); assert.ok(count(action) >= expected, action + ' requests: expected ' + expected + ', got ' + count(action)); };
    await run({ page, viewer, image, controls, text, host, calls, hold: held, release, count, waitForCount, loseInput: () => { failInput = true; } });
    assert.deepEqual(errors, []);
  } finally { for (const action of gates.keys()) release(action); await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
const idle = page => page.waitForFunction(() => !document.querySelector('#desktop-viewer .actions button:nth-child(2)').disabled);

test('DESKTOP-GESTURE capture overlap delivers ordered keys and scaled pointer to the host once', { timeout: 15000 }, () => fixture(async ({ page, image, host, calls, hold, release, waitForCount }) => {
  hold('observe'); await image.focus(); await page.clock.runFor(2000); await waitForCount('observe', 2);
  await image.press('a'); await image.press('b'); await image.press('Enter');
  await image.click(); host.width = 400; host.height = 200;
  assert.equal(calls.filter(call => call.action === 'input').length, 0);
  release('observe'); await waitForCount('input', 4); await idle(page);
  assert.equal(host.text, 'ab\n'); assert.deepEqual(host.clicks, [{ x: 200, y: 100, buttons: 1 }]);
  assert.deepEqual(calls.filter(call => call.action === 'input').map(call => call.body.sequence), [1, 2, 3, 4]);
  assert.equal(new Set(calls.filter(call => call.action === 'input').map(call => call.body.requestKey)).size, 4);
  assert.ok(calls.filter(call => call.action === 'input').every(call => call.body.frameId === 'frame-2')); assert.equal(host.maxActive, 1);
}));

test('DESKTOP-GESTURE bursts during a pending key preserve order and text send reaches the host', { timeout: 15000 }, () => fixture(async ({ page, viewer, image, text, host, calls, hold, release, waitForCount }) => {
  hold('input'); await image.press('a'); await waitForCount('input', 1);
  await image.press('b'); await image.press('c'); await page.clock.runFor(6000);
  assert.equal(calls.filter(call => call.action === 'input').length, 1);
  release('input'); await waitForCount('input', 3); await idle(page);
  await text.fill(' 한글 text'); await viewer.locator(':scope > button').click(); await waitForCount('input', 4); await idle(page);
  assert.equal(host.text, 'abc 한글 text'); assert.equal(host.maxActive, 1);
  assert.deepEqual(calls.filter(call => call.action === 'input').map(call => call.body.sequence), [1, 2, 3, 4]);
}));

test('DESKTOP-GESTURE uncertain committed input cancels unsent keys without replay after refresh', { timeout: 15000 }, () => fixture(async ({ page, viewer, image, controls, host, calls, hold, release, waitForCount, loseInput }) => {
  hold('input'); loseInput(); await image.press('a'); await waitForCount('input', 1); await image.press('b'); await image.press('c'); release('input');
  await viewer.getByRole('alert').filter({ hasText: 'Input outcome unconfirmed' }).waitFor();
  assert.match(await viewer.innerText(), /Unsent queued input was cancelled/);
  await page.clock.runFor(6000); assert.equal(host.text, 'a'); assert.equal(calls.filter(call => call.action === 'input').length, 1);
  await controls.nth(1).click(); await idle(page); await page.clock.runFor(2000); assert.equal(calls.filter(call => call.action === 'input').length, 1);
  await image.press('d'); await waitForCount('input', 2); await idle(page); assert.equal(host.text, 'ad');
  assert.deepEqual(calls.filter(call => call.action === 'input').map(call => call.body.sequence), [1, 2]);
}));

test('DESKTOP-GESTURE close and target changes invalidate waiting gestures', { timeout: 15000 }, () => fixture(async ({ page, image, controls, calls, hold, release, waitForCount }) => {
  hold('observe'); await page.clock.runFor(2000); await waitForCount('observe', 2); await image.press('x');
  await page.evaluate(() => { void panel.close(); }); release('observe'); await waitForCount('close', 1); await page.waitForFunction(() => document.querySelector('img').hidden);
  assert.equal(calls.filter(call => call.action === 'input').length, 0);
  await page.evaluate(() => setTarget('beta')); await controls.nth(0).click(); await idle(page);
  hold('observe'); await page.clock.runFor(2000); await waitForCount('observe', 4); await image.press('y');
  await page.evaluate(() => setTarget('alpha')); release('observe'); await idle(page);
  assert.equal(calls.filter(call => call.action === 'input').length, 0);
}));

test('DESKTOP-GESTURE composition and Tab stay local while queue saturation is visible and bounded', { timeout: 15000 }, () => fixture(async ({ page, viewer, image, host, calls, hold, release, waitForCount }) => {
  await image.focus(); await image.dispatchEvent('keydown', { key: 'Process', isComposing: true }); await image.press('Tab');
  assert.equal(await image.evaluate(node => document.activeElement === node), false); assert.equal(calls.filter(call => call.action === 'input').length, 0);
  hold('observe'); await page.clock.runFor(2000); await waitForCount('observe', 2);
  await image.evaluate(node => { for (let index = 0; index < 70; index++) node.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true })); });
  assert.match(await viewer.innerText(), /Input is arriving too quickly/); release('observe'); await waitForCount('input', 64); await idle(page);
  assert.equal(calls.filter(call => call.action === 'input').length, 64); assert.equal(host.text, 'x'.repeat(64));
}));
