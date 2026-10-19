import { ExternalToolError, IntegrityError } from '../../domain/errors.js';
import type { AppDetails, AppSummary, LogEntry, RemoteFileEntry } from '../../domain/inspection.js';
import type { DiskEntry, StorageCategories, StorageSnapshot, VolumeUsage } from '../../domain/storage.js';
import type { DeviceVitals } from '../../domain/vitals.js';
import type { AppCatalog, FileBrowser, LogSource, ProgressListener, ScreenCapture, StorageProbe, ToolchainProbe, ToolStatus, VitalsProbe } from '../../application/ports.js';
import { runCommand } from '../process/command-runner.js';
import { writeNewFile } from '../storage/local-files.js';
import { AdbShell, splitSections } from './adb-shell.js';
import {
  parseBattery, parseCpu, parseDf, parseDiskEntries, parseDiskstats, parseLogLine, parseMeminfo,
  parsePackageDump, parsePackageList, parseStatLines
} from './adb-parsers.js';
import { shellQuote } from './shell-quote.js';

const STAT_FORMAT = "'%F|%s|%Y|%A|%n'";
/** `/sdcard` is a symlink; a trailing slash makes du/find descend into the target. */
const descend = (devicePath: string) => shellQuote(devicePath.endsWith('/') ? devicePath : `${devicePath}/`);

export class AdbStorageProbe implements StorageProbe {
  constructor(private readonly adb: AdbShell) {}

  async snapshot(deviceId: string): Promise<StorageSnapshot> {
    const out = await this.adb.text(deviceId, [
      'echo @@DF; df -k /data',
      'echo @@STAMP; stat -c %Y /data/system/diskstats_cache.json 2>/dev/null',
      'echo @@DISKSTATS; dumpsys diskstats'
    ].join('; '));
    const s = splitSections(out);
    const volume = parseDf(s.DF ?? '');
    if (!volume) throw new ExternalToolError('Could not read /data usage from df');
    const stamp = Number((s.STAMP ?? '').trim());
    const { categories, apps } = parseDiskstats(s.DISKSTATS ?? '');
    return {
      volume,
      apps,
      ...(categories ? { categories: normaliseSystemSize(categories, volume) } : {}),
      ...(stamp > 0 ? { measuredAt: new Date(stamp * 1000).toISOString() } : {})
    };
  }

  async largest(deviceId: string, devicePath: string, limit: number): Promise<DiskEntry[]> {
    const n = Math.max(1, Math.min(500, Math.floor(limit)));
    const root = descend(devicePath);
    const out = await this.adb.text(deviceId, [
      `echo @@FILES; find ${root} -type f -size +1024k -exec stat -c '%s|%n' {} + 2>/dev/null | sort -t'|' -k1,1 -rn | head -n ${n}`,
      `echo @@DIRS; du -k -d 3 ${root} 2>/dev/null | sort -rn | head -n ${n + 1}`,
      'true'
    ].join('; '), 300_000);
    const s = splitSections(out);
    return parseDiskEntries(s.FILES ?? '', s.DIRS ?? '', devicePath).slice(0, n * 2);
  }

  async trimCaches(deviceId: string, freeBytes: number): Promise<void> {
    await this.adb.text(deviceId, `pm trim-caches ${Math.floor(freeBytes)}`, 300_000);
  }
}

/**
 * diskstats reports the *marketed* capacity (e.g. 256 GB) as "System Size".
 * Like Settings › Storage, treat "System" as whatever the other categories do not explain.
 */
export function normaliseSystemSize(categories: StorageCategories, volume: VolumeUsage): StorageCategories {
  if (categories.system < volume.totalBytes) return categories;
  const { system: _marketed, ...rest } = categories;
  const explained = Object.values(rest).reduce((sum, n) => sum + n, 0) - categories.appCache;
  return { ...categories, system: Math.max(0, volume.usedBytes - explained) };
}

export class AdbVitalsProbe implements VitalsProbe {
  constructor(private readonly adb: AdbShell, private readonly clock: () => Date = () => new Date()) {}

  async sample(deviceId: string): Promise<DeviceVitals> {
    const out = await this.adb.text(deviceId, [
      'echo @@BATTERY; dumpsys battery',
      'echo @@MEM; cat /proc/meminfo',
      'echo @@LOAD; cat /proc/loadavg',
      'echo @@UPTIME; cat /proc/uptime',
      'echo @@NPROC; nproc',
      "echo @@TOP; top -b -n 1 -m 1 2>/dev/null | grep -m1 '%cpu'",
      "echo @@THERMAL; dumpsys thermalservice 2>/dev/null | grep -m1 'Thermal Status'",
      'echo @@DF; df -k /data',
      'true'
    ].join('; '));
    const s = splitSections(out);
    const battery = parseBattery(s.BATTERY ?? '');
    const memory = parseMeminfo(s.MEM ?? '');
    const cpu = parseCpu(s.NPROC ?? '', s.LOAD ?? '', s.TOP ?? '');
    const storage = parseDf(s.DF ?? '');
    const thermal = /Thermal Status:\s*(\d+)/.exec(s.THERMAL ?? '');
    const uptime = Number((s.UPTIME ?? '').trim().split(/\s+/)[0]);
    return {
      sampledAt: this.clock().toISOString(),
      ...(battery ? { battery } : {}),
      ...(memory ? { memory } : {}),
      ...(cpu ? { cpu } : {}),
      ...(thermal ? { thermalStatus: Number(thermal[1]) } : {}),
      ...(Number.isFinite(uptime) && uptime > 0 ? { uptimeSeconds: Math.round(uptime) } : {}),
      ...(storage ? { storage } : {})
    };
  }
}

