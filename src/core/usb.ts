// usb.ts — the navigator.usb object model (WIP)
// =============================================
// Real `class ... extends EventTarget / Event` hierarchies with `#private` state, as in
// tauri-webusb's polyfill.ts (itself the devtools-resistant rewrite from fox-webusb), so
// `navigator.usb instanceof EventTarget`, `Object.prototype.toString.call(device)` and
// friends behave like a browser's.
//
// Everything that touches the bridge goes through `UsbRuntime.transport`, so the same
// classes serve the crx build (window.postMessage → extension → WebSocket) and the
// Shortcuts build (WebSocket straight from the page).
//
// Known gaps in this WIP (see README): descriptor classes cannot be constructed by page
// code; isochronous transfers depend on the bridge; no per-origin state lives here.

import type {
  BridgeEvent,
  CallMeta,
  DeviceRef,
  RpcMethod,
  RpcMethodMap,
  RpcTransport,
  WireAlternateInterface,
  WireConfiguration,
  WireControlSetup,
  WireDevice,
  WireDirection,
  WireEndpoint,
  WireEndpointType,
  WireFilter,
  WireInterface,
  WireTransferStatus,
} from './protocol.ts';
import { base64ToUint8Array, bufferSourceToBase64, bufferSourceToUint8Array } from './base64.ts';
import { throwFromRpcError } from './errors.ts';

export interface DeviceChooserContext {
  filters: WireFilter[];
  exclusionFilters: WireFilter[];
  /** Ask the bridge again (the "search again" button of the chooser). */
  refresh?: () => Promise<WireDevice[]>;
}

/** Shows the device picker. Resolve `null` when the user cancels. */
export interface DeviceChooser {
  choose(candidates: WireDevice[], context: DeviceChooserContext): Promise<WireDevice | null>;
}

export interface RequestDeviceContext {
  filters: WireFilter[];
  exclusionFilters: WireFilter[];
  /** navigator.userActivation.isActive at call time, when the browser has that API. */
  hasGesture?: boolean;
}

export interface UsbRuntime {
  transport: RpcTransport;
  /**
   * Runs the whole "show chooser -> user picks -> grant" step and resolves with the granted
   * device. Reject with NotFoundError when the user cancels. See pick.ts: the crx build
   * delegates this to the content script (trusted UI), the Shortcuts build runs it in the page.
   */
  requestDevice(context: RequestDeviceContext): Promise<WireDevice>;
}

// ---------------------------------------------------------------- internals

/** Construction token: only this module can create instances (real browsers throw "Illegal constructor"). */
const INTERNAL: unique symbol = Symbol('ios-webusb.internal');
function checkToken(token: unknown): void {
  if (token !== INTERNAL) throw new TypeError('Illegal constructor');
}

interface DeviceInternals {
  isClaimed(interfaceNumber: number): boolean;
  activeAlternate(interfaceNumber: number): number;
  refresh(wire: WireDevice): void;
  markDisconnected(): void;
}
const deviceInternals = new WeakMap<object, DeviceInternals>();
function internalsOf(device: USBDevice): DeviceInternals {
  const internals = deviceInternals.get(device);
  if (!internals) throw new TypeError('Illegal invocation');
  return internals;
}

const usbInternals = new WeakMap<object, { dispose(): void }>();

async function rpcCall<M extends RpcMethod>(
  rt: UsbRuntime,
  method: M,
  params: RpcMethodMap[M]['params'],
  meta?: CallMeta,
): Promise<RpcMethodMap[M]['result']> {
  try {
    return await rt.transport.call(method, params, meta);
  } catch (e) {
    return throwFromRpcError(e);
  }
}

export function deviceRef(w: WireDevice): DeviceRef {
  return {
    deviceId: w.deviceId,
    vendorId: w.vendorId,
    productId: w.productId,
    serialNumber: w.serialNumber ?? undefined,
  };
}

