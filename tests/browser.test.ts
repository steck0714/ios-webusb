// Real-browser checks in headless Chromium (via @sparticuz/chromium + puppeteer-core).
// jsdom cannot show that genuine taps are accepted, how the layout behaves, or that the
// Shortcuts payload works against a real WebSocket, so this file does. Chromium is not
// WebKit: it proves the code, not iOS rendering. Skipped when no browser can be launched.
import { after, before, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { bridgeSkipReason, startMockBridge, type MockBridge } from './helpers.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
let browser: any;
let bundle = '';
let unavailable: string | null = null;
let web: Server | undefined;
let webUrl = '';
let bridge: MockBridge | undefined;

const PAGE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>t</title>'
  + '<body style="margin:0;font:16px sans-serif"><button id="connect" style="margin:20px;padding:12px">connect</button></body>';

before(async () => {
  try {
    const chromium = (await import('@sparticuz/chromium')).default;
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: 'shell' });
  } catch (e) {
    unavailable = `headless Chromium is not available: ${String((e as Error).message).split('\n')[0]}`;
    return;
  }
  bundle = (await build({
    entryPoints: [`${root}src/core/chooser.ts`], bundle: true, format: 'iife', globalName: 'Chooser', write: false, logLevel: 'silent',
  })).outputFiles[0]!.text;
  web = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE); });
  await new Promise<void>((resolve) => web!.listen(0, '127.0.0.1', resolve));
  webUrl = `http://127.0.0.1:${(web.address() as { port: number }).port}/`;
  if (!bridgeSkipReason) bridge = await startMockBridge(['--debug-rpc']);
});
after(async () => { await browser?.close(); web?.close(); bridge?.stop(); });

const DEVICES = [
  { vendorId: 0x2341, productId: 0x8036, manufacturerName: 'Arduino LLC', productName: 'Arduino Leonardo', serialNumber: 'HIDPC' },
  { vendorId: 0x18d1, productId: 0x4ee7, manufacturerName: 'Google Inc.', productName: 'Pixel 7', serialNumber: '2A1B3C4D5E6F' },
  { vendorId: 0x1209, productId: 0x0001, manufacturerName: null, productName: null, serialNumber: null },
];

/** `reduceMotion` (default) also exercises the prefers-reduced-motion path: no slide animation to wait for. */
async function newPage(width: number, height: number, mobile = true, reduceMotion = true) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: reduceMotion ? 'reduce' : 'no-preference' }]);
  await page.evaluateOnNewDocument(() => {
    // Test-only: open every shadow root so selectors can reach into it (the product uses 'closed').
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit) { return attach.call(this, { ...init, mode: 'open' }); };
    // Make this Chromium look like iOS Safari: no WebUSB at all.
    delete (Navigator.prototype as any).usb;
    for (const name of Object.getOwnPropertyNames(window)) if (/^USB/.test(name)) delete (window as any)[name];
  });
  await page.goto(webUrl);
  return page;
}

async function showChooser(page: any, options: object = {}) {
  await page.addScriptTag({ content: bundle });
  await page.evaluate((devices: unknown[], o: object) => {
    const w = window as any;
    w.__done = false;
    w.__result = null;
    new w.Chooser.OverlayChooser({ animate: false, locale: 'ja-JP', origin: 'webusb.example.com', ...o })
      .choose(devices, { filters: [], exclusionFilters: [] })
      .then((d: any) => { w.__result = d ? d.productName : null; w.__done = true; });
  }, DEVICES, options);
  await page.waitForSelector('pierce/.sheet');
}
const settled = (page: any) => page.waitForFunction(() => (window as any).__done === true);
const result = (page: any) => page.evaluate(() => (window as any).__result);
const doneDisabled = (page: any): Promise<boolean> => page.$eval('pierce/.done', (b: HTMLButtonElement) => b.disabled);

test('real taps are accepted; a script-made click is not', async (t: TestContext) => {
  if (unavailable) return t.skip(unavailable);
  const page = await newPage(390, 844);
  await showChooser(page, { requireTrustedInput: true });
  await page.evaluate(() => (document.querySelector('[data-ios-webusb-chooser]')!.shadowRoot!.querySelector('.row input[value="0"]') as HTMLElement).click());
  assert.equal(await doneDisabled(page), true, 'a page script cannot select a row');
  await page.click('pierce/.row input[value="1"]');
  assert.equal(await doneDisabled(page), false);
  await page.click('pierce/.done');
  await settled(page);
  assert.equal(await result(page), 'Pixel 7');
  assert.equal(await page.$('[data-ios-webusb-chooser]'), null);
  await page.close();
});

