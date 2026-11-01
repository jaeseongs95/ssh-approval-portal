import test from 'node:test';
import { permissionsTab, cliTab, openRequest, selectServer } from './admin-ui.mjs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { fixtureServer } from './fixture-server.mjs';
import { launchBrowser } from './browser.mjs';

const revision = 'b'.repeat(64);
const capabilities = windows => ({ commandShell: windows ? 'windows-powershell-5.1' : 'posix', fileTransfer: true,
  elevatedFileTransfer: true, pythonSource: true, agentCli: true, commandNameApproval: true });
const targets = ['windows', 'linux'].map(id => ({ id, displayName: id + ' 시험 서버', enabled: true, platform: id, capabilities: capabilities(id === 'windows') }));
const bindings = targets.map(target => ({ targetId: target.id, targetRevision: revision, profile: target.id + '-write',
  displayName: target.displayName, enabled: true, platform: target.platform, capabilities: target.capabilities,
  sshTarget: 'portal-user@' + target.id + '.example', supported: target.capabilities.agentCli }));

async function fixture(run, { pythonConfigured = true, cliSupported = true } = {}) {
  const server = await fixtureServer(fileURLToPath(new URL('../../', import.meta.url)));
  const currentTargets = structuredClone(targets), currentBindings = structuredClone(bindings);
  currentTargets[0].capabilities.pythonSource = currentBindings[0].capabilities.pythonSource = pythonConfigured;
  currentBindings[0].supported = cliSupported;
  server.state.commandAutomation = server.state.multiTarget = true;
  server.state.targets = currentTargets;
  server.state.jobs = targets.map((target, index) => ({ id: String(index + 1).repeat(48), kind: 'command', state: 'completed',
    createdAt: Date.now(), finishedAt: Date.now(), command: index ? 'pwd' : 'WHOAMI.EXE', targetId: target.id,
    targetRevision: revision, targetDisplayName: target.displayName, profile: target.id + '-write', target: bindings[index].sshTarget }));
  const cliCalls = [], policyPosts = [];
  server.state.agentCli = async (request, response, url) => {
    cliCalls.push(url.pathname);
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname.endsWith('/login-status')) {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); response.end(JSON.stringify({ binding: currentBindings.find(b => b.targetId === body.targetId), provider: body.provider, checkedAt: Date.now(), state: 'signed_out' }));
    } else response.end(JSON.stringify({ available: true, bindings: currentBindings, providers: [{ id: 'codex' }, { id: 'claude' }] }));
  };
  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ locale: 'ko-KR', viewport: { width: 390, height: 844 } });
    let snapshot = { revision: 0, targets: [], bindings: currentBindings, testServerAvailable: true, evaluators: {} };
    await context.route('**/api/command-policy**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() === 'GET') return route.fulfill({ json: snapshot });
      const body = request.postDataJSON(); policyPosts.push({ path, body });
      if (path.endsWith('/review')) return route.fulfill({ json: { notice: '', feedback: [], reviewToken: 'fixture-review', expiresAt: Date.now() + 300000 } });
      snapshot = { ...snapshot, revision: snapshot.revision + 1, targets: body.policy.targets };
      return route.fulfill({ json: snapshot });
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    await run({ page, origin: server.origin, cliCalls, policyPosts });
  } finally { await browser?.close(); await server.close(); }
}

