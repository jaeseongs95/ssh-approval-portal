import { createHash } from 'node:crypto';
import { COMMAND_MAX_BYTES, utf8WithinLimit } from '../contracts/ports.mjs';

const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
export const hash = value => createHash('sha256').update(value).digest('hex');
export const idValid = id => typeof id === 'string' && /^[a-f0-9]{48}$/.test(id);

/** Shell formatting is visible input, not a reason to change its transport bytes.
 * Only TAB, LF and paired CRLF are allowed; paths retain the strict HIDDEN rule.
 */
export const commandTextValid = command => utf8WithinLimit(command, COMMAND_MAX_BYTES)
  && Boolean(command.trim()) && !HIDDEN.test(command.replace(/\r\n|\n|\t/g, ''));

/** Validate command syntax before consulting the injected SSH policy classifier. */
export function validateCommand(command, classify, safeOnly = false) {
  if (!commandTextValid(command)) throw Error('Invalid command');
  const classified = classify(command);
  // A classifier that trims its input cannot prove the whole multiline program
  // read-only. Keep it on the normal request/policy path, including trailing LF.
  const result = /[\r\n]/.test(command) && classified.class === 'read-only' ? { ...classified, class: 'safe' } : classified;
  if (safeOnly && result.class !== 'safe') throw Error('Only safe-class commands are supported');
  return result;
}

export function remotePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path === '/' || path.length > 4096 || path !== path.trim() || HIDDEN.test(path) || path.split('/').some(p => p === '..' || p === '.')) throw Error('Use an absolute regular-file path without dot segments or hidden characters');
  return path;
}

export function windowsRemotePath(path) {
  if (typeof path !== 'string' || !/^[A-Za-z]:[\\/]/.test(path) || path.length > 4096 || path !== path.trim() || HIDDEN.test(path)) throw Error('Use an absolute Windows regular-file path');
  const segments = path.slice(3).split(/[\\/]/);
  if (segments.some(part => !part || part === '.' || part === '..' || /[<>:"|?*]/.test(part) || /[ .]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part))) throw Error('Use a Windows regular-file path without reserved names or unsafe segments');
  return path;
}

/** Clients and the shared artifact store accept either target's path syntax. */
export function anyRemotePath(path) {
  return typeof path === 'string' && /^[A-Za-z]:/.test(path) ? windowsRemotePath(path) : remotePath(path);
}

export function remoteBasename(path, platform = 'linux') {
  if (!['linux', 'windows'].includes(platform)) throw Error('Unsupported remote platform');
  (platform === 'windows' ? windowsRemotePath : remotePath)(path);
  return path.replace(/\/+$/, '').split(platform === 'windows' ? /[\\/]/ : '/').at(-1);
}
