// Build everything into dist/:
//   dist/crx/           unpacked Chrome extension (MV3)
//   dist/shortcuts/     ios-webusb.js (paste into "Run JavaScript on Web Page") + unsigned .shortcut
//   dist/types/         webusb-polyfill.d.ts, sample-usage.ts, negative-check.ts
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const p = (...s) => join(root, ...s);
const dist = p('dist');

const VERSION = (await readFile(p('src/core/version.ts'), 'utf8')).match(/VERSION = '([^']+)'/)[1];

await rm(dist, { recursive: true, force: true });
await mkdir(p('dist/crx'), { recursive: true });
await mkdir(p('dist/shortcuts'), { recursive: true });

const common = {
  bundle: true,
  format: 'iife',
  // iOS Safari 15+ (WebKit engines: Safari, Orion), current Chromium and Firefox.
  target: ['safari15', 'chrome116', 'firefox115'],
  legalComments: 'none',
  logLevel: 'warning',
};

// ---- crx
await build({
  ...common,
  entryPoints: {
    page: p('src/crx/page.ts'),
    content: p('src/crx/content.ts'),
    background: p('src/crx/background.ts'),
    options: p('src/crx/options.ts'),
  },
  outdir: p('dist/crx'),
});
await cp(p('crx/manifest.json'), p('dist/crx/manifest.json'));
await cp(p('crx/options.html'), p('dist/crx/options.html'));
await cp(p('crx/_locales'), p('dist/crx/_locales'), { recursive: true });

// ---- shortcuts
const bundle = await build({
  ...common,
  entryPoints: [p('src/shortcut/entry.ts')],
  globalName: '__iosWebUsb',
  minify: true,
  write: false,
});
const payload = bundle.outputFiles[0].text;
const literal = JSON.stringify(payload).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const template = await readFile(p('shortcuts/wrapper.template.js'), 'utf8');
if (!template.includes('"__IOS_WEBUSB_PAYLOAD__"')) throw new Error('payload placeholder missing in wrapper template');
const wrapper = template
  .replace('__IOS_WEBUSB_VERSION__', VERSION)
  .replace('"__IOS_WEBUSB_PAYLOAD__"', () => literal);
await writeFile(p('dist/shortcuts/ios-webusb.js'), wrapper);

const python = existsSync(p('.venv/bin/python')) ? p('.venv/bin/python') : 'python3';
const made = spawnSync(python, [p('scripts/make_shortcut.py'), p('dist/shortcuts/ios-webusb.js'), p('dist/shortcuts/ios-webusb.unsigned.shortcut')], { stdio: 'inherit' });
if (made.status !== 0) throw new Error('make_shortcut.py failed');

// ---- types
await mkdir(p('dist/types'), { recursive: true });
for (const f of ['webusb-polyfill.d.ts', 'sample-usage.ts', 'negative-check.ts']) await cp(p('types', f), p('dist/types', f));

for (const f of ['crx/page.js', 'crx/content.js', 'crx/background.js', 'crx/options.js', 'shortcuts/ios-webusb.js', 'shortcuts/ios-webusb.unsigned.shortcut']) {
  console.log(`${f.padEnd(44)} ${String((await stat(p('dist', f))).size).padStart(7)} bytes`);
}
console.log(`built ios-webusb ${VERSION}`);
