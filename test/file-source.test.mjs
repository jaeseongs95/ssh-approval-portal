import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { PassThrough, Readable } from 'node:stream';
import { createFileSource } from '../file-source.mjs';

// Component plan: inspect/open -> URL/SSRF, pinned transport, byte bounds, lifecycle,
// generic errors. Injected DNS/HTTPS remove real DNS, TLS and host integration.
const hostname = 'files.example.test', url = `https://${hostname}/file?signature=SECRET_URL`;
const generic = 'File source refused, expired or unavailable';
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const rejection = error => { assert.equal(error.message, generic); return true; };
function fixture({ status = 200, headers = {}, chunks = [Buffer.from([0, 255, 1])], rawHeaders = [], headerDelay = 0, respond = true, bodyError = false, ...config } = {}) {
  let options, requestCount = 0, destroyed = 0, incoming;
  const source = createFileSource({ hosts: [hostname], resolve: publicDns, timeoutMs: 1000, idleTimeoutMs: 1000, ...config,
    request: (_url, settings, callback) => {
      options = settings; requestCount++;
      const req = new EventEmitter();
      req.destroy = () => { destroyed++; };
      req.end = () => {
        if (!respond) return;
        setTimeout(() => {
          incoming = chunks === null ? new PassThrough() : Readable.from(chunks);
          Object.assign(incoming, { statusCode: status, headers, rawHeaders });
          callback(incoming);
          if (bodyError) queueMicrotask(() => incoming.destroy(Error('SECRET_URL SECRET_BODY')));
        }, headerDelay);
      };
      return req;
    },
  });
  return { source, options: () => options, count: () => requestCount, destroyed: () => destroyed, incoming: () => incoming };
}
const collect = async stream => { const chunks = []; for await (const bytes of stream) chunks.push(bytes); return Buffer.concat(chunks); };

test('inspect is offline, requires exact allowed host and rejects ambiguous or unsafe URLs', async () => {
  let dnsCalls = 0;
  const source = createFileSource({ hosts: [hostname], resolve: () => { dnsCalls++; throw Error('unexpected'); }, request: () => { throw Error('unexpected'); } });
  assert.deepEqual(source.inspect(url), { hostname, allowed: true });
  for (const host of ['other.example.test', 'files.example.test.evil.test', 'evilfiles.example.test']) {
    assert.deepEqual(source.inspect(`https://${host}/`), { hostname: host, allowed: false });
    await assert.rejects(source.open(`https://${host}/`), rejection);
  }
  for (const value of ['http://files.example.test/', 'https://files.example.test:444/', 'https://user:pass@files.example.test/', 'https://@files.example.test/', 'https://files.example.test/#', 'https://files.example.test./', 'https://127.0.0.1/', 'https://2130706433/', 'https://[::1]/', ' https://files.example.test/', 'https://files.example.test\\@evil.test/', 'https://files.example.test/\nSECRET_URL']) {
    assert.throws(() => source.inspect(value), rejection);
    await assert.rejects(source.open(value), rejection);
  }
  assert.equal(dnsCalls, 0);
  const disabled = createFileSource({ hosts: [] });
  assert.equal(disabled.inspect(url).allowed, false); await assert.rejects(disabled.open(url), rejection);
  assert.throws(() => createFileSource({ hosts: ['*.example.test'] }), rejection);
});

test('all DNS answers must be public, including mapped and transition IPv6', async () => {
  const addresses = ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.0.0.1', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::808:808', '2001::1', '2001:db8::1', '2002:808:808::1', '3ffe::1', '3fff::1'];
  for (const address of addresses) {
    const f = fixture({ resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }] });
    await assert.rejects(f.source.open(url), rejection); assert.equal(f.count(), 0, address);
  }
  for (const answers of [[], [{ address: '8.8.8.8', family: 6 }], [{ address: 'not-an-ip', family: 4 }]]) {
    const f = fixture({ resolve: async () => answers }); await assert.rejects(f.source.open(url), rejection); assert.equal(f.count(), 0);
  }
});

