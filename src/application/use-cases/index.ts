import type { CreateBackup } from './create-backup.js';
import type { DiagnoseDevice, InspectDevice, ListDevices } from './device-queries.js';
import type { ExportBackup, GetBackupStatus, VerifyBackup } from './backup-integrity.js';
import type {
  AnalyzeStorage, FindLargestFiles, FollowLogs, GetAppInfo, GetVitals, ListApps, ListFiles, PullFile, PushFile,
  ReadLogs, RunDoctor, TakeScreenshot, TrimCaches
} from './toolkit.js';
import type {
  AuditPermissions, BuildHealthReport, GetAppPermissions, GetNetworkStatus, HeadlessControl, LaunchMirror, ListProcesses, ManageApps,
  ManagePortMappings, ManageWirelessAdb, PingHost, ReadAuditLog, RunShellCommand, SetPermission, SetWifi
} from './operations.js';

export * from './create-backup.js';
export * from './device-queries.js';
export * from './backup-integrity.js';
export * from './toolkit.js';
export * from './operations.js';

type Port<T extends { execute: (...args: never[]) => unknown }> = Pick<T, 'execute'>;

/** The application's public surface; every delivery mechanism (CLI, MCP) drives only this. */
export interface UseCases {
  listDevices: Port<ListDevices>;
  inspectDevice: Port<InspectDevice>;
  diagnoseDevice: Port<DiagnoseDevice>;
  createBackup: Port<CreateBackup>;
  getBackupStatus: Port<GetBackupStatus>;
  verifyBackup: Port<VerifyBackup>;
  exportBackup: Port<ExportBackup>;
  analyzeStorage: Port<AnalyzeStorage>;
  findLargestFiles: Port<FindLargestFiles>;
  trimCaches: Port<TrimCaches>;
  getVitals: Port<GetVitals>;
  listApps: Port<ListApps>;
  getAppInfo: Port<GetAppInfo>;
  listFiles: Port<ListFiles>;
  pullFile: Port<PullFile>;
  pushFile: Port<PushFile>;
  takeScreenshot: Port<TakeScreenshot>;
  readLogs: Port<ReadLogs>;
  followLogs: Port<FollowLogs>;
  runDoctor: Port<RunDoctor>;
  networkStatus: Port<GetNetworkStatus>;
  ping: Port<PingHost>;
  setWifi: Port<SetWifi>;
  wireless: Pick<ManageWirelessAdb, 'pair' | 'connect' | 'disconnect' | 'discover' | 'enable'>;
  portMappings: Pick<ManagePortMappings, 'list' | 'add' | 'remove'>;
  auditPermissions: Port<AuditPermissions>;
  appPermissions: Port<GetAppPermissions>;
  setPermission: Port<SetPermission>;
  processes: Port<ListProcesses>;
  apps: Pick<ManageApps, 'install' | 'uninstall' | 'restore' | 'launch' | 'stop' | 'clearData'>;
  shell: Port<RunShellCommand>;
  headless: Pick<HeadlessControl, 'state' | 'key' | 'tap' | 'swipe' | 'type' | 'wake' | 'dumpUi' | 'tapElement' | 'waitFor' | 'stayAwake' | 'screenTimeout' | 'record' | 'reboot'>;
  mirror: Port<LaunchMirror>;
  healthReport: Port<BuildHealthReport>;
  auditLog: Port<ReadAuditLog>;
}
