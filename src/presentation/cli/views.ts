import type { Device } from '../../domain/device.js';
import type { Finding } from '../../domain/findings.js';
import type { AppDetails, AppSummary, LogEntry, RemoteFileEntry } from '../../domain/inspection.js';
import type { DiskEntry, VolumeUsage } from '../../domain/storage.js';
import { thermalStatusName, type DeviceVitals } from '../../domain/vitals.js';
import type { StorageReport } from '../../application/use-cases/index.js';
import { formatAge, formatBytes, formatDuration, type Ui } from './ui.js';
import { OPERATION_VIEWS } from './views-ops.js';

type View = (data: any, ui: Ui) => string;

function findings(list: Finding[] | undefined, ui: Ui): string {
  if (!list?.length) return `\n  ${ui.green('✔ No problems found')}`;
  return '\n' + list.map(f => {
    const subject = f.subject ? ui.bold(` [${f.subject}]`) : '';
    const advice = f.recommendation ? `\n             ${ui.dim('→ ' + f.recommendation)}` : '';
    return `  ${ui.severity(f.severity)}${subject} ${f.message}${advice}`;
  }).join('\n');
}

function volumeLine(v: VolumeUsage, ui: Ui): string {
  const ratio = v.totalBytes ? v.usedBytes / v.totalBytes : 0;
  return `  ${ui.meter(ratio, 32)} ${ui.bold((ratio * 100).toFixed(1) + '%')} used  ` +
    `${formatBytes(v.usedBytes)} / ${formatBytes(v.totalBytes)}  ${ui.dim('free')} ${ratio > 0.95 ? ui.red(formatBytes(v.freeBytes)) : formatBytes(v.freeBytes)}`;
}

function stateColor(device: Device, ui: Ui): string {
  if (device.state === 'device') return ui.green(device.state);
  if (device.state === 'unauthorized' || device.state === 'offline') return ui.red(device.state);
  return ui.yellow(device.state);
}

function deviceBlock(d: Device, ui: Ui): string {
  return ui.keyValues([
    ['Device', ui.bold(d.id)],
    ['Model', d.model],
    ['Transport', d.transport],
    ['State', stateColor(d, ui)],
    ['Capabilities', d.capabilities.join(', ') || ui.dim('none')],
    ['Limitations', d.limitations.length ? ui.yellow(d.limitations.join('; ')) : undefined]
  ]);
}

const LEVEL_STYLE: Record<string, (ui: Ui, t: string) => string> = {
  V: (ui, t) => ui.dim(t), D: (ui, t) => ui.cyan(t), I: (ui, t) => ui.green(t),
  W: (ui, t) => ui.yellow(t), E: (ui, t) => ui.red(t), F: (ui, t) => ui.paint(['bold', 'red'], t)
};

export function logLine(e: LogEntry, ui: Ui): string {
  const style = LEVEL_STYLE[e.level] ?? ((_u: Ui, t: string) => t);
  return `${ui.dim(e.time)} ${String(e.pid).padStart(5)} ${style(ui, e.level)} ${ui.bold(e.tag)}: ${e.level === 'E' || e.level === 'F' ? style(ui, e.message) : e.message}`;
}

