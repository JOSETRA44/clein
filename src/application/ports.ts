/**
 * Ports: everything the use cases need from the outside world, expressed in
 * domain terms. Infrastructure provides the implementations; the application
 * layer never imports Node, adb or the file system directly.
 */
import type { BackupBlock, BackupManifest } from '../domain/backup.js';
import type { Device } from '../domain/device.js';
import type { AppDetails, AppSummary, LogEntry, RemoteFileEntry } from '../domain/inspection.js';
import type { Job } from '../domain/job.js';
import type { DiskEntry, StorageSnapshot } from '../domain/storage.js';
import type { DeviceVitals } from '../domain/vitals.js';
import type { ListeningSocket, NetworkStatus, PingResult, PortMapping } from '../domain/network.js';
import type { AppPermissions } from '../domain/permissions.js';
import type { ProcessInfo, ProcessSort, RebootTarget, ScreenState, UiElement } from '../domain/control.js';

export interface DeviceGateway {
  listDevices(): Promise<Device[]>;
  /** Reads a system property (`getprop`) from a ready ADB device. */
  readProperty(deviceId: string, name: string): Promise<string>;
  pathExists(deviceId: string, devicePath: string): Promise<boolean>;
}

export interface ArchiveOutcome {
  /** Exit status of the archiver on the device; non-zero means some entries were skipped. */
  exitCode: number;
  diagnostics: string[];
}

export interface ArchiveStream {
  chunks: AsyncIterable<Uint8Array>;
  /** Resolves once `chunks` is exhausted. */
  outcome(): Promise<ArchiveOutcome>;
}

/** Streams a device path (file or directory) as a tar archive. */
export interface DeviceArchiveSource {
  open(deviceId: string, devicePath: string): Promise<ArchiveStream>;
  /** Approximate archive size, used only for progress reporting. */
  estimateSize(deviceId: string, devicePath: string): Promise<number | undefined>;
}

export interface JobRepository {
  save(job: Job): Promise<void>;
  find(id: string): Promise<Job | undefined>;
}

export interface EncryptedBlock {
  data: Uint8Array;
  /** Per-block nonce in a printable encoding owned by the cipher (base64). */
  nonce: string;
}

export interface BlockCipher {
  readonly algorithm: 'AES-256-GCM';
  encrypt(plain: Uint8Array, key: Uint8Array): EncryptedBlock;
  /** Throws when authentication fails (wrong key or tampered data). */
  decrypt(data: Uint8Array, nonce: string, key: Uint8Array): Uint8Array;
}

export interface KeyDerivation {
  /** Stable identifier recorded in manifests, e.g. `scrypt:N=32768,r=8,p=1`. */
  readonly id: string;
  randomSalt(): Uint8Array;
  derive(secret: string, salt: Uint8Array): Promise<Uint8Array>;
}

export interface RunningHash {
  update(data: Uint8Array): void;
  digest(): string;
}

export interface Hasher {
  sha256(data: Uint8Array): string;
  start(): RunningHash;
}

export interface BackupLocation {
  archivePath: string;
  manifestPath: string;
}

export interface BackupWriter {
  append(data: Uint8Array): Promise<void>;
  /** Persists the manifest and makes the backup visible atomically. */
  commit(manifest: BackupManifest): Promise<BackupLocation>;
  /** Discards everything written so far. Safe to call more than once. */
  abort(): Promise<void>;
}

