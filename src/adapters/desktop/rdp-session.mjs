import { randomUUID, createHash } from 'node:crypto';
import { desktopFail, DesktopError } from '../../domain/desktop-lease.mjs';
import { parseSecretReference } from '../../application/secret-service.mjs';
import { nativeRdpCapabilities, nativeRdpExecutable } from './rdp-runtime.mjs';

/** Explicit native capability plus the verified private executable, not stock help text. */
export const rdpClientCapabilities = input => Object.freeze(nativeRdpCapabilities(input));

function validatePlan(config, width, height) {
  try { parseSecretReference(config?.credentialRef); }
  catch { desktopFail('DESKTOP_INVALID_CONFIG'); }
  if (!Number.isInteger(width) || width < 320 || width > 4096
    || !Number.isInteger(height) || height < 200 || height > 4096 || width * height > 4_194_304) desktopFail('DESKTOP_INVALID_CONFIG');
}

/** Fixed application description for the managed-display helper. Contains no credentials. */
export function rdpSessionPlan({ config, endpoint, capabilities, width = 1280, height = 800 } = {}) {
  validatePlan(config, width, height);
  if (endpoint?.host !== '127.0.0.1' || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) desktopFail('DESKTOP_RDP_INVALID_TUNNEL');
  if (capabilities?.available !== true || capabilities.executable !== nativeRdpExecutable
    || !/^[a-f0-9]{64}$/.test(capabilities.executableSha256) || !/^[a-f0-9]{64}$/.test(capabilities.patchDigest)) desktopFail('DESKTOP_RDP_CLIENT_UNAVAILABLE');
  return Object.freeze({ kind: 'rdp', host: endpoint.host, port: endpoint.port,
    executable: capabilities.executable, executableSha256: capabilities.executableSha256,
    patchDigest: capabilities.patchDigest, certificateMode: 'ssh-tunnel', width, height });
}

/** /from-stdin:force consumes password before username/domain in FreeRDP 2; use /from-stdin.
 * Helper receives JSON privately and feeds the native client username/domain/password lines.
 * The caller must not log this bootstrap or attach stdout/stderr/PTY logging to the child.
 */
export async function writeRdpCredentialBootstrap(writable, credentials, signal) {
  const line = (value, empty = false) => typeof value === 'string' && (empty || value.length > 0)
    && value.isWellFormed() && Buffer.byteLength(value) <= 510 && !/[\u0000-\u001f\u007f]/.test(value);
  if (!line(credentials?.username) || !line(credentials?.domain, true) || !line(credentials?.password)
    || typeof writable?.write !== 'function') desktopFail('DESKTOP_RDP_CREDENTIAL_UNAVAILABLE');
  signal?.throwIfAborted();
  const bytes = Buffer.from(`${JSON.stringify({ username: credentials.username, domain: credentials.domain, password: credentials.password })}\n`);
  try {
    await new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); error ? reject(error) : resolve(); };
      const aborted = () => finish(new DesktopError('DESKTOP_RDP_CREDENTIAL_UNAVAILABLE'));
      const timer = setTimeout(aborted, 10000);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) return aborted();
      try { writable.write(bytes, error => finish(error ? new DesktopError('DESKTOP_RDP_CREDENTIAL_UNAVAILABLE') : undefined)); }
      catch { aborted(); }
    });
    signal?.throwIfAborted();
  } catch { desktopFail('DESKTOP_RDP_CREDENTIAL_UNAVAILABLE'); }
  finally { bytes.fill(0); }
}

/** Linux bridge-local Xvnc + native RDP client; Windows is reached through SSH loopback only.
 * openSession owns native process/display cleanup. This adapter owns the tunnel and bootstrap.
 * The existing pinned SSH connection authenticates the Windows host and its fixed loopback3389
 * endpoint. Only this mode delegates TLS identity checks to SSH; no raw-network fallback exists.
 */
