import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeInputText } from '../../src/infrastructure/adb/adb-operations.js';
import {
  parseIpAddr, parseMappings, parseMdnsServices, parseNetworkStatus, parsePermissionDump, parsePing, parseProcNet,
  parseScreenState, parseTopProcesses, parseUiHierarchy, parseWifiStatus
} from '../../src/infrastructure/adb/ops-parsers.js';
import { redact } from '../../src/infrastructure/persistence/file-audit-log.js';

test('ip addr and network status sections', () => {
  const ifaces = parseIpAddr([
    '1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever',
    '23: wlan0    inet 192.168.1.34/24 brd 192.168.1.255 scope global wlan0\\       valid_lft forever',
    '23: wlan0    inet6 fe80::1/64 scope link \\       valid_lft forever',
    '9: rmnet_data0    inet 10.20.30.40/30 scope global rmnet_data0'
  ].join('\n'));
  assert.deepEqual(ifaces, [{ name: 'wlan0', addresses: ['192.168.1.34', 'fe80::1'] }, { name: 'rmnet_data0', addresses: ['10.20.30.40'] }]);

  const status = parseNetworkStatus({
    ADDR: '23: wlan0    inet 192.168.1.34/24 brd 192.168.1.255 scope global wlan0',
    ROUTE: 'default via 192.168.1.1 dev wlan0 table wlan0 proto static\n',
    WIFI: 'Wifi is enabled\nWifi is connected to "Casa"\nWifiInfo: SSID: "Casa", BSSID: aa:bb:cc:dd:ee:ff, MAC: x, IP: /192.168.1.34, Security type: 2, Supplicant state: COMPLETED, Wi-Fi standard: 11ax, RSSI: -61, Link speed: 866Mbps, Tx Link speed: 866Mbps, Frequency: 5180MHz',
    AIRPLANE: '0\n',
    PDNS: 'hostname\ndns.adguard.com\n',
    CONN: '  DnsAddresses: [ /192.168.1.1,/8.8.8.8 ]\n'
  });
  assert.equal(status.defaultGateway, '192.168.1.1');
  assert.deepEqual(status.wifi, { enabled: true, connected: true, ssid: 'Casa', bssid: 'aa:bb:cc:dd:ee:ff', rssiDbm: -61, linkSpeedMbps: 866, frequencyMhz: 5180, standard: '11ax' });
  assert.deepEqual(status.privateDns, { mode: 'hostname', specifier: 'dns.adguard.com' });
  assert.deepEqual(status.dnsServers, ['192.168.1.1', '8.8.8.8']);
  assert.equal(status.airplaneMode, false);
  assert.deepEqual(parseWifiStatus('Wifi is disabled\n'), { enabled: false, connected: false });
});

test('ping summary', () => {
  assert.deepEqual(parsePing('8.8.8.8', '4 packets transmitted, 3 received, 25% packet loss, time 3004ms\nrtt min/avg/max/mdev = 10.1/12.3/15.0/1.9 ms'),
    { host: '8.8.8.8', transmitted: 4, received: 3, lossPercent: 25, rttAvgMs: 12.3, rttMaxMs: 15 });
  assert.equal(parsePing('h', 'ping: unknown host').lossPercent, 100);
});

test('/proc/net listening sockets (IPv4, IPv6 and v4-mapped)', () => {
  const tcp = parseProcNet('tcp', [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:13AD 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10234        0 1 1',
    '   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10234        0 2 1',
    '   2: 2201A8C0:A1B2 0101A8C0:01BB 01 00000000:00000000 00:00000000 00000000 10111        0 3 1'
  ].join('\n'));
  assert.deepEqual(tcp, [
    { protocol: 'tcp', address: '127.0.0.1', port: 5037, uid: 10234 },
    { protocol: 'tcp', address: '0.0.0.0', port: 8080, uid: 10234 }
  ]);
  const tcp6 = parseProcNet('tcp6', [
    'header',
    '   0: 00000000000000000000000000000000:0035 00000000000000000000000000000000:0000 0A 0:0 00:0 0 1000 0 1',
    '   1: 0000000000000000FFFF00000100007F:1F91 00000000000000000000000000000000:0000 0A 0:0 00:0 0 10050 0 1'
  ].join('\n'));
  assert.deepEqual(tcp6.map(s => [s.address, s.port]), [['::', 53], ['::ffff:127.0.0.1', 8081]]);
});