test('real Escape and Cancel dismiss; the page gets null', async (t: TestContext) => {
  if (unavailable) return t.skip(unavailable);
  const esc = await newPage(390, 844);
  await showChooser(esc, { requireTrustedInput: true });
  await esc.keyboard.press('Escape');
  await settled(esc);
  assert.equal(await result(esc), null);
  await esc.close();

  const cancel = await newPage(390, 844);
  await showChooser(cancel, { requireTrustedInput: true });
  await cancel.click('pierce/.cancel');
  await settled(cancel);
  assert.equal(await result(cancel), null);
  await cancel.close();
});

test('with motion allowed the sheet slides in and settles at the bottom edge, then still dismisses', async (t: TestContext) => {
  if (unavailable) return t.skip(unavailable);
  const page = await newPage(390, 844, true, false);
  await showChooser(page, { animate: true });
  await page.waitForFunction(() => {
    const r = document.querySelector('[data-ios-webusb-chooser]')!.shadowRoot!.querySelector('.sheet')!.getBoundingClientRect();
    return Math.abs(r.bottom - innerHeight) < 0.5;
  }, { timeout: 3000 });
  await page.click('pierce/.cancel');
  await settled(page);
  assert.equal(await result(page), null);
  await page.waitForFunction(() => document.querySelector('[data-ios-webusb-chooser]') === null, { timeout: 3000 });
  await page.close();
});

test('the sheet fits every iPhone / iPad size, with no overlapping bar items or sideways scroll', async (t: TestContext) => {
  if (unavailable) return t.skip(unavailable);
  for (const [w, h, mobile] of [[320, 568, true], [375, 667, true], [390, 844, true], [430, 932, true], [844, 390, true], [820, 1180, true], [1280, 800, false]] as const) {
    const page = await newPage(w, h, mobile);
    await showChooser(page);
    const m = await page.evaluate(() => {
      const r = document.querySelector('[data-ios-webusb-chooser]')!.shadowRoot!;
      const box = (s: string) => { const b = r.querySelector(s)!.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
      const body = r.querySelector('.body') as HTMLElement;
      return { sheet: box('.sheet'), cancel: box('.cancel'), title: box('.bar h2'), done: box('.done'), sideways: body.scrollWidth > body.clientWidth, vw: innerWidth, vh: innerHeight };
    });
    const label = `${w}x${h}`;
    assert.ok(m.sheet.l >= -0.5 && m.sheet.r <= m.vw + 0.5 && m.sheet.t >= -0.5 && m.sheet.b <= m.vh + 0.5, `${label}: sheet inside the viewport ${JSON.stringify(m.sheet)}`);
    assert.ok(m.cancel.r <= m.title.l + 0.5 && m.title.r <= m.done.l + 0.5, `${label}: bar items overlap ${JSON.stringify([m.cancel, m.title, m.done])}`);
    assert.equal(m.sideways, false, `${label}: horizontal overflow`);
    await page.close();
  }
});

test('Shortcuts build in a real browser: inject, tap, then transfer through the mock bridge', { skip: bridgeSkipReason }, async (t: TestContext) => {
  if (unavailable) return t.skip(unavailable);
  const page = await newPage(390, 844);
  const wrapper = readFileSync(`${root}dist/shortcuts/ios-webusb.js`, 'utf8').replace('wss://192.168.0.10:8765/', bridge!.url);
  await page.evaluate(() => { const w = window as any; w.__completions = []; w.completion = (r: unknown) => { w.__completions.push(r); }; });
  await page.evaluate(wrapper);
  assert.deepEqual(await page.evaluate(() => (window as any).__completions), [{ ok: true, reason: 'installed' }]);

  await page.evaluate(() => {
    document.getElementById('connect')!.addEventListener('click', () => {
      const w = window as any;
      w.__pending = navigator.usb.requestDevice({ filters: [{ vendorId: 0x1209 }] }).then((d) => { w.__dev = d; return d.productName; });
    });
  });
  await page.click('#connect');
  await page.waitForSelector('pierce/.sheet');
  await page.click('pierce/.row input[value="0"]');
  await page.click('pierce/.done');
  assert.equal(await page.evaluate(() => (window as any).__pending), 'Virtual Loopback');

  const out = await page.evaluate(async () => {
    const d = (window as any).__dev as USBDevice;
    await d.open();
    await d.selectConfiguration(1);
    await d.claimInterface(0);
    const written = (await d.transferOut(1, new Uint8Array([1, 2, 3, 4]))).bytesWritten;
    const back = (await d.transferIn(1, 64)).data!;
    return {
      written, back: [...new Uint8Array(back.buffer, back.byteOffset, back.byteLength)], opened: d.opened,
      tag: Object.prototype.toString.call(navigator.usb), isEventTarget: navigator.usb instanceof EventTarget,
      info: (window as any).__iosWebUSB.variant,
    };
  });
  assert.deepEqual(out, { written: 4, back: [1, 2, 3, 4], opened: true, tag: '[object USB]', isEventTarget: true, info: 'shortcut' });
  await page.close();
});
