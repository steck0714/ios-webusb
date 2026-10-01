import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import jsdom from 'jsdom';
import type { BridgeEvent, CallMeta, RpcTransport, WireDevice } from '../src/core/protocol.ts';

const { JSDOM } = jsdom;

export const sleep = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
export const b64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64');

export function makeDom(url = 'https://example.com/app') {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url, pretendToBeVisual: true, runScripts: 'dangerously',
  });
  const win = dom.window as unknown as Window & typeof globalThis;
  // Browsers fill MessageEvent.source/origin for same-window postMessage; jsdom leaves them null.
  win.postMessage = ((data: unknown) => {
    setTimeout(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win, origin: win.location.origin })), 0);
  }) as typeof win.postMessage;
  return { dom, win, doc: win.document };
}

const alt = (alternateSetting: number, endpoints: WireDevice['configurations'][0]['interfaces'][0]['alternates'][0]['endpoints']) => ({
  alternateSetting, interfaceClass: 255, interfaceSubclass: 0, interfaceProtocol: 0,
  interfaceProtected: false, interfaceName: null, endpoints,
});

export function wireDevice(over: Partial<WireDevice> = {}): WireDevice {
  return {
    deviceId: 'dev-1', vendorId: 0x1209, productId: 0x0001,
    manufacturerName: 'ios-webusb', productName: 'Virtual Loopback', serialNumber: 'MOCK-0001',
    deviceClass: 0, deviceSubclass: 0, deviceProtocol: 0,
    usbVersionMajor: 2, usbVersionMinor: 0, usbVersionSubminor: 0,
    deviceVersionMajor: 0, deviceVersionMinor: 1, deviceVersionSubminor: 0,
    configurations: [{
      configurationValue: 1, configurationName: null,
      interfaces: [
        { interfaceNumber: 0, alternates: [alt(0, [
          { endpointNumber: 1, direction: 'out', type: 'bulk', packetSize: 64 },
          { endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 64 },
        ])] },
        { interfaceNumber: 1, alternates: [alt(0, []), alt(1, [
          { endpointNumber: 2, direction: 'in', type: 'isochronous', packetSize: 188 },
        ])] },
      ],
    }],
    activeConfigurationValue: null,
    ...over,
  };
}

export type Handler = (params: any, meta: CallMeta | undefined) => unknown;

export class FakeTransport implements RpcTransport {
  calls: { method: string; params: any; meta: CallMeta | undefined }[] = [];
  handlers: Record<string, Handler> = {};
  closed = false;
  #listeners = new Set<(e: BridgeEvent) => void>();

  async call(method: any, params: any, meta?: CallMeta): Promise<any> {
    this.calls.push({ method, params, meta });
    const handler = this.handlers[method];
    if (!handler) throw new Error(`NotSupportedError: no handler for ${method}`);
    return handler(params, meta);
  }
  onEvent(handler: (e: BridgeEvent) => void): () => void {
    this.#listeners.add(handler);
    return () => { this.#listeners.delete(handler); };
  }
  emit(e: BridgeEvent): void { for (const l of [...this.#listeners]) l(e); }
  close(): void { this.closed = true; }
  methods(): string[] { return this.calls.map((c) => c.method); }
}

export function fakeBridge(dev: WireDevice = wireDevice()): FakeTransport {
  const t = new FakeTransport();
  const written = (p: any): number => Buffer.from(p.data, 'base64').length;
  Object.assign(t.handlers, {
    bridgeInfo: () => ({ protocol: 0, server: 'fake', capabilities: [] }),
    getDevices: () => [dev], listAvailableDevices: () => [dev], grantDevice: () => dev,
    open: () => ({ handle: 7, descriptor: dev }), close: () => null, forget: () => null,
    selectConfiguration: () => null, claimInterface: () => null, releaseInterface: () => null,
    selectAlternateInterface: () => null, resetDevice: () => null, clearHalt: () => null,
    controlTransferIn: () => ({ status: 'ok', data: b64([1, 2, 3]) }),
    controlTransferOut: (p: any) => ({ status: 'ok', bytesWritten: written(p) }),
    transferIn: () => ({ status: 'ok', data: b64([9, 8]) }),
    transferOut: (p: any) => ({ status: 'ok', bytesWritten: written(p) }),
    isochronousTransferIn: (p: any) => p.packetLengths.map((n: number) => ({ status: 'ok', data: b64(new Array(n).fill(1)) })),
    isochronousTransferOut: (p: any) => p.packetLengths.map((n: number) => ({ status: 'ok', bytesWritten: n })),
  } satisfies Record<string, Handler>);
  return t;
}

// ---- Python mock bridge (bridge/mock_bridge.py), used by the e2e and browser tests
const root = fileURLToPath(new URL('../', import.meta.url));
const python = existsSync(`${root}.venv/bin/python`) ? `${root}.venv/bin/python` : 'python3';

/** `false` when the bridge can run, otherwise the reason tests should skip. */
export const bridgeSkipReason: string | false = spawnSync(python, ['-c', 'import websockets']).status === 0
  ? false
  : 'create the venv first: python3 -m venv .venv && .venv/bin/pip install -r bridge/requirements.txt';

export interface MockBridge { url: string; stop(): void }

export function startMockBridge(args: string[] = []): Promise<MockBridge> {
  const child = spawn(python, [`${root}bridge/mock_bridge.py`, '--port', '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise<MockBridge>((resolve, reject) => {
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`bridge did not start: ${err}`)); }, 15_000);
    child.stdout!.on('data', (d) => {
      out += d;
      const nl = out.indexOf('\n');
      if (nl >= 0) { clearTimeout(timer); resolve({ url: JSON.parse(out.slice(0, nl)).listening, stop: () => { child.kill('SIGTERM'); } }); }
    });
    child.stderr!.on('data', (d) => { err += d; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`bridge exited (${code}): ${err}`)); });
  });
}
