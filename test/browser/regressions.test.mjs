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

test('approval card labels actual automatic approval and removes it for owner approval', async () => browserFixture(async (page, server) => {
  await page.goto(server.origin + '/fixture/card'); await page.waitForFunction(() => window.fixture);
  await page.evaluate(() => window.fixture.receive({ structuredContent: { id: 'automatic-fixture', kind: 'command', state: 'failed',
    command: 'id', target: 'fixture', expiresAt: 2000000000000, approvalMode: 'automatic' }, _meta: { sshApproval: { uiEnabled: true } } }));
  await page.getByText('자동승인', { exact: true }).waitFor();
  assert.equal(await page.locator('#status').textContent(), '실패');
  await page.evaluate(() => window.fixture.receive({ structuredContent: { id: 'owner-fixture', kind: 'command', state: 'completed',
    command: 'id', target: 'fixture', expiresAt: 2000000000000, approvalMode: 'owner' }, _meta: { sshApproval: { uiEnabled: true } } }));
  assert.equal(await page.getByText('자동승인', { exact: true }).count(), 0);
}, 'ko-KR'));

test('card and web show classification and actual review condition before diagnostic numbers', async () => browserFixture(async (page, server) => {
  const decision = { decision: 'review', reasonCode: 'model_review', reviewReason: 'high_risk', decisionRuleVersion: 'command-explanation-v1', provider: 'jev',
    assessment: { model: 'jev-1.14.0', label: 'high_risk', confidence: 0.4, probabilities: { low_risk: 0, high_risk: 0.6, uncertain: 0.4 } }, threshold: { minLowRisk: 0.9 } };
  const value = { id: 'review-fixture', kind: 'command', state: 'pending', command: 'sudo fixture', target: 'fixture', expiresAt: 2000000000000, decision };
  await page.goto(server.origin + '/fixture/card'); await page.waitForFunction(() => window.fixture);
  await page.evaluate(value => window.fixture.receive({ structuredContent: value, _meta: { sshApproval: { uiEnabled: true } } }), value);
  await page.getByText('위험도가 높다는 평가로 사용자 확인이 필요합니다.', { exact: true }).waitFor();
  assert.equal(await page.locator('.assessment-scores dd').nth(1).isVisible(), false);
  await page.getByText('AI 평가 상세', { exact: true }).click();
  await page.getByText('60.0%', { exact: true }).waitFor();
  await page.getByText(/구체적인 위험 사유가 제공되지/).waitFor();
  assert.doesNotMatch(await page.locator('.assessment-details').textContent(), /confidence|command-explanation/);
  server.state.jobs = [value]; await page.goto(server.origin + '/fixture/web');
  await page.getByText('위험도가 높다는 평가로 사용자 확인이 필요합니다.', { exact: true }).waitFor();
  assert.equal(await page.locator('.assessment-scores dd').first().isVisible(), false);
  await page.getByText('AI 평가 상세', { exact: true }).click(); await page.getByText('40.0%', { exact: true }).waitFor();
  server.state.jobs = [{ ...value, decision: { decision: 'review', reasonCode: 'model_review', assessment: decision.assessment, provider: 'jev' } }];
  await page.reload(); await page.getByText('평가 결과에 따른 사용자 확인 필요 · AI 분류: 높은 위험', { exact: true }).waitFor();
  assert.equal(await page.getByText(/못 미쳐/).count(), 0, 'old records cannot claim an unrecorded gate failure');
  for (const [reason, label, message] of [['execution_disabled', 'high_risk', 'Jev 자동승인이 꺼져 있어 사용자 승인이 필요합니다. · AI 분류: 높은 위험'], ['threshold_missing', 'uncertain', '자동승인 기준이 등록되지 않아 사용자 승인이 필요합니다. · AI 분류: 판단 불가']]) {
    const next = { ...value, decision: { ...decision, reviewReason: reason, assessment: { ...decision.assessment, label } } };
    server.state.jobs = [next]; await page.goto(server.origin + '/fixture/web'); await page.getByText(message, { exact: true }).waitFor();
    await page.goto(server.origin + '/fixture/card'); await page.waitForFunction(() => window.fixture);
    await page.evaluate(value => window.fixture.receive({ structuredContent: value, _meta: { sshApproval: { uiEnabled: true } } }), next);
    await page.getByText(message, { exact: true }).waitFor();
  }
  const completed = { ...value, state: 'completed', approvalMode: 'owner' };
  await page.evaluate(value => window.fixture.receive({ structuredContent: value, _meta: { sshApproval: {} } }), completed);
  await page.getByText('사용자가 승인한 요청입니다', { exact: true }).waitFor();
  await page.getByText(/사용자 승인 전 AI 검토/).waitFor();
}, 'ko-KR'));
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

