import assert from 'node:assert/strict';

export const requestRows = (page, area = '#history') => page.locator(area + ' article[data-request-id]');
export async function openRequest(page, id, area = '#history') {
  const row = id === undefined ? requestRows(page, area).first() : page.locator(area + ' article[data-request-id="' + id + '"]');
  await row.locator('[data-request-detail]').click();
  await page.locator('#request-detail').waitFor({state:'visible'});
  if (id !== undefined) assert.ok((await page.locator('#request-detail-target').textContent()).includes(id));
  return page.locator('#request-detail-body');
}
export async function navigate(page, path) {
  await page.locator('[data-page-link][href="' + path + '"]').click();
  await page.waitForURL(url => url.pathname === path);
}
export async function historyReady(page) {
  await page.waitForFunction(() => document.querySelector('#history')?.getAttribute('aria-busy') === 'false');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
export const permissionsTab = page => page.locator('#command-policy [role=tab]').nth(1).click();
export const cliTab = page => page.locator('#server-settings-tabs [data-server-tab=cli]').click();
export async function selectServer(page, id) {
  await page.locator('#server-target option[value="' + id + '"]').waitFor({state:'attached'});
  await page.locator('#server-target').selectOption(id);
  await page.waitForFunction(id => document.querySelector('#server-target')?.value === id && !document.querySelector('#server-target').disabled, id);
}
export async function environmentGroups(page) {
  for (const group of await page.locator('#environment-editor details.environment-group').all()) {
    if (!await group.evaluate(node => node.open)) await group.locator(':scope > summary').click();
  }
}
export async function assertHistoryIds(page, ids) {
  await page.waitForFunction(expected => JSON.stringify(Array.from(document.querySelectorAll('#history article[data-request-id]'), node => node.dataset.requestId).sort()) === JSON.stringify(expected), [...ids].sort());
  assert.deepEqual(await requestRows(page).evaluateAll(nodes => nodes.map(node => node.dataset.requestId).sort()), [...ids].sort());
}