test('transport preserves host/TLS, pins the validated DNS address and returns raw binary', async () => {
  let dnsCalls = 0;
  const f = fixture({ headers: { 'content-length': '3' }, resolve: async (host, settings) => { dnsCalls++; assert.equal(host, hostname); assert.equal(settings.all, true); return [{ address: '2606:4700:4700::1111', family: 6 }]; } });
  const opened = await f.source.open(url), settings = f.options();
  assert.equal(settings.method, 'GET'); assert.equal(settings.agent, false); assert.equal(settings.rejectUnauthorized, true); assert.equal(settings.servername, hostname);
  assert.deepEqual(settings.headers, { Host: hostname, 'Accept-Encoding': 'identity' }); assert.equal(settings.maxHeaderSize, 16384);
  const pinned = await new Promise((accept, reject) => settings.lookup(hostname, { all: true }, (err, values) => err ? reject(err) : accept(values)));
  assert.deepEqual(pinned, [{ address: '2606:4700:4700::1111', family: 6 }]);
  const single = await new Promise((accept, reject) => settings.lookup(hostname, {}, (err, address, family) => err ? reject(err) : accept({ address, family })));
  assert.deepEqual(single, pinned[0]); assert.equal(dnsCalls, 1);
  assert.equal(opened.expectedSize, 3); assert.deepEqual(await collect(opened.stream), Buffer.from([0, 255, 1]));
  opened.close(); opened.close(); assert.equal(f.destroyed(), 1);
});

test('redirects, status, encodings, oversized headers and untrusted content lengths fail before exposure', async () => {
  for (const config of [{ status: 302, headers: { location: 'http://127.0.0.1/SECRET_URL' } }, { status: 401 }, { status: 206 }, { headers: { 'content-encoding': 'gzip' } }, { rawHeaders: Array(130).fill('x') }, { headers: { 'content-length': '4' }, maxBytes: 3 }, { headers: { 'content-length': '-1' } }, { headers: { 'content-length': '1e2' } }, { headers: { 'content-length': '9007199254740992' } }]) {
    const f = fixture(config); await assert.rejects(f.source.open(url), rejection); assert.equal(f.count(), 1); assert.equal(f.destroyed(), 1);
  }
});

test('stream limits measure actual bytes and reject truncated or excess payloads', async () => {
  for (const config of [{ maxBytes: 2 }, { headers: { 'content-length': '2' } }, { headers: { 'content-length': '4' } }, { bodyError: true, chunks: null }]) {
    const f = fixture(config), opened = await f.source.open(url);
    await assert.rejects(collect(opened.stream), rejection); assert.equal(f.destroyed(), 1);
  }
  for (const headers of [{}, { 'content-length': '0', 'content-encoding': 'identity' }]) {
    const f = fixture({ headers, chunks: [] }), opened = await f.source.open(url);
    assert.equal(opened.expectedSize, headers['content-length'] === '0' ? 0 : null); assert.equal((await collect(opened.stream)).length, 0);
  }
});

test('deadline and caller abort cover unresolved DNS without creating a request', async () => {
  for (const abort of [false, true]) {
    let finishDns;
    const f = fixture({ timeoutMs: 30, resolve: () => new Promise(accept => { finishDns = accept; }) });
    const controller = new AbortController(), opening = f.source.open(url, { signal: controller.signal });
    if (abort) setTimeout(() => controller.abort(Error('SECRET_URL')), 5);
    await assert.rejects(opening, rejection);
    finishDns([{ address: '8.8.8.8', family: 4 }]); await new Promise(accept => setImmediate(accept)); assert.equal(f.count(), 0);
  }
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.source.open(url, { signal: controller.signal }), rejection); assert.equal(f.count(), 0);
});

test('header/body stalls, cancellation and explicit close release the request once', async () => {
  const noHeaders = fixture({ respond: false, idleTimeoutMs: 20 }); await assert.rejects(noHeaders.source.open(url), rejection); assert.equal(noHeaders.destroyed(), 1);
  for (const abort of [false, true]) {
    const f = fixture({ chunks: null, idleTimeoutMs: 30 }), controller = new AbortController();
    const opened = await f.source.open(url, { signal: controller.signal }), reading = collect(opened.stream);
    if (abort) controller.abort(Error('SECRET_URL'));
    await assert.rejects(reading, rejection); assert.equal(f.destroyed(), 1);
  }
  const f = fixture({ chunks: null }), opened = await f.source.open(url); opened.close(); opened.close();
  assert.equal(opened.stream.destroyed, true); assert.equal(f.incoming().destroyed, true); assert.equal(f.destroyed(), 1);
});

