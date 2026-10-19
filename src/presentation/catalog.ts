/**
 * Single source of truth for every user-facing operation. The CLI (commands,
 * flags, help) and the MCP server (tools, schemas, annotations) are both
 * generated from this list, so they cannot drift apart. Adding a capability
 * means: write the use case, then add one entry here.
 */
import { z } from 'zod';
import { MIN_SECRET_LENGTH } from '../domain/backup.js';
import { LOG_LEVELS } from '../domain/inspection.js';
import type { ProgressListener } from '../application/ports.js';
import type { UseCases } from '../application/use-cases/index.js';

export type Safety = 'read' | 'write' | 'destructive';

export interface CommandContext {
  useCases: UseCases;
  onProgress?: ProgressListener;
}

export interface CommandDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  /** MCP tool name and renderer key. */
  id: string;
  /** CLI words, e.g. ['storage', 'analyze']. */
  path: string[];
  group: string;
  summary: string;
  /** Longer guidance for MCP clients; falls back to `summary`. */
  description?: string;
  input: S;
  /** Input keys that may be given positionally on the CLI, in order. */
  positional?: (keyof S & string)[];
  /** The last positional swallows all remaining words (e.g. a shell command line). */
  variadic?: boolean;
  safety: Safety;
  run(ctx: CommandContext, input: z.infer<z.ZodObject<S>>): Promise<unknown>;
  /** Optional live mode, CLI only (e.g. `logs --follow`). */
  stream?(ctx: CommandContext, input: z.infer<z.ZodObject<S>>): AsyncIterable<unknown>;
  /** Snapshot commands that make sense to refresh with `--watch`. */
  watchable?: boolean;
  /** Exclude from MCP (e.g. needs an interactive terminal). */
  cliOnly?: boolean;
}

function define<S extends z.ZodRawShape>(definition: CommandDefinition<S>): CommandDefinition {
  return definition as unknown as CommandDefinition;
}

/* Shared field schemas */
const deviceId = z.string().min(1).optional().describe('Device id from device_list; optional when exactly one device is connected');
const secret = z.string().min(MIN_SECRET_LENGTH).describe(`Encryption secret provided by the user (min ${MIN_SECRET_LENGTH} chars). Never invent one`);
const confirm = z.boolean().optional().describe('Must be true to perform this change. Ask the user first');
const devicePath = () => z.string().min(1).describe('Absolute path on the device');
const optionalDevicePath = (fallback: string) => z.string().min(1).optional().describe(`Absolute path on the device (default ${fallback})`);
const count = (what: string, max: number) => z.coerce.number().int().positive().max(max).optional().describe(what);
const manifestPath = z.string().min(1).describe('Path to a <job>.androidbackup.manifest.json file');
const logFilter = {
  deviceId,
  minLevel: z.enum(LOG_LEVELS as [string, ...string[]]).optional().describe('Minimum level: V D I W E F'),
  tag: z.string().optional().describe('Exact log tag'),
  search: z.string().optional().describe('Case-insensitive text in tag or message'),
  pid: z.coerce.number().int().nonnegative().optional().describe('Only this process id')
};
type LogFilterInput = { deviceId?: string; minLevel?: string; tag?: string; search?: string; pid?: number };
const toFilter = (i: LogFilterInput) => ({ ...i, minLevel: i.minLevel as (typeof LOG_LEVELS)[number] | undefined });

