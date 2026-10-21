import { createHash } from 'node:crypto';
import { COMMAND_MAX_BYTES, utf8WithinLimit } from '../contracts/ports.mjs';

const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
export const hash = value => createHash('sha256').update(value).digest('hex');
export const idValid = id => typeof id === 'string' && /^[a-f0-9]{48}$/.test(id);

/** Validate command syntax before consulting the injected SSH policy classifier. */
export function validateCommand(command, classify, safeOnly = false) {
  if (!utf8WithinLimit(command, COMMAND_MAX_BYTES) || !command.trim() || HIDDEN.test(command)) throw Error('Invalid command');
  const result = classify(command);
  if (safeOnly && result.class !== 'safe') throw Error('Only safe-class commands are supported');
  return result;
}

export function remotePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path === '/' || path.length > 4096 || path !== path.trim() || HIDDEN.test(path) || path.split('/').some(p => p === '..' || p === '.')) throw Error('Use an absolute regular-file path without dot segments or hidden characters');
  return path;
}
