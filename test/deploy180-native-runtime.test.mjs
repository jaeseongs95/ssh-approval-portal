import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, chown, readFile, writeFile, lstat, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const rootLinux = process.platform === 'linux' && process.getuid() === 0 && process.arch === 'x64';
const deployUrl = new URL('../scripts/deploy180.mjs', import.meta.url).href;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, { corrupt = false, unsupported = false } = {}) {
  const uid = spawnSync('/usr/bin/id', ['-u', 'mcpbridge'], { encoding: 'utf8' });
  const gid = spawnSync('/usr/bin/id', ['-g', 'mcpbridge'], { encoding: 'utf8' });
  if (uid.status || gid.status) { t.skip('requires the TEST mcpbridge service account'); return; }
  const identity = { uid: Number(uid.stdout), gid: Number(gid.stdout) };
  assert.notEqual(identity.uid, 0);
  const root = await mkdtemp(join(tmpdir(), 'portal-native-deploy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);
  const sourceDir = join(root, 'source'), dataRoot = join(root, 'data');
  await mkdir(sourceDir); await mkdir(dataRoot); await chmod(dataRoot, 0o700); await chown(dataRoot, identity.uid, identity.gid);
  const files = {
    'package.json': JSON.stringify({ name: 'native-deploy-fixture', version: '2.0.0', type: 'module' }),
    'package-lock.json': '{}', 'bridge.mjs': 'export {};',
    'app.mjs': `import {value} from './node_modules/fixture/entry.mjs';import fs from 'node:fs';` +
      (unsupported ? '' : `fs.accessSync(new URL('./native/freerdp-input/runtime/bin/xfreerdp3',import.meta.url),fs.constants.R_OK|fs.constants.X_OK);` +
        `if(fs.readFileSync(new URL('./native/freerdp-input/runtime/lib/libfixture.so.3',import.meta.url),'utf8')!=='fixture library')throw Error('runtime bytes');`) +
      `export function createApplication(){return value;}`,
    'scripts/check-package-imports.mjs': await readFile(new URL('../scripts/check-package-imports.mjs', import.meta.url)),
    'scripts/prepare-freerdp-input.py': await readFile(new URL('../scripts/prepare-freerdp-input.py', import.meta.url)),
    'scripts/windows-file-helper.ps1': '# fixture', 'scripts/windows-file-native.cs': '// fixture',
    'scripts/install-windows-helper.ps1': '# fixture', 'config/settings-contract.json': '{}',
    'ui/dist/card.html': '<html></html>', 'web/dist/app.js': 'export {};',
    'deploy/oidc/Caddyfile': '# fixture', 'deploy/oidc/oauth2-proxy.cfg': '# fixture', 'src/fixture.mjs': 'export {};',
  };
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(sourceDir, path)), { recursive: true });
    await writeFile(join(sourceDir, path), bytes); await chmod(join(sourceDir, path), 0o644);
  }
  const build = `import pathlib,tarfile,io,json,hashlib,re,sys\n` +
    `root=pathlib.Path(sys.argv[1]);(root/'vendor').mkdir()\n` +
    `files={'bin/xfreerdp3':b'#!/bin/sh\\nexit 93\\n','lib/libfixture.so.3':b'fixture library','licenses/FreeRDP-LICENSE':b'fixture license'}\n` +
    `manifest={'format':'portal.freerdp-native.v1','upstreamVersion':'3.32.1','upstreamCommit':'bf217a504e54cc719880c228e82353382cd7d4fa','patchSha256':'a'*64,'executable':'bin/xfreerdp3','files':[{'path':p,'size':len(b),'sha256':hashlib.sha256(b).hexdigest(),'mode':493 if p.startswith('bin/') else 420} for p,b in files.items()]}\n` +
    (corrupt ? `manifest['files'][0]['sha256']='0'*64\n` : '') +
    `archive=root/'vendor/fixture-native.tgz'\nwith tarfile.open(archive,'w:gz') as out:\n` +
    ` for p,b in {**{'runtime/'+p:b for p,b in files.items()},'runtime/manifest.json':json.dumps(manifest).encode(),'source/upstream.tar.gz':b'archived source'}.items():\n` +
    `  m=tarfile.TarInfo(p);m.size=len(b);m.mode=493 if p=='runtime/bin/xfreerdp3' else 420;out.addfile(m,io.BytesIO(b))\n` +
    `script=root/'scripts/prepare-freerdp-input.py';text=script.read_text();text=re.sub(r'^BUNDLE_PATH = .*$',"BUNDLE_PATH = 'vendor/fixture-native.tgz'",text,flags=re.M);text=re.sub(r'^BUNDLE_SHA256 = .*$', 'BUNDLE_SHA256 = '+repr(hashlib.sha256(archive.read_bytes()).hexdigest()),text,flags=re.M)\n` +
    (unsupported ? `text=text.replace('print(json.dumps(prepare()))','print(json.dumps(prepare(machine="aarch64")))')\n` : '') +
    `script.write_text(text)\n`;
  const built = spawnSync('/usr/bin/python3', ['-I', '-B', '-c', build, sourceDir], { encoding: 'utf8', timeout: 10000 });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const entries = [];
  async function scan(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await scan(join(folder, entry.name), name + '/');
      else { const bytes = await readFile(join(folder, entry.name)); entries.push({ path: name, size: bytes.length, sha256: digest(bytes) }); }
    }
  }
  await scan(sourceDir);
  const manifest = JSON.stringify({ version: '2.0.0', files: entries });
  await writeFile(join(sourceDir, 'release-manifest.json'), manifest); await chmod(join(sourceDir, 'release-manifest.json'), 0o644);
  const npmExecutable = join(root, 'fixture-npm');
  await writeFile(npmExecutable, `#!${process.execPath}\nconst fs=require('node:fs');` +
    `if(fs.existsSync('native/freerdp-input/runtime'))process.exit(73);` +
    `fs.mkdirSync('node_modules/fixture',{recursive:true});fs.writeFileSync('node_modules/fixture/entry.mjs','export const value=42;');`);
  await chmod(npmExecutable, 0o755);
  const plan = { generation: digest(manifest), sourceDir, appRoot: join(root, 'app'), activePath: join(root, 'app/current'), dataRoot, npmExecutable,
    healthUrl: 'http://127.0.0.1:39999/health', service: { stop: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'stop-called'))},'stop')`],
      start: [process.execPath, '-e', 'process.exit(0)'], status: [process.execPath, '-e', 'process.exit(3)'] } };
  const planPath = join(root, 'plan.json'); await writeFile(planPath, JSON.stringify(plan));
  return { root, plan, planPath, identity, release: join(plan.appRoot, 'releases', plan.generation) };
}
function stage(f) {
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    `import{readFile}from'node:fs/promises';const{runDeployment}=await import(process.argv[2]);process.umask(0o077);` +
    `try{console.log(JSON.stringify(await runDeployment('stage',JSON.parse(await readFile(process.argv[1],'utf8')))))}catch(e){console.log(JSON.stringify({code:e.code}));process.exitCode=1;}`,
    f.planPath, deployUrl], { encoding: 'utf8', timeout: 30000 });
}

test('stage prepares private runtime after npm under umask077 and real service imports succeed; repeated stage only reuses', { skip: !rootLinux }, async t => {
  const f = await fixture(t); if (!f) return;
  const result = stage(f); assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).nativeRuntime.status, 'prepared');
  const runtime = join(f.release, 'native/freerdp-input/runtime'), before = await lstat(runtime);
  for (const [name, mode] of [['', 0o755], ['bin', 0o755], ['lib', 0o755], ['licenses', 0o755], ['bin/xfreerdp3', 0o755], ['lib/libfixture.so.3', 0o644]]) {
    assert.equal((await lstat(join(runtime, name))).mode & 0o777, mode, name);
  }
  const imports = spawnSync(process.execPath, [join(f.release, 'scripts/check-package-imports.mjs')], { ...f.identity, cwd: f.release, encoding: 'utf8' });
  assert.equal(imports.status, 0, imports.stdout + imports.stderr);
  const repeated = stage(f); assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).nativeRuntime.status, 'reused');
  assert.equal((await lstat(runtime)).ino, before.ino);
  await assert.rejects(lstat(join(f.root, 'stop-called')), { code: 'ENOENT' });
});

test('runtime integrity failure stops staging before release publication and never stops the existing service', { skip: !rootLinux }, async t => {
  const f = await fixture(t, { corrupt: true }); if (!f) return;
  const result = stage(f); assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).code, 'FREERDP_RUNTIME_HASH_MISMATCH');
  await assert.rejects(lstat(f.release), { code: 'ENOENT' });
  await assert.rejects(lstat(join(f.root, 'stop-called')), { code: 'ENOENT' });
});

test('unsupported native architecture produces a skip receipt while ordinary server staging and imports succeed', { skip: !rootLinux }, async t => {
  const f = await fixture(t, { unsupported: true }); if (!f) return;
  const result = stage(f); assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).nativeRuntime.status, 'skipped');
  assert.equal(JSON.parse(result.stdout).nativeRuntime.reason, 'UNSUPPORTED_NATIVE_PLATFORM');
  await assert.rejects(lstat(join(f.release, 'native/freerdp-input/runtime')), { code: 'ENOENT' });
});
