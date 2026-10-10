import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptBlock, decryptBlock } from '../src/security.js';

test('AES-256-GCM block round trip and tamper detection', () => {
  const key = crypto.randomBytes(32);
  const plain = Buffer.from('androidctl integrity test');
  const encrypted = encryptBlock(plain, key);
  assert.deepEqual(decryptBlock(encrypted.data, encrypted.nonce, key), plain);
  const tampered = Buffer.from(encrypted.data); tampered[0] ^= 1;
  assert.throws(() => decryptBlock(tampered, encrypted.nonce, key));
});
