import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const root = process.argv[2];
if (!root) throw Error('Source directory required');
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw Error('Invalid release version');
const hash = createHash('sha256').update(readFileSync(resolve(root, 'release-manifest.json'))).digest('hex');
console.log(version + '-' + hash.slice(0, 16));
