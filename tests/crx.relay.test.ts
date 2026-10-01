import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, type PortLike } from '../src/crx/relay.ts';
import { PostMessageTransport } from '../src/core/transports/postmessage.ts';
import { makeDom, sleep, wireDevice } from './helpers.ts';

class FakePort implements PortLike {
  sent: any[] = [];
  disconnected = false;
  onCall: ((m: any) => void) | null = null;
  #msg: ((m: unknown) => void)[] = [];
  #disc: (() => void)[] = [];
  onMessage = { addListener: (cb: (m: unknown) => void) => { this.#msg.push(cb); } };
  onDisconnect = { addListener: (cb: () => void) => { this.#disc.push(cb); } };
  postMessage(m: unknown): void { this.sent.push(m); this.onCall?.(m); }
  disconnect(): void { this.disconnected = true; }
  emit(m: unknown): void { for (const cb of this.#msg) cb(m); }
  drop(): void { for (const cb of this.#disc) cb(); }
  methods(): string[] { return this.sent.map((m) => m.method); }
}

const dev = wireDevice();
const ARGS = { filters: [], exclusionFilters: [] };

function harness(o: { chooser?: any; realTrust?: boolean; pageTimeout?: number } = {}) {
  const { win, doc } = makeDom();
  const ports: FakePort[] = [];
  const clock = { t: 1000 };
  const h = {
    win, doc, ports, clock,
    respond: ((m: any) => ({ getDevices: [dev], listAvailableDevices: [dev], grantDevice: dev }[m.method as string])) as ((m: any) => unknown) | null,
    trusted: true,
  };
  const relay = startRelay({
    win,
    connect: () => {
      const p = new FakePort();
      p.onCall = (m) => {
        if (!h.respond) return;
        try { p.emit({ kind: 'response', id: m.id, result: h.respond(m) }); }
        catch (e) { p.emit({ kind: 'response', id: m.id, error: (e as Error).message }); }
      };
      ports.push(p);
      return p;
    },
    chooser: o.chooser ?? { choose: async (c: any[]) => c[0] ?? null },
    locale: 'ja',
    now: () => clock.t,
    isTrusted: o.realTrust ? undefined : () => h.trusted,
  });
  const page = new PostMessageTransport(win, { timeoutMs: o.pageTimeout ?? 500 });
  const gesture = () => doc.dispatchEvent(new win.Event('click'));
  return { ...h, h, relay, page, gesture };
}

test('forwards an allowed call and relays the result; meta comes from the content script', async () => {
  const t = harness();
  assert.deepEqual(await t.page.call('getDevices', {}), [dev]);
  const m = t.ports[0]!.sent[0];
  assert.deepEqual([m.kind, m.method, m.hasGesture, m.locale], ['call', 'getDevices', false, 'ja']);
});

test('a page cannot reach trusted-only or unknown methods, and the bridge is never contacted', async () => {
  const t = harness();
  for (const method of ['hello', 'listAvailableDevices', 'grantDevice', 'nonsense', '__proto__']) {
    await assert.rejects((t.page as any).call(method, {}), /NotSupportedError/);
  }
  assert.equal(t.ports.length, 0);
});

test('requestDevice needs a trusted gesture, then runs list -> chooser -> grant', async () => {
  const t = harness();
  await assert.rejects(t.page.call('requestDevice', ARGS), /SecurityError/);
  assert.equal(t.ports.length, 0, 'refused before touching the bridge');
  t.gesture();
  assert.deepEqual(await t.page.call('requestDevice', ARGS), dev);
  assert.deepEqual(t.ports[0]!.methods(), ['listAvailableDevices', 'grantDevice']);
  assert.equal(t.ports[0]!.sent[0].hasGesture, true);
  assert.deepEqual(t.ports[0]!.sent[1].params, { deviceId: 'dev-1', vendorId: 0x1209, productId: 1, serialNumber: 'MOCK-0001' });
});

test('a click the page fabricates is not a gesture', async () => {
  const t = harness({ realTrust: true }); // real isTrusted check: dispatchEvent() events are untrusted
  t.gesture();
  await assert.rejects(t.page.call('requestDevice', ARGS), /SecurityError/);
});

test('the gesture expires after a few seconds', async () => {
  const t = harness();
  t.gesture();
  t.clock.t += 4999;
  assert.deepEqual(await t.page.call('requestDevice', ARGS), dev);
  t.clock.t += 5001;
  await assert.rejects(t.page.call('requestDevice', ARGS), /SecurityError/);
});

test('cancelling the chooser is NotFoundError and nothing is granted', async () => {
  const t = harness({ chooser: { choose: async () => null } });
  t.gesture();
  await assert.rejects(t.page.call('requestDevice', ARGS), /NotFoundError/);
  assert.deepEqual(t.ports[0]!.methods(), ['listAvailableDevices']);
});

test('only one chooser at a time', async () => {
  let release!: (d: unknown) => void;
  const t = harness({ chooser: { choose: () => new Promise((r) => { release = r; }) } });
  t.gesture();
  const first = t.page.call('requestDevice', ARGS);
  await sleep(20);
  await assert.rejects(t.page.call('requestDevice', ARGS), /InvalidStateError/);
  release(dev);
  assert.deepEqual(await first, dev);
});

test('invalid filters are a DataError before any gesture check or bridge call', async () => {
  const t = harness();
  await assert.rejects(t.page.call('requestDevice', { filters: [{ vendorId: 'x' as any }], exclusionFilters: [] }), /DataError/);
  assert.equal(t.ports.length, 0);
});

test('bridge events reach the page', async () => {
  const t = harness();
  await t.page.call('getDevices', {});
  const seen: string[] = [];
  t.page.onEvent((e) => seen.push(`${e.event}:${e.device.deviceId}`));
  t.ports[0]!.emit({ kind: 'event', event: 'connect', device: dev });
  t.ports[0]!.emit({ kind: 'event', event: 'bogus', device: dev });
  await sleep(10);
  assert.deepEqual(seen, ['connect:dev-1']);
});

test('losing the port fails pending calls; the next call reconnects', async () => {
  const t = harness();
  await t.page.call('getDevices', {});
  const normal = t.h.respond;
  t.h.respond = null;
  const pending = t.page.call('getDevices', {});
  await sleep(10);
  t.ports[0]!.drop();
  await assert.rejects(pending, /connection was lost/);
  t.h.respond = normal;
  assert.deepEqual(await t.page.call('getDevices', {}), [dev]);
  assert.equal(t.ports.length, 2);
});

test('a page message that is not ours, or from another window, is ignored', async () => {
  const t = harness({ pageTimeout: 40 });
  t.win.dispatchEvent(new t.win.MessageEvent('message', { data: { channel: '__iosWebusb__', dir: 'toContent', kind: 'call', id: 1, method: 'getDevices' }, source: null }));
  t.win.dispatchEvent(new t.win.MessageEvent('message', { data: 'hello', source: t.win }));
  await sleep(20);
  assert.equal(t.ports.length, 0);
});

test('stop() disconnects and the relay stops answering', async () => {
  const t = harness({ pageTimeout: 40 });
  await t.page.call('getDevices', {});
  t.relay.stop();
  assert.equal(t.ports[0]!.disconnected, true);
  await assert.rejects(t.page.call('getDevices', {}), /did not answer/);
});
