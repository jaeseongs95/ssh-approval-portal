import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSemver, compareSemver, createPortalReleaseChecker } from '../src/adapters/releases/portal-release.mjs';
import { createApplication } from '../app.mjs';

function mockRequest({ status = 200, contentType = 'application/vnd.github+json; charset=utf-8', body = {} } = {}) {
  let calls = 0;
  const fn = (_url, _options, callback) => {
    calls++;
    const req = new EventEmitter();
    req.destroy = () => {};
    queueMicrotask(() => {
      const res = new EventEmitter();
      res.statusCode = status;
      res.headers = { 'content-type': contentType, 'content-encoding': 'identity' };
      res.destroy = () => {};
      callback(res);
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      res.emit('data', Buffer.from(payload, 'utf8'));
      res.emit('end');
    });
    return req;
  };
  fn.calls = () => calls;
  return fn;
}

test('V01 semver parser and comparator handle v-prefixes and prerelease tags', () => {
  assert.equal(parseSemver('v2.4.0').normalized, '2.4.0');
  assert.equal(parseSemver('2.4.1-rc.1').normalized, '2.4.1-rc.1');
  assert.equal(parseSemver('invalid'), null);
  assert.equal(compareSemver('2.5.0', '2.4.0'), 1);
  assert.equal(compareSemver('2.4.0', '2.4.0'), 0);
  assert.equal(compareSemver('2.3.9', '2.4.0'), -1);
  assert.equal(compareSemver('2.4.0', '2.4.0-rc.1'), 1);
});

test('V02 portal release checker detects update_available, up_to_date, ahead, and caches results with cooldown', async () => {
  let now = 100000;
  const reqUpdate = mockRequest({
    body: {
      tag_name: 'v2.5.0',
      html_url: 'https://github.com/jaeseongs95/ssh-approval-portal/releases/tag/v2.5.0',
      published_at: '2026-11-07T00:00:00Z',
      draft: false,
      prerelease: false,
    },
  });
  const checker = createPortalReleaseChecker({ currentVersion: '2.4.0', request: reqUpdate, now: () => now });
  const first = await checker.check();
  assert.equal(first.status, 'update_available');
  assert.equal(first.updateAvailable, true);
  assert.equal(first.currentVersion, '2.4.0');
  assert.equal(first.latestVersion, '2.5.0');
  assert.equal(first.releaseUrl, 'https://github.com/jaeseongs95/ssh-approval-portal/releases/tag/v2.5.0');
  assert.equal(reqUpdate.calls(), 1);

  now += 5000;
  await checker.check({ refresh: true });
  assert.equal(reqUpdate.calls(), 1, 'refresh within 10s cooldown reuses cached value');

  now += 15000;
  await checker.check({ refresh: true });
  assert.equal(reqUpdate.calls(), 2, 'refresh after cooldown fetches again');

  const sameChecker = createPortalReleaseChecker({
    currentVersion: '2.4.0',
    request: mockRequest({ body: { tag_name: 'v2.4.0', html_url: 'https://evil.example/phish' } }),
    now: () => now,
  });
  const same = await sameChecker.check();
  assert.equal(same.status, 'up_to_date');
  assert.equal(same.updateAvailable, false);
  assert.equal(same.releaseUrl, 'https://github.com/jaeseongs95/ssh-approval-portal/releases', 'untrusted release URL falls back to canonical repo URL');

  const aheadChecker = createPortalReleaseChecker({
    currentVersion: '2.4.0',
    request: mockRequest({ body: { tag_name: 'v2.3.3' } }),
    now: () => now,
  });
  const ahead = await aheadChecker.check();
  assert.equal(ahead.status, 'ahead');
  assert.equal(ahead.updateAvailable, false);
});

test('V03 network failure or non-200 response degrades gracefully to unavailable', async () => {
  const failChecker = createPortalReleaseChecker({
    currentVersion: '2.4.0',
    request: mockRequest({ status: 503, body: { message: 'Service Unavailable' } }),
  });
  const res = await failChecker.check();
  assert.equal(res.status, 'unavailable');
  assert.equal(res.updateAvailable, false);
  assert.equal(res.latestVersion, null);
});

test('V04 GET /api/version requires admin auth and returns release status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'version-api-'));
  let app;
  try {
    const reqMock = mockRequest({
      body: {
        tag_name: 'v2.5.1',
        html_url: 'https://github.com/jaeseongs95/ssh-approval-portal/releases/tag/v2.5.1',
      },
    });
    app = await createApplication({
      registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'fixture', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
      classify: () => ({ class: 'privileged' }),
      executeCommand: async () => ({ texts: [] }),
      audit: () => {},
      transferRoot: dir,
      uiHtml: '<html></html>',
      portalReleaseChecker: createPortalReleaseChecker({ currentVersion: '2.4.0', request: reqMock }),
      env: {
        BRIDGE_MCP_TOKEN: 'mcp-secret',
        BRIDGE_ADMIN_TOKEN: 'admin-secret',
        BRIDGE_ADMIN_ORIGIN: 'https://owner.test',
        BRIDGE_UI_TICKET_KEY: 'a'.repeat(64),
      },
    });
    await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.adminHttp.address().port}`;

    const unauth = await fetch(`${base}/api/version`);
    assert.equal(unauth.status, 401);

    const auth = await fetch(`${base}/api/version`, { headers: { authorization: 'Bearer admin-secret' } });
    assert.equal(auth.status, 200);
    const body = await auth.json();
    assert.equal(body.status, 'update_available');
    assert.equal(body.latestVersion, '2.5.1');
    assert.equal(body.updateAvailable, true);
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
