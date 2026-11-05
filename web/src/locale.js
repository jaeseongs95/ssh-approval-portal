/** Native BCP 47 parsing; unsupported message languages use the English catalog. */
export function resolveLocale(language = 'en') {
  let locale;
  try { locale = Intl.getCanonicalLocales(language)[0]; } catch { /* invalid browser preference */ }
  locale ||= 'en-US';
  const messageLanguage = new Intl.Locale(locale).language === 'ko' ? 'ko' : 'en';
  if (locale === 'ko') locale = 'ko-KR';
  if (locale === 'en') locale = 'en-US';
  return { locale, messageLanguage, korean: messageLanguage === 'ko' };
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
  const message = catalogs[messageLanguage]?.[key] ?? catalogs.en?.[key] ?? key;
  return message.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name) => Object.hasOwn(values, name) ? String(values[name]) : placeholder);
}

export function createFormatters(locale) {
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return { formatNumber: value => number.format(value), formatDate: value => { const instant = new Date(value); return Number.isNaN(instant.getTime()) ? '—' : date.format(instant); } };
}
