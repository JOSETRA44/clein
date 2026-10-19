import { ValidationError } from './errors.js';

/** Installed package as reported by the package manager. */
export interface AppSummary {
  packageName: string;
  kind: 'system' | 'user';
  versionCode?: number;
  uid?: number;
}

export interface AppDetails extends AppSummary {
  versionName?: string;
  installer?: string;
  firstInstalledAt?: string;
  updatedAt?: string;
  targetSdk?: number;
  permissions: string[];
  storage?: { codeBytes: number; dataBytes: number; cacheBytes: number };
}

export interface RemoteFileEntry {
  path: string;
  name: string;
  type: 'file' | 'directory' | 'link' | 'other';
  sizeBytes: number;
  modifiedAt: string;
  mode: string;
}

export type LogLevel = 'V' | 'D' | 'I' | 'W' | 'E' | 'F';
export const LOG_LEVELS: readonly LogLevel[] = ['V', 'D', 'I', 'W', 'E', 'F'];

export interface LogEntry {
  /** `MM-DD HH:MM:SS.mmm` as printed by logcat (device local time). */
  time: string;
  pid: number;
  tid: number;
  level: LogLevel;
  tag: string;
  message: string;
}

export interface LogFilter {
  minLevel?: LogLevel;
  tag?: string;
  /** Case-insensitive substring match on tag or message. */
  search?: string;
  pid?: number;
}

export function matchesLogFilter(entry: LogEntry, filter: LogFilter): boolean {
  if (filter.minLevel && LOG_LEVELS.indexOf(entry.level) < LOG_LEVELS.indexOf(filter.minLevel)) return false;
  if (filter.tag && entry.tag !== filter.tag) return false;
  if (filter.pid !== undefined && entry.pid !== filter.pid) return false;
  if (filter.search) {
    const needle = filter.search.toLowerCase();
    if (!entry.tag.toLowerCase().includes(needle) && !entry.message.toLowerCase().includes(needle)) return false;
  }
  return true;
}

const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

export function assertPackageName(name: string | undefined): asserts name is string {
  if (!name || !PACKAGE_NAME.test(name)) throw new ValidationError(`Invalid package name: ${name ?? '(missing)'}`);
}
