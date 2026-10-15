import { validateOrigin, settingsContract } from '../src/adapters/config/settings.mjs';

// One Node24/WHATWG authority for both runtime configuration and Python deployment tools.
if (process.versions.node.split('.')[0] !== '24') {
  console.error('Origin validation failed.');
  process.exitCode = 1;
} else if (import.meta.main) {
  try {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > settingsContract.originMaxBytes) throw Error('Input too large');
      chunks.push(chunk);
    }
    const value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    process.stdout.write(validateOrigin(value));
  } catch {
    console.error('Origin validation failed.');
    process.exitCode = 1;
  }
}
