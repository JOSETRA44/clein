/** Pure parsers for networking, permissions, processes and UI output. */
import type { ProcessInfo, ScreenState, UiElement } from '../../domain/control.js';
import type { ListeningSocket, NetworkInterface, NetworkStatus, PingResult, PortMapping, WifiStatus } from '../../domain/network.js';
import type { AppPermissions, SpecialAccess } from '../../domain/permissions.js';

const lines = (text: string) => text.split(/\r?\n/);

/* ── Network ─────────────────────────────────────────────────────────── */

/** `ip -o addr show` */
export function parseIpAddr(text: string): NetworkInterface[] {
  const byName = new Map<string, string[]>();
  for (const line of lines(text)) {
    const m = /^\d+:\s+(\S+?)(?:@\S+)?\s+inet6?\s+([0-9a-fA-F.:]+)\//.exec(line.trim());
    if (!m || m[1] === 'lo') continue;
    byName.set(m[1], [...(byName.get(m[1]) ?? []), m[2]]);
  }
  return [...byName].map(([name, addresses]) => ({ name, addresses }));
}

/** First `default via <gw> dev <if>` line of `ip route show table all`. */
export function parseDefaultRoute(text: string): { gateway?: string; iface?: string } {
  const m = /^default via (\S+) dev (\S+)/m.exec(text);
  return m ? { gateway: m[1], iface: m[2] } : {};
}

/** `cmd wifi status` (Android 11+). */
export function parseWifiStatus(text: string): WifiStatus | undefined {
  if (!/Wifi is (enabled|disabled)/i.test(text)) return undefined;
  const field = (name: string) => new RegExp(`${name}: ([^,]+)`).exec(text)?.[1]?.trim();
  const num = (name: string) => { const v = Number.parseInt(field(name) ?? '', 10); return Number.isFinite(v) ? v : undefined; };
  const ssid = /Wifi is connected to "([^"]*)"/.exec(text)?.[1] ?? field('SSID')?.replace(/^"|"$/g, '');
  const connected = /Wifi is connected/i.test(text) || field('Supplicant state') === 'COMPLETED';
  const status: WifiStatus = { enabled: /Wifi is enabled/i.test(text), connected };
  if (connected) {
    Object.assign(status, {
      ...(ssid && ssid !== '<unknown ssid>' ? { ssid } : {}),
      ...(field('BSSID') ? { bssid: field('BSSID') } : {}),
      ...(num('RSSI') !== undefined ? { rssiDbm: num('RSSI') } : {}),
      ...(num('Link speed') !== undefined ? { linkSpeedMbps: num('Link speed') } : {}),
      ...(num('Frequency') !== undefined ? { frequencyMhz: num('Frequency') } : {}),
      ...(field('Wi-Fi standard') ? { standard: field('Wi-Fi standard') } : {})
    });
  }
  return status;
}

