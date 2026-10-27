import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const [source, root] = process.argv.slice(2);
const owner = readFileSync(0, 'utf8').trim();
const {prepareOfflinePreservationBaseline} = await import(pathToFileURL(resolve(source,'src/adapters/storage/offline-preservation.mjs')));
if (prepareOfflinePreservationBaseline({root,owner,commandEnabled:false,cliEnabled:false}).status !== 'PREPARED') process.exitCode = 1;
