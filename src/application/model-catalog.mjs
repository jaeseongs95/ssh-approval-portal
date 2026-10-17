import { SAFETY_PROTOCOL, isJevModel } from '../domain/safety.mjs';

/** Metadata only: refreshing choices never changes a saved execution policy. */
export function createModelCatalog({ jev, providers = {}, configured = false, now = () => Date.now() }) {
  let models = ['jev-1.14.0', 'jev-1.13.0'], pending, next = 0, updatedAt = null, status = configured ? 'bundled' : 'not_configured';
  const snapshot = () => ({ updatedAt, status, refreshHours: 24, jev: { configured, defaultModel: SAFETY_PROTOCOL.model, models: [...models] },
    ...Object.fromEntries(['luna', 'sonnet'].map(name => [name, { configured: Boolean(providers[name]), models: providers[name] ? [providers[name].model] : [] }])) });
  async function refreshDue() {
    if (!configured || !jev?.listModels || now() < next) return snapshot();
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      try { const incoming = await jev.listModels(); models = [...new Set(['jev-1.13.0', 'jev-1.14.0', SAFETY_PROTOCOL.model, ...incoming.filter(isJevModel)])].sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, 64); updatedAt = now(); status = 'current'; next = now() + 86400000; }
      catch { status = 'unavailable'; next = now() + 3600000; }
      return snapshot();
    }).finally(() => { pending = undefined; });
    return pending;
  }
  return { get: refreshDue, refreshDue };
}
