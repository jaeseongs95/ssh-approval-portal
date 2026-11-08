import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Script } from 'node:vm';
import { resolveLocale, validateCatalogs, translate } from '../web/src/locale.js';
import { createWebI18n, webCatalogs } from '../web/src/i18n.js';
import { createCardI18n, cardCatalogs } from '../ui/src/i18n.js';
import { uiCatalogs, uiText } from '../web/src/ui-text.js';
import { capacityCatalogs, createCapacityPanel } from '../web/src/capacity.js';
import { desktopCatalogs } from '../web/src/desktop.js';
import { createAutomationMetricsPanel } from '../web/src/metrics.js';
import { createAgentCliPanel } from '../web/src/agent-cli.js';
import { createCommandLineImport } from '../web/src/command-line-import.js';

test('BCP 47 canonicalization, fallback catalog and native Intl formatting', () => {
  assert.equal(resolveLocale('KO-kr').locale, 'ko-KR');
  assert.equal(resolveLocale('ko-KP').messageLanguage, 'ko');
  assert.equal(resolveLocale('en-GB-u-nu-arab').locale, 'en-GB-u-nu-arab');
  for (const invalid of [null, {}, '', 'not_a_locale']) assert.equal(resolveLocale(invalid).locale, 'en-US');
  assert.deepEqual(resolveLocale(['not_a_locale', 'fr-FR', 'ko-KR']), { locale: 'fr-FR', messageLanguage: 'ko', korean: true, dir: 'ltr' });
  assert.deepEqual(resolveLocale(['de-DE', 'fr-FR']), { locale: 'de-DE', messageLanguage: 'en', korean: false, dir: 'ltr' });
  for (const create of [createWebI18n, createCardI18n]) {
    const korean = create('ko-KR'), french = create('fr-FR');
    assert.equal(korean.t('실행 중'), '실행 중');
    assert.equal(french.t('실행 중'), 'Running');
    assert.equal(french.locale, 'fr-FR');
    assert.equal(french.formatNumber(12345.5), new Intl.NumberFormat('fr-FR').format(12345.5));
    const instant = Date.UTC(2026, 10, 3, 10);
    assert.equal(korean.formatDate(instant), new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(instant));
    assert.equal(french.t('opaque caller text'), 'opaque caller text');
    assert.equal(french.formatDate('invalid date'), '—');
  }
});

test('unknown keys never read inherited object members or interpolate caller text', () => {
  for (const create of [createWebI18n, createCardI18n]) {
    for (const language of ['ko', 'en', 'fr-FR']) {
      const { t } = create(language);
      for (const key of ['constructor', 'toString', '__proto__', 'echo {name}', '승인·실행 && echo "한글"']) assert.equal(t(key, { name: 'changed' }), key);
    }
  }
  const catalogs = { ko: {}, en: { phrase: '{value} / {other}' } };
  assert.equal(translate(catalogs, 'ko', 'phrase', { value: '$& <b>한글</b> {other}', other: 'done' }), '$& <b>한글</b> {other} / done');
  assert.equal(translate(catalogs, 'en', 'phrase'), '{value} / {other}');
});

// Component DOM excludes layout and browser accessibility; only rendered text and actions are observed.
function componentDocument(page = 'bridge', language = 'en') {
  const nodes = [];
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.value = ''; this.dataset = {}; this.classList = { toggle() {} }; nodes.push(this); }
    append(...children) { this.children.push(...children); if (this.tagName === 'SELECT' && this.children.length === children.length) this.value = children[0]?.value ?? ''; }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    before(node) { this.beforeNode = node; }
    setAttribute(key, value) { this[key] = value; }
    removeAttribute(key) { delete this[key]; }
    addEventListener() {}
    focus() {}
    get options() { return this.children; }
  }
  const host = new Element('main');
  const document = { documentElement: { lang: language }, body: { dataset: { page, authMode: 'token' } }, createElement: tag => new Element(tag), addEventListener() {}, getElementById: id => nodes.find(node => node.id === id), querySelector: selector => selector === '.grid' ? host : selector.startsWith('#') ? nodes.find(node => node.id === selector.slice(1)) : null };
  return { document, nodes, find: id => nodes.find(node => node.id === id) };
}

