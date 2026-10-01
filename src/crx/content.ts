// content.ts — content script entry (isolated world), wires relay.ts to the real browser.
import { OverlayChooser } from '../core/chooser.ts';
import { startRelay } from './relay.ts';

type Ext = typeof chrome;
const ext: Ext = (globalThis as unknown as { browser?: Ext }).browser ?? chrome;

const locale = ext.i18n?.getUILanguage?.() ?? navigator.language;

startRelay({
  win: window,
  connect: () => ext.runtime.connect({ name: 'ios-webusb' }),
  // The chooser lives in this world and only reacts to real (trusted) input.
  chooser: new OverlayChooser({ locale, origin: location.host, requireTrustedInput: true }),
  locale,
});

// page.js is a web-accessible extension file rather than an inline script, so pages whose CSP
// forbids inline scripts still get navigator.usb (same approach as fox-webusb).
try {
  const script = document.createElement('script');
  script.src = ext.runtime.getURL('page.js');
  script.onload = () => script.remove();
  script.onerror = () => script.remove();
  (document.head ?? document.documentElement).appendChild(script);
} catch {
  /* documents we cannot inject into are skipped silently */
}
