import { hash } from '../../domain/validation.mjs';
import { desktopFail as fail } from '../../domain/desktop-lease.mjs';
import { createRfbDesktopAdapter } from './rfb.mjs';
import { createLinuxSessionDesktopAdapter } from './linux-session.mjs';
import { createRdpSessionDesktopAdapter } from './rdp-session.mjs';
import { readNativeRdpCapabilities } from './rdp-runtime.mjs';
import { openLocalDesktopProcess } from './local-process.mjs';
import { openDesktopTunnel } from './ssh-tunnel.mjs';

export { readNativeRdpCapabilities } from './rdp-runtime.mjs';
const backendOf = runtime => runtime.desktop?.backend ?? 'rfb';

/** Concrete GUI backends. Target addresses, helpers and secrets never come from an agent request. */
export function createTargetDesktops({ targets, registry, openDesktopChannel, openDesktopProcessChannel,
  resolver, maintenance, openLocalProcess = openLocalDesktopProcess, readRdpCapabilities = readNativeRdpCapabilities }) {
  const select = binding => {
    const runtime = targets.select(binding.targetId); runtime.verify();
    if (runtime.revision !== binding.targetRevision) fail('DESKTOP_STALE_TARGET');
    if (runtime.desktop?.enabled !== true) fail('DESKTOP_UNAVAILABLE');
    if (maintenance()) fail('MAINTENANCE_ACTIVE');
    return runtime;
  };
  const guard = binding => async () => { select(binding); };
  const trustedTunnels = new WeakMap();
  const adapter = {
    async open({ binding, signal }) {
      const runtime = select(binding), config = runtime.desktop, backend = backendOf(runtime);
      const width = config.width ?? 1280, height = config.height ?? 720;
      if (backend === 'rfb') {
        if (!openDesktopChannel) fail('DESKTOP_BACKEND_UNAVAILABLE');
        return createRfbDesktopAdapter({ allowNoneSecurity: true, openChannel: () =>
          openDesktopChannel(runtime.writeProfile, { host: '127.0.0.1', port: config.port, signal, beforeDispatch: guard(binding) })
        }).open({ binding, signal });
      }
      if (backend === 'xvnc') {
        if (!openDesktopProcessChannel) fail('DESKTOP_BACKEND_UNAVAILABLE');
        return createLinuxSessionDesktopAdapter({ width, height,
          openSession: ({ command }) => openDesktopProcessChannel(runtime.writeProfile,
            { command, signal, beforeDispatch: guard(binding) }) }).open({ binding, signal });
      }
      return createRdpSessionDesktopAdapter({ config, width, height,
        readClientCapabilities: readRdpCapabilities,
        openTunnel: async ({ signal: tunnelSignal }) => {
          select(binding);
          const profile = registry.getProfile(runtime.writeProfile);
          if (!openDesktopChannel || typeof profile.trustedHostKey !== 'string' || !profile.trustedHostKey.trim()) fail('DESKTOP_RDP_IDENTITY_UNVERIFIED');
          // Establish the pinned SSH channel before attesting its identity or requesting a credential.
          const first = await openDesktopChannel(runtime.writeProfile, { host: '127.0.0.1', port: 3389,
            signal: tunnelSignal, beforeDispatch: guard(binding) });
          let tunnel, unused = first;
          try {
            select(binding);
            tunnel = await openDesktopTunnel({ signal: tunnelSignal, beforeDispatch: guard(binding),
              openChannel: async options => {
                select(binding);
                if (unused) { const value = unused; unused = null; return value; }
                return openDesktopChannel(runtime.writeProfile, options);
              } });
            const close = tunnel.close;
            tunnel.close = async () => { try { return await close(); } finally { await first.close(); } };
            trustedTunnels.set(tunnel, { targetId: runtime.id, targetRevision: runtime.revision });
            return tunnel;
          } catch (error) { await first.close(); throw error; }
        },
        verifyServerIdentity: async ({ endpoint }) => {
          const bound = trustedTunnels.get(endpoint); select(binding);
          if (!bound || bound.targetId !== binding.targetId || bound.targetRevision !== binding.targetRevision) fail('DESKTOP_RDP_IDENTITY_UNVERIFIED');
          return { mode: 'pinned-ssh-loopback', endpoint, hostKeyVerified: true,
            remoteHost: '127.0.0.1', remotePort: 3389, ...bound };
        },
        credentialProvider: async ({ credentialRef }) => {
          select(binding);
          try {
            const value = JSON.parse(await resolver.resolve(credentialRef));
            if (!value || typeof value !== 'object' || Array.isArray(value)
                || Object.keys(value).some(key => !['username', 'domain', 'password'].includes(key))) fail('DESKTOP_RDP_CREDENTIAL_UNAVAILABLE');
            return { ...value, domain: value.domain ?? '' };
          } catch { fail('DESKTOP_RDP_CREDENTIAL_UNAVAILABLE'); }
        },
        openSession: ({ application, writeBootstrap, ...args }) => createLinuxSessionDesktopAdapter({ ...args,
          application, writeBootstrap, openSession: ({ command, signal: localSignal, nativeInput }) =>
            openLocalProcess({ command, signal: localSignal, nativeInput, beforeDispatch: guard(binding) }) }).open({ binding, signal }),
      }).open({ binding, signal });
    },
  };
  return { adapter,
    async capabilities(binding) {
      const runtime = targets.select(binding.targetId); runtime.verify();
      if (runtime.revision !== binding.targetRevision) fail('DESKTOP_STALE_TARGET');
      const backend = backendOf(runtime), configured = runtime.desktop?.enabled === true;
      const native = configured && backend === 'rdp' && openDesktopChannel ? await readRdpCapabilities() : null;
      const available = configured && (backend === 'rfb' ? Boolean(openDesktopChannel)
        : backend === 'xvnc' ? Boolean(openDesktopProcessChannel) : native?.available === true);
      return { configured, backend: configured ? backend : null, lifecycle: configured ? backend === 'rfb' ? 'attached' : 'managed' : null,
        status: !configured ? 'disabled' : available ? 'configured' : 'backend_unavailable',
        reason: configured && !available ? backend === 'rdp'
          ? /^DESKTOP_RDP_[A-Z_]+$/.test(native?.reason) ? native.reason : 'DESKTOP_RDP_CLIENT_UNAVAILABLE'
          : 'DESKTOP_BACKEND_UNAVAILABLE' : null,
        actions: configured ? ['observe', 'pointer', 'key', 'text'] : [], requiresUserClient: false };
    },
    leaseKey(binding) {
      const runtime = select(binding), profile = registry.getProfile(runtime.writeProfile), backend = backendOf(runtime);
      // Managed Linux displays are separate resources; existing displays and Windows accounts are exclusive.
      return hash(JSON.stringify([profile.trustedHostKey, backend,
        backend === 'xvnc' ? [binding.ownerId, binding.epoch] : backend === 'rdp' ? 3389 : runtime.desktop.port]));
    },
  };
}