test('metrics and capacity retain explicit regional formatting when document language is fallback English', async () => {
  const i18n = createWebI18n('de-DE');
  const h = componentDocument();
  const instant = '2026-11-03T10:00:00Z';
  createAutomationMetricsPanel({ document: h.document, i18n, api: async () => ({ from: instant, to: instant, available: true, total: 12345, commandSetApprovals: 1, modelApprovals: 0, ownerApprovals: 0, ownerApprovalsAfterAssessment: 0, providers: {} }) });
  await h.nodes.find(node => node.tagName === 'BUTTON').onclick();
  assert.ok(h.nodes.some(node => node.textContent?.includes(i18n.formatDate(instant))));
  assert.ok(h.nodes.some(node => node.tagName === 'STRONG' && node.textContent === '12.345'));
  const capacity = createCapacityPanel({ document: h.document, i18n, api: async () => ({ availableCpus: 2, settings: { queueCapacity: 12345, maxConcurrency: 2 }, status: { queued: 12345, running: 2 }, targets: [] }) });
  await capacity.reload();
  assert.equal(capacity.global.status.textContent, 'Currently queued: 12.345 · running: 2');
  assert.equal(capacity.global.inputs.queueCapacity.value, '12345'); // Editable machine values remain locale-neutral.
});

test('CLI history and login timestamps use the explicit format locale', async () => {
  const h = componentDocument('settings'), i18n = createWebI18n('de-DE'), instant = 1793700000000;
  const calls = [];
  const api = async path => {
    calls.push(path);
    if (path === '/api/agent-cli') return { available: true, bindings: [{ targetId: 'alpha', targetRevision: 'a'.repeat(64), profile: 'write', enabled: true, displayName: 'Alpha', sshTarget: 'tester@example', platform: 'linux' }] };
    if (path.startsWith('/api/agent-cli/login-status')) return { binding: { targetId: 'alpha', targetRevision: 'a'.repeat(64), profile: 'write' }, provider: 'codex', state: 'signed_in', checkedAt: instant };
    if (path.startsWith('/api/agent-cli/history')) return { binding: { targetId: 'alpha', targetRevision: 'a'.repeat(64), profile: 'write' }, provider: 'codex', requests: [{ id: 'b'.repeat(48), createdAt: instant, state: 'completed' }], next: null };
    throw Error('Unexpected request: ' + path);
  };
  const panel = createAgentCliPanel({ document: h.document, i18n, api, canLoad: () => true, isSignedOut: () => false, getTarget: () => 'alpha' });
  await panel.ensureLoaded();
  await h.find('cli-login-check').onclick();
  assert.ok(h.find('cli-login-state').textContent.includes(i18n.formatDate(instant)));
  await h.find('cli-recover').onclick();
  assert.ok(h.find('cli-history-select').children.some(option => option.textContent.includes(i18n.formatDate(instant))));
  assert.ok(calls.some(path => path.startsWith('/api/agent-cli/history')));
});

test('whole count messages handle zero, one and many without English singular suffixes', () => {
  const key = '초안에 이름 {count}개를 추가했습니다. 검토·저장 전에는 적용되지 않습니다.';
  for (const count of [0, 1, 2]) {
    assert.equal(uiText(key, { documentElement: { lang: 'en' } }, { count }), `Added command names to the draft: ${count}. Review and save to apply.`);
    assert.equal(uiText(key, { documentElement: { lang: 'ko' } }, { count }), `초안에 이름 ${count}개를 추가했습니다. 검토·저장 전에는 적용되지 않습니다.`);
  }
  for (const language of ['en', 'ko']) {
    const h = componentDocument('settings', language), commands = { value: '' }, denied = { value: '' };
    const importer = createCommandLineImport({ document: h.document, commands, denied, onChange() {}, onError: error => assert.fail(error) });
    importer.open('printf "한글 원문"');
    const selected = h.nodes.find(node => node.type === 'checkbox'); selected.checked = true; selected.onchange();
    h.nodes.find(node => node.tagName === 'BUTTON' && node.textContent === (language === 'ko' ? '선택한 이름을 초안에 추가' : 'Add selected names to draft')).onclick();
    assert.equal(commands.value, 'printf');
    assert.equal(importer.source.value, 'printf "한글 원문"');
    assert.ok(h.nodes.some(node => node.textContent === uiText(key, h.document, { count: 1 })));
  }
});

