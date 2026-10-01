// protocol.ts — ios-webusb wire protocol (v0, WIP)
// ================================================
// The polyfill (page side) and the bridge (the process that really owns the USB
// device) speak a small JSON-RPC-like protocol. The shapes of devices, transfers and
// errors are taken from tauri-webusb (bridge.ts), the "KindError: detail" error
// strings and base64 payloads from fox-webusb / pyside6-webusb, so an existing host can
// be adapted with little work.
//
//   request : { id, method, params, meta? }
//   response: { id, result }  |  { id, error: "NotFoundError: ..." }
//   event   : { event: "connect" | "disconnect", device }
//
// Binary payloads are base64 strings. `meta` is filled by the trusted side of the
// transport (see crx/content.ts and crx/background.ts) and never by the page.

export const PROTOCOL_VERSION = 0;

export type WireDirection = 'in' | 'out';
export type WireEndpointType = 'bulk' | 'interrupt' | 'isochronous';
export type WireTransferStatus = 'ok' | 'stall' | 'babble';
export type WireRequestType = 'standard' | 'class' | 'vendor';
export type WireRecipient = 'device' | 'interface' | 'endpoint' | 'other';

export interface WireEndpoint {
  endpointNumber: number;
  direction: WireDirection;
  type: WireEndpointType;
  packetSize: number;
}

export interface WireAlternateInterface {
  alternateSetting: number;
  interfaceClass: number;
  interfaceSubclass: number;
  interfaceProtocol: number;
  interfaceProtected: boolean;
  interfaceName: string | null;
  endpoints: WireEndpoint[];
}

export interface WireInterface {
  interfaceNumber: number;
  alternates: WireAlternateInterface[];
}

export interface WireConfiguration {
  configurationValue: number;
  configurationName: string | null;
  interfaces: WireInterface[];
}

export interface WireDevice {
  /** Bridge-scoped stable id. Optional: falls back to vendorId/productId/serialNumber. */
  deviceId?: string;
  vendorId: number;
  productId: number;
  manufacturerName: string | null;
  productName: string | null;
  serialNumber: string | null;
  deviceClass: number;
  deviceSubclass: number;
  deviceProtocol: number;
  usbVersionMajor: number;
  usbVersionMinor: number;
  usbVersionSubminor: number;
  deviceVersionMajor: number;
  deviceVersionMinor: number;
  deviceVersionSubminor: number;
  configurations: WireConfiguration[];
  activeConfigurationValue: number | null;
}

export interface WireFilter {
  vendorId?: number;
  productId?: number;
  classCode?: number;
  subclassCode?: number;
  protocolCode?: number;
  serialNumber?: string;
}

export interface WireControlSetup {
  requestType: WireRequestType;
  recipient: WireRecipient;
  request: number;
  value: number;
  index: number;
}

export interface WireInTransferResult {
  status: WireTransferStatus;
  data: string; // base64
  warning?: string;
}
export interface WireOutTransferResult {
  status: WireTransferStatus;
  bytesWritten: number;
  warning?: string;
}
export interface WireIsoInPacket {
  status: WireTransferStatus;
  data: string; // base64
}
export interface WireIsoOutPacket {
  status: WireTransferStatus;
  bytesWritten: number;
}
export interface WireOpenResult {
  handle: number;
  descriptor: WireDevice;
}

export interface DeviceRef {
  deviceId?: string;
  vendorId: number;
  productId: number;
  serialNumber?: string;
}

