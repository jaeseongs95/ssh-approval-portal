import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const records = new Map();
async function collect(root) {
  for (const name of await readdir(root)) {
    if (name.startsWith('.')) continue;
    const folders = name.startsWith('@') ? (await readdir(join(root, name))).map(x => join(root, name, x)) : [join(root, name)];
    for (const folder of folders) {
      let p; try { p = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')); } catch { continue; }
      let licenseText = null;
      for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
        try { licenseText = await readFile(join(folder, file), 'utf8'); break; } catch {}
      }
      records.set(p.name + '@' + p.version, { name: p.name, version: p.version, license: p.license ?? 'See upstream package', repository: p.repository, licenseText });
    }
  }
}
await collect('node_modules'); await collect('ui/node_modules');
await writeFile('THIRD_PARTY_NOTICES.json', JSON.stringify([...records.values()].sort((a, b) => a.name.localeCompare(b.name)), null, 2) + '\n');
