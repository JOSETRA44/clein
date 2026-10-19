import { sortFindings, type Finding, type Severity } from './findings.js';
import { ValidationError } from './errors.js';

/** Runtime permission groups that expose personal data or sensors. */
export const SENSITIVE_PERMISSIONS: Record<string, string> = {
  'android.permission.CAMERA': 'camera',
  'android.permission.RECORD_AUDIO': 'microphone',
  'android.permission.ACCESS_FINE_LOCATION': 'precise location',
  'android.permission.ACCESS_BACKGROUND_LOCATION': 'background location',
  'android.permission.READ_SMS': 'SMS',
  'android.permission.RECEIVE_SMS': 'SMS',
  'android.permission.SEND_SMS': 'SMS',
  'android.permission.READ_CALL_LOG': 'call log',
  'android.permission.READ_CONTACTS': 'contacts',
  'android.permission.READ_PHONE_STATE': 'phone state',
  'android.permission.CALL_PHONE': 'calls',
  'android.permission.BODY_SENSORS': 'body sensors',
  'android.permission.READ_MEDIA_IMAGES': 'photos',
  'android.permission.READ_MEDIA_VIDEO': 'videos',
  'android.permission.READ_EXTERNAL_STORAGE': 'shared storage',
  'android.permission.MANAGE_EXTERNAL_STORAGE': 'all files'
};

/** Special accesses granted outside the normal permission dialog. They are the usual abuse vectors. */
export type SpecialAccess = 'accessibility' | 'notification_listener' | 'device_admin' | 'overlay' | 'install_packages' | 'usage_stats';

export const SPECIAL_ACCESS_LABEL: Record<SpecialAccess, string> = {
  accessibility: 'accessibility service (can read and control the screen)',
  notification_listener: 'notification access (can read OTP codes and messages)',
  device_admin: 'device administrator (can lock or wipe the device, resists uninstall)',
  overlay: 'draw over other apps',
  install_packages: 'install unknown apps',
  usage_stats: 'usage access'
};

export interface AppPermissions {
  packageName: string;
  kind: 'system' | 'user';
  granted: string[];
  special: SpecialAccess[];
}

export interface AppRisk {
  packageName: string;
  score: number;
  level: Severity;
  sensitive: string[];
  special: SpecialAccess[];
  reasons: string[];
}

const SPECIAL_WEIGHT: Record<SpecialAccess, number> = {
  accessibility: 4, device_admin: 4, notification_listener: 3, overlay: 2, install_packages: 2, usage_stats: 1
};

/**
 * Scores an app by what it can reach. Combinations matter more than single
 * grants: accessibility or notification access together with SMS is the
 * signature of OTP-stealing banking malware.
 */
export function scoreApp(app: AppPermissions): AppRisk {
  const sensitive = [...new Set(app.granted.map(p => SENSITIVE_PERMISSIONS[p]).filter((p): p is string => Boolean(p)))];
  const reasons: string[] = [];
  let score = sensitive.length + app.special.reduce((n, s) => n + SPECIAL_WEIGHT[s], 0);

  const readsSms = sensitive.includes('SMS');
  const watchesScreen = app.special.includes('accessibility') || app.special.includes('notification_listener');
  if (readsSms && watchesScreen) { score += 5; reasons.push('Can read SMS and watch the screen/notifications: able to intercept one-time codes'); }
  if (app.special.includes('accessibility') && app.special.includes('overlay')) { score += 3; reasons.push('Accessibility + overlay: able to draw fake screens and tap for the user'); }
  if (app.special.includes('device_admin')) reasons.push('Device administrator: must be deactivated before it can be uninstalled');
  if (sensitive.includes('background location')) reasons.push('Tracks location in the background');
  if (sensitive.includes('microphone') && sensitive.includes('camera')) reasons.push('Camera and microphone');

  const level: Severity = score >= 10 ? 'critical' : score >= 6 ? 'warning' : 'info';
  return { packageName: app.packageName, score, level, sensitive, special: app.special, reasons };
}

export function assessPermissions(apps: AppPermissions[], options: { includeSystem?: boolean } = {}): { ranked: AppRisk[]; findings: Finding[] } {
  const ranked = apps
    .filter(a => options.includeSystem || a.kind === 'user')
    .map(scoreApp)
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);
  const findings: Finding[] = ranked
    .filter(r => r.level !== 'info')
    .map(r => ({
      severity: r.level,
      code: 'HIGH_PRIVILEGE_APP',
      subject: r.packageName,
      message: r.reasons[0] ?? `Has ${[...r.sensitive, ...r.special.map(s => SPECIAL_ACCESS_LABEL[s])].join(', ')}`,
      recommendation: 'Confirm you trust this app; revoke with `androidctl perms revoke <package> <permission> --yes` or in Settings › Apps'
    }));
  return { ranked, findings: sortFindings(findings) };
}

const PERMISSION = /^[A-Za-z][\w]*(\.[\w]+)+$/;

export function assertPermissionName(permission: string | undefined): asserts permission is string {
  if (!permission || !PERMISSION.test(permission)) throw new ValidationError(`Invalid permission: ${permission ?? '(missing)'}`);
}

/** Accepts short names (`CAMERA`) for platform permissions. */
export function normalisePermission(permission: string): string {
  return permission.includes('.') ? permission : `android.permission.${permission.toUpperCase()}`;
}
