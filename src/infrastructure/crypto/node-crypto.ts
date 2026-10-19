import crypto from 'node:crypto';
import type { BlockCipher, EncryptedBlock, Hasher, KeyDerivation, RunningHash } from '../../application/ports.js';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM; the 16-byte auth tag is appended to each ciphertext block. */
export class AesGcmCipher implements BlockCipher {
  readonly algorithm = 'AES-256-GCM' as const;

  encrypt(plain: Uint8Array, key: Uint8Array): EncryptedBlock {
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const data = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    return { data, nonce: nonce.toString('base64') };
  }

  decrypt(data: Uint8Array, nonce: string, key: Uint8Array): Uint8Array {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'));
    decipher.setAuthTag(bytes.subarray(-TAG_BYTES));
    return Buffer.concat([decipher.update(bytes.subarray(0, -TAG_BYTES)), decipher.final()]);
  }
}

export class ScryptKeyDerivation implements KeyDerivation {
  private static readonly params = { N: 2 ** 15, r: 8, p: 1 } as const;
  readonly id = `scrypt:N=${ScryptKeyDerivation.params.N},r=${ScryptKeyDerivation.params.r},p=${ScryptKeyDerivation.params.p}`;

  randomSalt(): Uint8Array {
    return crypto.randomBytes(16);
  }

  derive(secret: string, salt: Uint8Array): Promise<Uint8Array> {
    // maxmem must exceed 128 * N * r bytes (32 MiB here); the default limit is exactly 32 MiB.
    const options = { ...ScryptKeyDerivation.params, maxmem: 64 * 1024 * 1024 };
    return new Promise((resolve, reject) =>
      crypto.scrypt(secret, salt, 32, options, (error, key) => (error ? reject(error) : resolve(key)))
    );
  }
}

export class NodeHasher implements Hasher {
  sha256(data: Uint8Array): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  start(): RunningHash {
    const hash = crypto.createHash('sha256');
    return { update: data => { hash.update(data); }, digest: () => hash.digest('hex') };
  }
}
