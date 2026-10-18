import https from 'node:https';
import { SecretError, parseSecretReference } from '../../application/secret-service.mjs';
import { validateOrigin } from '../config/settings.mjs';

const MAX_BODY = 64 * 1024, DEADLINE_MS = 5000;

/** Read-only KV v2. Tokens come from the existing private local store, never this configuration. */
export function createVaultSecretStore({ origin, mount = 'secret', getToken }) {
  validateOrigin(origin);
  if (typeof mount !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(mount) || typeof getToken !== 'function') throw new SecretError('invalid_provider');
  async function record(name) {
    if (typeof name !== 'string') throw new SecretError('invalid_reference');
    parseSecretReference(`secret://vault/${name}`);
    let token;
    try { token = await getToken(); } catch { throw new SecretError('credential_unavailable'); }
    if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)) throw new SecretError('credential_unavailable');
    return new Promise((resolve, reject) => {
      let request, response, settled = false;
      const finish = (code, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        response?.destroy(); request?.destroy();
        if (code) reject(new SecretError(code)); else resolve(value);
      };
      // Absolute deadline covers DNS, TLS, headers and a peer that dribbles body bytes.
      const timer = setTimeout(() => finish('provider_unavailable'), DEADLINE_MS);
      try {
        request = https.get(`${origin}/v1/${mount}/data/${name}`, {
          agent: false, rejectUnauthorized: true, maxHeaderSize: 16 * 1024,
          headers: { 'X-Vault-Token': token, Accept: 'application/json' },
        }, incoming => {
          response = incoming;
          incoming.on('error', () => finish('provider_unavailable'));
          incoming.on('aborted', () => finish('provider_unavailable'));
          if (incoming.statusCode === 404) return finish(undefined, undefined);
          if (incoming.statusCode !== 200) return finish('provider_unavailable');
          if (incoming.headers['content-encoding'] || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(incoming.headers['content-type'] ?? '')) return finish('invalid_record');
          const length = incoming.headers['content-length'];
          if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) return finish('invalid_record');
          const chunks = []; let size = 0;
          incoming.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY) return finish('invalid_record');
            chunks.push(chunk);
          });
          incoming.on('end', () => {
            if (settled) return;
            try {
              const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))).data;
              const value = data?.data?.value, metadata = data?.metadata;
              if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 16384 || value.includes('\0') ||
                  !metadata || !Number.isSafeInteger(metadata.version) || metadata.version < 1 || metadata.destroyed !== false || metadata.deletion_time !== '' ||
                  typeof metadata.created_time !== 'string' || !Number.isFinite(Date.parse(metadata.created_time))) return finish('invalid_record');
              finish(undefined, { value, revision: String(metadata.version), updatedAt: metadata.created_time });
            } catch { finish('invalid_record'); }
          });
        });
        request.on('error', () => finish('provider_unavailable'));
      } catch { finish('provider_unavailable'); }
    });
  }
  return Object.freeze({
    async read(name) { return (await record(name))?.value; },
    async describe(name) { const item = await record(name); return item && { name, revision: item.revision, updatedAt: item.updatedAt }; },
    async put() { throw new SecretError('read_only'); },
    async remove() { throw new SecretError('read_only'); },
  });
}
