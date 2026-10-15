import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { fixtureServer } from './fixture-server.mjs';

const root = resolve(process.env.SOLID_BROWSER_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)));
async function browserFixture(run, locale = 'en-US') {
  const server = await fixtureServer(root);
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.SOLID_CHROMIUM_PATH ? { executablePath: process.env.SOLID_CHROMIUM_PATH } : {}) });
    const context = await browser.newContext({ locale });
    await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
    const page = await context.newPage();
    await run(page, server);
  } finally { await browser?.close(); await server.close(); }
}
async function card(page, server) {
  await page.goto(server.origin + '/fixture/card'); await page.waitForFunction(() => window.fixture);
  await page.evaluate(() => window.fixture.transfer('/tmp/A'));
  await page.locator('input[type=file]').setInputFiles({ name: 'fixture.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([1, 2, 3, 4]) });
}
test('UI-S-01 selected file cannot cross a card replacement', async () => browserFixture(async (page, server) => {
  await card(page, server); await page.evaluate(() => window.fixture.transfer('/tmp/B'));
  assert.equal(await page.locator('input[type=file]').evaluate(node => node.files.length), 0);
  await page.locator('#controls button').click();
  await page.waitForFunction(() => document.querySelector('#error').textContent || window.fixture.calls.some(x => x.name === 'ui-upload-begin'));
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(x => x.name === 'ui-upload-begin').length), 0, 'An old selected File must never begin an upload for the new card');
}));
for (const stage of ['ui-upload-chunk', 'ui-upload-finish']) test(`UI-S-01 stale ${stage} cannot change the replacement card`, async () => browserFixture(async (page, server) => {
  await card(page, server); await page.evaluate(stage => window.fixture.hold(stage), stage);
  await page.locator('#controls button').click();
  await page.waitForFunction(stage => window.fixture.calls.some(x => x.name === stage), stage);
  await page.evaluate(() => window.fixture.transfer('/tmp/B'));
  const before = await page.locator('#status').textContent();
  await page.evaluate(stage => window.fixture.release(stage), stage);
  // Wait for the resolved promise chain and two rendering turns, not a wall-clock sleep.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#status').textContent(), before, 'An old progress/completion must not overwrite the replacement status');
  assert.equal(await page.locator('input[type=text]').inputValue(), '/tmp/B');
  if (stage === 'ui-upload-chunk') assert.equal(await page.evaluate(() => window.fixture.calls.filter(x => x.name === 'ui-upload-finish').length), 0);
}));
const job = (id, state = 'pending') => ({ id, kind: 'command', state, command: 'printf ' + id, target: 'fixture', expiresAt: 2000000000000,
  ...(state === 'completed' ? { result: { content: [{ type: 'text', text: Array.from({ length: 80 }, (_, i) => `line ${i} fixture result`).join('\n') }] } } : {}) });
test('UI-S-02 unrelated 10-second refresh preserves node identity, focus, selection, open details and scroll', async () => browserFixture(async (page, server) => {
  server.state.jobs = [job('A'), job('C', 'completed')];
  await page.clock.install(); await page.goto(server.origin + '/fixture/web'); await page.locator('#jobs .actions button').first().waitFor();
  await page.evaluate(() => {
    const pending = document.querySelector('#jobs .request'), history = document.querySelector('#history details'), output = history.querySelector('.output');
    history.open = true; output.scrollTop = 120;
    const range = document.createRange(); range.setStart(output.firstChild, 0); range.setEnd(output.firstChild, 12); getSelection().removeAllRanges(); getSelection().addRange(range);
    const button = pending.querySelector('button'); button.focus();
    window.saved = { pending, history, output, button, selected: getSelection().toString(), scroll: output.scrollTop };
  });
  assert.equal(await page.evaluate(() => saved.selected.length), 12);
  assert.ok(await page.evaluate(() => saved.scroll > 0));
  const reads = server.state.reads; server.state.jobs.push(job('B'));
  await page.clock.runFor(9999); assert.equal(server.state.reads, reads, 'Poll must not run before ten seconds');
  await page.clock.runFor(1); await page.waitForFunction(() => document.querySelector('#pending-count').textContent === '2');
  const result = await page.evaluate(() => ({ pending: saved.pending.isConnected && saved.pending.querySelector('.command').textContent === 'printf A', history: saved.history === document.querySelector('#history details'),
    output: saved.output === document.querySelector('#history .output'), focus: document.activeElement === saved.button, selected: getSelection().toString() === saved.selected,
    open: saved.history.open, scroll: saved.output.scrollTop === saved.scroll }));
  assert.deepEqual(result, { pending: true, history: true, output: true, focus: true, selected: true, open: true, scroll: true });
  assert.ok(server.state.requests.every(request => request.authorization === null), 'Access mode must not send a bearer token');
}));
for (const [locale, language] of [['ko-KR', 'ko'], ['fr-FR', 'en']]) test(`UI preserved language and Access logout (${locale})`, async () => browserFixture(async (page, server) => {
  server.state.jobs = [job('A')]; await page.goto(server.origin + '/fixture/web'); await page.locator('#jobs .request').waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), language);
  assert.equal(await page.locator('#token').isVisible(), false);
  await page.locator('#logout').click(); await page.waitForURL('**/cdn-cgi/access/logout');
  assert.equal(await page.textContent('body'), 'Synthetic signed out');
}, locale));
