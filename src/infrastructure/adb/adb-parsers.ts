/**
 * Pure parsers for adb/toybox output. Kept free of I/O so each format quirk
 * is covered by a fixture test instead of a connected phone.
 */
import type { AppDetails, AppSummary, LogEntry, LogLevel, RemoteFileEntry } from '../../domain/inspection.js';
import type { AppStorage, DiskEntry, StorageCategories, VolumeUsage } from '../../domain/storage.js';
import { BATTERY_HEALTH, CHARGE_STATUS, type BatteryStatus, type CpuStatus, type MemoryStatus, type PowerSource } from '../../domain/vitals.js';

const lines = (text: string) => text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

/** `df -k <mount>`: Filesystem 1K-blocks Used Available Use% Mounted-on */
export function parseDf(text: string): VolumeUsage | undefined {
  const row = lines(text).find(l => /^\S+\s+\d+\s+\d+\s+\d+/.test(l));
  if (!row) return undefined;
  const [, total, used, free, , mount] = row.split(/\s+/);
  return { mount: mount ?? '/data', totalBytes: Number(total) * 1024, usedBytes: Number(used) * 1024, freeBytes: Number(free) * 1024 };
}

export function parseDiskstats(text: string): { categories?: StorageCategories; apps: AppStorage[] } {
  const field = (name: string) => {
    const match = new RegExp(`^${name}: (\\d+)`, 'm').exec(text);
    return match ? Number(match[1]) : undefined;
  };
  const array = <T>(name: string): T[] => {
    const line = text.split(/\r?\n/).find(l => l.startsWith(`${name}: [`));
    try { return line ? (JSON.parse(line.slice(name.length + 2)) as T[]) : []; } catch { return []; }
  };

  const names = array<string>('Package Names');
  const code = array<number>('App Sizes');
  const data = array<number>('App Data Sizes');
  const cache = array<number>('Cache Sizes');
  const apps = names.map((packageName, i) => {
    const codeBytes = code[i] ?? 0;
    const dataBytes = data[i] ?? 0;
    return { packageName, codeBytes, dataBytes, cacheBytes: cache[i] ?? 0, totalBytes: codeBytes + dataBytes };
  });

  const appCode = field('App Size');
  const categories = appCode === undefined ? undefined : {
    appCode,
    appData: field('App Data Size') ?? 0,
    appCache: field('App Cache Size') ?? 0,
    photos: field('Photos Size') ?? 0,
    videos: field('Videos Size') ?? 0,
    audio: field('Audio Size') ?? 0,
    downloads: field('Downloads Size') ?? 0,
    system: field('System Size') ?? 0,
    other: field('Other Size') ?? 0
  };
  return { categories, apps };
}

/** Lines of `<size>|<path>` (files, bytes) or `<kb>\t<path>` (du directories). */
export function parseDiskEntries(files: string, dirs: string, root: string): DiskEntry[] {
  const fileEntries = lines(files).flatMap(l => {
    const sep = l.indexOf('|');
    const size = Number(l.slice(0, sep));
    return sep > 0 && Number.isFinite(size) ? [{ path: l.slice(sep + 1), sizeBytes: size, kind: 'file' as const }] : [];
  });
  const normalisedRoot = root.replace(/\/+$/, '');
  const dirEntries = lines(dirs).flatMap(l => {
    const match = /^(\d+)\s+(.+)$/.exec(l);
    if (!match) return [];
    const path = match[2].replace(/\/+$/, '');
    return path === normalisedRoot ? [] : [{ path, sizeBytes: Number(match[1]) * 1024, kind: 'directory' as const }];
  });
  return [...fileEntries, ...dirEntries].sort((a, b) => b.sizeBytes - a.sizeBytes);
}

/** `dumpsys battery` */
export function parseBattery(text: string): BatteryStatus | undefined {
  const value = (key: string) => new RegExp(`^\\s*${key}: (.+)$`, 'm').exec(text)?.[1].trim();
  const level = Number(value('level'));
  if (!Number.isFinite(level)) return undefined;
  const scale = Number(value('scale')) || 100;
  const sources: [string, PowerSource][] = [['AC powered', 'ac'], ['USB powered', 'usb'], ['Wireless powered', 'wireless'], ['Dock powered', 'dock']];
  const source = sources.find(([key]) => value(key) === 'true')?.[1] ?? 'none';
  const temperature = Number(value('temperature'));
  const voltage = Number(value('voltage'));
  return {
    levelPercent: Math.round((level / scale) * 100),
    status: CHARGE_STATUS[Number(value('status'))] ?? 'unknown',
    source,
    ...(Number.isFinite(temperature) ? { temperatureC: temperature / 10 } : {}),
    ...(Number.isFinite(voltage) ? { voltageMv: voltage } : {}),
    health: BATTERY_HEALTH[Number(value('health'))] ?? 'unknown'
  };
}

