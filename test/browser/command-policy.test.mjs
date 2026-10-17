import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { classifyCommand } from 'ssh-mcp/build/policy/classifier.js';
import { createApplication } from '../../app.mjs';

test('owner edits command names in the actual bundled page and sees policy execution results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'policy-browser-')); let app, browser;
  try {
    app = await createApplication({ registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'fixture', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
      classify: classifyCommand, executeCommand: async () => ({ failed: false, texts: ['synthetic result'] }), audit: () => {}, transferRoot: root, uiHtml: '<html></html>',
      env: { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-owner', BRIDGE_UI_TICKET_KEY: 'a'.repeat(64), BRIDGE_ADMIN_ORIGIN: 'https://owner.test', BRIDGE_COMMAND_AUTOMATION: 'true' } });
    await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${app.adminHttp.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.SOLID_CHROMIUM_PATH ? { executablePath: process.env.SOLID_CHROMIUM_PATH } : {}) });
    const context = await browser.newContext({ locale: 'ko-KR' });
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== origin) return route.abort();
      if (route.request().method() === 'POST') {
        const response = await route.fetch({ maxRedirects: 0, headers: { ...route.request().headers(), origin: 'https://owner.test' } });
        return route.fulfill({ response });
      }
      return route.continue();
    });
    const page = await context.newPage(); await page.goto(origin);
    await page.locator('#token').fill('fixture-owner');
    await page.getByText('명령 자동 실행 정책', { exact: true }).click();
    await page.getByRole('button', { name: '정책 불러오기' }).click();
    const names = page.getByLabel('사전 승인 명령 이름 — 줄마다 하나');
    await names.waitFor({ state: 'visible' }); await names.fill('ls\nsudo');
    const save = page.getByRole('button', { name: '정책 저장' }), ok = page.getByLabel('위험도 피드백을 확인했고 등록에 동의합니다 (OK)');
    assert.equal(await save.isDisabled(), true); assert.equal(await ok.isDisabled(), true);
    await page.getByRole('button', { name: '위험도 확인', exact: true }).click();
    await page.getByText('등록은 아직 이루어지지 않았습니다.', { exact: false }).waitFor();
    assert.equal(await save.isDisabled(), true); await ok.check(); assert.equal(await save.isDisabled(), false);
    await names.fill('ls\nsudo '); assert.equal(await save.isDisabled(), true); assert.equal(await ok.isChecked(), false);
    await page.getByRole('button', { name: '위험도 확인', exact: true }).click();
    await ok.waitFor({ state: 'visible' }); await page.waitForFunction(() => !Array.from(document.querySelectorAll('input')).find(el => el.parentElement.textContent.includes('피드백을 확인했고')).disabled);
    await ok.check();
    const saved = page.waitForResponse(response => response.url().endsWith('/api/command-policy') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '정책 저장' }).click();
    const response = await saved; assert.equal(response.status(), 200, await response.text());
    await page.getByText('정책 revision 1 · 저장됨', { exact: true }).waitFor();
    const { job } = await app.targets.commands.run('sudo id'); await app.targets.drain();
    assert.equal(app.queue.get(job.id).state, 'completed');
    await page.locator('#load').click();
    await page.locator(`[data-request-id="${job.id}"] summary`).getByText('자동승인', { exact: true }).waitFor();
    await page.locator(`[data-request-id="${job.id}"] summary`).click();
    await page.getByText('사전 승인 명령셋에 일치', { exact: true }).waitFor();
    assert.equal(await names.inputValue(), 'ls\nsudo');
    const ownerApi = async (path, body) => {
      const result = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer fixture-owner', Origin: 'https://owner.test', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(result.status, 200); return result.json();
    };
    const current = await ownerApi('/api/command-policy');
    const legacy = { expectedRevision: current.revision, policy: { targets: [{ ...current.targets[0], thresholds: { jev: {
      model: 'jev-1.13.0', questionVersion: 'ssh-command-risk-v2', minLowRisk: 0.99, minConfidence: 0.99, validationRef: 'synthetic:legacy-v2' } } }] } };
    const checked = await ownerApi('/api/command-policy/review', legacy);
    await ownerApi('/api/command-policy', { ...legacy, reviewToken: checked.reviewToken, acknowledged: true });
    await page.getByRole('button', { name: '정책 불러오기' }).click();
    await page.getByText('정책 revision 2', { exact: true }).waitFor();
    await page.getByRole('button', { name: '위험도 확인', exact: true }).click();
    await page.getByText('v3 질문에 대한 새 검증 보고서 참조가 필요합니다.', { exact: true }).waitFor();
    assert.equal(await save.isDisabled(), true);
    await page.getByLabel('jev 검증 보고서 참조').fill('synthetic:new-v3-measurement');
    await page.getByRole('button', { name: '위험도 확인', exact: true }).click();
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('input')).find(el => el.parentElement.textContent.includes('피드백을 확인했고')).disabled);
    await ok.check();
    const upgraded = page.waitForResponse(result => result.url().endsWith('/api/command-policy') && result.request().method() === 'POST');
    await save.click(); const result = await upgraded; assert.equal(result.status(), 200);
    assert.equal((await result.json()).targets[0].thresholds.jev.questionVersion, 'ssh-command-risk-v3');
  } finally { await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true }); }
});
