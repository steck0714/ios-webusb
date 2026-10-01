import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64ToUint8Array, bufferSourceToBase64, bufferSourceToUint8Array } from '../src/core/base64.ts';

test('round-trips every byte value', () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(base64ToUint8Array(bufferSourceToBase64(all)), all);
});

test('round-trips a payload far larger than the chunk size', () => {
  const big = new Uint8Array(300 * 1024).map((_, i) => (i * 31) & 0xff);
  const back = base64ToUint8Array(bufferSourceToBase64(big));
  assert.equal(back.length, big.length);
  assert.equal(Buffer.compare(Buffer.from(back), Buffer.from(big)), 0);
});

test('respects byteOffset / byteLength of views', () => {
  const buf = new Uint8Array([0, 1, 2, 3, 4, 5]).buffer;
  assert.equal(bufferSourceToBase64(new Uint8Array(buf, 2, 3)), Buffer.from([2, 3, 4]).toString('base64'));
  assert.equal(bufferSourceToBase64(new DataView(buf, 1, 2)), Buffer.from([1, 2]).toString('base64'));
  assert.equal(bufferSourceToBase64(buf), Buffer.from([0, 1, 2, 3, 4, 5]).toString('base64'));
});

test('empty input', () => {
  assert.equal(bufferSourceToBase64(new Uint8Array(0)), '');
  assert.equal(base64ToUint8Array('').length, 0);
});

test('rejects anything that is not a BufferSource', () => {
  for (const bad of ['text', 12, null, undefined, {}, [1, 2, 3]]) {
    assert.throws(() => bufferSourceToUint8Array(bad), TypeError);
  }
});
