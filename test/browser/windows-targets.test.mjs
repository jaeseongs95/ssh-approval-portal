import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { fixtureServer } from './fixture-server.mjs';
import { launchBrowser } from './browser.mjs';

const revision = 'b'.repeat(64);
const capabilities = windows => ({ commandShell: windows ? 'windows-powershell-5.1' : 'posix', fileTransfer: true,
  elevatedFileTransfer: !windows, pythonSource: !windows, agentCli: !windows, commandNameApproval: !windows });
const targets = ['windows', 'linux'].map(id => ({ id, displayName: id + ' 시험 서버', enabled: true, platform: id, capabilities: capabilities(id === 'windows') }));
const bindings = targets.map(target => ({ targetId: target.id, targetRevision: revision, profile: target.id + '-write',
  displayName: target.displayName, enabled: true, platform: target.platform, capabilities: target.capabilities,
  sshTarget: 'portal-user@' + target.id + '.example', supported: target.capabilities.agentCli }));

async function fixture(run) {
  const server = await fixtureServer(fileURLToPath(new URL('../../', import.meta.url)));
  server.state.commandAutomation = server.state.multiTarget = true;
  server.state.targets = targets;
  server.state.jobs = targets.map((target, index) => ({ id: String(index + 1).repeat(48), kind: 'command', state: 'completed',
    createdAt: Date.now(), finishedAt: Date.now(), command: index ? 'pwd' : 'Get-Date', targetId: target.id,
    targetRevision: revision, targetDisplayName: target.displayName, profile: target.id + '-write', target: bindings[index].sshTarget }));
  const cliCalls = [], policyPosts = [];
  server.state.agentCli = async (request, response, url) => {
    cliCalls.push(url.pathname);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ available: true, bindings, providers: [{ id: 'codex' }, { id: 'claude' }] }));
  };
  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ locale: 'ko-KR', viewport: { width: 390, height: 844 } });
    let snapshot = { revision: 0, targets: [], bindings, testServerAvailable: true, evaluators: {} };
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

test('Windows 설정은 미지원 작업을 막고 모델·파일·테스트 권한과 Linux 초안을 보존한다', async () => fixture(async ({ page, origin, cliCalls, policyPosts }) => {
  await page.goto(origin + '/settings');
  const target = page.getByLabel('정책 편집 대상', { exact: true });
  await page.locator('#policy-platform-notice').waitFor({ state: 'visible' });
  assert.equal(await target.inputValue(), 'windows');
  assert.match(await target.locator('option:checked').textContent(), /Windows/);
  assert.equal(await page.getByRole('checkbox', { name: /^sudo 자동승인/ }).isDisabled(), true);
  assert.equal(await page.getByRole('checkbox', { name: /^제출한 Python 코드/ }).isDisabled(), true);
  for (const name of [/^파일 자동업로드/, /^파일 자동다운로드/, /^Jev·다른 모델을 통한/, /^테스트 서버/]) {
    assert.equal(await page.getByRole('checkbox', { name }).isEnabled(), true);
  }
  assert.equal(await page.getByLabel('자동승인할 명령', { exact: true }).isVisible(), false);
  const uploadExplanation = page.getByRole('checkbox', { name: /^파일 자동업로드/ }).locator('..');
  assert.match(await uploadExplanation.textContent(), /대상의 파일 전송 제한과 SSH 계정 권한/);
  assert.doesNotMatch(await uploadExplanation.textContent(), /폴더 제한 없이/);
  await page.getByRole('checkbox', { name: /^파일 자동업로드/ }).check();
  await target.selectOption('linux');
  assert.match(await uploadExplanation.textContent(), /폴더 제한 없이 SSH 계정이 쓸 수 있는 경로/);
  assert.equal(await page.getByRole('checkbox', { name: /^sudo 자동승인/ }).isEnabled(), true);
  assert.equal(await page.getByRole('checkbox', { name: /^제출한 Python 코드/ }).isEnabled(), true);
  assert.equal(await page.getByRole('checkbox', { name: /^파일 자동업로드/ }).isChecked(), false);
  await target.selectOption('windows');
  assert.doesNotMatch(await uploadExplanation.textContent(), /폴더 제한 없이/);
  assert.equal(await page.getByRole('checkbox', { name: /^파일 자동업로드/ }).isChecked(), true);
  await page.getByRole('tab', { name: '검토·저장', exact: true }).click();
  await page.getByRole('button', { name: '이 설정으로 위험도 확인', exact: true }).click();
  await page.getByRole('checkbox', { name: /^위험도와 변경 내용을 확인했고/ }).waitFor({ state: 'visible' });
  const candidate = policyPosts[0].body.policy.targets[0];
  assert.equal(candidate.targetId, 'windows'); assert.deepEqual(candidate.commands, []); assert.deepEqual(candidate.deniedCommands, []);
  assert.equal(candidate.automaticUploads, true); assert.equal(candidate.automaticSudo, undefined); assert.equal(candidate.sourceExecutionContract, undefined);
  await page.locator('#cli-target option[value=windows]').waitFor({ state: 'attached' });
  await page.locator('#cli-target').selectOption('windows');
  for (const id of ['cli-inspect', 'cli-login-check', 'cli-recover']) assert.equal(await page.locator('#' + id).isDisabled(), true);
  assert.equal(await page.locator('#cli-login').isVisible(), false);
  assert.match(await page.locator('#agent-cli-settings').textContent(), /일반 명령과 파일 전송/);
  assert.deepEqual(cliCalls, ['/api/agent-cli']);
  await page.locator('#cli-target').selectOption('linux');
  assert.equal(await page.locator('#cli-inspect').isEnabled(), true);
  assert.equal(await page.locator('#cli-login-check').isEnabled(), true);
  assert.equal(await page.locator('#cli-login').isVisible(), true);
}));

test('대상 개요에 운영체제를 표시하고 Windows 이력의 명령 이름 등록을 제공하지 않는다', async () => fixture(async ({ page, origin }) => {
  await page.goto(origin + '/history');
  await page.locator('#target-filter option[value=windows]').waitFor({ state: 'attached' });
  await page.locator('[data-request-id]').first().waitFor();
  assert.match(await page.locator('.server-card[data-target-id=windows]').textContent(), /Windows/);
  assert.match(await page.locator('.server-card[data-target-id=linux]').textContent(), /Linux/);
  const windows = page.locator('[data-request-id="' + '1'.repeat(48) + '"]');
  const linux = page.locator('[data-request-id="' + '2'.repeat(48) + '"]');
  await windows.locator('summary').click(); await linux.locator('summary').click();
  assert.equal(await windows.getByRole('button', { name: '이력의 명령 이름 등록', exact: true }).count(), 0);
  assert.equal(await linux.getByRole('button', { name: '이력의 명령 이름 등록', exact: true }).count(), 1);
}));
