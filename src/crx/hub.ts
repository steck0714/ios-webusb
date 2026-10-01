// hub.ts — background logic (service worker)
// ===========================================
// Owns the single bridge connection shared by every page. For each call it attaches the
// `meta` the bridge relies on — origin (from the port's sender, which the browser sets and
// the page cannot forge), gesture (as observed by that page's content script) and locale.
// Bridge events are forwarded only to pages whose origin the bridge listed in `origins`.

import { BRIDGE_METHODS, type BridgeEvent, type CallMeta, type RpcTransport } from '../core/protocol.ts';

export interface HubPort {
  sender?: { url?: string; origin?: string };
  postMessage(message: unknown): void;
  onMessage: { addListener(cb: (message: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

export interface HubDeps {
  /** Resolves the (possibly new) transport; rejects when the bridge is not configured. */
  getTransport(): Promise<RpcTransport>;
  /** The transport if one exists already, without creating a connection. */
  peekTransport(): RpcTransport | null;
}

/**
 * Origin of the frame behind a port, or null for opaque / non-web origins. Sandboxed frames
 * report the origin "null": like a browser's WebUSB they get nothing, and they must not
 * inherit the grants of the site that served them.
 */
export function originOf(sender: HubPort['sender']): string | null {
  if (sender?.origin === 'null') return null;
  const candidate = sender?.origin || sender?.url;
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class Hub {
  #deps: HubDeps;
  #ports = new Map<HubPort, { origin: string | null; handles: Set<number> }>();
  #subscribed: RpcTransport | null = null;
  #unsubscribe: (() => void) | null = null;

  constructor(deps: HubDeps) {
    this.#deps = deps;
  }

  get portCount(): number { return this.#ports.size; }

  attach(port: HubPort): void {
    this.#ports.set(port, { origin: originOf(port.sender), handles: new Set() });
    port.onMessage.addListener((m) => { void this.#onMessage(port, m); });
    port.onDisconnect.addListener(() => this.#detach(port));
  }

  async #onMessage(port: HubPort, raw: unknown): Promise<void> {
    const m = raw as { kind?: string; id?: number; method?: string; params?: unknown; hasGesture?: unknown; locale?: unknown } | null;
    if (!m || m.kind !== 'call' || typeof m.id !== 'number' || typeof m.method !== 'string') return;
    const id = m.id;
    const reply = (r: { result?: unknown; error?: string }): void => {
      try { port.postMessage({ kind: 'response', id, ...r }); } catch { /* the page went away */ }
    };
    const state = this.#ports.get(port);
    const method = m.method;
    if (method === 'hello' || !BRIDGE_METHODS.includes(method as never)) {
      reply({ error: 'NotSupportedError: unknown method' });
      return;
    }
    if (!state || !state.origin) {
      reply({ error: 'SecurityError: this page has no web origin' });
      return;
    }
    try {
      const transport = await this.#deps.getTransport();
      this.#subscribe(transport);
      const meta: CallMeta = {
        hasGesture: m.hasGesture === true,
        origin: state.origin,
        locale: typeof m.locale === 'string' ? m.locale : undefined,
      };
      const result = await transport.call(method as never, m.params as never, meta);
      if (method === 'open') state.handles.add((result as { handle: number }).handle);
      if (method === 'close') state.handles.delete((m.params as { handle: number }).handle);
      reply({ result });
    } catch (e) {
      reply({ error: errorText(e) });
    }
  }

  #detach(port: HubPort): void {
    const state = this.#ports.get(port);
    this.#ports.delete(port);
    if (!state || !state.origin) return;
    // Page went away: free what it left open (best effort; the bridge also frees on disconnect).
    const transport = this.#deps.peekTransport();
    if (!transport) return;
    for (const handle of state.handles) {
      transport.call('close', { handle }, { origin: state.origin }).catch(() => { /* ignore */ });
    }
  }

  #subscribe(transport: RpcTransport): void {
    if (this.#subscribed === transport) return;
    this.#unsubscribe?.();
    this.#subscribed = transport;
    this.#unsubscribe = transport.onEvent((ev) => this.#forward(ev));
  }

  #forward(ev: BridgeEvent): void {
    if (!Array.isArray(ev.origins)) return; // deny by default
    for (const [port, state] of this.#ports) {
      if (state.origin && ev.origins.includes(state.origin)) {
        try { port.postMessage({ kind: 'event', event: ev.event, device: ev.device }); } catch { /* ignore */ }
      }
    }
  }
}
