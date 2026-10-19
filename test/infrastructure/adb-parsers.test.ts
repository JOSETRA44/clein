import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBattery, parseCpu, parseDf, parseDiskEntries, parseDiskstats, parseLogLine, parseMeminfo, parsePackageDump,
  parsePackageList, parseStatLines
} from '../../src/infrastructure/adb/adb-parsers.js';
import { splitSections } from '../../src/infrastructure/adb/adb-shell.js';
import { normaliseSystemSize } from '../../src/infrastructure/adb/adb-toolkit.js';

/* Fixtures captured from a real Infinix X6885 (Android 16). */

test('df -k', () => {
  const v = parseDf('Filesystem     1K-blocks      Used Available Use% Mounted on\n/dev/block/dm-84 235386848 234142284    707696 100% /data/user/0\n');
  assert.deepEqual(v, { mount: '/data/user/0', totalBytes: 235386848 * 1024, usedBytes: 234142284 * 1024, freeBytes: 707696 * 1024 });
  assert.equal(parseDf('df: /data: Permission denied'), undefined);
});

const DISKSTATS = `Latency: 3ms [512B Data Write]
Data-Free: 707696K / 235386848K total = 0% free
App Size: 29114975744
App Data Size: 193255586939
App Cache Size: 287858688
Photos Size: 3877548032
Videos Size: 110673920
Audio Size: 13283328
Downloads Size: 0
System Size: 256000000000
Other Size: 6958596096
Package Names: ["org.thoughtcrime.securesms","com.whatsapp"]
App Sizes: [202000000,50000000]
App Data Sizes: [166916210688,1000]
Cache Sizes: [12288,2000]`;

test('dumpsys diskstats: categories and per-app arrays', () => {
  const { categories, apps } = parseDiskstats(DISKSTATS);
  assert.equal(categories?.appData, 193255586939);
  assert.equal(categories?.system, 256000000000);
  assert.deepEqual(apps[0], { packageName: 'org.thoughtcrime.securesms', codeBytes: 202000000, dataBytes: 166916210688, cacheBytes: 12288, totalBytes: 167118210688 });
  assert.deepEqual(parseDiskstats('garbage').apps, []);
});

test('"System Size" holding the marketed capacity is recomputed as the unexplained remainder', () => {
  const { categories } = parseDiskstats(DISKSTATS);
  const volume = { mount: '/data', totalBytes: 241e9, usedBytes: 240e9, freeBytes: 1e9 };
  const fixed = normaliseSystemSize(categories!, volume);
  const others = 29114975744 + 193255586939 + 3877548032 + 110673920 + 13283328 + 6958596096;
  assert.equal(fixed.system, 240e9 - others);
  const sane = { ...categories!, system: 5e9 };
  assert.equal(normaliseSystemSize(sane, volume).system, 5e9);
});

test('dumpsys battery', () => {
  const b = parseBattery(`Current Battery Service state:
  AC powered: false
  USB powered: true
  Wireless powered: false
  status: 2
  health: 2
  level: 23
  scale: 100
  voltage: 3783
  temperature: 334
  technology: Li-ion`);
  assert.deepEqual(b, { levelPercent: 23, status: 'charging', source: 'usb', temperatureC: 33.4, voltageMv: 3783, health: 'good' });
});

test('meminfo and cpu', () => {
  const m = parseMeminfo('MemTotal:        7872276 kB\nMemFree:          189664 kB\nMemAvailable:    2269788 kB\nSwapTotal:       7872272 kB\nSwapFree:        4281352 kB\n');
  assert.equal(m?.availableBytes, 2269788 * 1024);
  assert.equal(m?.swapFreeBytes, 4281352 * 1024);
  const cpu = parseCpu('8\n', '16.56 17.62 19.69 1/8286 14123\n', '800%cpu   0%user   0%nice  17%sys 762%idle   3%iow');
  assert.deepEqual(cpu, { cores: 8, loadAverage: [16.56, 17.62, 19.69], usagePercent: 4.75 });
});

test('pm list packages', () => {
  const apps = parsePackageList('package:com.google.android.contacts versionCode:3295893 uid:10315\npackage:com.x.y\nError: java.lang.SecurityException\n', 'user');
  assert.deepEqual(apps, [
    { packageName: 'com.google.android.contacts', kind: 'user', versionCode: 3295893, uid: 10315 },
    { packageName: 'com.x.y', kind: 'user' }
  ]);
});

test('dumpsys package', () => {
  const d = parsePackageDump('org.thoughtcrime.securesms', `Packages:
  Package [org.thoughtcrime.securesms] (abc):
    userId=10290
    versionCode=175001 minSdk=26 targetSdk=36
    versionName=8.27.1
    pkgFlags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]
    installerPackageName=com.android.vending
    requested permissions:
      android.permission.CAMERA
      android.permission.POST_NOTIFICATIONS: restricted=true
    install permissions:
      android.permission.INTERNET: granted=true
    User 0: ceDataInode=1 installed=true
      firstInstallTime=2026-02-08 20:39:38
    lastUpdateTime=2026-09-18 14:59:04
`);
  assert.equal(d.kind, 'user');
  assert.equal(d.versionName, '8.27.1');
  assert.equal(d.versionCode, 175001);
  assert.equal(d.targetSdk, 36);
  assert.equal(d.uid, 10290);
  assert.deepEqual(d.permissions, ['android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS']);
  assert.equal(d.firstInstalledAt, '2026-02-08 20:39:38');
  assert.equal(parsePackageDump('a.b', 'pkgFlags=[ SYSTEM HAS_CODE ]').kind, 'system');
});

test('stat lines keep names containing pipes', () => {
  const [dir, file] = parseStatLines('directory|53248|1792100827|drwxrws---|/sdcard/Download\nregular file|261220|1776463084|-rw-rw----|/sdcard/a|b.png\n');
  assert.equal(dir.type, 'directory');
  assert.equal(dir.name, 'Download');
  assert.equal(file.name, 'a|b.png');
  assert.equal(file.sizeBytes, 261220);
  assert.equal(file.modifiedAt, new Date(1776463084000).toISOString());
});

test('largest entries merge files and du output, excluding the root itself', () => {
  const entries = parseDiskEntries('504000000|/sdcard/a.mp4\n', '6390174\t/sdcard/Android\n9000000\t/sdcard/\n', '/sdcard');
  assert.deepEqual(entries.map(e => [e.kind, e.path]), [['directory', '/sdcard/Android'], ['file', '/sdcard/a.mp4']]);
});

test('logcat threadtime lines', () => {
  assert.deepEqual(parseLogLine('10-16 21:40:47.529  2031  3801 I TranFinanceMgr: isEnableDebuggingFeatures = false\r'), {
    time: '10-16 21:40:47.529', pid: 2031, tid: 3801, level: 'I', tag: 'TranFinanceMgr', message: 'isEnableDebuggingFeatures = false'
  });
  assert.equal(parseLogLine('Usf/policyManager: x')?.tag, undefined);
  assert.equal(parseLogLine('10-16 21:49:41.905  2573  2600 E Usf/policyManager: onExecuteResult: Bundle[{a=1}]')?.tag, 'Usf/policyManager');
  assert.equal(parseLogLine('--------- beginning of system'), undefined);
});

test('section splitter', () => {
  assert.deepEqual(splitSections('noise\n@@A\n1\n2\n@@B\nx'), { A: '1\n2\n', B: 'x\n' });
});
