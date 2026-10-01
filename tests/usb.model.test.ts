import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUsbApi, USB, USBConfiguration, USBConnectionEvent, USBDevice } from '../src/core/usb.ts';
import { createLocalPicker } from '../src/core/pick.ts';
import { fakeBridge, wireDevice } from './helpers.ts';

function setup(pick = true) {
  const t = fakeBridge();
  const chooser = { choose: async (c: any[]) => (pick ? c[0] ?? null : null) };
  const api = createUsbApi({ transport: t, requestDevice: createLocalPicker(t, chooser) });
  return { t, api, usb: api.usb };
}
async function opened() {
  const s = setup();
  const dev = await s.usb.requestDevice({ filters: [] });
  await dev.open();
  return { ...s, dev };
}
const bytes = (v: DataView | undefined): number[] => [...new Uint8Array(v!.buffer, v!.byteOffset, v!.byteLength)];
const SETUP = { requestType: 'vendor', recipient: 'device', request: 1, value: 0, index: 0 } as const;

test('navigator.usb looks like a WebUSB USB object', () => {
  const { usb } = setup();
  assert.ok(usb instanceof EventTarget);
  assert.ok(usb instanceof USB);
  assert.equal(Object.prototype.toString.call(usb), '[object USB]');
  assert.equal(usb.onconnect, null);
  assert.equal(usb.ondisconnect, null);
});

test('page code cannot construct the API objects ("Illegal constructor")', () => {
  assert.throws(() => new (USB as any)(), TypeError);
  assert.throws(() => new (USBDevice as any)(), TypeError);
});

test('requestDevice validates its argument like a browser', async () => {
  const { usb, t } = setup();
  await assert.rejects(usb.requestDevice(), TypeError);
  await assert.rejects(usb.requestDevice({} as any), TypeError);
  await assert.rejects(usb.requestDevice({ filters: [{ productId: 1 }] }), TypeError); // productId needs vendorId
  await assert.rejects(usb.requestDevice({ filters: [{ subclassCode: 1 }] }), TypeError);
  await assert.rejects(usb.requestDevice({ filters: [{ vendorId: '0x1209' as any }] }), TypeError);
  await assert.rejects(usb.requestDevice({ filters: [{ vendorId: 0x10000 }] }), TypeError);
  await assert.rejects(usb.requestDevice({ filters: 'x' as any }), TypeError);
  assert.deepEqual(t.methods(), [], 'nothing invalid may reach the bridge');
  await usb.requestDevice({ filters: [] }); // an empty filter list is legal: "show everything"
});

test('requestDevice: list -> choose -> grant, and a cancel is NotFoundError', async () => {
  const { usb, t } = setup();
  const dev = await usb.requestDevice({ filters: [{ vendorId: 0x1209 }], exclusionFilters: [{ classCode: 9 }] });
  assert.ok(dev instanceof USBDevice);
  assert.deepEqual(t.methods(), ['listAvailableDevices', 'grantDevice']);
  assert.deepEqual(t.calls[0]!.params, { filters: [{ vendorId: 0x1209 }], exclusionFilters: [{ classCode: 9 }] });

  const cancelled = setup(false);
  await assert.rejects(cancelled.usb.requestDevice({ filters: [] }), { name: 'NotFoundError' });
  assert.ok(!cancelled.t.methods().includes('grantDevice'));
});

test('requestDevice without user activation is a SecurityError (when the browser can tell)', async () => {
  const { usb, t } = setup();
  const nav = globalThis.navigator as any;
  Object.defineProperty(nav, 'userActivation', { value: { isActive: false }, configurable: true });
  try {
    await assert.rejects(usb.requestDevice({ filters: [] }), { name: 'SecurityError' });
    assert.deepEqual(t.methods(), []);
    Object.defineProperty(nav, 'userActivation', { value: { isActive: true }, configurable: true });
    await usb.requestDevice({ filters: [] });
    assert.equal(t.calls[0]!.meta?.hasGesture, true);
  } finally {
    delete nav.userActivation;
  }
});

