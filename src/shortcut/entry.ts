// entry.ts — Shortcuts build. Bundled as an IIFE exposing `__iosWebUsb.install(config)`;
// shortcuts/wrapper.template.js injects that bundle into the page's own JS world.
//
// No extension means no trusted world: the chooser runs in the page (createLocalPicker),
// and the WebSocket to the bridge is opened by the page itself, so it is subject to the
// page's mixed-content rules and CSP `connect-src` (use wss://).

import { OverlayChooser } from '../core/chooser.ts';
import { installNavigatorUsb, type InstallReason } from '../core/install.ts';
import { createLocalPicker } from '../core/pick.ts';
import { WebSocketTransport } from '../core/transports/websocket.ts';
import { parseBridgeUrl } from '../core/url.ts';
import { VERSION } from '../core/version.ts';

export interface ShortcutConfig {
  bridgeUrl: string;
  token?: string;
}

export interface ShortcutResult {
  /** True when navigator.usb is usable on this page after the call. */
  ok: boolean;
  reason: InstallReason | `error: ${string}`;
}

/** The wrapper (which may live in another JS world) reads the outcome from the shared DOM. */
export const STATE_ATTRIBUTE = 'data-ios-webusb';

export function install(config: ShortcutConfig): ShortcutResult {
  let result: ShortcutResult;
  try {
    const url = parseBridgeUrl(config.bridgeUrl);
    const transport = new WebSocketTransport({
      url: url.href,
      token: config.token || undefined,
      client: `ios-webusb-shortcut/${VERSION}`,
    });
    const chooser = new OverlayChooser({ locale: navigator.language, origin: location.host });
    const r = installNavigatorUsb({
      runtime: { transport, requestDevice: createLocalPicker(transport, chooser) },
      variant: 'shortcut',
    });
    if (!r.installed) transport.close();
    result = { ok: r.installed || r.reason === 'already-installed' || r.reason === 'native-usb-present', reason: r.reason };
  } catch (e) {
    result = { ok: false, reason: `error: ${e instanceof Error ? e.message : String(e)}` };
  }
  const state = result.reason === 'installed' || result.reason === 'already-installed' ? 'installed' : result.reason;
  document.documentElement.setAttribute(STATE_ATTRIBUTE, state);
  return result;
}
