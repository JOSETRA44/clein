import { sortFindings, type Finding } from './findings.js';
import type { VolumeUsage } from './storage.js';

export type ChargeStatus = 'charging' | 'discharging' | 'not_charging' | 'full' | 'unknown';
export type PowerSource = 'ac' | 'usb' | 'wireless' | 'dock' | 'none';

export interface BatteryStatus {
  levelPercent: number;
  status: ChargeStatus;
  source: PowerSource;
  temperatureC?: number;
  voltageMv?: number;
  health: string;
}

export interface MemoryStatus {
  totalBytes: number;
  availableBytes: number;
  swapTotalBytes?: number;
  swapFreeBytes?: number;
}

export interface CpuStatus {
  cores: number;
  /** 0–100, averaged over all cores. */
  usagePercent?: number;
  loadAverage?: [number, number, number];
}

export interface DeviceVitals {
  sampledAt: string;
  battery?: BatteryStatus;
  memory?: MemoryStatus;
  cpu?: CpuStatus;
  /** Android thermal status: 0 none … 6 shutdown. */
  thermalStatus?: number;
  uptimeSeconds?: number;
  storage?: VolumeUsage;
}

/** Codes from android.os.BatteryManager. */
export const CHARGE_STATUS: Record<number, ChargeStatus> = { 1: 'unknown', 2: 'charging', 3: 'discharging', 4: 'not_charging', 5: 'full' };
export const BATTERY_HEALTH: Record<number, string> = {
  1: 'unknown', 2: 'good', 3: 'overheat', 4: 'dead', 5: 'over_voltage', 6: 'failure', 7: 'cold'
};
const THERMAL_NAMES = ['none', 'light', 'moderate', 'severe', 'critical', 'emergency', 'shutdown'];

export function thermalStatusName(status: number): string {
  return THERMAL_NAMES[status] ?? 'unknown';
}

export function assessVitals(v: DeviceVitals): Finding[] {
  const findings: Finding[] = [];
  const { battery, memory, cpu } = v;

  if (battery) {
    if (battery.temperatureC !== undefined && battery.temperatureC >= 45) {
      findings.push({ severity: 'critical', code: 'BATTERY_HOT', message: `Battery at ${battery.temperatureC.toFixed(1)} °C`, recommendation: 'Stop heavy workloads and unplug fast charging' });
    } else if (battery.temperatureC !== undefined && battery.temperatureC >= 40) {
      findings.push({ severity: 'warning', code: 'BATTERY_WARM', message: `Battery at ${battery.temperatureC.toFixed(1)} °C` });
    }
    if (battery.health !== 'good' && battery.health !== 'unknown') {
      findings.push({ severity: 'warning', code: 'BATTERY_HEALTH', message: `Battery health reported as ${battery.health}` });
    }
    if (battery.levelPercent <= 15 && battery.status !== 'charging') {
      findings.push({ severity: 'warning', code: 'BATTERY_LOW', message: `Battery at ${battery.levelPercent}% and not charging` });
    }
  }

  if (memory && memory.totalBytes > 0 && memory.availableBytes / memory.totalBytes < 0.1) {
    findings.push({ severity: 'warning', code: 'MEMORY_PRESSURE', message: `Only ${Math.round((memory.availableBytes / memory.totalBytes) * 100)}% RAM available`, recommendation: 'Expect app restarts; close background apps before profiling' });
  }

  if (cpu?.loadAverage && cpu.cores > 0 && cpu.loadAverage[0] > cpu.cores * 1.5 && (cpu.usagePercent ?? 100) < 50) {
    findings.push({
      severity: 'info',
      code: 'IO_BOUND_LOAD',
      message: `Load average ${cpu.loadAverage[0].toFixed(1)} on ${cpu.cores} cores while CPU is mostly idle: tasks are waiting on I/O`,
      recommendation: 'Common when storage is nearly full or heavily fragmented'
    });
  } else if (cpu?.usagePercent !== undefined && cpu.usagePercent >= 85) {
    findings.push({ severity: 'warning', code: 'CPU_BUSY', message: `CPU at ${cpu.usagePercent.toFixed(0)}%` });
  }

  if (v.thermalStatus !== undefined && v.thermalStatus >= 3) {
    findings.push({ severity: 'critical', code: 'THERMAL_THROTTLING', message: `Thermal status ${thermalStatusName(v.thermalStatus)}: the device is throttling` });
  }
  return sortFindings(findings);
}
