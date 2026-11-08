/** Native Unicode BCP 47 locale parsing; unsupported message languages use English. */
export function resolveLocale(language = 'en') {
  const candidates = Array.isArray(language) ? language : [language];
  const canonicals = [];
  for (const item of candidates) {
    if (typeof item !== 'string' || !item.trim()) continue;
    try {
      const [canonical] = Intl.getCanonicalLocales(item.trim());
      if (canonical && !canonicals.includes(canonical)) canonicals.push(canonical);
    } catch { /* invalid browser preference */ }
  }
  let locale = canonicals[0] || 'en-US';
  let messageLanguage = 'en';
  for (const tag of canonicals) {
    const base = new Intl.Locale(tag).language;
    if (base === 'ko' || base === 'en') { messageLanguage = base; break; }
  }
  if (locale === 'ko') locale = 'ko-KR';
  if (locale === 'en') locale = 'en-US';
  return { locale, messageLanguage, korean: messageLanguage === 'ko', dir: 'ltr' };
}

/** Existing Korean source strings remain stable message identifiers. */
export function messageCatalog(english) {
  const catalogs = { en: Object.freeze({ ...english }), ko: Object.freeze(Object.fromEntries(Object.keys(english).map(key => [key, key]))) };
  validateCatalogs(catalogs);
  return Object.freeze(catalogs);
}

export function validateCatalogs(catalogs) {
  const keys = Object.keys(catalogs.en).sort();
  for (const language of ['ko', 'en']) {
    const catalog = catalogs[language];
    if (!catalog || JSON.stringify(Object.keys(catalog).sort()) !== JSON.stringify(keys)) throw Error('Incomplete message catalog: ' + language);
    for (const key of keys) {
      const placeholders = value => {
        // Empty translations can intentionally omit language-specific suffixes (for example 개).
        if (typeof value !== 'string' || /[{}]/.test(value.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, ''))) throw Error('Invalid message syntax: ' + key);
        return [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]).sort().join(',');
      };
      if (placeholders(catalog[key]) !== placeholders(catalogs.en[key])) throw Error('Message placeholder mismatch: ' + key);
    }
  }
  return true;
}

export function translate(catalogs, language, key, values = {}) {
  const { messageLanguage } = resolveLocale(language);
  const catalog = catalogs[messageLanguage];
  const message = catalog && Object.hasOwn(catalog, key) ? catalog[key] : catalogs.en && Object.hasOwn(catalogs.en, key) ? catalogs.en[key] : undefined;
  if (message === undefined) return key;
  return message.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name) => Object.hasOwn(values, name) ? String(values[name]) : placeholder);
}

export function createFormatters(locale) {
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return { formatNumber: value => number.format(value), formatDate: value => { const instant = new Date(value); return Number.isNaN(instant.getTime()) ? '—' : date.format(instant); } };
}
