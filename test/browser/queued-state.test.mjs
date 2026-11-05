import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { launchBrowser } from './browser.mjs';
import { fixtureServer } from './fixture-server.mjs';
import { openRequest, navigate, historyReady } from './admin-ui.mjs';

const root = resolve(process.env.SOLID_BROWSER_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)));
const queued = (approvalMode = 'automatic') => ({ id: 'queued-request', kind: 'command', state: 'queued', approvalMode,
  command: 'printf queued-fixture', target: 'fixture', createdAt: 1000, expiresAt: 2000000000000,
  decision: { decision: 'execute', reasonCode: 'command_set' } });
async function fixture(locale, run) {
  const server = await fixtureServer(root);
  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ locale });
    await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.clock.install();
    await run(page, server, locale.startsWith('ko'));
  } finally { await browser?.close(); await server.close(); }
}

for (const locale of ['ko-KR', 'en-US']) {
  test(`queued card polls without announcing completion and exposes cancellation only ${locale}`, () => fixture(locale, async (page, server, korean) => {
    await page.goto(server.origin + '/fixture/card');
    await page.waitForFunction(() => window.fixture);
    await page.evaluate(job => window.fixture.receive({ structuredContent: job, _meta: { sshApproval: {
      uiEnabled: true, approvalTicket: 'synthetic-cancel-ticket', namespace: 'fixture_',
    } } }), queued());
    assert.equal(await page.locator('#status').textContent(), korean ? '실행 대기' : 'Queued for execution');
    assert.equal(await page.locator('#controls button').count(), 1);
    assert.equal(await page.locator('#controls button').textContent(), korean ? '실행 취소' : 'Cancel execution');
    assert.equal(await page.locator('.automatic-approval').count(), 1);
    await page.clock.runFor(2000);
    await page.waitForFunction(() => window.fixture.calls.some(call => call.name === 'show-approval'));
    assert.deepEqual(await page.evaluate(() => window.fixture.calls.map(call => ({ name: call.name, args: call.args }))), [{ name: 'show-approval', args: { id: 'queued-request' } }]);
    assert.equal(await page.evaluate(() => window.fixture.contexts.length), 0, 'queued is not a terminal notification');
    await page.locator('#controls button').click();
    const decisions = await page.evaluate(() => window.fixture.calls.filter(call => call.name === 'ui-decide-request'));
    assert.deepEqual(decisions.map(call => call.args), [{ id: 'queued-request', action: 'deny', ticket: 'synthetic-cancel-ticket' }]);
    await page.evaluate(job => window.fixture.receive({ structuredContent: job }), queued('owner'));
    assert.equal(await page.locator('.automatic-approval').count(), 0);
    assert.match(await page.locator('.assessment-summary').textContent(), korean ? /사용자가 승인한 요청/ : /Approved by the owner/);
  }));

  test(`queued web request stays active, refreshes approval explanation and cancels by deny ${locale}`, () => fixture(locale, async (page, server, korean) => {
    const job = queued('owner');
    server.state.jobs = [{ ...job, state: 'pending', approvalMode: undefined }];
    await page.goto(server.origin);
    await openRequest(page, job.id, '#jobs');
    server.state.jobs = [job];
    await page.locator('#load').click();
    await page.waitForFunction(() => document.querySelector('#request-detail-state').dataset.state === 'queued');
    assert.equal(await page.locator('#pending-count').textContent(), '0');
    assert.equal(await page.locator('#running-count').textContent(), '1');
    assert.match(await page.locator('#request-detail-body .assessment-summary').textContent(), korean ? /사용자가 승인한 요청/ : /Approved by the owner/);
    assert.equal(await page.locator('#request-detail-body').getByRole('button', { name: korean ? '승인·실행' : 'Approve and run', exact: true }).isVisible(), false);
    await navigate(page, '/history');
    await historyReady(page);
    assert.equal(await page.locator('#history [data-request-id="queued-request"]').count(), 0);
    await navigate(page, '/');
    await openRequest(page, job.id, '#running');
    let denies = 0;
    await page.route('**/api/queued-request/deny', async route => {
      denies++; job.state = 'denied';
      await route.fulfill({ json: job });
    });
    await page.locator('#request-detail-body').getByRole('button', { name: korean ? '실행 취소' : 'Cancel execution', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#request-detail-state').dataset.state === 'denied');
    assert.equal(denies, 1);
    assert.equal(server.state.requests.filter(request => request.action === 'approve').length, 0);
  }));
}
