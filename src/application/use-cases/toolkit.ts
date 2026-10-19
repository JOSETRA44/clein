import { assertDevicePath } from '../../domain/backup.js';
import { assertConfirmed, NotFoundError, ValidationError } from '../../domain/errors.js';
import type { Finding } from '../../domain/findings.js';
import { assertPackageName, matchesLogFilter, type AppDetails, type AppSummary, type LogEntry, type LogFilter, type RemoteFileEntry } from '../../domain/inspection.js';
import { assessStorage, rankApps, type AppStorage, type DiskEntry, type StorageCategories, type VolumeUsage } from '../../domain/storage.js';
import { assessVitals, type DeviceVitals } from '../../domain/vitals.js';
import { requireCapability } from '../device-lookup.js';
import type { AppCatalog, DeviceGateway, FileBrowser, LogSource, ProgressListener, ScreenCapture, StorageProbe, ToolchainProbe, ToolStatus, VitalsProbe } from '../ports.js';

/* ── Storage ─────────────────────────────────────────────────────────── */

export interface StorageReport {
  deviceId: string;
  volume: VolumeUsage;
  categories?: StorageCategories;
  topApps: AppStorage[];
  appCount: number;
  measuredAt?: string;
  findings: Finding[];
}

export class AnalyzeStorage {
  constructor(private readonly devices: DeviceGateway, private readonly storage: StorageProbe) {}

  async execute(input: { deviceId?: string; top?: number }): Promise<StorageReport> {
    const device = await requireCapability(this.devices, input.deviceId, 'shell');
    const snapshot = await this.storage.snapshot(device.id);
    return {
      deviceId: device.id,
      volume: snapshot.volume,
      categories: snapshot.categories,
      topApps: rankApps(snapshot.apps).slice(0, input.top ?? 10),
      appCount: snapshot.apps.length,
      measuredAt: snapshot.measuredAt,
      findings: assessStorage(snapshot)
    };
  }
}

export class FindLargestFiles {
  constructor(private readonly devices: DeviceGateway, private readonly storage: StorageProbe) {}

  async execute(input: { deviceId?: string; path?: string; limit?: number }): Promise<{ deviceId: string; path: string; entries: DiskEntry[] }> {
    const path = input.path ?? '/sdcard';
    assertDevicePath(path);
    const device = await requireCapability(this.devices, input.deviceId, 'shell');
    return { deviceId: device.id, path, entries: await this.storage.largest(device.id, path, input.limit ?? 20) };
  }
}

export class TrimCaches {
  constructor(private readonly devices: DeviceGateway, private readonly storage: StorageProbe) {}

  async execute(input: { deviceId?: string; confirm?: boolean }): Promise<{ deviceId: string; freedBytes: number; before: VolumeUsage; after: VolumeUsage }> {
    const device = await requireCapability(this.devices, input.deviceId, 'shell');
    assertConfirmed(input.confirm, 'Trimming app caches');
    const before = (await this.storage.snapshot(device.id)).volume;
    // Requesting the whole volume as free space makes Android drop every cache it can.
    await this.storage.trimCaches(device.id, before.totalBytes);
    const after = (await this.storage.snapshot(device.id)).volume;
    return { deviceId: device.id, freedBytes: Math.max(0, after.freeBytes - before.freeBytes), before, after };
  }
}

/* ── Monitoring ──────────────────────────────────────────────────────── */

export class GetVitals {
  constructor(private readonly devices: DeviceGateway, private readonly vitals: VitalsProbe) {}

  async execute(input: { deviceId?: string }): Promise<{ deviceId: string; vitals: DeviceVitals; findings: Finding[] }> {
    const device = await requireCapability(this.devices, input.deviceId, 'shell');
    const vitals = await this.vitals.sample(device.id);
    return { deviceId: device.id, vitals, findings: assessVitals(vitals) };
  }
}

/* ── Apps ────────────────────────────────────────────────────────────── */

export class ListApps {
  constructor(private readonly devices: DeviceGateway, private readonly apps: AppCatalog) {}

  async execute(input: { deviceId?: string; includeSystem?: boolean; search?: string }): Promise<{ deviceId: string; apps: AppSummary[] }> {
    const device = await requireCapability(this.devices, input.deviceId, 'packages');
    const needle = input.search?.toLowerCase();
    const apps = (await this.apps.list(device.id))
      .filter(a => input.includeSystem || a.kind === 'user')
      .filter(a => !needle || a.packageName.toLowerCase().includes(needle))
      .sort((a, b) => a.packageName.localeCompare(b.packageName));
    return { deviceId: device.id, apps };
  }
}

export class GetAppInfo {
  constructor(private readonly devices: DeviceGateway, private readonly apps: AppCatalog) {}

  async execute(input: { deviceId?: string; packageName: string }): Promise<AppDetails> {
    assertPackageName(input.packageName);
    const device = await requireCapability(this.devices, input.deviceId, 'packages');
    const details = await this.apps.details(device.id, input.packageName);
    if (!details) throw new NotFoundError(`Package not installed: ${input.packageName}`);
    return details;
  }
}

/* ── Files ───────────────────────────────────────────────────────────── */

export class ListFiles {
  constructor(private readonly devices: DeviceGateway, private readonly files: FileBrowser) {}

