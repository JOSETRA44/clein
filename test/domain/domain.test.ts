import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDevicePath, assertValidSecret } from '../../src/domain/backup.js';
import { describeAdbDevice, describeFastbootDevice, hasCapability, normaliseAdbState } from '../../src/domain/device.js';
import { InvalidStateError, ValidationError } from '../../src/domain/errors.js';
import { completeJob, failJob, isValidJobId, newJob, startJob } from '../../src/domain/job.js';

const t0 = new Date('2026-01-01T00:00:00Z');
const t1 = new Date('2026-01-01T00:05:00Z');
const ID = '3f2b8a52-6c1e-4c33-9a57-0d5b0f3e9b11';

test('ADB state rules grant backup only to authorised devices', () => {
  assert.ok(hasCapability(describeAdbDevice('a', 'device'), 'backup'));
  const unauthorized = describeAdbDevice('a', 'unauthorized');
  assert.deepEqual(unauthorized.capabilities, []);
  assert.match(unauthorized.limitations[0], /Authorize USB debugging/);
  assert.equal(normaliseAdbState('no permissions'), 'unknown');
  assert.equal(normaliseAdbState('recovery'), 'recovery');
});

test('fastboot devices are inspect-only', () => {
  const device = describeFastbootDevice('X');
  assert.deepEqual(device.capabilities, ['bootloader_inspect']);
  assert.equal(device.transport, 'fastboot');
});

test('device descriptions do not share mutable rule arrays', () => {
  describeAdbDevice('a', 'device').capabilities.push('bootloader_inspect');
  assert.ok(!describeAdbDevice('b', 'device').capabilities.includes('bootloader_inspect'));
});

test('job lifecycle follows queued → running → completed|failed', () => {
  const queued = newJob(ID, 'backup', t0);
  assert.equal(queued.status, 'queued');
  const running = startJob(queued, t1);
  assert.equal(running.updatedAt, t1.toISOString());
  assert.throws(() => completeJob(queued, { manifest: {} as never, manifestPath: 'x' }, t1), InvalidStateError);
  const failed = failJob(running, 'boom', t1);
  assert.equal(failed.error, 'boom');
  assert.throws(() => failJob(failed, 'again', t1), InvalidStateError);
  assert.equal(queued.status, 'queued', 'transitions are immutable');
});

test('job ids must be UUIDs (they become file names)', () => {
  assert.ok(isValidJobId(ID));
  assert.ok(!isValidJobId('../../etc/passwd'));
  assert.ok(!isValidJobId(''));
});

test('secret policy requires a minimum length', () => {
  assert.throws(() => assertValidSecret(undefined), ValidationError);
  assert.throws(() => assertValidSecret('short'), /at least 12/);
  assert.doesNotThrow(() => assertValidSecret('correct horse battery'));
});

test('device paths must be absolute, single-line and without ".."', () => {
  assert.doesNotThrow(() => assertDevicePath('/sdcard/DCIM'));
  assert.throws(() => assertDevicePath('sdcard'), /absolute/);
  assert.throws(() => assertDevicePath('/sdcard/\nrm'), /control/);
  assert.throws(() => assertDevicePath('/sdcard/../data'), /\.\./);
});
