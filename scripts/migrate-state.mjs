import {DatabaseSync} from 'node:sqlite';
import {existsSync, lstatSync, readFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';
import {CommandOutputs} from '../src/adapters/storage/command-output.mjs';
import {validateCommandPolicy} from '../src/domain/command-policy.mjs';
import {requireStorageVersion} from '../src/adapters/storage/schema-version.mjs';

// Parsing failures must never echo an untrusted persisted body to a terminal.
process.on('uncaughtException', () => {
  process.stderr.write('Offline state conversion failed; destination is incomplete\n');
  process.exitCode = 1;
});

// Invoked only on a newly copied, stopped generation, under its service uid.
// CommandOutputs stores the already redacted adapter outcome without a raw
// presentation fallback. Reusing finish keeps its JSON/text/chunk contracts.
const contract = 'explicit-state-migration-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const [rootArg, nowArg] = process.argv.slice(2), root = resolve(rootArg ?? '');
const nowMs = Number(nowArg);
if (process.argv.length !== 4 || !rootArg || root !== rootArg || !Number.isSafeInteger(nowMs) || nowMs <= 0) throw Error('Invalid offline migration input');
const info = lstatSync(root);
if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && (info.uid !== process.getuid() || info.mode & 0o077)) throw Error('Unsafe migration generation');
const report = {contract, nowMs, terminalizedRequests: 0, legacyOutputs: []};
const opened = [];
let outputs;
try {
  outputs = new CommandOutputs(root, {now: () => nowMs, canReap: () => false});
  for (const name of ['command-automation.sqlite', 'agent-cli.sqlite']) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const db = new DatabaseSync(path); opened.push(db); requireStorageVersion(db);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL');
    if (name === 'command-automation.sqlite') validateCommandPolicy(JSON.parse(db.prepare('SELECT body FROM policy WHERE id=1').get().body));
    db.exec('BEGIN EXCLUSIVE');
    try {
      for (const row of db.prepare('SELECT id,body FROM requests ORDER BY id').all()) {
        const job = JSON.parse(row.body);
        let changed = false;
        if (job.kind === 'command' && job.result && !job.result.output) {
          if (typeof job.targetRevision !== 'string' || !/^[a-f0-9]{64}$/.test(job.targetRevision)
            || typeof (job.command ?? job.operation?.command) !== 'string') throw Error('Legacy result requires an explicit target binding');
          const original = job.result;
          // There was no legacy output TTL. Anchor the one-hour retention to
          // the original completion, never the deployment time.
          const expiresAt = (job.finishedAt ?? job.createdAt) + 3_600_000;
          if (!Number.isSafeInteger(expiresAt)) throw Error('Invalid legacy output expiry');
          const item = outputs.reserve({executionId: job.id, targetId: job.targetId ?? 'default', targetRevision: job.targetRevision,
            profile: job.profile, operationDigest: hash(job.command ?? job.operation.command)});
          const result = outputs.finish(item, original);
          if (item.state !== 'ready') throw Error('Legacy output publication failed');
          item.expiresAt = expiresAt; outputs.persist(item, item.size);
          job.result = {...result, output: outputs.describe(item)};
          const bytes = readFileSync(join(root, 'command-outputs', item.id + '.out'));
          if (!bytes.subarray(0, item.formats.json.bytes).equals(Buffer.from(JSON.stringify(original)))) throw Error('Legacy output verification failed');
          report.legacyOutputs.push({requestId: job.id, outputId: item.id}); changed = true;
        }
        if (['pending', 'running', 'evaluating'].includes(job.state)) {
          job.state = job.state === 'pending' ? 'expired' : 'unknown'; job.finishedAt = nowMs;
          report.terminalizedRequests++; changed = true;
        }
        if (changed) db.prepare('UPDATE requests SET body=? WHERE id=?').run(JSON.stringify(job), row.id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
} finally {
  for (const db of opened.reverse()) db.close();
  outputs?.close();
}
process.stdout.write(JSON.stringify(report));
