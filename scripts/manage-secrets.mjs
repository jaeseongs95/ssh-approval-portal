#!/usr/bin/env node
import { createLocalSecretStore } from '../src/adapters/secrets/local-file.mjs';
import { readHiddenSecret } from '../src/adapters/secrets/hidden-input.mjs';
import { createSecretService, parseSecretReference, SecretError } from '../src/application/secret-service.mjs';

/** Management stays in the operator CLI; no HTTP/MCP operation returns values. */
export async function runSecretCommand(args, { readValue = readHiddenSecret, write = value => console.log(JSON.stringify(value)) } = {}) {
  const [option, directory, action, reference] = args;
  if (option !== '--store' || !directory || !['init', 'list', 'set', 'status', 'delete'].includes(action) || args.length !== (['init', 'list'].includes(action) ? 3 : 4)) throw new SecretError('invalid_arguments');
  const store = createLocalSecretStore(directory);
  const service = createSecretService({ 'local-file': store });
  if (reference && parseSecretReference(reference).provider !== 'local-file') throw new SecretError('provider_unavailable');
  if (action === 'init') { await store.init(); write({ initialized: true }); }
  else if (action === 'list') write({ secrets: (await store.list()).map(item => ({ reference: 'secret://local-file/' + item.name, revision: item.revision, updatedAt: item.updatedAt })) });
  else if (action === 'status') { const info = await service.describe(reference); write({ reference, present: Boolean(info), ...(info ? { revision: info.revision, updatedAt: info.updatedAt } : {}) }); }
  else if (action === 'delete') write({ reference, removed: (await service.remove(reference)).removed });
  else {
    const value = await readValue('Secret value (hidden): '), confirm = await readValue('Confirm value (hidden): ');
    if (value !== confirm) throw new SecretError('confirmation_mismatch');
    const info = await service.put(reference, value);
    write({ reference, stored: true, revision: info.revision, updatedAt: info.updatedAt, restartRequired: true });
  }
}

if (import.meta.main) {
  try { await runSecretCommand(process.argv.slice(2)); }
  catch (error) {
    const safeCodes = new Set(['invalid_arguments', 'invalid_reference', 'provider_unavailable', 'terminal_required', 'input_cancelled', 'confirmation_mismatch', 'unsafe_store', 'unsafe_record', 'unsupported_platform', 'invalid_record', 'invalid_value', 'store_busy', 'commit_uncertain']);
    console.error(JSON.stringify({ error: safeCodes.has(error?.code) ? error.code : 'operation_failed' }));
    process.exitCode = 1;
  }
}
