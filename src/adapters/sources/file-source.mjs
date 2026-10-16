import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Transform } from 'node:stream';
import { matchesUploadHost, validateUploadHostPattern } from '../config/upload-hosts.mjs';

const refused = () => Error('File source refused, expired or unavailable');
const dnsName = name => typeof name === 'string' && name.length <= 253 && name.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) && !isIP(name);
const denied = new BlockList(), globalV6 = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) denied.addSubnet(address, prefix, 'ipv4');
globalV6.addSubnet('2000::', 3, 'ipv6');
// Conservative global-unicast policy: exclude transition, protocol and documentation ranges.
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16], ['3fff::', 20]]) denied.addSubnet(address, prefix, 'ipv6');
const publicAddress = ({ address, family }) => isIP(address) === family && (family === 4 ? !denied.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !denied.check(address, 'ipv6'));

export function createFileSource({ hosts, maxBytes = 64 * 1024 * 1024, timeoutMs = 60_000, idleTimeoutMs = 15_000, resolve = lookup, request = httpsRequest }) {
  if (!Array.isArray(hosts) || ![maxBytes, timeoutMs, idleTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0)) throw refused();
  let allowed;
  try { allowed = hosts.map(validateUploadHostPattern); } catch { throw refused(); }
  const parse = value => {
    try {
      if (typeof value !== 'string' || value.length > 8192 || /[\s\\]/.test(value)) throw refused();
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || value.includes('#') || !/^https:\/\//i.test(value) || value.split(/[/?#]/)[2]?.includes('@') || !dnsName(url.hostname)) throw refused();
      return url;
    } catch { throw refused(); }
  };
  const provider = {
    bind(downloadUrl) {
      const policy = provider.inspect(downloadUrl);
      return Object.freeze({
        inspect: () => ({ sourceHost: policy.hostname, allowed: policy.allowed }),
        open: options => provider.open(downloadUrl, options),
      });
    },
    inspect(downloadUrl) { const url = parse(downloadUrl); return { hostname: url.hostname, allowed: matchesUploadHost(url.hostname, allowed) }; },
    async open(downloadUrl, { signal } = {}) {
      const url = parse(downloadUrl);
      if (!matchesUploadHost(url.hostname, allowed)) throw refused();
      return new Promise((accept, reject) => {
        let req, response, stream, timer, idle, settled = false, closed = false;
        const cleanup = () => {
          clearTimeout(timer); clearTimeout(idle); signal?.removeEventListener('abort', fail);
        };
        const close = () => {
          if (closed) return; closed = true; cleanup();
          response?.unpipe(stream); response?.destroy(); req?.destroy(); stream?.destroy();
        };
        const fail = () => {
          if (closed) return;
          if (!settled) { settled = true; reject(refused()); }
          stream?.destroy(refused()); close();
        };
        const touch = () => { clearTimeout(idle); idle = setTimeout(fail, idleTimeoutMs); };
        timer = setTimeout(fail, timeoutMs);
        signal?.addEventListener('abort', fail, { once: true });
        if (signal?.aborted) { fail(); return; }
        Promise.resolve().then(() => resolve(url.hostname, { all: true, order: 'verbatim' })).then(addresses => {
          if (closed) return;
          if (!Array.isArray(addresses) || !addresses.length || !addresses.every(publicAddress)) throw refused();
          const pinned = addresses[0];
          req = request(url, {
            method: 'GET', agent: false, rejectUnauthorized: true, servername: url.hostname,
            headers: { Host: url.hostname, 'Accept-Encoding': 'identity' }, maxHeaderSize: 16 * 1024,
            // No second DNS lookup or proxy agent may replace the validated address.
            lookup: (_hostname, options, callback) => callback(null, options?.all ? [pinned] : pinned.address, pinned.family),
          }, incoming => {
            response = incoming;
            if (closed) { incoming.destroy(); return; }
            try {
              const length = incoming.headers['content-length'];
              const expectedSize = length === undefined ? null : /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) ? Number(length) : NaN;
              if (incoming.statusCode !== 200 || (incoming.headers['content-encoding'] && incoming.headers['content-encoding'].toLowerCase() !== 'identity') || incoming.rawHeaders.length > 128 || (expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize > maxBytes))) throw refused();
              let received = 0;
              stream = new Transform({
                transform(bytes, _encoding, done) {
                  received += bytes.length; touch();
                  if (received > maxBytes || (expectedSize !== null && received > expectedSize)) done(refused());
                  else done(null, bytes);
                },
                flush(done) { done(expectedSize !== null && received !== expectedSize ? refused() : null); },
              });
              stream.on('error', fail); stream.on('close', close); stream.on('end', close);
              incoming.on('error', fail); incoming.on('aborted', fail);
              touch(); incoming.pipe(stream);
              settled = true; accept({ stream, expectedSize, close });
            } catch { fail(); }
          });
          // Keep every header within maxHeaderSize so the policy check cannot inspect a truncated list.
          req.on('error', fail); req.maxHeadersCount = 0;
          touch(); req.end();
        }).catch(fail);
      });
    },
  };
  return provider;
}
