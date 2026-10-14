import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative } from 'node:path';
const root = resolve(process.argv[2] ?? '.');
const manifest = JSON.parse(await readFile(resolve(root, 'release-manifest.json'), 'utf8'));
if (manifest.version !== '0.3.0' || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('Invalid release manifest');
for (const file of manifest.files) {
  if (typeof file.path !== 'string' || file.path.includes('\\') || file.path.startsWith('/') || file.path.split('/').some(x => !x || x === '..' || x === '.')) throw Error('Invalid manifest path');
  const full = resolve(root, file.path);
  if (relative(root, full).startsWith('..')) throw Error('Manifest path escaped');
  for (let parent = full; parent !== root; parent = dirname(parent)) if ((await lstat(parent)).isSymbolicLink()) throw Error('Release contains a symlink');
  const st = await lstat(full); if (!st.isFile()) throw Error('Expected regular package file');
  const bytes = await readFile(full), digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== file.sha256 || bytes.length !== file.size) throw Error('Release digest mismatch: ' + file.path);
}
console.log('Release manifest verified: ' + manifest.files.length + ' files');