export interface RpcMethodMap {
  hello: {
    params: { protocol: number; client: string; token?: string };
    result: { protocol: number; server: string; capabilities: string[] };
  };
  /** Same payload as `hello`, callable by pages (F12: `__iosWebUSB.bridgeInfo()`). */
  bridgeInfo: {
    params: Record<string, never>;
    result: { protocol: number; server: string; capabilities: string[] };
  };
  /**
   * RELAY-LEVEL, never sent to the bridge. The crx content script runs the whole
   * "list -> trusted chooser -> grant" step itself, so page scripts cannot grant a
   * device without a real click on the chooser (see crx/relay.ts).
   */
  requestDevice: {
    params: { filters: WireFilter[]; exclusionFilters: WireFilter[] };
    result: WireDevice;
  };
  /** Devices this origin has already been granted (navigator.usb.getDevices). */
  getDevices: { params: Record<string, never>; result: WireDevice[] };
  /** Devices that match the filters and could be offered in the chooser. */
  listAvailableDevices: {
    params: { filters: WireFilter[]; exclusionFilters: WireFilter[] };
    result: WireDevice[];
  };
  /** The user picked a device in the chooser: grant it to the calling origin. */
  grantDevice: { params: DeviceRef; result: WireDevice };
  open: { params: DeviceRef; result: WireOpenResult };
  close: { params: { handle: number }; result: null };
  forget: { params: DeviceRef; result: null };
  selectConfiguration: { params: { handle: number; configurationValue: number }; result: null };
  claimInterface: { params: { handle: number; interfaceNumber: number }; result: null };
  releaseInterface: { params: { handle: number; interfaceNumber: number }; result: null };
  selectAlternateInterface: {
    params: { handle: number; interfaceNumber: number; alternateSetting: number };
    result: null;
  };
  resetDevice: { params: { handle: number }; result: null };
  clearHalt: {
    params: { handle: number; endpointNumber: number; direction: WireDirection };
    result: null;
  };
  controlTransferIn: {
    params: { handle: number; setup: WireControlSetup; length: number };
    result: WireInTransferResult;
  };
  controlTransferOut: {
    params: { handle: number; setup: WireControlSetup; data: string };
    result: WireOutTransferResult;
  };
  transferIn: {
    params: { handle: number; endpointNumber: number; length: number };
    result: WireInTransferResult;
  };
  transferOut: {
    params: { handle: number; endpointNumber: number; data: string };
    result: WireOutTransferResult;
  };
  isochronousTransferIn: {
    params: { handle: number; endpointNumber: number; packetLengths: number[] };
    result: WireIsoInPacket[];
  };
  isochronousTransferOut: {
    params: { handle: number; endpointNumber: number; data: string; packetLengths: number[] };
    result: WireIsoOutPacket[];
  };
}

export type RpcMethod = keyof RpcMethodMap;

export const RPC_METHODS = [
  'hello', 'bridgeInfo', 'requestDevice', 'getDevices', 'listAvailableDevices', 'grantDevice', 'open', 'close', 'forget',
  'selectConfiguration', 'claimInterface', 'releaseInterface', 'selectAlternateInterface',
  'resetDevice', 'clearHalt', 'controlTransferIn', 'controlTransferOut', 'transferIn',
  'transferOut', 'isochronousTransferIn', 'isochronousTransferOut',
] as const satisfies readonly RpcMethod[];

// Compile-time check: RPC_METHODS lists every method of RpcMethodMap.
type MissingMethods = Exclude<RpcMethod, (typeof RPC_METHODS)[number]>;
export const _rpcMethodsAreExhaustive: MissingMethods extends never ? true : never = true;

/** Implemented by the bridge: everything except the relay-level `requestDevice`. */
export const BRIDGE_METHODS: readonly RpcMethod[] = RPC_METHODS.filter((m) => m !== 'requestDevice');

/**
 * Only trusted code (extension content script / background, or the page itself in the
 * Shortcuts build where no trusted world exists) may call these: they decide what an
 * origin is allowed to touch.
 */
export const TRUSTED_ONLY_METHODS: readonly RpcMethod[] = ['hello', 'listAvailableDevices', 'grantDevice'];

/** What a web page may ask the crx relay. */
export const PAGE_RPC_METHODS: readonly RpcMethod[] = RPC_METHODS.filter(
  (m) => !TRUSTED_ONLY_METHODS.includes(m),
);

export interface CallMeta {
  /** Set by the trusted side: a real user gesture happened recently. */
  hasGesture?: boolean;
  /** Set by the trusted side: origin of the calling frame. */
  origin?: string;
  /** UI language, only used to pick the language of prompts. */
  locale?: string;
  timeoutMs?: number;
}

export interface RpcRequest {
  id: number;
  method: string;
  params: unknown;
  meta?: CallMeta;
}
export interface RpcResponse {
  id: number;
  result?: unknown;
  error?: string;
}
export interface BridgeEvent {
  event: 'connect' | 'disconnect';
  device: WireDevice;
  /**
   * Origins that hold a grant for this device. A relay shared by several pages (the crx
   * background) forwards the event only to pages whose origin is listed; with no
   * `origins` it forwards to nobody (deny by default: no cross-origin device leaks).
   */
  origins?: string[];
}

export interface RpcTransport {
  call<M extends RpcMethod>(
    method: M,
    params: RpcMethodMap[M]['params'],
    meta?: CallMeta,
  ): Promise<RpcMethodMap[M]['result']>;
  /** Subscribe to bridge events. Returns an unsubscribe function. */
  onEvent(handler: (event: BridgeEvent) => void): () => void;
  close(): void;
}
