import { createLocalSecretStore } from '../src/adapters/secrets/local-file.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
process.once('message', async ({ directory, value, interrupt }) => {
  if (interrupt) {
    const open = fs.open;
    fs.open = async (file, ...args) => {
      const handle = await open(file, ...args);
      if (path.basename(file).startsWith('.pending-')) handle.writeFile = async () => {
        await handle.write('partial'); process.send({ staged: true });
        await new Promise(() => {}); // The owning test kills this process at this staging point.
      };
      return handle;
    };
  }
  try { process.send({ ok: true, metadata: await createLocalSecretStore(directory).put('key', value) }); }
  catch (error) { process.send({ ok: false, code: ['store_busy', 'unsafe_record', 'unsafe_store'].includes(error.code) ? error.code : 'operation_failed' }); }
  finally { process.disconnect(); }
});
