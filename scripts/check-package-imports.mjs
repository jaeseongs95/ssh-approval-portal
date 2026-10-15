// Import the composition graph from the extracted package after production npm ci.
// Importing app.mjs must remain free of listeners and secret-file reads.
const { createApplication } = await import(new URL('../app.mjs', import.meta.url));
if (typeof createApplication !== 'function') throw Error('Missing application composition entrypoint');
console.log('Packaged application imports resolved');
