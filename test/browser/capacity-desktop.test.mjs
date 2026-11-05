import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureServer } from './fixture-server.mjs';
import { launchBrowser } from './browser.mjs';
import { navigate, selectServer } from './admin-ui.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)), revision = 'a'.repeat(64);
const bindings = ['alpha', 'beta'].map(targetId => ({ targetId, targetRevision: revision, profile: targetId + '-write', displayName: targetId, enabled: true, supported: true, platform: 'linux' }));
async function fixture(run, { compiled = false, locale = 'en-US', width = 1280 } = {}) {
  const server = await fixtureServer(root); let browser;
  server.state.compiled = compiled; server.state.multiTarget = server.state.commandAutomation = true;
  server.state.targets = bindings.map(binding => ({ id: binding.targetId, revision, displayName: binding.displayName, enabled: true, platform: 'linux' }));
  server.state.agentCli = async (_, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ available: true, providers: [{ id: 'codex' }], bindings })); };
  const capacity = { revision: 1, availableCpus: 2, settings: { queueCapacity: 20, maxConcurrency: 2 }, status: { queued: 3, running: 2 }, targets: bindings.map(binding => ({ id: binding.targetId, displayName: binding.displayName, queueCapacity: null, maxConcurrency: null, status: { queued: 1, running: 1 } })) };
  const calls = [], order = []; let session, frameNumber = 0, inputSequence = 0, dropInput = false, dropCapacity = false;
  const snapshot = () => ({ ...capacity, targets: capacity.targets.map(target => ({ ...target, effective: { queueCapacity: target.queueCapacity ?? capacity.settings.queueCapacity, maxConcurrency: target.maxConcurrency ?? capacity.settings.maxConcurrency } })) });
  try {
    browser = await launchBrowser(); const page = await browser.newPage({ locale, viewport: { width, height: 900 } }); page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 100; const context = canvas.getContext('2d'); context.fillStyle = '#315be8'; context.fillRect(0, 0, 200, 100); return canvas.toDataURL('image/png').split(',')[1]; });
    const now = new Date(); await page.clock.install({ time: new Date(now.getTime() - 60000) }); await page.clock.pauseAt(now);
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== server.origin) return route.abort();
      if (url.pathname === '/api/command-policy') return route.fulfill({ json: { revision: 1, bindings, targets: bindings.map(binding => ({ ...binding, commands: ['pwd'], deniedCommands: [], externalDisclosure: false, modelExecution: false, fallback: null, thresholds: {} })) } });
      if (url.pathname === '/api/environment') return route.fulfill({ json: { available: false, message: 'Synthetic ENV unavailable' } });
      if (url.pathname === '/api/capacity') {
        if (request.method() === 'POST') {
          const body = request.postDataJSON(); calls.push({ path: url.pathname, body });
          if (body.expectedRevision !== capacity.revision) return route.fulfill({ status: 409, json: { error: 'CAPACITY_REVISION_CONFLICT' } });
          Object.assign(capacity.settings, body.settings ?? {});
          for (const target of body.targets ?? []) Object.assign(capacity.targets.find(item => item.id === target.id), target);
          capacity.revision++;
          if (dropCapacity) { dropCapacity = false; return route.abort('failed'); }
        }
        return route.fulfill({ json: snapshot() });
      }
      if (url.pathname.startsWith('/api/desktop/')) {
        const action = url.pathname.split('/').pop(), body = request.postDataJSON(); calls.push({ path: url.pathname, body }); order.push(action);
        if (action === 'open') {
          assert.deepEqual(body, { target: 'alpha', expectedTargetRevision: revision });
          session = { sessionId: 'desktop-' + calls.length, targetId: body.target, targetRevision: body.expectedTargetRevision, epoch: 1, expiresAt: Date.now() + 600000, idleExpiresAt: Date.now() + 60000, kind: 'desktop' }; frameNumber = inputSequence = 0;
          return route.fulfill({ json: session });
        }
        assert.equal(body.sessionId, session.sessionId); assert.equal(body.epoch, session.epoch);
        if (action === 'observe') return route.fulfill({ json: { ...session, frameId: session.sessionId + ':' + ++frameNumber, geometryRevision: 7, width: 200, height: 100, coordinateSpace: 'physical-pixels', nextInputSequence: inputSequence + 1, mimeType: 'image/png', data: png } });
        if (action === 'input') {
          assert.equal(body.frameId, session.sessionId + ':' + frameNumber); assert.equal(body.geometryRevision, 7); assert.equal(body.sequence, ++inputSequence); assert.match(body.requestKey, /^[A-Za-z0-9_-]{1,128}$/);
          if (dropInput) { dropInput = false; return route.abort('failed'); }
          return route.fulfill({ json: { sessionId: session.sessionId, sequence: body.sequence, requestKey: body.requestKey, state: 'sent' } });
        }
        if (action === 'close') return route.fulfill({ json: { sessionId: session.sessionId, closed: true, releaseSent: true, logout: false } });
      }
      if (url.pathname === '/api/session/logout') { order.push('logout'); return route.fulfill({ json: { connected: false } }); }
      return route.continue();
    });
    await page.goto(server.origin + '/settings'); await selectServer(page, 'alpha');
    await page.waitForFunction(() => !document.querySelector('#capacity-target fieldset').disabled);
    const screenshot = async name => { if (process.env.UI_NEW_UI_SCREENSHOTS) { await mkdir(process.env.UI_NEW_UI_SCREENSHOTS, { recursive: true }); await page.screenshot({ path: join(process.env.UI_NEW_UI_SCREENSHOTS, name + '-' + locale + '-' + compiled + '.png'), fullPage: true }); } };
    await run({ page, capacity, calls, order, screenshot, loseInput: () => { dropInput = true; }, loseCapacity: () => { dropCapacity = true; } });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
}