export const CATALOG: CommandDefinition[] = [
  /* Devices */
  define({
    id: 'device_list', path: ['devices'], group: 'Devices', safety: 'read', watchable: true,
    summary: 'List connected devices with state, capabilities and limitations',
    input: {},
    run: ctx => ctx.useCases.listDevices.execute()
  }),
  define({
    id: 'device_capabilities', path: ['info'], group: 'Devices', safety: 'read',
    summary: 'Show one device and what it can do',
    input: { deviceId },
    run: (ctx, i) => ctx.useCases.inspectDevice.execute(i.deviceId)
  }),
  define({
    id: 'device_diagnose', path: ['diagnose'], group: 'Devices', safety: 'read',
    summary: 'Android version, patch level, boot/encryption state',
    input: { deviceId },
    run: (ctx, i) => ctx.useCases.diagnoseDevice.execute(i.deviceId)
  }),
  define({
    id: 'device_vitals', path: ['monitor'], group: 'Devices', safety: 'read', watchable: true,
    summary: 'Battery, temperature, CPU, RAM and storage health',
    description: 'Sample device vitals and get findings (overheating, memory pressure, I/O-bound load). Call repeatedly to monitor.',
    input: { deviceId },
    run: (ctx, i) => ctx.useCases.getVitals.execute(i)
  }),
  define({
    id: 'device_screenshot', path: ['screenshot'], group: 'Devices', safety: 'write',
    summary: 'Save a PNG screenshot to the local disk',
    input: { deviceId, output: z.string().min(1).optional().describe('Local file to create (default ./screenshot-<device>-<time>.png)') },
    positional: ['output'],
    run: (ctx, i) => ctx.useCases.takeScreenshot.execute(i)
  }),
  define({
    id: 'doctor', path: ['doctor'], group: 'Devices', safety: 'read',
    summary: 'Check adb/fastboot/scrcpy installation and device connectivity',
    input: {},
    run: ctx => ctx.useCases.runDoctor.execute()
  }),

  /* Storage */
  define({
    id: 'storage_analyze', path: ['storage', 'analyze'], group: 'Storage', safety: 'read',
    summary: 'Explain where storage goes: categories, top apps and findings',
    description: 'Analyse internal storage: volume usage, Android category breakdown, apps ranked by size and actionable findings. Start here for any "storage full" problem.',
    input: { deviceId, top: count('How many apps to rank (default 10)', 200) },
    run: (ctx, i) => ctx.useCases.analyzeStorage.execute(i)
  }),
  define({
    id: 'storage_largest', path: ['storage', 'largest'], group: 'Storage', safety: 'read',
    summary: 'Largest files and folders under a path (shared storage)',
    input: { deviceId, path: optionalDevicePath('/sdcard'), limit: count('Entries per kind (default 20)', 500) },
    positional: ['path'],
    run: (ctx, i) => ctx.useCases.findLargestFiles.execute(i)
  }),
  define({
    id: 'storage_trim_caches', path: ['storage', 'trim-caches'], group: 'Storage', safety: 'destructive',
    summary: 'Ask Android to drop all app caches (no user data is deleted)',
    input: { deviceId, confirm },
    run: (ctx, i) => ctx.useCases.trimCaches.execute(i)
  }),

  /* Apps */
  define({
    id: 'apps_list', path: ['apps', 'list'], group: 'Apps', safety: 'read',
    summary: 'Installed packages (user apps by default)',
    input: {
      deviceId,
      includeSystem: z.boolean().optional().describe('Include system packages'),
      search: z.string().optional().describe('Substring of the package name')
    },
    positional: ['search'],
    run: (ctx, i) => ctx.useCases.listApps.execute(i)
  }),
  define({
    id: 'app_info', path: ['apps', 'info'], group: 'Apps', safety: 'read',
    summary: 'Version, installer, SDK, permissions and storage of a package',
    input: { deviceId, packageName: z.string().min(1).describe('Package name, e.g. com.example.app') },
    positional: ['packageName'],
    run: (ctx, i) => ctx.useCases.getAppInfo.execute(i)
  }),

  /* Files */
  define({
    id: 'files_list', path: ['files', 'ls'], group: 'Files', safety: 'read',
    summary: 'List a device directory',
    input: { deviceId, path: optionalDevicePath('/sdcard') },
    positional: ['path'],
    run: (ctx, i) => ctx.useCases.listFiles.execute(i)
  }),
  define({
    id: 'files_pull', path: ['files', 'pull'], group: 'Files', safety: 'write',
    summary: 'Copy a device file to the PC (never overwrites)',
    input: { deviceId, path: devicePath(), output: z.string().min(1).optional().describe('Local destination (default: same file name in the current folder)') },
    positional: ['path', 'output'],
    run: (ctx, i) => ctx.useCases.pullFile.execute({ ...i, output: i.output ?? i.path.split('/').pop() ?? 'pulled.bin' }, ctx.onProgress)
  }),
  define({
    id: 'files_push', path: ['files', 'push'], group: 'Files', safety: 'write',
    summary: 'Copy a local file to the device (asks before overwriting)',
    input: { deviceId, localPath: z.string().min(1).describe('Local file'), path: devicePath(), confirm },
    positional: ['localPath', 'path'],
    run: (ctx, i) => ctx.useCases.pushFile.execute(i)
  }),

  /* Logs */
  define({
    id: 'logs_read', path: ['logs'], group: 'Logs', safety: 'read',
    summary: 'Recent logcat entries with level/tag/text filters (--follow to stream)',
    input: { ...logFilter, lines: count('Entries to return (default 200)', 10_000) },
    run: (ctx, i) => ctx.useCases.readLogs.execute({ ...toFilter(i), lines: i.lines }),
    stream: (ctx, i) => ctx.useCases.followLogs.execute(toFilter(i))
  }),

  /* Backups */
  define({
    id: 'backup_start', path: ['backup', 'create'], group: 'Backups', safety: 'write',
    summary: 'Encrypted, block-verified backup of a device path',
    description: 'Archive a device path (file or directory) over ADB into an encrypted, block-verified local backup. Blocks until finished.',
    input: { deviceId, source: optionalDevicePath('/sdcard'), destination: z.string().min(1).optional().describe('Local directory (default ./backups)'), secret },
    run: (ctx, i) => ctx.useCases.createBackup.execute(
      { deviceId: i.deviceId ?? '', source: i.source ?? '/sdcard', destination: i.destination ?? './backups', secret: i.secret },
      ctx.onProgress
    )
  }),
  define({
    id: 'backup_status', path: ['backup', 'status'], group: 'Backups', safety: 'read',
    summary: 'Status of a backup job',
    input: { job: z.string().uuid().describe('Job id') },
    positional: ['job'],
    run: (ctx, i) => ctx.useCases.getBackupStatus.execute(i.job)
  }),
  define({
    id: 'backup_verify', path: ['backup', 'verify'], group: 'Backups', safety: 'read',
    summary: 'Decrypt and check every block of a backup',
    description: 'Decrypt and check every block of a backup against its manifest. Run before reporting a backup as good.',
    input: { manifest: manifestPath, secret },
    positional: ['manifest'],
    run: (ctx, i) => ctx.useCases.verifyBackup.execute({ manifestPath: i.manifest, secret: i.secret })
  }),
  define({
    id: 'backup_export', path: ['backup', 'export'], group: 'Backups', safety: 'write',
    summary: 'Decrypt a verified backup into a local .tar',
    input: { manifest: manifestPath, output: z.string().min(1).describe('Local .tar file to create'), secret },
    positional: ['manifest', 'output'],
    run: (ctx, i) => ctx.useCases.exportBackup.execute({ manifestPath: i.manifest, outputPath: i.output, secret: i.secret })
  }),
  /* Network */
  define({
    id: 'net_status', path: ['net', 'status'], group: 'Network', safety: 'read', watchable: true,
    summary: 'Interfaces, gateway, Wi-Fi signal, DNS, VPN and apps listening on the network',
    input: { deviceId },
    run: (ctx, i) => ctx.useCases.networkStatus.execute(i)
  }),
  define({
    id: 'net_ping', path: ['net', 'ping'], group: 'Network', safety: 'read',
    summary: 'Ping a host from the device',
    input: { deviceId, host: z.string().min(1).describe('Hostname or IP'), count: count('Packets (default 4)', 20) },
    positional: ['host'],
    run: (ctx, i) => ctx.useCases.ping.execute(i)
  }),
  define({
    id: 'net_wifi', path: ['net', 'wifi'], group: 'Network', safety: 'write',
    summary: 'Turn Wi-Fi on or off (off needs confirmation)',
    input: { deviceId, state: z.enum(['on', 'off']).describe('on | off'), confirm },
    positional: ['state'],
    run: (ctx, i) => ctx.useCases.setWifi.execute({ deviceId: i.deviceId, enabled: i.state === 'on', confirm: i.confirm })
  }),
  define({
    id: 'wireless_enable', path: ['wireless', 'enable'], group: 'Network', safety: 'write',
    summary: 'Switch a USB-connected device to wireless adb and connect to it',
    input: { deviceId, port: count('TCP port (default 5555)', 65535) },
    run: (ctx, i) => ctx.useCases.wireless.enable(i)
  }),
  define({
    id: 'wireless_pair', path: ['wireless', 'pair'], group: 'Network', safety: 'write',
    summary: 'Pair with Android 11+ wireless debugging (host:port and 6-digit code)',
    input: {
      endpoint: z.string().min(3).describe('Pairing host:port from Settings > Wireless debugging'),
      code: z.string().length(6).describe('6-digit pairing code')
    },
    positional: ['endpoint', 'code'],
    run: (ctx, i) => ctx.useCases.wireless.pair(i)
  }),
  define({
    id: 'wireless_connect', path: ['wireless', 'connect'], group: 'Network', safety: 'write',
    summary: 'Connect to a device over Wi-Fi',
    input: { endpoint: z.string().min(3).describe('host:port') },
    positional: ['endpoint'],
    run: (ctx, i) => ctx.useCases.wireless.connect(i)
  }),
  define({
    id: 'wireless_disconnect', path: ['wireless', 'disconnect'], group: 'Network', safety: 'write',
    summary: 'Disconnect one wireless device (or all)',
    input: { endpoint: z.string().min(3).optional().describe('host:port; omit to disconnect all') },
    positional: ['endpoint'],
    run: (ctx, i) => ctx.useCases.wireless.disconnect(i)
  }),
  define({
    id: 'wireless_discover', path: ['wireless', 'discover'], group: 'Network', safety: 'read',
    summary: 'Find devices advertising wireless debugging via mDNS',
    input: {},
    run: ctx => ctx.useCases.wireless.discover()
  }),
  define({
    id: 'ports_list', path: ['ports', 'list'], group: 'Network', safety: 'read',
    summary: 'Active adb forward/reverse port mappings',
    input: { deviceId },
    run: (ctx, i) => ctx.useCases.portMappings.list(i)
  }),
  define({
    id: 'ports_reverse', path: ['ports', 'reverse'], group: 'Network', safety: 'write',
    summary: 'Expose a PC port to the phone (e.g. a dev server: ports reverse 3000)',
    input: { deviceId, host: z.string().min(1).describe('PC side: port or tcp:<port>'), device: z.string().min(1).optional().describe('Phone side (default: same as host)') },
    positional: ['host', 'device'],
    run: (ctx, i) => ctx.useCases.portMappings.add({ ...i, kind: 'reverse' })
  }),
  define({
    id: 'ports_forward', path: ['ports', 'forward'], group: 'Network', safety: 'write',
    summary: 'Expose a phone port on the PC (e.g. a debug server)',
    input: { deviceId, host: z.string().min(1).describe('PC side: port or tcp:<port>'), device: z.string().min(1).optional().describe('Phone side (default: same as host)') },
    positional: ['host', 'device'],
    run: (ctx, i) => ctx.useCases.portMappings.add({ ...i, kind: 'forward' })
  }),
  define({
    id: 'ports_remove', path: ['ports', 'remove'], group: 'Network', safety: 'write',
    summary: 'Remove a forward (PC side spec) or reverse (phone side spec)',
    input: { deviceId, kind: z.enum(['forward', 'reverse']).describe('forward | reverse'), spec: z.string().min(1).describe('Port or socket spec') },
    positional: ['kind', 'spec'],
    run: (ctx, i) => ctx.useCases.portMappings.remove(i)
  }),

  /* Security */
  define({
    id: 'perms_audit', path: ['perms', 'audit'], group: 'Security', safety: 'read',
    summary: 'Rank apps by sensitive permissions and special access',
    description: 'Audit runtime permissions and special accesses (accessibility, notification access, device admin, overlay, install unknown apps). Returns apps ranked by risk with reasons.',
    input: { deviceId, includeSystem: z.boolean().optional().describe('Include system apps'), top: count('Apps to return (default 25)', 500) },
    run: (ctx, i) => ctx.useCases.auditPermissions.execute(i)
  }),
  define({
    id: 'perms_show', path: ['perms', 'show'], group: 'Security', safety: 'read',
    summary: 'Granted permissions and special access of one app',
    input: { deviceId, packageName: z.string().min(1).describe('Package name') },
    positional: ['packageName'],
    run: (ctx, i) => ctx.useCases.appPermissions.execute(i)
  }),
  define({
    id: 'perms_revoke', path: ['perms', 'revoke'], group: 'Security', safety: 'write',
    summary: 'Revoke a runtime permission (CAMERA or android.permission.CAMERA)',
    input: { deviceId, packageName: z.string().min(1).describe('Package name'), permission: z.string().min(1).describe('Permission'), confirm },
    positional: ['packageName', 'permission'],
    run: (ctx, i) => ctx.useCases.setPermission.execute({ ...i, grant: false })
  }),
  define({
    id: 'perms_grant', path: ['perms', 'grant'], group: 'Security', safety: 'write',
    summary: 'Grant a runtime permission to an app',
    input: { deviceId, packageName: z.string().min(1).describe('Package name'), permission: z.string().min(1).describe('Permission'), confirm },
    positional: ['packageName', 'permission'],
    run: (ctx, i) => ctx.useCases.setPermission.execute({ ...i, grant: true })
  }),
  define({
    id: 'audit_log', path: ['audit'], group: 'Security', safety: 'read',
    summary: 'Recent state-changing operations performed by androidctl',
    input: { limit: count('Entries (default 50)', 1000) },
    run: (ctx, i) => ctx.useCases.auditLog.execute(i)
  }),

  /* Processes and app management */
  define({
    id: 'ps', path: ['ps'], group: 'Apps', safety: 'read', watchable: true,
    summary: 'Top processes by CPU or memory',
    input: {
      deviceId, sort: z.enum(['cpu', 'mem']).optional().describe('cpu | mem (default cpu)'),
      limit: count('Rows (default 25)', 1000), search: z.string().optional().describe('Filter by name')
    },
    positional: ['search'],
    run: (ctx, i) => ctx.useCases.processes.execute(i)
  }),
  define({
    id: 'apps_install', path: ['apps', 'install'], group: 'Apps', safety: 'write',
    summary: 'Install an APK (comma-separated files = split APKs)',
    input: {
      deviceId, apk: z.string().min(1).describe('Path to the .apk (comma-separated for splits)'),
      grantAll: z.boolean().optional().describe('Grant all runtime permissions'), downgrade: z.boolean().optional().describe('Allow version downgrade')
    },
    positional: ['apk'],
    run: (ctx, i) => ctx.useCases.apps.install({ deviceId: i.deviceId, apks: i.apk.split(',').map(s => s.trim()).filter(Boolean), grantAll: i.grantAll, downgrade: i.downgrade })
  }),
  define({
    id: 'apps_uninstall', path: ['apps', 'uninstall'], group: 'Apps', safety: 'destructive',
    summary: 'Uninstall an app (system apps: removed for the user, restorable)',
    input: { deviceId, packageName: z.string().min(1).describe('Package name'), keepData: z.boolean().optional().describe('Keep data and cache'), confirm },
    positional: ['packageName'],
    run: (ctx, i) => ctx.useCases.apps.uninstall(i)
  }),
  define({
    id: 'apps_restore', path: ['apps', 'restore'], group: 'Apps', safety: 'write',
    summary: 'Re-enable a system app removed with apps uninstall',
    input: { deviceId, packageName: z.string().min(1).describe('Package name') },
    positional: ['packageName'],
    run: (ctx, i) => ctx.useCases.apps.restore(i)
  }),
  define({
    id: 'apps_launch', path: ['apps', 'launch'], group: 'Apps', safety: 'write',
    summary: 'Start the launcher activity of an app',
    input: { deviceId, packageName: z.string().min(1).describe('Package name') },
    positional: ['packageName'],
    run: (ctx, i) => ctx.useCases.apps.launch(i)
  }),
  define({
    id: 'apps_stop', path: ['apps', 'stop'], group: 'Apps', safety: 'write',
    summary: 'Force-stop an app',
    input: { deviceId, packageName: z.string().min(1).describe('Package name') },
    positional: ['packageName'],
    run: (ctx, i) => ctx.useCases.apps.stop(i)
  }),
  define({
    id: 'apps_clear', path: ['apps', 'clear'], group: 'Apps', safety: 'destructive',
    summary: 'Delete all data of an app (irreversible)',
    input: { deviceId, packageName: z.string().min(1).describe('Package name'), confirm },
    positional: ['packageName'],
    run: (ctx, i) => ctx.useCases.apps.clearData(i)
  }),

  /* Shell */
  define({
    id: 'shell_exec', path: ['shell'], group: 'Shell', safety: 'write',
    summary: 'Run a device shell command (read-only commands run directly; others need confirmation)',
    description: 'Run a shell command on the device. Read-only commands (getprop, dumpsys, ls, cat...) run directly; anything that may change state requires confirm: true; commands that can wipe or brick the device are always refused. Output is capped at 256 KB.',
    input: {
      deviceId, command: z.string().min(1).describe('Command line, e.g. "dumpsys battery"'),
      timeoutSeconds: count('Timeout (default 60, max 600)', 600), asRoot: z.boolean().optional().describe('Run through su (rooted devices)'), confirm
    },
    positional: ['command'], variadic: true,
    run: (ctx, i) => ctx.useCases.shell.execute(i)
  }),

  /* Headless control */
  define({
    id: 'screen_status', path: ['screen', 'status'], group: 'Headless', safety: 'read',
    summary: 'Awake/locked state, resolution, density, timeout',
    input: { deviceId },
    run: (ctx, i) => ctx.useCases.headless.state(i)
  }),
  define({
    id: 'screen_wake', path: ['screen', 'wake'], group: 'Headless', safety: 'write',
    summary: 'Wake the device and dismiss a swipe-only keyguard',
    input: { deviceId },
    run: (ctx, i) => ctx.useCases.headless.wake(i)
  }),
  define({
    id: 'screen_stay_awake', path: ['screen', 'stay-awake'], group: 'Headless', safety: 'write',
    summary: 'Keep the screen on while powered (on/off)',
    input: { deviceId, state: z.enum(['on', 'off']).describe('on | off') },
    positional: ['state'],
    run: (ctx, i) => ctx.useCases.headless.stayAwake({ deviceId: i.deviceId, enabled: i.state === 'on' })
  }),
  define({
    id: 'screen_timeout', path: ['screen', 'timeout'], group: 'Headless', safety: 'write',
    summary: 'Set the screen-off timeout in seconds',
    input: { deviceId, seconds: z.coerce.number().int().describe('10-86400') },
    positional: ['seconds'],
    run: (ctx, i) => ctx.useCases.headless.screenTimeout(i)
  }),
  define({
    id: 'screen_record', path: ['screen', 'record'], group: 'Headless', safety: 'write',
    summary: 'Record the screen to a local MP4 (max 180 s)',
    input: { deviceId, seconds: count('Length (default 15)', 180), output: z.string().min(1).optional().describe('Local .mp4 to create') },
    positional: ['output'],
    run: (ctx, i) => ctx.useCases.headless.record(i)
  }),
  define({
    id: 'input_key', path: ['input', 'key'], group: 'Headless', safety: 'write',
    summary: 'Press a key (home, back, enter, power, wakeup, volume-up...)',
    input: { deviceId, key: z.string().min(1).describe('Key name or numeric keycode'), longPress: z.boolean().optional().describe('Long press') },
    positional: ['key'],
    run: (ctx, i) => ctx.useCases.headless.key(i)
  }),
  define({
    id: 'input_tap', path: ['input', 'tap'], group: 'Headless', safety: 'write',
    summary: 'Tap screen coordinates',
    input: { deviceId, x: z.coerce.number().int().nonnegative().describe('X in pixels'), y: z.coerce.number().int().nonnegative().describe('Y in pixels') },
    positional: ['x', 'y'],
    run: (ctx, i) => ctx.useCases.headless.tap(i)
  }),
  define({
    id: 'input_swipe', path: ['input', 'swipe'], group: 'Headless', safety: 'write',
    summary: 'Swipe up/down/left/right across the screen',
    input: { deviceId, direction: z.enum(['up', 'down', 'left', 'right']).describe('Direction'), durationMs: count('Duration (default 300)', 5000) },
    positional: ['direction'],
    run: (ctx, i) => ctx.useCases.headless.swipe(i)
  }),
  define({
    id: 'input_text', path: ['input', 'text'], group: 'Headless', safety: 'write',
    summary: 'Type text into the focused field (printable ASCII)',
    input: { deviceId, text: z.string().min(1).max(1000).describe('Text to type') },
    positional: ['text'],
    run: (ctx, i) => ctx.useCases.headless.type(i)
  }),
  define({
    id: 'ui_dump', path: ['ui', 'dump'], group: 'Headless', safety: 'read',
    summary: 'Read the on-screen UI as a list of elements (works with a broken display)',
    description: 'Dump the current UI hierarchy via uiautomator: text, resource id, content description, bounds and state of each element. Use with ui_tap to operate a device whose screen cannot be seen.',
    input: { deviceId, search: z.string().optional().describe('Only elements whose text/id/description contains this'), all: z.boolean().optional().describe('Include layout-only nodes') },
    positional: ['search'],
    run: (ctx, i) => ctx.useCases.headless.dumpUi(i)
  }),
  define({
    id: 'ui_tap', path: ['ui', 'tap'], group: 'Headless', safety: 'write',
    summary: 'Tap an element by text, resource id or description',
    input: {
      deviceId, text: z.string().optional().describe('Visible text'), id: z.string().optional().describe('Resource id (full or short)'),
      desc: z.string().optional().describe('Content description'), contains: z.boolean().optional().describe('Substring match'),
      index: z.coerce.number().int().nonnegative().optional().describe('Which match (default 0)'), longPress: z.boolean().optional().describe('Long press')
    },
    run: (ctx, i) => ctx.useCases.headless.tapElement(i)
  }),
  define({
    id: 'ui_wait', path: ['ui', 'wait'], group: 'Headless', safety: 'read',
    summary: 'Wait until an element appears (or disappears with --gone)',
    input: {
      deviceId, text: z.string().optional().describe('Visible text'), id: z.string().optional().describe('Resource id'),
      desc: z.string().optional().describe('Content description'), contains: z.boolean().optional().describe('Substring match'),
      gone: z.boolean().optional().describe('Wait for it to disappear'), timeoutSeconds: count('Timeout (default 10)', 300)
    },
    run: (ctx, i) => ctx.useCases.headless.waitFor(i)
  }),
  define({
    id: 'mirror', path: ['mirror'], group: 'Headless', safety: 'write', cliOnly: true,
    summary: 'Mirror and control the device with scrcpy',
    input: {
      deviceId, otg: z.boolean().optional().describe('scrcpy OTG mode: act as USB keyboard/mouse'),
      turnScreenOff: z.boolean().optional().describe('Keep the phone display off while mirroring'),
      noAudio: z.boolean().optional().describe('Do not forward audio'), readOnly: z.boolean().optional().describe('View only'),
      record: z.string().optional().describe('Also record to this local file')
    },
    run: (ctx, i) => ctx.useCases.mirror.execute(i)
  }),
  define({
    id: 'reboot', path: ['reboot'], group: 'Headless', safety: 'destructive',
    summary: 'Reboot into system, recovery, bootloader or sideload',
    input: { deviceId, target: z.enum(['system', 'recovery', 'bootloader', 'sideload']).optional().describe('Default system'), confirm },
    positional: ['target'],
    run: (ctx, i) => ctx.useCases.headless.reboot(i)
  }),

  /* Automation */
  define({
    id: 'health_report', path: ['report'], group: 'Devices', safety: 'read',
    summary: 'Full health report (device, vitals, storage, network, permissions) with a score',
    description: 'Run every read-only probe and return one report with an overall health score (0-100), grade and all findings ranked by severity. The CLI can save it as HTML or Markdown with --output.',
    input: { deviceId, output: z.string().min(1).optional().describe('CLI only: save as .html or .md') },
    positional: ['output'],
    run: (ctx, i) => ctx.useCases.healthReport.execute({ deviceId: i.deviceId })
  })
];

export function findCommand(words: string[]): { command: CommandDefinition; rest: string[] } | undefined {
  const matches = CATALOG
    .filter(c => c.path.every((w, i) => words[i] === w))
    .sort((a, b) => b.path.length - a.path.length);
  const command = matches[0];
  return command ? { command, rest: words.slice(command.path.length) } : undefined;
}
