import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_ERROR_PREFIXES, throwFromRpcError } from '../src/core/errors.ts';

test('every known prefix becomes a DOMException of that name', () => {
  assert.equal(KNOWN_ERROR_PREFIXES.length, 7);
  for (const name of KNOWN_ERROR_PREFIXES) {
    assert.throws(
      () => throwFromRpcError(new Error(`${name}: boom: with colon`)),
      (e: any) => e instanceof DOMException && e.name === name && e.message === 'boom: with colon',
    );
  }
});

test('unknown or unprefixed failures become NetworkError', () => {
  for (const msg of ['boom', 'NotFoundError', 'NotFoundError:missing space', 'SomethingError: x']) {
    assert.throws(() => throwFromRpcError(new Error(msg)), (e: any) => e instanceof DOMException && e.name === 'NetworkError' && e.message === msg);
  }
});

test('accepts non-Error values and a custom default name', () => {
  assert.throws(() => throwFromRpcError('plain string'), { name: 'NetworkError', message: 'plain string' });
  assert.throws(() => throwFromRpcError(new Error('x'), 'AbortError'), { name: 'AbortError' });
});
