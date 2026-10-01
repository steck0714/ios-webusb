// install.ts — attach navigator.usb (and the constructors) to a window
// =====================================================================
// Order of decisions, like fox-webusb's page_polyfill.js: yield to a real/other
// implementation first, refuse insecure contexts (WebUSB is [SecureContext]), respect a
// Permissions-Policy that disables `usb`, then define the property non-configurable so the
// page cannot `delete navigator.usb` and slip in a fake.

import { createUsbApi, type UsbRuntime } from './usb.ts';
import { PROTOCOL_VERSION } from './protocol.ts';
import { VERSION } from './version.ts';

export type Variant = 'crx' | 'shortcut';

export type InstallReason =
  | 'installed'
  | 'already-installed'
  | 'native-usb-present'
  | 'insecure-context'
  | 'permissions-policy'
  | 'define-failed';

export interface InstallOptions {
  runtime: UsbRuntime;
  variant: Variant;
  /** Replace an existing navigator.usb (only possible if that property is configurable). */
  force?: boolean;
  /** Target window; defaults to the current global. Tests pass a jsdom window. */
  win?: Window & typeof globalThis;
}

export interface InstallResult {
  installed: boolean;
  reason: InstallReason;
}

export function installNavigatorUsb(options: InstallOptions): InstallResult {
  const w = options.win ?? (globalThis as unknown as Window & typeof globalThis);
  const nav = w.navigator;

  if ('__iosWebUSB' in w) return { installed: false, reason: 'already-installed' };
  if (!options.force && 'usb' in nav) return { installed: false, reason: 'native-usb-present' };
  if (w.isSecureContext === false) return { installed: false, reason: 'insecure-context' };

  // document.permissionsPolicy is experimental (absent in Safari); when present, honour it.
  const policy = (w.document as Document & { permissionsPolicy?: { allowsFeature(name: string): boolean } }).permissionsPolicy;
  if (policy && typeof policy.allowsFeature === 'function') {
    try {
      if (!policy.allowsFeature('usb')) return { installed: false, reason: 'permissions-policy' };
    } catch { /* unknown feature name in this browser: do not restrict */ }
  }

  const api = createUsbApi(options.runtime);
  try {
    Object.defineProperty(nav, 'usb', { value: api.usb, writable: false, configurable: false, enumerable: true });
  } catch {
    api.dispose();
    return { installed: false, reason: 'define-failed' };
  }

  // Feature detection in the wild also looks at the constructors (`'USBDevice' in window`).
  // Define each only when absent so an unrelated page global named `USB` is never clobbered.
  for (const [name, value] of Object.entries(api.globals)) {
    if (!(name in w)) Object.defineProperty(w, name, { value, writable: true, enumerable: false, configurable: true });
  }

  const info = Object.freeze({
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    variant: options.variant,
    bridgeInfo: () => options.runtime.transport.call('bridgeInfo', {}),
  });
  Object.defineProperty(w, '__iosWebUSB', { value: info, writable: false, enumerable: false, configurable: false });
  return { installed: true, reason: 'installed' };
}
