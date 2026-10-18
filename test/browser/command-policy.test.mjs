import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { classifyCommand } from 'ssh-mcp/build/policy/classifier.js';
import { createApplication } from '../../app.mjs';

const recommended = ['pwd', 'ls', 'stat', 'df', 'du', 'uname', 'uptime', 'whoami', 'id', 'hostname'];
const low = { status: 'assessed', model: 'jev-1.14.0', label: 'low_risk', confidence: 0.7, probabilities: { low_risk: 0.95, high_risk: 0.02, uncertain: 0.03 } };
const targets = ['alpha', 'beta'].map(id => ({ id, displayName: id === 'alpha' ? '테스트 서버' : '운영 서버', readProfile: id + '-read', writeProfile: id + '-write', credentialRevision: 'v1' }));
const tab = (page, name) => page.getByRole('tab', { name, exact: true });
const commandTab = async page => { await tab(page, '명령 관리').click(); const bulk = page.locator('.command-bulk'); if (!await bulk.evaluate(n => n.open)) await bulk.locator('summary').click(); };
const modelTab = async page => tab(page, 'Jev·모델').click();
const reviewTab = async page => tab(page, '검토·저장').click();
const catalog = async page => { await commandTab(page); await page.getByLabel('명령 보기', { exact: true }).selectOption('all'); };
const choice = (page, name) => page.getByRole('button', { name: new RegExp('^' + name + ' 자동승인') });
const names = page => page.getByLabel('자동승인할 명령', { exact: true });
const ok = page => page.getByRole('checkbox', { name: /^위험도와 변경 내용을 확인했고/, includeHidden: true });
const review = page => page.getByRole('button', { name: '이 설정으로 위험도 확인', exact: true, includeHidden: true });
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
      if (process.env.POLICY_UX_ROOT && new URL(route.request().url()).pathname === '/app.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(join(process.env.POLICY_UX_ROOT, 'web/dist/app.js'), 'utf8') });
      if (route.request().method() === 'POST') {
        posts.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
        const response = await route.fetch({ maxRedirects: 0, headers: { ...route.request().headers(), origin: 'https://owner.test' } });
        return route.fulfill({ response });
      }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const open = async () => {
      await page.goto(origin+'/settings'); await page.locator('#token').fill('fixture-owner');
      await page.getByRole('button',{name:'현재 설정 불러오기',exact:true}).click();
      await tab(page, '명령 관리').waitFor(); await commandTab(page); await names(page).waitFor({ state: 'visible' });
    };
    const checked = async () => { await reviewTab(page); await review(page).click(); await ok(page).waitFor({ state: 'visible' }); await page.waitForFunction(() => !document.querySelector('.policy-section:last-child input[type=checkbox]').disabled, null, { timeout: 10000 }); };
    const commit = async () => {
      await reviewTab(page); await ok(page).check();
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
  assert.equal(await page.getByRole('checkbox', { name: /^Jev에 정보 전송/, includeHidden: true }).isChecked(), false);
  assert.equal(await page.getByRole('checkbox', { name: /^Jev·다른 모델을 통한/ }).isChecked(), false);
  assert.equal(await page.getByLabel('Jev 모델', { exact: true }).isVisible(), false); await modelTab(page); assert.equal(await page.getByLabel('Jev 모델', { exact: true }).isVisible(), true);
  assert.equal(await page.getByLabel('Jev 모델', { exact: true }).evaluate(node => node.tagName), 'SELECT');
  assert.equal(await page.getByLabel('Jev 모델', { exact: true }).inputValue(), 'jev-1.14.0');
  assert.equal(await page.getByLabel(/기준 근거 참조/).count(), 0);
  assert.deepEqual((await names(page).inputValue()).split('\n'), recommended);
  assert.equal(await page.getByRole('button', { name: '조회 명령 10개 추가' }).count(), 0);
  assert.equal(f.posts.length, 0); assert.deepEqual((await f.api('/api/command-policy')).targets, []);
  await commandTab(page); await names(page).fill('ls\nsudo');
  await catalog(page); await page.getByLabel('명령 검색', { exact: true }).fill('pwd');
  await choice(page, 'pwd').click();
  assert.deepEqual((await names(page).inputValue()).split('\n'), ['ls', 'sudo', 'pwd']);
  assert.equal(await page.getByRole('checkbox', { name: /^Jev에 정보 전송/, includeHidden: true }).isChecked(), false);
  await commandTab(page); await names(page).fill('ls -l'); await reviewTab(page); await review(page).click();
  await page.getByRole('alert').getByText(/1번째 줄/).waitFor();
  assert.equal(f.posts.filter(x => x.path.endsWith('/review')).length, 0);
  await commandTab(page); await names(page).fill('ls\nsudo'); await commandTab(page); await names(page).focus();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await names(page).evaluate(node => getComputedStyle(node).fontSize), '16px');
  await f.checked();
  await page.getByText(/평가가 없다는 것이 안전하다는 뜻은 아닙니다/).waitFor();
  assert.equal(await save(page).isDisabled(), true);
  await ok(page).check(); assert.equal(await save(page).isDisabled(), false);
  await commandTab(page); await names(page).fill('ls\nsudo\npwd'); assert.equal(await save(page).isDisabled(), true); assert.equal(await ok(page).isChecked(), false);
  await f.checked(); await screenshot(page, 'mobile-' + width + '-review'); await f.commit();
  const stored = await f.api('/api/command-policy');
  assert.deepEqual(stored.targets[0].commands, ['ls', 'sudo', 'pwd']);
  assert.equal(stored.targets[0].externalDisclosure, false); assert.equal(stored.targets[0].modelExecution, false); assert.deepEqual(stored.targets[0].thresholds, {});
  assert.equal(f.calls.length, 0);
  const { job } = await f.app.targets.commands.run('ls && pwd'); await f.app.targets.drain();
  assert.equal(f.app.queue.get(job.id).state, 'completed'); assert.equal(f.app.queue.get(job.id).approvalMode, 'automatic');
  await page.getByRole('link',{name:'승인',exact:true}).click();
  await page.locator('#load').click(); await page.locator('[data-request-id="' + job.id + '"] summary').getByText('자동승인', { exact: true }).waitFor();
}, { width }));

