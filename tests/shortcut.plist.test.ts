import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = existsSync(`${root}.venv/bin/python`) ? `${root}.venv/bin/python` : 'python3';

test('the .shortcut is a well-formed workflow plist holding exactly the dist JavaScript', () => {
  const script = `
import json, plistlib, sys
with open(sys.argv[1], 'rb') as f:
    raw = f.read()
print(json.dumps({'xml': raw.lstrip().startswith(b'<?xml'), 'plist': plistlib.loads(raw)}))
`;
  const r = spawnSync(python, ['-c', script, `${root}dist/shortcuts/ios-webusb.unsigned.shortcut`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const { xml, plist } = JSON.parse(r.stdout);
  assert.equal(xml, true, 'XML plist (what `shortcuts sign` accepts)');

  assert.equal(plist.WFWorkflowActions.length, 1);
  const action = plist.WFWorkflowActions[0];
  assert.equal(action.WFWorkflowActionIdentifier, 'is.workflow.actions.runjavascriptonwebpage');
  assert.equal(action.WFWorkflowActionParameters.WFJavaScript, readFileSync(`${root}dist/shortcuts/ios-webusb.js`, 'utf8'));
  assert.deepEqual(plist.WFWorkflowTypes, ['ActionExtension']);
  assert.deepEqual(plist.WFWorkflowInputContentItemClasses, ['WFSafariWebPageContentItem']);
  assert.equal(plist.WFWorkflowMinimumClientVersion, 900);
  assert.deepEqual(plist.WFWorkflowImportQuestions, []);
});