  async execute(input: { deviceId?: string; path?: string }): Promise<{ deviceId: string; path: string; entries: RemoteFileEntry[] }> {
    const path = input.path ?? '/sdcard';
    assertDevicePath(path);
    const device = await requireCapability(this.devices, input.deviceId, 'shell');
    const target = await this.files.stat(device.id, path);
    if (!target) throw new NotFoundError(`Path not found on device: ${path}`);
    const entries = target.type === 'directory' ? await this.files.list(device.id, path) : [target];
    entries.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
    return { deviceId: device.id, path, entries };
  }
}

export class PullFile {
  constructor(private readonly devices: DeviceGateway, private readonly files: FileBrowser) {}

  async execute(input: { deviceId?: string; path: string; output: string }, onProgress?: ProgressListener) {
    assertDevicePath(input.path);
    if (!input.output) throw new ValidationError('A local output path is required');
    const device = await requireCapability(this.devices, input.deviceId, 'pull');
    const entry = await this.files.stat(device.id, input.path);
    if (!entry) throw new NotFoundError(`Path not found on device: ${input.path}`);
    if (entry.type !== 'file') throw new ValidationError(`${input.path} is a ${entry.type}; use \`backup create\` for directories`);
    const localPath = await this.files.download(device.id, input.path, input.output, p => onProgress?.({ ...p, totalBytes: entry.sizeBytes }));
    return { deviceId: device.id, path: input.path, localPath, bytes: entry.sizeBytes };
  }
}

export class PushFile {
  constructor(private readonly devices: DeviceGateway, private readonly files: FileBrowser) {}

  async execute(input: { deviceId?: string; localPath: string; path: string; confirm?: boolean }) {
    assertDevicePath(input.path);
    if (!input.localPath) throw new ValidationError('A local file is required');
    const device = await requireCapability(this.devices, input.deviceId, 'push');
    if (await this.files.stat(device.id, input.path).then(e => e?.type === 'file')) {
      assertConfirmed(input.confirm, `Overwriting ${input.path}`);
    }
    await this.files.upload(device.id, input.localPath, input.path);
    return { deviceId: device.id, path: input.path, localPath: input.localPath };
  }
}

export class TakeScreenshot {
  constructor(private readonly devices: DeviceGateway, private readonly screen: ScreenCapture) {}

  async execute(input: { deviceId?: string; output?: string }, now: Date = new Date()) {
    const device = await requireCapability(this.devices, input.deviceId, 'shell');
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const localPath = await this.screen.captureTo(device.id, input.output ?? `screenshot-${device.id}-${stamp}.png`);
    return { deviceId: device.id, localPath };
  }
}

/* ── Logs ────────────────────────────────────────────────────────────── */

export class ReadLogs {
  constructor(private readonly devices: DeviceGateway, private readonly logs: LogSource) {}

  async execute(input: { deviceId?: string; lines?: number } & LogFilter): Promise<{ deviceId: string; entries: LogEntry[] }> {
    const device = await requireCapability(this.devices, input.deviceId, 'logcat');
    const lines = input.lines ?? 200;
    // Filtering happens after reading, so read generously to still return `lines` matches.
    const raw = await this.logs.recent(device.id, hasFilter(input) ? Math.max(lines * 20, 5000) : lines);
    return { deviceId: device.id, entries: raw.filter(e => matchesLogFilter(e, input)).slice(-lines) };
  }
}

export class FollowLogs {
  constructor(private readonly devices: DeviceGateway, private readonly logs: LogSource) {}

  async *execute(input: { deviceId?: string } & LogFilter): AsyncGenerator<LogEntry> {
    const device = await requireCapability(this.devices, input.deviceId, 'logcat');
    for await (const entry of this.logs.follow(device.id)) {
      if (matchesLogFilter(entry, input)) yield entry;
    }
  }
}

function hasFilter(filter: LogFilter): boolean {
  return Boolean(filter.minLevel || filter.tag || filter.search || filter.pid !== undefined);
}

/* ── Environment ─────────────────────────────────────────────────────── */

export class RunDoctor {
  constructor(private readonly toolchain: ToolchainProbe, private readonly devices: DeviceGateway) {}

  async execute(): Promise<{ tools: ToolStatus[]; devices: number; findings: Finding[] }> {
    const tools = await this.toolchain.check();
    const findings: Finding[] = [];
    const adb = tools.find(t => t.name === 'adb');
    let deviceCount = 0;
    if (!adb?.available) {
      findings.push({ severity: 'critical', code: 'ADB_MISSING', message: 'adb was not found', recommendation: 'Install Android SDK platform-tools or set ANDROIDCTL_ADB_PATH' });
    } else {
      const devices = await this.devices.listDevices();
      deviceCount = devices.length;
      if (devices.length === 0) findings.push({ severity: 'warning', code: 'NO_DEVICES', message: 'No devices connected', recommendation: 'Enable Developer options › USB debugging and accept the RSA prompt' });
      for (const d of devices) {
        for (const limitation of d.limitations) findings.push({ severity: 'warning', code: 'DEVICE_LIMITED', subject: d.id, message: limitation });
      }
    }
    for (const tool of tools.filter(t => !t.available && t.name !== 'adb')) {
      findings.push({ severity: 'info', code: 'OPTIONAL_TOOL_MISSING', subject: tool.name, message: `${tool.name} not found (optional)` });
    }
    return { tools, devices: deviceCount, findings };
  }
}
