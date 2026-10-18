import test from 'node:test';
import assert from 'node:assert/strict';
import {launchBrowser} from './browser.mjs';
import { fileURLToPath } from 'node:url';
import { fixtureServer } from './fixture-server.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../../app.mjs';
const id = 'a'.repeat(48), output = { id: 'b'.repeat(48), executionId: id, state: 'ready', bytes: 20, expiresAt: 2000000000000, sha256: 'c'.repeat(64) };
const job = { id, kind: 'command', state: 'completed', command: 'sudo id', target: 'fixture', expiresAt: 2000000000000, result: { content: [], structuredContent: { output } } };
async function fixture(run) {
  const server = await fixtureServer(fileURLToPath(new URL('../../', import.meta.url))); let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage({ locale: 'ko-KR', viewport: { width: 390, height: 844 } });
    await page.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
    await run(page, server);
  } finally { await browser?.close(); await server.close(); }
}
test('card output is explicit UI-only and display metadata changes do not repeat terminal model context', async () => fixture(async (page, server) => {
  await page.goto(server.origin + '/fixture/card'); await page.waitForFunction(() => window.fixture);
  await page.evaluate(job => window.fixture.receive({ structuredContent: job, _meta: { sshApproval: { uiEnabled: true, viewTicket: 'synthetic-view', targetDisplayName: '처음' } } }), job);
  assert.equal(await page.evaluate(() => fixture.calls.length), 0);
  assert.equal(await page.evaluate(() => fixture.contexts.length), 1);
  await page.evaluate(job => window.fixture.receive({ structuredContent: job, _meta: { sshApproval: { uiEnabled: true, viewTicket: 'synthetic-view', targetDisplayName: '다른 표시명' } } }), job);
  assert.equal(await page.evaluate(() => fixture.contexts.length), 1);
  await page.getByRole('button', { name: '출력 보기', exact: true }).click();
  await page.getByText('EXPLICIT_OUTPUT_SENTINEL', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => JSON.stringify(fixture.contexts).includes('SENTINEL')), false);
  assert.equal(await page.evaluate(() => fixture.contexts.length), 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => fixture.receive({ structuredContent: { id: 'transfer-fixture', kind: 'upload', state: 'completed', target: 'fixture', expiresAt: 2000000000000,
    operation: { remotePath: '/tmp/input.bin', fileName: 'input.bin', size: 3 }, result: { content: [{ type: 'text', text: 'Uploaded' }], structuredContent: { fileName: 'input.bin', size: 3, sha256: 'c'.repeat(64) } } } }));
  assert.equal(await page.evaluate(() => fixture.contexts[1].structuredContent.result.structuredContent.fileName), 'input.bin');
}));
test('late card output cannot overwrite a replacement request', async () => fixture(async (page, server) => {
  await page.goto(server.origin + '/fixture/card'); await page.waitForFunction(() => window.fixture);
  await page.evaluate(job => { fixture.receive({ structuredContent: job, _meta: { sshApproval: { uiEnabled: true, viewTicket: 'synthetic-view' } } }); fixture.hold('ui-read-command-output'); }, job);
  await page.getByRole('button', { name: '출력 보기', exact: true }).click(); await page.waitForFunction(() => fixture.calls.some(x => x.name === 'ui-read-command-output'));
  await page.evaluate(job => { fixture.receive({ structuredContent: { ...job, id: 'replacement', command: 'replacement' } }); fixture.release('ui-read-command-output'); }, job);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByText('EXPLICIT_OUTPUT_SENTINEL', { exact: true }).count(), 0);
}));
test('web history reads no output before explicit click and keeps content outside polling snapshots', async () => fixture(async (page, server) => {
  server.state.jobs = [job]; await page.goto(server.origin + '/history');
  await page.locator('#history details').waitFor(); await page.locator('#history details summary').click();
  assert.equal(server.state.outputReads ?? 0, 0);
  await page.getByRole('button', { name: '출력 보기', exact: true }).click();
  await page.getByText('EXPLICIT_WEB_SENTINEL', { exact: true }).waitFor();
  assert.equal(server.state.outputReads, 1); assert.equal(JSON.stringify(server.state.jobs).includes('SENTINEL'), false);
}));
test('late web output is discarded through target A to B to A replacement', async () => fixture(async (page, server) => {
  let release; server.state.multiTarget = true; server.state.jobs = [{ ...job, targetId: 'alpha', targetRevision: 'alpha-v1' }];
  server.state.beforeOutput = () => new Promise(resolve => { release = resolve; });
  await page.goto(server.origin + '/history'); await page.locator('#history details summary').click();
  await page.getByRole('button', { name: '출력 보기', exact: true }).click(); await page.waitForFunction(() => document.querySelector('#history button').disabled);
  await page.locator('#target-filter').selectOption('beta'); await page.locator('#target-filter').selectOption('alpha'); release();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByText('EXPLICIT_WEB_SENTINEL', { exact: true }).count(), 0);
}));
test('built administrator bundle loads stored result from actual authenticated application only on click', async () => {
  const root = await mkdtemp(join(tmpdir(), 'output-browser-')); let app, browser;
  try {
    app = await createApplication({ registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'fixture', readOnly: name === 'aws-readonly' }), closeAll: async () => {} }, classify: () => ({ class: 'privileged' }), executeCommand: async () => ({ failed: false, texts: ['ACTUAL_OUTPUT_SENTINEL'] }), audit: () => {}, transferRoot: root,
      env: { BRIDGE_MCP_TOKEN: 'synthetic-mcp', BRIDGE_ADMIN_TOKEN: 'synthetic-owner', BRIDGE_UI_TICKET_KEY: 'a'.repeat(64), BRIDGE_ADMIN_ORIGIN: 'https://owner.test' }, uiHtml: '<html>fixture</html>' });
    const requested = app.queue.submit('sudo id'); await app.queue.approve(requested.id);
    await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + app.adminHttp.address().port;
    browser = await launchBrowser();
    const page = await browser.newPage({ locale: 'ko-KR', viewport: { width: 390, height: 844 } }); let outputReads = 0;
    await page.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) return route.abort(); if (route.request().url().includes('/api/outputs/')) outputReads++; return route.continue(); });
    await page.goto(origin); await page.locator('#token').fill('synthetic-owner'); await page.locator('#load').click(); await page.locator('[href="/history"]').click();
    await page.locator('#history details summary').click(); assert.equal(outputReads, 0); assert.equal(await page.getByText('ACTUAL_OUTPUT_SENTINEL', { exact: true }).count(), 0);
    await page.getByRole('button', { name: '출력 보기', exact: true }).click(); await page.getByText('ACTUAL_OUTPUT_SENTINEL', { exact: true }).waitFor(); assert.equal(outputReads, 1);
  } finally { await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true }); }
});
