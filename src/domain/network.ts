import { sortFindings, type Finding } from './findings.js';
import { ValidationError } from './errors.js';

export interface NetworkInterface {
  name: string;
  addresses: string[];
}

export interface WifiStatus {
  enabled: boolean;
  connected: boolean;
  ssid?: string;
  bssid?: string;
  rssiDbm?: number;
  linkSpeedMbps?: number;
  frequencyMhz?: number;
  standard?: string;
}

export interface NetworkStatus {
  interfaces: NetworkInterface[];
  defaultGateway?: string;
  defaultInterface?: string;
  wifi?: WifiStatus;
  airplaneMode?: boolean;
  privateDns?: { mode: string; specifier?: string };
  vpnActive?: boolean;
  dnsServers: string[];
}

export interface PingResult {
  host: string;
  transmitted: number;
  received: number;
  lossPercent: number;
  rttAvgMs?: number;
  rttMaxMs?: number;
}

export interface ListeningSocket {
  protocol: 'tcp' | 'tcp6' | 'udp' | 'udp6';
  address: string;
  port: number;
  uid: number;
  owner?: string;
}

/**
 * forward: connections to `host` on this PC reach `device` on the phone.
 * reverse: connections to `device` on the phone reach `host` on this PC (dev servers).
 */
export interface PortMapping {
  kind: 'forward' | 'reverse';
  deviceId: string;
  host: string;
  device: string;
}

/** Wi-Fi signal buckets as Android's status bar draws them. */
export function signalQuality(rssiDbm: number): 'excellent' | 'good' | 'fair' | 'weak' | 'unusable' {
  if (rssiDbm >= -55) return 'excellent';
  if (rssiDbm >= -67) return 'good';
  if (rssiDbm >= -75) return 'fair';
  if (rssiDbm >= -85) return 'weak';
  return 'unusable';
}

export function isWildcardAddress(address: string): boolean {
  return address === '0.0.0.0' || address === '::' || address === '*';
}

export function isLoopbackAddress(address: string): boolean {
  return address.startsWith('127.') || address === '::1';
}

export function assessNetwork(status: NetworkStatus, sockets: ListeningSocket[] = []): Finding[] {
  const findings: Finding[] = [];
  if (status.airplaneMode) findings.push({ severity: 'warning', code: 'AIRPLANE_MODE', message: 'Airplane mode is on' });
  if (!status.defaultGateway) {
    findings.push({ severity: 'critical', code: 'NO_ROUTE', message: 'No default route: the device is offline', recommendation: 'Check Wi-Fi/mobile data; `androidctl net wifi on` can re-enable Wi-Fi without the screen' });
  }
  const wifi = status.wifi;
  if (wifi?.enabled === false && !status.defaultGateway) {
    findings.push({ severity: 'info', code: 'WIFI_OFF', message: 'Wi-Fi is disabled' });
  }
  if (wifi?.connected && wifi.rssiDbm !== undefined) {
    const quality = signalQuality(wifi.rssiDbm);
    if (quality === 'weak' || quality === 'unusable') {
      findings.push({ severity: 'warning', code: 'WEAK_WIFI', message: `Wi-Fi signal is ${quality} (${wifi.rssiDbm} dBm)`, recommendation: 'Move closer to the access point or prefer 5 GHz' });
    }
  }
  if (status.privateDns && status.privateDns.mode === 'off') {
    findings.push({ severity: 'info', code: 'PRIVATE_DNS_OFF', message: 'Private DNS (DNS-over-TLS) is off' });
  }
  if (status.vpnActive) findings.push({ severity: 'info', code: 'VPN_ACTIVE', message: 'A VPN is active; traffic and DNS go through it' });

  const exposed = sockets.filter(s => (s.protocol === 'tcp' || s.protocol === 'tcp6') && isWildcardAddress(s.address) && s.uid >= 10000);
  for (const socket of exposed) {
    findings.push({
      severity: 'warning',
      code: 'APP_LISTENING_ON_NETWORK',
      subject: socket.owner ?? `uid ${socket.uid}`,
      message: `Accepts TCP connections from the network on port ${socket.port}`,
      recommendation: 'Fine for dev servers; otherwise confirm the app is expected to expose a service on the LAN'
    });
  }
  return sortFindings(findings);
}

const HOSTNAME = /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9A-Fa-f:]{2,39}$/;

export function assertHost(host: string | undefined): asserts host is string {
  if (!host || !(IPV4.test(host) || IPV6.test(host) || HOSTNAME.test(host))) throw new ValidationError(`Invalid host: ${host ?? '(missing)'}`);
}

/** `host:port` endpoints for adb connect/pair. */
export function assertEndpoint(endpoint: string | undefined): asserts endpoint is string {
  const match = endpoint ? /^(.+):(\d{1,5})$/.exec(endpoint) : null;
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new ValidationError(`Expected host:port, got ${endpoint ?? '(missing)'}`);
  assertHost(match[1].replace(/^\[|\]$/g, ''));
}

/** adb forward/reverse specs: tcp:<port>, localabstract:<name>, jdwp:<pid>… */
export function assertSocketSpec(spec: string | undefined): asserts spec is string {
  if (!spec || !/^(tcp:\d{1,5}|localabstract:[\w.-]+|localreserved:[\w.-]+|localfilesystem:[\w./-]+|jdwp:\d+|dev:[\w./-]+)$/.test(spec)) {
    throw new ValidationError(`Invalid socket spec: ${spec ?? '(missing)'} (e.g. tcp:8080)`);
  }
}
