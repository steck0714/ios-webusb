// websocket.ts — RpcTransport over a WebSocket to the bridge
// ==========================================================
// Used by the crx background service worker (one shared connection) and directly by the
// Shortcuts build (one connection per page). The socket is opened lazily on the first
// call and a `hello` handshake (protocol version + optional token) runs before anything
// else. After a drop the next call reconnects.
//
// Note for the Shortcuts build: a page served over https cannot open `ws://` (mixed
// content); use `wss://`. Also subject to the page's CSP `connect-src`.

import type { BridgeEvent, CallMeta, RpcMethod, RpcMethodMap, RpcRequest, RpcResponse, RpcTransport } from '../protocol.ts';
import { PROTOCOL_VERSION } from '../protocol.ts';

export interface WebSocketTransportOptions {
  url: string;
  token?: string;
  /** Identifies this client in `hello`, e.g. "ios-webusb-crx/0.0.0a1". */
  client: string;
  WebSocketImpl?: typeof WebSocket;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

type HelloResult = RpcMethodMap['hello']['result'];

interface Pending {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class WebSocketTransport implements RpcTransport {
  #opts: Required<Omit<WebSocketTransportOptions, 'token' | 'WebSocketImpl'>> & Pick<WebSocketTransportOptions, 'token' | 'WebSocketImpl'>;
  #ws: WebSocket | null = null;
  #ready: Promise<HelloResult> | null = null;
  #hello: HelloResult | null = null;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #handlers = new Set<(e: BridgeEvent) => void>();
  #closed = false;

  constructor(options: WebSocketTransportOptions) {
    this.#opts = { connectTimeoutMs: 10_000, requestTimeoutMs: 60_000, ...options };
  }

  get serverInfo(): HelloResult | null { return this.#hello; }

  onEvent(handler: (event: BridgeEvent) => void): () => void {
    this.#handlers.add(handler);
    return () => { this.#handlers.delete(handler); };
  }

  async call<M extends RpcMethod>(
    method: M,
    params: RpcMethodMap[M]['params'],
    meta?: CallMeta,
  ): Promise<RpcMethodMap[M]['result']> {
    if (this.#closed) throw new Error('transport is closed');
    await this.#ensureConnected();
    return (await this.#send(method, params, meta)) as RpcMethodMap[M]['result'];
  }

  close(): void {
    this.#closed = true;
    const ws = this.#ws;
    this.#ws = null;
    this.#ready = null;
    this.#failAll(new Error('transport is closed'));
    try { ws?.close(1000, 'client closed'); } catch { /* already closed */ }
  }

  // ------------------------------------------------------------------ internals

  #ensureConnected(): Promise<HelloResult> {
    if (this.#ready) return this.#ready;
    const attempt = this.#connect();
    this.#ready = attempt;
    attempt.catch(() => { if (this.#ready === attempt) this.#ready = null; });
    return attempt;
  }

  async #connect(): Promise<HelloResult> {
    const Impl = this.#opts.WebSocketImpl ?? globalThis.WebSocket;
    if (!Impl) throw new Error('WebSocket is not available in this context');
    const ws = new Impl(this.#opts.url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`could not reach the bridge (timeout): ${this.#opts.url}`));
        try { ws.close(); } catch { /* ignore */ }
      }, this.#opts.connectTimeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`could not reach the bridge: ${this.#opts.url}`)); }, { once: true });
      ws.addEventListener('close', () => { clearTimeout(timer); reject(new Error(`bridge closed the connection: ${this.#opts.url}`)); }, { once: true });
    });
    this.#ws = ws;
    ws.addEventListener('message', (ev: MessageEvent) => this.#onMessage(ev));
    ws.addEventListener('close', () => this.#onClose(ws));

    try {
      const hello = (await this.#send('hello', {
        protocol: PROTOCOL_VERSION, client: this.#opts.client, token: this.#opts.token,
      })) as HelloResult;
      if (hello.protocol !== PROTOCOL_VERSION) {
        throw new Error(`bridge speaks protocol ${hello.protocol}, this client speaks ${PROTOCOL_VERSION}`);
      }
      this.#hello = hello;
      return hello;
    } catch (e) {
      try { ws.close(); } catch { /* ignore */ }
      this.#ws = null;
      throw e;
    }
  }

  #send(method: string, params: unknown, meta?: CallMeta): Promise<unknown> {
    const ws = this.#ws;
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error('bridge connection is not open'));
    const id = this.#nextId++;
    const request: RpcRequest = { id, method, params, ...(meta ? { meta } : {}) };
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = meta?.timeoutMs ?? this.#opts.requestTimeoutMs;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`bridge did not answer ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify(request));
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  #onMessage(ev: MessageEvent): void {
    if (typeof ev.data !== 'string') return;
    let msg: Partial<RpcResponse> & Partial<BridgeEvent>;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (typeof msg.id === 'number') {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      if (typeof msg.error === 'string') p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    } else if (msg.event === 'connect' || msg.event === 'disconnect') {
      const event = msg as BridgeEvent;
      for (const h of [...this.#handlers]) {
        try { h(event); } catch { /* one bad listener must not break the others */ }
      }
    }
  }

  #onClose(ws: WebSocket): void {
    if (this.#ws !== ws) return;
    this.#ws = null;
    this.#ready = null;
    this.#failAll(new Error('bridge connection closed'));
  }

  #failAll(error: Error): void {
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(error);
      this.#pending.delete(id);
    }
  }
}
