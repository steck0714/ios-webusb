import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketTransport } from '../src/core/transports/websocket.ts';
import { flush, wireDevice } from './helpers.ts';

class FakeWS extends EventTarget {
  static instances: FakeWS[] = [];
  static mode: 'open' | 'error' = 'open';
  static onSend: ((ws: FakeWS, req: any) => void) | null = null;
  url: string;
  readyState = 0;
  sent: any[] = [];
  constructor(url: string) {
    super();
    this.url = url;
    FakeWS.instances.push(this);
    queueMicrotask(() => {
      if (FakeWS.mode === 'open') { this.readyState = 1; this.dispatchEvent(new Event('open')); }
      else { this.readyState = 3; this.dispatchEvent(new Event('error')); this.dispatchEvent(new Event('close')); }
    });
  }
  send(data: string): void { const req = JSON.parse(data); this.sent.push(req); FakeWS.onSend?.(this, req); }
  close(): void { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  reply(msg: unknown): void { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg) })); }
}

const hello = (protocol = 0) => ({ protocol, server: 'fake', capabilities: [] });
const autoReply = (ws: FakeWS, req: any): void => {
  if (req.method === 'hello') ws.reply({ id: req.id, result: hello() });
  else if (req.method === 'getDevices') ws.reply({ id: req.id, result: [] });
};
const make = (over: object = {}) => new WebSocketTransport({ url: 'ws://bridge.test/', client: 'test', WebSocketImpl: FakeWS as any, ...over });

beforeEach(() => { FakeWS.instances = []; FakeWS.mode = 'open'; FakeWS.onSend = autoReply; });

test('connects lazily, says hello first (with token) and reuses the socket', async () => {
  const t = make({ token: 'tok' });
  assert.equal(FakeWS.instances.length, 0);
  assert.deepEqual(await t.call('getDevices', {}), []);
  await t.call('getDevices', {});
  assert.equal(FakeWS.instances.length, 1);
  const [h, first] = FakeWS.instances[0]!.sent;
  assert.deepEqual([h.method, h.params.protocol, h.params.token, h.params.client], ['hello', 0, 'tok', 'test']);
  assert.equal(first.method, 'getDevices');
  assert.equal(t.serverInfo?.server, 'fake');
});

test('an error reply rejects with the bridge message verbatim', async () => {
  FakeWS.onSend = (ws, req) => ws.reply(req.method === 'hello' ? { id: req.id, result: hello() } : { id: req.id, error: 'InvalidStateError: nope' });
  await assert.rejects(make().call('claimInterface', { handle: 1, interfaceNumber: 0 }), { message: 'InvalidStateError: nope' });
});

test('a call the bridge never answers times out', async () => {
  FakeWS.onSend = (ws, req) => { if (req.method === 'hello') ws.reply({ id: req.id, result: hello() }); };
  await assert.rejects(make({ requestTimeoutMs: 30 }).call('getDevices', {}), /did not answer getDevices within 30 ms/);
});

test('bridge events reach subscribers until they unsubscribe', async () => {
  const t = make();
  await t.call('getDevices', {});
  const seen: string[] = [];
  const off = t.onEvent((e) => seen.push(`${e.event}:${e.device.serialNumber}`));
  FakeWS.instances[0]!.reply({ event: 'connect', device: wireDevice({ serialNumber: 'A' }) });
  off();
  FakeWS.instances[0]!.reply({ event: 'connect', device: wireDevice({ serialNumber: 'B' }) });
  assert.deepEqual(seen, ['connect:A']);
});

test('after the socket drops, pending calls fail and the next call reconnects', async () => {
  const t = make();
  await t.call('getDevices', {});
  FakeWS.onSend = (ws, req) => { if (req.method === 'hello') ws.reply({ id: req.id, result: hello() }); };
  const pending = t.call('getDevices', {});
  await flush();
  FakeWS.instances[0]!.close();
  await assert.rejects(pending, /connection closed/);
  FakeWS.onSend = autoReply;
  assert.deepEqual(await t.call('getDevices', {}), []);
  assert.equal(FakeWS.instances.length, 2);
});

test('a protocol mismatch is refused and the socket closed', async () => {
  FakeWS.onSend = (ws, req) => ws.reply({ id: req.id, result: hello(99) });
  await assert.rejects(make().call('getDevices', {}), /speaks protocol 99/);
  assert.equal(FakeWS.instances[0]!.readyState, 3);
});

test('an unreachable bridge fails clearly and a later call can succeed', async () => {
  const t = make();
  FakeWS.mode = 'error';
  await assert.rejects(t.call('getDevices', {}), /could not reach the bridge/);
  FakeWS.mode = 'open';
  assert.deepEqual(await t.call('getDevices', {}), []);
});

test('close() refuses further calls', async () => {
  const t = make();
  await t.call('getDevices', {});
  t.close();
  await assert.rejects(t.call('getDevices', {}), /transport is closed/);
});