test('getDevices returns the same USBDevice object every time', async () => {
  const { usb } = setup();
  const [a] = await usb.getDevices();
  const [b] = await usb.getDevices();
  assert.equal(a, b);
  assert.equal(await usb.requestDevice({ filters: [] }), a);
});

test('device lifecycle: open, configure, claim, alternate, release, close', async () => {
  const { usb, t } = setup();
  const dev = await usb.requestDevice({ filters: [{ vendorId: 0x1209 }] });
  assert.equal(dev.opened, false);
  await assert.rejects(dev.selectConfiguration(1), { name: 'InvalidStateError' });
  await assert.rejects(dev.transferIn(1, 8), { name: 'InvalidStateError' });

  await dev.open();
  assert.equal(dev.opened, true);
  const current = (): USBConfiguration | null => dev.configuration; // a call, so TS keeps the full type
  assert.equal(current(), null, 'no configuration until one is selected');
  await dev.selectConfiguration(1);
  assert.equal(current()?.configurationValue, 1);

  const [i0, i1] = current()!.interfaces;
  assert.equal(i0!.claimed, false);
  await dev.claimInterface(0);
  assert.equal(i0!.claimed, true);
  await dev.claimInterface(1);
  assert.equal(i1!.alternate.alternateSetting, 0);
  await dev.selectAlternateInterface(1, 1);
  assert.equal(i1!.alternate.alternateSetting, 1);
  assert.equal(i1!.alternate.endpoints[0]!.type, 'isochronous');
  await dev.releaseInterface(0);
  assert.equal(i0!.claimed, false);

  await dev.close();
  assert.equal(dev.opened, false);
  await assert.rejects(dev.claimInterface(0), { name: 'InvalidStateError' });
  await dev.close(); // idempotent, no second RPC
  assert.equal(t.methods().filter((m) => m === 'close').length, 1);
});

test('open() is idempotent and concurrent calls share one RPC', async () => {
  const { usb, t } = setup();
  const dev = await usb.requestDevice({ filters: [] });
  await Promise.all([dev.open(), dev.open()]);
  await dev.open();
  assert.equal(t.methods().filter((m) => m === 'open').length, 1);
});

test('forget() closes first, then revokes', async () => {
  const { dev, t } = await opened();
  await dev.forget();
  assert.equal(dev.opened, false);
  assert.deepEqual(t.methods().slice(-2), ['close', 'forget']);
});

test('transfers round-trip through base64 and come back as DataView / result objects', async () => {
  const { dev, t } = await opened();

  const inResult = await dev.transferIn(1, 64);
  assert.equal(inResult.status, 'ok');
  assert.deepEqual(bytes(inResult.data), [9, 8]);
  assert.equal(Object.prototype.toString.call(inResult), '[object USBInTransferResult]');

  const out = await dev.transferOut(1, new Uint8Array([1, 2, 3]));
  assert.equal(out.bytesWritten, 3);
  assert.equal(t.calls.find((c) => c.method === 'transferOut')!.params.data, Buffer.from([1, 2, 3]).toString('base64'));

  assert.deepEqual(bytes((await dev.controlTransferIn(SETUP, 3)).data), [1, 2, 3]);
  assert.equal((await dev.controlTransferOut(SETUP)).bytesWritten, 0);
  assert.equal((await dev.controlTransferOut(SETUP, new Uint8Array(5))).bytesWritten, 5);

  const isoIn = await dev.isochronousTransferIn(2, [2, 3]);
  assert.equal(isoIn.packets.length, 2);
  assert.equal(isoIn.data!.byteLength, 5);
  const isoOut = await dev.isochronousTransferOut(2, new Uint8Array(5), [2, 3]);
  assert.deepEqual(isoOut.packets.map((p) => p.bytesWritten), [2, 3]);
});

