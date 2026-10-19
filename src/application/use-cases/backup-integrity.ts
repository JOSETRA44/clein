import { assertValidSecret, type BackupManifest } from '../../domain/backup.js';
import { IntegrityError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { isValidJobId, type Job } from '../../domain/job.js';
import type { BackupStore, BlockCipher, Hasher, JobRepository, KeyDerivation } from '../ports.js';

/** KDF used by v1 manifests, which did not record it. */
const LEGACY_KDF_ID = 'scrypt:N=32768,r=8,p=1';

export class GetBackupStatus {
  constructor(private readonly jobs: JobRepository) {}

  async execute(jobId: string | undefined): Promise<Job> {
    if (!jobId || !isValidJobId(jobId)) throw new ValidationError(`Invalid job id: ${jobId ?? '(missing)'}`);
    const job = await this.jobs.find(jobId);
    if (!job) throw new NotFoundError(`Job not found: ${jobId}`);
    return job;
  }
}

export interface IntegrityDeps {
  store: BackupStore;
  cipher: BlockCipher;
  kdf: KeyDerivation;
  hasher: Hasher;
}

export interface VerificationReport {
  manifestPath: string;
  valid: boolean;
  blocksChecked: number;
  totalBytes: number;
  /** Mirrors the manifest: false when the device skipped entries while archiving. */
  complete: boolean;
  failures: string[];
}

interface WalkResult {
  manifest: BackupManifest;
  blocksChecked: number;
  bytes: number;
  failures: string[];
}

/**
 * Decrypts every block in order, checking GCM authentication, per-block hashes
 * and the whole-stream digest. Verified plaintext is handed to `sink`.
 */
async function walkBackup(
  deps: IntegrityDeps,
  manifestPath: string,
  secret: string,
  sink?: (plain: Uint8Array) => Promise<void>
): Promise<WalkResult> {
  assertValidSecret(secret);
  const reader = await deps.store.open(manifestPath);
  try {
    const { manifest } = reader;
    const kdfId = manifest.kdf ?? LEGACY_KDF_ID;
    if (kdfId !== deps.kdf.id) throw new ValidationError(`Unsupported key derivation: ${kdfId}`);
    const key = await deps.kdf.derive(secret, reader.salt);
    const total = deps.hasher.start();
    const failures: string[] = [];
    let bytes = 0;
    let blocksChecked = 0;

    for (const block of manifest.blocks) {
      blocksChecked++;
      let plain: Uint8Array;
      try {
        plain = deps.cipher.decrypt(await reader.readBlock(block), block.nonce, key);
      } catch {
        if (block.index === 0) {
          failures.push('Block 0 failed authentication: the secret is wrong or the backup is corrupted');
          break;
        }
        failures.push(`Block ${block.index} failed authentication`);
        continue;
      }
      if (deps.hasher.sha256(plain) !== block.hash) {
        failures.push(`Block ${block.index} hash mismatch`);
        continue;
      }
      total.update(plain);
      bytes += plain.length;
      if (sink && failures.length === 0) await sink(plain);
    }

    if (failures.length === 0) {
      if (bytes !== manifest.totalBytes) failures.push(`Size mismatch: expected ${manifest.totalBytes} bytes, got ${bytes}`);
      else if (total.digest() !== manifest.digest) failures.push('Whole-backup digest mismatch');
    }
    return { manifest, blocksChecked, bytes, failures };
  } finally {
    await reader.close();
  }
}

export class VerifyBackup {
  constructor(private readonly deps: IntegrityDeps) {}

  async execute(input: { manifestPath: string; secret: string }): Promise<VerificationReport> {
    if (!input.manifestPath) throw new ValidationError('A manifest path is required');
    const result = await walkBackup(this.deps, input.manifestPath, input.secret);
    return {
      manifestPath: input.manifestPath,
      valid: result.failures.length === 0,
      blocksChecked: result.blocksChecked,
      totalBytes: result.bytes,
      complete: result.manifest.complete ?? true,
      failures: result.failures
    };
  }
}

export interface ExportBackupResult {
  outputPath: string;
  totalBytes: number;
  contentFormat: string;
}

/** Decrypts a verified backup into a local plaintext file (a tar archive for v2 backups). */
export class ExportBackup {
  constructor(private readonly deps: IntegrityDeps) {}

  async execute(input: { manifestPath: string; secret: string; outputPath: string }): Promise<ExportBackupResult> {
    if (!input.manifestPath) throw new ValidationError('A manifest path is required');
    if (!input.outputPath) throw new ValidationError('An output path is required');
    const output = await this.deps.store.createPlainOutput(input.outputPath);
    try {
      const result = await walkBackup(this.deps, input.manifestPath, input.secret, data => output.write(data));
      if (result.failures.length > 0) throw new IntegrityError(`Backup failed verification: ${result.failures.join('; ')}`);
      const outputPath = await output.commit();
      return { outputPath, totalBytes: result.bytes, contentFormat: result.manifest.contentFormat ?? 'raw' };
    } catch (error) {
      await output.abort();
      throw error;
    }
  }
}