export function createRdpSessionDesktopAdapter({ openSession, openTunnel, readClientCapabilities, credentialProvider,
  verifyServerIdentity, config, width = 1280, height = 800, ttlMs = 900_000, now = Date.now } = {}) {
  if (![openSession, openTunnel, readClientCapabilities, credentialProvider, verifyServerIdentity].every(value => typeof value === 'function')
    || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3_600_000) desktopFail('DESKTOP_INVALID_CONFIG');
  validatePlan(config, width, height);
  config = Object.freeze({ credentialRef: config.credentialRef });
  return {
    async open({ binding, signal } = {}) {
      signal?.throwIfAborted();
      let capabilities;
      try { capabilities = await readClientCapabilities({ binding, signal }); }
      catch { desktopFail('DESKTOP_RDP_CLIENT_UNAVAILABLE'); }
      if (capabilities?.available !== true) desktopFail(/^DESKTOP_RDP_[A-Z_]+$/.test(capabilities?.reason) ? capabilities.reason : 'DESKTOP_RDP_CLIENT_UNAVAILABLE');
      let tunnel, tunnelOpening, desktop, opening, closing, bootstrapUsed = false, closed = false;
      const controller = new AbortController();
      const sessionRef = `rdp:${randomUUID()}`;
      const resourceGeneration = createHash('sha256').update(sessionRef).digest('hex');
      const close = () => closing ??= (async () => {
        closed = true;
        if (!desktop) controller.abort();
        let outerSessionState = 'unknown', nativeInputState = 'unknown', nativeReleaseSent = false, cleanupError;
        if (!desktop && opening) { try { desktop = await opening; } catch { /* Open retains its error. */ } }
        try {
          if (desktop) {
            const receipt = await desktop.close();
            outerSessionState = receipt?.sessionState === 'terminated' ? 'terminated' : 'unknown';
            nativeInputState = receipt?.nativeInputState === 'detached' ? 'detached' : 'unknown';
            nativeReleaseSent = receipt?.nativeReleaseSent === true;
            if (receipt?.nativeInputState === 'unknown') cleanupError = 'DESKTOP_RDP_INPUT_DETACH_UNKNOWN';
            cleanupError ??= receipt?.cleanupError;
          }
        } catch { cleanupError = 'DESKTOP_RDP_DISPLAY_CLEANUP_FAILED'; }
        finally { controller.abort(); }
        if (!tunnel && tunnelOpening) { try { tunnel = await tunnelOpening; } catch { /* Open retains its error. */ } }
        try {
          const receipt = await tunnel?.close();
          if (receipt?.cleanupComplete === false) cleanupError ??= receipt.errorCode ?? 'DESKTOP_RDP_TUNNEL_CLEANUP_FAILED';
        } catch { cleanupError ??= 'DESKTOP_RDP_TUNNEL_CLEANUP_FAILED'; }
        signal?.removeEventListener('abort', abort);
        // Detaching a native client never proves that its Windows OS session was logged off.
        return { sessionState: 'unknown', remoteSessionState: 'unknown', outerSessionState,
          nativeInputState, nativeReleaseSent, logout: false, mode: 'detach', ...(cleanupError ? { cleanupError } : {}) };
      })();
      const abort = () => { controller.abort(); void close().catch(() => {}); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (signal?.aborted) abort();
        controller.signal.throwIfAborted();
        tunnelOpening = Promise.resolve(openTunnel({ binding, host: '127.0.0.1', port: 3389, signal: controller.signal }));
        tunnel = await tunnelOpening;
        controller.signal.throwIfAborted();
        const application = rdpSessionPlan({ config, endpoint: tunnel, capabilities, width, height });
        const identity = await verifyServerIdentity({ binding, endpoint: tunnel, application, signal: controller.signal });
        if (identity?.mode !== 'pinned-ssh-loopback' || identity.endpoint !== tunnel || identity.hostKeyVerified !== true
          || identity.remoteHost !== '127.0.0.1' || identity.remotePort !== 3389
          || typeof binding?.targetId !== 'string' || typeof binding?.targetRevision !== 'string'
          || identity.targetId !== binding.targetId || identity.targetRevision !== binding.targetRevision) desktopFail('DESKTOP_RDP_IDENTITY_UNVERIFIED');
        controller.signal.throwIfAborted();
        const writeBootstrap = async writable => {
          if (bootstrapUsed || closed) desktopFail('DESKTOP_RDP_CREDENTIAL_UNAVAILABLE');
          bootstrapUsed = true;
          let credentials;
          try {
            credentials = await credentialProvider({ credentialRef: config.credentialRef, binding, signal: controller.signal });
            await writeRdpCredentialBootstrap(writable, credentials, controller.signal);
          } catch { desktopFail('DESKTOP_RDP_CREDENTIAL_UNAVAILABLE'); }
          finally { credentials = undefined; }
        };
        opening = Promise.resolve(openSession({ binding, signal: controller.signal, width, height, ttlMs, application, writeBootstrap }));
        desktop = await opening;
        controller.signal.throwIfAborted();
        if (!bootstrapUsed || !desktop || !['observe', 'input', 'release', 'close'].every(key => typeof desktop[key] === 'function')) desktopFail('DESKTOP_RDP_INVALID_SESSION');
        return {
          lifecycle: 'managed', capabilities: { observe: true, pointer: true, key: true, text: true },
          get closed() { return closed || desktop.closed === true; },
          nativeReadiness: Object.freeze({ display: 'ready', client: 'started', windows: 'unverified' }),
          readState: async () => ({ state: 'transport_ready', observedAt: now(), generation: resourceGeneration,
            resourceGeneration, sessionRef, osSessionId: null, locked: null, sessionBindingVerified: false,
            displayBindingVerified: false, inputVerified: false, inputAllowed: true, ownerOnly: false,
            blockers: ['DESKTOP_SESSION_BINDING_UNVERIFIED'] }),
          observe: args => { if (closed) desktopFail('DESKTOP_CLOSED'); return desktop.observe(args); },
          input: actions => { if (closed) desktopFail('DESKTOP_CLOSED'); return desktop.input(actions); },
          release: () => desktop.release(), close,
        };
      } catch (error) {
        const receipt = await close();
        const safe = error instanceof DesktopError || error?.name === 'AbortError' ? error : new DesktopError('DESKTOP_RDP_OPEN_FAILED');
        if (receipt.cleanupError) safe.cleanupError = receipt.cleanupError;
        throw safe;
      }
    },
  };
}
