// background.ts — service worker entry, wires hub.ts to chrome.* and the WebSocket bridge.
import { PROTOCOL_VERSION } from '../core/protocol.ts';
import { VERSION } from '../core/version.ts';
import { parseBridgeUrl } from '../core/url.ts';
import { WebSocketTransport } from '../core/transports/websocket.ts';
import { Hub, type HubPort } from './hub.ts';

type Ext = typeof chrome;
const ext: Ext = (globalThis as unknown as { browser?: Ext }).browser ?? chrome;

interface BridgeConfig { bridgeUrl: string; token: string }

async function loadConfig(): Promise<BridgeConfig> {
  const r = await ext.storage.local.get(['bridgeUrl', 'token']);
  return { bridgeUrl: typeof r.bridgeUrl === 'string' ? r.bridgeUrl : '', token: typeof r.token === 'string' ? r.token : '' };
}

let transport: WebSocketTransport | null = null;
let transportKey = '';

async function getTransport(): Promise<WebSocketTransport> {
  const cfg = await loadConfig();
  if (!cfg.bridgeUrl) throw new Error('bridge URL is not set: open the ios-webusb extension options');
  const url = parseBridgeUrl(cfg.bridgeUrl);
  const key = JSON.stringify(cfg);
  if (transport && key !== transportKey) { transport.close(); transport = null; }
  if (!transport) {
    transport = new WebSocketTransport({ url: url.href, token: cfg.token || undefined, client: `ios-webusb-crx/${VERSION}` });
    transportKey = key;
  }
  return transport;
}

const hub = new Hub({ getTransport, peekTransport: () => transport });
ext.runtime.onConnect.addListener((port) => {
  if (port.name === 'ios-webusb') hub.attach(port as unknown as HubPort);
});

ext.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local' && transport) { transport.close(); transport = null; }
});

// Options page: "test connection" with the values currently typed in (before saving).
ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const m = message as { type?: string; bridgeUrl?: string; token?: string } | null;
  if (m?.type !== 'ios-webusb:test') return undefined;
  if (!sender.url?.startsWith(ext.runtime.getURL('options.html'))) return undefined;
  (async () => {
    const probe = new WebSocketTransport({
      url: parseBridgeUrl(String(m.bridgeUrl ?? '')).href,
      token: m.token || undefined,
      client: `ios-webusb-crx/${VERSION}`,
      connectTimeoutMs: 6000,
      requestTimeoutMs: 6000,
    });
    try {
      const info = await probe.call('bridgeInfo', {});
      sendResponse({ ok: true, info, extensionProtocol: PROTOCOL_VERSION });
    } finally {
      probe.close();
    }
  })().catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true; // async response
});

ext.action.onClicked.addListener(() => { void ext.runtime.openOptionsPage(); });
