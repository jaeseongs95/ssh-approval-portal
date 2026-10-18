import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { classifyCommand } from 'ssh-mcp/build/policy/classifier.js';
import { createApplication } from '../../app.mjs';

const recommended = ['pwd', 'ls', 'stat', 'df', 'du', 'uname', 'uptime', 'whoami', 'id', 'hostname'];
const low = { status: 'assessed', model: 'jev-1.14.0', label: 'low_risk', confidence: 0.7, probabilities: { low_risk: 0.95, high_risk: 0.02, uncertain: 0.03 } };
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
      await page.goto(origin+'/settings'); await page.locator('#token').fill('fixture-owner');
      await page.getByRole('button',{name:'현재 설정 불러오기',exact:true}).click();
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
  assert.equal(await page.getByRole('checkbox', { name: /^Jev·다른 모델을 통한/ }).isChecked(), false);
  assert.equal(await page.getByLabel('Jev 모델', { exact: true }).isVisible(), true);
  assert.equal(await page.getByLabel('Jev 모델', { exact: true }).evaluate(node => node.tagName), 'SELECT');
  assert.equal(await page.getByLabel('Jev 모델', { exact: true }).inputValue(), 'jev-1.14.0');
  assert.equal(await page.getByLabel(/기준 근거 참조/).count(), 0);
  assert.deepEqual((await names(page).inputValue()).split('\n'), recommended);
  assert.equal(await page.getByRole('button', { name: '조회 명령 10개 추가' }).count(), 0);
  assert.equal(f.posts.length, 0); assert.deepEqual((await f.api('/api/command-policy')).targets, []);
  await names(page).fill('ls\nsudo');
  await page.getByLabel('명령 검색', { exact: true }).fill('pwd');
  await page.getByRole('checkbox', { name: 'pwd 선택', exact: true }).check();
  await page.getByRole('checkbox', { name: 'pwd 선택', exact: true }).check();
  assert.deepEqual((await names(page).inputValue()).split('\n'), ['ls', 'sudo', 'pwd']);
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
  const { job } = await f.app.targets.commands.run('ls && pwd'); await f.app.targets.drain();
  assert.equal(f.app.queue.get(job.id).state, 'completed'); assert.equal(f.app.queue.get(job.id).approvalMode, 'automatic');
  await page.getByRole('link',{name:'승인',exact:true}).click();
  await page.locator('#load').click(); await page.locator('[data-request-id="' + job.id + '"] summary').getByText('자동승인', { exact: true }).waitFor();
}, { width }));

test('Jev 90 percent needs no manual reference and persists exactly the reviewed candidate', async () => fixture(async f => {
  const { page } = f; await f.open();
  await page.getByRole('checkbox', { name: /^Jev에 정보 전송/ }).check();
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

for (const mode of ['edit', 'select', 'target']) test('late review cannot authorize a changed draft: ' + mode, async () => fixture(async f => {
  const { page } = f; await f.open(); await names(page).fill('ls');
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/command-policy/review', async route => {
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: 'https://owner.test' } }); entered(); await held; await route.fulfill({ response });
  });
  const response = page.waitForResponse(r => r.url().endsWith('/api/command-policy/review'));
  await review(page).click(); await started;
  if (mode === 'edit') await names(page).fill('pwd');
  else if (mode === 'select') { await page.getByLabel('명령 검색', { exact: true }).fill('grep'); await page.getByRole('checkbox', { name: 'grep 선택', exact: true }).check(); }
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
  await f.checked(); await page.getByText(/종합 위험도 높음/).waitFor();
  assert.equal(await page.locator('.policy-risk').getAttribute('data-level'), 'high_risk');
  assert.equal(await save(page).isDisabled(), true); assert.equal((await f.api('/api/command-policy')).targets.length, 0);
}));

