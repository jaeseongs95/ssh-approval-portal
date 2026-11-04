import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Duplex } from 'node:stream';
import { createApplication } from '../app.mjs';
import { createDesktopPanel } from '../web/src/desktop.js';

const adminOrigin = 'https://desktop-owner.test';

// Only the external SSH/RFB wire is synthetic; app routing, authorization,
// target revisions, desktop service and PNG adapter remain real.
function rfbChannel() {
  let phase = 0;
  const stream = new Duplex({ read() {}, write(bytes, encoding, callback) {
    if (phase === 0) { phase++; stream.push(Buffer.from([1, 1])); }
    else if (phase === 1) { phase++; stream.push(Buffer.alloc(4)); }
    else if (phase === 2) {
      phase++; const init = Buffer.alloc(24); init.writeUInt16BE(2); init.writeUInt16BE(2, 2); stream.push(init);
    } else if (bytes[0] === 3) {
      const header = Buffer.alloc(16); header.writeUInt16BE(1, 2); header.writeUInt16BE(2, 8); header.writeUInt16BE(2, 10);
      stream.push(Buffer.concat([header, Buffer.alloc(16, 0x55)]));
    }
    callback();
  } });
  queueMicrotask(() => stream.push(Buffer.from('RFB 003.008\n')));
  return { stream, close() { stream.destroy(); } };
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-http-')), profiles = new Map(), channels = [], requests = [];
  let app;
  t.after(async () => { await app?.close(); assert.ok(root.startsWith(join(tmpdir(), 'desktop-http-'))); await rm(root, { recursive: true, force: true }); });
  const targets = ['alpha', 'beta'].map(id => ({ id, displayName: id, platform: options.platform ?? 'linux', readProfile: id + '-read', writeProfile: id + '-write', credentialRevision: 'synthetic-v1', desktop: { enabled: true, port: 5901 } }));
  const registry = { getProfile(name) {
    if (!profiles.has(name)) profiles.set(name, { host: '127.0.0.1', port: 22, user: 'synthetic', trustedHostKey: 'synthetic-host-key', readOnly: name.endsWith('-read') });
    return profiles.get(name);
  }, closeAll: async () => {} };
  app = await createApplication({ registry, classify: () => 'read-only', executeCommand: options.executeCommand ?? (async () => { throw Error('Unexpected command execution'); }),
    openDesktopChannel: async (profile, options) => { channels.push({ profile, host: options.host, port: options.port }); return rfbChannel(); }, audit: () => {}, transferRoot: root, uiHtml: '<html></html>',
    env: { BRIDGE_MCP_TOKEN: 'synthetic-mcp', BRIDGE_ADMIN_TOKEN: 'synthetic-owner', BRIDGE_UI_TICKET_KEY: 'a'.repeat(64), BRIDGE_ADMIN_ORIGIN: adminOrigin,
      BRIDGE_JEV_ENABLED: 'false', BRIDGE_COMMAND_AUTOMATION: 'false', BRIDGE_TARGETS: JSON.stringify(targets), BRIDGE_DEFAULT_TARGET: 'alpha' } });
  await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + app.adminHttp.address().port;
  const request = async (path, method = 'GET', body, overrides = {}) => {
    requests.push({ path, method, body });
    const response = await fetch(origin + path, { method, headers: { Authorization: 'Bearer synthetic-owner', Origin: adminOrigin, 'Content-Type': 'application/json', ...overrides }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { channels, requests, request, api: async (...args) => {
    const response = await request(...args);
    if (response.status >= 400) throw Object.assign(Error(response.body.error), { status: response.status });
    return response.body;
  } };
}

function panel(api) {
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.value = ''; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(key, value) { this[key] = value; }
    removeAttribute(key) { delete this[key]; }
  }
  const workspace = new Element('div');
  const document = { documentElement: { lang: 'en' }, body: { dataset: { page: 'settings' } }, createElement: tag => new Element(tag),
    getElementById: id => id === 'server-workspace' ? workspace : undefined, addEventListener() {} };
  const value = createDesktopPanel({ document, api, getTarget: () => 'beta', timers: { setInterval() {}, clearInterval() {} } });
  return { value, open: value.root.children.find(node => node.tagName === 'div').children[0], image: value.root.children.find(node => node.tagName === 'img'), error: value.root.children.find(node => node.className === 'error'), auth: value.root.children.find(node => node.id === 'desktop-authentication') };
}

test('DESKTOP-HTTP actual UI open crosses authenticated HTTP/app contract and uses server epoch', async t => {
  const f = await fixture(t), p = panel(f.api);
  const listed = await f.api('/api/targets'), selected = listed.targets.find(target => target.id === 'beta');
  await p.open.onclick();
  assert.equal(p.error.textContent, '');
  assert.deepEqual(f.requests.find(call => call.path === '/api/desktop/open').body, { target: 'beta', expectedTargetRevision: selected.revision });
  assert.deepEqual(f.channels, [{ profile: 'beta-write', host: '127.0.0.1', port: 5901 }]);
  assert.match(p.image.src, /^data:image\/png;base64,iVBORw0KGgo/);
  const observed = f.requests.find(call => call.path === '/api/desktop/observe').body;
  assert.match(observed.sessionId, /^[a-f0-9-]{36}$/); assert.equal(observed.epoch, 1);
  await p.value.close();
  assert.deepEqual(f.requests.find(call => call.path === '/api/desktop/close').body, observed);
  assert.equal(p.value.reloadState().blocked, false);
});

test('DESKTOP-HTTP rejects legacy UI fields, stale revision and unauthorized open before channel creation', async t => {
  const f = await fixture(t), listed = await f.api('/api/targets'), revision = listed.targets.find(target => target.id === 'beta').revision;
  const body = { target: 'beta', expectedTargetRevision: revision };
  const legacy = await f.request('/api/desktop/open', 'POST', { targetId: 'beta', targetRevision: revision, epoch: 123 });
  assert.equal(legacy.status, 409); assert.equal(legacy.body.error, 'DESKTOP_STALE_TARGET');
  assert.equal((await f.request('/api/desktop/open', 'POST', { ...body, expectedTargetRevision: '0'.repeat(64) })).status, 409);
  assert.equal((await f.request('/api/desktop/open', 'POST', { ...body, ownerId: 'forged-owner' })).status, 400);
  assert.equal((await f.request('/api/desktop/open', 'POST', body, { Authorization: 'Bearer synthetic-mcp' })).status, 401);
  assert.equal((await f.request('/api/desktop/open', 'POST', body, { Origin: 'https://untrusted.test' })).status, 403);
  assert.equal(f.channels.length, 0);
});


test('DESKTOP-HTTP owner login screen, nonstored credential field and SAS cross the real application route', async t => {
  const f = await fixture(t, { platform: 'windows', executeCommand: async () => ({ failed: false,
    execution: { exitCode: 0, stdout: { truncated: false } }, data: { stdout: JSON.stringify({ version: 1,
      boot: '133900000000000000', consoleSessionId: 1, sessions: [{ id: 1, state: 1, locked: true }] }) } }) });
  const p = panel(f.api); await p.open.onclick(); p.image.onload();
  assert.equal(p.error.textContent, ''); assert.equal(p.auth.hidden, false);
  const confirmation = p.auth.children[2].children[0], credential = p.auth.children[3].children[0];
  const send = p.auth.children[4], sas = p.auth.children[5];
  assert.equal(credential.type, 'password'); assert.equal(credential.autocomplete, 'off');
  credential.value = 'SYNTHETIC-PRIVATE-VALUE'; confirmation.checked = true; credential.oninput();
  await send.onclick();
  assert.equal(credential.value, ''); assert.equal(confirmation.checked, false);
  const privateRequest = f.requests.find(call => call.path === '/api/desktop/authenticate');
  assert.equal(privateRequest.body.value, undefined, 'UI drops the in-memory request value after completion');
  p.image.onload(); confirmation.checked = true; confirmation.onchange(); await sas.onclick();
  assert.equal(p.error.textContent, '');
  const requests = f.requests.filter(call => call.path === '/api/desktop/authenticate');
  assert.equal(requests.length, 2); assert.equal(requests[1].body.action, 'sas');
  assert.equal(requests[0].body.sequence, 1); assert.equal(requests[1].body.sequence, 2);
  const identity = f.requests.find(call => call.path === '/api/desktop/observe').body;
  const status = await f.api('/api/desktop/status', 'POST', identity);
  assert.equal(status.readiness.state, 'auth_required'); assert.equal(status.readiness.sessionBindingVerified, false);
  assert.doesNotMatch(JSON.stringify(status), /SYNTHETIC-PRIVATE|image\/png/);
  await p.value.close();
});
