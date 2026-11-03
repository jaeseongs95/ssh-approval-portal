export class DesktopError extends Error {
  constructor(code, message = code) { super(message); this.name = 'DesktopError'; this.code = code; }
}
export const desktopFail = code => { throw new DesktopError(code); };

export function desktopBinding(value) {
  if (!value || typeof value.ownerId !== 'string' || !value.ownerId || value.ownerId.length > 256
    || typeof value.targetId !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(value.targetId)
    || typeof value.targetRevision !== 'string' || !/^[a-f0-9]{64}$/.test(value.targetRevision)
    || !Number.isSafeInteger(value.epoch) || value.epoch < 1) desktopFail('DESKTOP_INVALID_BINDING');
  return Object.freeze(Object.fromEntries(['ownerId', 'targetId', 'targetRevision', 'epoch'].map(key => [key, value[key]])));
}

export function desktopActions(actions, width, height) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 128) desktopFail('DESKTOP_INVALID_INPUT');
  let events = 0;
  return actions.map(action => {
    if (!action || typeof action !== 'object') desktopFail('DESKTOP_INVALID_INPUT');
    const keys = Object.keys(action);
    if (action.type === 'key' && keys.every(key => ['type', 'keysym', 'down'].includes(key))
      && Number.isInteger(action.keysym) && action.keysym > 0 && action.keysym <= 0x1fffffff && typeof action.down === 'boolean'
      && ++events <= 4096) return { type: 'key', keysym: action.keysym, down: action.down };
    if (action.type === 'pointer' && keys.every(key => ['type', 'x', 'y', 'buttons'].includes(key))
      && Number.isInteger(action.x) && action.x >= 0 && action.x < width
      && Number.isInteger(action.y) && action.y >= 0 && action.y < height
      && Number.isInteger(action.buttons) && action.buttons >= 0 && action.buttons <= 255
      && ++events <= 4096) return { type: 'pointer', x: action.x, y: action.y, buttons: action.buttons };
    if (action.type === 'text' && keys.every(key => ['type', 'text'].includes(key))
      && typeof action.text === 'string' && action.text.length > 0 && action.text.length <= 2048 && action.text.isWellFormed()) {
      events += [...action.text].length * 2;
      if (events <= 4096) return { type: 'text', text: action.text };
    }
    desktopFail('DESKTOP_INVALID_INPUT');
  });
}
