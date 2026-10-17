import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { classifyCommand } from 'ssh-mcp/build/policy/classifier.js';
import { createApplication } from '../../app.mjs';

const recommended = ['pwd', 'ls', 'stat', 'df', 'du', 'uname', 'uptime', 'whoami', 'id', 'hostname'];
const low = { status: 'assessed', model: 'jev-1.13.0', label: 'low_risk', confidence: 0.7, probabilities: { low_risk: 0.95, high_risk: 0.02, uncertain: 0.03 } };
const targets = ['alpha', 'beta'].map(id => ({ id, displayName: id === 'alpha' ? '테스트 서버' : '운영 서버', readProfile: id + '-read', writeProfile: id + '-write', credentialRevision: 'v1' }));
const names = page => page.getByLabel('자동승인할 명령', { exact: true });
const ok = page => page.getByRole('checkbox', { name: /^위험도와 변경 내용을 확인했고/, includeHidden: true });
const review = page => page.getByRole('button', { name: '이 설정으로 위험도 확인', exact: true });
const save = page => page.getByRole('button', { name: '이 서버에 저장', exact: true, includeHidden: true });
async function fixture(run, { multi = false, assess = async () => low, width = 390 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'policy-browser-')); let app, browser;
  const calls = [], posts = [];
  try {
    app = await createApplication({
      registry: { getProfile: name => ({ host: '127.0.0.1', port: multi && name.startsWith('beta') ? 23 : 22, user: multi ? name.split('-')[0] : 'fixture', trustedHostKey: 'SHA256:' + (multi ? name.split('-')[0] : 'fixture'), readOnly: multi ? name.endsWith('-read') : name === 'aws-readonly' }), closeAll: async () => {} },
      classify: classifyCommand, executeCommand: async () => ({ failed: false, texts: ['synthetic result'] }), audit: () => {}, transferRoot: root, uiHtml: '<html></html>',
      policyRiskAssessor: { assess: async input => { calls.push(input); return assess(input); } },
      env: { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-owner', BRIDGE_UI_TICKET_KEY: 'a'.repeat(64), BRIDGE_ADMIN_ORIGIN: 'https://owner.test', BRIDGE_COMMAND_AUTOMATION: 'true',
        ...(multi ? { BRIDGE_TARGETS: JSON.stringify(targets), BRIDGE_DEFAULT_TARGET: 'alpha' } : {}) }
    });
    await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + app.adminHttp.address().port;
    const api = async (path, body) => {
      const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer fixture-owner', Origin: 'https://owner.test', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(response.status, 200, await response.clone().text()); return response.json();
    };
    const seed = async policy => {
      const current = await api('/api/command-policy'), proposal = { expectedRevision: current.revision, policy };
      const checked = await api('/api/command-policy/review', proposal);
      return api('/api/command-policy', { ...proposal, reviewToken: checked.reviewToken, acknowledged: true });
    };
    browser = await chromium.launch({ headless: true, ...(process.env.SOLID_CHROMIUM_PATH ? { executablePath: process.env.SOLID_CHROMIUM_PATH } : {}) });
    const context = await browser.newContext({ locale: 'ko-KR', viewport: { width, height: 844 }, colorScheme: 'dark' });
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== origin) return route.abort();
      if (route.request().method() === 'POST') {
        posts.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
        const response = await route.fetch({ maxRedirects: 0, headers: { ...route.request().headers(), origin: 'https://owner.test' } });
        return route.fulfill({ response });
      }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const open = async () => {
      await page.goto(origin); await page.locator('#token').fill('fixture-owner');
      await page.getByText('자동승인 설정', { exact: true }).click();
      await names(page).waitFor({ state: 'visible' });
    };
    const checked = async () => { await review(page).click(); await ok(page).waitFor({ state: 'visible' }); await page.waitForFunction(() => !document.querySelector('.policy-section:last-child input[type=checkbox]').disabled, null, { timeout: 10000 }); };
    const commit = async () => {
      await ok(page).check();
      const pending = page.waitForResponse(response => response.url().endsWith('/api/command-policy') && response.request().method() === 'POST');
      await save(page).click(); const response = await pending; assert.equal(response.status(), 200, await response.text());
      await page.getByText(/개를 저장했습니다\./).waitFor();
    };
    await run({ page, app, origin, api, seed, open, checked, commit, calls, posts });
  } finally { await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true }); }
}
async function screenshot(page, name) {
  if (!process.env.POLICY_UX_SCREENSHOTS) return;
  await mkdir(process.env.POLICY_UX_SCREENSHOTS, { recursive: true });
  await page.locator('#command-policy').screenshot({ path: join(process.env.POLICY_UX_SCREENSHOTS, name + '.png') });
}
for (const width of [375, 390]) test('simple registration preserves explicit consent and fits mobile ' + width, async () => fixture(async f => {
  const { page } = f; await f.open();
  assert.equal(await page.getByRole('checkbox', { name: /^Jev에 정보 전송/ }).isChecked(), false);
  assert.equal(await page.getByRole('checkbox', { name: /^Jev 판단으로도/ }).isChecked(), false);
  assert.equal(await page.getByLabel('jev 모델 ID', { exact: true }).isVisible(), false);
  assert.equal(await page.getByLabel(/기준 근거 참조/).count(), 0);
  await names(page).fill('ls\nsudo');
  await page.getByRole('button', { name: '조회 명령 10개 추가' }).click();
  await page.getByRole('button', { name: '조회 명령 10개 추가' }).click();
  assert.deepEqual((await names(page).inputValue()).split('\n'), ['ls', 'sudo', ...recommended.filter(name => name !== 'ls')]);
  assert.equal(await page.getByRole('checkbox', { name: /^Jev에 정보 전송/ }).isChecked(), false);
  await names(page).fill('ls -l'); await review(page).click();
  await page.getByRole('alert').getByText(/1번째 줄/).waitFor();
  assert.equal(f.posts.filter(x => x.path.endsWith('/review')).length, 0);
  await names(page).fill('ls\nsudo'); await names(page).focus();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await names(page).evaluate(node => getComputedStyle(node).fontSize), '16px');
  await f.checked();
  await page.getByText(/평가가 없다는 것이 안전하다는 뜻은 아닙니다/).waitFor();
  assert.equal(await save(page).isDisabled(), true);
  await ok(page).check(); assert.equal(await save(page).isDisabled(), false);
  await names(page).fill('ls\nsudo\npwd'); assert.equal(await save(page).isDisabled(), true); assert.equal(await ok(page).isChecked(), false);
  await f.checked(); await screenshot(page, 'mobile-' + width + '-review'); await f.commit();
  const stored = await f.api('/api/command-policy');
  assert.deepEqual(stored.targets[0].commands, ['ls', 'sudo', 'pwd']);
  assert.equal(stored.targets[0].externalDisclosure, false); assert.equal(stored.targets[0].modelExecution, false); assert.deepEqual(stored.targets[0].thresholds, {});
  assert.equal(f.calls.length, 0);
  const { job } = await f.app.targets.commands.run('sudo id'); await f.app.targets.drain();
  assert.equal(f.app.queue.get(job.id).state, 'completed'); assert.equal(f.app.queue.get(job.id).approvalMode, 'automatic');
  await page.locator('#load').click(); await page.locator('[data-request-id="' + job.id + '"] summary').getByText('자동승인', { exact: true }).waitFor();
}, { width }));

