"use strict";
(() => {
  // src/core/base64.ts
  function bufferSourceToUint8Array(source) {
    if (source instanceof ArrayBuffer) return new Uint8Array(source);
    if (ArrayBuffer.isView(source)) {
      return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    }
    throw new TypeError("data must be a BufferSource (ArrayBuffer or a typed array / DataView)");
  }
  function bufferSourceToBase64(source) {
    const bytes = bufferSourceToUint8Array(source);
    let binary = "";
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }
  function base64ToUint8Array(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // src/core/errors.ts
  var KNOWN_ERROR_PREFIXES = [
    "SecurityError",
    "InvalidStateError",
    "NotFoundError",
    "InvalidAccessError",
    "IndexSizeError",
    "DataError",
    "NotSupportedError"
  ];
  function throwFromRpcError(err, defaultName = "NetworkError") {
    const message = err instanceof Error ? err.message : String(err);
    for (const prefix of KNOWN_ERROR_PREFIXES) {
      if (message.startsWith(prefix + ": ")) {
        throw new DOMException(message.slice(prefix.length + 2), prefix);
      }
    }
    throw new DOMException(message, defaultName);
  }

  // src/core/usb.ts
  var INTERNAL = /* @__PURE__ */ Symbol("ios-webusb.internal");
  function checkToken(token) {
    if (token !== INTERNAL) throw new TypeError("Illegal constructor");
  }
  var deviceInternals = /* @__PURE__ */ new WeakMap();
  function internalsOf(device) {
    const internals = deviceInternals.get(device);
    if (!internals) throw new TypeError("Illegal invocation");
    return internals;
  }
  var usbInternals = /* @__PURE__ */ new WeakMap();
  async function rpcCall(rt, method, params, meta) {
    try {
      return await rt.transport.call(method, params, meta);
    } catch (e) {
      return throwFromRpcError(e);
    }
  }
  function deviceRef(w) {
    return {
      deviceId: w.deviceId,
      vendorId: w.vendorId,
      productId: w.productId,
      serialNumber: w.serialNumber ?? void 0
    };
  }
  function frozen(items) {
    return Object.freeze(items);
  }
  function wrapDataView(base64) {
    const bytes = base64ToUint8Array(base64);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  function concatDataViews(views) {
    let total = 0;
    for (const v of views) total += v?.byteLength ?? 0;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const v of views) {
      if (!v) continue;
      out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), offset);
      offset += v.byteLength;
    }
    return new DataView(out.buffer);
  }
  function isUint(value, max) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
  }
  function checkFilter(f, name) {
    if (typeof f !== "object" || f === null) throw new TypeError(`${name} contains an invalid USBDeviceFilter`);
    const r = f;
    const fields = [
      ["vendorId", 65535],
      ["productId", 65535],
      ["classCode", 255],
      ["subclassCode", 255],
      ["protocolCode", 255]
    ];
    for (const [key, max] of fields) {
      if (r[key] !== void 0 && !isUint(r[key], max)) {
        throw new TypeError(`${name}: ${key} must be an integer between 0 and ${max}`);
      }
    }
    if (r.serialNumber !== void 0 && typeof r.serialNumber !== "string") {
      throw new TypeError(`${name}: serialNumber must be a string`);
    }
    if (r.productId !== void 0 && r.vendorId === void 0) throw new TypeError(`${name}: productId requires vendorId`);
    if (r.subclassCode !== void 0 && r.classCode === void 0) throw new TypeError(`${name}: subclassCode requires classCode`);
    if (r.protocolCode !== void 0 && r.subclassCode === void 0) throw new TypeError(`${name}: protocolCode requires subclassCode`);
    return f;
  }
  function checkFilters(filters, name) {
    if (!Array.isArray(filters)) throw new TypeError(`${name} must be an array`);
    return filters.map((f) => checkFilter(f, name));
  }
  function checkEndpointNumber(n) {
    if (!isUint(n, 15) || n < 1) throw new DOMException("The endpoint number must be between 1 and 15", "IndexSizeError");
  }
  function checkLength(length, name = "length") {
    if (!isUint(length, 4294967295)) throw new TypeError(`${name} must be an unsigned integer`);
  }
  var REQUEST_TYPES = ["standard", "class", "vendor"];
  var RECIPIENTS = ["device", "interface", "endpoint", "other"];
  function checkSetup(setup) {
    if (typeof setup !== "object" || setup === null) throw new TypeError("setup must be a USBControlTransferParameters");
    const s = setup;
    if (!REQUEST_TYPES.includes(s.requestType)) throw new TypeError("setup.requestType is invalid");
    if (!RECIPIENTS.includes(s.recipient)) throw new TypeError("setup.recipient is invalid");
    if (!isUint(s.request, 255)) throw new TypeError("setup.request must be an integer between 0 and 255");
    if (!isUint(s.value, 65535)) throw new TypeError("setup.value must be an integer between 0 and 65535");
    if (!isUint(s.index, 65535)) throw new TypeError("setup.index must be an integer between 0 and 65535");
    return { requestType: s.requestType, recipient: s.recipient, request: s.request, value: s.value, index: s.index };
  }
  var USBEndpoint = class {
    #w;
    constructor(token, wire) {
      checkToken(token);
      this.#w = wire;
    }
    get endpointNumber() {
      return this.#w.endpointNumber;
    }
    get direction() {
      return this.#w.direction;
    }
    get type() {
      return this.#w.type;
    }
    get packetSize() {
      return this.#w.packetSize;
    }
    get [Symbol.toStringTag]() {
      return "USBEndpoint";
    }
  };
  var USBAlternateInterface = class {
    #w;
    #endpoints;
    constructor(token, wire) {
      checkToken(token);
      this.#w = wire;
      this.#endpoints = frozen(wire.endpoints.map((e) => new USBEndpoint(INTERNAL, e)));
    }
    get alternateSetting() {
      return this.#w.alternateSetting;
    }
    get interfaceClass() {
      return this.#w.interfaceClass;
    }
    get interfaceSubclass() {
      return this.#w.interfaceSubclass;
    }
    get interfaceProtocol() {
      return this.#w.interfaceProtocol;
    }
    get interfaceName() {
      return this.#w.interfaceName;
    }
    get interfaceProtected() {
      return this.#w.interfaceProtected;
    }
    get endpoints() {
      return this.#endpoints;
    }
    get [Symbol.toStringTag]() {
      return "USBAlternateInterface";
    }
  };
  var USBInterface = class {
    #device;
    #w;
    #alternates;
    constructor(token, device, wire) {
      checkToken(token);
      this.#device = device;
      this.#w = wire;
      this.#alternates = frozen(wire.alternates.map((a) => new USBAlternateInterface(INTERNAL, a)));
    }
    get interfaceNumber() {
      return this.#w.interfaceNumber;
    }
    get alternates() {
      return this.#alternates;
    }
    get alternate() {
      const active = internalsOf(this.#device).activeAlternate(this.#w.interfaceNumber);
      return this.#alternates.find((a) => a.alternateSetting === active) ?? this.#alternates[0];
    }
    get claimed() {
      return internalsOf(this.#device).isClaimed(this.#w.interfaceNumber);
    }
    get [Symbol.toStringTag]() {
      return "USBInterface";
    }
  };
  var USBConfiguration = class {
    #w;
    #interfaces;
    constructor(token, device, wire) {
      checkToken(token);
      this.#w = wire;
      this.#interfaces = frozen(wire.interfaces.map((i) => new USBInterface(INTERNAL, device, i)));
    }
    get configurationValue() {
      return this.#w.configurationValue;
    }
    get configurationName() {
      return this.#w.configurationName;
    }
    get interfaces() {
      return this.#interfaces;
    }
    get [Symbol.toStringTag]() {
      return "USBConfiguration";
    }
  };
  var USBInTransferResult = class {
    #data;
    #status;
    constructor(status, data) {
      this.#status = status;
      this.#data = data;
    }
    get data() {
      return this.#data;
    }
    get status() {
      return this.#status;
    }
    get [Symbol.toStringTag]() {
      return "USBInTransferResult";
    }
  };
  var USBOutTransferResult = class {
    #status;
    #bytesWritten;
    constructor(status, bytesWritten = 0) {
      this.#status = status;
      this.#bytesWritten = bytesWritten;
    }
    get bytesWritten() {
      return this.#bytesWritten;
    }
    get status() {
      return this.#status;
    }
    get [Symbol.toStringTag]() {
      return "USBOutTransferResult";
    }
  };
  var USBIsochronousInTransferPacket = class {
    #data;
    #status;
    constructor(status, data) {
      this.#status = status;
      this.#data = data;
    }
    get data() {
      return this.#data;
    }
    get status() {
      return this.#status;
    }
    get [Symbol.toStringTag]() {
      return "USBIsochronousInTransferPacket";
    }
  };
  var USBIsochronousInTransferResult = class {
    #data;
    #packets;
    constructor(packets, data) {
      this.#packets = packets;
      this.#data = data;
    }
    get data() {
      return this.#data;
    }
    get packets() {
      return this.#packets;
    }
    get [Symbol.toStringTag]() {
      return "USBIsochronousInTransferResult";
    }
  };
  var USBIsochronousOutTransferPacket = class {
    #status;
    #bytesWritten;
    constructor(status, bytesWritten = 0) {
      this.#status = status;
      this.#bytesWritten = bytesWritten;
    }
    get bytesWritten() {
      return this.#bytesWritten;
    }
    get status() {
      return this.#status;
    }
    get [Symbol.toStringTag]() {
      return "USBIsochronousOutTransferPacket";
    }
  };
  var USBIsochronousOutTransferResult = class {
    #packets;
    constructor(packets) {
      this.#packets = packets;
    }
    get packets() {
      return this.#packets;
    }
    get [Symbol.toStringTag]() {
      return "USBIsochronousOutTransferResult";
    }
  };
  var USBDevice = class {
    #rt;
    #wire;
    #handle = null;
    #opening = null;
    #claimed = /* @__PURE__ */ new Set();
    #alternate = /* @__PURE__ */ new Map();
    #configs = [];
    constructor(token, rt, wire) {
      checkToken(token);
      this.#rt = rt;
      this.#wire = wire;
      this.#rebuild();
      deviceInternals.set(this, {
        isClaimed: (n) => this.#claimed.has(n),
        activeAlternate: (n) => this.#alternate.get(n) ?? 0,
        refresh: (w) => {
          this.#wire = w;
          this.#rebuild();
        },
        markDisconnected: () => {
          this.#handle = null;
          this.#claimed.clear();
          this.#alternate.clear();
        }
      });
    }
    #rebuild() {
      this.#configs = frozen(this.#wire.configurations.map((c) => new USBConfiguration(INTERNAL, this, c)));
    }
    #requireHandle() {
      if (this.#handle === null) {
        throw new DOMException("The device must be opened first", "InvalidStateError");
      }
      return this.#handle;
    }
    #resetState() {
      this.#claimed.clear();
      this.#alternate.clear();
    }
    get usbVersionMajor() {
      return this.#wire.usbVersionMajor;
    }
    get usbVersionMinor() {
      return this.#wire.usbVersionMinor;
    }
    get usbVersionSubminor() {
      return this.#wire.usbVersionSubminor;
    }
    get deviceClass() {
      return this.#wire.deviceClass;
    }
    get deviceSubclass() {
      return this.#wire.deviceSubclass;
    }
    get deviceProtocol() {
      return this.#wire.deviceProtocol;
    }
    get vendorId() {
      return this.#wire.vendorId;
    }
    get productId() {
      return this.#wire.productId;
    }
    get deviceVersionMajor() {
      return this.#wire.deviceVersionMajor;
    }
    get deviceVersionMinor() {
      return this.#wire.deviceVersionMinor;
    }
    get deviceVersionSubminor() {
      return this.#wire.deviceVersionSubminor;
    }
    get manufacturerName() {
      return this.#wire.manufacturerName;
    }
    get productName() {
      return this.#wire.productName;
    }
    get serialNumber() {
      return this.#wire.serialNumber;
    }
    get opened() {
      return this.#handle !== null;
    }
    get configurations() {
      return this.#configs;
    }
    get configuration() {
      const value = this.#wire.activeConfigurationValue;
      if (value === null) return null;
      return this.#configs.find((c) => c.configurationValue === value) ?? null;
    }
    get [Symbol.toStringTag]() {
      return "USBDevice";
    }
    open() {
      if (this.#handle !== null) return Promise.resolve();
      if (this.#opening) return this.#opening;
      const attempt = (async () => {
        const r = await rpcCall(this.#rt, "open", deviceRef(this.#wire));
        this.#handle = r.handle;
        this.#wire = r.descriptor;
        this.#rebuild();
      })();
      this.#opening = attempt.finally(() => {
        this.#opening = null;
      });
      return this.#opening;
    }
    async close() {
      if (this.#handle === null) return;
      const handle = this.#handle;
      this.#handle = null;
      this.#resetState();
      await rpcCall(this.#rt, "close", { handle });
    }
    /** Works whether or not the device is open (unlike tauri-webusb v0.0.0): the bridge revokes by identity. */
    async forget() {
      await this.close();
      await rpcCall(this.#rt, "forget", deviceRef(this.#wire));
    }
    async selectConfiguration(configurationValue) {
      const handle = this.#requireHandle();
      if (!isUint(configurationValue, 255)) throw new TypeError("configurationValue must be an integer between 0 and 255");
      await rpcCall(this.#rt, "selectConfiguration", { handle, configurationValue });
      this.#resetState();
      this.#wire = { ...this.#wire, activeConfigurationValue: configurationValue };
      this.#rebuild();
    }
    async claimInterface(interfaceNumber) {
      const handle = this.#requireHandle();
      if (!isUint(interfaceNumber, 255)) throw new TypeError("interfaceNumber must be an integer between 0 and 255");
      await rpcCall(this.#rt, "claimInterface", { handle, interfaceNumber });
      this.#claimed.add(interfaceNumber);
    }
    async releaseInterface(interfaceNumber) {
      const handle = this.#requireHandle();
      if (!isUint(interfaceNumber, 255)) throw new TypeError("interfaceNumber must be an integer between 0 and 255");
      await rpcCall(this.#rt, "releaseInterface", { handle, interfaceNumber });
      this.#claimed.delete(interfaceNumber);
      this.#alternate.delete(interfaceNumber);
    }
    async selectAlternateInterface(interfaceNumber, alternateSetting) {
      const handle = this.#requireHandle();
      if (!isUint(interfaceNumber, 255)) throw new TypeError("interfaceNumber must be an integer between 0 and 255");
      if (!isUint(alternateSetting, 255)) throw new TypeError("alternateSetting must be an integer between 0 and 255");
      await rpcCall(this.#rt, "selectAlternateInterface", { handle, interfaceNumber, alternateSetting });
      this.#alternate.set(interfaceNumber, alternateSetting);
    }
    async reset() {
      const handle = this.#requireHandle();
      await rpcCall(this.#rt, "resetDevice", { handle });
      this.#resetState();
    }
    async clearHalt(direction, endpointNumber) {
      const handle = this.#requireHandle();
      if (direction !== "in" && direction !== "out") throw new TypeError("direction must be 'in' or 'out'");
      checkEndpointNumber(endpointNumber);
      await rpcCall(this.#rt, "clearHalt", { handle, endpointNumber, direction });
    }
    async controlTransferIn(setup, length) {
      const handle = this.#requireHandle();
      const s = checkSetup(setup);
      checkLength(length);
      const r = await rpcCall(this.#rt, "controlTransferIn", { handle, setup: s, length });
      return new USBInTransferResult(r.status, wrapDataView(r.data));
    }
    async controlTransferOut(setup, data) {
      const handle = this.#requireHandle();
      const s = checkSetup(setup);
      const bytes = data === void 0 ? new Uint8Array(0) : bufferSourceToUint8Array(data);
      const r = await rpcCall(this.#rt, "controlTransferOut", { handle, setup: s, data: bufferSourceToBase64(bytes) });
      return new USBOutTransferResult(r.status, r.bytesWritten);
    }
    async transferIn(endpointNumber, length) {
      const handle = this.#requireHandle();
      checkEndpointNumber(endpointNumber);
      checkLength(length);
      const r = await rpcCall(this.#rt, "transferIn", { handle, endpointNumber, length });
      return new USBInTransferResult(r.status, wrapDataView(r.data));
    }
    async transferOut(endpointNumber, data) {
      const handle = this.#requireHandle();
      checkEndpointNumber(endpointNumber);
      const bytes = bufferSourceToUint8Array(data);
      const r = await rpcCall(this.#rt, "transferOut", { handle, endpointNumber, data: bufferSourceToBase64(bytes) });
      return new USBOutTransferResult(r.status, r.bytesWritten);
    }
    async isochronousTransferIn(endpointNumber, packetLengths) {
      const handle = this.#requireHandle();
      checkEndpointNumber(endpointNumber);
      if (!Array.isArray(packetLengths)) throw new TypeError("packetLengths must be an array");
      packetLengths.forEach((l) => checkLength(l, "packetLengths[]"));
      const r = await rpcCall(this.#rt, "isochronousTransferIn", { handle, endpointNumber, packetLengths });
      const views = r.map((p) => wrapDataView(p.data));
      const packets = r.map((p, i) => new USBIsochronousInTransferPacket(p.status, views[i]));
      return new USBIsochronousInTransferResult(packets, concatDataViews(views));
    }
    async isochronousTransferOut(endpointNumber, data, packetLengths) {
      const handle = this.#requireHandle();
      checkEndpointNumber(endpointNumber);
      if (!Array.isArray(packetLengths)) throw new TypeError("packetLengths must be an array");
      packetLengths.forEach((l) => checkLength(l, "packetLengths[]"));
      const bytes = bufferSourceToUint8Array(data);
      const r = await rpcCall(this.#rt, "isochronousTransferOut", {
        handle,
        endpointNumber,
        data: bufferSourceToBase64(bytes),
        packetLengths
      });
      return new USBIsochronousOutTransferResult(r.map((p) => new USBIsochronousOutTransferPacket(p.status, p.bytesWritten)));
    }
  };
  var USBConnectionEvent = class extends Event {
    #device;
    constructor(type, eventInitDict) {
      super(type, eventInitDict);
      if (!eventInitDict || !eventInitDict.device) throw new TypeError("Failed to construct 'USBConnectionEvent': required member device is undefined.");
      this.#device = eventInitDict.device;
    }
    get device() {
      return this.#device;
    }
    get [Symbol.toStringTag]() {
      return "USBConnectionEvent";
    }
  };
  var USB = class extends EventTarget {
    #rt;
    #known = /* @__PURE__ */ new Map();
    #onconnect = null;
    #ondisconnect = null;
    constructor(token, rt) {
      super();
      checkToken(token);
      this.#rt = rt;
      const unsubscribe = rt.transport.onEvent((ev) => this.#onBridgeEvent(ev));
      usbInternals.set(this, { dispose: unsubscribe });
    }
    #track(wire) {
      const key = wire.deviceId ?? `${wire.vendorId}:${wire.productId}:${wire.serialNumber ?? ""}`;
      const existing = this.#known.get(key);
      if (existing) {
        deviceInternals.get(existing)?.refresh(wire);
        return existing;
      }
      const created = new USBDevice(INTERNAL, this.#rt, wire);
      this.#known.set(key, created);
      return created;
    }
    #onBridgeEvent(ev) {
      if (!ev || ev.event !== "connect" && ev.event !== "disconnect" || !ev.device) return;
      const device = this.#track(ev.device);
      if (ev.event === "disconnect") deviceInternals.get(device)?.markDisconnected();
      this.dispatchEvent(new USBConnectionEvent(ev.event, { device }));
    }
    async getDevices() {
      const wires = await rpcCall(this.#rt, "getDevices", {});
      return wires.map((w) => this.#track(w));
    }
    async requestDevice(options) {
      if (typeof options !== "object" || options === null) {
        throw new TypeError("Failed to execute 'requestDevice' on 'USB': 1 argument required, but only 0 present.");
      }
      const opts = options;
      if (opts.filters === void 0) {
        throw new TypeError("Failed to execute 'requestDevice' on 'USB': required member filters is undefined.");
      }
      const filters = checkFilters(opts.filters, "filters");
      const exclusionFilters = checkFilters(opts.exclusionFilters ?? [], "exclusionFilters");
      const activation = typeof navigator !== "undefined" ? navigator.userActivation : void 0;
      if (activation && activation.isActive === false) {
        throw new DOMException("Must be handling a user gesture to show a permission request.", "SecurityError");
      }
      let wire;
      try {
        wire = await this.#rt.requestDevice({
          filters,
          exclusionFilters,
          hasGesture: activation ? activation.isActive : void 0
        });
      } catch (e) {
        if (e instanceof DOMException) throw e;
        return throwFromRpcError(e);
      }
      return this.#track(wire);
    }
    get onconnect() {
      return this.#onconnect;
    }
    set onconnect(handler) {
      if (this.#onconnect) this.removeEventListener("connect", this.#onconnect);
      this.#onconnect = typeof handler === "function" ? handler : null;
      if (this.#onconnect) this.addEventListener("connect", this.#onconnect);
    }
    get ondisconnect() {
      return this.#ondisconnect;
    }
    set ondisconnect(handler) {
      if (this.#ondisconnect) this.removeEventListener("disconnect", this.#ondisconnect);
      this.#ondisconnect = typeof handler === "function" ? handler : null;
      if (this.#ondisconnect) this.addEventListener("disconnect", this.#ondisconnect);
    }
    get [Symbol.toStringTag]() {
      return "USB";
    }
  };
  function createUsbApi(rt) {
    const usb = new USB(INTERNAL, rt);
    return {
      usb,
      dispose: () => usbInternals.get(usb)?.dispose(),
      globals: {
        USB,
        USBDevice,
        USBConnectionEvent,
        USBConfiguration,
        USBInterface,
        USBAlternateInterface,
        USBEndpoint,
        USBInTransferResult,
        USBOutTransferResult,
        USBIsochronousInTransferPacket,
        USBIsochronousInTransferResult,
        USBIsochronousOutTransferPacket,
        USBIsochronousOutTransferResult
      }
    };
  }

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

  // src/core/install.ts
  function installNavigatorUsb(options) {
    const w = options.win ?? globalThis;
    const nav = w.navigator;
    if ("__iosWebUSB" in w) return { installed: false, reason: "already-installed" };
    if (!options.force && "usb" in nav) return { installed: false, reason: "native-usb-present" };
    if (w.isSecureContext === false) return { installed: false, reason: "insecure-context" };
    const policy = w.document.permissionsPolicy;
    if (policy && typeof policy.allowsFeature === "function") {
      try {
        if (!policy.allowsFeature("usb")) return { installed: false, reason: "permissions-policy" };
      } catch {
      }
    }
    const api = createUsbApi(options.runtime);
    try {
      Object.defineProperty(nav, "usb", { value: api.usb, writable: false, configurable: false, enumerable: true });
    } catch {
      api.dispose();
      return { installed: false, reason: "define-failed" };
    }
    for (const [name, value] of Object.entries(api.globals)) {
      if (!(name in w)) Object.defineProperty(w, name, { value, writable: true, enumerable: false, configurable: true });
    }
    const info = Object.freeze({
      version: VERSION,
      protocolVersion: PROTOCOL_VERSION,
      variant: options.variant,
      bridgeInfo: () => options.runtime.transport.call("bridgeInfo", {})
    });
    Object.defineProperty(w, "__iosWebUSB", { value: info, writable: false, enumerable: false, configurable: false });
    return { installed: true, reason: "installed" };
  }

  // src/core/pick.ts
  function createRelayPicker(transport2) {
    return async (ctx) => {
      try {
        return await transport2.call("requestDevice", {
          filters: ctx.filters,
          exclusionFilters: ctx.exclusionFilters
        });
      } catch (e) {
        return throwFromRpcError(e);
      }
    };
  }

  // src/core/transports/postmessage.ts
  var RELAY_CHANNEL = "__iosWebusb__";
  function targetOriginOf(win) {
    const origin = win.location.origin;
    return origin && origin !== "null" ? origin : "*";
  }
  var PostMessageTransport = class {
    #win;
    #timeoutMs;
    #nextId = 1;
    #pending = /* @__PURE__ */ new Map();
    #handlers = /* @__PURE__ */ new Set();
    #listener;
    constructor(win, options = {}) {
      this.#win = win;
      this.#timeoutMs = options.timeoutMs ?? 12e4;
      this.#listener = (ev) => this.#onMessage(ev);
      win.addEventListener("message", this.#listener);
    }
    call(method, params, _meta) {
      const id = this.#nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`the extension did not answer ${method} in time`));
        }, this.#timeoutMs);
        this.#pending.set(id, { resolve, reject, timer });
        const msg = { channel: RELAY_CHANNEL, dir: "toContent", kind: "call", id, method, params };
        this.#win.postMessage(msg, targetOriginOf(this.#win));
      });
    }
    onEvent(handler) {
      this.#handlers.add(handler);
      return () => {
        this.#handlers.delete(handler);
      };
    }
    close() {
      this.#win.removeEventListener("message", this.#listener);
      for (const [id, p] of this.#pending) {
        clearTimeout(p.timer);
        p.reject(new Error("transport is closed"));
        this.#pending.delete(id);
      }
    }
    #onMessage(ev) {
      if (ev.source !== this.#win) return;
      const data = ev.data;
      if (!data || data.channel !== RELAY_CHANNEL || data.dir !== "toPage") return;
      if (data.kind === "response") {
        const p = this.#pending.get(data.id);
        if (!p) return;
        this.#pending.delete(data.id);
        clearTimeout(p.timer);
        if (typeof data.error === "string") p.reject(new Error(data.error));
        else p.resolve(data.result);
      } else if (data.kind === "event") {
        const event = { event: data.event, device: data.device };
        for (const h of [...this.#handlers]) {
          try {
            h(event);
          } catch {
          }
        }
      }
    }
  };

  // src/crx/page.ts
  var transport = new PostMessageTransport(window);
  installNavigatorUsb({
    runtime: { transport, requestDevice: createRelayPicker(transport) },
    variant: "crx"
  });
})();