test('command search matches descriptions, preserves review for filters, and selection clears OK', async () => fixture(async f => {
  const {page}=f;await f.open();const search=page.getByLabel('명령 검색',{exact:true});
  await search.fill('프로세스');await page.getByRole('checkbox',{name:'ps 선택',exact:true}).waitFor();
  assert.equal(await page.getByRole('checkbox',{name:'grep 선택',exact:true}).count(),0);
  await search.fill('파일 찾기');await page.getByRole('checkbox',{name:'find 선택',exact:true}).waitFor();
  await search.fill('grep');const choice=page.getByRole('checkbox',{name:'grep 선택',exact:true});await choice.check();
  assert.equal(await choice.evaluate(node=>node===document.activeElement),true);
  assert.equal((await names(page).inputValue()).split('\n').filter(name=>name==='grep').length,1);
  await choice.uncheck();assert.deepEqual((await names(page).inputValue()).split('\n'),recommended);
  await f.checked();await ok(page).check();await search.fill('메모리');
  assert.equal(await save(page).isDisabled(),false);assert.equal(await ok(page).isChecked(),true);
  await search.press('Enter');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(f.posts.filter(item=>item.path==='/api/command-policy').length,0);
  assert.equal(await ok(page).isChecked(),true);assert.equal(await save(page).isDisabled(),false);
  await page.getByRole('checkbox',{name:'free 선택',exact:true}).check();
  assert.equal(await save(page).isDisabled(),true);assert.equal(await ok(page).isChecked(),false);
  await search.fill('not-a-known-command');await page.getByText(/검색 결과가 없습니다/).waitFor();
  assert.equal(f.calls.length,0);assert.equal(f.posts.length,1);
  await search.fill('파일');await screenshot(page,'mobile-search-files');
  await page.setViewportSize({width:1200,height:900});await search.fill('프로세스');await screenshot(page,'desktop-search-processes');
}));

test('search Enter keeps the reviewed draft unsaved until the save button is clicked',async()=>fixture(async f=>{
  await f.open();const {page}=f;await f.checked();await ok(page).check();
  const search=page.getByLabel('명령 검색',{exact:true});await search.fill('grep');await search.press('Enter');
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
  const {page}=f;await f.open();assert.ok(page.url().endsWith('/settings'));await names(page).fill('ls');
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
  await names(page).fill('ls'); await f.checked(); await f.commit();
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
  await page.getByRole('checkbox',{name:/^Jev에 정보 전송/}).check();await page.getByRole('checkbox',{name:/^Jev·다른 모델을 통한/}).check();
  await score.fill('50');await review(page).click();
  const note=page.locator('#'+await score.getAttribute('aria-errormessage'));await note.waitFor();
  assert.match(await note.textContent(),/50%보다 크고/);assert.equal(await score.getAttribute('aria-invalid'),'true');
  assert.equal(await score.evaluate(node=>document.activeElement===node),true);assert.equal(await page.locator('#command-policy>p.error').isVisible(),false);
  await score.fill('90');await f.checked();await ok(page).check();await model.selectOption('jev-1.13.0');
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
  assert.equal(await page.locator('#command-policy').evaluate(n=>n.open),false);
  assert.equal(await sudo.isChecked(),false);assert.equal(await upload.isChecked(),false);
  assert.equal(await page.locator('#important-settings').evaluate(n=>Boolean(document.querySelector('#overview-section').compareDocumentPosition(n)&Node.DOCUMENT_POSITION_FOLLOWING)&&Boolean(n.compareDocumentPosition(document.querySelector('#command-policy'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
  await sudo.check();assert.equal(await page.locator('#command-policy').evaluate(n=>n.open),true);
  assert.match(await page.locator('#important-settings [role=status]').textContent(),/아직 저장되지/);
  assert.equal(f.posts.filter(p=>p.path==='/api/command-policy').length,0);assert.equal(await save(page).isDisabled(),true);
  await f.checked();await page.getByText(/sudo 자동승인을 켜면/).waitFor();await f.commit();
  let policy=(await f.api('/api/command-policy'));assert.equal(policy.targets[0].automaticSudo,true);
  await page.getByLabel('설정할 서버',{exact:true}).selectOption('beta');assert.equal(await sudo.isChecked(),false);
  await page.getByLabel('설정할 서버',{exact:true}).selectOption('alpha');assert.equal(await sudo.isChecked(),true);
  await sudo.uncheck();await f.checked();await f.commit();assert.equal((await f.api('/api/command-policy')).targets[0].automaticSudo,false);
  await page.locator('#command-policy').evaluate(n=>n.open=false);await page.setViewportSize({width:390,height:844});
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
  await page.waitForURL('**/settings'); assert.equal(await names(page).isVisible(), true);
  assert.match(await page.locator('#important-settings [role=status]').textContent(), /AI 평가 자동승인 개별 승인.*아직 저장되지/);
  assert.equal(posts(), before); assert.equal(await save(page).isDisabled(), true);
  await f.checked(); assert.equal(posts(), before); await f.commit();
  let saved = (await f.api('/api/command-policy')).targets[0];
  assert.equal(saved.modelExecution, true); assert.deepEqual(saved.thresholds, rule.thresholds); assert.equal(saved.automaticDownloads, true);
  await model.uncheck(); assert.equal(posts(), before + 1); await f.checked(); await f.commit();
  saved = (await f.api('/api/command-policy')).targets[0]; assert.equal(saved.modelExecution, false);
  assert.deepEqual(saved.commands, ['pwd']); assert.deepEqual(saved.thresholds, rule.thresholds);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}, { width: 320 }));