/** `/proc/meminfo` */
export function parseMeminfo(text: string): MemoryStatus | undefined {
  const kb = (key: string) => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : undefined;
  };
  const total = kb('MemTotal');
  if (total === undefined) return undefined;
  const swapTotal = kb('SwapTotal');
  return {
    totalBytes: total,
    availableBytes: kb('MemAvailable') ?? kb('MemFree') ?? 0,
    ...(swapTotal ? { swapTotalBytes: swapTotal, swapFreeBytes: kb('SwapFree') ?? 0 } : {})
  };
}

/** Combines `nproc`, `/proc/loadavg` and toybox top's summary line (`800%cpu … 762%idle`). */
export function parseCpu(nproc: string, loadavg: string, topLine: string): CpuStatus | undefined {
  const cores = Number(nproc.trim());
  if (!Number.isFinite(cores) || cores <= 0) return undefined;
  const load = loadavg.trim().split(/\s+/).slice(0, 3).map(Number);
  const total = /(\d+)%cpu/.exec(topLine);
  const idle = /(\d+)%idle/.exec(topLine);
  return {
    cores,
    ...(load.length === 3 && load.every(Number.isFinite) ? { loadAverage: load as [number, number, number] } : {}),
    ...(total && idle ? { usagePercent: Math.max(0, Math.min(100, ((Number(total[1]) - Number(idle[1])) / Number(total[1])) * 100)) } : {})
  };
}

/** `pm list packages -U --show-versioncode`: `package:<name> versionCode:<n> uid:<n>` */
export function parsePackageList(text: string, kind: AppSummary['kind']): AppSummary[] {
  return lines(text).flatMap(l => {
    const match = /^package:(\S+)(?:\s+versionCode:(\d+))?(?:\s+uid:(\d+))?/.exec(l);
    if (!match) return [];
    return [{
      packageName: match[1],
      kind,
      ...(match[2] ? { versionCode: Number(match[2]) } : {}),
      ...(match[3] ? { uid: Number(match[3]) } : {})
    }];
  });
}

/** `dumpsys package <name>` — only the first (primary user) values are taken. */
export function parsePackageDump(packageName: string, text: string): AppDetails {
  const first = (re: RegExp) => re.exec(text)?.[1];
  const flags = first(/pkgFlags=\[([^\]]*)\]/) ?? '';
  const permissions: string[] = [];
  const requested = /requested permissions:\r?\n((?:\s{6,}\S.*\r?\n)+)/.exec(text);
  if (requested) {
    for (const line of lines(requested[1])) permissions.push(line.split(/[\s,:]/)[0]);
  }
  const versionCode = first(/versionCode=(\d+)/);
  const targetSdk = first(/targetSdk=(\d+)/);
  const uid = first(/userId=(\d+)/);
  return {
    packageName,
    kind: /\bSYSTEM\b/.test(flags) ? 'system' : 'user',
    ...(versionCode ? { versionCode: Number(versionCode) } : {}),
    ...(uid ? { uid: Number(uid) } : {}),
    versionName: first(/versionName=(\S+)/),
    installer: first(/installerPackageName=(\S+)/),
    firstInstalledAt: first(/firstInstallTime=(.+)/)?.trim(),
    updatedAt: first(/lastUpdateTime=(.+)/)?.trim(),
    ...(targetSdk ? { targetSdk: Number(targetSdk) } : {}),
    permissions
  };
}

const FILE_TYPES: Record<string, RemoteFileEntry['type']> = {
  'regular file': 'file',
  'regular empty file': 'file',
  directory: 'directory',
  'symbolic link': 'link'
};

/** `stat -c '%F|%s|%Y|%A|%n'` lines. The name is last so it may itself contain `|`. */
export function parseStatLines(text: string): RemoteFileEntry[] {
  return lines(text).flatMap(l => {
    const parts = l.split('|');
    if (parts.length < 5) return [];
    const [type, size, mtime, mode, ...nameParts] = parts;
    const path = nameParts.join('|');
    return [{
      path,
      name: path.replace(/\/+$/, '').split('/').pop() || path,
      type: FILE_TYPES[type] ?? 'other',
      sizeBytes: Number(size) || 0,
      modifiedAt: new Date(Number(mtime) * 1000).toISOString(),
      mode
    }];
  });
}

const THREADTIME = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.*?)\s*: (.*)$/;

/** One `logcat -v threadtime` line; banners like `--------- beginning of main` yield undefined. */
export function parseLogLine(line: string): LogEntry | undefined {
  const m = THREADTIME.exec(line.replace(/\r$/, ''));
  if (!m) return undefined;
  return { time: m[1], pid: Number(m[2]), tid: Number(m[3]), level: m[4] as LogLevel, tag: m[5], message: m[6] };
}