test('Jev 90 percent needs no manual reference and persists exactly the reviewed candidate', async () => fixture(async f => {
  const { page } = f; await f.open();
  await modelTab(page); await page.getByRole('checkbox', { name: /^Jev에 정보 전송/ }).check();
  await page.getByRole('checkbox', { name: /^Jev·다른 모델을 통한/ }).check();
  assert.equal(await page.getByLabel('Jev 자동승인 기준 (%)', { exact: true }).inputValue(), '90');
  await screenshot(page, 'mobile-390-settings');
  await f.checked(); assert.equal(f.calls.length, 1);
  await page.getByText('Jev 분류: 낮음 · 구체적인 위험 사유는 제공되지 않았습니다.', { exact: true }).waitFor();
  assert.equal(await page.getByText(/낮은 위험 점수 95.0%/).isVisible(), false);
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
  const thresholds = { jev: { model: 'jev-1.14.0', questionVersion: 'ssh-command-risk-v2', minLowRisk: 0.8, minConfidence: 0.7, validationRef: 'synthetic:original-legacy' },
    luna: { model: 'custom-luna', questionVersion: 'ssh-command-risk-v4', basis: 'safety-probability-v1', minLowRisk: 0.96, validationRef: 'synthetic:luna' },
    sonnet: { model: 'custom-sonnet', questionVersion: 'ssh-command-risk-v4', basis: 'safety-probability-v1', minLowRisk: 0.91, validationRef: 'synthetic:sonnet' } };
  const policy = { targets: initial.bindings.map(binding => ({ targetId: binding.targetId, targetRevision: binding.targetRevision, profile: binding.profile,
    commands: ['ls'], deniedCommands: ['rm', 'dd'], externalDisclosure: true, modelExecution: true, fallback: 'luna', thresholds: structuredClone(thresholds) })) };
  await f.seed(policy); await f.open(); const { page } = f;
  const probability = page.getByLabel('Jev 자동승인 기준 (%)', { exact: true });
  assert.equal(await probability.inputValue(), '80'); assert.equal(await probability.isDisabled(), true);
  await commandTab(page); await names(page).fill('ls\npwd'); await f.checked(); await f.commit();
  const after = (await f.api('/api/command-policy')).targets;
  assert.deepEqual(after, [{ ...policy.targets[0], commands: ['ls', 'pwd'] }, policy.targets[1]]);
  await modelTab(page); await page.getByRole('button', { name: 'jev 기준을 현재 방식으로 바꾸기', exact: true }).click();
  assert.equal(await probability.isDisabled(), false); await modelTab(page); await probability.fill('90');
  await reviewTab(page); await page.getByText(/기존 confidence 조건 제거/).waitFor();
  await f.checked(); await f.commit();
  const migrated = (await f.api('/api/command-policy')).targets;
  assert.equal(migrated[0].thresholds.jev.questionVersion, 'ssh-command-risk-v4'); assert.equal(migrated[0].thresholds.jev.basis, 'safety-probability-v1');
  assert.equal(migrated[0].thresholds.jev.minLowRisk, 0.9); assert.equal(Object.hasOwn(migrated[0].thresholds.jev, 'minConfidence'), false);
  assert.deepEqual(migrated[0].thresholds.luna, thresholds.luna); assert.deepEqual(migrated[0].thresholds.sonnet, thresholds.sonnet); assert.deepEqual(migrated[1], policy.targets[1]);
}, { multi: true }));

for (const mode of ['edit', 'select', 'target']) test('late review cannot authorize a changed draft: ' + mode, async () => fixture(async f => {
  const { page } = f; await f.open(); await commandTab(page); await names(page).fill('ls');
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/command-policy/review', async route => {
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: 'https://owner.test' } }); entered(); await held; await route.fulfill({ response });
  });
  const response = page.waitForResponse(r => r.url().endsWith('/api/command-policy/review'));
  await reviewTab(page); await review(page).click(); await started;
  if (mode === 'edit') { await commandTab(page); await names(page).fill('pwd'); }
  else if (mode === 'select') { await catalog(page); await page.getByLabel('명령 검색', { exact: true }).fill('grep'); await choice(page, 'grep').click(); }
  else {
    const selector = page.getByLabel('설정할 서버', { exact: true });
    await selector.selectOption('beta');
  }
  release(); await (await response).finished(); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await save(page).isDisabled(), true); assert.equal(await ok(page).isDisabled(), true);
  assert.equal(await page.getByText('저장 전 확인해 주세요', { exact: true }).count(), 0);
}, { multi: true }));

test('expired feedback clears OK without losing input, and an unobserved save preserves the draft without retry', async () => fixture(async f => {
  const { page } = f; await page.clock.install(); await f.open(); await commandTab(page); await names(page).fill('ls'); await f.checked(); await ok(page).check();
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
  const { page } = f; await f.open(); await commandTab(page); await names(page).fill('rm'); await modelTab(page); await page.getByRole('checkbox', { name: /^Jev에 정보 전송/ }).check();
  await f.checked(); await page.getByText(/종합 위험도 높음/).waitFor();
  assert.equal(await page.locator('.policy-risk').getAttribute('data-level'), 'high_risk');
  assert.equal(await save(page).isDisabled(), true); assert.equal((await f.api('/api/command-policy')).targets.length, 0);
}));

test('command search matches descriptions, preserves review for filters, and selection clears OK', async () => fixture(async f => {
  const {page}=f;await f.open();const search=page.getByLabel('명령 검색',{exact:true});
  await catalog(page); await search.fill('프로세스');await page.getByRole('button',{name:'ps 상세 보기',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'grep 상세 보기',exact:true}).count(),0);
  await catalog(page); await search.fill('파일 찾기');await page.getByRole('button',{name:'find 상세 보기',exact:true}).waitFor();
  await catalog(page); await search.fill('grep');const selected=choice(page, 'grep');await selected.click();
  assert.equal(await selected.evaluate(node=>node===document.activeElement),true);
  assert.equal((await names(page).inputValue()).split('\n').filter(name=>name==='grep').length,1);
  await selected.click();assert.deepEqual((await names(page).inputValue()).split('\n'),recommended);
  await f.checked();await ok(page).check();await catalog(page); await search.fill('메모리');
  assert.equal(await save(page).isDisabled(),false);assert.equal(await ok(page).isChecked(),true);
  await search.press('Enter');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(f.posts.filter(item=>item.path==='/api/command-policy').length,0);
  assert.equal(await ok(page).isChecked(),true);assert.equal(await save(page).isDisabled(),false);
  await choice(page, 'free').click();
  assert.equal(await save(page).isDisabled(),true);assert.equal(await ok(page).isChecked(),false);
  await catalog(page); await search.fill('not-a-known-command');await page.getByText(/일치하는 규칙이 없습니다/).waitFor();
  assert.equal(f.calls.length,0);assert.equal(f.posts.length,1);
  await catalog(page); await search.fill('파일');await screenshot(page,'mobile-search-files');
  await page.setViewportSize({width:1200,height:900});await catalog(page); await search.fill('프로세스');await screenshot(page,'desktop-search-processes');
}));

