import {randomBytes} from 'node:crypto';
import {lstatSync, realpathSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createMaintenanceState} from './maintenance-state.mjs';
import {capturePreservationSnapshot} from './preservation-verification.mjs';

function openReadOnly(path) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    let info;
    try { info = lstatSync(path + suffix); } catch (error) { if (suffix && error.code === 'ENOENT') continue; throw error; }
    if (suffix) throw Error('Database sidecar prevents offline baseline');
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (process.platform !== 'win32' && ((info.mode & 0o077) || info.uid !== process.getuid()))) throw Error('Unsafe offline database');
  }
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    db.exec('PRAGMA query_only=ON');
    const result = db.prepare('PRAGMA integrity_check').all();
    if (result.length !== 1 || result[0].integrity_check !== 'ok') throw Error('Offline database integrity check failed');
    return db;
  } catch (error) { db.close(); throw error; }
}

function schema(db) { return db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name').all(); }
function journal(db, cli) {
  return {preservationRows() {
    const extra = cli ? '+coalesce(length(CAST(remote_status AS BLOB)),0)' : '';
    const usage = db.prepare(`SELECT count(*) AS count,coalesce(sum(length(CAST(body AS BLOB))${extra}),0) AS bytes FROM requests`).get();
    if (usage.count > 10000 || usage.bytes > 64 * 1024 * 1024) throw Error('Offline journal budget exceeded');
    return {schema: schema(db), ...(cli ? {} : {policy: db.prepare('SELECT * FROM policy ORDER BY id').all()}), requests: db.prepare('SELECT * FROM requests ORDER BY id').all()};
  }};
}

// Disabled automation must still retain a readable view of its existing journal.
export function openDormantCommandState(root) {
  const path = join(root, 'command-automation.sqlite');
  try { lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const db = openReadOnly(path);
  return { ...journal(db, false), close: () => db.close() };
}

/** Run as the bridge account after independent proof of clean service stop. */
export function prepareOfflinePreservationBaseline({root, owner, commandEnabled, cliEnabled, now = Date.now()}) {
  if (typeof root !== 'string' || !/^[a-f0-9]{64}$/.test(owner ?? '') || typeof commandEnabled !== 'boolean' || typeof cliEnabled !== 'boolean') throw Error('Invalid offline preservation input');
  const absolute = resolve(root), info = lstatSync(absolute);
  if (realpathSync(absolute) !== absolute || !info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && ((info.mode & 0o077) || info.uid !== process.getuid()))) throw Error('Unsafe offline root');
  const opened = [];
  const db = path => { const connection = openReadOnly(path); opened.push(connection); return connection; };
  try {
    const commandPath = join(absolute, 'command-automation.sqlite');
    let commandExists = true;
    try { lstatSync(commandPath); } catch (error) { if (error.code !== 'ENOENT') throw error; commandExists = false; }
    const command = commandEnabled || commandExists ? journal(db(commandPath), false) : null;
    const cli = cliEnabled ? journal(db(join(absolute, 'agent-cli.sqlite')), true) : null;
    const outputRoot = join(absolute, 'command-outputs');
    const outInfo = lstatSync(outputRoot);
    if (realpathSync(outputRoot) !== outputRoot || !outInfo.isDirectory() || outInfo.isSymbolicLink() || (process.platform !== 'win32' && ((outInfo.mode & 0o077) || outInfo.uid !== process.getuid()))) throw Error('Unsafe offline output root');
    const outputDb = db(join(outputRoot, 'manifest.sqlite'));
    const outputs = {root: outputRoot, preservationRows() {
      const usage = outputDb.prepare('SELECT count(*) AS count,coalesce(sum(length(CAST(body AS BLOB))),0) AS bytes FROM outputs').get();
      if (usage.count > 1000 || usage.bytes > 64 * 1024 * 1024) throw Error('Offline output budget exceeded');
      return {schema: schema(outputDb), outputs: outputDb.prepare('SELECT id,body,digest,charge FROM outputs ORDER BY id').all()};
    }};
    const snapshot = capturePreservationSnapshot({commandState: command, cliState: cli, outputs, now});
    const maintenance = createMaintenanceState(absolute);
    try {
      maintenance.reserve(owner);
      maintenance.saveBaseline(owner, {instance: 'offline:' + randomBytes(32).toString('hex'), snapshot});
    } finally { maintenance.close(); }
    return {status: 'PREPARED', commandEnabled, cliEnabled};
  } finally { for (const connection of opened.reverse()) connection.close(); }
}
