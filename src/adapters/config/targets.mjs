import { hash } from '../../domain/validation.mjs';

const alias = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
const label = value => typeof value === 'string' && value.trim() && value.length <= 80 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);

/** Administrator-owned startup configuration. Requests can select IDs, never SSH addresses. */
export function parseTargets(value, defaultTarget) {
  if (value === undefined || value === '') {
    if (defaultTarget) throw Error('A default target requires explicit target configuration');
    return null;
  }
  if (typeof value !== 'string' || Buffer.byteLength(value) > 65536) throw Error('Invalid target configuration');
  let entries;
  try { entries = JSON.parse(value); } catch { throw Error('Invalid target configuration'); }
  if (!Array.isArray(entries) || !entries.length || entries.length > 32) throw Error('Configure 1 to 32 targets');
  const ids = new Set(), profiles = new Set();
  const targets = entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['id', 'displayName', 'readProfile', 'writeProfile', 'credentialRevision', 'enabled'].includes(key)) ||
        !alias(entry.id) || ids.has(entry.id) || !label(entry.displayName) || !alias(entry.readProfile) || !alias(entry.writeProfile) ||
        entry.readProfile === entry.writeProfile || !alias(entry.credentialRevision) || (entry.enabled !== undefined && typeof entry.enabled !== 'boolean')) throw Error('Invalid or duplicate target configuration');
    for (const profile of [entry.readProfile, entry.writeProfile]) {
      if (profiles.has(profile)) throw Error('SSH profiles cannot be shared by targets');
      profiles.add(profile);
    }
    ids.add(entry.id);
    return Object.freeze({ ...entry, displayName: entry.displayName.trim(), enabled: entry.enabled !== false });
  });
  if (defaultTarget && (!alias(defaultTarget) || !targets.some(target => target.id === defaultTarget && target.enabled))) throw Error('Default target must name an enabled target');
  return Object.freeze(targets);
}

export function resolveTargets(settings, registry) {
  const explicit = settings.targets !== null;
  const entries = settings.targets ?? [{ id: 'default', displayName: settings.targetDisplayName, readProfile: settings.readProfile, writeProfile: settings.writeProfile, enabled: true }];
  const hosts = new Set(), pins = new Set();
  return entries.map(entry => {
    const reader = registry.getProfile(entry.readProfile), writer = registry.getProfile(entry.writeProfile);
    const shared = explicit ? ['host', 'port', 'user', 'trustedHostKey', 'via', 'auth', 'keyRef', 'keychainEntry'] : ['host', 'port', 'user'];
    if (!reader.readOnly || writer.readOnly || shared.some(key => reader[key] !== writer[key])) throw Error('Expected matching writable and read-only SSH targets');
    const host = `${writer.host}:${writer.port}`, target = `${writer.user}@${host}`;
    if (explicit && (typeof writer.trustedHostKey !== 'string' || !writer.trustedHostKey.trim() || hosts.has(host) || pins.has(writer.trustedHostKey))) throw Error('Targets require distinct SSH hosts and pinned host keys');
    hosts.add(host); pins.add(writer.trustedHostKey);
    // Credentials remain in the registry. Rotation requires a new administrator revision.
    const revision = hash(JSON.stringify({ entry, reader, writer }));
    const identity = explicit ? Object.freeze({ targetId: entry.id, targetRevision: revision, targetDisplayName: entry.displayName, hostKey: writer.trustedHostKey }) : undefined;
    const verify = () => {
      if (hash(JSON.stringify({ entry, reader: registry.getProfile(entry.readProfile), writer: registry.getProfile(entry.writeProfile) })) !== revision) throw Error('Target configuration changed; restart and request fresh approval');
    };
    return Object.freeze({ ...entry, target, identity, revision, verify });
  });
}