test('total deadline stops a progressing body even while the idle deadline resets', async () => {
  const f = fixture({ chunks: null, timeoutMs: 80, idleTimeoutMs: 1000 }), opened = await f.source.open(url);
  const feeding = setInterval(() => f.incoming().write(Buffer.from('x')), 5);
  try { await assert.rejects(collect(opened.stream), rejection); assert.equal(f.destroyed(), 1); }
  finally { clearInterval(feeding); opened.close(); }
});

test('DNS/request exceptions never escape as raw source errors', async () => {
  for (const config of [{ resolve: async () => { throw Error(url); } }, { request: () => { throw Error(url); } }]) {
    const source = createFileSource({ hosts: [hostname], resolve: publicDns, ...config });
    await assert.rejects(source.open(url), rejection);
  }
  const source = createFileSource({ hosts: [hostname], resolve: publicDns, request: () => {
    const req = new EventEmitter(); req.destroy = () => {}; req.end = () => queueMicrotask(() => req.emit('error', Error(url))); return req;
  } });
  await assert.rejects(source.open(url), rejection);
});

test('real HTTP parser preserves policy checks across fragmented response headers', async t => {
  // Test-only transport seam: public DNS policy remains injected, while a real
  // HTTP client/parser connects to an ephemeral loopback TCP fixture. No TLS E2E.
  const fillers = count => Array.from({ length: count }, (_, index) => `X-Fixture-${index}: ok\r\n`).join('');
  async function response(first, last, verify) {
    let firstRead;
    const received = new Promise(accept => { firstRead = accept; });
    const sockets = new Set();
    const server = createNetServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.setNoDelay(true);
      socket.once('data', () => {
        socket.write(first);
        // Wait until the client receives the first bytes, then send the remaining
        // fields on another turn so Node takes its fragmented-header parser path.
        received.then(() => setImmediate(() => { if (!socket.destroyed) socket.end(last); }));
      });
    });
    await new Promise(accept => server.listen(0, '127.0.0.1', accept));
    const source = createFileSource({ hosts: [hostname], resolve: publicDns, maxBytes: 3, timeoutMs: 2000, idleTimeoutMs: 1000,
      request: (_url, settings, callback) => {
        const req = httpRequest({ method: settings.method, hostname: '127.0.0.1', port: server.address().port, path: '/', agent: false, headers: settings.headers, maxHeaderSize: settings.maxHeaderSize }, callback);
        req.on('socket', socket => socket.once('data', firstRead));
        return req;
      },
    });
    try { await verify(source); }
    finally { for (const socket of sockets) socket.destroy(); await new Promise(accept => server.close(accept)); }
  }
  const refuseAtHeaders = async source => {
    await assert.rejects(async () => {
      const opened = await source.open(url);
      opened.close();
    }, rejection);
  };
  await t.test('64 total headers permit an identity binary response', async () => {
    await response('HTTP/1.1 200 OK\r\n' + fillers(62), 'Content-Encoding: identity\r\nContent-Length: 3\r\n\r\nabc', async source => {
      const opened = await source.open(url);
      try { assert.equal(opened.expectedSize, 3); assert.deepEqual(await collect(opened.stream), Buffer.from('abc')); }
      finally { opened.close(); }
    });
  });
  await t.test('gzip after the first 64 headers is refused before exposure', async () => {
    await response('HTTP/1.1 200 OK\r\n' + fillers(64), 'Content-Encoding: gzip\r\nContent-Length: 3\r\n\r\nabc', refuseAtHeaders);
  });
  await t.test('excess content length after the first 64 headers is refused at headers', async () => {
    await response('HTTP/1.1 200 OK\r\n' + fillers(64), 'Content-Length: 4\r\n\r\nabcd', refuseAtHeaders);
  });
  await t.test('headers larger than 16 KiB are refused by the real parser', async () => {
    await response('HTTP/1.1 200 OK\r\nX-Large: ' + 'x'.repeat(17 * 1024), '\r\nContent-Length: 3\r\n\r\nabc', refuseAtHeaders);
  });
});
