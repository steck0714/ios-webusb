"use strict";
(() => {
  // src/core/protocol.ts
  var PROTOCOL_VERSION = 0;
  var RPC_METHODS = [
    "hello",
    "bridgeInfo",
    "requestDevice",
    "getDevices",
    "listAvailableDevices",
    "grantDevice",
    "open",
    "close",
    "forget",
    "selectConfiguration",
    "claimInterface",
    "releaseInterface",
    "selectAlternateInterface",
    "resetDevice",
    "clearHalt",
    "controlTransferIn",
    "controlTransferOut",
    "transferIn",
    "transferOut",
    "isochronousTransferIn",
    "isochronousTransferOut"
  ];
  var BRIDGE_METHODS = RPC_METHODS.filter((m) => m !== "requestDevice");
  var TRUSTED_ONLY_METHODS = ["hello", "listAvailableDevices", "grantDevice"];
  var PAGE_RPC_METHODS = RPC_METHODS.filter(
    (m) => !TRUSTED_ONLY_METHODS.includes(m)
  );

  // src/core/version.ts
  var VERSION = "0.0.0a1";

  // src/core/url.ts
  function parseBridgeUrl(value) {
    let url;
    try {
      url = new URL(value.trim());
    } catch {
      throw new Error(`not a valid URL: ${value}`);
    }
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error(`the bridge URL must start with ws:// or wss:// (got ${url.protocol}//)`);
    }
    return url;
  }

  // src/core/transports/websocket.ts
  var WebSocketTransport = class {
    #opts;
    #ws = null;
    #ready = null;
    #hello = null;
    #nextId = 1;
    #pending = /* @__PURE__ */ new Map();
    #handlers = /* @__PURE__ */ new Set();
    #closed = false;
    constructor(options) {
      this.#opts = { connectTimeoutMs: 1e4, requestTimeoutMs: 6e4, ...options };
    }
    get serverInfo() {
      return this.#hello;
    }
    onEvent(handler) {
      this.#handlers.add(handler);
      return () => {
        this.#handlers.delete(handler);
      };
    }
    async call(method, params, meta) {
      if (this.#closed) throw new Error("transport is closed");
      await this.#ensureConnected();
      return await this.#send(method, params, meta);
    }
    close() {
      this.#closed = true;
      const ws = this.#ws;
      this.#ws = null;
      this.#ready = null;
      this.#failAll(new Error("transport is closed"));
      try {
        ws?.close(1e3, "client closed");
      } catch {
      }
    }
    // ------------------------------------------------------------------ internals
    #ensureConnected() {
      if (this.#ready) return this.#ready;
      const attempt = this.#connect();
      this.#ready = attempt;
      attempt.catch(() => {
        if (this.#ready === attempt) this.#ready = null;
      });
      return attempt;
    }
    async #connect() {
      const Impl = this.#opts.WebSocketImpl ?? globalThis.WebSocket;
      if (!Impl) throw new Error("WebSocket is not available in this context");
      const ws = new Impl(this.#opts.url);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`could not reach the bridge (timeout): ${this.#opts.url}`));
          try {
            ws.close();
          } catch {
          }
        }, this.#opts.connectTimeoutMs);
        ws.addEventListener("open", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error(`could not reach the bridge: ${this.#opts.url}`));
        }, { once: true });
        ws.addEventListener("close", () => {
          clearTimeout(timer);
          reject(new Error(`bridge closed the connection: ${this.#opts.url}`));
        }, { once: true });
      });
      this.#ws = ws;
      ws.addEventListener("message", (ev) => this.#onMessage(ev));
      ws.addEventListener("close", () => this.#onClose(ws));
      try {
        const hello = await this.#send("hello", {
          protocol: PROTOCOL_VERSION,
          client: this.#opts.client,
          token: this.#opts.token
        });
        if (hello.protocol !== PROTOCOL_VERSION) {
          throw new Error(`bridge speaks protocol ${hello.protocol}, this client speaks ${PROTOCOL_VERSION}`);
        }
        this.#hello = hello;
        return hello;
      } catch (e) {
        try {
          ws.close();
        } catch {
        }
        this.#ws = null;
        throw e;
      }
    }
    #send(method, params, meta) {
      const ws = this.#ws;
      if (!ws || ws.readyState !== 1) return Promise.reject(new Error("bridge connection is not open"));
      const id = this.#nextId++;
      const request = { id, method, params, ...meta ? { meta } : {} };
      return new Promise((resolve, reject) => {
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
    #onMessage(ev) {
      if (typeof ev.data !== "string") return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (typeof msg.id === "number") {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        clearTimeout(p.timer);
        if (typeof msg.error === "string") p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      } else if (msg.event === "connect" || msg.event === "disconnect") {
        const event = msg;
        for (const h of [...this.#handlers]) {
          try {
            h(event);
          } catch {
          }
        }
      }
    }
    #onClose(ws) {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#ready = null;
      this.#failAll(new Error("bridge connection closed"));
    }
    #failAll(error) {
      for (const [id, p] of this.#pending) {
        clearTimeout(p.timer);
        p.reject(error);
        this.#pending.delete(id);
      }
    }
  };

  // src/crx/hub.ts
  function originOf(sender) {
    if (sender?.origin === "null") return null;
    const candidate = sender?.origin || sender?.url;
    if (!candidate) return null;
    try {
      const url = new URL(candidate);
      return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
    } catch {
      return null;
    }
  }
  var errorText = (e) => e instanceof Error ? e.message : String(e);
  var Hub = class {
    #deps;
    #ports = /* @__PURE__ */ new Map();
    #subscribed = null;
    #unsubscribe = null;
    constructor(deps) {
      this.#deps = deps;
    }
    get portCount() {
      return this.#ports.size;
    }
    attach(port) {
      this.#ports.set(port, { origin: originOf(port.sender), handles: /* @__PURE__ */ new Set() });
      port.onMessage.addListener((m) => {
        void this.#onMessage(port, m);
      });
      port.onDisconnect.addListener(() => this.#detach(port));
    }
    async #onMessage(port, raw) {
      const m = raw;
      if (!m || m.kind !== "call" || typeof m.id !== "number" || typeof m.method !== "string") return;
      const id = m.id;
      const reply = (r) => {
        try {
          port.postMessage({ kind: "response", id, ...r });
        } catch {
        }
      };
      const state = this.#ports.get(port);
      const method = m.method;
      if (method === "hello" || !BRIDGE_METHODS.includes(method)) {
        reply({ error: "NotSupportedError: unknown method" });
        return;
      }
      if (!state || !state.origin) {
        reply({ error: "SecurityError: this page has no web origin" });
        return;
      }
      try {
        const transport2 = await this.#deps.getTransport();
        this.#subscribe(transport2);
        const meta = {
          hasGesture: m.hasGesture === true,
          origin: state.origin,
          locale: typeof m.locale === "string" ? m.locale : void 0
        };
        const result = await transport2.call(method, m.params, meta);
        if (method === "open") state.handles.add(result.handle);
        if (method === "close") state.handles.delete(m.params.handle);
        reply({ result });
      } catch (e) {
        reply({ error: errorText(e) });
      }
    }
    #detach(port) {
      const state = this.#ports.get(port);
      this.#ports.delete(port);
      if (!state || !state.origin) return;
      const transport2 = this.#deps.peekTransport();
      if (!transport2) return;
      for (const handle of state.handles) {
        transport2.call("close", { handle }, { origin: state.origin }).catch(() => {
        });
      }
    }
    #subscribe(transport2) {
      if (this.#subscribed === transport2) return;
      this.#unsubscribe?.();
      this.#subscribed = transport2;
      this.#unsubscribe = transport2.onEvent((ev) => this.#forward(ev));
    }
    #forward(ev) {
      if (!Array.isArray(ev.origins)) return;
      for (const [port, state] of this.#ports) {
        if (state.origin && ev.origins.includes(state.origin)) {
          try {
            port.postMessage({ kind: "event", event: ev.event, device: ev.device });
          } catch {
          }
        }
      }
    }
  };

  // src/crx/background.ts
  var ext = globalThis.browser ?? chrome;
  async function loadConfig() {
    const r = await ext.storage.local.get(["bridgeUrl", "token"]);
    return { bridgeUrl: typeof r.bridgeUrl === "string" ? r.bridgeUrl : "", token: typeof r.token === "string" ? r.token : "" };
  }
  var transport = null;
  var transportKey = "";
  async function getTransport() {
    const cfg = await loadConfig();
    if (!cfg.bridgeUrl) throw new Error("bridge URL is not set: open the ios-webusb extension options");
    const url = parseBridgeUrl(cfg.bridgeUrl);
    const key = JSON.stringify(cfg);
    if (transport && key !== transportKey) {
      transport.close();
      transport = null;
    }
    if (!transport) {
      transport = new WebSocketTransport({ url: url.href, token: cfg.token || void 0, client: `ios-webusb-crx/${VERSION}` });
      transportKey = key;
    }
    return transport;
  }
  var hub = new Hub({ getTransport, peekTransport: () => transport });
  ext.runtime.onConnect.addListener((port) => {
    if (port.name === "ios-webusb") hub.attach(port);
  });
  ext.storage.onChanged.addListener((_changes, area) => {
    if (area === "local" && transport) {
      transport.close();
      transport = null;
    }
  });
  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const m = message;
    if (m?.type !== "ios-webusb:test") return void 0;
    if (!sender.url?.startsWith(ext.runtime.getURL("options.html"))) return void 0;
    (async () => {
      const probe = new WebSocketTransport({
        url: parseBridgeUrl(String(m.bridgeUrl ?? "")).href,
        token: m.token || void 0,
        client: `ios-webusb-crx/${VERSION}`,
        connectTimeoutMs: 6e3,
        requestTimeoutMs: 6e3
      });
      try {
        const info = await probe.call("bridgeInfo", {});
        sendResponse({ ok: true, info, extensionProtocol: PROTOCOL_VERSION });
      } finally {
        probe.close();
      }
    })().catch((e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  });
  ext.action.onClicked.addListener(() => {
    void ext.runtime.openOptionsPage();
  });
})();