test('all actual ko/en catalogs have valid message syntax, identical keys and placeholders', () => {
  for (const catalogs of [webCatalogs, cardCatalogs, uiCatalogs, capacityCatalogs, desktopCatalogs]) assert.equal(validateCatalogs(catalogs), true);
  assert.throws(() => validateCatalogs({ en: { key: 'Ready' }, ko: {} }), /Incomplete/);
  assert.throws(() => validateCatalogs({ en: { key: '{count}' }, ko: { key: '{wrong}' } }), /placeholder/);
  assert.throws(() => validateCatalogs({ en: { key: '{broken' }, ko: { key: '준비' } }), /syntax/);
  assert.throws(() => validateCatalogs({ en: { key: undefined }, ko: { key: '준비' } }), /syntax/);
  assert.equal(validateCatalogs({ en: { '개': '' }, ko: { '개': '개' } }), true);
  assert.equal(translate(uiCatalogs, 'en', '개'), '');
  assert.equal(translate(uiCatalogs, 'ko', '개'), '개');
  const windowsHint = '예: whoami.exe, Microsoft.PowerShell.Management\\Get-Location, C:\\Tools\\tool.exe. 이름은 UTF-8 512바이트까지이며 대소문자를 구분하지 않습니다.';
  assert.equal(translate(uiCatalogs, 'ko', windowsHint), windowsHint);
  assert.equal(translate(uiCatalogs, 'en', windowsHint), 'Examples: whoami.exe, Microsoft.PowerShell.Management\\Get-Location, C:\\Tools\\tool.exe. Names allow up to 512 UTF-8 bytes and are case-insensitive.');
  assert.equal(translate(capacityCatalogs, 'en-GB', '현재 실행 대기 {queued}개 · 실행 중 {running}개', { queued: 3, running: 2 }), 'Currently queued: 3 · running: 2');
  assert.equal(translate({ en: { key: 'Fallback' } }, 'ko', 'key'), 'Fallback');
});

function assertLiteralTranslations(source, name, catalogs, file) {
  // agent-cli's local t(ko, en) selects an inline pair; it does not read webCatalogs.
  const inlinePair = name === 't' && /\bt\s*=\s*\(\s*a\s*,\s*b\s*\)\s*=>\s*ko\s*\?\s*a\s*:\s*b\b/.test(source);
  const calls = new RegExp(String.raw`\b${name}\('((?:\\.|[^'\\\r\n])*)'\s*(?=[,)])`, 'g');
  for (const match of source.matchAll(calls)) {
    const key = new Script("'" + match[1] + "'").runInThisContext();
    if (inlinePair) {
      const second = /^,\s*('(?:\\.|[^'\\\r\n])*')\s*\)/.exec(source.slice(match.index + match[0].length));
      assert.ok(second, file + ': inline translation needs an English literal: ' + key);
      const english = new Script(second[1]).runInThisContext();
      assert.ok(english.trim(), file + ': empty inline English translation: ' + key);
      assert.doesNotMatch(english, /[가-힣]/, file + ': untranslated inline English: ' + key);
      assert.equal(validateCatalogs({ ko: { [key]: key }, en: { [key]: english } }), true);
    } else if (/[가-힣]/.test(key)) {
      assert.ok(Object.hasOwn(catalogs.en, key), file + ': ' + key);
    }
  }
}

test('translation callsite guard distinguishes catalog lookup from inline bilingual pairs without ignoring missing translations', () => {
  const catalog = { ko: { '준비': '준비' }, en: { '준비': 'Ready' } };
  assert.doesNotThrow(() => assertLiteralTranslations("const {t}=i18n; t('준비');", 't', catalog, 'catalog'));
  for (const source of ["const {t}=i18n; t('누락');", "const {t}=i18n; t('누락', {count: 1});"]) assert.throws(() => assertLiteralTranslations(source, 't', catalog, 'catalog'), /누락/);
  const declaration = 'const ko=true,t=(a,b)=>ko?a:b;';
  assert.doesNotThrow(() => assertLiteralTranslations(declaration + "t('서버 CLI 설치','Server CLI installation');", 't', catalog, 'inline'));
  for (const call of ["t('서버 CLI 설치');", "t('서버 CLI 설치','');", "t('서버 CLI 설치','서버 CLI 설치');", "t('요청 {count}','Request {wrong}');"]) assert.throws(() => assertLiteralTranslations(declaration + call, 't', catalog, 'inline'));
});

test('literal Korean UI translations have an English message at their actual catalog or inline boundary', async () => {
  for (const [folder, name, catalogs] of [['web/src/', 'tr', uiCatalogs], ['web/src/', 't', webCatalogs], ['ui/src/', 't', cardCatalogs]]) {
    for (const file of await readdir(new URL('../' + folder, import.meta.url))) {
      if (!file.endsWith('.js') || ['capacity.js', 'desktop.js'].includes(file)) continue;
      const source = await readFile(new URL('../' + folder + file, import.meta.url), 'utf8');
      assertLiteralTranslations(source, name, catalogs, file);
    }
  }
});