test('Jev 90 percent needs no manual reference and persists exactly the reviewed candidate', async () => fixture(async f => {
  const { page } = f; await f.open(); await page.getByRole('button', { name: '조회 명령 10개 추가' }).click();
  await page.getByRole('checkbox', { name: /^Jev에 정보 전송/ }).check();
  await page.getByRole('checkbox', { name: /^Jev 판단으로도/ }).check();
  assert.equal(await page.getByLabel('Jev 자동승인 기준 (%)', { exact: true }).inputValue(), '90');
  await screenshot(page, 'mobile-390-settings');
  await f.checked(); assert.equal(f.calls.length, 1);
  await page.getByText('Jev 안전 확률 95.0% · 실제 안전을 보증하지 않습니다.', { exact: true }).waitFor();
  const proposed = f.posts.find(x => x.path.endsWith('/review')).body;
  assert.equal(proposed.policy.targets[0].thresholds.jev.minLowRisk, 0.9);
  assert.match(proposed.policy.targets[0].thresholds.jev.validationRef, /^user-choice:/);
  assert.equal(f.calls[0].userApproval, undefined); assert.deepEqual(f.calls[0].proposedCommands, recommended);
  await f.commit();
  const submitted = f.posts.find(x => x.path === '/api/command-policy').body;
  assert.deepEqual(submitted.policy, proposed.policy); assert.equal(submitted.expectedRevision, proposed.expectedRevision);
  assert.deepEqual((await f.api('/api/command-policy')).targets, proposed.policy.targets);
  await page.setViewportSize({ width: 1200, height: 900 }); await screenshot(page, 'desktop-settings');
}));

