import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OverlayChooser, sanitizeLabel, type ChooserOptions } from '../src/core/chooser.ts';
import type { DeviceChooserContext } from '../src/core/usb.ts';
import { makeDom, sleep, wireDevice } from './helpers.ts';

const devA = wireDevice({ deviceId: 'a', productName: 'First' });
const devB = wireDevice({ deviceId: 'b', productName: 'Second', vendorId: 0xabcd, productId: 2 });

function show(devices: any[], opts: Partial<ChooserOptions> = {}, ctx: Partial<DeviceChooserContext> = {}) {
  const { win, doc } = makeDom();
  const chooser = new OverlayChooser({ document: doc, shadowMode: 'open', animate: false, locale: 'ja-JP', origin: 'app.example', ...opts });
  const promise = chooser.choose(devices, { filters: [], exclusionFilters: [], ...ctx });
  const host = doc.querySelector('[data-ios-webusb-chooser]') as HTMLElement;
  const root = host.shadowRoot!;
  const q = <T extends Element = HTMLElement>(sel: string): T => root.querySelector(sel) as T;
  const all = <T extends Element = HTMLElement>(sel: string): T[] => [...root.querySelectorAll(sel)] as T[];
  const key = (target: Element, k: string) => target.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }));
  return { win, doc, host, root, promise, q, all, key };
}
const pending = (p: Promise<unknown>) => Promise.race([p, sleep(30).then(() => 'pending')]);

test('one row per device; descriptor strings are sanitized and never parsed as HTML', () => {
  const evil = wireDevice({
    deviceId: 'e', productName: 'Evil\u202e Name\u0000', manufacturerName: 'ACME\u200b Corp', serialNumber: 'S\nN1',
  });
  const html = wireDevice({ deviceId: 'h', productName: '<img src=x onerror=alert(1)>', manufacturerName: null, serialNumber: null, vendorId: 0xabcd, productId: 2 });
  const nameless = wireDevice({ deviceId: 'n', productName: null, manufacturerName: null, serialNumber: null, vendorId: 0x0001, productId: 0x0002 });
  const s = show([evil, html, nameless]);
  assert.deepEqual(s.all('.row .name').map((n) => n.textContent), ['Evil Name', '<img src=x onerror=alert(1)>', '名称不明のデバイス']);
  assert.equal(s.all('.row .meta')[0]!.textContent, 'ACME Corp · 1209:0001 · S/N SN1');
  assert.equal(s.all('.row .meta')[2]!.textContent, '0001:0002');
  assert.equal(s.root.querySelector('img'), null, 'text only, never markup');
  assert.match(s.q('.lead').textContent!, /app\.example/);
  s.host.remove();
});

test('Connect stays disabled until a device is selected, then resolves that exact device', async () => {
  const s = show([devA, devB]);
  const done = s.q<HTMLButtonElement>('.done');
  assert.equal(done.disabled, true);
  s.all<HTMLInputElement>('.row input')[1]!.click();
  assert.equal(done.disabled, false);
  done.click();
  assert.equal(await s.promise, devB);
  assert.equal(s.doc.querySelector('[data-ios-webusb-chooser]'), null, 'the sheet is gone');
});

test('Cancel, Escape and a tap on the dimmed area all cancel', async () => {
  const a = show([devA]); a.q('.cancel').click();
  assert.equal(await a.promise, null);
  const b = show([devA]); b.key(b.q('.sheet'), 'Escape');
  assert.equal(await b.promise, null);
  const c = show([devA]); c.q('.scrim').click();
  assert.equal(await c.promise, null);
  const d = show([devA]); d.q('.sheet').click(); // a tap inside the sheet must not dismiss it
  assert.equal(await pending(d.promise), 'pending');
  d.host.remove();
});

test('Enter on a selected radio connects', async () => {
  const s = show([devA, devB]);
  const input = s.all<HTMLInputElement>('.row input')[0]!;
  input.click();
  s.key(input, 'Enter');
  assert.equal(await s.promise, devA);
});

test('empty state, then "search again" fills the list', async () => {
  const s = show([], {}, { refresh: async () => [devA] });
  assert.equal(s.q('.empty').hidden, false);
  assert.equal(s.q('.group').hidden, true);
  assert.equal(s.q('.actions').hidden, false);
  s.q<HTMLButtonElement>('.act').click();
  await sleep(10);
  assert.equal(s.all('.row').length, 1);
  assert.equal(s.q('.empty').hidden, true);
  assert.match(s.q('.foot').textContent!, /1件/);
  assert.equal(s.q<HTMLButtonElement>('.act').disabled, false);
  s.host.remove();
});

test('the search-again row only exists when the caller can refresh', () => {
  const s = show([devA]);
  assert.equal(s.q('.actions').hidden, true);
  s.host.remove();
});