function frozen<T>(items: T[]): T[] {
  return Object.freeze(items) as T[];
}

function wrapDataView(base64: string): DataView {
  const bytes = base64ToUint8Array(base64);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function concatDataViews(views: (DataView | undefined)[]): DataView {
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

// ---------------------------------------------------------------- validation

function isUint(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

function checkFilter(f: unknown, name: string): WireFilter {
  if (typeof f !== 'object' || f === null) throw new TypeError(`${name} contains an invalid USBDeviceFilter`);
  const r = f as Record<string, unknown>;
  const fields: [string, number][] = [
    ['vendorId', 0xffff], ['productId', 0xffff], ['classCode', 0xff], ['subclassCode', 0xff], ['protocolCode', 0xff],
  ];
  for (const [key, max] of fields) {
    if (r[key] !== undefined && !isUint(r[key], max)) {
      throw new TypeError(`${name}: ${key} must be an integer between 0 and ${max}`);
    }
  }
  if (r.serialNumber !== undefined && typeof r.serialNumber !== 'string') {
    throw new TypeError(`${name}: serialNumber must be a string`);
  }
  if (r.productId !== undefined && r.vendorId === undefined) throw new TypeError(`${name}: productId requires vendorId`);
  if (r.subclassCode !== undefined && r.classCode === undefined) throw new TypeError(`${name}: subclassCode requires classCode`);
  if (r.protocolCode !== undefined && r.subclassCode === undefined) throw new TypeError(`${name}: protocolCode requires subclassCode`);
  return f as WireFilter;
}

export function checkFilters(filters: unknown, name: string): WireFilter[] {
  if (!Array.isArray(filters)) throw new TypeError(`${name} must be an array`);
  return filters.map((f) => checkFilter(f, name));
}

function checkEndpointNumber(n: number): void {
  if (!isUint(n, 15) || n < 1) throw new DOMException('The endpoint number must be between 1 and 15', 'IndexSizeError');
}

function checkLength(length: number, name: string = 'length'): void {
  if (!isUint(length, 0xffffffff)) throw new TypeError(`${name} must be an unsigned integer`);
}

const REQUEST_TYPES = ['standard', 'class', 'vendor'];
const RECIPIENTS = ['device', 'interface', 'endpoint', 'other'];
function checkSetup(setup: unknown): WireControlSetup {
  if (typeof setup !== 'object' || setup === null) throw new TypeError('setup must be a USBControlTransferParameters');
  const s = setup as Record<string, unknown>;
  if (!REQUEST_TYPES.includes(s.requestType as string)) throw new TypeError('setup.requestType is invalid');
  if (!RECIPIENTS.includes(s.recipient as string)) throw new TypeError('setup.recipient is invalid');
  if (!isUint(s.request, 0xff)) throw new TypeError('setup.request must be an integer between 0 and 255');
  if (!isUint(s.value, 0xffff)) throw new TypeError('setup.value must be an integer between 0 and 65535');
  if (!isUint(s.index, 0xffff)) throw new TypeError('setup.index must be an integer between 0 and 65535');
  return { requestType: s.requestType, recipient: s.recipient, request: s.request, value: s.value, index: s.index } as WireControlSetup;
}

// ---------------------------------------------------------------- descriptors

export class USBEndpoint {
  #w: WireEndpoint;
  constructor(token: unknown, wire: WireEndpoint) {
    checkToken(token);
    this.#w = wire;
  }
  get endpointNumber(): number { return this.#w.endpointNumber; }
  get direction(): WireDirection { return this.#w.direction; }
  get type(): WireEndpointType { return this.#w.type; }
  get packetSize(): number { return this.#w.packetSize; }
  get [Symbol.toStringTag](): string { return 'USBEndpoint'; }
}

export class USBAlternateInterface {
  #w: WireAlternateInterface;
  #endpoints: USBEndpoint[];
  constructor(token: unknown, wire: WireAlternateInterface) {
    checkToken(token);
    this.#w = wire;
    this.#endpoints = frozen(wire.endpoints.map((e) => new USBEndpoint(INTERNAL, e)));
  }
  get alternateSetting(): number { return this.#w.alternateSetting; }
  get interfaceClass(): number { return this.#w.interfaceClass; }
  get interfaceSubclass(): number { return this.#w.interfaceSubclass; }
  get interfaceProtocol(): number { return this.#w.interfaceProtocol; }
  get interfaceName(): string | null { return this.#w.interfaceName; }
  get interfaceProtected(): boolean { return this.#w.interfaceProtected; }
  get endpoints(): USBEndpoint[] { return this.#endpoints; }
  get [Symbol.toStringTag](): string { return 'USBAlternateInterface'; }
}

export class USBInterface {
  #device: USBDevice;
  #w: WireInterface;
  #alternates: USBAlternateInterface[];
  constructor(token: unknown, device: USBDevice, wire: WireInterface) {
    checkToken(token);
    this.#device = device;
    this.#w = wire;
    this.#alternates = frozen(wire.alternates.map((a) => new USBAlternateInterface(INTERNAL, a)));
  }
  get interfaceNumber(): number { return this.#w.interfaceNumber; }
  get alternates(): USBAlternateInterface[] { return this.#alternates; }
  get alternate(): USBAlternateInterface {
    const active = internalsOf(this.#device).activeAlternate(this.#w.interfaceNumber);
    return this.#alternates.find((a) => a.alternateSetting === active) ?? this.#alternates[0]!;
  }
  get claimed(): boolean { return internalsOf(this.#device).isClaimed(this.#w.interfaceNumber); }
  get [Symbol.toStringTag](): string { return 'USBInterface'; }
}

export class USBConfiguration {
  #w: WireConfiguration;
  #interfaces: USBInterface[];
  constructor(token: unknown, device: USBDevice, wire: WireConfiguration) {
    checkToken(token);
    this.#w = wire;
    this.#interfaces = frozen(wire.interfaces.map((i) => new USBInterface(INTERNAL, device, i)));
  }
  get configurationValue(): number { return this.#w.configurationValue; }
  get configurationName(): string | null { return this.#w.configurationName; }
  get interfaces(): USBInterface[] { return this.#interfaces; }
  get [Symbol.toStringTag](): string { return 'USBConfiguration'; }
}

// ---------------------------------------------------------------- transfer results

export class USBInTransferResult {
  #data: DataView | undefined;
  #status: WireTransferStatus;
  constructor(status: WireTransferStatus, data?: DataView) {
    this.#status = status;
    this.#data = data;
  }
  get data(): DataView | undefined { return this.#data; }
  get status(): WireTransferStatus { return this.#status; }
  get [Symbol.toStringTag](): string { return 'USBInTransferResult'; }
}

export class USBOutTransferResult {
  #status: WireTransferStatus;
  #bytesWritten: number;
  constructor(status: WireTransferStatus, bytesWritten: number = 0) {
    this.#status = status;
    this.#bytesWritten = bytesWritten;
  }
  get bytesWritten(): number { return this.#bytesWritten; }
  get status(): WireTransferStatus { return this.#status; }
  get [Symbol.toStringTag](): string { return 'USBOutTransferResult'; }
}

export class USBIsochronousInTransferPacket {
  #data: DataView | undefined;
  #status: WireTransferStatus;
  constructor(status: WireTransferStatus, data?: DataView) {
    this.#status = status;
    this.#data = data;
  }
  get data(): DataView | undefined { return this.#data; }
  get status(): WireTransferStatus { return this.#status; }
  get [Symbol.toStringTag](): string { return 'USBIsochronousInTransferPacket'; }
}

export class USBIsochronousInTransferResult {
  #data: DataView | undefined;
  #packets: USBIsochronousInTransferPacket[];
  constructor(packets: USBIsochronousInTransferPacket[], data?: DataView) {
    this.#packets = packets;
    this.#data = data;
  }
  get data(): DataView | undefined { return this.#data; }
  get packets(): USBIsochronousInTransferPacket[] { return this.#packets; }
  get [Symbol.toStringTag](): string { return 'USBIsochronousInTransferResult'; }
}

export class USBIsochronousOutTransferPacket {
  #status: WireTransferStatus;
  #bytesWritten: number;
  constructor(status: WireTransferStatus, bytesWritten: number = 0) {
    this.#status = status;
    this.#bytesWritten = bytesWritten;
  }
  get bytesWritten(): number { return this.#bytesWritten; }
  get status(): WireTransferStatus { return this.#status; }
  get [Symbol.toStringTag](): string { return 'USBIsochronousOutTransferPacket'; }
}

export class USBIsochronousOutTransferResult {
  #packets: USBIsochronousOutTransferPacket[];
  constructor(packets: USBIsochronousOutTransferPacket[]) {
    this.#packets = packets;
  }
  get packets(): USBIsochronousOutTransferPacket[] { return this.#packets; }
  get [Symbol.toStringTag](): string { return 'USBIsochronousOutTransferResult'; }
}

// ---------------------------------------------------------------- USBDevice

export class USBDevice {
  #rt: UsbRuntime;
  #wire: WireDevice;
  #handle: number | null = null;
  #opening: Promise<void> | null = null;
  #claimed = new Set<number>();
  #alternate = new Map<number, number>();
  #configs: USBConfiguration[] = [];

  constructor(token: unknown, rt: UsbRuntime, wire: WireDevice) {
    checkToken(token);
    this.#rt = rt;
    this.#wire = wire;
    this.#rebuild();
    deviceInternals.set(this, {
      isClaimed: (n) => this.#claimed.has(n),
      activeAlternate: (n) => this.#alternate.get(n) ?? 0,
      refresh: (w) => { this.#wire = w; this.#rebuild(); },
      markDisconnected: () => { this.#handle = null; this.#claimed.clear(); this.#alternate.clear(); },
    });
  }

  #rebuild(): void {
    this.#configs = frozen(this.#wire.configurations.map((c) => new USBConfiguration(INTERNAL, this, c)));
  }

  #requireHandle(): number {
    if (this.#handle === null) {
      throw new DOMException('The device must be opened first', 'InvalidStateError');
    }
    return this.#handle;
  }

  #resetState(): void {
    this.#claimed.clear();
    this.#alternate.clear();
  }

  get usbVersionMajor(): number { return this.#wire.usbVersionMajor; }
  get usbVersionMinor(): number { return this.#wire.usbVersionMinor; }
  get usbVersionSubminor(): number { return this.#wire.usbVersionSubminor; }
  get deviceClass(): number { return this.#wire.deviceClass; }
  get deviceSubclass(): number { return this.#wire.deviceSubclass; }
  get deviceProtocol(): number { return this.#wire.deviceProtocol; }
  get vendorId(): number { return this.#wire.vendorId; }
  get productId(): number { return this.#wire.productId; }
  get deviceVersionMajor(): number { return this.#wire.deviceVersionMajor; }
  get deviceVersionMinor(): number { return this.#wire.deviceVersionMinor; }
  get deviceVersionSubminor(): number { return this.#wire.deviceVersionSubminor; }
  get manufacturerName(): string | null { return this.#wire.manufacturerName; }
  get productName(): string | null { return this.#wire.productName; }
  get serialNumber(): string | null { return this.#wire.serialNumber; }
  get opened(): boolean { return this.#handle !== null; }
  get configurations(): USBConfiguration[] { return this.#configs; }
  get configuration(): USBConfiguration | null {
    const value = this.#wire.activeConfigurationValue;
    if (value === null) return null;
    return this.#configs.find((c) => c.configurationValue === value) ?? null;
  }
  get [Symbol.toStringTag](): string { return 'USBDevice'; }

  open(): Promise<void> {
    if (this.#handle !== null) return Promise.resolve();
    if (this.#opening) return this.#opening;
    const attempt = (async () => {
      const r = await rpcCall(this.#rt, 'open', deviceRef(this.#wire));
      this.#handle = r.handle;
      this.#wire = r.descriptor;
      this.#rebuild();
    })();
    this.#opening = attempt.finally(() => { this.#opening = null; });
    return this.#opening;
  }

  async close(): Promise<void> {
    if (this.#handle === null) return;
    const handle = this.#handle;
    this.#handle = null;
    this.#resetState();
    await rpcCall(this.#rt, 'close', { handle });
  }

  /** Works whether or not the device is open (unlike tauri-webusb v0.0.0): the bridge revokes by identity. */
  async forget(): Promise<void> {
    await this.close();
    await rpcCall(this.#rt, 'forget', deviceRef(this.#wire));
  }

  async selectConfiguration(configurationValue: number): Promise<void> {
    const handle = this.#requireHandle();
    if (!isUint(configurationValue, 0xff)) throw new TypeError('configurationValue must be an integer between 0 and 255');
    await rpcCall(this.#rt, 'selectConfiguration', { handle, configurationValue });
    this.#resetState();
    this.#wire = { ...this.#wire, activeConfigurationValue: configurationValue };
    this.#rebuild();
  }

  async claimInterface(interfaceNumber: number): Promise<void> {
    const handle = this.#requireHandle();
    if (!isUint(interfaceNumber, 0xff)) throw new TypeError('interfaceNumber must be an integer between 0 and 255');
    await rpcCall(this.#rt, 'claimInterface', { handle, interfaceNumber });
    this.#claimed.add(interfaceNumber);
  }

  async releaseInterface(interfaceNumber: number): Promise<void> {
    const handle = this.#requireHandle();
    if (!isUint(interfaceNumber, 0xff)) throw new TypeError('interfaceNumber must be an integer between 0 and 255');
    await rpcCall(this.#rt, 'releaseInterface', { handle, interfaceNumber });
    this.#claimed.delete(interfaceNumber);
    this.#alternate.delete(interfaceNumber);
  }

  async selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void> {
    const handle = this.#requireHandle();
    if (!isUint(interfaceNumber, 0xff)) throw new TypeError('interfaceNumber must be an integer between 0 and 255');
    if (!isUint(alternateSetting, 0xff)) throw new TypeError('alternateSetting must be an integer between 0 and 255');
    await rpcCall(this.#rt, 'selectAlternateInterface', { handle, interfaceNumber, alternateSetting });
    this.#alternate.set(interfaceNumber, alternateSetting);
  }

  async reset(): Promise<void> {
    const handle = this.#requireHandle();
    await rpcCall(this.#rt, 'resetDevice', { handle });
    this.#resetState();
  }

  async clearHalt(direction: WireDirection, endpointNumber: number): Promise<void> {
    const handle = this.#requireHandle();
    if (direction !== 'in' && direction !== 'out') throw new TypeError("direction must be 'in' or 'out'");
    checkEndpointNumber(endpointNumber);
    await rpcCall(this.#rt, 'clearHalt', { handle, endpointNumber, direction });
  }

  async controlTransferIn(setup: unknown, length: number): Promise<USBInTransferResult> {
    const handle = this.#requireHandle();
    const s = checkSetup(setup);
    checkLength(length);
    const r = await rpcCall(this.#rt, 'controlTransferIn', { handle, setup: s, length });
    return new USBInTransferResult(r.status, wrapDataView(r.data));
  }

  async controlTransferOut(setup: unknown, data?: unknown): Promise<USBOutTransferResult> {
    const handle = this.#requireHandle();
    const s = checkSetup(setup);
    const bytes = data === undefined ? new Uint8Array(0) : bufferSourceToUint8Array(data);
    const r = await rpcCall(this.#rt, 'controlTransferOut', { handle, setup: s, data: bufferSourceToBase64(bytes) });
    return new USBOutTransferResult(r.status, r.bytesWritten);
  }

  async transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult> {
    const handle = this.#requireHandle();
    checkEndpointNumber(endpointNumber);
    checkLength(length);
    const r = await rpcCall(this.#rt, 'transferIn', { handle, endpointNumber, length });
    return new USBInTransferResult(r.status, wrapDataView(r.data));
  }

  async transferOut(endpointNumber: number, data: unknown): Promise<USBOutTransferResult> {
    const handle = this.#requireHandle();
    checkEndpointNumber(endpointNumber);
    const bytes = bufferSourceToUint8Array(data);
    const r = await rpcCall(this.#rt, 'transferOut', { handle, endpointNumber, data: bufferSourceToBase64(bytes) });
    return new USBOutTransferResult(r.status, r.bytesWritten);
  }

  async isochronousTransferIn(endpointNumber: number, packetLengths: number[]): Promise<USBIsochronousInTransferResult> {
    const handle = this.#requireHandle();
    checkEndpointNumber(endpointNumber);
    if (!Array.isArray(packetLengths)) throw new TypeError('packetLengths must be an array');
    packetLengths.forEach((l) => checkLength(l, 'packetLengths[]'));
    const r = await rpcCall(this.#rt, 'isochronousTransferIn', { handle, endpointNumber, packetLengths });
    const views = r.map((p) => wrapDataView(p.data));
    const packets = r.map((p, i) => new USBIsochronousInTransferPacket(p.status, views[i]));
    return new USBIsochronousInTransferResult(packets, concatDataViews(views));
  }

  async isochronousTransferOut(
    endpointNumber: number,
    data: unknown,
    packetLengths: number[],
  ): Promise<USBIsochronousOutTransferResult> {
    const handle = this.#requireHandle();
    checkEndpointNumber(endpointNumber);
    if (!Array.isArray(packetLengths)) throw new TypeError('packetLengths must be an array');
    packetLengths.forEach((l) => checkLength(l, 'packetLengths[]'));
    const bytes = bufferSourceToUint8Array(data);
    const r = await rpcCall(this.#rt, 'isochronousTransferOut', {
      handle, endpointNumber, data: bufferSourceToBase64(bytes), packetLengths,
    });
    return new USBIsochronousOutTransferResult(r.map((p) => new USBIsochronousOutTransferPacket(p.status, p.bytesWritten)));
  }
}

// ---------------------------------------------------------------- events / USB

export class USBConnectionEvent extends Event {
  #device: USBDevice;
  constructor(type: string, eventInitDict: EventInit & { device: USBDevice }) {
    super(type, eventInitDict);
    if (!eventInitDict || !eventInitDict.device) throw new TypeError("Failed to construct 'USBConnectionEvent': required member device is undefined.");
    this.#device = eventInitDict.device;
  }
  get device(): USBDevice { return this.#device; }
  get [Symbol.toStringTag](): string { return 'USBConnectionEvent'; }
}

type ConnectionHandler = ((this: USB, ev: USBConnectionEvent) => unknown) | null;

export class USB extends EventTarget {
  #rt: UsbRuntime;
  #known = new Map<string, USBDevice>();
  #onconnect: ConnectionHandler = null;
  #ondisconnect: ConnectionHandler = null;

  constructor(token: unknown, rt: UsbRuntime) {
    super();
    checkToken(token);
    this.#rt = rt;
    const unsubscribe = rt.transport.onEvent((ev) => this.#onBridgeEvent(ev));
    usbInternals.set(this, { dispose: unsubscribe });
  }

  #track(wire: WireDevice): USBDevice {
    const key = wire.deviceId ?? `${wire.vendorId}:${wire.productId}:${wire.serialNumber ?? ''}`;
    const existing = this.#known.get(key);
    if (existing) {
      deviceInternals.get(existing)?.refresh(wire);
      return existing;
    }
    const created = new USBDevice(INTERNAL, this.#rt, wire);
    this.#known.set(key, created);
    return created;
  }

  #onBridgeEvent(ev: BridgeEvent): void {
    if (!ev || (ev.event !== 'connect' && ev.event !== 'disconnect') || !ev.device) return;
    const device = this.#track(ev.device);
    if (ev.event === 'disconnect') deviceInternals.get(device)?.markDisconnected();
    this.dispatchEvent(new USBConnectionEvent(ev.event, { device }));
  }

  async getDevices(): Promise<USBDevice[]> {
    const wires = await rpcCall(this.#rt, 'getDevices', {});
    return wires.map((w) => this.#track(w));
  }

  async requestDevice(options?: unknown): Promise<USBDevice> {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError("Failed to execute 'requestDevice' on 'USB': 1 argument required, but only 0 present.");
    }
    const opts = options as { filters?: unknown; exclusionFilters?: unknown };
    if (opts.filters === undefined) {
      throw new TypeError("Failed to execute 'requestDevice' on 'USB': required member filters is undefined.");
    }
    const filters = checkFilters(opts.filters, 'filters');
    const exclusionFilters = checkFilters(opts.exclusionFilters ?? [], 'exclusionFilters');

    // Fail early when the page has no user activation. Browsers without the
    // UserActivation API (older Safari) skip this check; the trusted side (crx content
    // script, bridge) does its own gesture check.
    const activation = typeof navigator !== 'undefined' ? navigator.userActivation : undefined;
    if (activation && activation.isActive === false) {
      throw new DOMException('Must be handling a user gesture to show a permission request.', 'SecurityError');
    }

    let wire: WireDevice;
    try {
      wire = await this.#rt.requestDevice({
        filters, exclusionFilters, hasGesture: activation ? activation.isActive : undefined,
      });
    } catch (e) {
      if (e instanceof DOMException) throw e;
      return throwFromRpcError(e);
    }
    return this.#track(wire);
  }

  get onconnect(): ConnectionHandler { return this.#onconnect; }
  set onconnect(handler: ConnectionHandler) {
    if (this.#onconnect) this.removeEventListener('connect', this.#onconnect as EventListener);
    this.#onconnect = typeof handler === 'function' ? handler : null;
    if (this.#onconnect) this.addEventListener('connect', this.#onconnect as EventListener);
  }
  get ondisconnect(): ConnectionHandler { return this.#ondisconnect; }
  set ondisconnect(handler: ConnectionHandler) {
    if (this.#ondisconnect) this.removeEventListener('disconnect', this.#ondisconnect as EventListener);
    this.#ondisconnect = typeof handler === 'function' ? handler : null;
    if (this.#ondisconnect) this.addEventListener('disconnect', this.#ondisconnect as EventListener);
  }
  get [Symbol.toStringTag](): string { return 'USB'; }
}

// ---------------------------------------------------------------- factory

export interface UsbApi {
  usb: USB;
  /** Detach from the transport. */
  dispose(): void;
  /** Constructors that a real browser exposes on `window`. */
  globals: Record<string, unknown>;
}

export function createUsbApi(rt: UsbRuntime): UsbApi {
  const usb = new USB(INTERNAL, rt);
  return {
    usb,
    dispose: () => usbInternals.get(usb)?.dispose(),
    globals: {
      USB, USBDevice, USBConnectionEvent, USBConfiguration, USBInterface, USBAlternateInterface, USBEndpoint,
      USBInTransferResult, USBOutTransferResult, USBIsochronousInTransferPacket, USBIsochronousInTransferResult,
      USBIsochronousOutTransferPacket, USBIsochronousOutTransferResult,
    },
  };
}