test('server names distinguish installations, remain text, and accompany pending and completed jobs', async () => browserFixture(async (page, server) => {
  const malicious = '<img src=x onerror="window.nameInjected=true">';
  server.state.bridgeDisplayName = malicious; server.state.targetDisplayName = '운영 대상 & SSH';
  server.state.jobs = [job('named-pending'), job('named-done', 'completed')];
  await page.goto(server.origin + '/fixture/web'); await page.locator('#jobs .request').waitFor();
  assert.equal(await page.title(), `${malicious} · 운영 대상 & SSH · SSH approvals`);
  assert.match(await page.locator('#server-identity').textContent(), /Bridge · <img/);
  for (const selector of ['#jobs .target', '#history .target']) {
    const text = await page.locator(selector).textContent();
    assert.ok(text.includes(malicious)); assert.ok(text.includes('Target server · 운영 대상 & SSH')); assert.ok(text.includes('(fixture)'));
  }
  assert.equal(await page.locator('img').count(), 0); assert.equal(await page.evaluate(() => window.nameInjected), undefined);
  server.state.bridgeDisplayName = '운영 중계기'; await page.reload();
  assert.equal(await page.title(), '운영 중계기 · 운영 대상 & SSH · SSH approvals');
}));
test('card identity follows replacement and completed result without HTML injection or stale names', async () => browserFixture(async (page, server) => {
  await page.goto(server.origin + '/fixture/card'); await page.waitForFunction(() => window.fixture);
  const receive = (page, value, meta) => page.evaluate(({value, meta}) => window.fixture.receive({structuredContent:value,_meta:{sshApproval:meta}}), {value,meta});
  const display = {bridgeDisplayName:'시험 <bridge>',targetDisplayName:'운영 & target'};
  await receive(page, job('named-card'), display);
  assert.equal(await page.title(), '시험 <bridge> · 운영 & target · SSH approval and file transfer');
  assert.ok((await page.locator('#details').textContent()).includes('Bridge · 시험 <bridge>'));
  // A metadata-only change must invalidate the old render fingerprint.
  await receive(page, job('named-card'), {...display, bridgeDisplayName:'다른 중계기'});
  assert.ok((await page.title()).startsWith('다른 중계기'));
  await receive(page, job('named-card', 'completed'), {...display, targetDisplayName:'<script>window.nameInjected=true</script>'});
  assert.ok((await page.locator('#details').textContent()).includes('line 0 fixture result'));
  assert.equal(await page.evaluate(() => window.nameInjected), undefined);
  await page.evaluate(() => window.fixture.transfer('/tmp/replacement'));
  assert.equal(await page.locator('.server-identity').count(), 0);
  assert.equal(await page.title(), 'SSH approval and file transfer');
}));

test('multi-target web filter retires a delayed old response and updates visible identity', async () => browserFixture(async (page, server) => {
  server.state.multiTarget = true;
  server.state.jobs = ['alpha','beta'].map(id=>({...job(id+'-request'),targetId:id,targetDisplayName:id+' 이름',targetRevision:id+'-v1',hostKey:'SHA256:'+id}));
  await page.goto(server.origin+'/fixture/web'); await page.locator('#target-filter').waitFor({state:'visible'});
  assert.equal(await page.locator('#jobs .request').count(),2);
  let entered, release; const held=new Promise(resolve=>release=resolve), started=new Promise(resolve=>entered=resolve);
  // The console now requests one global snapshot; filtering is local to that snapshot.
  server.state.beforeRequests=async()=>{entered();await held;};
  await page.selectOption('#target-filter','alpha');await started;
  await page.selectOption('#target-filter','beta');
  assert.ok((await page.title()).includes('beta 이름 [beta]')); assert.equal(await page.locator('#jobs .request').count(),0);
  release();await page.waitForFunction(()=>document.querySelector('#jobs .request')?.dataset.requestId==='beta-request');
  assert.equal(await page.locator('#jobs .request').count(),1);assert.ok((await page.locator('#jobs').textContent()).includes('beta 이름 [beta]'));
}));
test('card target replacement clears selected file and blocks late upload work for the former target', async () => browserFixture(async (page, server) => {
  await page.goto(server.origin+'/fixture/card');await page.waitForFunction(()=>window.fixture);
  await page.evaluate(()=>window.fixture.transfer('/tmp/same','alpha'));
  await page.locator('input[type=file]').setInputFiles({name:'synthetic.bin',mimeType:'application/octet-stream',buffer:Buffer.from([1,2,3,4])});
  await page.evaluate(()=>window.fixture.hold('ui-upload-chunk'));await page.locator('#controls button').click();
  await page.waitForFunction(()=>window.fixture.calls.some(x=>x.name==='ui-upload-chunk'));
  await page.selectOption('#details select','beta');
  await page.waitForFunction(()=>document.title.includes('beta 이름'));
  assert.equal(await page.locator('input[type=file]').evaluate(node=>node.files.length),0);
  await page.evaluate(()=>window.fixture.release('ui-upload-chunk'));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(()=>window.fixture.calls.filter(x=>x.name==='ui-upload-finish').length),0);
  assert.equal(await page.locator('#details select').inputValue(),'beta');
  assert.equal(await page.evaluate(()=>window.fixture.calls.find(x=>x.name==='ui-upload-begin').args.transfer.target),'alpha');
}));