export class AdbAppCatalog implements AppCatalog {
  constructor(private readonly adb: AdbShell, private readonly storage?: StorageProbe) {}

  async list(deviceId: string): Promise<AppSummary[]> {
    // `--user 0` avoids failures on phones with a clone/"dual apps" profile the shell cannot access.
    const out = await this.adb.text(deviceId,
      'echo @@USER; pm list packages --user 0 -3 -U --show-versioncode; echo @@SYSTEM; pm list packages --user 0 -s -U --show-versioncode');
    const s = splitSections(out);
    return [...parsePackageList(s.USER ?? '', 'user'), ...parsePackageList(s.SYSTEM ?? '', 'system')];
  }

  async details(deviceId: string, packageName: string): Promise<AppDetails | undefined> {
    const name = shellQuote(packageName);
    const result = await this.adb.exec(deviceId, `pm path --user 0 ${name} >/dev/null 2>&1 || exit 3; dumpsys package ${name}`);
    if (result.code === 3) return undefined;
    if (result.code !== 0) throw new ExternalToolError(`dumpsys package failed: ${result.stderr.trim()}`);
    const details = parsePackageDump(packageName, result.stdout);
    const sizes = (await this.storage?.snapshot(deviceId).catch(() => undefined))?.apps.find(a => a.packageName === packageName);
    return sizes ? { ...details, storage: { codeBytes: sizes.codeBytes, dataBytes: sizes.dataBytes, cacheBytes: sizes.cacheBytes } } : details;
  }
}

export class AdbFileBrowser implements FileBrowser {
  constructor(private readonly adb: AdbShell) {}

  async stat(deviceId: string, devicePath: string): Promise<RemoteFileEntry | undefined> {
    const result = await this.adb.exec(deviceId, `stat -L -c ${STAT_FORMAT} -- ${shellQuote(devicePath)}`);
    return result.code === 0 ? parseStatLines(result.stdout)[0] : undefined;
  }

  async list(deviceId: string, devicePath: string): Promise<RemoteFileEntry[]> {
    const out = await this.adb.text(deviceId, `find ${descend(devicePath)} -mindepth 1 -maxdepth 1 -exec stat -c ${STAT_FORMAT} {} + 2>/dev/null; true`);
    return parseStatLines(out);
  }

  async download(deviceId: string, devicePath: string, localPath: string, onProgress?: ProgressListener): Promise<string> {
    const expected = (await this.stat(deviceId, devicePath))?.sizeBytes;
    const stream = this.adb.binary(deviceId, `cat ${shellQuote(devicePath)}`);
    const written = await writeNewFile(localPath, stream.stdout, {
      onChunk: doneBytes => onProgress?.({ doneBytes, totalBytes: expected }),
      // exec-out hides remote errors, so a short read is the only signal of failure.
      finish: bytes => { if (expected !== undefined && bytes !== expected) throw new IntegrityError(`Short read: got ${bytes} of ${expected} bytes from ${devicePath}`); }
    });
    return written.path;
  }

  async upload(deviceId: string, localPath: string, devicePath: string): Promise<void> {
    const result = await this.adb.run(['-s', deviceId, 'push', localPath, devicePath], undefined);
    if (result.code !== 0) throw new ExternalToolError(`adb push failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

export class AdbScreenCapture implements ScreenCapture {
  constructor(private readonly adb: AdbShell) {}

  async captureTo(deviceId: string, localPath: string): Promise<string> {
    const stream = this.adb.binary(deviceId, 'screencap -p');
    const written = await writeNewFile(localPath, stream.stdout, {
      finish: (_bytes, head) => {
        if (!PNG_MAGIC.every((b, i) => head[i] === b)) throw new ExternalToolError('screencap did not return a PNG (is the screen secure or off?)');
      }
    });
    return written.path;
  }
}

export class AdbLogSource implements LogSource {
  constructor(private readonly adb: AdbShell) {}

  async recent(deviceId: string, count: number): Promise<LogEntry[]> {
    const out = await this.adb.text(deviceId, `logcat -d -v threadtime -t ${Math.max(1, Math.floor(count))}`);
    return out.split('\n').map(parseLogLine).filter((e): e is LogEntry => e !== undefined);
  }

  async *follow(deviceId: string): AsyncGenerator<LogEntry> {
    const stream = this.adb.binary(deviceId, 'logcat -v threadtime -T 1');
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of stream.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      for (const line of parts) {
        const entry = parseLogLine(line);
        if (entry) yield entry;
      }
    }
  }
}

export class LocalToolchainProbe implements ToolchainProbe {
  constructor(private readonly tools: { name: string; path: string; versionArgs: string[] }[]) {}

  async check(): Promise<ToolStatus[]> {
    return Promise.all(this.tools.map(async tool => {
      try {
        const result = await runCommand(tool.path, tool.versionArgs, { timeoutMs: 15_000 });
        const text = `${result.stdout}\n${result.stderr}`;
        const version = /Version ([\w.-]+)/.exec(text)?.[1] ?? /(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1];
        return { name: tool.name, path: tool.path, available: result.code === 0, ...(version ? { version } : {}) };
      } catch (error) {
        return { name: tool.name, path: tool.path, available: false, detail: error instanceof Error ? error.message : String(error) };
      }
    }));
  }
}
