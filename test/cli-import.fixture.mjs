import { pathToFileURL } from 'node:url';

const module = await import(pathToFileURL(process.argv[2]).href);
console.log(JSON.stringify({ imported: true, exports: Object.keys(module).sort() }));
