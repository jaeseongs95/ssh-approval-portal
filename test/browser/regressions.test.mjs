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
  server.state.beforeRequests=async target=>{if(target==='alpha'){entered();await held;}};
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
