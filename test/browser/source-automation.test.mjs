import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyCommand } from 'ssh-mcp/build/policy/classifier.js';
import { createApplication } from '../../app.mjs';
import { launchBrowser, browserName } from './browser.mjs';

const targets = ['alpha', 'beta'].map(id => ({ id, displayName: id, readProfile: id + '-read', writeProfile: id + '-write', credentialRevision: 'v1' }));
const source = "# PRIVATE_BROWSER_SOURCE_32 <img src=x onerror=alert(1)>\n" + '# literal code review line, no effects\n'.repeat(260) + "print('done')\n";
const context = 'Synthetic test only; literal print with comments, no resources mutated, no recovery required';
const title = ko => ko ? '제출한 Python 코드 평가·실행 허용' : 'Allow submitted Python code assessment and execution';
async function fixture(t, { width = 390, height = 844, ko = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'source-browser-')); let app, browser;
  t.after(async () => { await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true }); });
  app = await createApplication({ registry: { getProfile: name => ({ host: '127.0.0.1', port: name.startsWith('alpha') ? 22 : 23, user: name.split('-')[0], trustedHostKey: 'SHA256:' + name.split('-')[0], readOnly: name.endsWith('-read') }), closeAll: async () => {} },
    classify: classifyCommand, executeCommand: async () => ({ failed: false, texts: ['ok'] }), executePythonSource: async () => ({ failed: false, texts: ['ok'] }), audit() {}, transferRoot: root, uiHtml: '<html></html>',
    env: { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-owner', BRIDGE_UI_TICKET_KEY: 'a'.repeat(64), BRIDGE_ADMIN_ORIGIN: 'https://owner.test', BRIDGE_COMMAND_AUTOMATION: 'true', BRIDGE_TARGETS: JSON.stringify(targets), BRIDGE_DEFAULT_TARGET: 'alpha' } });
  await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + app.adminHttp.address().port;
  const api = async (path, body) => {
    const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer fixture-owner', Origin: 'https://owner.test', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  const initial = await api('/api/command-policy');
  const rules = initial.bindings.map(binding => ({ targetId: binding.targetId, targetRevision: binding.targetRevision, profile: binding.profile, commands: ['ls'], deniedCommands: ['rm'], automaticSudo: false,
    automaticUploads: false, automaticDownloads: true, externalDisclosure: false, modelExecution: true, fallback: null, thresholds: { jev: { model: 'jev-1.14.0', questionVersion: 'ssh-command-risk-v4', basis: 'safety-probability-v1', minLowRisk: 0.83, validationRef: 'synthetic:browser-source' } } }));
  const proposal = { expectedRevision: initial.revision, policy: { targets: rules } }, review = await api('/api/command-policy/review', proposal);
  await api('/api/command-policy', { ...proposal, reviewToken: review.reviewToken, acknowledged: true });
  browser = await launchBrowser(); const browserContext = await browser.newContext({ locale: ko ? 'ko-KR' : 'en-US', viewport: { width, height } });
  await browserContext.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== origin) return route.abort();
    if (route.request().method() === 'POST') return route.fulfill({ response: await route.fetch({ headers: { ...route.request().headers(), origin: 'https://owner.test' } }) });
    return route.continue();
  });
  const page = await browserContext.newPage(); page.setDefaultTimeout(10000);
  const open = async path => {
    await page.goto(origin + path); await page.locator('#token').fill('fixture-owner');
    if (path === '/settings') await page.getByRole('button', { name: ko ? '현재 설정 불러오기' : 'Load current settings', exact: true }).click();
    else await page.locator('#load').click();
  };
  const submit = async () => { const result = await app.targets.commands.runSource({ source, cwd: '/tmp', context }, 'alpha'); await app.targets.drain(); return app.queue.get(result.job.id); };
  return { app, page, api, open, submit, rules, browserContext, origin };
}

