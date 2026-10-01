import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/core/version.ts';
import { makeDom } from './helpers.ts';

const code = readFileSync(new URL('../dist/shortcuts/ios-webusb.js', import.meta.url), 'utf8');
const windows: Array<{ close(): void }> = [];
after(() => { for (const w of windows) w.close(); }); // drops the toast's fallback timer

function run(src: string = code, prepare?: (win: any) => void) {
  const { win, doc } = makeDom();
  windows.push(win);
  const results: any[] = [];
  (win as any).completion = (r: object) => { results.push({ ...r }); }; // copy: jsdom objects have another realm's prototype
  prepare?.(win);
  (win as any).eval(src);
  return { win: win as any, doc, results };
}
const toast = (doc: Document): string | null => doc.querySelector('[role="status"]')?.textContent ?? null;

test('Run JavaScript on Web Page: installs navigator.usb and reports through completion()', () => {
  const { win, doc, results } = run();
  assert.deepEqual(results, [{ ok: true, reason: 'installed' }]);
  assert.ok('usb' in win.navigator);
  assert.equal(Object.prototype.toString.call(win.navigator.usb), '[object USB]');
  assert.equal(win.__iosWebUSB.variant, 'shortcut');
  assert.equal(doc.documentElement.getAttribute('data-ios-webusb'), 'installed');
  assert.equal(doc.querySelectorAll('script').length, 0, 'the injected <script> removes itself');
  assert.match(toast(doc)!, /navigator\.usb is now available/);
});

test('running it twice is harmless', () => {
  const { win, results } = run();
  win.eval(code);
  assert.deepEqual(results.map((r) => r.reason), ['installed', 'already-installed']);
  assert.ok(results.every((r) => r.ok));
});

test('a bad bridge URL is reported and nothing is installed', () => {
  const { win, doc, results } = run(code.replace('wss://192.168.0.10:8765/', 'http://nope/'));
  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /^error: .*ws:\/\/ or wss:\/\//);
  assert.ok(!('usb' in win.navigator));
  assert.match(toast(doc)!, /^✕\s+ios-webusb: error:/);
});

test('a browser with native WebUSB is left alone', () => {
  const { win, results } = run(code, (w) => Object.defineProperty(w.navigator, 'usb', { value: { native: true }, configurable: true }));
  assert.deepEqual(results, [{ ok: true, reason: 'native-usb-present' }]);
  assert.deepEqual(win.navigator.usb, { native: true });
});

test('when the page blocks the injected script (CSP) it says so', () => {
  const { win, doc, results } = run(code, (w) => { w.document.head.appendChild = (n: Node) => n; });
  assert.deepEqual(results, [{ ok: false, reason: 'blocked' }]);
  assert.ok(!('usb' in win.navigator));
  assert.match(toast(doc)!, /Content-Security-Policy/);
});

test('works outside Shortcuts too (no completion function)', () => {
  const { win } = run(code, (w) => { delete w.completion; });
  assert.ok('usb' in win.navigator);
});

test('the file is a self-describing paste target', () => {
  assert.ok(code.startsWith(`// ios-webusb ${VERSION}`));
  assert.match(code, /var IOS_WEBUSB_CONFIG = \{ bridgeUrl: "wss:\/\//);
});
