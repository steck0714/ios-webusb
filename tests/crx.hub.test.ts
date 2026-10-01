import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, originOf, type HubPort } from '../src/crx/hub.ts';
import { FakeTransport, flush, wireDevice } from './helpers.ts';

class FakeHubPort implements HubPort {
  sender: HubPort['sender'];
  sent: any[] = [];
  #msg: ((m: unknown) => void)[] = [];
  #disc: (() => void)[] = [];
  onMessage = { addListener: (cb: (m: unknown) => void) => { this.#msg.push(cb); } };
  onDisconnect = { addListener: (cb: () => void) => { this.#disc.push(cb); } };
  constructor(sender: HubPort['sender']) { this.sender = sender; }
  postMessage(m: unknown): void { this.sent.push(m); }
  send(m: unknown): void { for (const cb of this.#msg) cb(m); }
  leave(): void { for (const cb of this.#disc) cb(); }
}

const dev = wireDevice();
const APP = { url: 'https://app.example/page?x=1', origin: 'https://app.example' };

function setup(configure?: (t: FakeTransport) => void) {
  const t = new FakeTransport();
  Object.assign(t.handlers, {
    getDevices: () => [dev], open: () => ({ handle: 5, descriptor: dev }), close: () => null, grantDevice: () => dev,
  });
  configure?.(t);
  const hub = new Hub({ getTransport: async () => t, peekTransport: () => t });
  const attach = (sender: HubPort['sender']) => { const p = new FakeHubPort(sender); hub.attach(p); return p; };
  const call = async (p: FakeHubPort, id: number, method: string, extra: object = {}) => {
    p.send({ kind: 'call', id, method, params: {}, ...extra });
    await flush();
    return p.sent.find((m) => m.id === id);
  };
  return { t, hub, attach, call };
}

test('originOf: web origins only, opaque ones get nothing', () => {
  assert.equal(originOf(APP), 'https://app.example');
  assert.equal(originOf({ url: 'http://localhost:3000/p' }), 'http://localhost:3000');
  assert.equal(originOf({ url: 'https://a.example/x', origin: 'null' }), null, 'sandboxed frame');
  assert.equal(originOf({ url: 'chrome-extension://abc/options.html' }), null);
  assert.equal(originOf({ url: 'file:///tmp/x.html' }), null);
  assert.equal(originOf({}), null);
  assert.equal(originOf(undefined), null);
});

test('the origin sent to the bridge comes from the port, never from the message', async () => {
  const { t, attach, call } = setup();
  const port = attach(APP);
  const reply = await call(port, 1, 'getDevices', { hasGesture: true, locale: 'ja', origin: 'https://evil.example', meta: { origin: 'https://evil.example' } });
  assert.deepEqual(reply.result, [dev]);
  assert.deepEqual(t.calls[0]!.meta, { hasGesture: true, origin: 'https://app.example', locale: 'ja' });
});

test('hasGesture is true only for the boolean true', async () => {
  const { t, attach, call } = setup();
  const port = attach(APP);
  await call(port, 1, 'getDevices', { hasGesture: 'yes' });
  await call(port, 2, 'getDevices', {});
  assert.deepEqual(t.calls.map((c) => c.meta?.hasGesture), [false, false]);
});

test('hello, relay-level and unknown methods are refused without touching the bridge', async () => {
  const { t, attach, call } = setup();
  const port = attach(APP);
  for (const [i, method] of ['hello', 'requestDevice', 'nonsense', 'constructor'].entries()) {
    assert.match((await call(port, i + 1, method)).error, /NotSupportedError/);
  }
  assert.equal(t.calls.length, 0);
});

test('a frame without a web origin is refused', async () => {
  const { t, attach, call } = setup();
  assert.match((await call(attach({ url: 'chrome-extension://abc/x.html' }), 1, 'getDevices')).error, /SecurityError/);
  assert.match((await call(attach({ url: 'https://a.example/', origin: 'null' }), 1, 'getDevices')).error, /SecurityError/);
  assert.equal(t.calls.length, 0);
});

test('bridge failures and a missing configuration come back as errors, not crashes', async () => {
  const failing = setup((t) => { t.handlers.getDevices = () => { throw new Error('NotFoundError: gone'); }; });
  assert.equal((await failing.call(failing.attach(APP), 1, 'getDevices')).error, 'NotFoundError: gone');

  const hub = new Hub({ getTransport: async () => { throw new Error('bridge URL is not set'); }, peekTransport: () => null });
  const port = new FakeHubPort(APP);
  hub.attach(port);
  port.send({ kind: 'call', id: 1, method: 'getDevices', params: {} });
  await flush();
  assert.equal(port.sent[0].error, 'bridge URL is not set');
});

test('events go only to pages whose origin the bridge listed (deny by default)', async () => {
  const { t, attach, call } = setup();
  const app = attach(APP);
  const other = attach({ url: 'https://other.example/', origin: 'https://other.example' });
  await call(app, 1, 'getDevices');
  await call(other, 1, 'getDevices');

  t.emit({ event: 'connect', device: dev, origins: ['https://app.example'] });
  t.emit({ event: 'disconnect', device: dev });
  t.emit({ event: 'connect', device: dev, origins: [] });
  assert.equal(app.sent.filter((m) => m.kind === 'event').length, 1);
  assert.equal(other.sent.filter((m) => m.kind === 'event').length, 0);
  assert.deepEqual(app.sent.find((m) => m.kind === 'event'), { kind: 'event', event: 'connect', device: dev });
});

test('when a page goes away, the handles it left open are closed', async () => {
  const { t, attach, call } = setup();
  const port = attach(APP);
  await call(port, 1, 'open');
  port.leave();
  await flush();
  const close = t.calls.find((c) => c.method === 'close');
  assert.deepEqual(close?.params, { handle: 5 });
  assert.equal(close?.meta?.origin, 'https://app.example');

  const again = setup();
  const p2 = again.attach(APP);
  await again.call(p2, 1, 'open');
  await again.call(p2, 2, 'close', { params: { handle: 5 } });
  p2.leave();
  await flush();
  assert.equal(again.t.calls.filter((c) => c.method === 'close').length, 1, 'a handle the page already closed is not closed twice');
});
