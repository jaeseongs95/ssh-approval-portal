import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolveLocale, validateCatalogs, translate } from '../web/src/locale.js';
import { createWebI18n, webCatalogs } from '../web/src/i18n.js';
import { createCardI18n, cardCatalogs } from '../ui/src/i18n.js';
import { uiCatalogs } from '../web/src/ui-text.js';
import { capacityCatalogs } from '../web/src/capacity.js';
import { desktopCatalogs } from '../web/src/desktop.js';

test('BCP 47 canonicalization, fallback catalog and native Intl formatting', () => {
  assert.equal(resolveLocale('KO-kr').locale, 'ko-KR');
  for (const invalid of [null, {}, '', 'not_a_locale']) assert.equal(resolveLocale(invalid).locale, 'en-US');
  for (const create of [createWebI18n, createCardI18n]) {
    const korean = create('ko-KR'), french = create('fr-FR');
    assert.equal(korean.t('실행 중'), '실행 중');
    assert.equal(french.t('실행 중'), 'Running');
    assert.equal(french.locale, 'fr-FR');
    assert.equal(french.formatNumber(12345.5), new Intl.NumberFormat('fr-FR').format(12345.5));
    const instant = Date.UTC(2026, 10, 3, 10);
    assert.equal(korean.formatDate(instant), new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(instant));
    assert.equal(french.t('opaque caller text'), 'opaque caller text');
  }
});

test('all actual ko/en catalogs have valid message syntax, identical keys and placeholders', () => {
  for (const catalogs of [webCatalogs, cardCatalogs, uiCatalogs, capacityCatalogs, desktopCatalogs]) assert.equal(validateCatalogs(catalogs), true);
  assert.throws(() => validateCatalogs({ en: { key: 'Ready' }, ko: {} }), /Incomplete/);
  assert.throws(() => validateCatalogs({ en: { key: '{count}' }, ko: { key: '{wrong}' } }), /placeholder/);
  assert.throws(() => validateCatalogs({ en: { key: '{broken' }, ko: { key: '준비' } }), /syntax/);
  assert.equal(translate(capacityCatalogs, 'en-GB', '현재 실행 대기 {queued}개 · 실행 중 {running}개', { queued: 3, running: 2 }), 'Currently queued: 3 · running: 2');
  assert.equal(translate({ en: { key: 'Fallback' } }, 'ko', 'key'), 'Fallback');
});

test('literal Korean UI translation callsites exist in their actual English catalog', async () => {
  for (const [folder, name, catalogs] of [['web/src/', 'tr', uiCatalogs], ['web/src/', 't', webCatalogs], ['ui/src/', 't', cardCatalogs]]) {
    for (const file of await readdir(new URL('../' + folder, import.meta.url))) {
      if (!file.endsWith('.js') || ['capacity.js', 'desktop.js'].includes(file)) continue;
      const source = await readFile(new URL('../' + folder + file, import.meta.url), 'utf8');
      const calls = new RegExp('\\b' + name + "\\('([^'\\n]*)'\\)", 'g');
      for (const [, key] of source.matchAll(calls)) if (/[가-힣]/.test(key)) assert.ok(Object.hasOwn(catalogs.en, key), file + ': ' + key);
    }
  }
});
