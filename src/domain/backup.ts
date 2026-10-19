import { ValidationError } from './errors.js';

export const MIN_SECRET_LENGTH = 12;
export const DEFAULT_BLOCK_SIZE = 4 * 1024 * 1024;
export const BACKUP_ALGORITHM = 'AES-256-GCM';

export interface BackupBlock {
  index: number;
  /** Offset of this block inside the plaintext stream. */
  offset: number;
  plainSize: number;
  cipherSize: number;
  /** SHA-256 of the plaintext block, hex encoded. */
  hash: string;
  /** GCM nonce, base64 encoded. */
  nonce: string;
}

export interface BackupManifest {
  version: 1 | 2;
  jobId: string;
  deviceId: string;
  source: string;
  createdAt: string;
  completedAt?: string;
  blockSize: number;
  algorithm: typeof BACKUP_ALGORITHM;
  /** Key-derivation scheme identifier; absent in v1 manifests (scrypt N=2^15, r=8, p=1). */
  kdf?: string;
  /** Plaintext format; v1 backups stored whatever `adb pull` produced. */
  contentFormat?: 'tar';
  blocks: BackupBlock[];
  totalBytes: number;
  /** SHA-256 of the full plaintext stream, hex encoded. */
  digest: string;
  /** False when the device reported errors (e.g. unreadable files) while archiving. */
  complete?: boolean;
  warnings?: string[];
}

export function assertValidSecret(secret: string | undefined): asserts secret is string {
  if (!secret) throw new ValidationError('An encryption secret is required');
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new ValidationError(`The encryption secret must have at least ${MIN_SECRET_LENGTH} characters`);
  }
}

/** Device paths are passed to a remote shell, so only absolute, single-line paths are accepted. */
export function assertDevicePath(devicePath: string | undefined): asserts devicePath is string {
  if (!devicePath) throw new ValidationError('A device source path is required');
  if (!devicePath.startsWith('/')) throw new ValidationError(`Device path must be absolute: ${devicePath}`);
  if (/[\0\r\n]/.test(devicePath)) throw new ValidationError('Device path contains control characters');
  if (devicePath.split('/').includes('..')) throw new ValidationError('Device path must not contain ".." segments');
}
