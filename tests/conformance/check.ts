// Compile-time only. Every runtime class of src/core/usb.ts must be usable wherever the
// loaded WebUSB types (W3C's or ours, see spec-alias.d.ts) expect the real thing:
// every member the spec type has must exist on the class with a compatible type.
//
// Skipped on purpose: the event-handler properties and add/removeEventListener. They take
// the event *class* in a contravariant position, and a class with #private fields is
// nominal, so a structural spec type can never be passed there. Those are covered by the
// runtime tests (tests/usb.model.test.ts).
import * as impl from '../../src/core/usb.ts';

type SkipKeys = 'onconnect' | 'ondisconnect' | 'addEventListener' | 'removeEventListener';

/** Keys of `Spec` that `Impl` lacks or has with an incompatible type. */
type Problems<Impl, Spec> = {
  [K in Exclude<keyof Spec, SkipKeys>]: K extends keyof Impl ? (Impl[K] extends Spec[K] ? never : K) : K;
}[Exclude<keyof Spec, SkipKeys>];
type AssertNever<T extends never> = T;

export type Checks = [
  AssertNever<Problems<impl.USB, SpecUSB>>,
  AssertNever<Problems<impl.USBDevice, SpecUSBDevice>>,
  AssertNever<Problems<impl.USBConfiguration, SpecUSBConfiguration>>,
  AssertNever<Problems<impl.USBInterface, SpecUSBInterface>>,
  AssertNever<Problems<impl.USBAlternateInterface, SpecUSBAlternateInterface>>,
  AssertNever<Problems<impl.USBEndpoint, SpecUSBEndpoint>>,
  AssertNever<Problems<impl.USBConnectionEvent, SpecUSBConnectionEvent>>,
  AssertNever<Problems<impl.USBInTransferResult, SpecUSBInTransferResult>>,
  AssertNever<Problems<impl.USBOutTransferResult, SpecUSBOutTransferResult>>,
  AssertNever<Problems<impl.USBIsochronousInTransferPacket, SpecUSBIsochronousInTransferPacket>>,
  AssertNever<Problems<impl.USBIsochronousInTransferResult, SpecUSBIsochronousInTransferResult>>,
  AssertNever<Problems<impl.USBIsochronousOutTransferPacket, SpecUSBIsochronousOutTransferPacket>>,
  AssertNever<Problems<impl.USBIsochronousOutTransferResult, SpecUSBIsochronousOutTransferResult>>,
];

// The checker itself must be able to fail, otherwise a green build proves nothing.
// @ts-expect-error: wrong member type is reported
export type MustFailType = AssertNever<Problems<{ vendorId: string }, { vendorId: number }>>;
// @ts-expect-error: missing member is reported
export type MustFailMissing = AssertNever<Problems<{ vendorId: number }, { vendorId: number; productId: number }>>;
