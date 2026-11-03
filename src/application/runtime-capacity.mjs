import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateCapacity } from '../adapters/config/capacity.mjs';

/** Durable administrator overrides. Installation defaults remain separate from live limits. */
export function createRuntimeCapacity({ root, settings, targets, scheduler, audit = () => {}, maintenance = () => false }) {
  const path = join(root, 'capacity.sqlite');
  try { closeSync(openSync(path, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.platform !== 'win32' && (stat.uid !== process.getuid() || stat.mode & 0o077))) throw Error('UNSAFE_CAPACITY_STORE');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS runtime_capacity (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);');
  const defaults = () => ({ revision: randomBytes(16).toString('hex'), settings: { queueCapacity: settings.queueCapacity, maxConcurrency: settings.maxConcurrency }, targets: targets.map(target => { const configured = settings.targets?.find(item => item.id === target.id); return { id: target.id, queueCapacity: configured?.queueCapacity ?? null, maxConcurrency: configured?.maxConcurrency ?? null }; }) });
  let value;
  try {
    const row = db.prepare('SELECT body FROM runtime_capacity WHERE id=1').get();
    value = row ? JSON.parse(row.body) : defaults();
    if (!row) db.prepare('INSERT INTO runtime_capacity VALUES (1,?)').run(JSON.stringify(value));
    validate(value);
    apply(value);
  } catch (error) { db.close(); throw error; }
  function validate(next) {
    validateCapacity(next.settings?.queueCapacity); validateCapacity(next.settings?.maxConcurrency);
    if (!Array.isArray(next.targets) || new Set(next.targets.map(target => target.id)).size !== next.targets.length) throw Error('INVALID_CAPACITY_TARGETS');
    for (const target of next.targets) {
      // Retain overrides for temporarily removed targets, without applying them.
      if (typeof target.id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(target.id)) throw Error('INVALID_CAPACITY_TARGET');
      for (const key of ['queueCapacity', 'maxConcurrency']) if (target[key] !== null) validateCapacity(target[key], key);
    }
  }
  function apply(next) {
    const overrides = new Map(next.targets.map(target => [target.id, target]));
    const limits = key => Object.fromEntries(targets.map(target => [target.id, overrides.get(target.id)?.[key] ?? next.settings[key]]));
    scheduler.configure({ queueCapacity: next.settings.queueCapacity, globalConcurrency: next.settings.maxConcurrency,
      targetQueueCapacity: limits('queueCapacity'), targetConcurrency: limits('maxConcurrency') });
  }
  function snapshot() {
    const counts = scheduler.snapshot(), jobs = scheduler.list?.() ?? [];
    return { revision: value.revision, availableCpus: settings.availableCpus, settings: { ...value.settings }, status: { queued: counts.queued, running: counts.active },
      targets: targets.map(target => { const override = value.targets.find(item => item.id === target.id);
        return { id: target.id, displayName: target.displayName, queueCapacity: override?.queueCapacity ?? null, maxConcurrency: override?.maxConcurrency ?? null,
          effective: { queueCapacity: override?.queueCapacity ?? value.settings.queueCapacity, maxConcurrency: override?.maxConcurrency ?? value.settings.maxConcurrency },
          status: { queued: jobs.filter(job => job.targetId === target.id && job.state === 'queued').length, running: jobs.filter(job => job.targetId === target.id && ['starting','running','terminating'].includes(job.state)).length } };
      }) };
  }
  return { get: snapshot,
    set(body) {
      if (maintenance()) throw Error('MAINTENANCE_ACTIVE');
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['expectedRevision','settings','targets'].includes(key))) throw Error('INVALID_CAPACITY_FIELDS');
      if (body.expectedRevision !== value.revision) throw Object.assign(Error('CAPACITY_REVISION_CONFLICT'), { code: 'CAPACITY_REVISION_CONFLICT' });
      const next = structuredClone(value);
      if (body.settings !== undefined) {
        if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings) || Object.keys(body.settings).some(key => !['queueCapacity','maxConcurrency'].includes(key))) throw Error('INVALID_CAPACITY_FIELDS');
        Object.assign(next.settings, body.settings);
      }
      if (body.targets !== undefined) {
        if (!Array.isArray(body.targets) || new Set(body.targets.map(target => target.id)).size !== body.targets.length) throw Error('INVALID_CAPACITY_TARGETS');
        for (const target of body.targets) {
          if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some(key => !['id','queueCapacity','maxConcurrency'].includes(key))) throw Error('INVALID_CAPACITY_FIELDS');
          if (!targets.some(known => known.id === target.id)) throw Error('UNKNOWN_CAPACITY_TARGET');
          const prior = next.targets.find(item => item.id === target.id);
          if (prior) Object.assign(prior, target); else next.targets.push({ queueCapacity: null, maxConcurrency: null, ...target });
        }
      }
      validate(next); next.revision = randomBytes(16).toString('hex');
      audit({ action: 'capacity-updated', priorRevision: value.revision, revision: next.revision });
      db.prepare('UPDATE runtime_capacity SET body=? WHERE id=1').run(JSON.stringify(next));
      value = next; apply(value); return snapshot();
    }, close() { db.close(); } };
}
