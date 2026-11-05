import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopKeyActions, desktopPointerActions } from '../web/src/desktop.js';
import { createWebController } from '../web/src/controller.js';

test('desktop coordinates use framebuffer/CSS scaling once and complete pointer gestures release buttons', () => {
  const actions = desktopPointerActions({ clientX: 110, clientY: 70, button: 2 }, { left: 10, top: 20, width: 200, height: 100 }, 1600, 800);
  assert.deepEqual(actions, [{ type: 'pointer', x: 800, y: 400, buttons: 4 }, { type: 'pointer', x: 800, y: 400, buttons: 0 }]);
  assert.deepEqual(desktopPointerActions({ clientX: 999, clientY: -1, button: 0 }, { left: 0, top: 0, width: 100, height: 100 }, 1000, 500), [{ type: 'pointer', x: 999, y: 0, buttons: 1 }, { type: 'pointer', x: 999, y: 0, buttons: 0 }]);
  assert.deepEqual(desktopPointerActions({ button: 0 }, { width: 0, height: 10 }, 10, 10), []);
});

test('desktop shortcuts and Unicode use X11 keysyms and release every pressed key', () => {
  assert.deepEqual(desktopKeyActions({ key: 'c', ctrlKey: true }), [{ type: 'key', keysym: 0xffe3, down: true }, { type: 'key', keysym: 99, down: true }, { type: 'key', keysym: 99, down: false }, { type: 'key', keysym: 0xffe3, down: false }]);
  assert.equal(desktopKeyActions({ key: 'ArrowDown' })[0].keysym, 0xff54);
  assert.equal(desktopKeyActions({ key: '한' })[0].keysym, 0x01000000 + '한'.codePointAt(0));
  assert.deepEqual(desktopKeyActions({ key: 'Process', isComposing: true }), []);
  assert.deepEqual(desktopKeyActions({ key: 'Shift' }), []);
});

test('logout awaits desktop close while suppressing duplicate logout gestures', async () => {
  let release;
  const order = [], state = { signedOut: false, accessMode: true };
  const controller = createWebController({ state, view: { signedOut: () => order.push('signed-out') }, api: { endAdminSession: async () => order.push('app-session-ended') }, document: { body: { dataset: {} } }, location: { replace: path => order.push(path) }, beforeLogout: async () => { order.push('desktop-close'); await new Promise(resolve => { release = resolve; }); order.push('desktop-closed'); } });
  const first = controller.logout(); await controller.logout();
  assert.equal(state.signedOut, false); assert.deepEqual(order, ['desktop-close']);
  release(); await first;
  assert.deepEqual(order, ['desktop-close', 'desktop-closed', 'signed-out', 'app-session-ended', '/signed-out']);
});
