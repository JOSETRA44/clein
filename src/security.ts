import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { paths } from './config.js';

export async function deriveKey(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(secret, salt, 32, { N: 2 ** 15, r: 8, p: 1 }, (e, k) => e ? reject(e) : resolve(k)));
}

export function encryptBlock(plain: Buffer, key: Buffer) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { data: Buffer.concat([data, cipher.getAuthTag()]), nonce };
}

export function decryptBlock(data: Buffer, nonce: Buffer, key: Buffer) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
}

export async function ensureDataDirs() { await fs.mkdir(paths.jobs, { recursive: true }); await fs.mkdir(paths.keys, { recursive: true }); }
