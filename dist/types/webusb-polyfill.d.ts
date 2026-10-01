// webusb-polyfill.d.ts
// ====================
// Standalone global type declarations for `navigator.usb` as provided by ios-webusb
// (crx build and Shortcuts build alike). Reference it directly
//   /// <reference path="path/to/webusb-polyfill.d.ts" />
// or add it to tsconfig "include" to get editor support without importing anything.
//
// Same idea as tauri-webusb / fox-webusb `types/webusb-polyfill.d.ts`. Array and
// shapes follow @types/w3c-web-usb; arrays are ReadonlyArray like the WebIDL FrozenArray (and the
// sibling projects), which is also what the runtime gives you: they are frozen.
// Do NOT load this file together with @types/w3c-web-usb: both declare the same globals.

interface USBDeviceFilter {
  vendorId?: number;
  productId?: number;
  classCode?: number;
  subclassCode?: number;
  protocolCode?: number;
  serialNumber?: string;
}

interface USBDeviceRequestOptions {
  filters: USBDeviceFilter[];
  exclusionFilters?: USBDeviceFilter[];
}

type USBDirection = "in" | "out";
type USBEndpointType = "bulk" | "interrupt" | "isochronous";
type USBRequestType = "standard" | "class" | "vendor";
type USBRecipient = "device" | "interface" | "endpoint" | "other";
type USBTransferStatus = "ok" | "stall" | "babble";

interface USBControlTransferParameters {
  requestType: USBRequestType;
  recipient: USBRecipient;
  request: number;
  value: number;
  index: number;
}

interface USBEndpoint {
  readonly endpointNumber: number;
  readonly direction: USBDirection;
  readonly type: USBEndpointType;
  readonly packetSize: number;
}

interface USBAlternateInterface {
  readonly alternateSetting: number;
  readonly interfaceClass: number;
  readonly interfaceSubclass: number;
  readonly interfaceProtocol: number;
  readonly interfaceName: string | null;
  readonly endpoints: ReadonlyArray<USBEndpoint>;
  /** Non-spec: the bridge marks protected classes (HID, mass storage, ...). Informational only. */
  readonly interfaceProtected: boolean;
}

interface USBInterface {
  readonly interfaceNumber: number;
  readonly alternate: USBAlternateInterface;
  readonly alternates: ReadonlyArray<USBAlternateInterface>;
  readonly claimed: boolean;
}

interface USBConfiguration {
  readonly configurationValue: number;
  readonly configurationName: string | null;
  readonly interfaces: ReadonlyArray<USBInterface>;
}

interface USBInTransferResult {
  readonly data?: DataView;
  readonly status: USBTransferStatus;
}

interface USBOutTransferResult {
  readonly bytesWritten: number;
  readonly status: USBTransferStatus;
}

interface USBIsochronousInTransferPacket {
  readonly data?: DataView;
  readonly status: USBTransferStatus;
}

interface USBIsochronousInTransferResult {
  readonly data?: DataView;
  readonly packets: ReadonlyArray<USBIsochronousInTransferPacket>;
}

interface USBIsochronousOutTransferPacket {
  readonly bytesWritten: number;
  readonly status: USBTransferStatus;
}

interface USBIsochronousOutTransferResult {
  readonly packets: ReadonlyArray<USBIsochronousOutTransferPacket>;
}

interface USBDevice {
  readonly usbVersionMajor: number;
  readonly usbVersionMinor: number;
  readonly usbVersionSubminor: number;
  readonly deviceClass: number;
  readonly deviceSubclass: number;
  readonly deviceProtocol: number;
  readonly vendorId: number;
  readonly productId: number;
  readonly deviceVersionMajor: number;
  readonly deviceVersionMinor: number;
  readonly deviceVersionSubminor: number;
  readonly manufacturerName: string | null;
  readonly productName: string | null;
  readonly serialNumber: string | null;
  /** `null` until selectConfiguration() has run (matches real Chrome). */
  readonly configuration: USBConfiguration | null;
  readonly configurations: ReadonlyArray<USBConfiguration>;
  readonly opened: boolean;

