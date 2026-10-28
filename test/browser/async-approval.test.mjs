import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../../app.mjs';
import { launchBrowser } from './browser.mjs';

for (const failed of [false, true]) test(`owner approval releases the browser while actual execution is held (${failed ? 'failed' : 'completed'})`, { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'async-owner-browser-'));
  let app, browser, release, executions = 0;
  const held = new Promise(resolve => { release = resolve; });
  try {
    app = await createApplication({
      registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'fixture', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
      classify: () => ({ class: 'privileged' }),
      executeCommand: async () => { executions++; await held; return { failed, texts: ['Held executor finished'] }; },
      audit: () => {}, transferRoot: directory, uiHtml: '<html>fixture</html>',
      env: { BRIDGE_MCP_TOKEN: 'synthetic-mcp', BRIDGE_ADMIN_TOKEN: 'synthetic-owner', BRIDGE_UI_TICKET_KEY: 'a'.repeat(64), BRIDGE_ADMIN_ORIGIN: 'https://owner.test' },
    });
    const first = app.queue.submit('sudo id'), second = app.queue.submit('sudo pwd');
    await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${app.adminHttp.address().port}`;
    browser = await launchBrowser();
    const page = await browser.newPage({ locale: 'en-US' });
    // Map the local fixture's browser origin to its configured administrator origin.
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (route.request().method() === 'POST') return route.fulfill({ response: await route.fetch({ headers: { ...route.request().headers(), origin: 'https://owner.test' } }) });
      return route.continue();
    });
    page.setDefaultTimeout(10000);
    await page.clock.install(); await page.clock.pauseAt(new Date());
    await page.goto(origin); await page.locator('#token').fill('synthetic-owner'); await page.locator('#load').click();
    const card = id => page.locator(`#jobs [data-request-id="${id}"]`);
    await card(first.id).waitFor();
    const accepted = page.waitForResponse(response => response.url() === `${origin}/api/${first.id}/approve`);
    await card(first.id).getByRole('button', { name: 'Approve and run', exact: true }).click();
    const response = await accepted;
    assert.equal(response.status(), 202); assert.equal(response.headers()['preference-applied'], 'respond-async');
    assert.equal(response.request().headers().prefer, 'respond-async');
    await page.locator(`#running [data-request-id="${first.id}"]`).waitFor();
    assert.equal(app.queue.get(first.id).state, 'running'); assert.equal(executions, 1);
    assert.equal(await card(second.id).getByRole('button', { name: 'Approve and run', exact: true }).isEnabled(), true);
    await page.locator('[data-page-link][href="/settings"]').click();
    assert.equal(await page.locator('#appearance-settings').isVisible(), true);
    assert.equal(app.queue.get(first.id).state, 'running', 'settings navigation does not await execution');
    await page.locator('[data-page-link][href="/"]').click();
    const denied = page.waitForResponse(response => response.url() === `${origin}/api/${second.id}/deny`);
    await card(second.id).getByRole('button', { name: 'Denied', exact: true }).click();
    assert.equal((await denied).request().headers().prefer, undefined);
    assert.equal(app.queue.get(second.id).state, 'denied'); assert.equal(executions, 1);
    release(); assert.equal((await app.queue.wait(first.id)).state, failed ? 'failed' : 'completed');
    await page.clock.runFor(10000);
    await page.locator('[data-page-link][href="/history"]').click();
    const history = page.locator(`#history [data-request-id="${first.id}"]`);
    await history.waitFor(); assert.match(await history.textContent(), failed ? /Failed/ : /Completed/);
    assert.equal(executions, 1, 'polling and navigation never replay approval');
  } finally { release(); await browser?.close(); await app?.close(); await rm(directory, { recursive: true, force: true }); }
});
