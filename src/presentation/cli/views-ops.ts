import type { ProcessInfo, ScreenState, UiElement } from '../../domain/control.js';
import type { Finding } from '../../domain/findings.js';
import { signalQuality, type ListeningSocket, type NetworkStatus, type PingResult, type PortMapping } from '../../domain/network.js';
import { SPECIAL_ACCESS_LABEL, type AppRisk, type SpecialAccess } from '../../domain/permissions.js';
import type { AuditEntry } from '../../application/ports.js';
import type { HealthReport } from '../../application/use-cases/index.js';
import { formatBytes, formatDuration, type Ui } from './ui.js';

// Views receive already-validated use case output, hence the loose input type.
type View = (data: any, ui: Ui) => string;

export function renderFindings(list: Finding[] | undefined, ui: Ui): string {
  if (!list?.length) return `\n  ${ui.green('✔ No problems found')}`;
  return '\n' + list.map(f => {
    const subject = f.subject ? ui.bold(` [${f.subject}]`) : '';
    const advice = f.recommendation ? `\n             ${ui.dim('→ ' + f.recommendation)}` : '';
    return `  ${ui.severity(f.severity)}${subject} ${f.message}${advice}`;
  }).join('\n');
}

const ok = (ui: Ui, text: string) => `  ${ui.green('✔')} ${text}`;
const yesNo = (ui: Ui, v: boolean | undefined, yes = 'yes', no = 'no') => v === undefined ? ui.dim('unknown') : v ? yes : no;

function signal(ui: Ui, rssi: number): string {
  const q = signalQuality(rssi);
  const bars = { excellent: '▂▄▆█', good: '▂▄▆_', fair: '▂▄__', weak: '▂___', unusable: '____' }[q];
  const paint = q === 'excellent' || q === 'good' ? ui.green : q === 'fair' ? ui.yellow : ui.red;
  return `${paint(bars)} ${rssi} dBm (${q})`;
}

function riskBar(ui: Ui, risk: AppRisk): string {
  const style = risk.level === 'critical' ? ui.red : risk.level === 'warning' ? ui.yellow : ui.dim;
  return style(`${'■'.repeat(Math.min(12, risk.score))}${' '.repeat(Math.max(0, 12 - risk.score))} ${String(risk.score).padStart(2)}`);
}