test('Windows 기능 정보를 따라 이름·권한·Python·CLI를 제공하고 Linux 초안을 보존한다', async () => fixture(async ({ page, origin, cliCalls, policyPosts }) => {
  await page.goto(origin + '/settings'); await selectServer(page,'windows'); await permissionsTab(page);
  const target = page.getByLabel('편집 대상 서버', { exact: true });
  await page.locator('#policy-platform-notice').waitFor({ state: 'visible' });
  assert.equal(await target.inputValue(), 'windows');
  assert.match(await target.locator('option:checked').textContent(), /Windows/);
  assert.equal(await page.getByRole('checkbox', { name: /^관리자 권한 작업/ , includeHidden:true}).isEnabled(), true);
  assert.equal(await page.getByRole('checkbox', { name: /^제출한 Python 코드/ , includeHidden:true}).isEnabled(), true);
  for (const name of [/^파일 자동업로드/, /^파일 자동다운로드/, /^Jev·다른 모델을 통한/, /^테스트 서버/]) {
    assert.equal(await page.getByRole('checkbox', { name , includeHidden:true}).isEnabled(), true);
  }
  await page.getByRole('tab', { name: '명령 관리', exact: true }).click();
  await page.locator('.command-bulk summary').click();
  const names = page.getByLabel('자동승인할 명령', { exact: true });
  assert.equal(await names.isVisible(), true); assert.equal(await names.inputValue(), '');
  await names.fill('WHOAMI.EXE\nMicrosoft.PowerShell.Management\\Get-Location\nC:\\Tools\\tool.exe');
  const uploadExplanation = page.getByRole('checkbox', { name: /^파일 자동업로드/ , includeHidden:true}).locator('..');
  assert.match(await uploadExplanation.textContent(), /대상의 파일 전송 제한과 SSH 계정 권한/);
  assert.doesNotMatch(await uploadExplanation.textContent(), /폴더 제한 없이/);
  await permissionsTab(page); await page.getByRole('checkbox', { name: /^파일 자동업로드/ , includeHidden:true}).check();
  await target.selectOption('linux');
  assert.match(await uploadExplanation.textContent(), /폴더 제한 없이 SSH 계정이 쓸 수 있는 경로/);
  assert.equal(await page.getByRole('checkbox', { name: /^sudo 자동승인/ , includeHidden:true}).isEnabled(), true);
  assert.equal(await page.getByRole('checkbox', { name: /^제출한 Python 코드/ , includeHidden:true}).isEnabled(), true);
  assert.equal(await page.getByRole('checkbox', { name: /^파일 자동업로드/ , includeHidden:true}).isChecked(), false);
  assert.match(await names.inputValue(), /pwd/);
  await target.selectOption('windows');
  assert.doesNotMatch(await uploadExplanation.textContent(), /폴더 제한 없이/);
  assert.equal(await page.getByRole('checkbox', { name: /^파일 자동업로드/ , includeHidden:true}).isChecked(), true);
  assert.match(await names.inputValue(), /WHOAMI.EXE/);
  await page.getByRole('tab', { name: '검토·저장', exact: true }).click();
  await page.getByRole('button', { name: '이 설정으로 위험도 확인', exact: true }).click();
  await page.getByRole('checkbox', { name: /^위험도와 변경 내용을 확인했고/ , includeHidden:true}).waitFor({ state: 'visible' });
  const candidate = policyPosts[0].body.policy.targets[0];
  assert.equal(candidate.targetId, 'windows'); assert.equal(candidate.platform, 'windows');
  assert.deepEqual(candidate.commands, ['whoami.exe', 'microsoft.powershell.management\\get-location', 'c:\\tools\\tool.exe']); assert.deepEqual(candidate.deniedCommands, []);
  assert.equal(candidate.automaticUploads, true); assert.equal(candidate.automaticSudo, undefined); assert.equal(candidate.sourceExecutionContract, undefined);
  await cliTab(page); await page.locator('#server-target option[value=windows]').waitFor({ state: 'attached' });
  await page.locator('#server-target').selectOption('windows');
  for (const id of ['cli-inspect', 'cli-login-check', 'cli-recover']) assert.equal(await page.locator('#' + id).isEnabled(), true);
  assert.equal(await page.locator('#cli-login').isVisible(), true);
  assert.match(await page.locator('#cli-login pre').textContent(), /current.json/);
  assert.doesNotMatch(await page.locator('#cli-login pre').textContent(), /sudo|\/opt\//);
  assert.deepEqual(cliCalls, ['/api/agent-cli']);
  await page.locator('#cli-login-check').click();
  await page.locator('#cli-login-state').getByText(/로그인 안 됨/).waitFor();
  assert.deepEqual(cliCalls, ['/api/agent-cli', '/api/agent-cli/login-status']);
  await page.locator('#server-target').selectOption('linux');
  assert.equal(await page.locator('#cli-inspect').isEnabled(), true);
  assert.equal(await page.locator('#cli-login-check').isEnabled(), true);
  assert.equal(await page.locator('#cli-login').isVisible(), true);
}));

test('대상 개요에 운영체제를 표시하고 Windows 이력의 명령 이름 등록을 제공한다', async () => fixture(async ({ page, origin }) => {
  let release,entered;const held=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  await page.route('**/api/agent-cli',async route=>{entered();await held;await route.continue().catch(()=>{});});
  try {
  await page.goto(origin + '/history');
  await page.locator('#target-filter option[value=windows]').waitFor({ state: 'attached' });
  await page.locator('[data-request-id]').first().waitFor();await page.locator('#server-target option[value=windows]').waitFor({state:'attached'});
  assert.match(await page.locator('.server-card[data-target-id=windows]').textContent(), /Windows/);
  assert.match(await page.locator('.server-card[data-target-id=linux]').textContent(), /Linux/);
  const windows = page.locator('[data-request-id="' + '1'.repeat(48) + '"]');
  const linux = page.locator('[data-request-id="' + '2'.repeat(48) + '"]');
  await openRequest(page, '1'.repeat(48));
  assert.equal(await page.locator('#request-detail-body').getByRole('button', { name: '이력의 명령 이름 등록', exact: true }).count(), 1);
  await openRequest(page, '2'.repeat(48));
  assert.equal(await page.locator('#request-detail-body').getByRole('button', { name: '이력의 명령 이름 등록', exact: true }).count(), 1);
  await openRequest(page, '1'.repeat(48));
  const policyRead=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/command-policy'&&response.request().method()==='GET');
  await page.locator('#request-detail-body').getByRole('button', { name: '이력의 명령 이름 등록', exact: true }).click();
  await started;await (await policyRead).finished();
  const candidate = page.locator('.command-import').getByRole('checkbox', { name: 'whoami.exe', exact: true , includeHidden:true});
  assert.equal(await candidate.count(),0,'초기 CLI 연결을 확인하기 전에는 가져오기를 확정하지 않는다');release();
  await candidate.waitFor({ state: 'visible' }); assert.equal(await candidate.isChecked(), false);
  assert.equal(await page.locator('#server-target').inputValue(),'windows');
  } finally {release();}
}));

test('Python 경로가 없거나 CLI가 지원되지 않으면 해당 기능만 비활성화한다', async () => fixture(async ({ page, origin, cliCalls }) => {
  await page.goto(origin + '/settings'); await selectServer(page,'windows'); await permissionsTab(page); await page.locator('#policy-platform-notice').waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('checkbox', { name: /^제출한 Python 코드/ , includeHidden:true}).isDisabled(), true);
  assert.match(await page.locator('#important-settings').textContent(), /Python 실행 파일 절대 경로를 등록/);
  assert.equal(await page.getByRole('checkbox', { name: /^관리자 권한 작업/ , includeHidden:true}).isEnabled(), true);
  await cliTab(page); await page.locator('#server-target option[value=windows]').waitFor({ state: 'attached' }); await page.locator('#server-target').selectOption('windows');
  assert.equal(await page.locator('#cli-inspect').isDisabled(), true);
  assert.equal(await page.locator('#cli-login-check').isDisabled(), true);
  assert.deepEqual(cliCalls, ['/api/agent-cli']);
}, { pythonConfigured: false, cliSupported: false }));

