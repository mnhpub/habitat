import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../src/shared/hash';

test('sha256Hex matches the standard digest for known inputs', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex('a'.repeat(1000)), createHash('sha256').update('a'.repeat(1000)).digest('hex'));
  assert.equal(sha256Hex('héllo wörld ✓'), createHash('sha256').update('héllo wörld ✓').digest('hex'));
});
