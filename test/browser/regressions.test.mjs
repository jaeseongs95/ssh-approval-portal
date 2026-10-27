import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {launchBrowser} from './browser.mjs';
import { fixtureServer } from './fixture-server.mjs';

const root = resolve(process.env.SOLID_BROWSER_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)));
async function browserFixture(run, locale = 'en-US') {
  const server = await fixtureServer(root);
  let browser;
  try {
    browser = await launchBrowser();
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


async function localLogout(page) {
  const calls = [], observe = request => calls.push({ path: new URL(request.url()).pathname, method: request.method() });
  page.on('request', observe);
  try {
    await page.locator('#logout').click(); await page.waitForURL('**/signed-out');
    assert.equal(calls.filter(call => call.path === '/api/session/logout' && call.method === 'POST').length, 1);
    assert.equal(calls.some(call => ['/cdn-cgi/access/logout', '/oauth2/sign_out'].includes(call.path)), false);
  } finally { page.off('request', observe); }
}

for(const locale of ['ko-KR','en-US'])for(const [width,height]of [[1440,900],[1280,800],[1024,768],[768,1024],[390,844],[320,740],[844,390]])test(`OIDC browser uses cookie login and local logout ${locale} ${width}x${height}`,async()=>browserFixture(async(page,server)=>{
  server.state.oidc=true;server.state.commandAutomation=true;
  const binding={targetId:'default',targetRevision:'a'.repeat(64),profile:'aws-local',displayName:'fixture',enabled:true};
  let policyReads=0;
  await page.route('**/api/command-policy',route=>{policyReads++;return route.fulfill({json:{revision:1,bindings:[binding],targets:[{targetId:binding.targetId,targetRevision:binding.targetRevision,profile:binding.profile,commands:['id'],deniedCommands:[],externalDisclosure:false,modelExecution:false,fallback:null,thresholds:{}}]}});});
  await page.route('**/api/environment',route=>route.fulfill({json:{available:true,revision:'a'.repeat(64),fields:[{key:'BRIDGE_DISPLAY_NAME',label:'중계기 표시 이름',type:'text',value:'fixture'}],readOnlyKeys:[],restart:{state:'idle'}}}));
  await page.setViewportSize({width,height});await page.goto(server.origin+'/settings');
  await page.locator('#connection.connected').waitFor();
  await page.locator('#env-BRIDGE_DISPLAY_NAME').waitFor({state:'attached'});
  await page.waitForFunction(()=>document.querySelector('#important-settings select')?.options.length===1);
  assert.equal(policyReads,1,'SSO settings load without an administrator-token click');
  assert.equal(await page.locator('#token').isVisible(),false);
  assert.equal(await page.locator('#auth-note').textContent(),locale==='ko-KR'?'SSO에서 확인한 본인 계정으로 요청을 처리합니다.':'Manage requests with your owner account verified by SSO.');
  assert.ok(server.state.requests.some(r=>r.method==='GET'&&r.authorization===null));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await localLogout(page);
},locale));

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
  await page.getByText(/구체적인 위험 근거는 제공하지/).waitFor();
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
for (const locale of ['ko-KR', 'en-US']) for (const label of ['low_risk', 'high_risk']) test(`binary assessment shows exactly its two recorded scores ${locale} ${label}`, async () => browserFixture(async (page, server) => {
  const korean = locale === 'ko-KR';
  const value = { id: 'binary-assessment', kind: 'command', state: 'pending', command: 'id', target: 'fixture', expiresAt: 2e12,
    decision: { decision: 'review', reasonCode: 'model_review', provider: 'jev', assessment: { model: 'fixture-model', label, probabilities: { low_risk: 0.23, high_risk: 0.77 } } } };
  for (const surface of ['card', 'web', 'compiled-web']) {
    server.state.compiled = surface === 'compiled-web';
    if (surface === 'card') {
      await page.goto(server.origin + '/fixture/card'); await page.waitForFunction(() => window.fixture);
      await page.evaluate(value => window.fixture.receive({ structuredContent: value, _meta: { sshApproval: {} } }), value);
    } else { server.state.jobs = [value]; await page.goto(server.origin + '/fixture/web'); }
    const summary = page.locator('.assessment-summary');
    assert.ok((await summary.textContent()).includes(korean ? (label === 'low_risk' ? '안전' : '위험') : (label === 'low_risk' ? 'Safe' : 'Risk')));
    await page.getByText(korean ? 'AI 평가 상세' : 'AI assessment details', { exact: true }).click();
    assert.deepEqual(await page.locator('.assessment-scores dt').allTextContents(), korean ? ['안전', '위험'] : ['Safe', 'Risk']);
    assert.deepEqual(await page.locator('.assessment-scores dd').allTextContents(), ['23.0%', '77.0%']);
  }
  assert.equal(server.state.requests.filter(item => item.method === 'POST').length, 0);
}, locale));
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
  // Freeze before navigation so setup actions cannot consume part of the polling interval.
  await page.clock.install({time:new Date('2026-01-01T00:00:00Z')}); await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z')); await page.goto(server.origin + '/fixture/web'); await page.locator('#jobs .actions button').first().waitFor(); await page.locator('[href="/history"]').click();
  await page.evaluate(() => {
    const pending = document.querySelector('#jobs .request'), history = document.querySelector('#history details'), output = history.querySelector('.output');
    history.open = true; output.scrollTop = 120;
    const button = history.querySelector('summary'); button.focus();
    const range = document.createRange(); range.setStart(output.firstChild, 0); range.setEnd(output.firstChild, 12); getSelection().removeAllRanges(); getSelection().addRange(range);
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
  await localLogout(page);
  assert.match(await page.textContent('body'), /Administrator signed out/);
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
  // The filter becomes visible before the asynchronous initial snapshot finishes rendering.
  await page.waitForFunction(()=>document.querySelectorAll('#jobs .request').length===2);
  assert.equal(await page.locator('#jobs .request').count(),2);
  let entered, release; const held=new Promise(resolve=>release=resolve), started=new Promise(resolve=>entered=resolve);
  // The console now requests one global snapshot; filtering is local to that snapshot.
  server.state.beforeRequests=async()=>{entered();await held;};
  await page.selectOption('#target-filter','alpha');await started;
  await page.selectOption('#target-filter','beta');
  assert.ok((await page.title()).includes('beta 이름 [beta]')); assert.equal(await page.locator('#jobs .request').count(),1);
  assert.equal(await page.locator('#jobs .request').getAttribute('data-request-id'),'beta-request','cached snapshot is filtered immediately while the next read is pending');
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
  await page.goto(server.origin+'/history');await page.locator('#target-filter').waitFor({state:'visible'});
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
    assert.ok(page.url().endsWith('/history'),'An old selection download must not navigate the replacement view');
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
  const counts=await page.locator('#server-overview button').first().textContent();
  for(const expected of ['Retained 6','Awaiting approval 3','Assessing 0','Running 1','Completed 1','Failed 1'])assert.ok(counts.includes(expected));
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
  await localLogout(page);
}));

test('approved history keeps historical scores and threshold while explaining the completed owner action in past tense', async () => browserFixture(async (page, server) => {
  const context = '테스트 서버 조회. 변경·재시작 없음. <script>window.contextInjected=true</script>';
  const value = { id: 'approved-context-fixture', kind: 'command', state: 'completed', approvalMode: 'owner', command: 'sudo id', operation: { kind: 'command', command: 'sudo id', context }, target: 'fixture', expiresAt: 2000000000000,
    decision: { decision: 'review', reasonCode: 'model_review', reviewReason: 'uncertain', decisionRuleVersion: 'command-explanation-v1', provider: 'jev', evaluation: { callerContextProvided: true },
      assessment: { model: 'jev-1.14.0', questionVersion: 'ssh-command-risk-v4', label: 'uncertain', confidence: 0.505, probabilities: { low_risk: 0.01, high_risk: 0.32, uncertain: 0.67 } }, threshold: { minLowRisk: 0.51 } } };
  server.state.jobs = [value];
  await page.goto(server.origin + '/history');
  await page.locator('#history > details').evaluate(node => node.open = true);
  await page.getByText('사용자가 승인한 요청입니다', { exact: true }).waitFor();
  await page.getByText('당시 자동승인을 보류했고, 사용자가 직접 승인해 진행한 요청입니다.', { exact: true }).waitFor();
  await page.getByText('AI 평가 상세', { exact: true }).click();
  await page.getByText('당시 보류 사유: AI가 위험도를 판단하지 못했습니다.', { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator('#history').textContent(), /사용자 확인이 필요합니다/);
  assert.match(await page.locator('.assessment-details').textContent(), /51.0% 이상/);
  assert.deepEqual(await page.locator('.assessment-scores dt').allTextContents(), ['낮은 위험', '높은 위험', '판단 불가']);
  assert.deepEqual(await page.locator('.assessment-scores dd').allTextContents(), ['1.0%', '32.0%', '67.0%']);
  assert.ok((await page.locator('.assessment-details').textContent()).includes(context));
  assert.equal(await page.evaluate(() => window.contextInjected), undefined);
  await page.goto(server.origin + '/fixture/card'); await page.waitForFunction(() => window.fixture);
  await page.evaluate(value => window.fixture.receive({ structuredContent: value, _meta: { sshApproval: {} } }), value);
  await page.getByText('당시 자동승인을 보류했고, 사용자가 직접 승인해 진행한 요청입니다.', { exact: true }).waitFor();
  await page.getByText('AI 평가 상세', { exact: true }).click();
  await page.getByText('당시 보류 사유: AI가 위험도를 판단하지 못했습니다.', { exact: true }).waitFor();
  assert.deepEqual(await page.locator('.assessment-scores dt').allTextContents(), ['낮은 위험', '높은 위험', '판단 불가']);
  assert.deepEqual(await page.locator('.assessment-scores dd').allTextContents(), ['1.0%', '32.0%', '67.0%']);
  server.state.compiled = true; await page.goto(server.origin + '/history');
  await page.locator('#history > details').evaluate(node => node.open = true);
  await page.getByText('AI 평가 상세', { exact: true }).click();
  assert.deepEqual(await page.locator('.assessment-scores dt').allTextContents(), ['낮은 위험', '높은 위험', '판단 불가']);
  assert.deepEqual(await page.locator('.assessment-scores dd').allTextContents(), ['1.0%', '32.0%', '67.0%']);
}, 'ko-KR'));

test('long history uses a full-width page of 20 and preserves expanded records across pages and polling',async()=>browserFixture(async(page,server)=>{
  server.state.multiTarget=true;
  server.state.jobs=Array.from({length:45},(_,i)=>({...job('history-'+i,'completed'),createdAt:100-i,targetId:i%2?'alpha':'beta'}));
  server.state.jobs.push({...job('evaluating-now','evaluating'),createdAt:200},{...job('running-now','running'),createdAt:201});
  await page.goto(server.origin+'/history');await page.locator('#history details').first().waitFor();
  assert.equal(await page.locator('#history details').count(),20);assert.equal(await page.locator('#history-count').textContent(),'45');
  const counts=await page.locator('#server-overview button').first().textContent();assert.match(counts,/Retained 47/);assert.match(counts,/Assessing 1/);assert.match(counts,/Running 1/);
  const first=page.locator('#history details').first();await first.locator('summary').click();await first.evaluate(n=>window.savedHistory=n);
  await page.locator('#history-pagination').getByRole('button',{name:'Next',exact:true}).click();assert.equal(await page.locator('#history details').first().getAttribute('data-request-id'),'history-20');
  await page.locator('#history-pagination').getByRole('button',{name:'Previous',exact:true}).click();assert.equal(await first.evaluate(n=>n===window.savedHistory&&n.open),true);
  await page.locator('#load').click();assert.equal(await first.evaluate(n=>n===window.savedHistory&&n.open),true);
  assert.ok(await page.locator('#history').evaluate(n=>n.getBoundingClientRect().width>document.querySelector('.grid').getBoundingClientRect().width*.95));
  if(process.env.FOLLOWUP_SCREENSHOTS)await page.screenshot({path:process.env.FOLLOWUP_SCREENSHOTS+'/history-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
}));

test('prepared download card distinguishes server readiness from local receipt and opens authenticated browser save',async()=>browserFixture(async(page,server)=>{
  await page.goto(server.origin+'/fixture/card');await page.waitForFunction(()=>window.fixture);
  await page.evaluate(()=>window.fixture.receive({structuredContent:{id:'download-ready',kind:'download',state:'completed',target:'fixture',expiresAt:2e12,operation:{remotePath:'/tmp/fixture.txt',elevate:false},result:{structuredContent:{fileName:'fixture.txt',size:0}}},_meta:{sshApproval:{uiEnabled:true,viewTicket:'synthetic-view',namespace:'fixture_',downloadRequiresLogin:true}}}));
  assert.equal(await page.locator('#status').textContent(),'서버 파일 준비 완료');await page.getByText(/아직 PC 저장이나 에이전트 수신/).waitFor();
  await page.getByRole('button',{name:'브라우저에서 파일 저장',exact:true}).click();await page.getByText(/브라우저에서 로그인 후/).waitFor();
  assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.name==='host-open-link').length),1);
  assert.equal(await page.evaluate(()=>JSON.stringify(fixture.contexts).includes('synthetic-download-ticket')),false);
},'ko-KR'));

for (const [locale, korean] of [['ko-KR', true], ['en-US', false]]) test(`recorded approval display separates admission, policy and AI history (${locale})`, async () => browserFixture(async (page, server) => {
  const automatic = korean ? '자동승인' : 'Automatically approved';
  const owner = korean ? '사용자가 승인한 요청입니다' : 'Approved by the owner';
  const missing = korean ? '승인 방식 미확인' : 'Approval route not recorded';
  const waiting = korean ? '승인 대기' : 'Awaiting approval';
  const aiNote = korean ? '사용자 승인 전 AI 검토' : 'recorded before owner approval';
  const cases = [
    { id: 'download-automatic', state: 'completed', approvalMode: 'automatic', reasonCode: 'download_policy', title: automatic, noReview: true },
    { id: 'upload-admission-not-started', kind: 'upload', state: 'pending', reasonCode: 'upload_policy', title: waiting, noReview: true },
    { id: 'download-admission-not-started', state: 'pending', reasonCode: 'download_policy', title: waiting, noReview: true },
    { id: 'legacy-route-missing', state: 'completed', reasonCode: 'future_reason', title: missing, noReview: true },
    { id: 'owner-file-no-ai', state: 'completed', approvalMode: 'owner', reasonCode: 'download_policy', title: owner, noReview: true },
    { id: 'future-reason', state: 'running', approvalMode: 'automatic', reasonCode: 'future_reason', title: automatic, noReview: true },
    { id: 'interrupted', state: 'unknown', approvalMode: 'automatic', reasonCode: 'download_policy', title: automatic, noReview: true },
    { id: 'inconsistent-pending-mode', state: 'pending', approvalMode: 'automatic', reasonCode: 'download_policy', title: waiting, noReview: true },
    { id: 'expired-owner-mode', state: 'expired', approvalMode: 'owner', reasonCode: 'download_policy', title: korean ? '승인 기한 만료' : 'Approval expired', noReview: true },
    { id: 'completed-audit-error', state: 'completed', approvalMode: 'automatic', reasonCode: 'download_policy', title: automatic, auditError: 'synthetic audit record error', noReview: true },
    { id: 'owner-review-is-history', kind: 'command', state: 'completed', approvalMode: 'owner', reasonCode: 'model_review', decision: 'review', title: owner, assessment: { model: 'fixture-model', label: 'uncertain', probabilities: { low_risk: 0.01, high_risk: 0.32, uncertain: 0.67 } } },
  ];
  for (const item of cases) {
    const { title, noReview, ...fields } = item;
    const value = { kind: 'download', target: 'fixture', command: 'fixture command', expiresAt: 2000000000000, createdAt: 1900000000000,
      operation: { remotePath: '/tmp/fixture.bin', elevate: false }, ...fields,
      decision: { decision: item.decision ?? 'execute', reasonCode: item.reasonCode, ...(item.assessment ? { assessment: item.assessment } : {}) } };
    for (const surface of ['card', 'web']) {
      if (surface === 'card') {
        await page.goto(server.origin + '/fixture/card'); await page.waitForFunction(() => window.fixture);
        await page.evaluate(value => window.fixture.receive({ structuredContent: value, _meta: { sshApproval: { uiEnabled: true } } }), value);
      } else { server.state.jobs = [value]; await page.goto(server.origin + '/fixture/web'); }
      const summary = page.locator('.assessment-summary');
      assert.equal(await summary.locator('strong').textContent(), title, item.id + '/' + surface);
      const text = await summary.textContent();
      if (noReview) assert.doesNotMatch(text, /사용자 확인 필요|사용자 승인이 필요|Owner review required|owner approval is required/i, item.id + '/' + surface);
      if (!item.assessment) assert.ok(!text.includes(aiNote), 'no invented AI assessment: ' + item.id + '/' + surface);
      else assert.ok(text.includes(aiNote), 'recorded assessment remains historical');
      assert.equal(await page.locator('.automatic-approval').count(), item.title === automatic ? 1 : 0, 'actual approval badge: ' + item.id + '/' + surface);
      if (item.reasonCode === 'download_policy' && item.state === 'completed') assert.match(text, korean ? /파일 자동다운로드/ : /File download allowed/);
      if (item.auditError) assert.ok((await page.locator('body').textContent()).includes(item.auditError), 'audit failure must not replace completion');
    }
  }
}, locale));

for (const locale of ['ko-KR', 'en-US']) test('owner and assessment details select localized context without mixing evaluator prose ' + locale, async () => browserFixture(async (page, server) => {
  const context = 'Inspect the synthetic test identity; no mutation. English evaluator description.';
  const displayContext = '테스트 실행 계정 조회. 변경 없음. <script>window.localizedInjected=true</script>';
  const value = { id: 'language-pair-fixture', kind: 'command', state: 'completed', approvalMode: 'owner', command: 'sudo id',
    operation: { kind: 'command', command: 'sudo id', context, displayContext }, target: 'fixture', expiresAt: 2e12,
    decision: { decision: 'review', reasonCode: 'model_review', reviewReason: 'uncertain', provider: 'jev', evaluation: { callerContextProvided: true },
      assessment: { model: 'jev-1.14.0', label: 'uncertain', confidence: 1, probabilities: { low_risk: 0, high_risk: 0, uncertain: 1 } } } };
  const expected = locale === 'ko-KR' ? displayContext : context, excluded = locale === 'ko-KR' ? context : displayContext;
  server.state.jobs = [value]; await page.goto(server.origin + '/history');
  await page.locator('#history > details').evaluate(n => n.open = true);
  assert.ok((await page.locator('#history').textContent()).includes(expected));
  assert.ok(!(await page.locator('#history').textContent()).includes(excluded));
  await page.getByText(locale === 'ko-KR' ? 'AI 평가 상세' : 'AI assessment details', { exact: true }).click();
  assert.ok((await page.locator('.assessment-details').textContent()).includes(expected));
  assert.equal(await page.evaluate(() => window.localizedInjected), undefined);
  await page.goto(server.origin + '/fixture/card'); await page.waitForFunction(() => window.fixture);
  await page.evaluate(value => window.fixture.receive({ structuredContent: value, _meta: { sshApproval: {} } }), value);
  assert.ok((await page.locator('body').textContent()).includes(expected));
  assert.ok(!(await page.locator('body').textContent()).includes(excluded));
  assert.equal(await page.evaluate(() => window.localizedInjected), undefined);
}, locale));

for (const locale of ['ko-KR', 'en-US']) test('JEV failure details distinguish unavailable from uncertain ' + locale, async () => browserFixture(async (page, server) => {
  const korean = locale === 'ko-KR';
  const value = { id: 'evaluation-unavailable-fixture', kind: 'command', state: 'pending', command: 'id', target: 'fixture', expiresAt: 2000000000000,
    decision: { decision: 'review', reasonCode: 'evaluation_unavailable', attempts: [
      { provider: 'untrusted-provider-sentinel', status: 'unavailable', reason: 'evaluation_failed', failureReason: 'invalid_response', diagnostic: 'PROBABILITY_SUM', raw: '<img src=x onerror=alert(1)>private-sentinel', error: 'private-error-sentinel', context: 'private-context-sentinel', model: 'private-model-sentinel', response: 'private-response-sentinel' },
      { provider: 'untrusted-provider-sentinel', status: 'unavailable', reason: 'not_configured', diagnostic: 'private-diagnostic-sentinel' },
      { status: 'unavailable', failureReason: 'timeout' }, { status: 'unavailable', failureReason: 'busy' },
      { status: 'unavailable', reason: { toString: 'private-sentinel' }, diagnostic: 'private-diagnostic-sentinel' },
    ] } };
  for (const surface of ['card', 'web', 'compiled-web']) {
    server.state.compiled = surface === 'compiled-web';
    if (surface === 'card') { await page.goto(server.origin + '/fixture/card'); await page.waitForFunction(() => window.fixture); await page.evaluate(value => window.fixture.receive({ structuredContent: value, _meta: { sshApproval: { uiEnabled: true } } }), value); }
    else { server.state.jobs = [value]; await page.goto(server.origin + '/fixture/web'); await page.locator('.assessment-summary').waitFor(); }
    const detail = page.locator('.assessment-failure-details');
    assert.equal(await detail.count(), 1, 'stored evaluator failures must be visible in both surfaces');
    assert.equal(await detail.getAttribute('open'), null, 'failure details start collapsed');
    await detail.locator('summary').click();
    const text = await detail.textContent();
    assert.match(text, /PROBABILITY_SUM/);
    assert.match(text, korean ? /응답 형식/ : /response format/);
    assert.match(text, korean ? /설정/ : /configured/);
    assert.match(text, korean ? /대기 시간/ : /timed out/);
    assert.match(text, korean ? /진행 중/ : /in progress/);
    assert.doesNotMatch(text, /private-|untrusted-provider|onerror/);
    assert.equal(await page.locator('.assessment-scores').count(), 0);
    assert.equal(await page.locator('.assessment-failure-details img').count(), 0);
  }
  const uncertain = { ...value, decision: { decision: 'review', reasonCode: 'model_review', reviewReason: 'uncertain', decisionRuleVersion: 'command-explanation-v1', assessment: { model: 'fixture-model', label: 'uncertain', probabilities: { low_risk: 0.01, high_risk: 0.23, uncertain: 0.76 } }, attempts: [] } };
  server.state.jobs = [uncertain]; await page.goto(server.origin + '/fixture/web');
  await page.getByText(korean ? '안전 여부를 판단하지 못해 사용자 확인이 필요합니다.' : 'The assessment is uncertain; owner review is required.', { exact: true }).waitFor();
  assert.equal(await page.locator('.assessment-failure-details').count(), 0, 'valid uncertainty must not be called an evaluator failure');
  assert.equal(await page.locator('.assessment-scores dd').count(), 3);
  assert.equal(server.state.requests.filter(item => item.method === 'POST').length, 0, 'rendering never approves or retries');
}, locale));
