// Pack dist/crx into dist/ios-webusb-<version_name>.crx (CRX3) and .zip.
//   npm run pack:crx
// The CRX is signed with a throw-away key kept in keys/ (git-ignored, generated on first run).
// Keep that key if you want the extension ID to stay the same across builds.
//
// Chrome / Chromium (since 75) refuses to install a CRX that lacks the Chrome Web Store's
// signature (CRX_REQUIRED_PROOF_MISSING), so this file is for browsers and tools that accept
// self-signed CRX3. For Chrome itself use "Load unpacked" on dist/crx, or the .zip.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import crx3 from 'crx3';

const root = fileURLToPath(new URL('..', import.meta.url));
const p = (...s) => join(root, ...s);

if (!existsSync(p('dist/crx/manifest.json'))) throw new Error('dist/crx is missing: run `npm run build` first');
const manifest = JSON.parse(await readFile(p('dist/crx/manifest.json'), 'utf8'));
const base = `ios-webusb-${manifest.version_name ?? manifest.version}`;

const keyPath = p('keys/ios-webusb.pem');
if (!existsSync(keyPath)) {
  await mkdir(p('keys'), { recursive: true });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await writeFile(keyPath, privateKey, { mode: 0o600 });
  console.log('generated a new signing key: keys/ios-webusb.pem');
}

const crxPath = p(`dist/${base}.crx`);
const zipPath = p(`dist/${base}.zip`);
await crx3([p('dist/crx/manifest.json')], { keyPath, crxPath, zipPath });

// Sanity: CRX3 header = "Cr24", version 3 (little endian), header length.
const head = (await readFile(crxPath)).subarray(0, 12);
if (head.toString('latin1', 0, 4) !== 'Cr24' || head.readUInt32LE(4) !== 3) throw new Error('not a CRX3 file');
for (const f of [crxPath, zipPath]) console.log(`${f.slice(root.length)}  ${(await stat(f)).size} bytes`);