test('invalid arguments fail locally with the right error type, before the bridge', async () => {
  const { dev, t } = await opened();
  const before = t.calls.length;
  await assert.rejects(dev.transferIn(0, 8), { name: 'IndexSizeError' });
  await assert.rejects(dev.transferIn(16, 8), { name: 'IndexSizeError' });
  await assert.rejects(dev.transferIn(1, -1), TypeError);
  await assert.rejects(dev.transferOut(1, 'text' as any), TypeError);
  await assert.rejects(dev.clearHalt('inout' as any, 1), TypeError);
  await assert.rejects(dev.controlTransferIn({ ...SETUP, requestType: 'x' } as any, 8), TypeError);
  await assert.rejects(dev.controlTransferIn({ ...SETUP, request: 256 }, 8), TypeError);
  await assert.rejects(dev.selectConfiguration(256), TypeError);
  await assert.rejects(dev.isochronousTransferIn(2, 'x' as any), TypeError);
  assert.equal(t.calls.length, before);
});

test('bridge errors surface as DOMException with the bridge-chosen name', async () => {
  const { dev, t } = await opened();
  t.handlers.claimInterface = () => { throw new Error('NotFoundError: gone'); };
  await assert.rejects(dev.claimInterface(0), (e: any) => e instanceof DOMException && e.name === 'NotFoundError' && e.message === 'gone');
  t.handlers.claimInterface = () => { throw new Error('boom'); };
  await assert.rejects(dev.claimInterface(0), { name: 'NetworkError', message: 'boom' });
});

test('connect / disconnect events, handler properties and ignoring garbage', async () => {
  const { usb, t } = setup();
  const seen: string[] = [];
  usb.addEventListener('connect', (e) => seen.push(`connect:${(e as USBConnectionEvent).device.serialNumber}`));

  t.emit({ event: 'connect', device: wireDevice({ serialNumber: 'A' }) });
  assert.deepEqual(seen, ['connect:A']);

  let handlerA = 0; let handlerB = 0;
  usb.onconnect = () => { handlerA++; };
  usb.onconnect = () => { handlerB++; }; // replaces, does not stack
  t.emit({ event: 'connect', device: wireDevice() });
  assert.deepEqual([handlerA, handlerB], [0, 1]);
  usb.onconnect = null;
  t.emit({ event: 'connect', device: wireDevice() });
  assert.equal(handlerB, 1);

  t.emit({ event: 'bogus', device: wireDevice() } as any);
  t.emit({ event: 'connect' } as any);
  assert.equal(seen.length, 3, 'garbage events are dropped');

  const dev = await usb.requestDevice({ filters: [] });
  await dev.open();
  let disconnected: unknown;
  usb.ondisconnect = (e) => { disconnected = e.device; };
  t.emit({ event: 'disconnect', device: wireDevice() });
  assert.equal(disconnected, dev, 'same USBDevice object as the one the page holds');
  assert.equal(dev.opened, false, 'an unplugged device is no longer open');

  const ev = new USBConnectionEvent('connect', { device: dev });
  assert.equal(ev.device, dev);
  assert.throws(() => new USBConnectionEvent('connect', {} as any), TypeError);
});

test('descriptor trees are frozen and carry WebUSB-style toStringTags', async () => {
  const { dev } = await opened();
  const config = dev.configurations[0]!;
  const iface = config.interfaces[0]!;
  const alt = iface.alternates[0]!;
  for (const list of [dev.configurations, config.interfaces, iface.alternates, alt.endpoints]) assert.ok(Object.isFrozen(list));
  const tag = (o: object): string => Object.prototype.toString.call(o);
  assert.deepEqual([dev, config, iface, alt, alt.endpoints[0]!].map(tag), [
    '[object USBDevice]', '[object USBConfiguration]', '[object USBInterface]', '[object USBAlternateInterface]', '[object USBEndpoint]',
  ]);
});
