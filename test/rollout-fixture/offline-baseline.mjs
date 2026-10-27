// Executed as the bridge account. Owner is supplied on stdin; only public booleans use argv.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join, resolve} from 'node:path';
// Passed to node -e by the adapter: argv[1] is the first argument.
const [source, root, command, cli] = process.argv.slice(1);
if (!source || resolve(source) !== source) throw Error('Invalid source path');
const {prepareOfflinePreservationBaseline} = await import(pathToFileURL(join(source, 'src/adapters/storage/offline-preservation.mjs')).href);
if (!['true','false'].includes(command) || !['true','false'].includes(cli)) throw Error('Invalid journal configuration');
const owner = readFileSync(0, 'utf8').trim();
const result = prepareOfflinePreservationBaseline({root, owner, commandEnabled: command === 'true', cliEnabled: cli === 'true'});
if (result.status !== 'PREPARED') throw Error('Baseline not prepared');
console.log('Offline baseline prepared');
