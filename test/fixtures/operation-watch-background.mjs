import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { main } from '../../scripts/portal-files.mjs';

// TEST-only seam: actual packaged CLI main, watcher and owner session; synthetic
// credential/fetch only. No sockets, credential files or remote effects.
const origin = 'https://owner.example.test', token = 'synthetic.header.signature';
const id = 'a'.repeat(48), revision = 'b'.repeat(64);
const cookie = '__Host-ssh_admin_session=' + 'f'.repeat(64);

if (process.argv[2] === 'other') {
  process.stdout.write(['OTHER', 'DONE'].join('_') + '\n');
} else if (process.argv.length > 3 || ![undefined, 'watch'].includes(process.argv[2])) {
  process.stderr.write('{"error":"INVALID_FIXTURE_ARGUMENTS"}\n'); process.exitCode = 1;
} else {
  const originalFetch = globalThis.fetch;
  let reads = 0, credentials = 0, loggedOut = false;
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, origin); assert.equal(options.redirect, 'error');
    assert.equal(options.headers['cf-access-token'], token); assert.equal(options.headers.Origin, origin);
    if (parsed.pathname === '/api/session' && options.method === 'GET') return Response.json({ mode: 'access' });
    if (parsed.pathname === '/api/session/start' && options.method === 'POST') {
      assert.equal(options.body, '{}');
      return Response.json({ connected: true }, { headers: { 'Set-Cookie': cookie + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=60' } });
    }
    assert.equal(options.headers.Cookie, cookie);
    if (parsed.pathname === '/api/session/logout' && options.method === 'POST') {
      assert.equal(options.body, '{}'); loggedOut = true; return Response.json({ connected: false });
    }
    assert.equal(options.method, 'GET'); assert.equal(parsed.pathname, '/api/' + id);
    assert.equal(parsed.search, '?observe=1&waitMs=25000'); assert.equal(++reads, 1);
    await delay(15_000, undefined, { signal: options.signal });
    return Response.json({ contractVersion: '2.0', ok: true, error: null, data: {
      id, state: 'completed', targetId: 'fixture', targetRevision: revision,
      finishedAt: Date.now(), failed: false, auditFailure: false, failureCode: null,
      execution: { exitCode: 0, reason: 'exit' }, remoteOutcome: 'completed', output: { state: 'ready' },
    } });
  };
  const credential = (executable, args) => {
    assert.equal(executable, process.execPath);
    assert.deepEqual(args, ['access', 'token', '--app=' + origin]);
    assert.equal(++credentials, 1); return token;
  };
  try {
    process.exitCode = await main(['--origin', origin, '--cloudflared', process.execPath, 'watch', id, '--timeout-ms', '30000'],
      process.stdout, process.stderr, credential);
    assert.equal(process.exitCode, 0); assert.equal(reads, 1); assert.equal(credentials, 1); assert.equal(loggedOut, true);
  } catch {
    // Never print assertion bodies, request headers, tokens or private paths.
    process.stderr.write('{"error":"BACKGROUND_FIXTURE_FAILED"}\n'); process.exitCode = 1;
  } finally { globalThis.fetch = originalFetch; }
}