test('Windows 이름 가져오기는 리터럴만 추출하고 동적 호출은 전체를 거부한다', async () => fixture(async ({ page, origin }) => {
  await page.goto(origin + '/settings'); await selectServer(page,'windows'); await permissionsTab(page); await page.locator('#policy-platform-notice').waitFor({ state: 'visible' });
  const results = await page.evaluate(async () => {
    const { parseCommandImport } = await import('/web/src/command-line-import.js');
    return [parseCommandImport('WHOAMI.EXE; Microsoft.PowerShell.Management\\Get-Location', 'windows'),
      parseCommandImport('WHOAMI.EXE; & $command', 'windows'), parseCommandImport('Get-Location', 'windows')];
  });
  assert.deepEqual(results[0], { complete: true, names: ['whoami.exe', 'microsoft.powershell.management\\get-location'], usesSudo: false });
  for (const result of results.slice(1)) { assert.equal(result.complete, false); assert.deepEqual(result.names, []); }
}));

test('Windows 파일 카드의 권한 상승 선택은 기존 관리자 토큰을 설명한다', async () => fixture(async ({ page, origin }) => {
  await page.route('**/fixture/windows-card', route => route.fulfill({ contentType: 'text/html', body: '<div id="details"></div><div id="controls"></div><div id="status"></div>' }));
  await page.goto(origin + '/fixture/windows-card');
  await page.evaluate(async () => {
    const [{ createCardView }, { createCardI18n }] = await Promise.all([import('/ui/src/view.js'), import('/ui/src/i18n.js')]);
    const view = createCardView({ document, i18n: createCardI18n('ko') });
    view.transfer({ target: 'windows', direction: 'download', remotePath: 'C:/portal-files/report.txt', elevate: false },
      { uiEnabled: true, targets: [{ id: 'windows', displayName: 'Windows', enabled: true, platform: 'windows', capabilities: { elevatedFileTransfer: true } }] },
      config => { window.submittedTransfer = config; }, () => {});
  });
  assert.match(await page.locator('#details').textContent(), /현재 SSH 연결의 관리자 토큰/);
  await page.getByRole('checkbox', { name: /관리자 토큰으로 전송/ , includeHidden:true}).check();
  await page.getByRole('button', { name: '다운로드 요청', exact: true }).click();
  assert.equal((await page.evaluate(() => window.submittedTransfer)).elevate, true);
}));
