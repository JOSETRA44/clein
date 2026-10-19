import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { BackupBlock, BackupManifest } from '../../domain/backup.js';
import { IntegrityError, NotFoundError, ValidationError } from '../../domain/errors.js';
import type { BackupLocation, BackupReader, BackupStore, BackupWriter, PlainOutput } from '../../application/ports.js';

/**
 * On-disk layout:
 *   <jobId>.androidbackup                = MAGIC (12 bytes) | salt (16 bytes) | ciphertext blocks…
 *   <jobId>.androidbackup.manifest.json  = BackupManifest
 * Files are written under a `.partial` suffix and renamed on commit, so a
 * visible manifest always describes a complete archive.
 */
const MAGIC = Buffer.from('ANDROIDCTL2\n');
const ACCEPTED_MAGIC = [MAGIC, Buffer.from('ANDROIDCTL1\n')];
const SALT_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES;
const ARCHIVE_EXT = '.androidbackup';
const MANIFEST_SUFFIX = '.manifest.json';

const manifestSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  jobId: z.string(),
  deviceId: z.string(),
  source: z.string(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  blockSize: z.number().int().positive(),
  algorithm: z.literal('AES-256-GCM'),
  kdf: z.string().optional(),
  contentFormat: z.literal('tar').optional(),
  blocks: z.array(z.object({
    index: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    plainSize: z.number().int().nonnegative(),
    cipherSize: z.number().int().positive(),
    hash: z.string(),
    nonce: z.string()
  })),
  totalBytes: z.number().int().nonnegative(),
  digest: z.string(),
  complete: z.boolean().optional(),
  warnings: z.array(z.string()).optional()
});

async function removeQuietly(...files: string[]): Promise<void> {
  await Promise.all(files.map(f => fs.rm(f, { force: true })));
}

export class FileBackupStore implements BackupStore {
  async create(destinationDir: string, jobId: string, salt: Uint8Array): Promise<BackupWriter> {
    if (salt.length !== SALT_BYTES) throw new ValidationError(`Salt must be ${SALT_BYTES} bytes`);
    await fs.mkdir(destinationDir, { recursive: true });
    const archivePath = path.resolve(destinationDir, `${jobId}${ARCHIVE_EXT}`);
    const manifestPath = `${archivePath}${MANIFEST_SUFFIX}`;
    const partialArchive = `${archivePath}.partial`;
    const partialManifest = `${manifestPath}.partial`;
    const handle = await fs.open(partialArchive, 'wx');
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await handle.close(); } };

    try {
      await handle.write(Buffer.concat([MAGIC, salt]));
    } catch (error) {
      await close();
      await removeQuietly(partialArchive);
      throw error;
    }

    return {
      append: async data => { await handle.write(data); },
      commit: async (manifest: BackupManifest): Promise<BackupLocation> => {
        await handle.sync();
        await close();
        await fs.writeFile(partialManifest, JSON.stringify(manifest, null, 2), 'utf8');
        await fs.rename(partialArchive, archivePath);
        await fs.rename(partialManifest, manifestPath);
        return { archivePath, manifestPath };
      },
      abort: async () => {
        await close().catch(() => undefined);
        await removeQuietly(partialArchive, partialManifest);
      }
    };
  }

  async open(manifestPath: string): Promise<BackupReader> {
    if (!manifestPath.endsWith(MANIFEST_SUFFIX)) throw new ValidationError(`Manifest files end with ${MANIFEST_SUFFIX}: ${manifestPath}`);
    const manifest = await readManifest(manifestPath);
    const archivePath = manifestPath.slice(0, -MANIFEST_SUFFIX.length);
    const handle = await fs.open(archivePath, 'r').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError(`Backup archive not found: ${archivePath}`);
      throw error;
    });

    try {
      const header = Buffer.alloc(HEADER_BYTES);
      const { bytesRead } = await handle.read(header, 0, HEADER_BYTES, 0);
      const magic = header.subarray(0, MAGIC.length);
      if (bytesRead < HEADER_BYTES || !ACCEPTED_MAGIC.some(m => m.equals(magic))) {
        throw new IntegrityError(`Not an androidctl backup: ${archivePath}`);
      }
      const offsets = cipherOffsets(manifest.blocks);
      return {
        manifest,
        salt: header.subarray(MAGIC.length),
        readBlock: async (block: BackupBlock) => {
          const buffer = Buffer.alloc(block.cipherSize);
          const { bytesRead: read } = await handle.read(buffer, 0, block.cipherSize, offsets.get(block.index)!);
          if (read !== block.cipherSize) throw new IntegrityError(`Block ${block.index} is truncated`);
          return buffer;
        },
        close: () => handle.close()
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async createPlainOutput(outputPath: string): Promise<PlainOutput> {
    const target = path.resolve(outputPath);
    const partial = `${target}.partial`;
    if (await fs.stat(target).then(() => true, () => false)) throw new ValidationError(`Refusing to overwrite existing file: ${target}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const handle = await fs.open(partial, 'wx');
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await handle.close(); } };
    return {
      write: async data => { await handle.write(data); },
      commit: async () => { await handle.sync(); await close(); await fs.rename(partial, target); return target; },
      abort: async () => { await close().catch(() => undefined); await removeQuietly(partial); }
    };
  }
}

async function readManifest(manifestPath: string): Promise<BackupManifest> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError(`Manifest not found: ${manifestPath}`);
    throw error;
  }
  const parsed = manifestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new IntegrityError(`Invalid manifest ${manifestPath}: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

/** Ciphertext blocks are stored back to back after the header, in index order. */
function cipherOffsets(blocks: BackupBlock[]): Map<number, number> {
  const offsets = new Map<number, number>();
  let position = HEADER_BYTES;
  for (const block of [...blocks].sort((a, b) => a.index - b.index)) {
    offsets.set(block.index, position);
    position += block.cipherSize;
  }
  return offsets;
}
