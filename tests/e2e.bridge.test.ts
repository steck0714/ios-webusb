import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createUsbApi } from '../src/core/usb.ts';
import { createLocalPicker } from '../src/core/pick.ts';
import { WebSocketTransport } from '../src/core/transports/websocket.ts';
import { bridgeSkipReason, startMockBridge, type MockBridge } from './helpers.ts';

const opts = { skip: bridgeSkipReason };
let bridge: MockBridge | undefined;
let url = '';

before(async () => {
  if (bridgeSkipReason) return;
  bridge = await startMockBridge(['--token', 'secret', '--debug-rpc']);
  url = bridge.url;
});
after(() => { bridge?.stop(); });

const connect = (token = 'secret') => new WebSocketTransport({ url, token, client: 'e2e' });
const chooser = { choose: async (c: any[]) => c[0] ?? null };
const api = (transport: WebSocketTransport) => createUsbApi({ transport, requestDevice: createLocalPicker(transport, chooser) });
const bytes = (v: DataView | undefined): number[] => [...new Uint8Array(v!.buffer, v!.byteOffset, v!.byteLength)];
const vendor = (request: number, value = 0, index = 0) => ({ requestType: 'vendor', recipient: 'device', request, value, index }) as const;

test('full WebUSB flow against the mock bridge, over a real WebSocket', opts, async () => {
  const transport = connect();
  const { usb } = api(transport);

  assert.deepEqual(await usb.getDevices(), [], 'nothing granted yet');
  await assert.rejects(usb.requestDevice({ filters: [{ vendorId: 0x1111 }] }), { name: 'NotFoundError' });
  const dev = await usb.requestDevice({ filters: [{ vendorId: 0x1209, productId: 0x0001 }] });
  assert.equal(dev.productName, 'Virtual Loopback');
  assert.equal(dev.serialNumber, 'MOCK-0001');
  assert.equal(dev.configurations[0]!.interfaces.length, 2);
  assert.equal((await usb.getDevices()).length, 1);

  await assert.rejects(dev.claimInterface(0), { name: 'InvalidStateError' }, 'not open yet');
  await dev.open();
  const config = () => dev.configuration;
  assert.equal(config(), null);
  await assert.rejects(dev.claimInterface(0), { name: 'InvalidStateError' }, 'no configuration yet');
  await dev.selectConfiguration(1);
  assert.equal(config()?.configurationValue, 1);
  await dev.claimInterface(0);

  const payload = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
  assert.equal((await dev.transferOut(1, payload)).bytesWritten, 300);
  assert.deepEqual(bytes((await dev.transferIn(1, 512)).data), [...payload], 'loopback returns what was sent');
  assert.deepEqual(bytes((await dev.transferIn(1, 8)).data), [], 'and then it is empty');

  assert.deepEqual(Buffer.from(bytes((await dev.controlTransferIn(vendor(1), 8)).data)).toString(), 'MOCK');
  assert.deepEqual(bytes((await dev.controlTransferIn(vendor(3, 0x1234, 0x5678), 4)).data), [0x34, 0x12, 0x78, 0x56]);
  assert.equal((await dev.controlTransferIn(vendor(9), 4)).status, 'stall');
  assert.equal((await dev.controlTransferOut(vendor(2), new Uint8Array(4))).bytesWritten, 4);

  await dev.claimInterface(1);
  await dev.selectAlternateInterface(1, 1);
  const iso = await dev.isochronousTransferIn(2, [4, 4]);
  assert.deepEqual(iso.packets.map((p) => bytes(p.data)), [[0, 0, 0, 0], [1, 1, 1, 1]]);
  assert.equal(iso.data!.byteLength, 8);
  assert.deepEqual((await dev.isochronousTransferOut(2, new Uint8Array(8), [4, 4])).packets.map((p) => p.bytesWritten), [4, 4]);

  await assert.rejects(dev.transferIn(5, 8), { name: 'NotFoundError' });
  await assert.rejects(dev.selectConfiguration(2), { name: 'NotFoundError' });
  await assert.rejects(dev.claimInterface(9), { name: 'NotFoundError' });
  await dev.releaseInterface(1);
  await assert.rejects(dev.isochronousTransferIn(2, [4]), { name: 'NotFoundError' }, 'released interface');
  await dev.clearHalt('in', 1);
  await dev.reset();

  const disconnected = new Promise<unknown>((resolve) => { usb.ondisconnect = (e) => resolve(e.device); });
  await transport.call('__debug.unplug' as any, {});
  assert.equal(await disconnected, dev);
  assert.equal(dev.opened, false);
  await assert.rejects(dev.open(), { name: 'NotFoundError' });
  const connected = new Promise<unknown>((resolve) => { usb.onconnect = (e) => resolve(e.device); });
  await transport.call('__debug.plug' as any, {});
  assert.equal(await connected, dev);
  await dev.open();
  assert.equal(config(), null, 'a re-plugged device starts unconfigured');

  await dev.forget();
  assert.deepEqual(await usb.getDevices(), []);
  transport.close();
});

