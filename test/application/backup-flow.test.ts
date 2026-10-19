import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CreateBackup, ExportBackup, GetBackupStatus, VerifyBackup } from '../../src/application/use-cases/index.js';
import { fixedSizeBlocks } from '../../src/application/streams.js';
import { describeAdbDevice } from '../../src/domain/device.js';
import { AesGcmCipher, NodeHasher, ScryptKeyDerivation } from '../../src/infrastructure/crypto/node-crypto.js';
import { FileBackupStore } from '../../src/infrastructure/storage/file-backup-store.js';
import { FakeArchiveSource, FakeDeviceGateway, InMemoryJobRepository, fixedClock, sequentialIds, tempDir } from '../support/fakes.js';

const SECRET = 'correct horse battery staple';

function setup(chunks: Uint8Array[], options: { outcome?: { exitCode: number; diagnostics: string[] }; devices?: FakeDeviceGateway } = {}) {
  const integrity = { store: new FileBackupStore(), cipher: new AesGcmCipher(), kdf: new ScryptKeyDerivation(), hasher: new NodeHasher() };
  const jobs = new InMemoryJobRepository();
  const createBackup = new CreateBackup({
    ...integrity,
    devices: options.devices ?? new FakeDeviceGateway(),
    archives: new FakeArchiveSource(chunks, options.outcome),
    jobs,
    clock: fixedClock(),
    ids: sequentialIds(),
    blockSize: 1024
  });
  return { createBackup, jobs, verify: new VerifyBackup(integrity), exportBackup: new ExportBackup(integrity) };
}

async function* from(chunks: Uint8Array[]) { yield* chunks; }

test('fixedSizeBlocks regroups uneven chunks into full blocks plus a tail', async () => {
  const sizes: number[] = [];
  for await (const block of fixedSizeBlocks(from([new Uint8Array(3), new Uint8Array(10), new Uint8Array(1)]), 4)) sizes.push(block.length);
  assert.deepEqual(sizes, [4, 4, 4, 2]);
});

test('backup → verify → export round-trips the archive byte for byte', async () => {
  const dir = await tempDir();
  const payload = crypto.randomBytes(5000);
  const { createBackup, jobs, verify, exportBackup } = setup([payload.subarray(0, 700), payload.subarray(700)]);

  const result = await createBackup.execute({ deviceId: 'SERIAL1', source: '/sdcard/DCIM', destination: dir, secret: SECRET });
  assert.equal(result.manifest.blocks.length, 5);
  assert.equal(result.manifest.totalBytes, 5000);
  assert.equal(result.manifest.complete, true);
  assert.deepEqual(jobs.history.map(j => j.status), ['running', 'completed']);
  assert.equal((await new GetBackupStatus(jobs).execute(result.jobId)).manifestPath, result.manifestPath);

  const report = await verify.execute({ manifestPath: result.manifestPath, secret: SECRET });
  assert.deepEqual(report, { manifestPath: result.manifestPath, valid: true, blocksChecked: 5, totalBytes: 5000, complete: true, failures: [] });

  const exported = await exportBackup.execute({ manifestPath: result.manifestPath, secret: SECRET, outputPath: path.join(dir, 'out.tar') });
  assert.deepEqual(await fs.readFile(exported.outputPath), payload);
  await assert.rejects(exportBackup.execute({ manifestPath: result.manifestPath, secret: SECRET, outputPath: exported.outputPath }), /overwrite/);
});

test('verification reports a wrong secret without exporting anything', async () => {
  const dir = await tempDir();
  const { createBackup, verify, exportBackup } = setup([crypto.randomBytes(2048)]);
  const { manifestPath } = await createBackup.execute({ deviceId: 'SERIAL1', source: '/sdcard', destination: dir, secret: SECRET });

  const report = await verify.execute({ manifestPath, secret: 'not the right secret' });
  assert.equal(report.valid, false);
  assert.match(report.failures[0], /secret is wrong/);

  const out = path.join(dir, 'bad.tar');
  await assert.rejects(exportBackup.execute({ manifestPath, secret: 'not the right secret', outputPath: out }), { code: 'INTEGRITY' });
  await assert.rejects(fs.stat(out));
  await assert.rejects(fs.stat(`${out}.partial`));
});

test('verification pinpoints a tampered block', async () => {
  const dir = await tempDir();
  const { createBackup, verify } = setup([crypto.randomBytes(3000)]);
  const { archivePath, manifestPath, manifest } = await createBackup.execute({ deviceId: 'SERIAL1', source: '/sdcard', destination: dir, secret: SECRET });

  const bytes = await fs.readFile(archivePath);
  const secondBlockStart = 28 + manifest.blocks[0].cipherSize;
  bytes[secondBlockStart + 5] ^= 0xff;
  await fs.writeFile(archivePath, bytes);

  const report = await verify.execute({ manifestPath, secret: SECRET });
  assert.equal(report.valid, false);
  assert.deepEqual(report.failures, ['Block 1 failed authentication']);
});

test('archiver errors keep the backup but flag it incomplete', async () => {
  const dir = await tempDir();
  const { createBackup } = setup([crypto.randomBytes(100)], { outcome: { exitCode: 1, diagnostics: ['tar: Android/data: Permission denied'] } });
  const { manifest } = await createBackup.execute({ deviceId: 'SERIAL1', source: '/sdcard', destination: dir, secret: SECRET });
  assert.equal(manifest.complete, false);
  assert.deepEqual(manifest.warnings, ['tar: Android/data: Permission denied']);
});

test('an archiver that produced nothing fails the job and leaves no files', async () => {
  const dir = await tempDir();
  const { createBackup, jobs } = setup([], { outcome: { exitCode: 1, diagnostics: ['tar: boom'] } });
  await assert.rejects(createBackup.execute({ deviceId: 'SERIAL1', source: '/sdcard', destination: dir, secret: SECRET }), /tar: boom/);
  assert.deepEqual(jobs.history.map(j => j.status), ['running', 'failed']);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('preconditions are checked before any job is created', async () => {
  const dir = await tempDir();
  const devices = new FakeDeviceGateway([describeAdbDevice('LOCKED', 'unauthorized')]);
  const { createBackup, jobs } = setup([], { devices });
  await assert.rejects(createBackup.execute({ deviceId: 'LOCKED', source: '/sdcard', destination: dir, secret: SECRET }), { code: 'DEVICE_UNAVAILABLE' });
  await assert.rejects(createBackup.execute({ deviceId: 'MISSING', source: '/sdcard', destination: dir, secret: SECRET }), { code: 'NOT_FOUND' });
  await assert.rejects(createBackup.execute({ deviceId: 'LOCKED', source: '/sdcard', destination: dir, secret: 'short' }), { code: 'VALIDATION' });
  const ready = setup([]);
  await assert.rejects(ready.createBackup.execute({ deviceId: 'SERIAL1', source: '/nope', destination: dir, secret: SECRET }), { code: 'NOT_FOUND' });
  assert.equal(jobs.history.length + ready.jobs.history.length, 0);
});

test('backup status rejects ids that are not UUIDs', async () => {
  await assert.rejects(new GetBackupStatus(new InMemoryJobRepository()).execute('../../secrets'), { code: 'VALIDATION' });
  await assert.rejects(new GetBackupStatus(new InMemoryJobRepository()).execute(crypto.randomUUID()), { code: 'NOT_FOUND' });
});
