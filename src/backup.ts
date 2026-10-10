import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { toolPath, paths } from './config.js';
import { run } from './process.js';
import { createJob, getJob, saveJob } from './jobs.js';
import { deriveKey, encryptBlock } from './security.js';
import type { BackupManifest } from './types.js';

const BLOCK = 4 * 1024 * 1024;
export async function createBackup(deviceId: string, source: string, destination: string, secret: string) {
  const job = await createJob('backup'); job.status = 'running'; await saveJob(job);
  const temp = path.join(paths.jobs, `${job.id}.source`); const output = path.join(destination, `${job.id}.androidbackup`);
  try {
    await fs.mkdir(destination, { recursive: true });
    const pull = await run(toolPath('adb'), ['-s', deviceId, 'pull', source, temp], 0x7fffffff);
    if (pull.code !== 0) throw new Error(pull.stderr || 'ADB pull failed');
    const stat = await fs.stat(temp); const salt = crypto.randomBytes(16); const key = await deriveKey(secret, salt); const blocks = [] as BackupManifest['blocks'];
    const input = await fs.open(temp, 'r'); const out = await fs.open(output, 'w'); let offset = 0, index = 0; const hash = crypto.createHash('sha256');
    await out.write(Buffer.from('ANDROIDCTL1\n')); await out.write(salt);
    while (offset < stat.size) { const size = Math.min(BLOCK, stat.size - offset); const plain = Buffer.alloc(size); await input.read(plain, 0, size, offset); const encrypted = encryptBlock(plain, key); await out.write(encrypted.data); const digest = crypto.createHash('sha256').update(plain).digest('hex'); hash.update(plain); blocks.push({ index, offset, plainSize: size, cipherSize: encrypted.data.length, hash: digest, nonce: encrypted.nonce.toString('base64') }); offset += size; index++; }
    await input.close(); await out.close(); const manifest: BackupManifest = { version: 1, jobId: job.id, deviceId, source, createdAt: job.createdAt, blockSize: BLOCK, algorithm: 'AES-256-GCM', blocks, totalBytes: stat.size, digest: hash.digest('hex') }; await fs.writeFile(`${output}.manifest.json`, JSON.stringify(manifest, null, 2)); await fs.rm(temp, { force: true }); job.status = 'completed'; job.manifest = manifest; await saveJob(job); return { jobId: job.id, output, manifest };
  } catch (error) { job.status = 'failed'; job.error = error instanceof Error ? error.message : String(error); await saveJob(job); throw error; }
}
export async function backupStatus(id: string) { return getJob(id); }
