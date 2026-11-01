// Fixed offline entry point. The root worker proves stop and supplies only
// its retained owner, selected generation, service uid/gid, and frozen time.
import {readFileSync, lstatSync, realpathSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {loadSecrets} from '../src/adapters/config/secrets.mjs';
import {parseSettings} from '../src/adapters/config/settings.mjs';
import {createMaintenanceState} from '../src/adapters/storage/maintenance-state.mjs';
import {capturePreservationSnapshot, comparePreservationSnapshots, baselinePreservationAccepted} from '../src/adapters/storage/preservation-verification.mjs';
import {openDormantCommandState} from '../src/adapters/storage/offline-preservation.mjs';

const [ownerFile, inputRoot, uidText, gidText, timeText, action = 'capture'] = process.argv.slice(2);
if (!['capture', 'verify'].includes(action)) throw Error('Invalid deployment baseline action');
const owner = readFileSync(ownerFile, 'utf8');
if (!/^[a-f0-9]{64}$/.test(owner) || !/^\d+$/.test(uidText) || !/^\d+$/.test(gidText) || !/^\d+$/.test(timeText)) throw Error('Invalid deployment baseline input');
const now = Number(timeText), uid = Number(uidText), gid = Number(gidText);
if (!Number.isSafeInteger(now) || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid <= 0) throw Error('Invalid deployment identity');
const env = await loadSecrets({}, process.env.BRIDGE_SECRET_ENV_FILE ?? '/etc/ssh-mcp-approval-bridge.env');
const settings = parseSettings(env);
process.setgroups([gid]); process.setgid(gid); process.setuid(uid);
if (process.getuid() !== uid || process.getgid() !== gid) throw Error('Identity drop failed');
const root = resolve(inputRoot), info = lstatSync(root);
if (realpathSync(root) !== root || !info.isDirectory() || info.uid !== uid || info.mode & 0o077) throw Error('Unsafe generation');
const opened = [];
function database(path) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    let st;
    try { st = lstatSync(path + suffix); } catch (error) { if (suffix && error.code === 'ENOENT') continue; throw error; }
    if (suffix || !st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== uid || st.mode & 0o077) throw Error('Unsafe offline database');
  }
  const db = new DatabaseSync(path, {readOnly:true}); opened.push(db);
  db.exec('PRAGMA query_only=ON');
  const check = db.prepare('PRAGMA integrity_check').all();
  if (check.length !== 1 || check[0].integrity_check !== 'ok') throw Error('Offline integrity failed');
  return db;
}
const schema = db => db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name').all();
try {
  const commandState = openDormantCommandState(root);
  if (commandState) opened.push(commandState);
  if (settings.commandAutomation && !commandState) throw Error('Enabled command state missing');
  let cliState;
  try {
    lstatSync(join(root, 'agent-cli.sqlite'));
    const db = database(join(root, 'agent-cli.sqlite'));
    cliState = {preservationRows() {
      const usage = db.prepare('SELECT count(*) AS count,coalesce(sum(length(CAST(body AS BLOB))+coalesce(length(CAST(remote_status AS BLOB)),0)),0) AS bytes FROM requests').get();
      if (usage.count > 10000 || usage.bytes > 64*1024*1024) throw Error('Journal budget exceeded');
      return {schema:schema(db), requests:db.prepare('SELECT * FROM requests ORDER BY id').all()};
    }};
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const outputRoot = join(root, 'command-outputs');
  const outputInfo = lstatSync(outputRoot);
  if (realpathSync(outputRoot) !== outputRoot || !outputInfo.isDirectory() || outputInfo.uid !== uid || outputInfo.mode & 0o077) throw Error('Unsafe output root');
  const outputDb = database(join(outputRoot, 'manifest.sqlite'));
  const outputs = {root:outputRoot, preservationRows() {
    const usage = outputDb.prepare('SELECT count(*) AS count,coalesce(sum(length(CAST(body AS BLOB))),0) AS bytes FROM outputs').get();
    if (usage.count > 1000 || usage.bytes > 64*1024*1024) throw Error('Output budget exceeded');
    return {schema:schema(outputDb), outputs:outputDb.prepare('SELECT id,body,digest,charge FROM outputs ORDER BY id').all()};
  }};
  const snapshot = capturePreservationSnapshot({commandState, cliState, outputs, now});
  const maintenance = createMaintenanceState(root);
  try {
    if (action === 'capture') {
      if (!maintenance.owns(owner)) maintenance.reserve(owner);
      if (maintenance.baseline(owner) !== null) throw Error('Baseline already exists; reconcile the retained job');
      maintenance.saveBaseline(owner, {instance:'offline:' + randomBytes(32).toString('hex'), snapshot});
    } else {
      const baseline = maintenance.baseline(owner);
      if (!baseline || !baselinePreservationAccepted(comparePreservationSnapshots(baseline.snapshot, snapshot))) throw Error('Offline generation changed after baseline');
    }
  } finally { maintenance.close(); }
  console.log(JSON.stringify({status:action === 'capture' ? 'PREPARED' : 'VERIFIED'}));
} finally { for (const item of opened.reverse()) item.close(); }
