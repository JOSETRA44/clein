import { assertDevicePath, assertValidSecret, BACKUP_ALGORITHM, DEFAULT_BLOCK_SIZE, type BackupBlock, type BackupManifest } from '../../domain/backup.js';
import { NotFoundError } from '../../domain/errors.js';
import { completeJob, failJob, newJob, startJob, type Job } from '../../domain/job.js';
import { requireCapability } from '../device-lookup.js';
import { fixedSizeBlocks } from '../streams.js';
import type { ArchiveOutcome, BackupLocation, ProgressListener, BackupStore, BlockCipher, Clock, DeviceArchiveSource, DeviceGateway, Hasher, IdGenerator, JobRepository, KeyDerivation } from '../ports.js';

export interface CreateBackupInput {
  deviceId: string;
  source: string;
  destination: string;
  secret: string;
}

export interface CreateBackupResult extends BackupLocation {
  jobId: string;
  manifest: BackupManifest;
}

export interface CreateBackupDeps {
  devices: DeviceGateway;
  archives: DeviceArchiveSource;
  jobs: JobRepository;
  store: BackupStore;
  cipher: BlockCipher;
  kdf: KeyDerivation;
  hasher: Hasher;
  clock: Clock;
  ids: IdGenerator;
  blockSize?: number;
}

export class CreateBackup {
  private readonly blockSize: number;

  constructor(private readonly deps: CreateBackupDeps) {
    this.blockSize = deps.blockSize ?? DEFAULT_BLOCK_SIZE;
  }

  async execute(input: CreateBackupInput, onProgress?: ProgressListener): Promise<CreateBackupResult> {
    assertValidSecret(input.secret);
    assertDevicePath(input.source);
    const { devices, jobs, clock } = this.deps;
    const device = await requireCapability(devices, input.deviceId, 'backup');
    if (!(await devices.pathExists(device.id, input.source))) {
      throw new NotFoundError(`Path not found on device ${device.id}: ${input.source}`);
    }

    let job: Job = newJob(this.deps.ids.next(), 'backup', clock.now());
    job = startJob(job, clock.now());
    await jobs.save(job);

    try {
      const result = await this.encryptToStore(job, { ...input, deviceId: device.id }, onProgress);
      job = completeJob(job, { manifest: result.manifest, manifestPath: result.manifestPath }, clock.now());
      await jobs.save(job);
      return result;
    } catch (error) {
      job = failJob(job, error instanceof Error ? error.message : String(error), clock.now());
      await jobs.save(job);
      throw error;
    }
  }

  private async encryptToStore(job: Job, input: CreateBackupInput, onProgress?: ProgressListener): Promise<CreateBackupResult> {
    const { archives, store, cipher, kdf, hasher, clock } = this.deps;
    const salt = kdf.randomSalt();
    const key = await kdf.derive(input.secret, salt);
    const totalBytes = onProgress ? await archives.estimateSize(input.deviceId, input.source).catch(() => undefined) : undefined;
    // Writer first: if the destination is unusable, no device process gets started.
    const writer = await store.create(input.destination, job.id, salt);

    try {
      const archive = await archives.open(input.deviceId, input.source);
      const blocks: BackupBlock[] = [];
      const total = hasher.start();
      let offset = 0;
      for await (const plain of fixedSizeBlocks(archive.chunks, this.blockSize)) {
        const encrypted = cipher.encrypt(plain, key);
        await writer.append(encrypted.data);
        total.update(plain);
        blocks.push({
          index: blocks.length,
          offset,
          plainSize: plain.length,
          cipherSize: encrypted.data.length,
          hash: hasher.sha256(plain),
          nonce: encrypted.nonce
        });
        offset += plain.length;
        onProgress?.({ doneBytes: offset, totalBytes });
      }

      const outcome = await archive.outcome();
      assertArchiveUsable(outcome, offset);
      const manifest: BackupManifest = {
        version: 2,
        jobId: job.id,
        deviceId: input.deviceId,
        source: input.source,
        createdAt: job.createdAt,
        completedAt: clock.now().toISOString(),
        blockSize: this.blockSize,
        algorithm: BACKUP_ALGORITHM,
        kdf: kdf.id,
        contentFormat: 'tar',
        blocks,
        totalBytes: offset,
        digest: total.digest(),
        complete: outcome.exitCode === 0,
        warnings: outcome.diagnostics
      };
      const location = await writer.commit(manifest);
      return { jobId: job.id, ...location, manifest };
    } catch (error) {
      await writer.abort();
      throw error;
    }
  }
}

/**
 * Decides whether an archive that finished with device-side errors is still
 * worth keeping. Shared storage often contains entries the shell user cannot
 * read (e.g. other apps' scoped folders), so a non-zero exit is not fatal by
 * itself; the backup is kept and flagged as incomplete with its diagnostics.
 */
function assertArchiveUsable(outcome: ArchiveOutcome, bytes: number): void {
  if (outcome.exitCode !== 0 && bytes === 0) {
    throw new Error(`Device archiver failed (exit ${outcome.exitCode}): ${outcome.diagnostics.join('; ') || 'no output'}`);
  }
}