for (const options of [{ locale: 'ko-KR', width: 390, compiled: false }, { locale: 'en-US', width: 1280, compiled: true }]) {
  const suffix = options.locale + ' compiled=' + options.compiled;
  test('CAPACITY-BROWSER user saves global/target limits with null inheritance and CAS ' + suffix, { timeout: 30000 }, () => fixture(async ({ page, capacity, calls, screenshot }) => {
    const target = page.locator('#capacity-target'), queue = page.locator('#capacity-target-queueCapacity'), concurrent = page.locator('#capacity-target-maxConcurrency');
    assert.equal(await queue.inputValue(), ''); assert.equal(await concurrent.inputValue(), '');
    await queue.fill('7'); await target.locator('button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('#capacity-target fieldset').disabled && document.querySelector('#capacity-target button[type=submit]').disabled);
    assert.deepEqual(calls.filter(call => call.path === '/api/capacity').at(-1).body, { expectedRevision: 1, targets: [{ id: 'alpha', queueCapacity: 7, maxConcurrency: null }] });
    await queue.fill('9'); await selectServer(page, 'beta'); assert.equal(await queue.inputValue(), ''); await selectServer(page, 'alpha'); assert.equal(await queue.inputValue(), '9');
    await target.locator('button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('#capacity-target fieldset').disabled && document.querySelector('#capacity-target button[type=submit]').disabled);
    await navigate(page, '/bridge'); const global = page.locator('#capacity-global');
    await page.locator('#capacity-global-maxConcurrency').fill('1'); await global.locator('button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('#capacity-global fieldset').disabled && document.querySelector('#capacity-global button[type=submit]').disabled);
    assert.deepEqual(calls.filter(call => call.path === '/api/capacity').at(-1).body, { expectedRevision: 3, settings: { queueCapacity: 20, maxConcurrency: 1 } });
    assert.equal(capacity.status.running, 2); assert.match(await global.innerText(), options.locale.startsWith('ko') ? /실행 중 2개/ : /running: 2/);
    assert.equal(await global.locator('.error').isVisible(), false);
    await screenshot('capacity-global');
    await navigate(page, '/settings'); await queue.fill(''); await target.locator('button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('#capacity-target fieldset').disabled && document.querySelector('#capacity-target button[type=submit]').disabled);
    assert.deepEqual(calls.filter(call => call.path === '/api/capacity').at(-1).body, { expectedRevision: 4, targets: [{ id: 'alpha', queueCapacity: null, maxConcurrency: null }] });
    assert.match(await target.innerText(), options.locale.startsWith('ko') ? /대기 20개.*동시 실행 1개/ : /queue 20.*concurrent 1/);
    assert.equal(await target.locator('.error').isVisible(), false);
    await screenshot('capacity-inherited');
  }, options));

  test('DESKTOP-BROWSER real viewer gestures retain frame/sequence and close before logout ' + suffix, { timeout: 30000 }, () => fixture(async ({ page, calls, order, screenshot }) => {
    const viewer = page.locator('#desktop-viewer'), buttons = viewer.locator('.actions button'), image = viewer.locator('img');
    await buttons.nth(0).click(); await page.waitForFunction(() => document.querySelector('#desktop-viewer img').getAttribute('aria-disabled') === 'false');
    assert.equal(await page.locator('#server-target').isDisabled(), true); assert.match(await image.getAttribute('src'), /^data:image\/png;base64,/);
    await image.click(); await page.waitForFunction(() => !document.querySelector('#desktop-viewer textarea').disabled);
    await image.press('Control+c'); await page.waitForFunction(() => !document.querySelector('#desktop-viewer textarea').disabled);
    await viewer.locator('textarea').fill('hello 한글'); await viewer.locator(':scope > button').click();
    await page.waitForFunction(() => !document.querySelector('#desktop-viewer textarea').value);
    const inputs = calls.filter(call => call.path.endsWith('/input'));
    assert.deepEqual(inputs.map(call => call.body.sequence), [1, 2, 3]); assert.equal(new Set(inputs.map(call => call.body.requestKey)).size, 3);
    assert.equal(inputs[0].body.actions[0].type, 'pointer'); assert.equal(inputs[0].body.actions.at(-1).buttons, 0);
    assert.ok(inputs[1].body.actions.some(action => action.keysym === 0xffe3 && action.down)); assert.deepEqual(inputs[2].body.actions, [{ type: 'text', text: 'hello 한글' }]);
    assert.equal(await viewer.locator('.error').isVisible(), false);
    await screenshot('desktop-open');
    await page.locator('#logout').click(); await page.waitForURL('**/signed-out');
    assert.deepEqual(order.slice(-2), ['close', 'logout']); assert.equal(order.filter(action => action === 'close').length, 1);
  }, options));
}

test('CAPACITY-BROWSER conflict and committed response loss require explicit GET without replay', { timeout: 30000 }, () => fixture(async ({ page, capacity, calls, loseCapacity, screenshot }) => {
  await navigate(page, '/bridge'); const global = page.locator('#capacity-global'), input = page.locator('#capacity-global-queueCapacity');
  capacity.revision++; capacity.settings.queueCapacity = 30;
  await input.fill('25'); await global.locator('button[type=submit]').click(); await global.getByRole('alert').filter({ hasText: 'CAPACITY_REVISION_CONFLICT' }).waitFor();
  assert.equal(await global.locator('.error').isVisible(), true); await screenshot('capacity-conflict-visible');
  assert.equal(await input.isDisabled(), true);
  await global.locator('button.secondary').click(); await page.waitForFunction(() => !document.querySelector('#capacity-global fieldset').disabled);
  assert.equal(await global.locator('.error').isVisible(), false);
  assert.equal(await input.inputValue(), '30'); assert.equal(calls.filter(call => call.path === '/api/capacity').length, 1);
  loseCapacity(); await input.fill('40'); await global.locator('button[type=submit]').click();
  await global.getByRole('alert').filter({ hasText: 'Save outcome unconfirmed' }).waitFor(); await page.clock.runFor(10000);
  assert.equal(calls.filter(call => call.path === '/api/capacity').length, 2);
  await global.locator('button.secondary').click(); await page.waitForFunction(() => !document.querySelector('#capacity-global fieldset').disabled);
  assert.equal(await input.inputValue(), '40'); assert.equal(calls.filter(call => call.path === '/api/capacity').length, 2);
}));

test('DESKTOP-BROWSER lost input never replays and explicit observation recovers the next sequence', { timeout: 30000 }, () => fixture(async ({ page, calls, order, loseInput, screenshot }) => {
  const viewer = page.locator('#desktop-viewer'), buttons = viewer.locator('.actions button'), image = viewer.locator('img');
  await buttons.nth(0).click(); await page.waitForFunction(() => document.querySelector('#desktop-viewer img').getAttribute('aria-disabled') === 'false');
  loseInput(); await image.click(); await viewer.getByRole('alert').filter({ hasText: 'Input outcome unconfirmed' }).waitFor();
  assert.equal(await viewer.locator('.error').isVisible(), true); await screenshot('desktop-input-error-visible');
  await page.clock.runFor(10000); assert.equal(calls.filter(call => call.path.endsWith('/input')).length, 1); assert.equal(await viewer.locator('textarea').isDisabled(), true);
  await buttons.nth(1).click(); await page.waitForFunction(() => document.querySelector('#desktop-viewer img').getAttribute('aria-disabled') === 'false');
  assert.equal(await viewer.locator('.error').isVisible(), false);
  await image.press('ArrowDown'); await page.waitForFunction(() => !document.querySelector('#desktop-viewer textarea').disabled);
  assert.deepEqual(calls.filter(call => call.path.endsWith('/input')).map(call => call.body.sequence), [1, 2]);
  await navigate(page, '/history'); await page.waitForFunction(() => document.querySelector('#server-target').disabled === false);
  assert.equal(order.at(-1), 'close'); assert.equal(order.filter(action => action === 'close').length, 1);
}));
