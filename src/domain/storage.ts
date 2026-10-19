import { sortFindings, type Finding } from './findings.js';

export interface VolumeUsage {
  mount: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}

/** Android's own storage breakdown (as shown in Settings › Storage). */
export interface StorageCategories {
  appCode: number;
  appData: number;
  appCache: number;
  photos: number;
  videos: number;
  audio: number;
  downloads: number;
  system: number;
  other: number;
}

export interface AppStorage {
  packageName: string;
  codeBytes: number;
  dataBytes: number;
  cacheBytes: number;
  totalBytes: number;
}

export interface StorageSnapshot {
  volume: VolumeUsage;
  categories?: StorageCategories;
  apps: AppStorage[];
  /** When Android last measured per-app sizes (the system caches them). */
  measuredAt?: string;
}

export interface DiskEntry {
  path: string;
  sizeBytes: number;
  kind: 'file' | 'directory';
}

export const STORAGE_THRESHOLDS = {
  criticalFreeRatio: 0.02,
  warningFreeRatio: 0.1,
  dominantAppRatio: 0.25,
  largeAppRatio: 0.1,
  reclaimableCacheBytes: 1024 ** 3
} as const;

/**
 * Where to reclaim space inside apps whose data cannot be inspected from the
 * outside. Clearing app data from Android Settings deletes it irreversibly, so
 * the in-app tools are always the first recommendation.
 */
const IN_APP_STORAGE_HINTS: Record<string, string> = {
  'org.thoughtcrime.securesms': 'Signal › Settings › Data and storage › Manage storage: review large files and set "Keep messages" to a limit',
  'com.whatsapp': 'WhatsApp › Settings › Storage and data › Manage storage',
  'com.whatsapp.w4b': 'WhatsApp Business › Settings › Storage and data › Manage storage',
  'org.telegram.messenger': 'Telegram › Settings › Data and Storage › Storage Usage: lower the cache limit',
  'com.zhiliaoapp.musically': 'TikTok › Settings › Free up space',
  'com.spotify.music': 'Spotify › Settings › Storage: remove downloads or clear cache',
  'com.google.android.youtube': 'YouTube › Library › Downloads',
  'com.instagram.android': 'Instagram › Settings › Archiving and downloading'
};

export function inAppStorageHint(packageName: string): string | undefined {
  return IN_APP_STORAGE_HINTS[packageName];
}

export function rankApps(apps: AppStorage[]): AppStorage[] {
  return [...apps].sort((a, b) => b.totalBytes - a.totalBytes);
}

export function assessStorage(snapshot: StorageSnapshot): Finding[] {
  const findings: Finding[] = [];
  const { volume } = snapshot;
  const t = STORAGE_THRESHOLDS;

  if (volume.totalBytes > 0) {
    const freeRatio = volume.freeBytes / volume.totalBytes;
    if (freeRatio < t.criticalFreeRatio) {
      findings.push({
        severity: 'critical',
        code: 'STORAGE_FULL',
        message: `Only ${(freeRatio * 100).toFixed(1)}% free. Android slows down, apps crash and updates fail below ~5%`,
        recommendation: 'Free space before installing builds or taking backups'
      });
    } else if (freeRatio < t.warningFreeRatio) {
      findings.push({ severity: 'warning', code: 'STORAGE_LOW', message: `${(freeRatio * 100).toFixed(1)}% free` });
    }

    for (const app of rankApps(snapshot.apps)) {
      const share = app.totalBytes / volume.totalBytes;
      if (share < t.largeAppRatio) break;
      const dominant = share >= t.dominantAppRatio;
      findings.push({
        severity: dominant ? 'critical' : 'warning',
        code: dominant ? 'DOMINANT_APP' : 'LARGE_APP',
        subject: app.packageName,
        message: `Uses ${(share * 100).toFixed(0)}% of the device` +
          (app.dataBytes > app.codeBytes * 10 ? ', almost all of it app data (messages, media, databases)' : ''),
        recommendation: inAppStorageHint(app.packageName) ??
          'Use the app\'s own storage manager; "Clear storage" in Android Settings deletes its data permanently'
      });
    }
  }

  const cache = snapshot.apps.reduce((sum, a) => sum + a.cacheBytes, 0);
  if (cache >= t.reclaimableCacheBytes) {
    findings.push({
      severity: 'info',
      code: 'RECLAIMABLE_CACHE',
      message: `App caches hold ${(cache / 1024 ** 3).toFixed(1)} GiB`,
      recommendation: 'Run `androidctl storage trim-caches --yes` (safe: apps rebuild caches)'
    });
  }
  return sortFindings(findings);
}
