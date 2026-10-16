import { isIP } from 'node:net';

export const UPLOAD_HOSTS_MAX_BYTES = 65536;
const invalid = () => Error('Configure exact DNS hostnames or leading *.domain suffixes');

export function validateUploadHostPattern(value) {
  if (typeof value !== 'string') throw invalid();
  const wildcard = value.startsWith('*.'), host = wildcard ? value.slice(2) : value;
  if (!host || host.length > 253 || (wildcard && !host.includes('.')) ||
      !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw invalid();
  try {
    // WHATWG canonicalization also rejects numeric IP aliases (127.1, hex, octal).
    const parsed = new URL('https://' + host);
    if (isIP(parsed.hostname) || parsed.hostname !== host) throw invalid();
  } catch { throw invalid(); }
  return value;
}

export function parseUploadHosts(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > UPLOAD_HOSTS_MAX_BYTES || /[\r\n\0]/.test(value)) throw invalid();
  if (!value.trim()) return [];
  return [...new Set(value.split(',').map(entry => validateUploadHostPattern(entry.trim().toLowerCase())))];
}

export const matchesUploadHost = (hostname, patterns) => patterns.some(pattern => pattern.startsWith('*.')
  ? hostname.endsWith(pattern.slice(1)) && hostname.length > pattern.length - 1
  : hostname === pattern);
