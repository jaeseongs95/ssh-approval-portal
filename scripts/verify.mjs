import { readFile, lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative } from 'node:path';

export async function verifyRelease(root) {
  root = resolve(root);
  const manifest = JSON.parse(await readFile(resolve(root, 'release-manifest.json'), 'utf8'));
  const metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (manifest.version !== metadata.version || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('Invalid release manifest');
  const paths = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || file.path.includes('\\') || file.path.startsWith('/') || file.path.split('/').some(x => !x || x === '..' || x === '.')) throw Error('Invalid manifest path');
    if (paths.has(file.path)) throw Error('Duplicate manifest path');
    paths.add(file.path);
    const full = resolve(root, file.path);
    if (relative(root, full).startsWith('..')) throw Error('Manifest path escaped');
    for (let parent = full; parent !== root; parent = dirname(parent)) if ((await lstat(parent)).isSymbolicLink()) throw Error('Release contains a symlink');
    const st = await lstat(full); if (!st.isFile()) throw Error('Expected regular package file');
    const bytes = await readFile(full), digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== file.sha256 || bytes.length !== file.size) throw Error('Release digest mismatch: ' + file.path);
  }
  for (const path of ['package.json', 'package-lock.json', 'bridge.mjs', 'app.mjs', 'scripts/check-package-imports.mjs', 'config/settings-contract.json', 'ui/dist/card.html', 'web/dist/app.js', 'deploy/oidc/Caddyfile', 'deploy/oidc/oauth2-proxy.cfg']) {
    if (!paths.has(path)) throw Error('Required package entry missing: ' + path);
  }
  async function checkSource(folder) {
    for (const entry of await readdir(resolve(root, folder), { withFileTypes: true })) {
      const path = folder + '/' + entry.name;
      if (entry.isSymbolicLink()) throw Error('Source contains a symlink');
      if (entry.isDirectory()) await checkSource(path);
      else if (/\.(mjs|json)$/.test(entry.name) && !paths.has(path)) throw Error('Source missing from manifest: ' + path);
    }
  }
  await checkSource('src');
  return manifest.files.length;
}

if (import.meta.main) {
  console.log('Release manifest verified: ' + await verifyRelease(process.argv[2] ?? '.') + ' files');
}