export const OPERATION_VIEWS: Record<string, View> = {
  net_status: (r: { deviceId: string; status: NetworkStatus; listening: ListeningSocket[]; findings: Finding[] }, ui) => {
    const s = r.status;
    const out = [ui.heading(`Network · ${r.deviceId}`), ui.keyValues([
      ['Gateway', s.defaultGateway ? `${s.defaultGateway} via ${s.defaultInterface}` : ui.red('none (offline)')],
      ['Wi-Fi', s.wifi ? (s.wifi.connected ? `${ui.bold(s.wifi.ssid ?? 'connected')}  ${s.wifi.rssiDbm !== undefined ? signal(ui, s.wifi.rssiDbm) : ''}` : s.wifi.enabled ? ui.yellow('on, not connected') : ui.dim('off')) : undefined],
      ['Link', s.wifi?.connected ? [s.wifi.linkSpeedMbps && `${s.wifi.linkSpeedMbps} Mbps`, s.wifi.frequencyMhz && `${(s.wifi.frequencyMhz / 1000).toFixed(1)} GHz`, s.wifi.standard].filter(Boolean).join(' · ') : undefined],
      ['DNS', s.dnsServers.join(', ') || undefined],
      ['Private DNS', s.privateDns ? `${s.privateDns.mode}${s.privateDns.specifier ? ` (${s.privateDns.specifier})` : ''}` : undefined],
      ['VPN', yesNo(ui, s.vpnActive, ui.cyan('active'), 'no')],
      ['Airplane', yesNo(ui, s.airplaneMode, ui.yellow('on'), 'off')]
    ])];
    out.push(ui.heading('Interfaces') + '\n' + ui.table(['NAME', 'ADDRESSES'], s.interfaces.map(i => [ui.bold(i.name), i.addresses.join('  ')])));
    const tcp = r.listening.filter(l => l.protocol.startsWith('tcp'));
    if (tcp.length) {
      out.push(ui.heading('Listening TCP ports') + '\n' + ui.table(['PORT', 'ADDRESS', 'OWNER'], tcp.sort((a, b) => a.port - b.port).map(l => [
        String(l.port), l.address === '0.0.0.0' || l.address === '::' ? ui.yellow(`${l.address} (all interfaces)`) : ui.dim(l.address), l.owner ?? `uid ${l.uid}`
      ]), ['right']));
    }
    return out.join('\n') + renderFindings(r.findings, ui);
  },

  net_ping: (r: PingResult, ui) => {
    const loss = r.lossPercent === 0 ? ui.green('0% loss') : r.lossPercent === 100 ? ui.red('100% loss') : ui.yellow(`${r.lossPercent}% loss`);
    return `  ${ui.bold(r.host)}  ${r.received}/${r.transmitted} replies  ${loss}${r.rttAvgMs !== undefined ? `  avg ${r.rttAvgMs} ms  max ${r.rttMaxMs} ms` : ''}`;
  },

  net_wifi: (r: { wifiEnabled: boolean }, ui) => ok(ui, `Wi-Fi ${r.wifiEnabled ? 'enabled' : 'disabled'}`),
  wireless_enable: (r: { endpoint: string; message: string }, ui) => ok(ui, `${r.message}\n  ${ui.dim('You can unplug the USB cable. Use')} --device ${r.endpoint}`),
  wireless_pair: (r: { message: string }, ui) => ok(ui, `${r.message}\n  ${ui.dim('Next: androidctl wireless connect <ip>:<port shown under "IP address & Port">')}`),
  wireless_connect: (r: { message: string }, ui) => ok(ui, r.message),
  wireless_disconnect: (r: { message: string }, ui) => ok(ui, r.message),
  wireless_discover: (r: { services: { name: string; service: string; endpoint: string }[] }, ui) => r.services.length
    ? ui.table(['ENDPOINT', 'SERVICE', 'NAME'], r.services.map(s => [ui.bold(s.endpoint), s.service.includes('pairing') ? ui.yellow('pairing') : ui.green('connect'), ui.dim(s.name)]))
    : `  ${ui.dim('No devices found. Open Settings › Developer options › Wireless debugging on the phone (same network as this PC).')}`,

  ports_list: (r: { mappings: PortMapping[] }, ui) => r.mappings.length
    ? ui.table(['KIND', 'PC', '', 'PHONE'], r.mappings.map(m => [m.kind === 'reverse' ? ui.cyan('reverse') : ui.magenta('forward'), m.host, m.kind === 'reverse' ? '←' : '→', m.device]))
    : `  ${ui.dim('No port mappings')}`,
  ports_reverse: (m: PortMapping, ui) => ok(ui, `Phone ${ui.bold(m.device)} → PC ${ui.bold(m.host)}`),
  ports_forward: (m: PortMapping, ui) => ok(ui, `PC ${ui.bold(m.host)} → phone ${ui.bold(m.device)}`),
  ports_remove: (r: { kind: string; removed: string }, ui) => ok(ui, `Removed ${r.kind} ${r.removed}`),

  perms_audit: (r: { apps: AppRisk[]; scanned: number; findings: Finding[] }, ui) =>
    ui.heading(`Permission audit · ${r.scanned} packages`) + '\n' +
    ui.table(['RISK', 'PACKAGE', 'SENSITIVE', 'SPECIAL ACCESS'], r.apps.map(a => [
      riskBar(ui, a), a.level === 'critical' ? ui.paint(['bold', 'red'], a.packageName) : a.packageName,
      a.sensitive.join(', ') || ui.dim('—'), a.special.join(', ') || ui.dim('—')
    ])) + renderFindings(r.findings, ui),

  perms_show: (r: { packageName: string; kind: string; granted: string[]; special: SpecialAccess[]; risk: AppRisk }, ui) =>
    ui.keyValues([['Package', ui.bold(r.packageName)], ['Kind', r.kind], ['Risk score', riskBar(ui, r.risk)]]) +
    (r.special.length ? ui.heading('Special access') + '\n' + r.special.map(s => `    ${ui.yellow('●')} ${SPECIAL_ACCESS_LABEL[s]}`).join('\n') : '') +
    (r.risk.reasons.length ? '\n' + r.risk.reasons.map(x => `    ${ui.red('!')} ${x}`).join('\n') : '') +
    ui.heading(`Granted permissions (${r.granted.length})`) + '\n' + r.granted.map(p => `    ${ui.dim('·')} ${p}`).join('\n'),

  perms_revoke: (r: { permission: string; packageName: string }, ui) => ok(ui, `Revoked ${r.permission} from ${r.packageName}`),
  perms_grant: (r: { permission: string; packageName: string }, ui) => ok(ui, `Granted ${r.permission} to ${r.packageName}`),

  audit_log: (r: { entries: AuditEntry[] }, ui) => r.entries.length
    ? ui.table(['TIME', 'CHANNEL', 'OPERATION', 'DEVICE', 'OUTCOME'], r.entries.map(e => [
      ui.dim(e.at.replace('T', ' ').slice(0, 19)), e.channel, e.safety === 'destructive' ? ui.red(e.operation) : e.operation, e.deviceId ?? ui.dim('—'),
      e.outcome === 'ok' ? ui.green('ok') : e.outcome === 'denied' ? ui.yellow('denied') : ui.red(`error: ${e.error ?? ''}`.slice(0, 60))
    ]))
    : `  ${ui.dim('No state-changing operations recorded yet')}`,

  ps: (r: { processes: ProcessInfo[] }, ui) => ui.table(['PID', 'USER', 'S', '%CPU', '%MEM', 'RES', 'NAME'], r.processes.map(p => [
    String(p.pid), ui.dim(p.user), p.state ?? '', p.cpuPercent >= 50 ? ui.red(p.cpuPercent.toFixed(1)) : p.cpuPercent >= 10 ? ui.yellow(p.cpuPercent.toFixed(1)) : p.cpuPercent.toFixed(1),
    (p.memPercent ?? 0).toFixed(1), formatBytes(p.residentBytes), p.user.startsWith('u0_') ? ui.cyan(p.name) : p.name
  ]), ['right', 'left', 'left', 'right', 'right', 'right']),

  apps_install: (r: { installed: string[] }, ui) => ok(ui, `Installed ${r.installed.join(', ')}`),
  apps_uninstall: (r: { packageName: string; restoreWith?: string }, ui) => ok(ui, `Uninstalled ${r.packageName}`) + (r.restoreWith ? `\n  ${ui.dim('Undo with: ' + r.restoreWith)}` : ''),
  apps_restore: (r: { packageName: string }, ui) => ok(ui, `Restored ${r.packageName}`),
  apps_launch: (r: { packageName: string }, ui) => ok(ui, `Launched ${r.packageName}`),
  apps_stop: (r: { packageName: string }, ui) => ok(ui, `Stopped ${r.packageName}`),
  apps_clear: (r: { packageName: string }, ui) => ok(ui, `Cleared all data of ${r.packageName}`),

  shell_exec: (r: { stdout: string }) => r.stdout,

  screen_status: (s: ScreenState & { deviceId: string }, ui) => ui.keyValues([
    ['Device', ui.bold(s.deviceId)],
    ['Screen', yesNo(ui, s.awake, ui.green('on'), ui.dim('off'))],
    ['Locked', yesNo(ui, s.locked, ui.yellow('yes'), ui.green('no'))],
    ['Resolution', s.widthPx ? `${s.widthPx}×${s.heightPx}${s.densityDpi ? ` @ ${s.densityDpi} dpi` : ''}` : undefined],
    ['Timeout', s.screenOffTimeoutMs ? formatDuration(s.screenOffTimeoutMs / 1000) : undefined],
    ['Stay awake', yesNo(ui, s.stayAwakeWhilePlugged, 'while plugged in', 'no')]
  ]),
  screen_wake: (r: { awake?: boolean; locked?: boolean }, ui) => r.locked
    ? `  ${ui.yellow('▲')} Screen is on but a secure lock is showing — unlock it yourself, e.g. with ${ui.bold('androidctl mirror')}`
    : ok(ui, r.awake ? 'Screen on and unlocked' : 'Wake signal sent'),
  screen_stay_awake: (r: { stayAwake: boolean }, ui) => ok(ui, `Stay awake ${r.stayAwake ? 'enabled' : 'disabled'}`),
  screen_timeout: (r: { screenOffTimeoutSeconds: number }, ui) => ok(ui, `Screen timeout set to ${formatDuration(r.screenOffTimeoutSeconds)}`),
  screen_record: (r: { localPath: string; seconds: number }, ui) => ok(ui, `${r.seconds}s recording saved to ${ui.bold(r.localPath)}`),
  input_key: (r: { key: string; keycode: number }, ui) => ok(ui, `Pressed ${r.key} ${ui.dim(`(${r.keycode})`)}`),
  input_tap: (r: { x: number; y: number }, ui) => ok(ui, `Tapped ${r.x},${r.y}`),
  input_swipe: (r: { from: { x: number; y: number }; to: { x: number; y: number } }, ui) => ok(ui, `Swiped ${r.from.x},${r.from.y} → ${r.to.x},${r.to.y}`),
  input_text: (r: { typedCharacters: number }, ui) => ok(ui, `Typed ${r.typedCharacters} characters`),

  ui_dump: (r: { elements: UiElement[]; total: number }, ui) =>
    ui.table(['#', 'TEXT / DESCRIPTION', 'ID', 'CENTER', 'STATE'], r.elements.map(e => [
      ui.dim(String(e.index)),
      e.password ? ui.dim('•••••• (password field)') : (e.text || ui.dim(e.contentDesc) || ui.dim(e.className.split('.').pop() ?? '')).slice(0, 48),
      ui.dim(e.resourceId.split(':id/').pop() ?? ''),
      `${Math.round((e.bounds.left + e.bounds.right) / 2)},${Math.round((e.bounds.top + e.bounds.bottom) / 2)}`,
      [e.clickable ? ui.cyan('tap') : '', e.checked ? ui.green('✔') : '', e.focused ? ui.yellow('focus') : '', e.enabled ? '' : ui.dim('disabled')].filter(Boolean).join(' ')
    ]), ['right']) + `\n\n  ${ui.dim(`${r.elements.length} of ${r.total} nodes · tap one with: androidctl ui tap --text "…"`)}`,
  ui_tap: (r: { tapped: { x: number; y: number }; element: UiElement; alternatives: number }, ui) =>
    ok(ui, `Tapped "${r.element.text || r.element.contentDesc || r.element.resourceId}" at ${r.tapped.x},${r.tapped.y}`) + (r.alternatives ? ui.dim(`  (${r.alternatives} other match${r.alternatives > 1 ? 'es' : ''}; use --index)`) : ''),
  ui_wait: (r: { attempts: number }, ui) => ok(ui, `Condition met after ${r.attempts} check${r.attempts > 1 ? 's' : ''}`),

  mirror: (r: { exitCode: number; command: string }, ui) => r.exitCode === 0 ? ok(ui, 'Mirroring session ended') : `  ${ui.red('✖')} scrcpy exited with ${r.exitCode}\n  ${ui.dim(r.command)}`,
  reboot: (r: { target: string }, ui) => ok(ui, `Rebooting into ${r.target}`),

  health_report: (r: HealthReport, ui) => {
    const color = r.score >= 75 ? ui.green : r.score >= 50 ? ui.yellow : ui.red;
    const counts = (['critical', 'warning', 'info'] as const).map(s => `${r.findings.filter(f => f.severity === s).length} ${s}`).join(' · ');
    return ui.heading(`Health report · ${r.deviceId}`) + `\n  ${ui.paint('bold', color(`${r.score}/100`))}  grade ${ui.bold(r.grade)}  ${ui.dim(counts)}` +
      r.findings.map(f => `\n  ${ui.severity(f.severity)} ${ui.dim(f.section.padEnd(11))} ${f.subject ? ui.bold(`[${f.subject}] `) : ''}${f.message}${f.recommendation ? `\n                         ${ui.dim('→ ' + f.recommendation)}` : ''}`).join('') +
      (Object.keys(r.errors).length ? '\n' + Object.entries(r.errors).map(([k, v]) => `  ${ui.yellow('▲')} ${k} not collected: ${v}`).join('\n') : '') +
      `\n\n  ${ui.dim('Save it: androidctl report report.html')}`;
  }
};
