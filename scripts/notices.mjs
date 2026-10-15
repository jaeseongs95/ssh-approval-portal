import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export async function collectNotices(root = process.cwd()) {
  const records = new Map();
  const readOptional = async path => {
    try { return await readFile(path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  async function collectPackage(folder) {
    const text = await readOptional(join(folder, 'package.json'));
    if (text === null) return;
    const p = JSON.parse(text);
    let licenseText = null;
    for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
      licenseText = await readOptional(join(folder, file));
      if (licenseText !== null) break;
    }
    records.set(p.name + '@' + p.version, { name: p.name, version: p.version, license: p.license ?? 'See upstream package', repository: p.repository, licenseText });
    await collectModules(join(folder, 'node_modules'));
  }
  async function collectModules(folder) {
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
      const child = join(folder, entry.name);
      if (entry.name.startsWith('@')) {
        for (const scoped of await readdir(child, { withFileTypes: true })) {
          if (scoped.isDirectory()) await collectPackage(join(child, scoped.name));
        }
      } else await collectPackage(child);
    }
  }
  for (const base of [root, join(root, 'ui')]) {
    await collectModules(join(base, 'node_modules'));
    // Keep optional/platform-specific locked versions in the inventory even
    // when this build host did not install them. Their license text is explicit null.
    const lockText = await readOptional(join(base, 'package-lock.json'));
    if (lockText !== null) for (const [path, p] of Object.entries(JSON.parse(lockText).packages ?? {})) {
      if (!path.includes('node_modules/') || !p.version) continue;
      const name = p.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      const key = name + '@' + p.version;
      if (!records.has(key)) records.set(key, { name, version: p.version, license: p.license ?? 'See upstream package', licenseText: null });
    }
  }
  return [...records.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { root: { type: 'string' }, output: { type: 'string' } } });
  const root = resolve(values.root ?? '.');
  const records = await collectNotices(root);
  await writeFile(resolve(values.output ?? join(root, 'THIRD_PARTY_NOTICES.json')), JSON.stringify(records, null, 2) + '\n');
  console.log('Dependency notice records: ' + records.length);
}