test('search Enter keeps the reviewed draft unsaved until the save button is clicked',async()=>fixture(async f=>{
  await f.open();const {page}=f;await f.checked();await ok(page).check();
  const search=page.getByLabel('명령 검색',{exact:true});await catalog(page); await search.fill('grep');await search.press('Enter');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(f.posts.filter(item=>item.path==='/api/command-policy').length,0);
  assert.deepEqual((await f.api('/api/command-policy')).targets,[]);
  await f.commit();assert.equal(f.posts.filter(item=>item.path==='/api/command-policy').length,1);
  assert.deepEqual((await f.api('/api/command-policy')).targets[0].commands,recommended);
}));

test('saved empty and custom command policies are not replaced by defaults',async()=>fixture(async f=>{
  const initial=await f.api('/api/command-policy');
  await f.seed({targets:initial.bindings.map((binding,index)=>({targetId:binding.targetId,targetRevision:binding.targetRevision,profile:binding.profile,commands:index?['custom-check']:[],deniedCommands:[],externalDisclosure:false,modelExecution:false,fallback:null,thresholds:{}}))});
  await f.open();const {page}=f;assert.equal(await names(page).inputValue(),'');
  await page.getByLabel('설정할 서버',{exact:true}).selectOption('beta');assert.equal(await names(page).inputValue(),'custom-check');
  await page.getByLabel('설정할 서버',{exact:true}).selectOption('alpha');assert.equal(await names(page).inputValue(),'');
  assert.equal(f.posts.length,0);
},{multi:true}));

test('download opt-in is visible, exact-review-bound and isolated per target',async()=>fixture(async f=>{
  await f.open();const download=f.page.getByRole('checkbox',{name:/^파일 자동다운로드 허용/});
  assert.equal(await download.isChecked(),false);await download.check();assert.equal(await save(f.page).isDisabled(),true);
  await f.checked();await f.page.getByText(/파일 자동다운로드를 켜면/).waitFor();await f.commit();
  let policy=await f.api('/api/command-policy');assert.equal(policy.targets[0].automaticDownloads,true);assert.equal(policy.targets[0].automaticSudo,undefined);
  await f.page.getByLabel('설정할 서버',{exact:true}).selectOption('beta');assert.equal(await download.isChecked(),false);
  await f.page.getByLabel('설정할 서버',{exact:true}).selectOption('alpha');assert.equal(await download.isChecked(),true);
  await download.uncheck();await f.checked();await f.commit();policy=await f.api('/api/command-policy');assert.equal(policy.targets[0].automaticDownloads,false);
},{multi:true}));

test('settings is a separate URL, navigation preserves unsaved input without storing credentials and metrics load on demand',async()=>fixture(async f=>{
  const {page}=f;await f.open();assert.ok(page.url().endsWith('/settings'));await commandTab(page); await names(page).fill('ls');
  await page.getByRole('link',{name:'승인',exact:true}).click();assert.ok(page.url().endsWith('/'));assert.equal(await page.locator('#command-policy').isVisible(),false);
  assert.equal(await page.getByRole('checkbox',{name:/^파일 자동다운로드 허용/}).isVisible(),true);
  await page.getByRole('link',{name:'설정',exact:true}).click();assert.equal(await names(page).inputValue(),'ls');assert.equal(await page.locator('#token').inputValue(),'fixture-owner');
  assert.deepEqual(await page.evaluate(()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage)})),{local:[],session:[]});
  await page.locator('#automation-metrics>summary').click();await page.locator('.metric-card').first().waitFor();assert.equal(await page.locator('.metric-card').count(),5);
  assert.match(await page.locator('#automation-metrics').textContent(),/청구금액은 수집하지/);assert.equal(f.calls.length,0);
  if(process.env.FOLLOWUP_SCREENSHOTS)await page.screenshot({path:process.env.FOLLOWUP_SCREENSHOTS+'/settings-mobile.png',fullPage:true});
  await page.goBack();assert.ok(page.url().endsWith('/'));assert.equal(await page.locator('#command-policy').isVisible(),false);
}));

test('upload opt-in is explicit, review-bound, preserved per target and reversible', async () => fixture(async f => {
  const { page } = f; await f.open();
  const upload = page.getByRole('checkbox', { name: /^파일 자동업로드 허용/ });
  assert.equal(await upload.isChecked(), false);
  assert.ok((await upload.locator('..').textContent()).includes('폴더 제한 없이 SSH 계정이 쓸 수 있는 경로'));
  await f.checked(); await ok(page).check(); await upload.check();
  assert.equal(await save(page).isDisabled(), true); assert.equal(await ok(page).isChecked(), false);
  assert.ok((await page.locator('.policy-change-summary').textContent()).includes('설정/인증/자동 실행 파일도 포함'));
  await f.checked(); await page.getByText(/종합 위험도 높음/).waitFor(); await f.commit();
  const stored = await f.api('/api/command-policy'); assert.equal(stored.targets[0].automaticUploads, true);
  await page.getByLabel('설정할 서버', { exact: true }).selectOption('beta'); assert.equal(await upload.isChecked(), false);
  await commandTab(page); await names(page).fill('ls'); await f.checked(); await f.commit();
  const other = (await f.api('/api/command-policy')).targets; assert.equal(other[0].automaticUploads, true); assert.equal(Object.hasOwn(other[1], 'automaticUploads'), false);
  await page.getByLabel('설정할 서버', { exact: true }).selectOption('alpha'); assert.equal(await upload.isChecked(), true);
  await upload.uncheck(); await f.checked(); await f.commit();
  assert.equal((await f.api('/api/command-policy')).targets[0].automaticUploads, false);
  assert.equal(f.calls.length, 0);
}, { multi: true }));