export interface BackupReader {
  readonly manifest: BackupManifest;
  readonly salt: Uint8Array;
  readBlock(block: BackupBlock): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface PlainOutput {
  write(data: Uint8Array): Promise<void>;
  commit(): Promise<string>;
  abort(): Promise<void>;
}

export interface BackupStore {
  create(destinationDir: string, jobId: string, salt: Uint8Array): Promise<BackupWriter>;
  open(manifestPath: string): Promise<BackupReader>;
  createPlainOutput(outputPath: string): Promise<PlainOutput>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

/** Remote destinations for finished backups (not yet wired into a use case). */
export interface BackupProvider {
  readonly name: string;
  upload(stream: AsyncIterable<Uint8Array>, metadata: Record<string, unknown>): Promise<void>;
  resume(jobId: string): Promise<void>;
}

/** Direct file access on a device (not yet wired into a use case). */
export interface FileTransport {
  list(deviceId: string, devicePath: string): Promise<string>;
  pull(deviceId: string, devicePath: string, localPath: string): Promise<void>;
  push(deviceId: string, localPath: string, devicePath: string): Promise<void>;
}

/* ── Developer toolkit ports ──────────────────────────────────────────────
 * Split per capability (interface segregation): a future transport only has
 * to implement the probes it can actually support.
 */

export interface StorageProbe {
  snapshot(deviceId: string): Promise<StorageSnapshot>;
  /** Largest files and directories under a path, biggest first. */
  largest(deviceId: string, devicePath: string, limit: number): Promise<DiskEntry[]>;
  /** Asks Android to drop app caches until `freeBytes` are free (system-wide, non-destructive to user data). */
  trimCaches(deviceId: string, freeBytes: number): Promise<void>;
}

export interface VitalsProbe {
  sample(deviceId: string): Promise<DeviceVitals>;
}

export interface AppCatalog {
  list(deviceId: string): Promise<AppSummary[]>;
  details(deviceId: string, packageName: string): Promise<AppDetails | undefined>;
}

/** Reports transfer progress; `totalBytes` is absent when the size is unknown. */
export type ProgressListener = (progress: { doneBytes: number; totalBytes?: number }) => void;

export interface FileBrowser {
  stat(deviceId: string, devicePath: string): Promise<RemoteFileEntry | undefined>;
  list(deviceId: string, devicePath: string): Promise<RemoteFileEntry[]>;
  /** Copies a device file to a new local file; never overwrites. Returns the absolute local path. */
  download(deviceId: string, devicePath: string, localPath: string, onProgress?: ProgressListener): Promise<string>;
  upload(deviceId: string, localPath: string, devicePath: string): Promise<void>;
}

export interface ScreenCapture {
  /** Saves a PNG screenshot to a new local file and returns its absolute path. */
  captureTo(deviceId: string, localPath: string): Promise<string>;
}

export interface LogSource {
  recent(deviceId: string, lines: number): Promise<LogEntry[]>;
  /** Live stream; ends when the consumer stops iterating. */
  follow(deviceId: string): AsyncIterable<LogEntry>;
}

export interface ToolStatus {
  name: string;
  path: string;
  available: boolean;
  version?: string;
  detail?: string;
}

export interface ToolchainProbe {
  check(): Promise<ToolStatus[]>;
}

/* ── Networking ───────────────────────────────────────────────────────── */

export interface NetworkProbe {
  status(deviceId: string): Promise<NetworkStatus>;
  ping(deviceId: string, host: string, count: number): Promise<PingResult>;
  listeningSockets(deviceId: string): Promise<ListeningSocket[]>;
  setWifi(deviceId: string, enabled: boolean): Promise<void>;
}

/** Host-side adb operations that are not scoped to a shell session. */
export interface AdbHost {
  pair(endpoint: string, code: string): Promise<string>;
  connect(endpoint: string): Promise<string>;
  disconnect(endpoint?: string): Promise<string>;
  /** Restarts adbd on the device in TCP mode and returns the port. */
  enableTcpip(deviceId: string, port: number): Promise<void>;
  discover(): Promise<{ name: string; service: string; endpoint: string }[]>;
  listMappings(deviceId: string): Promise<PortMapping[]>;
  addMapping(mapping: PortMapping): Promise<void>;
  /** `spec` is the host side for forwards and the device side for reverses. */
  removeMapping(deviceId: string, kind: PortMapping['kind'], spec: string): Promise<void>;
}

/* ── Permissions and processes ───────────────────────────────────────── */

export interface PermissionProbe {
  /** Granted runtime/install permissions and special accesses for every package. */
  all(deviceId: string): Promise<AppPermissions[]>;
  setGranted(deviceId: string, packageName: string, permission: string, granted: boolean): Promise<void>;
}

export interface ProcessProbe {
  snapshot(deviceId: string, limit: number, sort: ProcessSort): Promise<ProcessInfo[]>;
}

export interface AppManager {
  install(deviceId: string, apkPaths: string[], options: { replace: boolean; grantAll: boolean; downgrade: boolean }): Promise<string>;
  uninstall(deviceId: string, packageName: string, options: { keepData: boolean; userOnly: boolean }): Promise<void>;
  launch(deviceId: string, packageName: string): Promise<void>;
  forceStop(deviceId: string, packageName: string): Promise<void>;
  clearData(deviceId: string, packageName: string): Promise<void>;
  /** Re-enables a system package previously removed for the user (`install-existing`). */
  restore(deviceId: string, packageName: string): Promise<void>;
}

/* ── Shell ───────────────────────────────────────────────────────────── */

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

export interface ShellRunner {
  run(deviceId: string, command: string, options: { timeoutMs: number; maxOutputBytes: number; asRoot: boolean }): Promise<ShellResult>;
}

/* ── Headless control ────────────────────────────────────────────────── */

export interface DeviceInput {
  key(deviceId: string, keycode: number, longPress?: boolean): Promise<void>;
  tap(deviceId: string, x: number, y: number): Promise<void>;
  swipe(deviceId: string, from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number): Promise<void>;
  /** Types text into the focused field. Implementations must never log `text`. */
  text(deviceId: string, text: string): Promise<void>;
}

export interface UiInspector {
  dump(deviceId: string): Promise<UiElement[]>;
}

export interface ScreenControl {
  state(deviceId: string): Promise<ScreenState>;
  setStayAwake(deviceId: string, enabled: boolean): Promise<void>;
  setScreenTimeout(deviceId: string, ms: number): Promise<void>;
  record(deviceId: string, localPath: string, seconds: number): Promise<string>;
  reboot(deviceId: string, target: RebootTarget): Promise<void>;
}

/** Launches an external mirroring/control tool (scrcpy). */
export interface MirrorLauncher {
  launch(options: { deviceId?: string; otg: boolean; turnScreenOff: boolean; stayAwake: boolean; record?: string; noAudio: boolean; readOnly: boolean }): Promise<{ command: string; exitCode: number }>;
}

/* ── Cross-cutting ───────────────────────────────────────────────────── */

export interface AuditEntry {
  at: string;
  operation: string;
  safety: 'write' | 'destructive';
  deviceId?: string;
  input: Record<string, unknown>;
  outcome: 'ok' | 'error' | 'denied';
  error?: string;
  channel: 'cli' | 'mcp';
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
  recent(limit: number): Promise<AuditEntry[]>;
}
