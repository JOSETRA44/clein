import test from 'node:test';
import assert from 'node:assert/strict';
import { assertConfirmed, ConfirmationRequiredError } from '../../src/domain/errors.js';
import { matchesLogFilter, type LogEntry } from '../../src/domain/inspection.js';
import { assessStorage, type AppStorage } from '../../src/domain/storage.js';
import { assessVitals } from '../../src/domain/vitals.js';

const GB = 1e9;
const app = (packageName: string, dataBytes: number, cacheBytes = 0): AppStorage =>
  ({ packageName, codeBytes: 0.2 * GB, dataBytes, cacheBytes, totalBytes: 0.2 * GB + dataBytes });

test('a nearly full device with one dominant app yields two critical findings, worst first', () => {
  const findings = assessStorage({
    volume: { mount: '/data', totalBytes: 240 * GB, usedBytes: 239.3 * GB, freeBytes: 0.7 * GB },
    apps: [app('com.small', 1 * GB), app('org.thoughtcrime.securesms', 167 * GB)]
  });
  assert.deepEqual(findings.map(f => f.code), ['STORAGE_FULL', 'DOMINANT_APP']);
  assert.match(findings[1].recommendation!, /Signal › Settings › Data and storage/);
  assert.match(findings[1].message, /almost all of it app data/);
});

test('large (not dominant) apps warn, unknown apps get the generic safe advice', () => {
  const findings = assessStorage({
    volume: { mount: '/data', totalBytes: 100 * GB, usedBytes: 50 * GB, freeBytes: 50 * GB },
    apps: [app('com.unknown.big', 15 * GB)]
  });
  assert.equal(findings[0].code, 'LARGE_APP');
  assert.match(findings[0].recommendation!, /deletes its data permanently/);
});

test('reclaimable caches are reported as info', () => {
  const findings = assessStorage({
    volume: { mount: '/data', totalBytes: 100 * GB, usedBytes: 10 * GB, freeBytes: 90 * GB },
    apps: [app('a.b', 0, 0.6 * GB), app('c.d', 0, 0.6 * GB)]
  });
  assert.deepEqual(findings.map(f => [f.severity, f.code]), [['info', 'RECLAIMABLE_CACHE']]);
});

test('high load with idle CPU is diagnosed as I/O-bound', () => {
  const findings = assessVitals({ sampledAt: '', cpu: { cores: 8, loadAverage: [17.4, 17, 18], usagePercent: 9 } });
  assert.deepEqual(findings.map(f => f.code), ['IO_BOUND_LOAD']);
});

test('battery temperature and thermal throttling', () => {
  const findings = assessVitals({
    sampledAt: '',
    battery: { levelPercent: 80, status: 'discharging', source: 'none', temperatureC: 46, health: 'good' },
    thermalStatus: 3
  });
  assert.deepEqual(findings.map(f => f.code).sort(), ['BATTERY_HOT', 'THERMAL_THROTTLING']);
  assert.ok(findings.every(f => f.severity === 'critical'));
});

test('log filters combine level, tag, pid and search', () => {
  const e: LogEntry = { time: '', pid: 10, tid: 10, level: 'W', tag: 'ActivityManager', message: 'ANR in com.app' };
  assert.ok(matchesLogFilter(e, { minLevel: 'W', search: 'anr' }));
  assert.ok(!matchesLogFilter(e, { minLevel: 'E' }));
  assert.ok(!matchesLogFilter(e, { tag: 'Other' }));
  assert.ok(!matchesLogFilter(e, { pid: 11 }));
});

test('state-changing operations need explicit confirmation', () => {
  assert.throws(() => assertConfirmed(undefined, 'Trimming'), ConfirmationRequiredError);
  assert.throws(() => assertConfirmed(false, 'Trimming'), { code: 'CONFIRMATION_REQUIRED' });
  assert.doesNotThrow(() => assertConfirmed(true, 'Trimming'));
});