test('model selection is above consent, invalidates review, and threshold errors stay beside their input', async () => fixture(async f => {
  const {page}=f;await f.open();const model=page.getByLabel('Jev 모델',{exact:true}),score=page.getByLabel('Jev 자동승인 기준 (%)',{exact:true});
  assert.equal(await model.evaluate(node=>node.tagName),'SELECT');
  assert.ok(await model.evaluate(node=>Boolean(node.compareDocumentPosition(document.querySelector('.policy-section:nth-child(2) input[type=checkbox]')) & Node.DOCUMENT_POSITION_FOLLOWING)));
  await modelTab(page); await page.getByRole('checkbox',{name:/^Jev에 정보 전송/}).check();await page.getByRole('checkbox',{name:/^Jev·다른 모델을 통한/}).check();
  await modelTab(page); await score.fill('50');await reviewTab(page); await review(page).click();
  const note=page.locator('#'+await score.getAttribute('aria-errormessage'));await note.waitFor();
  assert.match(await note.textContent(),/50%보다 크고/);assert.equal(await score.getAttribute('aria-invalid'),'true');
  assert.equal(await score.evaluate(node=>document.activeElement===node),true);assert.equal(await page.locator('#command-policy>p.error').isVisible(),false);
  await modelTab(page); await score.fill('90');await f.checked();await ok(page).check();await modelTab(page); await model.selectOption('jev-1.13.0');
  assert.equal(await save(page).isDisabled(),true);assert.equal(await ok(page).isChecked(),false);
  const fallbackOption=page.getByLabel('Jev 평가 불가 시 대체 평가자',{exact:true}).locator('option[value=luna]');
  assert.equal(await fallbackOption.evaluate(node=>node.disabled),true,JSON.stringify(await fallbackOption.evaluate(node=>({html:node.outerHTML,parent:node.parentElement.outerHTML}))));
  await screenshot(page,'model-and-inline-validation');
}));