test('port mappings and mDNS services', () => {
  assert.deepEqual(parseMappings('forward', 'S1 tcp:9222 localabstract:chrome_devtools_remote\nS2 tcp:1 tcp:1\n', 'S1'),
    [{ kind: 'forward', deviceId: 'S1', host: 'tcp:9222', device: 'localabstract:chrome_devtools_remote' }]);
  assert.deepEqual(parseMappings('reverse', 'UsbFfs tcp:3000 tcp:3001\n', 'S1'), [{ kind: 'reverse', deviceId: 'S1', host: 'tcp:3001', device: 'tcp:3000' }]);
  assert.deepEqual(parseMdnsServices('List of discovered mdns services\nadb-148027-AbCd\t_adb-tls-connect._tcp\t192.168.1.34:41235\n'),
    [{ name: 'adb-148027-AbCd', service: '_adb-tls-connect._tcp', endpoint: '192.168.1.34:41235' }]);
});

test('permission dump: user-0 grants only, plus special access sources', () => {
  const apps = parsePermissionDump({
    A11Y: 'com.evil.app/com.evil.app.Svc:com.good.reader/.ReaderService\n',
    NOTIF: 'null\n',
    ADMIN: '  admin=ComponentInfo{com.payjoy.access/com.payjoy.access.AdminReceiver}\n',
    OVERLAY: 'com.evil.app\n',
    INSTALL: '',
    USAGE: '',
    PACKAGES: `Packages:
  Package [com.evil.app] (1a2b):
    pkgFlags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]
    install permissions:
      android.permission.INTERNET: granted=true
    User 0: ceDataInode=1 installed=true
      runtime permissions:
        android.permission.READ_SMS: granted=true, flags=[ USER_SET ]
        android.permission.CAMERA: granted=false, flags=[ ]
    User 999: ceDataInode=2 installed=true
      runtime permissions:
        android.permission.RECORD_AUDIO: granted=true
  Package [android] (3c4d):
    pkgFlags=[ SYSTEM HAS_CODE ]
`
  });
  const evil = apps.find(a => a.packageName === 'com.evil.app')!;
  assert.deepEqual(evil.granted, ['android.permission.INTERNET', 'android.permission.READ_SMS']);
  assert.deepEqual(evil.special.sort(), ['accessibility', 'overlay']);
  assert.equal(apps.find(a => a.packageName === 'android')!.kind, 'system');
  assert.deepEqual(apps.find(a => a.packageName === 'com.payjoy.access')!.special, ['device_admin']);
  assert.deepEqual(apps.find(a => a.packageName === 'com.good.reader')!.special, ['accessibility']);
});

test('top process rows', () => {
  const rows = parseTopProcesses(`Tasks: 952 total
  PID USER         S[%CPU] %MEM  RES NAME
30395 u0_a312      S  3.4   6.2 494M com.zhiliaoapp.musically
 2031 system       S 12.0   7.7 612M system_server
14192 shell        R  0.0   0.0 5.5M top -b -n 1`);
  assert.deepEqual(rows.map(r => [r.pid, r.cpuPercent, r.residentBytes, r.name]), [
    [30395, 3.4, 494 * 1024 ** 2, 'com.zhiliaoapp.musically'],
    [2031, 12, 612 * 1024 ** 2, 'system_server'],
    [14192, 0, Math.round(5.5 * 1024 ** 2), 'top -b -n 1']
  ]);
});

test('screen state from power, window, wm and settings', () => {
  const s = parseScreenState({
    POWER: '  mWakefulness=Asleep\n', WINDOW: '    mShowingLockscreen=true mShowingDream=false\n',
    WM: 'Physical size: 1080x2400\nOverride size: 720x1600\nPhysical density: 480\n', SETTINGS: '30000\n0\n'
  });
  assert.deepEqual(s, { awake: false, locked: true, widthPx: 720, heightPx: 1600, densityDpi: 480, screenOffTimeoutMs: 30000, stayAwakeWhilePlugged: false });
  assert.deepEqual(parseScreenState({}), { awake: undefined, locked: undefined });
});

test('uiautomator hierarchy with entities and password fields', () => {
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="Allow &amp; continue" resource-id="com.android.permissioncontroller:id/permission_allow_button" class="android.widget.Button" package="com.android.permissioncontroller" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[63,1897][1017,2029]" />
<node index="1" text="" resource-id="" class="android.widget.EditText" package="x" content-desc="PIN" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="false" password="true" selected="false" bounds="[0,0][10,10]"><node index="0" text="child" bounds="[1,1][2,2]" /></node>
</hierarchy>`;
  const [button, pin, child] = parseUiHierarchy(xml);
  assert.equal(button.text, 'Allow & continue');
  assert.deepEqual(button.bounds, { left: 63, top: 1897, right: 1017, bottom: 2029 });
  assert.equal(pin.password, true);
  assert.equal(child.text, 'child');
});

test('input text encoding and audit redaction', () => {
  assert.equal(encodeInputText("it's 100% ok"), `'it'\\''s%s100\\%%sok'`);
  assert.deepEqual(redact({ secret: 'x', pairingCode: '123456', manifest: 'm', token: undefined }), { secret: '[redacted]', pairingCode: '[redacted]', manifest: 'm', token: undefined });
});