test('legacy, 80 percent, fallback, denied rules and other targets survive command-only editing; migration is explicit', async () => fixture(async f => {
  const initial = await f.api('/api/command-policy');
  const thresholds = { jev: { model: 'jev-1.13.0', questionVersion: 'ssh-command-risk-v2', minLowRisk: 0.8, minConfidence: 0.7, validationRef: 'synthetic:original-legacy' },
    luna: { model: 'custom-luna', questionVersion: 'ssh-command-risk-v4', basis: 'safety-probability-v1', minLowRisk: 0.96, validationRef: 'synthetic:luna' },
    sonnet: { model: 'custom-sonnet', questionVersion: 'ssh-command-risk-v4', basis: 'safety-probability-v1', minLowRisk: 0.91, validationRef: 'synthetic:sonnet' } };
  const policy = { targets: initial.bindings.map(binding => ({ targetId: binding.targetId, targetRevision: binding.targetRevision, profile: binding.profile,
    commands: ['ls'], deniedCommands: ['rm', 'dd'], externalDisclosure: true, modelExecution: true, fallback: 'luna', thresholds: structuredClone(thresholds) })) };
  await f.seed(policy); await f.open(); const { page } = f;
  const probability = page.getByLabel('Jev 자동승인 기준 (%)', { exact: true });
  assert.equal(await probability.inputValue(), '80'); assert.equal(await probability.isDisabled(), true);
  await names(page).fill('ls\npwd'); await f.checked(); await f.commit();
  const after = (await f.api('/api/command-policy')).targets;
  assert.deepEqual(after, [{ ...policy.targets[0], commands: ['ls', 'pwd'] }, policy.targets[1]]);
  await page.getByRole('button', { name: 'jev 기준을 현재 방식으로 바꾸기', exact: true }).click();
  assert.equal(await probability.isDisabled(), false); await probability.fill('90');
  await page.getByText(/기존 confidence 조건 제거/).waitFor();
  await f.checked(); await f.commit();
  const migrated = (await f.api('/api/command-policy')).targets;
  assert.equal(migrated[0].thresholds.jev.questionVersion, 'ssh-command-risk-v4'); assert.equal(migrated[0].thresholds.jev.basis, 'safety-probability-v1');
  assert.equal(migrated[0].thresholds.jev.minLowRisk, 0.9); assert.equal(Object.hasOwn(migrated[0].thresholds.jev, 'minConfidence'), false);
  assert.deepEqual(migrated[0].thresholds.luna, thresholds.luna); assert.deepEqual(migrated[0].thresholds.sonnet, thresholds.sonnet); assert.deepEqual(migrated[1], policy.targets[1]);
}, { multi: true }));

for (const mode of ['edit', 'recommend', 'target']) test('late review cannot authorize a changed draft: ' + mode, async () => fixture(async f => {
  const { page } = f; await f.open(); await names(page).fill('ls');
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/command-policy/review', async route => {
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: 'https://owner.test' } }); entered(); await held; await route.fulfill({ response });
  });
  const response = page.waitForResponse(r => r.url().endsWith('/api/command-policy/review'));
  await review(page).click(); await started;
  if (mode === 'edit') await names(page).fill('pwd');
  else if (mode === 'recommend') await page.getByRole('button', { name: '조회 명령 10개 추가' }).click();
  else {
    const selector = page.getByLabel('설정할 서버', { exact: true });
    await selector.selectOption('beta');
  }
  release(); await (await response).finished(); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await save(page).isDisabled(), true); assert.equal(await ok(page).isDisabled(), true);
  assert.equal(await page.getByText('저장 전 확인해 주세요', { exact: true }).count(), 0);
}, { multi: true }));

test('expired feedback clears OK without losing input, and an unobserved save preserves the draft without retry', async () => fixture(async f => {
  const { page } = f; await page.clock.install(); await f.open(); await names(page).fill('ls'); await f.checked(); await ok(page).check();
  await page.clock.fastForward(300001);
  await page.getByText(/확인 결과가 만료됐습니다. 입력은 유지됩니다/).waitFor();
  assert.equal(await names(page).inputValue(), 'ls'); assert.equal(await save(page).isDisabled(), true); assert.equal(await ok(page).isChecked(), false);
  await page.clock.setSystemTime(new Date());
  await f.checked(); await ok(page).check();
  let writes = 0;
  await page.route('**/api/command-policy', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    writes++; const response = await route.fetch({ headers: { ...route.request().headers(), origin: 'https://owner.test' } });
    assert.equal(response.status(), 200); await route.abort('failed');
  });
  await save(page).click(); await page.getByText(/저장 결과를 확인하지 못했습니다/).waitFor();
  assert.equal(await names(page).inputValue(), 'ls'); assert.equal(await save(page).isDisabled(), true); assert.equal(await ok(page).isDisabled(), true);
  assert.equal(writes, 1); assert.deepEqual((await f.api('/api/command-policy')).targets[0].commands, ['ls']);
}));

test('local high-risk warning remains prominent even when Jev reports low risk', async () => fixture(async f => {
  const { page } = f; await f.open(); await names(page).fill('rm'); await page.getByRole('checkbox', { name: /^Jev에 정보 전송/ }).check();
  await f.checked(); await page.getByText(/위험도 높음/).waitFor();
  assert.equal(await page.locator('.policy-risk').getAttribute('data-level'), 'high_risk');
  assert.equal(await save(page).isDisabled(), true); assert.equal((await f.api('/api/command-policy')).targets.length, 0);
}));