test('a failed search is reported in place and can be retried', async () => {
  let fail = true;
  const s = show([devA], {}, { refresh: async () => { if (fail) throw new Error('bridge down'); return [devB]; } });
  s.q<HTMLButtonElement>('.act').click();
  await sleep(10);
  assert.ok(s.q('.foot').classList.contains('err'));
  assert.equal(s.q('.foot').textContent, '検索に失敗しました: bridge down');
  assert.equal(s.q('.spin').hidden, true);
  assert.equal(s.all('.row').length, 1, 'the old list is kept');
  fail = false;
  s.q<HTMLButtonElement>('.act').click();
  await sleep(10);
  assert.deepEqual(s.all('.row .name').map((n) => n.textContent), ['Second']);
  assert.ok(!s.q('.foot').classList.contains('err'));
  s.host.remove();
});

test('requireTrustedInput: synthetic events (what a page script can send) do nothing', async () => {
  const s = show([devA], { requireTrustedInput: true }, { refresh: async () => [] });
  s.all<HTMLInputElement>('.row input')[0]!.click();
  assert.equal(s.q<HTMLButtonElement>('.done').disabled, true, 'selection was refused');
  s.q('.done').click(); s.q('.cancel').click(); s.q('.scrim').click(); s.key(s.q('.sheet'), 'Escape');
  assert.equal(await pending(s.promise), 'pending');
  s.host.remove(); // ...but the page can always remove its own DOM: that resolves as a cancel
  assert.equal(await s.promise, null);
});

test('removing the sheet from the DOM resolves as a cancel instead of hanging', async () => {
  const s = show([devA]);
  s.host.remove();
  assert.equal(await s.promise, null);
});

test('swipe down on the bar dismisses on phones, a short drag snaps back, wide screens ignore it', async () => {
  const s = show([devA]);
  const top = s.q('.top');
  const sheet = s.q('.sheet');
  const drag = (from: number, to: number, end = 'pointerup') => {
    for (const [type, y] of [['pointerdown', from], ['pointermove', to], [end, to]] as const) {
      top.dispatchEvent(new s.win.MouseEvent(type, { clientY: y, bubbles: true }));
    }
  };
  drag(100, 400); // innerWidth is 1024 in jsdom: wide layout, no swipe
  assert.equal(await pending(s.promise), 'pending');

  Object.defineProperty(s.win, 'innerWidth', { value: 390, configurable: true });
  drag(100, 130);
  assert.equal(await pending(s.promise), 'pending');
  assert.equal(sheet.style.transform, '', 'snapped back');
  drag(100, 400, 'pointercancel');
  assert.equal(await pending(s.promise), 'pending', 'a cancelled gesture never dismisses');
  drag(100, 320);
  assert.equal(await s.promise, null);
});

test('language follows the locale', () => {
  const ja = show([devA]);
  assert.equal(ja.q('.bar h2').textContent, 'USBデバイスを選択');
  assert.equal(ja.q('.cancel').textContent, 'キャンセル');
  assert.equal(ja.q('.done').textContent, '接続');
  ja.host.remove();
  const en = show([devA], { locale: 'en-US' });
  assert.equal(en.q('.bar h2').textContent, 'Select a USB Device');
  assert.equal(en.q('.cancel').textContent, 'Cancel');
  assert.equal(en.q('.done').textContent, 'Connect');
  assert.match(en.q('.lead').textContent!, /^app\.example wants/);
  en.host.remove();
});

test('with animation on, the promise settles at once and the sheet leaves a moment later', async () => {
  const s = show([devA], { animate: true });
  s.q('.cancel').click();
  assert.equal(await s.promise, null);
  assert.ok(s.host.isConnected);
  assert.ok(s.q('.scrim').classList.contains('closing'));
  await sleep(350);
  assert.equal(s.host.isConnected, false);
});

test('the dialog is accessible: dialog role, labelled, radio group with a legend', () => {
  const s = show([devA, devB]);
  const sheet = s.q('.sheet');
  assert.equal(sheet.getAttribute('role'), 'dialog');
  assert.equal(sheet.getAttribute('aria-modal'), 'true');
  assert.equal(s.root.getElementById('ttl')!.textContent, 'USBデバイスを選択');
  assert.equal(sheet.getAttribute('aria-labelledby'), 'ttl');
  assert.equal(s.q('.group legend').textContent, '利用できるUSBデバイス');
  assert.equal(s.all('.row input[type="radio"]').length, 2);
  assert.equal(s.q('.foot').getAttribute('aria-live'), 'polite');
  s.host.remove();
});

test('sanitizeLabel', () => {
  assert.equal(sanitizeLabel('  a \t\n b  '), 'a b'.replace(' ', ' '));
  assert.equal(sanitizeLabel('x\u0000y\u202ez\u200b'), 'xyz');
  assert.equal(sanitizeLabel('abcdef', 4), 'abc…');
  assert.equal(sanitizeLabel(undefined), '');
  assert.equal(sanitizeLabel(42 as any), '');
});
