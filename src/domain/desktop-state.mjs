import { desktopFail } from './desktop-lease.mjs';

const states = ['transport_ready', 'auth_required', 'desktop_ready', 'capture_unavailable'];
const blockers = ['DESKTOP_AUTH_REQUIRED', 'DESKTOP_SESSION_BINDING_UNVERIFIED', 'DESKTOP_SESSION_QUERY_FAILED',
  'DESKTOP_SESSION_QUERY_UNSUPPORTED', 'DESKTOP_AUTH_BROKER_UNAVAILABLE', 'DESKTOP_CAPTURE_UNAVAILABLE'];

/** Status is supplied by a trusted host adapter, never by a desktop request. */
export function desktopState(value) {
  if (!value || !states.includes(value.state) || !Number.isSafeInteger(value.observedAt) || value.observedAt < 0
    || !Array.isArray(value.blockers) || value.blockers.length > 8 || value.blockers.some(code => !blockers.includes(code))
    || !['sessionBindingVerified', 'displayBindingVerified', 'inputVerified', 'inputAllowed', 'ownerOnly'].every(key => typeof value[key] === 'boolean')
    || !(value.generation === null || typeof value.generation === 'string' && /^[a-f0-9]{64}$/.test(value.generation))
    || !(value.osSessionId === null || Number.isSafeInteger(value.osSessionId) && value.osSessionId > 0)
    || !(value.locked === null || typeof value.locked === 'boolean')
    || !(value.sessionRef === undefined || value.sessionRef === null || typeof value.sessionRef === 'string' && /^[A-Za-z0-9_.:-]{1,256}(?![\s\S])/.test(value.sessionRef))
    || !(value.resourceGeneration === undefined || value.resourceGeneration === null || typeof value.resourceGeneration === 'string' && /^[a-f0-9]{64}$/.test(value.resourceGeneration))) desktopFail('DESKTOP_INVALID_STATE');
  if (value.state === 'desktop_ready' && (!value.sessionBindingVerified || !value.displayBindingVerified || !value.inputVerified
    || value.locked === true || !(value.sessionRef || value.osSessionId !== null && value.locked === false)
    || !(value.resourceGeneration || value.generation))) desktopFail('DESKTOP_INVALID_STATE');
  if (value.state === 'capture_unavailable' && value.inputAllowed) desktopFail('DESKTOP_INVALID_STATE');
  return Object.freeze(Object.fromEntries(['state', 'observedAt', 'generation', 'osSessionId', 'locked', 'sessionBindingVerified',
    'displayBindingVerified', 'inputVerified', 'inputAllowed', 'ownerOnly', 'blockers',
    ...['sessionRef', 'resourceGeneration'].filter(key => value[key] !== undefined)].map(key => [key, key === 'blockers' ? Object.freeze([...value[key]]) : value[key]])));
}

/** Existing backends keep their input contract; a handshake never attests desktop_ready. */
export function transportDesktopState(now = Date.now()) {
  return desktopState({ state: 'transport_ready', observedAt: now, generation: null, osSessionId: null, locked: null,
    sessionBindingVerified: false, displayBindingVerified: false, inputVerified: false, inputAllowed: true, ownerOnly: false,
    blockers: ['DESKTOP_SESSION_BINDING_UNVERIFIED'] });
}
