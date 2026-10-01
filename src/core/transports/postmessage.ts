// postmessage.ts — page-side RpcTransport of the crx build
// ========================================================
// Runs in the page's own JS world (MAIN). Talks to the extension's content script
// (isolated world) over window.postMessage. The page cannot be trusted, so nothing it
// sends is treated as authoritative: the content script recomputes the user gesture,
// and the background derives the origin from the sender, never from these messages.

import type { BridgeEvent, CallMeta, RpcMethod, RpcMethodMap, RpcTransport } from '../protocol.ts';

export const RELAY_CHANNEL = '__iosWebusb__';

export interface RelayToContent {
  channel: typeof RELAY_CHANNEL;
  dir: 'toContent';
  kind: 'call';
  id: number;
  method: string;
  params: unknown;
}
export type RelayToPage =
  | { channel: typeof RELAY_CHANNEL; dir: 'toPage'; kind: 'response'; id: number; result?: unknown; error?: string }
  | { channel: typeof RELAY_CHANNEL; dir: 'toPage'; kind: 'event'; event: 'connect' | 'disconnect'; device: BridgeEvent['device'] };

/** `postMessage` refuses the literal origin "null" (file:, sandboxed frames). */
export function targetOriginOf(win: Window): string {
  const origin = win.location.origin;
  return origin && origin !== 'null' ? origin : '*';
}

interface Pending { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }

export class PostMessageTransport implements RpcTransport {
  #win: Window;
  #timeoutMs: number;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #handlers = new Set<(e: BridgeEvent) => void>();
  #listener: (ev: MessageEvent) => void;

  constructor(win: Window, options: { timeoutMs?: number } = {}) {
    this.#win = win;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#listener = (ev) => this.#onMessage(ev);
    win.addEventListener('message', this.#listener);
  }

  call<M extends RpcMethod>(
    method: M,
    params: RpcMethodMap[M]['params'],
    _meta?: CallMeta, // deliberately ignored: a page may not supply meta
  ): Promise<RpcMethodMap[M]['result']> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`the extension did not answer ${method} in time`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      const msg: RelayToContent = { channel: RELAY_CHANNEL, dir: 'toContent', kind: 'call', id, method, params };
      this.#win.postMessage(msg, targetOriginOf(this.#win));
    });
  }

  onEvent(handler: (event: BridgeEvent) => void): () => void {
    this.#handlers.add(handler);
    return () => { this.#handlers.delete(handler); };
  }

  close(): void {
    this.#win.removeEventListener('message', this.#listener);
    for (const [id, p] of this.#pending) { clearTimeout(p.timer); p.reject(new Error('transport is closed')); this.#pending.delete(id); }
  }

  #onMessage(ev: MessageEvent): void {
    if (ev.source !== this.#win) return;
    const data = ev.data as RelayToPage | undefined;
    if (!data || data.channel !== RELAY_CHANNEL || data.dir !== 'toPage') return;
    if (data.kind === 'response') {
      const p = this.#pending.get(data.id);
      if (!p) return;
      this.#pending.delete(data.id);
      clearTimeout(p.timer);
      if (typeof data.error === 'string') p.reject(new Error(data.error));
      else p.resolve(data.result);
    } else if (data.kind === 'event') {
      const event: BridgeEvent = { event: data.event, device: data.device };
      for (const h of [...this.#handlers]) {
        try { h(event); } catch { /* isolate listeners */ }
      }
    }
  }
}
