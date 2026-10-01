import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { MANIFEST_VERSION, VERSION } from '../src/core/version.ts';

const root = new URL('../', import.meta.url);
const json = (p: string): any => JSON.parse(readFileSync(new URL(p, root), 'utf8'));

test('manifest.json and package.json agree with version.ts', () => {
  const manifest = json('crx/manifest.json');
  const pkg = json('package.json');
  assert.equal(manifest.version, MANIFEST_VERSION);
  assert.equal(manifest.version_name, VERSION);
  assert.equal(pkg.version.replace('-a.', 'a'), VERSION); // npm "0.0.0-a.1" <-> tag "0.0.0a1"
});

test('manifest version is 1-4 integers (0..65535), not all zero', () => {
  assert.match(MANIFEST_VERSION, /^\d+(\.\d+){0,3}$/);
  const parts = MANIFEST_VERSION.split('.').map(Number);
  assert.ok(parts.every((n) => n >= 0 && n <= 65535));
  assert.ok(parts.some((n) => n > 0));
});

test('the built extension carries the same manifest', { skip: !existsSync(new URL('dist/crx/manifest.json', root)) }, () => {
  assert.deepEqual(json('dist/crx/manifest.json'), json('crx/manifest.json'));
});
