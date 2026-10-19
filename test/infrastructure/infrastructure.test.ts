import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArchiverReport } from '../../src/infrastructure/adb/adb-archive-source.js';
import { parseAdbDevices, parseFastbootDevices } from '../../src/infrastructure/adb/adb-device-gateway.js';
import { shellQuote, splitDevicePath } from '../../src/infrastructure/adb/shell-quote.js';
import { loadConfig } from '../../src/infrastructure/config.js';
import { AesGcmCipher } from '../../src/infrastructure/crypto/node-crypto.js';
import { FileJobRepository } from '../../src/infrastructure/persistence/file-job-repository.js';
import { newJob } from '../../src/domain/job.js';
import { tempDir } from '../support/fakes.js';

test('parses `adb devices -l` including details and odd states', () => {
  const devices = parseAdbDevices([
    '* daemon started successfully',
    'List of devices attached',
    '148027058D011036       device usb:1-1 product:a50 model:SM_A505F device:a50 transport_id:1',
    'emulator-5554          unauthorized transport_id:2',
    'ZY22                   no permissions; see [http://developer.android.com/tools/device.html]',
    ''
  ].join('\r\n'));
  assert.deepEqual(devices.map(d => [d.id, d.state, d.model]), [
    ['148027058D011036', 'device', 'SM A505F'],
    ['emulator-5554', 'unauthorized', undefined],
    ['ZY22', 'unknown', undefined]
  ]);
});

test('parses `fastboot devices`', () => {
  assert.deepEqual(parseFastbootDevices('ABC123\tfastboot\n\n').map(d => d.id), ['ABC123']);
});

test('archiver report separates exit status from diagnostics', () => {
  assert.deepEqual(parseArchiverReport('0\n---\n'), { exitCode: 0, diagnostics: [] });
  assert.deepEqual(parseArchiverReport('1\r\n---\r\ntar: x: Permission denied\r\ntar: had errors\r\n'), {
    exitCode: 1, diagnostics: ['tar: x: Permission denied', 'tar: had errors']
  });
  assert.equal(parseArchiverReport('---\n').exitCode, -1);
});

test('shell quoting neutralises metacharacters', () => {
  assert.equal(shellQuote("it's; rm -rf /"), `'it'\\''s; rm -rf /'`);
  assert.deepEqual(splitDevicePath('/sdcard/DCIM/'), { parent: '/sdcard', name: 'DCIM' });
  assert.deepEqual(splitDevicePath('/sdcard'), { parent: '/', name: 'sdcard' });
  assert.deepEqual(splitDevicePath('/'), { parent: '/', name: '.' });
});

test('config honours overrides and derives Windows defaults', () => {
  const config = loadConfig({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ANDROIDCTL_FASTBOOT_PATH: 'D:\\fb.exe' }, 'win32', 'C:\\Users\\me');
  assert.equal(config.adbPath, 'C:\\Users\\me\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe');
  assert.equal(config.fastbootPath, 'D:\\fb.exe');
  assert.equal(config.jobsDir, 'C:\\Users\\me\\AppData\\Local\\androidctl\\jobs');
  assert.equal(loadConfig({ ANDROID_HOME: '/opt/sdk' }, 'linux', '/home/me').adbPath, '/opt/sdk/platform-tools/adb');
});

test('AES-256-GCM round trip and tamper detection', () => {
  const cipher = new AesGcmCipher();
  const key = crypto.randomBytes(32);
  const plain = Buffer.from('androidctl integrity test');
  const encrypted = cipher.encrypt(plain, key);
  assert.deepEqual(Buffer.from(cipher.decrypt(encrypted.data, encrypted.nonce, key)), plain);
  const tampered = Buffer.from(encrypted.data);
  tampered[0] ^= 1;
  assert.throws(() => cipher.decrypt(tampered, encrypted.nonce, key));
});

test('job repository writes atomically and refuses traversal ids', async () => {
  const dir = await tempDir();
  const repo = new FileJobRepository(path.join(dir, 'jobs'));
  const job = newJob(crypto.randomUUID(), 'backup', new Date());
  await repo.save(job);
  assert.deepEqual(await repo.find(job.id), job);
  assert.deepEqual(await fs.readdir(path.join(dir, 'jobs')), [`${job.id}.json`]);
  assert.equal(await repo.find(crypto.randomUUID()), undefined);
  await assert.rejects(repo.find('..\\..\\secret'), { code: 'VALIDATION' });
});
