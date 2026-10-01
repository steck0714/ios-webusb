// Single source of truth for the version strings used at runtime.
// tests/version.test.ts keeps these in sync with package.json and crx/manifest.json.
//
// Naming follows fox-webusb: the git tag / human-facing name is "0.0.0a1" while the
// manifest.json `version` may only contain dot-separated integers ("0.0.0.1").
export const VERSION = '0.0.0a1';
export const MANIFEST_VERSION = '0.0.0.1';
