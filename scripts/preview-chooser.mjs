// Dev tool: render the chooser sheet in headless Chromium and write PNGs to docs/screenshots/.
//   npm run preview            (needs the devDependencies puppeteer-core + @sparticuz/chromium)
// Chromium is not WebKit and has no San Francisco font: colours, spacing and behaviour are
// representative, glyph shapes are not. Real iOS rendering is checked on a device.
import { build } from 'esbuild';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, 'docs/screenshots');
await mkdir(outDir, { recursive: true });

const bundle = (await build({
  entryPoints: [join(root, 'src/core/chooser.ts')], bundle: true, format: 'iife', globalName: 'Chooser', write: false, logLevel: 'warning',
})).outputFiles[0].text;

const devices = [
  { vendorId: 0x2341, productId: 0x8036, manufacturerName: 'Arduino LLC', productName: 'Arduino Leonardo', serialNumber: 'HIDPC' },
  { vendorId: 0x18d1, productId: 0x4ee7, manufacturerName: 'Google Inc.', productName: 'Pixel 7', serialNumber: '2A1B3C4D5E6F' },
  { vendorId: 0x1209, productId: 0x0001, manufacturerName: null, productName: null, serialNumber: null },
];

const page_html = (dark) => `<!doctype html><html lang="ja"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>body{margin:0;padding:64px 22px;font:16px/1.65 -apple-system,system-ui,sans-serif;background:${dark ? '#000' : '#fff'};color:${dark ? '#eee' : '#111'}}
h1{font-size:28px;margin:0 0 12px}button{font:inherit;padding:12px 20px;border:0;border-radius:10px;background:#0a7d5a;color:#fff}</style>
<h1>WebUSB デモ</h1><p>USBデバイスに接続して、ファームウェアの書き込みや設定を行います。</p><button>デバイスに接続</button>
<p>接続するとこのページからデバイスを操作できるようになります。</p><p>ここは背景のページです。</p>`;

const scenarios = [
  { name: 'phone-light',          w: 390, h: 844,  dpr: 2, dark: false, devices, pick: -1, locale: 'ja-JP' },
  { name: 'phone-light-selected', w: 390, h: 844,  dpr: 2, dark: false, devices, pick: 1,  locale: 'ja-JP' },
  { name: 'phone-dark-selected',  w: 390, h: 844,  dpr: 2, dark: true,  devices, pick: 1,  locale: 'ja-JP' },
  { name: 'phone-light-empty',    w: 390, h: 844,  dpr: 2, dark: false, devices: [], pick: -1, locale: 'ja-JP' },
  { name: 'ipad-light-selected',  w: 820, h: 1180, dpr: 1, dark: false, devices, pick: 0,  locale: 'ja-JP' },
  { name: 'phone-se-light',        w: 320, h: 568,  dpr: 2, dark: false, devices, pick: 1,  locale: 'ja-JP' },
  { name: 'phone-light-en',       w: 390, h: 844,  dpr: 2, dark: false, devices, pick: 1,  locale: 'en-US' },
];
const only = process.argv[2];

const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: 'shell' });
for (const s of scenarios) {
  if (only && s.name !== only) continue;
  const page = await browser.newPage();
  await page.setViewport({ width: s.w, height: s.h, deviceScaleFactor: s.dpr, isMobile: s.w < 600, hasTouch: s.w < 600 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: s.dark ? 'dark' : 'light' }]);
  await page.setContent(page_html(s.dark));
  await page.addScriptTag({ content: bundle });
  await page.evaluate((devs, locale) => {
    const c = new Chooser.OverlayChooser({ shadowMode: 'open', animate: false, locale, origin: 'webusb.example.com' });
    window.__p = c.choose(devs, { filters: [], exclusionFilters: [], refresh: async () => devs });
  }, s.devices, s.locale);
  if (s.pick >= 0) await page.evaluate((i) => {
    document.querySelector('[data-ios-webusb-chooser]').shadowRoot.querySelectorAll('.row input')[i].click();
  }, s.pick);
  await new Promise((r) => setTimeout(r, 150));
  await page.screenshot({ path: join(outDir, `${s.name}.png`) });
  console.log('wrote', `${s.name}.png`);
  await page.close();
}
await browser.close();
