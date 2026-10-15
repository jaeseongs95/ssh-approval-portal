import { readFile } from 'node:fs/promises';
import { settingsContract } from './settings.mjs';

const allowed = new Set(settingsContract.allowedKeys);
export function parseSecretText(text) {
  const settings = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || (!allowed.has(match[1]) && !/^SSH_MCP_[A-Z0-9_]+$/.test(match[1]))) throw Error('Unsupported secret configuration entry');
    let value = match[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (/[\r\n\0]/.test(value)) throw Error('Invalid secret configuration value');
    settings[match[1]] = value;
  }
  return settings;
}

export async function loadSecrets(input = process.env, legacyFile) {
  const options = Object.hasOwn(input, 'env') || Object.hasOwn(input, 'file');
  const env = options ? input.env ?? process.env : input;
  const file = options ? input.file ?? env.BRIDGE_SECRET_ENV_FILE : legacyFile ?? env.BRIDGE_SECRET_ENV_FILE;
  return { ...env, ...(file ? parseSecretText(await readFile(file, 'utf8')) : {}) };
}
