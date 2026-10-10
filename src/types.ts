export type TransportName = 'adb' | 'mtp' | 'fastboot' | 'scrcpy';
export type DeviceState = 'device' | 'unauthorized' | 'offline' | 'fastboot' | 'mtp' | 'unknown';

export interface Device {
  id: string;
  transport: TransportName;
  state: DeviceState;
  model?: string;
  serial?: string;
  capabilities: string[];
  limitations: string[];
}

export interface CommandResult { stdout: string; stderr: string; code: number; }
export interface BackupBlock { index: number; offset: number; plainSize: number; cipherSize: number; hash: string; nonce: string; }
export interface BackupManifest { version: 1; jobId: string; deviceId: string; source: string; createdAt: string; blockSize: number; algorithm: 'AES-256-GCM'; blocks: BackupBlock[]; totalBytes: number; digest: string; }
