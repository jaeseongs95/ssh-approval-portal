import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, chown, lstat, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { prepareDeploymentMigration } from '../scripts/deploy180.mjs';

const rootLinux = process.platform === 'linux' && process.getuid() === 0;
const release = fileURLToPath(new URL('../', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
function serviceIdentity(t) {
  const query = flag => spawnSync('/usr/bin/id', [flag, 'mcpbridge'], { encoding: 'utf8', timeout: 5000 });
  const uid = query('-u'), gid = query('-g');
  if (uid.status !== 0 || gid.status !== 0 || !/^\d+\s*$/.test(uid.stdout) || !/^\d+\s*$/.test(gid.stdout)) {
    t.skip('requires the TEST mcpbridge service account'); return null;
  }
  assert.notEqual(Number(uid.stdout), 0, 'the migration child must run as an unprivileged service uid');
  return { uid: Number(uid.stdout), gid: Number(gid.stdout) };
}
async function fixture(t) {
  const identity = serviceIdentity(t); if (!identity) return null;
  const root = await mkdtemp(join(tmpdir(), 'portal-archive-permissions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);
  const appRoot = join(root, 'app'), dataRoot = join(root, 'data');
  await mkdir(appRoot); await chmod(appRoot, 0o755);
  await mkdir(join(appRoot, 'deployments'), { mode: 0o700 });
  await mkdir(dataRoot, { mode: 0o700 }); await chmod(dataRoot, 0o700);
  const source = join(dataRoot, 'command-automation.sqlite'), db = new DatabaseSync(source);
  try {
    db.exec('CREATE TABLE requests(id TEXT PRIMARY KEY,body TEXT NOT NULL,digest TEXT NOT NULL,request_key TEXT UNIQUE);');
    const insert = db.prepare('INSERT INTO requests VALUES(?,?,?,?)');
    for (const [index, state] of ['completed', 'running'].entries()) {
      const job = { id: String(index + 1).repeat(48), kind: 'command', state, createdAt: 10 + index };
      insert.run(job.id, JSON.stringify(job), digest(JSON.stringify(job)), 'original:' + job.id);
    }
  } finally { db.close(); }
  await chmod(source, 0o600); await chown(source, identity.uid, identity.gid);
  await chown(dataRoot, identity.uid, identity.gid);
  return { root, appRoot, dataRoot, source, identity, generation: 'a'.repeat(64), parent: join(appRoot, 'legacy-archives') };
}
async function migratePrivate(f) {
  const previous = process.umask(0o077);
  try { return await prepareDeploymentMigration(f, release); }
  finally { process.umask(previous); }
}

for (const existingParent of [false, true]) test(`root umask077 migration traverses ${existingParent ? 'an existing root0700' : 'a newly created'} archive parent as the real service uid`, { skip: !rootLinux }, async t => {
  const f = await fixture(t); if (!f) return;
  let previousLeaf, previousFile, previousIdentity;
  if (existingParent) {
    await mkdir(f.parent, { mode: 0o700 }); await chmod(f.parent, 0o700);
    previousLeaf = join(f.parent, 'b'.repeat(64)); await mkdir(previousLeaf, { mode: 0o700 });
    await chmod(previousLeaf, 0o700); await chown(previousLeaf, f.identity.uid, f.identity.gid);
    previousFile = join(previousLeaf, 'preserved-failure.json'); await writeFile(previousFile, 'original failure evidence\n', { mode: 0o400 });
    previousIdentity = await lstat(previousLeaf);
  }
  const before = await readFile(f.source), receipt = await migratePrivate(f);
  assert.equal(receipt.imported, 2); assert.equal(receipt.unknown, 1);
  assert.deepEqual(await readFile(f.source), before, 'original legacy bytes must remain exact');
  const parent = await lstat(f.parent), archiveRoot = join(f.parent, f.generation), leaf = await lstat(archiveRoot);
  assert.equal(parent.uid, 0); assert.equal(parent.mode & 0o777, 0o711);
  assert.equal(leaf.uid, 0); assert.equal(leaf.mode & 0o777, 0o700);
  const archive = join(archiveRoot, 'command-automation.sqlite'), archived = await lstat(archive);
  assert.equal(archived.uid, 0); assert.equal(archived.mode & 0o777, 0o400);
  assert.deepEqual(await readFile(archive), before);
  if (existingParent) {
    const preserved = await lstat(previousLeaf);
    for (const key of ['ino', 'dev', 'uid', 'gid', 'mode']) assert.equal(preserved[key], previousIdentity[key]);
    assert.equal(await readFile(previousFile, 'utf8'), 'original failure evidence\n');
  }
  const check = spawnSync(process.execPath, ['-e', 'const fs=require("node:fs");const{DatabaseSync}=require("node:sqlite");const p=require("node:path");const db=new DatabaseSync(p.join(process.argv[1],"operations.sqlite"),{readOnly:true});try{if(db.prepare("SELECT count(*) AS n FROM operations").get().n!==2)process.exit(2)}finally{db.close()}fs.accessSync(process.argv[2],fs.constants.X_OK);try{fs.readdirSync(process.argv[2]);process.exit(3)}catch(e){if(e.code!=="EACCES")throw e}', f.dataRoot, f.parent],
    { ...f.identity, timeout: 10000, encoding: 'utf8' });
  assert.equal(check.status, 0, 'service uid must read its imported journal and traverse, but not list, the archive parent');
});

for (const unsafe of ['writable', 'foreign-owner', 'symlink']) test(`migration refuses an ${unsafe} archive parent without normalizing unrelated ownership or permissions`, { skip: !rootLinux }, async t => {
  const f = await fixture(t); if (!f) return;
  const before = await readFile(f.source);
  let observed = f.parent;
  if (unsafe === 'symlink') {
    observed = join(f.root, 'unrelated'); await mkdir(observed, { mode: 0o700 }); await chmod(observed, 0o700);
    await symlink(observed, f.parent);
  } else {
    await mkdir(f.parent, { mode: 0o700 });
    if (unsafe === 'writable') await chmod(f.parent, 0o777);
    else await chown(f.parent, f.identity.uid, f.identity.gid);
  }
  const original = await lstat(observed);
  await assert.rejects(migratePrivate(f), { code: 'UNSAFE_LEGACY_ARCHIVE' });
  const after = await lstat(observed);
  assert.equal(after.uid, original.uid); assert.equal(after.gid, original.gid); assert.equal(after.mode, original.mode);
  assert.deepEqual(await readFile(f.source), before);
  await assert.rejects(lstat(join(f.dataRoot, 'operations.sqlite')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(observed, f.generation)), { code: 'ENOENT' });
});
