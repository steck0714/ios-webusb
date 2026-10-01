import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installNavigatorUsb } from '../src/core/install.ts';
import { fakeBridge, makeDom, wireDevice } from './helpers.ts';

const runtime = () => ({ transport: fakeBridge(), requestDevice: async () => wireDevice() });

test('installs navigator.usb as a locked-down property plus the constructors', () => {
  const { win } = makeDom();
  (win as any).USB = 'the page already owns this name';
  const r = installNavigatorUsb({ runtime: runtime(), variant: 'crx', win });
  assert.deepEqual(r, { installed: true, reason: 'installed' });

  const d = Object.getOwnPropertyDescriptor(win.navigator, 'usb')!;
  assert.deepEqual([d.configurable, d.writable, d.enumerable], [false, false, true]);
  assert.equal(Object.prototype.toString.call(win.navigator.usb), '[object USB]');
  assert.throws(() => { delete (win.navigator as any).usb; }, TypeError);

  assert.ok('USBDevice' in win && 'USBConnectionEvent' in win);
  assert.equal((win as any).USB, 'the page already owns this name', 'existing globals are never clobbered');
});

test('exposes __iosWebUSB for debugging, frozen, with bridgeInfo()', async () => {
  const { win } = makeDom();
  installNavigatorUsb({ runtime: runtime(), variant: 'shortcut', win });
  const info = (win as any).__iosWebUSB;
  assert.equal(info.variant, 'shortcut');
  assert.equal(info.protocolVersion, 0);
  assert.ok(Object.isFrozen(info));
  assert.deepEqual(await info.bridgeInfo(), { protocol: 0, server: 'fake', capabilities: [] });
});

test('a second install is refused', () => {
  const { win } = makeDom();
  installNavigatorUsb({ runtime: runtime(), variant: 'crx', win });
  assert.deepEqual(installNavigatorUsb({ runtime: runtime(), variant: 'crx', win }), { installed: false, reason: 'already-installed' });
});

test('yields to an existing navigator.usb unless forced (and only if replaceable)', () => {
  const { win } = makeDom();
  Object.defineProperty(win.navigator, 'usb', { value: { native: true }, configurable: true });
  assert.deepEqual(installNavigatorUsb({ runtime: runtime(), variant: 'crx', win }), { installed: false, reason: 'native-usb-present' });
  assert.deepEqual((win.navigator as any).usb, { native: true });
  assert.equal(installNavigatorUsb({ runtime: runtime(), variant: 'crx', win, force: true }).installed, true);

  const { win: locked } = makeDom();
  Object.defineProperty(locked.navigator, 'usb', { value: { native: true }, configurable: false });
  assert.deepEqual(installNavigatorUsb({ runtime: runtime(), variant: 'crx', win: locked, force: true }), { installed: false, reason: 'define-failed' });
});

test('refuses insecure contexts and pages whose Permissions-Policy disables usb', () => {
  const insecure = makeDom().win;
  Object.defineProperty(insecure, 'isSecureContext', { value: false });
  assert.deepEqual(installNavigatorUsb({ runtime: runtime(), variant: 'crx', win: insecure }), { installed: false, reason: 'insecure-context' });
  assert.ok(!('usb' in insecure.navigator));

  const blocked = makeDom().win;
  (blocked.document as any).permissionsPolicy = { allowsFeature: (f: string) => f !== 'usb' };
  assert.deepEqual(installNavigatorUsb({ runtime: runtime(), variant: 'crx', win: blocked }), { installed: false, reason: 'permissions-policy' });

  const allowed = makeDom().win;
  (allowed.document as any).permissionsPolicy = { allowsFeature: () => true };
  assert.equal(installNavigatorUsb({ runtime: runtime(), variant: 'crx', win: allowed }).installed, true);
});
