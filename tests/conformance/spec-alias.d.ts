// Global aliases for "whatever WebUSB types are loaded in this compilation": the W3C ones
// (@types/w3c-web-usb) in tsconfig.conformance-w3c.json, ours (types/webusb-polyfill.d.ts)
// in tsconfig.conformance-own.json. check.ts is a module whose classes shadow the plain names.
type SpecUSB = USB;
type SpecUSBDevice = USBDevice;
type SpecUSBConfiguration = USBConfiguration;
type SpecUSBInterface = USBInterface;
type SpecUSBAlternateInterface = USBAlternateInterface;
type SpecUSBEndpoint = USBEndpoint;
type SpecUSBConnectionEvent = USBConnectionEvent;
type SpecUSBInTransferResult = USBInTransferResult;
type SpecUSBOutTransferResult = USBOutTransferResult;
type SpecUSBIsochronousInTransferPacket = USBIsochronousInTransferPacket;
type SpecUSBIsochronousInTransferResult = USBIsochronousInTransferResult;
type SpecUSBIsochronousOutTransferPacket = USBIsochronousOutTransferPacket;
type SpecUSBIsochronousOutTransferResult = USBIsochronousOutTransferResult;