test('important upload and sudo controls stay between overview and collapsed policy; changes require exact feedback and OK',async()=>fixture(async f=>{
  const {page}=f;await page.goto(f.origin);await page.locator('#token').fill('fixture-owner');
  await page.getByRole('button',{name:'현재 설정 불러오기',exact:true}).click();
  const sudo=page.getByRole('checkbox',{name:/^sudo 자동승인 허용/}),upload=page.getByRole('checkbox',{name:/^파일 자동업로드 허용/});
  await page.waitForFunction(()=>!document.querySelector('#important-settings fieldset').disabled);
  assert.equal(await sudo.isVisible(),true);assert.equal(await upload.isVisible(),true);
  assert.equal(await page.locator('#command-policy').isVisible(),false);
  assert.equal(await sudo.isChecked(),false);assert.equal(await upload.isChecked(),false);
  assert.equal(await page.locator('#important-settings').evaluate(n=>Boolean(document.querySelector('#overview-section').compareDocumentPosition(n)&Node.DOCUMENT_POSITION_FOLLOWING)&&Boolean(n.compareDocumentPosition(document.querySelector('#command-policy'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
  await sudo.check();assert.equal(await page.locator('#command-policy').isVisible(),true);
  assert.match(await page.locator('#important-settings .policy-message').textContent(),/아직 저장되지/);
  assert.equal(f.posts.filter(p=>p.path==='/api/command-policy').length,0);assert.equal(await save(page).isDisabled(),true);
  await f.checked();await page.getByText(/sudo 자동승인을 켜면/).waitFor();await f.commit();
  let policy=(await f.api('/api/command-policy'));assert.equal(policy.targets[0].automaticSudo,true);
  await page.getByLabel('설정할 서버',{exact:true}).selectOption('beta');assert.equal(await sudo.isChecked(),false);
  await page.getByLabel('설정할 서버',{exact:true}).selectOption('alpha');assert.equal(await sudo.isChecked(),true);
  await sudo.uncheck();await f.checked();await f.commit();assert.equal((await f.api('/api/command-policy')).targets[0].automaticSudo,false);
  await tab(page,'명령 관리').click();await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.POLICY_UX_SCREENSHOTS)await page.screenshot({path:process.env.POLICY_UX_SCREENSHOTS+'/important-settings.png',fullPage:true});
},{multi:true}));

test('model autoapproval is visible beside transfer controls and requires review and OK while preserving the saved threshold', async () => fixture(async f => {
  const current = await f.api('/api/command-policy'), b = current.bindings[0];
  const rule = { targetId: b.targetId, targetRevision: b.targetRevision, profile: b.profile, commands: ['pwd'], deniedCommands: [],
    automaticUploads: false, automaticDownloads: true, automaticSudo: false, externalDisclosure: true, modelExecution: false, fallback: null,
    thresholds: { jev: { model: 'jev-1.14.0', questionVersion: 'ssh-command-risk-v4', basis: 'safety-probability-v1', minLowRisk: 0.51, validationRef: 'fixture:keep-choice' } } };
  await f.seed({ targets: [rule] });
  const { page } = f; await page.goto(f.origin); await page.locator('#token').fill('fixture-owner');
  await page.getByRole('button', { name: '현재 설정 불러오기', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#important-settings fieldset').disabled);
  const model = page.locator('#important-settings').getByRole('checkbox', { name: /^Jev·다른 모델을 통한/ });
  assert.equal(await model.isVisible(), true); assert.equal(await model.isChecked(), false);
  assert.equal(await page.locator('#important-settings input[type=checkbox]').count(), 4);
  const posts = () => f.posts.filter(p => p.path === '/api/command-policy').length, before = posts();
  await model.check();
  await page.waitForURL('**/settings'); assert.equal(await tab(page,'명령 관리').getAttribute('aria-selected'), 'true');
  assert.match(await page.locator('#important-settings .policy-message').textContent(), /AI 평가 자동승인 개별 승인.*아직 저장되지/);
  assert.equal(posts(), before); assert.equal(await save(page).isDisabled(), true);
  await f.checked(); assert.equal(posts(), before); await f.commit();
  let saved = (await f.api('/api/command-policy')).targets[0];
  assert.equal(saved.modelExecution, true); assert.deepEqual(saved.thresholds, rule.thresholds); assert.equal(saved.automaticDownloads, true);
  await model.uncheck(); assert.equal(posts(), before + 1); await f.checked(); await f.commit();
  saved = (await f.api('/api/command-policy')).targets[0]; assert.equal(saved.modelExecution, false);
  assert.deepEqual(saved.commands, ['pwd']); assert.deepEqual(saved.thresholds, rule.thresholds);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}, { width: 320 }));


test('target drafts preserve raw inputs but never reuse review; other-target updates use the newest snapshot', async () => fixture(async f => {
  const {page}=f; await f.open(); const selector=page.getByLabel('설정할 서버',{exact:true});
  await commandTab(page); await names(page).fill('ls\npwd'); const upload=page.getByRole('checkbox',{name:/^파일 자동업로드 허용/}); await upload.check();
  await page.getByRole('checkbox',{name:/^Jev·다른 모델을 통한/}).check();
  await modelTab(page); await page.getByLabel('Jev 자동승인 기준 (%)',{exact:true}).fill('51');
  await f.checked(); await ok(page).check(); await selector.selectOption('beta'); await commandTab(page); await names(page).fill('custom-beta');
  await selector.selectOption('alpha'); assert.equal(await names(page).inputValue(),'ls\npwd'); assert.equal(await upload.isChecked(),true);
  assert.equal(await page.getByLabel('Jev 자동승인 기준 (%)',{exact:true}).inputValue(),'51'); assert.equal(await ok(page).isChecked(),false); assert.equal(await save(page).isDisabled(),true);
  const before=await f.api('/api/command-policy'), b=before.bindings.find(b=>b.targetId==='beta');
  const beta={targetId:b.targetId,targetRevision:b.targetRevision,profile:b.profile,commands:['stat'],deniedCommands:[],externalDisclosure:false,modelExecution:false,fallback:null,thresholds:{}};
  await f.seed({targets:[beta]}); await page.getByRole('button',{name:'서버 설정 다시 불러오기',exact:true}).click();
  await page.getByText(/보존한 초안입니다/).waitFor(); assert.equal(await selector.inputValue(),'alpha'); assert.equal(await names(page).inputValue(),'ls\npwd');
  await f.checked(); const candidate=f.posts.filter(p=>p.path.endsWith('/review')).at(-1).body;
  assert.deepEqual(candidate.policy.targets.find(t=>t.targetId==='beta'),beta); assert.equal(candidate.policy.targets.find(t=>t.targetId==='alpha').thresholds.jev.minLowRisk,0.51);
  assert.notEqual(candidate.expectedRevision,before.revision); assert.equal(f.posts.filter(p=>p.path==='/api/command-policy').length,0);
}, {multi:true}));

test('same-target policy conflicts preserve the old raw draft for copying and require explicit latest start', async () => fixture(async f => {
  const {page}=f; await f.open(); await commandTab(page); await names(page).fill('ls -l\ncustom-check');
  const current=await f.api('/api/command-policy'), b=current.bindings[0];
  const latest={targetId:b.targetId,targetRevision:b.targetRevision,profile:b.profile,commands:['pwd'],deniedCommands:['rm'],externalDisclosure:false,modelExecution:false,fallback:null,thresholds:{}};
  await f.seed({targets:[latest]}); await page.getByRole('button',{name:'서버 설정 다시 불러오기',exact:true}).click();
  await page.getByText(/서버의 정책 또는 연결 정보가 바뀌었습니다/).waitFor();
  assert.equal(await names(page).isDisabled(),true); assert.equal(await review(page).isDisabled(),true);
  await page.getByText('보존한 초안 보기 · 복사 가능',{exact:true}).click(); assert.match(await page.locator('.policy-warning pre').textContent(),/ls -l\ncustom-check/);
  await page.getByRole('button',{name:'최신 설정으로 새 초안 시작',exact:true}).click(); assert.equal(await names(page).isDisabled(),false); assert.equal(await names(page).inputValue(),'pwd');
  assert.match(await page.locator('.policy-warning pre').textContent(),/ls -l\ncustom-check/); assert.equal(await save(page).isDisabled(),true); assert.equal(f.posts.length,0);
}));

test('changed target bindings never silently rebind a preserved draft', async () => fixture(async f => {
  const {page}=f; await f.open(); await commandTab(page); await names(page).fill('ls\ncustom-check');
  await page.route('**/api/command-policy',async route=>{
    if(route.request().method()!=='GET')return route.continue();
    const response=await route.fetch(),body=await response.json(); body.bindings[0].targetRevision+='-changed'; await route.fulfill({response,json:body});
  });
  await page.getByRole('button',{name:'서버 설정 다시 불러오기',exact:true}).click(); await page.getByText(/서버의 정책 또는 연결 정보가 바뀌었습니다/).waitFor();
  assert.equal(await review(page).isDisabled(),true); assert.equal(await names(page).isDisabled(),true); assert.equal(f.posts.length,0);
}));

test('unknown save locks authority edits; failed read stays unknown and matching read reports only current equality', async () => fixture(async f => {
  const {page}=f; await f.open(); await commandTab(page); await names(page).fill('ls'); await f.checked(); await ok(page).check(); let writes=0,failRead=false;
  await page.route('**/api/command-policy',async route=>{
    if(route.request().method()==='POST'){writes++;const response=await route.fetch({headers:{...route.request().headers(),origin:'https://owner.test'}});assert.equal(response.status(),200);failRead=true;return route.abort('failed');}
    if(failRead)return route.abort('failed'); return route.continue();
  });
  await save(page).click(); await page.getByText(/저장 결과를 확인하지 못했습니다/).waitFor();
  assert.equal(await names(page).isDisabled(),true); assert.equal(await review(page).isDisabled(),true); assert.equal(await page.getByLabel('설정할 서버',{exact:true}).isDisabled(),true);
  const status=page.locator('#important-settings .policy-message'); assert.match(await status.textContent(),/이미 적용됐을 수/); assert.doesNotMatch(await status.textContent(),/아직 저장되지/);
  await page.getByRole('button',{name:'현재 적용 설정 확인',exact:true}).click(); await page.getByText(/설정을 불러오지 못했습니다/).waitFor(); assert.equal(await names(page).isDisabled(),true); assert.match(await status.textContent(),/이미 적용됐을 수/);
  failRead=false; await page.getByRole('button',{name:'현재 적용 설정 확인',exact:true}).click(); await page.getByText(/현재 적용값은 요청한 설정과 같습니다/).waitFor();
  assert.equal(await names(page).isDisabled(),false); assert.equal(await names(page).inputValue(),'ls'); assert.equal(await save(page).isDisabled(),true); assert.equal(writes,1);
  assert.deepEqual((await f.api('/api/command-policy')).targets[0].commands,['ls']); assert.equal(f.posts.filter(p=>p.path==='/api/command-policy').length,0);
}));

test('uncommitted unknown save keeps a differing draft; later conflicting current policy is never overwritten', async () => fixture(async f => {
  const {page}=f;await f.open();await commandTab(page); await names(page).fill('custom-check');await f.checked();await ok(page).check();let writes=0;
  await page.route('**/api/command-policy',async route=>{if(route.request().method()==='POST'){writes++;return route.abort('failed');}return route.continue();});
  await save(page).click();await page.getByText(/저장 결과를 확인하지 못했습니다/).waitFor();
  const c=await f.api('/api/command-policy'),b=c.bindings[0];await f.seed({targets:[{targetId:b.targetId,targetRevision:b.targetRevision,profile:b.profile,commands:['pwd'],deniedCommands:[],externalDisclosure:false,modelExecution:false,fallback:null,thresholds:{}}]});
  await page.getByRole('button',{name:'현재 적용 설정 확인',exact:true}).click();await page.getByText(/현재 적용값과 요청한 설정이 다릅니다/).waitFor();
  assert.equal(await names(page).isDisabled(),true);await page.getByText('보존한 초안 보기 · 복사 가능',{exact:true}).click();assert.match(await page.locator('.policy-warning pre').textContent(),/custom-check/);assert.equal(writes,1);
}));

test('selection exposes capability and same-count deltas; 128 names remain filterable and removable on narrow screens', async () => fixture(async f=>{
  const {page}=f;const c=await f.api('/api/command-policy'),b=c.bindings[0];await f.seed({targets:[{targetId:b.targetId,targetRevision:b.targetRevision,profile:b.profile,commands:['ls'],deniedCommands:['rm'],externalDisclosure:false,modelExecution:false,fallback:null,thresholds:{}}]});
  await f.open();await commandTab(page); await names(page).fill('rm');const delta=page.locator('.policy-change-summary');assert.match(await delta.textContent(),/자동승인 명령 추가: rm · 제외: ls/);assert.match(await page.locator('[data-command-name=rm]').textContent(),/차단 우선.*자동승인 목록에도 포함/);
  const list=Array.from({length:128},(_,i)=>'custom-'+String(i).padStart(3,'0'));await commandTab(page); await names(page).fill(list.join('\n'));
  assert.equal(await page.locator('.command-rule').count(),12);
  await page.getByRole('button',{name:'명령 12개 더 보기',exact:true}).click();assert.equal(await page.locator('.command-rule').count(),24);
  const filter=page.getByLabel('명령 검색',{exact:true});await filter.fill('custom-127');await f.checked();await ok(page).check();await commandTab(page);
  await page.getByRole('button',{name:'custom-127 자동승인에서 제외',exact:true}).click();assert.equal(await save(page).isDisabled(),true);assert.equal(await ok(page).isChecked(),false);
  assert.equal((await names(page).inputValue()).split('\n').length,127);assert.equal(await filter.evaluate(n=>n===document.activeElement),true);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await screenshot(page,'command-selection-320');
},{width:320}));

test('hidden advanced errors open their ancestors and expired consent restores keyboard focus',async()=>fixture(async f=>{
  const {page}=f;const c=await f.api('/api/command-policy'),b=c.bindings[0];await f.seed({targets:[{targetId:b.targetId,targetRevision:b.targetRevision,profile:b.profile,commands:['ls'],deniedCommands:[],externalDisclosure:false,modelExecution:false,fallback:null,thresholds:{luna:{model:'custom-luna',questionVersion:'ssh-command-risk-v4',basis:'safety-probability-v1',minLowRisk:0.9,validationRef:'fixture:luna'}}}]});
  await page.clock.install();await f.open();await modelTab(page);const advanced=page.locator('.policy-advanced');await advanced.locator('summary').first().click();const score=page.getByLabel('luna 자동승인 기준 (%)',{exact:true});await modelTab(page); await score.fill('50');await advanced.locator('summary').first().click();
  await reviewTab(page); await review(page).click();assert.equal(await advanced.evaluate(n=>n.open),true);assert.equal(await score.evaluate(n=>n===document.activeElement),true);assert.equal(await score.getAttribute('aria-invalid'),'true');
  await modelTab(page); await score.fill('90');await f.checked();await ok(page).check();await save(page).focus();await page.clock.fastForward(300001);assert.equal(await review(page).evaluate(n=>n===document.activeElement),true);assert.equal(await save(page).isDisabled(),true);
}));

test('late feedback does not steal search focus and search descriptions remain available to accessibility APIs',async()=>fixture(async f=>{
  const {page}=f;await f.open();let entered,release;const started=new Promise(r=>entered=r),held=new Promise(r=>release=r);
  await page.route('**/api/command-policy/review',async route=>{const response=await route.fetch({headers:{...route.request().headers(),origin:'https://owner.test'}});entered();await held;await route.fulfill({response});});
  await reviewTab(page); await review(page).click();await started;const search=page.getByLabel('명령 검색',{exact:true});await commandTab(page); await search.focus();release();await page.locator('#policy-activity').getByText(/OK를/).waitFor();assert.equal(await search.evaluate(n=>n===document.activeElement),true);
  await catalog(page); await search.fill('파일');const first=page.locator('.command-rule button').first();assert.ok(await first.getAttribute('aria-describedby'));const count=await page.locator('.command-rule').count();
  if(await page.getByRole('button',{name:'명령 12개 더 보기',exact:true}).isVisible()){await page.getByRole('button',{name:'명령 12개 더 보기',exact:true}).click();assert.ok(await page.locator('.command-rule').count()>count);}
  assert.equal(await save(page).isDisabled(),true);assert.equal(f.posts.filter(p=>p.path==='/api/command-policy').length,0);
}));


for(const mode of ['commands','approvals'])test('expiration remains announced outside hidden settings without stealing focus '+mode,async()=>fixture(async f=>{
  const {page}=f;await page.clock.install();await f.open();await f.checked();await ok(page).check();
  const focused=mode==='commands'?tab(page,'명령 관리'):page.getByRole('link',{name:'승인',exact:true});await focused.click();
  await page.clock.fastForward(300001);const status=page.locator('#policy-activity');await status.getByText(/확인 결과가 만료됐습니다/).waitFor();
  assert.equal(await status.isVisible(),true);assert.equal(await focused.evaluate(n=>n===document.activeElement),true);assert.equal(await save(page).isDisabled(),true);
  if(mode==='commands')assert.equal(await page.locator('#settings-panel-2').isVisible(),false);else assert.equal(await page.locator('#command-policy').isVisible(),false);
}));

for(const outcome of ['complete','failed'])test('late feedback reports outside collapsed settings and preserves navigation focus '+outcome,async()=>fixture(async f=>{
  const {page}=f;await f.open();let entered,release;const started=new Promise(r=>entered=r),held=new Promise(r=>release=r);
  await page.route('**/api/command-policy/review',async route=>{let response;if(outcome==='complete')response=await route.fetch({headers:{...route.request().headers(),origin:'https://owner.test'}});entered();await held;if(response)await route.fulfill({response});else await route.abort('failed');});
  await reviewTab(page); await review(page).click();await started;const heading=tab(page,'명령 관리');await heading.click();release();
  const status=page.locator('#policy-activity');await status.getByText(outcome==='complete'?/OK를/:/위험도를 확인하지 못했습니다/).waitFor();
  assert.equal(await status.isVisible(),true);assert.equal(await heading.evaluate(n=>n===document.activeElement),true);assert.equal(await page.locator('#settings-panel-2').isVisible(),false);
  assert.equal(f.posts.filter(p=>p.path==='/api/command-policy').length,0);
}));

test('settings workspace tabs preserve one reviewed draft through keyboard navigation without requests', async () => fixture(async f => {
  const {page}=f;await f.open();await names(page).fill('ls\ncustom-health');
  assert.match(await page.locator('.policy-draft-status').textContent(),/미저장 초안/);
  assert.equal(await page.getByRole('tab').count(),3);assert.equal(await page.getByRole('tabpanel').count(),1);
  await f.checked();await ok(page).check();const count=f.posts.length;
  const selected=tab(page,'검토·저장');await selected.focus();await selected.press('ArrowLeft');
  assert.equal(await tab(page,'Jev·모델').getAttribute('aria-selected'),'true');
  assert.equal(await ok(page).isChecked(),true);assert.equal(await save(page).isDisabled(),false);
  await tab(page,'Jev·모델').press('Home');assert.equal(await tab(page,'명령 관리').getAttribute('aria-selected'),'true');
  await tab(page,'명령 관리').press('Enter');assert.equal(f.posts.length,count);
  assert.equal(await names(page).inputValue(),'ls\ncustom-health');
  assert.equal(await page.getByRole('tabpanel').count(),1);assert.equal(await page.locator('#important-settings input[type=checkbox]').count(),4);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
},{width:320}));

test('settings workspace shows saved and draft rule membership and preserves overlapping deny on edits', async () => fixture(async f => {
  const {page}=f,c=await f.api('/api/command-policy'),b=c.bindings[0];
  await f.seed({targets:[{targetId:b.targetId,targetRevision:b.targetRevision,profile:b.profile,commands:['ls','rm'],deniedCommands:['rm'],externalDisclosure:false,modelExecution:false,fallback:null,thresholds:{}}]});await f.open();
  const ls=page.locator('.command-detail'),rm=ls;await page.getByRole('button',{name:'ls 상세 보기',exact:true}).click();
  await ls.getByRole('button',{name:'ls 자동승인에서 제외',exact:true}).click();
  assert.match(await ls.textContent(),/마지막 저장값: 자동승인 목록/);assert.match(await ls.textContent(),/제외 예정/);
  await page.getByRole('button',{name:'rm 상세 보기',exact:true}).click();assert.match(await rm.textContent(),/차단 우선 · 자동승인 목록에도 포함/);
  await rm.getByRole('button',{name:'rm 차단 해제',exact:true}).click();assert.equal(await names(page).inputValue(),'rm');
  assert.equal(await page.getByLabel('항상 차단할 명령',{exact:true}).inputValue(),'');
  assert.match(await rm.textContent(),/마지막 저장값: 차단 우선/);assert.match(await rm.textContent(),/저장할 초안: 자동승인 목록/);
  await rm.getByRole('button',{name:'rm 항상 차단',exact:true}).click();
  assert.equal(await names(page).inputValue(),'rm');assert.equal(await page.getByLabel('항상 차단할 명령',{exact:true}).inputValue(),'rm');
  assert.equal(f.posts.length,0);await f.checked();const p=f.posts.at(-1).body.policy.targets[0];assert.deepEqual(p.commands,['rm']);assert.deepEqual(p.deniedCommands,['rm']);
}));

test('settings workspace direct names and catalog navigation never silently register or normalize raw bulk input', async () => fixture(async f => {
  const {page}=f;await f.open();await names(page).fill('ls -l\nls\nls');await catalog(page);
  await page.getByLabel('명령 검색',{exact:true}).fill('pwd');await choice(page,'pwd').click();
  assert.equal(await names(page).inputValue(),'ls -l\nls\nls\npwd');
  await page.getByText('목록에 없는 명령 직접 추가',{exact:true}).click();
  const name=page.getByLabel('추가할 명령 이름',{exact:true});await name.fill('__proto__');await name.press('Enter');assert.equal(f.posts.length,0);
  await page.getByRole('button',{name:'자동승인 초안에 추가',exact:true}).click();
  assert.match(await names(page).inputValue(),/ls -l\nls\nls\npwd\n__proto__/);
  assert.match(await page.locator('.command-detail').textContent(),/내장 안내 없음/);assert.doesNotMatch(await page.locator('.command-detail').textContent(),/undefined/);
  await reviewTab(page);await review(page).click();assert.equal(await tab(page,'명령 관리').getAttribute('aria-selected'),'true');
  assert.equal(await names(page).evaluate(n=>n===document.activeElement),true);assert.equal(f.posts.length,0);
}));

test('settings workspace hidden model validation opens its tab while retaining command changes', async () => fixture(async f => {
  const {page}=f;await f.open();await names(page).fill('ls\ncustom-health');await page.getByRole('checkbox',{name:/^Jev·다른 모델을 통한/}).check();
  await modelTab(page);const score=page.getByLabel('Jev 자동승인 기준 (%)',{exact:true});await score.fill('50');await commandTab(page);
  await page.getByRole('button',{name:'변경 확인·저장',exact:true}).click();assert.equal(f.posts.length,0);await review(page).click();
  assert.equal(await tab(page,'Jev·모델').getAttribute('aria-selected'),'true');assert.equal(await score.getAttribute('aria-invalid'),'true');
  assert.equal(await score.evaluate(n=>n===document.activeElement),true);assert.equal(await names(page).inputValue(),'ls\ncustom-health');
  assert.equal(f.posts.length,0);
}));

test('settings workspace tab navigation stays available while an unknown save locks all command actions', async () => fixture(async f => {
  const {page}=f;await f.open();await names(page).fill('ls');await f.checked();await ok(page).check();let writes=0;
  await page.route('**/api/command-policy',async route=>{if(route.request().method()==='POST'){writes++;return route.abort('failed');}return route.continue();});
  await save(page).click();await page.locator('#policy-activity').getByText(/저장 결과를 확인하지 못했습니다/).waitFor();
  await tab(page,'명령 관리').click();assert.equal(await names(page).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'ls 자동승인에서 제외',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'명령 찾아 추가',exact:true}).isDisabled(),true);
  await modelTab(page);assert.equal(await page.getByLabel('Jev 모델',{exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'현재 적용 설정 확인',exact:true}).isVisible(),true);
  assert.equal(writes,1);assert.match(await page.locator('.policy-draft-status').textContent(),/적용 미확인/);
}));

for (const width of [1200,320]) test('command master detail separates selection from edits and keeps review '+width,async()=>fixture(async f=>{
  const {page}=f,c=await f.api('/api/command-policy'),b=c.bindings[0];
  await f.seed({targets:[{targetId:b.targetId,targetRevision:b.targetRevision,profile:b.profile,commands:['ls','pwd','rm'],deniedCommands:['rm'],externalDisclosure:false,modelExecution:false,fallback:null,thresholds:{}}]});await f.open();
  const grid=page.locator('.command-grid'),detail=page.getByRole('region',{name:'선택한 명령 상세',exact:true});
  assert.equal(await grid.getByRole('columnheader').count(),3);assert.equal(await grid.locator('[data-command-action]').count(),0);
  await f.checked();await ok(page).check();await tab(page,'명령 관리').click();const before=f.posts.length;
  const selected=page.getByRole('button',{name:'rm 상세 보기',exact:true});await selected.focus();await selected.press('Enter');
  assert.equal(await selected.getAttribute('aria-pressed'),'true');assert.equal(await selected.evaluate(n=>n===document.activeElement),true);
  assert.equal(await grid.locator('[aria-pressed=true]').count(),1);assert.match(await detail.textContent(),/차단이 우선합니다/);
  assert.equal(await ok(page).isChecked(),true);assert.equal(await save(page).isDisabled(),false);assert.equal(f.posts.length,before);
  const positions=await page.evaluate(()=>{const a=document.querySelector('.command-master').getBoundingClientRect(),b=document.querySelector('.command-detail').getBoundingClientRect();return {left:a.x,right:a.right,top:a.y,bx:b.x,by:b.y};});
  if(width===1200)assert.ok(positions.bx>positions.right);else assert.ok(positions.by>positions.top);
  await detail.getByRole('button',{name:'rm 차단 해제',exact:true}).click();
  assert.equal(await page.getByLabel('항상 차단할 명령',{exact:true}).inputValue(),'');assert.equal(await names(page).inputValue(),'ls\npwd\nrm');
  assert.equal(await ok(page).isChecked(),false);assert.equal(await save(page).isDisabled(),true);assert.equal(f.posts.length,before);
  assert.match(await detail.textContent(),/마지막 저장값: 차단 우선/);assert.match(await detail.textContent(),/저장할 초안: 자동승인 목록/);
  await page.getByLabel('명령 검색',{exact:true}).fill('does-not-exist');assert.equal(await grid.locator('tbody tr').count(),0);assert.match(await detail.textContent(),/선택할 명령이 없습니다/);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await screenshot(page,'master-detail-'+width);
},{width}));

for(const width of [1200,320])test('command list scroll keeps headers and selection independent '+width,async()=>fixture(async f=>{
  const {page}=f;await f.open();await names(page).fill(Array.from({length:24},(_,i)=>'custom-'+String(i).padStart(2,'0')).join('\n'));
  const region=page.getByRole('region',{name:'명령 목록 스크롤',exact:true}),table=page.locator('.command-grid');
  assert.equal(await region.getAttribute('tabindex'),'0');
  const before=await region.evaluate(n=>({height:n.clientHeight,total:n.scrollHeight}));assert.ok(before.total>before.height);assert.ok(before.height<=480);
  const raw=await names(page).inputValue(),posts=f.posts.length;
  await region.focus();await region.press('End');
  await page.waitForFunction(()=>document.querySelector('.command-table-scroll').scrollTop>0);
  const position=await region.evaluate(n=>({top:n.getBoundingClientRect().top,head:n.querySelector('th').getBoundingClientRect().top}));assert.ok(Math.abs(position.top-position.head)<3);
  assert.equal(await names(page).inputValue(),raw);assert.equal(f.posts.length,posts);
  await table.getByRole('button',{name:'custom-11 상세 보기',exact:true}).click();assert.match(await page.locator('.command-detail').textContent(),/custom-11/);
  await page.getByRole('button',{name:'명령 12개 더 보기',exact:true}).click();assert.equal(await table.locator('tbody tr').count(),24);
  assert.equal(await names(page).inputValue(),raw);assert.equal(f.posts.length,posts);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await screenshot(page,'command-scroll-'+width);
},{width}));
