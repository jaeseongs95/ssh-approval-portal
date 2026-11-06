import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { fixtureServer } from './fixture-server.mjs';
import { launchBrowser } from './browser.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(run) {
  const server = await fixtureServer(root); let browser;
  try {
    browser = await launchBrowser(); const page = await browser.newPage(); page.setDefaultTimeout(5000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/fixture/desktop', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><body data-page="settings"><div id="server-workspace"></div><button id="logout">Logout</button><script type="module">
      import { createDesktopPanel } from '/web/src/desktop.js';
      const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 100;
      const png = canvas.toDataURL('image/png').split(',')[1];
      const calls = [], gates = new Map(); let sequence = 1, frame = 0, target = 'alpha';
      const session = { sessionId: 'fixture-session', epoch: 1, targetId: target };
      window.fixture = { calls, hold(action) { gates.set(action, {}); }, release(action) { gates.get(action)?.resolve?.(); gates.delete(action); }, target(value) { target = value; window.fixture.panel.syncTarget(); } };
      window.fixture.panel = createDesktopPanel({ document, getTarget: () => target, api: async (path, method, body) => {
        const action = path.split('/').pop(); calls.push({ action, body });
        const gate = gates.get(action); if (gate) await new Promise(resolve => { gate.resolve = resolve; });
        if (action === 'targets') return { targets: [{ id: target, revision: 'a'.repeat(64), platform: 'windows' }] };
        if (action === 'open') return { ...session, targetId: target };
        if (action === 'observe') return { ...session, frameId: 'frame-' + ++frame, geometryRevision: 1, width: 200, height: 100, nextInputSequence: sequence, mimeType: 'image/png', data: png };
        if (action === 'status') return { readiness: { state: 'desktop_ready', generation: 1 } };
        if (action === 'input' || action === 'authenticate') { sequence++; return { sessionId: session.sessionId, sequence: body.sequence, requestKey: body.requestKey, state: 'sent' }; }
        if (action === 'close') return { closed: true };
      } });
    </script></body></html>` }));
    const now = new Date(); await page.clock.install({ time: new Date(now.getTime() - 60000) }); await page.clock.pauseAt(now);
    await page.goto(server.origin + '/fixture/desktop');
    const viewer = page.locator('#desktop-viewer'), text = viewer.locator('textarea'), controls = viewer.locator('.actions button');
    await controls.nth(0).click(); await page.waitForFunction(() => document.querySelector('#desktop-viewer img').getAttribute('aria-disabled') === 'false');
    await run({ page, viewer, text, controls }); assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
}
const draftState = page => page.evaluate(() => { const node = document.querySelector('textarea'); return { value: node.value, focused: document.activeElement === node, start: node.selectionStart, end: node.selectionEnd, disabled: node.disabled }; });
const hold = (page, action) => page.evaluate(action => fixture.hold(action), action);
const release = (page, action) => page.evaluate(action => fixture.release(action), action);
const called = (page, action, count = 1) => page.waitForFunction(({ action, count }) => fixture.calls.filter(call => call.action === action).length >= count, { action, count });

test('DESKTOP-DRAFT automatic observation preserves draft focus, selection and typing', { timeout: 15000 }, () => fixture(async ({ page, text }) => {
  await text.fill('draft 한글 abc'); await text.evaluate(node => { node.focus(); node.setSelectionRange(6, 8); });
  const before = await draftState(page); await hold(page, 'observe'); await page.clock.runFor(2000); await called(page, 'observe', 2);
  assert.deepEqual(await draftState(page), before);
  await page.keyboard.insertText('교체'); const during = await draftState(page);
  await release(page, 'observe'); await page.waitForFunction(() => document.querySelector('img').getAttribute('aria-disabled') === 'false');
  assert.deepEqual(await draftState(page), during); assert.equal(during.value, 'draft 교체 abc');
}));

test('DESKTOP-DRAFT manual refresh and connection checks preserve editable local draft', { timeout: 15000 }, () => fixture(async ({ page, text, controls }) => {
  await text.fill('keep this draft'); await text.evaluate(node => { node.focus(); node.setSelectionRange(2, 7); });
  for (const [action, index] of [['observe', 1], ['status', 3]]) {
    const before = await draftState(page); await hold(page, action); await controls.nth(index).evaluate(node => node.click()); await called(page, action, action === 'observe' ? 2 : 1);
    assert.deepEqual(await draftState(page), before); await release(page, action);
    await page.waitForFunction(() => !document.querySelector('#desktop-viewer .actions button:nth-child(2)').disabled);
    assert.deepEqual(await draftState(page), before);
  }
}));

test('DESKTOP-DRAFT completing a send preserves a newly edited draft and sends only its snapshot', { timeout: 15000 }, () => fixture(async ({ page, viewer, text }) => {
  await text.fill('first draft'); await hold(page, 'input'); await viewer.locator(':scope > button').click(); await called(page, 'input');
  assert.equal(await text.isDisabled(), false); await text.fill('next draft 한글');
  await release(page, 'input'); await page.waitForFunction(() => !document.querySelector('#desktop-viewer .actions button:nth-child(2)').disabled);
  assert.equal(await text.inputValue(), 'next draft 한글');
  assert.deepEqual(await page.evaluate(() => fixture.calls.filter(call => call.action === 'input').map(call => call.body.actions)), [[{ type: 'text', text: 'first draft' }]]);
  await hold(page, 'input'); await viewer.locator(':scope > button').click(); await called(page, 'input', 2);
  await text.fill('temporary edit'); await text.fill('next draft 한글');
  await release(page, 'input'); await page.waitForFunction(() => !document.querySelector('#desktop-viewer .actions button:nth-child(2)').disabled);
  assert.equal(await text.inputValue(), 'next draft 한글');
}));

test('DESKTOP-DRAFT an unchanged successful send clears its draft; closing and reopening cannot reuse it', { timeout: 15000 }, () => fixture(async ({ page, viewer, text, controls }) => {
  await text.fill('sent once'); await viewer.locator(':scope > button').click(); await page.waitForFunction(() => !document.querySelector('textarea').value);
  await text.fill('discard on close'); await controls.nth(2).click(); await page.waitForFunction(() => document.querySelector('img').hidden);
  assert.equal(await text.inputValue(), ''); assert.equal(await text.isDisabled(), true);
  await page.evaluate(() => fixture.target('beta')); await controls.nth(0).click(); await page.waitForFunction(() => document.querySelector('img').getAttribute('aria-disabled') === 'false');
  assert.equal(await text.inputValue(), ''); assert.equal(await page.evaluate(() => fixture.calls.filter(call => call.action === 'input').length), 1);
}));

test('DESKTOP-DRAFT automatic capture cannot blur an empty focused one-time authentication field', { timeout: 15000 }, () => fixture(async ({ page, viewer }) => {
  const credential = viewer.locator('input[type=password]'); await credential.focus();
  await hold(page, 'observe'); await page.clock.runFor(2000);
  assert.equal(await credential.isDisabled(), false); assert.equal(await credential.evaluate(node => document.activeElement === node), true);
  await credential.fill('fixture-only-secret');
  await release(page, 'observe'); await page.clock.runFor(4000);
  assert.equal(await credential.inputValue(), 'fixture-only-secret');
  assert.equal(await page.evaluate(() => fixture.calls.filter(call => call.action === 'authenticate').length), 0);
}));
