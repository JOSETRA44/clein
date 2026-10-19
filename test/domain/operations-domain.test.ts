import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTypeableText, healthScore, matchElements, resolveKeycode, type UiElement } from '../../src/domain/control.js';
import { assertEndpoint, assertHost, assertSocketSpec, assessNetwork, signalQuality } from '../../src/domain/network.js';
import { assessPermissions, normalisePermission, scoreApp } from '../../src/domain/permissions.js';
import { assessShellCommand } from '../../src/domain/shell-policy.js';

test('shell policy: read-only commands run, state changes need confirmation, wipes are refused', () => {
  for (const cmd of ['getprop ro.product.model', 'dumpsys battery | grep level', 'ls -la /sdcard && df -h', 'pm list packages -3', "cat '/sdcard/a b.txt' 2>/dev/null", 'settings get global adb_enabled']) {
    assert.equal(assessShellCommand(cmd).risk, 'read', cmd);
  }
  for (const cmd of ['rm /sdcard/x', 'pm uninstall com.x', 'settings put global y 1', 'echo hi > /sdcard/f', 'ls $(rm x)', 'find /sdcard -delete', 'su -c id', 'am force-stop com.x', "sed -i 's/a/b/' f"]) {
    assert.equal(assessShellCommand(cmd).risk, 'write', cmd);
  }
  for (const cmd of ['rm -rf /', 'rm -rf / --no-preserve-root', 'dd if=/dev/zero of=/dev/block/sda', 'mkfs.ext4 /dev/block/x', 'echo ok; rm -fr /*']) {
    assert.equal(assessShellCommand(cmd).risk, 'blocked', cmd);
  }
  assert.equal(assessShellCommand('echo "a;b" | grep a').risk, 'read', 'quoted separators are not split');
});

test('permission risk: OTP-interception combination outranks single grants', () => {
  const sms = scoreApp({ packageName: 'x.sms', kind: 'user', granted: ['android.permission.READ_SMS'], special: ['accessibility'] });
  const camera = scoreApp({ packageName: 'x.cam', kind: 'user', granted: ['android.permission.CAMERA'], special: [] });
  assert.equal(sms.level, 'critical');
  assert.match(sms.reasons[0], /one-time codes/);
  assert.equal(camera.level, 'info');
  const { ranked, findings } = assessPermissions([
    { packageName: 'sys.app', kind: 'system', granted: ['android.permission.READ_SMS'], special: ['accessibility', 'notification_listener'] },
    { packageName: 'x.cam', kind: 'user', granted: ['android.permission.CAMERA'], special: [] },
    { packageName: 'x.none', kind: 'user', granted: ['android.permission.INTERNET'], special: [] }
  ]);
  assert.deepEqual(ranked.map(r => r.packageName), ['x.cam'], 'system apps hidden, zero-score apps dropped');
  assert.deepEqual(findings, []);
  assert.equal(normalisePermission('camera'), 'android.permission.CAMERA');
  assert.equal(normalisePermission('com.x.CUSTOM'), 'com.x.CUSTOM');
});

test('network assessment flags offline, weak Wi-Fi and apps exposed on the LAN', () => {
  const findings = assessNetwork({ interfaces: [], dnsServers: [], wifi: { enabled: true, connected: true, rssiDbm: -80 } }, [
    { protocol: 'tcp', address: '0.0.0.0', port: 8080, uid: 10234, owner: 'com.dev.server' },
    { protocol: 'tcp', address: '127.0.0.1', port: 5037, uid: 10234 },
    { protocol: 'tcp6', address: '::', port: 53, uid: 1000 }
  ]);
  assert.deepEqual(findings.map(f => f.code), ['NO_ROUTE', 'WEAK_WIFI', 'APP_LISTENING_ON_NETWORK']);
  assert.equal(findings[2].subject, 'com.dev.server');
  assert.equal(signalQuality(-50), 'excellent');
  assert.equal(signalQuality(-90), 'unusable');
});

test('host, endpoint and socket spec validation', () => {
  assert.doesNotThrow(() => assertHost('example.com'));
  assert.doesNotThrow(() => assertEndpoint('192.168.1.5:37099'));
  assert.throws(() => assertHost('a;rm -rf'), /Invalid host/);
  assert.throws(() => assertEndpoint('192.168.1.5'), /host:port/);
  assert.throws(() => assertEndpoint('h:99999'));
  assert.doesNotThrow(() => assertSocketSpec('tcp:3000'));
  assert.doesNotThrow(() => assertSocketSpec('localabstract:chrome_devtools_remote'));
  assert.throws(() => assertSocketSpec('tcp:3000;reboot'));
});

const el = (over: Partial<UiElement>): UiElement => ({
  index: 0, text: '', resourceId: '', contentDesc: '', className: 'android.widget.TextView', packageName: 'p', clickable: false,
  enabled: true, focused: false, checked: false, password: false, bounds: { left: 0, top: 0, right: 100, bottom: 100 }, ...over
});

test('UI selectors prefer clickable, then smallest, and match short resource ids', () => {
  const big = el({ text: 'Allow', clickable: true, bounds: { left: 0, top: 0, right: 1000, bottom: 1000 } });
  const small = el({ text: 'Allow', clickable: true, resourceId: 'com.android.permissioncontroller:id/permission_allow_button' });
  const label = el({ text: 'allow' });
  assert.deepEqual(matchElements([label, big, small], { text: 'Allow' }), [small, big, label]);
  assert.deepEqual(matchElements([big, small], { id: 'permission_allow_button' }), [small]);
  assert.deepEqual(matchElements([el({ contentDesc: 'Navigate up' })], { desc: 'navigate', contains: true }).length, 1);
});

test('keys, typing and health score', () => {
  assert.equal(resolveKeycode('HOME'), 3);
  assert.equal(resolveKeycode('66'), 66);
  assert.throws(() => resolveKeycode('teleport'), /Unknown key/);
  assert.throws(() => assertTypeableText('line1\nline2'), /single line/);
  assert.throws(() => assertTypeableText('ñandú'), /ASCII/);
  assert.deepEqual(healthScore([]), { score: 100, grade: 'A' });
  assert.deepEqual(healthScore([{ severity: 'critical', code: 'a', message: '' }, { severity: 'critical', code: 'b', message: '' }, { severity: 'warning', code: 'c', message: '' }]), { score: 42, grade: 'D' });
});