export function parseNetworkStatus(sections: Record<string, string>): NetworkStatus {
  const route = parseDefaultRoute(sections.ROUTE ?? '');
  const wifi = parseWifiStatus(sections.WIFI ?? '');
  const [pdnsMode = '', pdnsSpec = ''] = lines(sections.PDNS ?? '').map(l => l.trim());
  const conn = sections.CONN ?? '';
  const dns = [...new Set([...conn.matchAll(/DnsAddresses: \[([^\]]*)\]/g)].flatMap(m => m[1].split(',').map(a => a.trim().replace(/^\//, '')).filter(Boolean)))];
  return {
    interfaces: parseIpAddr(sections.ADDR ?? ''),
    ...(route.gateway ? { defaultGateway: route.gateway, defaultInterface: route.iface } : {}),
    ...(wifi ? { wifi } : {}),
    airplaneMode: (sections.AIRPLANE ?? '').trim() === '1',
    ...(pdnsMode && pdnsMode !== 'null' ? { privateDns: { mode: pdnsMode, ...(pdnsSpec && pdnsSpec !== 'null' ? { specifier: pdnsSpec } : {}) } } : {}),
    vpnActive: /\bVPN\b[^\n]*\bCONNECTED\b|Transports: VPN/i.test(conn),
    dnsServers: dns
  };
}

/** toybox/iputils ping summary. */
export function parsePing(host: string, text: string): PingResult {
  const counts = /(\d+) packets transmitted, (\d+) (?:packets )?received/.exec(text);
  const rtt = /= ([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(text);
  const transmitted = counts ? Number(counts[1]) : 0;
  const received = counts ? Number(counts[2]) : 0;
  return {
    host, transmitted, received,
    lossPercent: transmitted ? Math.round(((transmitted - received) / transmitted) * 1000) / 10 : 100,
    ...(rtt ? { rttAvgMs: Number(rtt[2]), rttMaxMs: Number(rtt[3]) } : {})
  };
}

function hexToIpv4(hex: string): string {
  return [6, 4, 2, 0].map(i => Number.parseInt(hex.slice(i, i + 2), 16)).join('.');
}

function hexToIpv6(hex: string): string {
  // Four little-endian 32-bit words.
  const bytes: string[] = [];
  for (let w = 0; w < 4; w++) {
    const word = hex.slice(w * 8, w * 8 + 8);
    for (let b = 3; b >= 0; b--) bytes.push(word.slice(b * 2, b * 2 + 2));
  }
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(Number.parseInt(bytes[i] + bytes[i + 1], 16).toString(16));
  const full = groups.join(':');
  if (full === '0:0:0:0:0:0:0:0') return '::';
  if (full === '0:0:0:0:0:0:0:1') return '::1';
  const mapped = /^0:0:0:0:0:ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(full);
  if (mapped) {
    const n = (Number.parseInt(mapped[1], 16) << 16) | Number.parseInt(mapped[2], 16);
    return `::ffff:${[n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')}`;
  }
  return full.replace(/(^|:)0(:0)+(:|$)/, '::');
}

/**
 * `/proc/net/{tcp,tcp6,udp,udp6}`: listening TCP sockets (state 0A) and
 * unconnected UDP sockets (state 07 with no remote port).
 */
export function parseProcNet(protocol: ListeningSocket['protocol'], text: string): ListeningSocket[] {
  const v6 = protocol.endsWith('6');
  const tcp = protocol.startsWith('tcp');
  const out: ListeningSocket[] = [];
  for (const line of lines(text).slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 8) continue;
    const [local, remote, state, , , , uid] = cols.slice(1);
    const [addrHex, portHex] = local.split(':');
    if (tcp ? state !== '0A' : !(state === '07' && remote.endsWith(':0000'))) continue;
    out.push({ protocol, address: v6 ? hexToIpv6(addrHex) : hexToIpv4(addrHex), port: Number.parseInt(portHex, 16), uid: Number(uid) });
  }
  return out;
}

/** `adb forward --list` / `adb -s X reverse --list`: `<serial> <a> <b>`. */
export function parseMappings(kind: PortMapping['kind'], text: string, deviceId?: string): PortMapping[] {
  return lines(text).flatMap(line => {
    const [serial, a, b] = line.trim().split(/\s+/);
    if (!serial || !a || !b) return [];
    const owner = kind === 'reverse' ? deviceId ?? serial : serial;
    if (deviceId && owner !== deviceId) return [];
    // forward: host <a> → device <b>; reverse --list prints device <a> → host <b>.
    return [kind === 'forward' ? { kind, deviceId: owner, host: a, device: b } : { kind, deviceId: owner, host: b, device: a }];
  });
}

/** `adb mdns services`: `<instance>\t<service>\t<ip:port>` */
export function parseMdnsServices(text: string): { name: string; service: string; endpoint: string }[] {
  return lines(text).flatMap(line => {
    const [name, service, endpoint] = line.trim().split(/\t+|\s{2,}/);
    return name && service?.startsWith('_adb') && endpoint && /:\d+$/.test(endpoint) ? [{ name, service, endpoint }] : [];
  });
}

/* ── Permissions ─────────────────────────────────────────────────────── */

const componentPackages = (text: string) =>
  new Set(text.split(/[:\s]+/).map(c => c.split('/')[0]).filter(p => /^[\w]+(\.[\w]+)+$/.test(p)));

/**
 * Parses `dumpsys package packages` plus special-access listings. Only grants
 * for the primary user (0) count; clone profiles repeat the same packages.
 */
export function parsePermissionDump(sections: Record<string, string>): AppPermissions[] {
  const special = new Map<string, Set<SpecialAccess>>();
  const add = (pkgs: Iterable<string>, access: SpecialAccess) => {
    for (const p of pkgs) special.set(p, (special.get(p) ?? new Set()).add(access));
  };
  add(componentPackages(sections.A11Y ?? ''), 'accessibility');
  add(componentPackages(sections.NOTIF ?? ''), 'notification_listener');
  add([...(sections.ADMIN ?? '').matchAll(/ComponentInfo\{([\w.]+)\/|^\s+([\w.]+)\/[\w.$]+:\s*$/gm)].map(m => m[1] ?? m[2]), 'device_admin');
  const opPackages = (key: string) => lines(sections[key] ?? '').map(l => l.trim()).filter(l => /^[\w]+(\.[\w]+)+$/.test(l));
  add(opPackages('OVERLAY'), 'overlay');
  add(opPackages('INSTALL'), 'install_packages');
  add(opPackages('USAGE'), 'usage_stats');

  const apps: AppPermissions[] = [];
  let current: AppPermissions | undefined;
  let user: number | undefined;
  for (const raw of lines(sections.PACKAGES ?? '')) {
    const header = /^\s{2}Package \[([^\]]+)\]/.exec(raw);
    if (header) {
      current = { packageName: header[1], kind: 'user', granted: [], special: [...(special.get(header[1]) ?? [])] };
      apps.push(current);
      user = undefined;
      continue;
    }
    if (!current) continue;
    const flags = /^\s+pkgFlags=\[([^\]]*)\]/.exec(raw);
    if (flags && /\bSYSTEM\b/.test(flags[1])) current.kind = 'system';
    const userLine = /^\s+User (\d+):/.exec(raw);
    if (userLine) { user = Number(userLine[1]); continue; }
    const grant = /^\s+([\w.]+): granted=true/.exec(raw);
    if (grant && (user === undefined || user === 0) && !current.granted.includes(grant[1])) current.granted.push(grant[1]);
  }
  // Packages with special access that dumpsys did not list (rare) are still reported.
  for (const [pkg, accesses] of special) {
    if (!apps.some(a => a.packageName === pkg)) apps.push({ packageName: pkg, kind: 'user', granted: [], special: [...accesses] });
  }
  return apps;
}

/* ── Processes ───────────────────────────────────────────────────────── */

function parseSize(value: string): number {
  const m = /^([\d.]+)([KMGT]?)$/i.exec(value.trim());
  if (!m) return 0;
  const scale = { '': 1024, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2].toUpperCase() as '' | 'K' | 'M' | 'G' | 'T'];
  return Math.round(Number(m[1]) * scale);
}

/** `top -b -n 1 -o PID,USER,S,%CPU,%MEM,RES,NAME` rows. */
export function parseTopProcesses(text: string): ProcessInfo[] {
  return lines(text).flatMap(line => {
    const m = /^\s*(\d+)\s+(\S+)\s+([A-Z])\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.+?)\s*$/.exec(line.replace(/\x1b\[[0-9;]*m/g, ''));
    if (!m) return [];
    return [{ pid: Number(m[1]), user: m[2], state: m[3], cpuPercent: Number(m[4]), memPercent: Number(m[5]), residentBytes: parseSize(m[6]), name: m[7] }];
  });
}

/* ── Screen and UI ───────────────────────────────────────────────────── */

export function parseScreenState(sections: Record<string, string>): ScreenState {
  const power = sections.POWER ?? '';
  const wake = /mWakefulness=(\w+)/.exec(power)?.[1];
  const win = sections.WINDOW ?? '';
  const lockMatch = /(?:mShowingLockscreen|isKeyguardShowing|mKeyguardShowing|KeyguardShowing|mDreamingLockscreen)=(true|false)/.exec(win);
  const size = /Override size: (\d+)x(\d+)/.exec(sections.WM ?? '') ?? /Physical size: (\d+)x(\d+)/.exec(sections.WM ?? '');
  const density = /Override density: (\d+)/.exec(sections.WM ?? '') ?? /Physical density: (\d+)/.exec(sections.WM ?? '');
  const [timeout = '', stayOn = ''] = lines(sections.SETTINGS ?? '').map(l => l.trim());
  return {
    awake: wake ? wake === 'Awake' : undefined,
    locked: lockMatch ? lockMatch[1] === 'true' : undefined,
    ...(size ? { widthPx: Number(size[1]), heightPx: Number(size[2]) } : {}),
    ...(density ? { densityDpi: Number(density[1]) } : {}),
    ...(/^\d+$/.test(timeout) ? { screenOffTimeoutMs: Number(timeout) } : {}),
    ...(/^\d+$/.test(stayOn) ? { stayAwakeWhilePlugged: Number(stayOn) !== 0 } : {})
  };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) =>
  e.startsWith('#x') ? String.fromCodePoint(Number.parseInt(e.slice(2), 16)) : e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1))) : ENTITIES[e] ?? m);

/** `uiautomator dump` XML → flat element list in document order. */
export function parseUiHierarchy(xml: string): UiElement[] {
  const elements: UiElement[] = [];
  for (const node of xml.matchAll(/<node\s([^>]*?)\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of node[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = decode(a[2]);
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attrs.bounds ?? '');
    if (!b) continue;
    elements.push({
      index: elements.length,
      text: attrs.text ?? '',
      resourceId: attrs['resource-id'] ?? '',
      contentDesc: attrs['content-desc'] ?? '',
      className: attrs.class ?? '',
      packageName: attrs.package ?? '',
      clickable: attrs.clickable === 'true',
      enabled: attrs.enabled !== 'false',
      focused: attrs.focused === 'true',
      checked: attrs.checked === 'true',
      password: attrs.password === 'true',
      bounds: { left: Number(b[1]), top: Number(b[2]), right: Number(b[3]), bottom: Number(b[4]) }
    });
  }
  return elements;
}
