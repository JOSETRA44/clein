/**
 * Composition root: the only place that knows every concrete class. Swapping
 * an adapter (e.g. MTP instead of ADB) means changing wiring here, nothing else.
 */
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import {
  AnalyzeStorage, CreateBackup, DiagnoseDevice, ExportBackup, FindLargestFiles, FollowLogs, GetAppInfo, GetBackupStatus,
  GetVitals, InspectDevice, ListApps, ListDevices, ListFiles, PullFile, PushFile, ReadLogs, RunDoctor, TakeScreenshot,
  TrimCaches, VerifyBackup, AuditPermissions, BuildHealthReport, GetAppPermissions, GetNetworkStatus, HeadlessControl, LaunchMirror,
  ListProcesses, ManageApps, ManagePortMappings, ManageWirelessAdb, PingHost, ReadAuditLog, RunShellCommand, SetPermission, SetWifi,
  type UseCases
} from '../application/use-cases/index.js';
import { AdbArchiveSource } from '../infrastructure/adb/adb-archive-source.js';
import { AdbDeviceGateway } from '../infrastructure/adb/adb-device-gateway.js';
import { AdbShell } from '../infrastructure/adb/adb-shell.js';
import {
  AdbAppCatalog, AdbFileBrowser, AdbLogSource, AdbScreenCapture, AdbStorageProbe, AdbVitalsProbe, LocalToolchainProbe
} from '../infrastructure/adb/adb-toolkit.js';
import {
  AdbAppManager, AdbDeviceInput, AdbHostControl, AdbNetworkProbe, AdbPermissionProbe, AdbProcessProbe, AdbScreenControl, AdbShellRunner,
  AdbUiInspector, ScrcpyLauncher
} from '../infrastructure/adb/adb-operations.js';
import { FileAuditLog } from '../infrastructure/persistence/file-audit-log.js';
import { loadConfig, type AppConfig } from '../infrastructure/config.js';
import { AesGcmCipher, NodeHasher, ScryptKeyDerivation } from '../infrastructure/crypto/node-crypto.js';
import { FileJobRepository } from '../infrastructure/persistence/file-job-repository.js';
import { FileBackupStore } from '../infrastructure/storage/file-backup-store.js';

export function buildAuditLog(config: AppConfig = loadConfig()): FileAuditLog {
  return new FileAuditLog(config.auditFile);
}

export function buildUseCases(config: AppConfig = loadConfig()): UseCases {
  const adb = new AdbShell(config.adbPath);
  const devices = new AdbDeviceGateway(config.adbPath, config.fastbootPath);
  const jobs = new FileJobRepository(config.jobsDir);
  const store = new FileBackupStore();
  const integrity = { store, cipher: new AesGcmCipher(), kdf: new ScryptKeyDerivation(), hasher: new NodeHasher() };
  const storage = new AdbStorageProbe(adb);
  const apps = new AdbAppCatalog(adb, storage);
  const files = new AdbFileBrowser(adb);
  const logs = new AdbLogSource(adb);
  const toolchain = new LocalToolchainProbe([
    { name: 'adb', path: config.adbPath, versionArgs: ['version'] },
    { name: 'fastboot', path: config.fastbootPath, versionArgs: ['--version'] },
    { name: 'scrcpy', path: config.scrcpyPath, versionArgs: ['--version'] }
  ]);

  const network = new AdbNetworkProbe(adb);
  const permissions = new AdbPermissionProbe(adb);
  const diagnoseDevice = new DiagnoseDevice(devices);
  const getVitals = new GetVitals(devices, new AdbVitalsProbe(adb));
  const analyzeStorage = new AnalyzeStorage(devices, storage);
  const networkStatus = new GetNetworkStatus(devices, network, apps);
  const auditPermissions = new AuditPermissions(devices, permissions);

  return {
    listDevices: new ListDevices(devices),
    inspectDevice: new InspectDevice(devices),
    diagnoseDevice,
    createBackup: new CreateBackup({
      ...integrity,
      devices,
      archives: new AdbArchiveSource(config.adbPath),
      jobs,
      clock: { now: () => new Date() },
      ids: { next: () => crypto.randomUUID() }
    }),
    getBackupStatus: new GetBackupStatus(jobs),
    verifyBackup: new VerifyBackup(integrity),
    exportBackup: new ExportBackup(integrity),
    analyzeStorage,
    findLargestFiles: new FindLargestFiles(devices, storage),
    trimCaches: new TrimCaches(devices, storage),
    getVitals,
    listApps: new ListApps(devices, apps),
    getAppInfo: new GetAppInfo(devices, apps),
    listFiles: new ListFiles(devices, files),
    pullFile: new PullFile(devices, files),
    pushFile: new PushFile(devices, files),
    takeScreenshot: new TakeScreenshot(devices, new AdbScreenCapture(adb)),
    readLogs: new ReadLogs(devices, logs),
    followLogs: new FollowLogs(devices, logs),
    runDoctor: new RunDoctor(toolchain, devices),
    networkStatus,
    ping: new PingHost(devices, network),
    setWifi: new SetWifi(devices, network),
    wireless: new ManageWirelessAdb(devices, new AdbHostControl(adb), network),
    portMappings: new ManagePortMappings(devices, new AdbHostControl(adb)),
    auditPermissions,
    appPermissions: new GetAppPermissions(devices, permissions),
    setPermission: new SetPermission(devices, permissions),
    processes: new ListProcesses(devices, new AdbProcessProbe(adb)),
    apps: new ManageApps(devices, new AdbAppManager(adb), apps),
    shell: new RunShellCommand(devices, new AdbShellRunner(adb)),
    headless: new HeadlessControl(devices, new AdbDeviceInput(adb), new AdbUiInspector(adb), new AdbScreenControl(adb)),
    mirror: new LaunchMirror(devices, new ScrcpyLauncher(config.scrcpyPath, config.adbPath)),
    healthReport: new BuildHealthReport({ diagnose: diagnoseDevice, vitals: getVitals, storage: analyzeStorage, network: networkStatus, permissions: auditPermissions, devices }),
    auditLog: new ReadAuditLog(buildAuditLog(config))
  };
}

export const appVersion: string = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