test('1 MiB through base64 and the WebSocket and back, unchanged', opts, async () => {
  const transport = connect();
  const { usb } = api(transport);
  const dev = await usb.requestDevice({ filters: [] });
  await dev.open();
  await dev.selectConfiguration(1);
  await dev.claimInterface(0);
  const big = new Uint8Array(1024 * 1024).map((_, i) => (i * 7 + (i >> 8)) & 0xff);
  assert.equal((await dev.transferOut(1, big)).bytesWritten, big.length);
  const back = (await dev.transferIn(1, big.length)).data!;
  assert.equal(Buffer.compare(Buffer.from(back.buffer, back.byteOffset, back.byteLength), Buffer.from(big)), 0);
  await dev.forget();
  transport.close();
});

test('grants are per origin: another origin can neither list nor open a granted device', opts, async () => {
  const t = connect();
  const A = { origin: 'https://a.example' };
  const B = { origin: 'https://b.example' };
  const [listed] = await t.call('listAvailableDevices', { filters: [], exclusionFilters: [] }, A);
  const ref = { vendorId: listed!.vendorId, productId: listed!.productId };
  await t.call('grantDevice', ref, A);
  assert.equal((await t.call('getDevices', {}, A)).length, 1);
  assert.equal((await t.call('getDevices', {}, B)).length, 0);
  await assert.rejects(t.call('open', ref, B), /^Error: SecurityError/);
  const { handle } = await t.call('open', ref, A);
  await t.call('close', { handle }, A);
  await t.call('forget', ref, A);
  assert.equal((await t.call('getDevices', {}, A)).length, 0);
  t.close();
});

test('the token is enforced; a client that skips hello gets nothing', opts, async () => {
  await assert.rejects(connect('wrong').call('bridgeInfo', {}), /invalid token/);
  await assert.rejects(new WebSocketTransport({ url, client: 'e2e' }).call('bridgeInfo', {}), /invalid token/);
  const good = connect();
  const info = await good.call('bridgeInfo', {});
  assert.equal(info.protocol, 0);
  assert.match(info.server, /mock-bridge/);
  good.close();

  const raw = new WebSocket(url);
  await new Promise((resolve) => raw.addEventListener('open', resolve, { once: true }));
  const answers: any[] = [];
  raw.addEventListener('message', (e) => answers.push(JSON.parse(String(e.data))));
  raw.send(JSON.stringify({ id: 1, method: 'getDevices', params: {} }));
  raw.send(JSON.stringify({ id: 2, method: '__debug.unplug', params: {} }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  raw.close();
  assert.deepEqual(answers, [
    { id: 1, error: 'SecurityError: send hello first' },
    { id: 2, error: 'SecurityError: send hello first' },
  ]);
});

test('unknown and private method names are rejected', opts, async () => {
  const t = connect();
  for (const method of ['constructor', '../x', '_private', 'rpc_open', '']) {
    await assert.rejects(t.call(method as any, {}), /NotSupportedError/, method);
  }
  t.close();
});