export const VIEWS: Record<string, View> = {
  device_list: (devices: Device[], ui) => devices.length === 0
    ? `  ${ui.yellow('No devices connected.')} Enable USB debugging and run ${ui.bold('androidctl doctor')}`
    : ui.table(['DEVICE', 'MODEL', 'TRANSPORT', 'STATE', 'NOTES'], devices.map(d => [
      ui.bold(d.id), d.model ?? '—', d.transport, stateColor(d, ui), d.limitations[0] ? ui.yellow(d.limitations[0]) : ''
    ])),

  device_capabilities: (d: Device, ui) => deviceBlock(d, ui),

  device_diagnose: (r: { device: Device; properties: Record<string, string> }, ui) => {
    const p = r.properties;
    const boot = p.verifiedBootState === 'green' ? ui.green('green (verified)') : p.verifiedBootState ? ui.yellow(p.verifiedBootState) : undefined;
    return deviceBlock(r.device, ui) + ui.heading('System') + '\n' + ui.keyValues([
      ['Manufacturer', p.manufacturer], ['Android', p.androidVersion && `${p.androidVersion} (SDK ${p.sdk})`],
      ['Security patch', p.securityPatch], ['Verified boot', boot],
      ['Bootloader', p.bootloaderLocked === '1' ? 'locked' : p.bootloaderLocked === '0' ? ui.yellow('unlocked') : undefined],
      ['Encryption', p.encryptionState]
    ]);
  },

  device_vitals: (r: { deviceId: string; vitals: DeviceVitals; findings: Finding[] }, ui) => {
    const v = r.vitals;
    const out: string[] = [ui.heading(`Vitals · ${r.deviceId}`) + ui.dim(`  ${new Date(v.sampledAt).toLocaleTimeString()}`)];
    if (v.battery) {
      const b = v.battery;
      const temp = b.temperatureC === undefined ? '' : `  ${b.temperatureC >= 40 ? ui.red(`${b.temperatureC.toFixed(1)} °C`) : `${b.temperatureC.toFixed(1)} °C`}`;
      const charging = b.status === 'charging' ? ui.green(`⚡ charging via ${b.source}`) : b.status;
      out.push(`  ${ui.dim('Battery ')} ${ui.meter(b.levelPercent / 100, 24, true)} ${ui.bold(`${b.levelPercent}%`)}  ${charging}${temp}  ${ui.dim(`health ${b.health}`)}`);
    }
    if (v.cpu) {
      const usage = v.cpu.usagePercent ?? 0;
      const load = v.cpu.loadAverage ? ui.dim(`  load ${v.cpu.loadAverage.map(n => n.toFixed(2)).join(' ')}`) : '';
      out.push(`  ${ui.dim('CPU     ')} ${ui.meter(usage / 100, 24)} ${ui.bold(`${usage.toFixed(0)}%`)}  ${v.cpu.cores} cores${load}`);
    }
    if (v.memory) {
      const used = v.memory.totalBytes - v.memory.availableBytes;
      const swap = v.memory.swapTotalBytes ? ui.dim(`  swap ${formatBytes(v.memory.swapTotalBytes - (v.memory.swapFreeBytes ?? 0))} / ${formatBytes(v.memory.swapTotalBytes)}`) : '';
      out.push(`  ${ui.dim('RAM     ')} ${ui.meter(used / v.memory.totalBytes, 24)} ${ui.bold(formatBytes(used))} / ${formatBytes(v.memory.totalBytes)}${swap}`);
    }
    if (v.storage) {
      const ratio = v.storage.usedBytes / v.storage.totalBytes;
      out.push(`  ${ui.dim('Storage ')} ${ui.meter(ratio, 24)} ${ui.bold(`${(ratio * 100).toFixed(1)}%`)}  ${ui.dim('free')} ${formatBytes(v.storage.freeBytes)}`);
    }
    const extras = [
      v.thermalStatus !== undefined ? `thermal ${v.thermalStatus >= 3 ? ui.red(thermalStatusName(v.thermalStatus)) : thermalStatusName(v.thermalStatus)}` : '',
      v.uptimeSeconds ? `uptime ${formatDuration(v.uptimeSeconds)}` : ''
    ].filter(Boolean);
    if (extras.length) out.push(`  ${ui.dim(extras.join('  ·  '))}`);
    return out.join('\n') + findings(r.findings, ui);
  },

  device_screenshot: (r: { localPath: string }, ui) => `  ${ui.green('✔')} Screenshot saved to ${ui.bold(r.localPath)}`,

  doctor: (r: { tools: { name: string; available: boolean; version?: string; path: string }[]; devices: number; findings: Finding[] }, ui) =>
    ui.table(['TOOL', 'STATUS', 'VERSION', 'PATH'], r.tools.map(t => [
      ui.bold(t.name), t.available ? ui.green('✔ found') : ui.red('✖ missing'), t.version ?? '—', ui.dim(t.path)
    ])) + `\n\n  ${ui.dim('Devices connected:')} ${r.devices}` + findings(r.findings, ui),

  storage_analyze: (r: StorageReport, ui) => {
    const out = [ui.heading(`Storage · ${r.deviceId}`), volumeLine(r.volume, ui)];
    if (r.categories) {
      const c = r.categories;
      const total = r.volume.totalBytes || 1;
      const rows: [string, number][] = [
        ['App data', c.appData], ['System', c.system], ['Apps (code)', c.appCode], ['Other', c.other],
        ['Photos', c.photos], ['Videos', c.videos], ['Audio', c.audio], ['Downloads', c.downloads], ['App cache', c.appCache]
      ];
      out.push(ui.heading('Categories') + ui.dim(r.measuredAt ? `  measured ${formatAge(r.measuredAt)}` : ''));
      out.push(ui.table(['CATEGORY', 'SIZE', 'SHARE', ''], rows.sort((a, b) => b[1] - a[1]).filter(([, n]) => n > 0)
        .map(([name, n]) => [name, formatBytes(n), `${((n / total) * 100).toFixed(1)}%`, ui.meter(n / total, 20, false, [0.25, 0.5])]), ['left', 'right', 'right']));
    }
    out.push(ui.heading(`Top ${r.topApps.length} of ${r.appCount} apps`));
    out.push(ui.table(['PACKAGE', 'TOTAL', 'DATA', 'CODE', 'CACHE', 'SHARE'], r.topApps.map(a => {
      const share = a.totalBytes / (r.volume.totalBytes || 1);
      const name = share >= 0.25 ? ui.paint(['bold', 'red'], a.packageName) : share >= 0.1 ? ui.yellow(a.packageName) : a.packageName;
      return [name, ui.bold(formatBytes(a.totalBytes)), formatBytes(a.dataBytes), formatBytes(a.codeBytes), formatBytes(a.cacheBytes), ui.meter(share, 16, false, [0.1, 0.25])];
    }), ['left', 'right', 'right', 'right', 'right']));
    return out.join('\n') + '\n' + ui.heading('Findings') + findings(r.findings, ui);
  },

  storage_largest: (r: { path: string; entries: DiskEntry[] }, ui) => {
    const section = (kind: DiskEntry['kind'], title: string) => {
      const rows = r.entries.filter(e => e.kind === kind);
      return rows.length ? ui.heading(title) + '\n' + ui.table(['SIZE', 'PATH'], rows.map(e => [ui.bold(formatBytes(e.sizeBytes)), e.path]), ['right']) : '';
    };
    const body = section('directory', `Largest folders under ${r.path}`) + '\n' + section('file', 'Largest files (> 1 MB)');
    return body.trim() ? body : `  ${ui.dim('Nothing large found (private app data is not visible without root)')}`;
  },

  storage_trim_caches: (r: { freedBytes: number; after: VolumeUsage }, ui) =>
    `  ${ui.green('✔')} Freed ${ui.bold(formatBytes(r.freedBytes))}\n` + volumeLine(r.after, ui),

  apps_list: (r: { apps: AppSummary[] }, ui) =>
    ui.table(['PACKAGE', 'KIND', 'VERSION CODE', 'UID'], r.apps.map(a => [
      a.packageName, a.kind === 'system' ? ui.dim('system') : ui.cyan('user'), String(a.versionCode ?? '—'), String(a.uid ?? '—')
    ]), ['left', 'left', 'right', 'right']) + `\n\n  ${ui.dim(`${r.apps.length} packages`)}`,

  app_info: (a: AppDetails, ui) => ui.keyValues([
    ['Package', ui.bold(a.packageName)], ['Kind', a.kind], ['Version', a.versionName && `${a.versionName} (${a.versionCode ?? '?'})`],
    ['Target SDK', a.targetSdk?.toString()], ['Installer', a.installer], ['Installed', a.firstInstalledAt], ['Updated', a.updatedAt],
    ['UID', a.uid?.toString()],
    ['Storage', a.storage && `${ui.bold(formatBytes(a.storage.codeBytes + a.storage.dataBytes))}  ${ui.dim(`data ${formatBytes(a.storage.dataBytes)} · code ${formatBytes(a.storage.codeBytes)} · cache ${formatBytes(a.storage.cacheBytes)}`)}`],
    ['Permissions', `${a.permissions.length} requested`]
  ]) + (a.permissions.length ? '\n' + a.permissions.map(p => `    ${ui.dim('·')} ${p}`).join('\n') : ''),

  files_list: (r: { path: string; entries: RemoteFileEntry[] }, ui) =>
    ui.heading(r.path) + '\n' + ui.table(['MODE', 'SIZE', 'MODIFIED', 'NAME'], r.entries.map(e => [
      ui.dim(e.mode), e.type === 'directory' ? ui.dim('—') : formatBytes(e.sizeBytes), ui.dim(e.modifiedAt.slice(0, 16).replace('T', ' ')),
      e.type === 'directory' ? ui.paint(['bold', 'blue'], e.name + '/') : e.type === 'link' ? ui.cyan(e.name + '@') : e.name
    ]), ['left', 'right']) + `\n\n  ${ui.dim(`${r.entries.length} entries`)}`,

  files_pull: (r: { localPath: string; bytes: number }, ui) => `  ${ui.green('✔')} ${formatBytes(r.bytes)} saved to ${ui.bold(r.localPath)}`,
  files_push: (r: { path: string }, ui) => `  ${ui.green('✔')} Uploaded to ${ui.bold(r.path)}`,

  logs_read: (r: { entries: LogEntry[] }, ui) => r.entries.length ? r.entries.map(e => logLine(e, ui)).join('\n') : `  ${ui.dim('No matching log entries')}`,

  backup_start: (r: { jobId: string; manifestPath: string; manifest: { totalBytes: number; blocks: unknown[]; complete?: boolean; warnings?: string[] } }, ui) =>
    `  ${r.manifest.complete === false ? ui.yellow('▲ Backup kept but incomplete') : ui.green('✔ Backup completed')}\n` + ui.keyValues([
      ['Job', r.jobId], ['Size', `${formatBytes(r.manifest.totalBytes)} in ${r.manifest.blocks.length} encrypted blocks`],
      ['Manifest', r.manifestPath], ['Warnings', r.manifest.warnings?.length ? ui.yellow(r.manifest.warnings.slice(0, 5).join('\n              ')) : undefined]
    ]) + `\n  ${ui.dim('Next: androidctl backup verify ' + JSON.stringify(r.manifestPath))}`,

  backup_status: (j: { id: string; status: string; updatedAt: string; error?: string; manifestPath?: string }, ui) => ui.keyValues([
    ['Job', j.id], ['Status', j.status === 'completed' ? ui.green(j.status) : j.status === 'failed' ? ui.red(j.status) : ui.yellow(j.status)],
    ['Updated', j.updatedAt], ['Manifest', j.manifestPath], ['Error', j.error && ui.red(j.error)]
  ]),

  backup_verify: (r: { valid: boolean; blocksChecked: number; totalBytes: number; complete: boolean; failures: string[] }, ui) =>
    (r.valid ? `  ${ui.green('✔ Backup verified')}` : `  ${ui.red('✖ Verification failed')}`) +
    `  ${ui.dim(`${r.blocksChecked} blocks · ${formatBytes(r.totalBytes)}${r.complete ? '' : ' · archive was incomplete'}`)}` +
    (r.failures.length ? '\n' + r.failures.map(f => `    ${ui.red('·')} ${f}`).join('\n') : ''),

  backup_export: (r: { outputPath: string; totalBytes: number }, ui) => `  ${ui.green('✔')} ${formatBytes(r.totalBytes)} decrypted to ${ui.bold(r.outputPath)}`,

  ...OPERATION_VIEWS
};