  open(): Promise<void>;
  close(): Promise<void>;
  forget(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void>;
  controlTransferIn(setup: USBControlTransferParameters, length: number): Promise<USBInTransferResult>;
  controlTransferOut(setup: USBControlTransferParameters, data?: BufferSource): Promise<USBOutTransferResult>;
  clearHalt(direction: USBDirection, endpointNumber: number): Promise<void>;
  transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<USBOutTransferResult>;
  isochronousTransferIn(endpointNumber: number, packetLengths: number[]): Promise<USBIsochronousInTransferResult>;
  isochronousTransferOut(
    endpointNumber: number,
    data: BufferSource,
    packetLengths: number[],
  ): Promise<USBIsochronousOutTransferResult>;
  reset(): Promise<void>;
}

interface USBConnectionEventInit extends EventInit {
  device: USBDevice;
}

interface USBConnectionEvent extends Event {
  readonly device: USBDevice;
}

interface USBEventMap {
  connect: USBConnectionEvent;
  disconnect: USBConnectionEvent;
}

interface USB extends EventTarget {
  onconnect: ((this: USB, ev: USBConnectionEvent) => unknown) | null;
  ondisconnect: ((this: USB, ev: USBConnectionEvent) => unknown) | null;

  getDevices(): Promise<USBDevice[]>;
  requestDevice(options?: USBDeviceRequestOptions): Promise<USBDevice>;

  addEventListener<K extends keyof USBEventMap>(
    type: K,
    listener: (this: USB, ev: USBEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof USBEventMap>(
    type: K,
    listener: (this: USB, ev: USBEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

interface Navigator {
  readonly usb: USB;
}

// Constructors exposed on `window` (only USBConnectionEvent and the transfer results
// can be constructed by page code, like in real browsers).
declare var USB: { prototype: USB };
declare var USBDevice: { prototype: USBDevice };
declare var USBConfiguration: { prototype: USBConfiguration };
declare var USBInterface: { prototype: USBInterface };
declare var USBAlternateInterface: { prototype: USBAlternateInterface };
declare var USBEndpoint: { prototype: USBEndpoint };
declare var USBConnectionEvent: {
  prototype: USBConnectionEvent;
  new (type: "connect" | "disconnect", eventInitDict: USBConnectionEventInit): USBConnectionEvent;
};
declare var USBInTransferResult: {
  prototype: USBInTransferResult;
  new (status: USBTransferStatus, data?: DataView): USBInTransferResult;
};
declare var USBOutTransferResult: {
  prototype: USBOutTransferResult;
  new (status: USBTransferStatus, bytesWritten?: number): USBOutTransferResult;
};
declare var USBIsochronousInTransferPacket: {
  prototype: USBIsochronousInTransferPacket;
  new (status: USBTransferStatus, data?: DataView): USBIsochronousInTransferPacket;
};
declare var USBIsochronousInTransferResult: {
  prototype: USBIsochronousInTransferResult;
  new (packets: USBIsochronousInTransferPacket[], data?: DataView): USBIsochronousInTransferResult;
};
declare var USBIsochronousOutTransferPacket: {
  prototype: USBIsochronousOutTransferPacket;
  new (status: USBTransferStatus, bytesWritten?: number): USBIsochronousOutTransferPacket;
};
declare var USBIsochronousOutTransferResult: {
  prototype: USBIsochronousOutTransferResult;
  new (packets: USBIsochronousOutTransferPacket[]): USBIsochronousOutTransferResult;
};

/** ios-webusb only: what `window.__iosWebUSB.bridgeInfo()` resolves with. */
interface IosWebUSBBridgeInfo {
  readonly protocol: number;
  readonly server: string;
  readonly capabilities: string[];
}

/** ios-webusb only: present on `window` once the polyfill has been installed (F12: `__iosWebUSB`). */
interface IosWebUSBInfo {
  readonly version: string;
  readonly protocolVersion: number;
  readonly variant: "crx" | "shortcut";
  /** Asks the bridge who it is and what it supports. */
  bridgeInfo(): Promise<IosWebUSBBridgeInfo>;
}

interface Window {
  readonly __iosWebUSB?: IosWebUSBInfo;
}