for (const [width, height] of [[375, 812], [390, 844], [768, 1024], [1440, 900], [844, 390]]) for (const ko of [true, false]) {
  test(`SOURCE-BROWSER policy consent/drafts/save and source scroll ${browserName} ${width}x${height} ${ko ? 'ko' : 'en'}`, { timeout: 30000 }, async t => {
    const f = await fixture(t, { width, height, ko }), { page } = f;
    await f.open('/settings'); const checkbox = page.getByRole('checkbox', { name: new RegExp('^' + title(ko)) });
    await checkbox.waitFor(); assert.equal(await checkbox.isChecked(), false); await checkbox.check();
    const target = page.getByLabel(ko ? '정책 편집 대상' : 'Policy edit target', { exact: true });
    await target.selectOption('beta'); assert.equal(await checkbox.isChecked(), false);
    await target.selectOption('alpha'); assert.equal(await checkbox.isChecked(), true);
    await page.getByRole('tab', { name: ko ? '검토·저장' : 'Review and save', exact: true }).click();
    await page.getByRole('button', { name: ko ? '이 설정으로 위험도 확인' : 'Review this configuration', exact: true }).click();
    const ack = page.getByRole('checkbox', { name: ko ? '위험도와 변경 내용을 확인했고 저장에 동의합니다 (OK)' : 'I reviewed the risk and changes and agree to save (OK)' });
    await ack.waitFor(); assert.match(await page.locator('.policy-feedback').innerText(), ko ? /샌드박스가 아니며/ : /not a sandbox/);
    if (!ko) assert.doesNotMatch(await page.locator('.policy-feedback').innerText(), /[가-힣]/);
    await ack.check(); const saved = page.waitForResponse(r => r.url().endsWith('/api/command-policy') && r.request().method() === 'POST');
    await page.getByRole('button', { name: ko ? '이 서버에 저장' : 'Save to this server', exact: true }).click(); assert.equal((await saved).status(), 200);
    const current = await f.api('/api/command-policy'), expected = structuredClone(f.rules); expected[0].sourceExecutionContract = 'python-source-v1';
    assert.deepEqual(current.targets, expected, 'Only the selected source grant changes; threshold/sudo/deny/other target remain intact');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'No horizontal page overflow');
    const job = await f.submit(); await f.open('/');
    const card = page.locator('[data-request-id="' + job.id + '"]'); await card.waitFor();
    assert.equal(await card.locator('.submitted-source').count(), 0);
    await card.getByRole('button', { name: ko ? '제출 코드 원문 보기' : 'View submitted source', exact: true }).click();
    const code = card.locator('.submitted-source'); await code.waitFor(); assert.equal(await code.textContent(), source); assert.equal(await code.locator('img').count(), 0);
    const scroll = await code.evaluate(n => { n.scrollTop = n.scrollHeight; return { scrollable: n.scrollHeight > n.clientHeight, moved: n.scrollTop > 0, height: n.clientHeight }; });
    assert.equal(scroll.scrollable, true); assert.equal(scroll.moved, true); assert.ok(scroll.height <= 360);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  });
}

for (const action of ['page', 'target', 'logout']) test(`SOURCE-BROWSER delayed source never populates replaced scope ${browserName} ${action}`, { timeout: 20000 }, async t => {
  const f = await fixture(t), { page } = f, job = await f.submit(); await f.open('/');
  let release, reached, delivered; const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { reached = resolve; }), delivery = new Promise(resolve => { delivered = resolve; });
  await page.route('**/api/' + job.id + '/source', async route => { const response = await route.fetch(); reached(); await held; try { await route.fulfill({ response }).catch(() => {}); } finally { delivered(); } });
  await page.getByRole('button', { name: '제출 코드 원문 보기', exact: true }).click(); await started;
  try {
    if (action === 'page') await page.locator('[data-page-link][href="/settings"]').click();
    else if (action === 'target') await page.locator('#target-filter').selectOption('beta');
    else await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.getByRole('button', { name: '로그아웃', exact: true }).click()]);
  } finally { release(); }
  // Let the held fetch settle and all rendering microtasks run; no fixed long sleep.
  await delivery; await page.waitForLoadState(); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.submitted-source').count(), 0); assert.doesNotMatch(await page.locator('body').innerText(), /PRIVATE_BROWSER_SOURCE_32/);
  assert.deepEqual(await page.evaluate(() => Object.values(localStorage)), []);
});