for (const mode of ['beta-success','beta-error','aba-success','aba-error','unchanged']) test(`web download response belongs to its captured selection generation (${mode})`, async () => browserFixture(async (page, server) => {
  server.state.multiTarget = true;server.state.downloadError=mode.endsWith('error');
  server.state.jobs=['alpha','beta'].map(id=>({...job(id+'-file','completed'),kind:'download',operation:{remotePath:'/tmp/same.bin',elevate:false},targetId:id,targetDisplayName:id+' 이름',targetRevision:id+'-v1',hostKey:'SHA256:'+id}));
  await page.goto(server.origin+'/fixture/web');await page.locator('#target-filter').waitFor({state:'visible'});
  await page.selectOption('#target-filter','alpha');await page.waitForFunction(()=>document.querySelector('#history details')?.dataset.requestId==='alpha-file'&&document.querySelector('#history-count').textContent==='1');
  await page.locator('#history details').evaluate(node=>node.open=true);
  let entered, release;const started=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);
  server.state.beforeDownload=async()=>{entered();await held;};
  const reply=page.waitForResponse(response=>response.url().endsWith('/api/alpha-file/download'));
  await page.locator('#history button').click();await started;
  if(mode!=='unchanged') {
    await page.selectOption('#target-filter','beta');
    if(mode.startsWith('aba'))await page.selectOption('#target-filter','alpha');
  }
  release();await(await reply).finished();
  if(mode==='unchanged') {await page.waitForURL('**/fixture/download/alpha-file');assert.equal(await page.textContent('body'),'Synthetic download delivered');}
  else {
    await page.waitForLoadState('networkidle');
    assert.ok(page.url().endsWith('/fixture/web'),'An old selection download must not navigate the replacement view');
    assert.equal(await page.locator('#error').textContent(),'','An old selection error must not be shown in the replacement view');
  }
}));

test('unified console counts all targets, separates running work, sorts across queues and acts on immutable IDs', async () => browserFixture(async (page, server) => {
  server.state.multiTarget = true;
  const on=(id,target,state,createdAt,kind='command')=>({...job(id,state),targetId:target,targetDisplayName:'same name',targetRevision:target+'-v1',hostKey:'SHA256:'+target,createdAt,kind,...(kind==='command'?{}:{operation:{remotePath:'/tmp/same.bin',elevate:false}})});
  // Grouped target queues deliberately arrive out of chronological order.
  server.state.jobs=[on('alpha-old','alpha','pending',10),on('alpha-upload','alpha','pending',30,'upload'),on('alpha-done','alpha','completed',11),on('beta-new','beta','pending',20),on('beta-running','beta','running',40,'download'),on('beta-failed','beta','failed',12)];
  await page.goto(server.origin+'/fixture/web');await page.locator('#server-overview button').first().waitFor();
  assert.equal(await page.locator('#pending-count').textContent(),'3');
  assert.equal(await page.locator('#running-count').textContent(),'1');
  assert.equal(await page.locator('#history-count').textContent(),'2');
  assert.deepEqual(await page.locator('#jobs .request').evaluateAll(nodes=>nodes.map(n=>n.dataset.requestId)),['alpha-upload','beta-new','alpha-old']);
  assert.ok((await page.locator('#server-overview button').first().textContent()).includes('Awaiting approval 3 · Running 1 · Failed 1'));
  assert.ok((await page.locator('#history summary').allTextContents()).every(text=>/same name \[(alpha|beta)\]/.test(text)));
  const beta=page.locator('#server-overview button[data-target-id=beta]');
  await beta.click();await page.waitForFunction(()=>document.querySelector('#pending-count').textContent==='1');
  assert.equal(await beta.getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#jobs .request').getAttribute('data-request-id'),'beta-new');
  assert.ok((await page.locator('#server-overview button').first().textContent()).includes('Awaiting approval 3'),'Server selection must not shrink global counts');
  await page.locator('#jobs button').first().click();await page.waitForFunction(()=>document.querySelector('#running-count').textContent==='2');
  assert.deepEqual(server.state.requests.filter(r=>r.method==='POST'),[{method:'POST',id:'beta-new',action:'approve'}]);
  await page.selectOption('#target-filter','alpha');await page.waitForFunction(()=>document.querySelector('#pending-count').textContent==='2');
  await page.locator('#jobs .request[data-request-id=alpha-upload] button').last().click();
  await page.waitForFunction(()=>document.querySelector('#history-count').textContent==='2');
  assert.equal(server.state.jobs.find(j=>j.id==='alpha-upload').state,'denied');
  assert.equal(server.state.jobs.find(j=>j.id==='alpha-old').state,'pending');
  assert.equal(server.state.jobs.find(j=>j.id==='beta-new').state,'running');
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Console fits a narrow browser without horizontal overflow');
  await page.locator('#logout').click();await page.waitForURL('**/cdn-cgi/access/logout');
}));
