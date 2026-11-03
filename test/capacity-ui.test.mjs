import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapacityPanel, parseCapacity } from '../web/src/capacity.js';

function harness() {
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.value = ''; this.listeners = {}; }
    append(...nodes) { this.children.push(...nodes); }
    before(node) { this.beforeNode = node; }
    setAttribute(key, value) { this[key] = value; }
    addEventListener(key, handler) { this.listeners[key] = handler; }
  }
  const roots = Object.fromEntries(['environment-editor', 'server-workspace', 'load', 'logout'].map(key => [key, new Element('div')]));
  const listeners = {};
  const document = { documentElement: { lang: 'en' }, body: { dataset: { page: 'bridge', authMode: 'token' } }, createElement: tag => new Element(tag), getElementById: id => roots[id], addEventListener: (name, action) => { listeners[name] = action; } };
  let current = 'alpha', failAfterCommit = false;
  const calls = [], snapshot = { revision: 1, availableCpus: 2, settings: { queueCapacity: 20, maxConcurrency: 2 }, status: { queued: 3, running: 2 }, targets: ['alpha', 'beta'].map(id => ({ id, queueCapacity: null, maxConcurrency: null, effective: { queueCapacity: 20, maxConcurrency: 2 }, status: { queued: 1, running: 1 } })) };
  const api = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (method === 'POST') {
      assert.equal(body.expectedRevision, snapshot.revision);
      if (body.settings) Object.assign(snapshot.settings, body.settings);
      for (const target of body.targets ?? []) Object.assign(snapshot.targets.find(item => item.id === target.id), target);
      snapshot.revision++;
      if (failAfterCommit) throw Error('Connection lost');
    }
    return structuredClone(snapshot);
  };
  const panel = createCapacityPanel({ document, api, getTarget: () => current });
  const edit = (scope, name, value) => { panel[scope].inputs[name].value = value; panel[scope].inputs[name].oninput(); };
  const submit = scope => panel[scope].form.onsubmit({ preventDefault() {} });
  return { panel, calls, document, edit, submit, loseReply: () => { failAfterCommit = true; }, select(id) { current = id; panel.syncTarget(); }, navigate(page) { document.body.dataset.page = page; listeners['admin-scope-change'](); } };
}

test('capacity values preserve inheritance and reject zero, fractional, exponential and unsafe input', () => {
  assert.equal(parseCapacity('', true), null);
  assert.equal(parseCapacity('20'), 20);
  for (const value of ['', '0', '-1', '1.2', '1e3', '9007199254740992']) assert.throws(() => parseCapacity(value));
});

test('global and target saves carry CAS revision, explicit null inheritance and preserve other drafts', async () => {
  const h = harness(); await h.panel.reload();
  assert.match(h.panel.global.defaults.textContent, /2 available CPUs/);
  assert.match(h.panel.global.status.textContent, /queued: 3.*running: 2/);
  h.edit('target', 'queueCapacity', '5'); h.select('beta'); h.edit('target', 'maxConcurrency', '1');
  h.select('alpha'); assert.equal(h.panel.target.inputs.queueCapacity.value, '5');
  await h.submit('target');
  assert.deepEqual(h.calls.at(-1).body, { expectedRevision: 1, targets: [{ id: 'alpha', queueCapacity: 5, maxConcurrency: null }] });
  h.select('beta'); assert.equal(h.panel.target.inputs.maxConcurrency.value, '1');
  h.edit('global', 'maxConcurrency', '1'); await h.submit('global');
  assert.deepEqual(h.calls.at(-1).body, { expectedRevision: 2, settings: { queueCapacity: 20, maxConcurrency: 1 } });
  h.navigate('settings'); assert.equal(h.panel.global.root.hidden, true); assert.equal(h.panel.target.root.hidden, false);
});

test('a committed save with a lost response is never replayed and a GET reconciles the actual value', async () => {
  const h = harness(); await h.panel.reload(); h.loseReply();
  h.edit('global', 'queueCapacity', '7'); await h.submit('global');
  assert.equal(h.panel.reloadState().blocked, true); assert.equal(h.panel.global.save.disabled, true);
  await h.submit('global'); assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  await h.panel.reload(); assert.equal(h.panel.global.inputs.queueCapacity.value, '7'); assert.equal(h.panel.reloadState().blocked, false);
});
