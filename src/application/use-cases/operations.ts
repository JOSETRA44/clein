import {
  assertCoordinate, assertSelector, assertTypeableText, centerOf, healthScore, matchElements, mergeFindings, resolveKeycode,
  sortProcesses, type ProcessInfo, type ProcessSort, type RebootTarget, type ScreenState, type UiElement, type UiSelector
} from '../../domain/control.js';
import { assertConfirmed, AppError, DeviceUnavailableError, NotFoundError, ValidationError } from '../../domain/errors.js';
import type { Finding } from '../../domain/findings.js';
import { assertPackageName } from '../../domain/inspection.js';
import {
  assertEndpoint, assertHost, assertSocketSpec, assessNetwork, type ListeningSocket, type NetworkStatus, type PingResult, type PortMapping
} from '../../domain/network.js';
import { assertPermissionName, assessPermissions, normalisePermission, scoreApp, type AppRisk } from '../../domain/permissions.js';
import { assessShellCommand, type CommandAssessment } from '../../domain/shell-policy.js';
import { requireCapability } from '../device-lookup.js';
import type {
  AdbHost, AppCatalog, AppManager, AuditEntry, AuditLog, DeviceGateway, DeviceInput, MirrorLauncher, NetworkProbe, PermissionProbe,
  ProcessProbe, ScreenControl, ShellResult, ShellRunner, UiInspector
} from '../ports.js';
import type { AnalyzeStorage, GetVitals } from './toolkit.js';
import type { DiagnoseDevice } from './device-queries.js';

const shellDevice = (devices: DeviceGateway, deviceId?: string) => requireCapability(devices, deviceId, 'shell');

/* ── Network ─────────────────────────────────────────────────────────── */

export interface NetworkReport {
  deviceId: string;
  status: NetworkStatus;
  listening: ListeningSocket[];
  findings: Finding[];
}

async function ownersByUid(apps: AppCatalog, deviceId: string): Promise<Map<number, string>> {
  const list = await apps.list(deviceId).catch(() => []);
  return new Map(list.filter(a => a.uid !== undefined).map(a => [a.uid!, a.packageName]));
}

export class GetNetworkStatus {
  constructor(private readonly devices: DeviceGateway, private readonly network: NetworkProbe, private readonly apps: AppCatalog) {}

  async execute(input: { deviceId?: string }): Promise<NetworkReport> {
    const device = await shellDevice(this.devices, input.deviceId);
    const [status, sockets, owners] = await Promise.all([
      this.network.status(device.id),
      this.network.listeningSockets(device.id).catch(() => []),
      ownersByUid(this.apps, device.id)
    ]);
    const listening = sockets.map(s => ({ ...s, owner: owners.get(s.uid) ?? (s.uid < 10000 ? 'system' : undefined) }));
    return { deviceId: device.id, status, listening, findings: assessNetwork(status, listening) };
  }
}

export class PingHost {
  constructor(private readonly devices: DeviceGateway, private readonly network: NetworkProbe) {}

  async execute(input: { deviceId?: string; host: string; count?: number }): Promise<PingResult & { deviceId: string }> {
    assertHost(input.host);
    const device = await shellDevice(this.devices, input.deviceId);
    return { deviceId: device.id, ...(await this.network.ping(device.id, input.host, input.count ?? 4)) };
  }
}

export class SetWifi {
  constructor(private readonly devices: DeviceGateway, private readonly network: NetworkProbe) {}

  async execute(input: { deviceId?: string; enabled: boolean; confirm?: boolean }) {
    const device = await shellDevice(this.devices, input.deviceId);
    // Turning Wi-Fi off can cut a wireless adb session, so it needs confirmation; turning it on does not.
    if (!input.enabled) assertConfirmed(input.confirm, 'Disabling Wi-Fi');
    await this.network.setWifi(device.id, input.enabled);
    return { deviceId: device.id, wifiEnabled: input.enabled };
  }
}

export class ManageWirelessAdb {
  constructor(private readonly devices: DeviceGateway, private readonly host: AdbHost, private readonly network: NetworkProbe) {}

  async pair(input: { endpoint: string; code: string }) {
    assertEndpoint(input.endpoint);
    if (!/^\d{6}$/.test(input.code)) throw new ValidationError('The pairing code is the 6-digit number shown under "Pair device with pairing code"');
    return { endpoint: input.endpoint, message: await this.host.pair(input.endpoint, input.code) };
  }

  async connect(input: { endpoint: string }) {
    assertEndpoint(input.endpoint);
    return { endpoint: input.endpoint, message: await this.host.connect(input.endpoint) };
  }

  async disconnect(input: { endpoint?: string }) {
    if (input.endpoint) assertEndpoint(input.endpoint);
    return { message: await this.host.disconnect(input.endpoint) };
  }

  discover() {
    return this.host.discover().then(services => ({ services }));
  }

  /** USB → Wi-Fi handover: switch adbd to TCP, find the device IP and connect to it. */
  async enable(input: { deviceId?: string; port?: number }) {
    const port = input.port ?? 5555;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ValidationError('Port must be between 1024 and 65535');
    const device = await shellDevice(this.devices, input.deviceId);
    const status = await this.network.status(device.id);
    const wlan = status.interfaces.find(i => i.name.startsWith('wlan'))?.addresses.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    if (!wlan) throw new DeviceUnavailableError('The device has no Wi-Fi IPv4 address; connect it to the same network as this PC first');
    await this.host.enableTcpip(device.id, port);
    const endpoint = `${wlan}:${port}`;
    return { deviceId: device.id, endpoint, message: await this.host.connect(endpoint) };
  }
}

const asSpec = (value: string) => (/^\d+$/.test(value) ? `tcp:${value}` : value);

export class ManagePortMappings {
  constructor(private readonly devices: DeviceGateway, private readonly host: AdbHost) {}

  async list(input: { deviceId?: string }): Promise<{ deviceId: string; mappings: PortMapping[] }> {
    const device = await shellDevice(this.devices, input.deviceId);
    return { deviceId: device.id, mappings: await this.host.listMappings(device.id) };
  }

  /** Bare port numbers are accepted as `tcp:<port>`; `device` defaults to the same port. */
  async add(input: { deviceId?: string; kind: PortMapping['kind']; host: string; device?: string }) {
    const host = asSpec(input.host);
    const deviceSpec = asSpec(input.device ?? input.host);
    assertSocketSpec(host);
    assertSocketSpec(deviceSpec);
    const device = await shellDevice(this.devices, input.deviceId);
    const mapping = { kind: input.kind, deviceId: device.id, host, device: deviceSpec };
    await this.host.addMapping(mapping);
    return mapping;
  }

  async remove(input: { deviceId?: string; kind: PortMapping['kind']; spec: string }) {
    const spec = asSpec(input.spec);
    assertSocketSpec(spec);
    const device = await shellDevice(this.devices, input.deviceId);
    await this.host.removeMapping(device.id, input.kind, spec);
    return { deviceId: device.id, kind: input.kind, removed: spec };
  }
}

/* ── Permissions ─────────────────────────────────────────────────────── */

export class AuditPermissions {
  constructor(private readonly devices: DeviceGateway, private readonly permissions: PermissionProbe) {}

  async execute(input: { deviceId?: string; includeSystem?: boolean; top?: number }): Promise<{ deviceId: string; apps: AppRisk[]; scanned: number; findings: Finding[] }> {
    const device = await requireCapability(this.devices, input.deviceId, 'packages');
    const all = await this.permissions.all(device.id);
    const { ranked, findings } = assessPermissions(all, input);
    return { deviceId: device.id, apps: ranked.slice(0, input.top ?? 25), scanned: all.length, findings };
  }
}

export class GetAppPermissions {
  constructor(private readonly devices: DeviceGateway, private readonly permissions: PermissionProbe) {}

  async execute(input: { deviceId?: string; packageName: string }) {
    assertPackageName(input.packageName);
    const device = await requireCapability(this.devices, input.deviceId, 'packages');
    const app = (await this.permissions.all(device.id)).find(a => a.packageName === input.packageName);
    if (!app) throw new NotFoundError(`Package not installed: ${input.packageName}`);
    return { deviceId: device.id, ...app, risk: scoreApp(app) };
  }
}

export class SetPermission {
  constructor(private readonly devices: DeviceGateway, private readonly permissions: PermissionProbe) {}

  async execute(input: { deviceId?: string; packageName: string; permission: string; grant: boolean; confirm?: boolean }) {
    assertPackageName(input.packageName);
    const permission = normalisePermission(input.permission);
    assertPermissionName(permission);
    const device = await requireCapability(this.devices, input.deviceId, 'packages');
    assertConfirmed(input.confirm, `${input.grant ? 'Granting' : 'Revoking'} ${permission}`);
    await this.permissions.setGranted(device.id, input.packageName, permission, input.grant);
    return { deviceId: device.id, packageName: input.packageName, permission, granted: input.grant };
  }
}

/* ── Processes and app management ────────────────────────────────────── */

export class ListProcesses {
  constructor(private readonly devices: DeviceGateway, private readonly processes: ProcessProbe) {}

  async execute(input: { deviceId?: string; sort?: ProcessSort; limit?: number; search?: string }): Promise<{ deviceId: string; processes: ProcessInfo[] }> {
    const device = await shellDevice(this.devices, input.deviceId);
    const sort = input.sort ?? 'cpu';
    const limit = input.limit ?? 25;
    const needle = input.search?.toLowerCase();
    const raw = await this.processes.snapshot(device.id, needle ? 1000 : limit, sort);
    const filtered = needle ? raw.filter(p => p.name.toLowerCase().includes(needle)) : raw;
    return { deviceId: device.id, processes: sortProcesses(filtered, sort).slice(0, limit) };
  }
}

export class ManageApps {
  constructor(private readonly devices: DeviceGateway, private readonly manager: AppManager, private readonly catalog: AppCatalog) {}

  async install(input: { deviceId?: string; apks: string[]; replace?: boolean; grantAll?: boolean; downgrade?: boolean }) {
    if (!input.apks.length) throw new ValidationError('Give at least one .apk file');
    for (const apk of input.apks) if (!/\.(apk|apks|apex)$/i.test(apk)) throw new ValidationError(`Not an APK: ${apk}`);
    const device = await requireCapability(this.devices, input.deviceId, 'push');
    const message = await this.manager.install(device.id, input.apks, { replace: input.replace ?? true, grantAll: input.grantAll ?? false, downgrade: input.downgrade ?? false });
    return { deviceId: device.id, installed: input.apks, message };
  }

  /**
   * User apps are removed; system apps are only removed for user 0, which is
   * reversible with `apps restore` — the standard "debloat" technique.
   */
  async uninstall(input: { deviceId?: string; packageName: string; keepData?: boolean; confirm?: boolean }) {
    assertPackageName(input.packageName);
    const device = await requireCapability(this.devices, input.deviceId, 'packages');
    const details = await this.catalog.details(device.id, input.packageName);
    if (!details) throw new NotFoundError(`Package not installed: ${input.packageName}`);
    assertConfirmed(input.confirm, `Uninstalling ${input.packageName}${details.kind === 'system' ? ' (system app, for user 0)' : ''}`);
    await this.manager.uninstall(device.id, input.packageName, { keepData: input.keepData ?? false, userOnly: details.kind === 'system' });
    return {
      deviceId: device.id, packageName: input.packageName, kind: details.kind,
      ...(details.kind === 'system' ? { restoreWith: `androidctl apps restore ${input.packageName}` } : {})
    };
  }

  async restore(input: { deviceId?: string; packageName: string }) {
    assertPackageName(input.packageName);
    const device = await requireCapability(this.devices, input.deviceId, 'packages');
    await this.manager.restore(device.id, input.packageName);
    return { deviceId: device.id, packageName: input.packageName, restored: true };
  }

  async launch(input: { deviceId?: string; packageName: string }) {
    assertPackageName(input.packageName);
    const device = await shellDevice(this.devices, input.deviceId);
    await this.manager.launch(device.id, input.packageName);
    return { deviceId: device.id, packageName: input.packageName, launched: true };
  }

  async stop(input: { deviceId?: string; packageName: string }) {
    assertPackageName(input.packageName);
    const device = await shellDevice(this.devices, input.deviceId);
    await this.manager.forceStop(device.id, input.packageName);
    return { deviceId: device.id, packageName: input.packageName, stopped: true };
  }

  async clearData(input: { deviceId?: string; packageName: string; confirm?: boolean }) {
    assertPackageName(input.packageName);
    const device = await shellDevice(this.devices, input.deviceId);
    assertConfirmed(input.confirm, `Deleting ALL data of ${input.packageName} (irreversible)`);
    await this.manager.clearData(device.id, input.packageName);
    return { deviceId: device.id, packageName: input.packageName, cleared: true };
  }
}

/* ── Shell ───────────────────────────────────────────────────────────── */

export const SHELL_LIMITS = { defaultTimeoutSeconds: 60, maxTimeoutSeconds: 600, maxOutputBytes: 256 * 1024 } as const;

export class RunShellCommand {
  constructor(private readonly devices: DeviceGateway, private readonly shell: ShellRunner) {}

  async execute(input: { deviceId?: string; command: string; confirm?: boolean; timeoutSeconds?: number; asRoot?: boolean }): Promise<ShellResult & { deviceId: string; assessment: CommandAssessment }> {
    const command = input.command?.trim();
    if (!command) throw new ValidationError('A command is required');
    if (command.length > 8000) throw new ValidationError('Command is longer than 8000 characters');
    const timeout = input.timeoutSeconds ?? SHELL_LIMITS.defaultTimeoutSeconds;
    if (timeout <= 0 || timeout > SHELL_LIMITS.maxTimeoutSeconds) throw new ValidationError(`Timeout must be 1–${SHELL_LIMITS.maxTimeoutSeconds} seconds`);

    const assessment = assessShellCommand(command);
    if (input.asRoot) assessment.reasons.push('Runs as root');
    if (assessment.risk === 'blocked') throw new AppError('VALIDATION', `Refused: ${assessment.reasons.join('; ')}. androidctl never runs this, even with confirmation`);
    if (assessment.risk === 'write' || input.asRoot) assertConfirmed(input.confirm, `This command (${assessment.reasons[0]})`);

    const device = await shellDevice(this.devices, input.deviceId);
    const result = await this.shell.run(device.id, command, { timeoutMs: timeout * 1000, maxOutputBytes: SHELL_LIMITS.maxOutputBytes, asRoot: input.asRoot ?? false });
    return { deviceId: device.id, assessment, ...result };
  }
}

/* ── Headless control ────────────────────────────────────────────────── */

export class HeadlessControl {
  constructor(
    private readonly devices: DeviceGateway,
    private readonly input: DeviceInput,
    private readonly ui: UiInspector,
    private readonly screen: ScreenControl,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))
  ) {}

  async state(input: { deviceId?: string }): Promise<ScreenState & { deviceId: string }> {
    const device = await shellDevice(this.devices, input.deviceId);
    return { deviceId: device.id, ...(await this.screen.state(device.id)) };
  }

  async key(input: { deviceId?: string; key: string; longPress?: boolean }) {
    const keycode = resolveKeycode(input.key);
    const device = await shellDevice(this.devices, input.deviceId);
    await this.input.key(device.id, keycode, input.longPress);
    return { deviceId: device.id, key: input.key, keycode };
  }

  async tap(input: { deviceId?: string; x: number; y: number }) {
    const device = await shellDevice(this.devices, input.deviceId);
    const screen = await this.screen.state(device.id);
    assertCoordinate(input.x, screen.widthPx, 'x');
    assertCoordinate(input.y, screen.heightPx, 'y');
    await this.input.tap(device.id, input.x, input.y);
    return { deviceId: device.id, x: input.x, y: input.y };
  }

  async swipe(input: { deviceId?: string; direction?: 'up' | 'down' | 'left' | 'right'; from?: [number, number]; to?: [number, number]; durationMs?: number }) {
    const device = await shellDevice(this.devices, input.deviceId);
    const screen = await this.screen.state(device.id);
    const w = screen.widthPx ?? 1080;
    const h = screen.heightPx ?? 1920;
    const presets = {
      up: [[w / 2, h * 0.8], [w / 2, h * 0.25]], down: [[w / 2, h * 0.25], [w / 2, h * 0.8]],
      left: [[w * 0.85, h / 2], [w * 0.15, h / 2]], right: [[w * 0.15, h / 2], [w * 0.85, h / 2]]
    } as const;
    const [from, to] = input.direction ? presets[input.direction] : [input.from, input.to];
    if (!from || !to) throw new ValidationError('Give a direction (up/down/left/right) or both from and to');
    const point = (p: readonly number[]) => ({ x: Math.round(p[0]), y: Math.round(p[1]) });
    for (const p of [from, to]) { assertCoordinate(Math.round(p[0]), screen.widthPx, 'x'); assertCoordinate(Math.round(p[1]), screen.heightPx, 'y'); }
    await this.input.swipe(device.id, point(from), point(to), input.durationMs ?? 300);
    return { deviceId: device.id, from: point(from), to: point(to) };
  }

  async type(input: { deviceId?: string; text: string }) {
    assertTypeableText(input.text);
    const device = await shellDevice(this.devices, input.deviceId);
    await this.input.text(device.id, input.text);
    return { deviceId: device.id, typedCharacters: input.text.length };
  }

  /**
   * Wakes the screen and swipes up to dismiss a swipe-only keyguard. A secure
   * lock (PIN, pattern, biometrics) stays in place: the owner unlocks it, for
   * example through scrcpy.
   */
  async wake(input: { deviceId?: string }) {
    const device = await shellDevice(this.devices, input.deviceId);
    const before = await this.screen.state(device.id);
    if (!before.awake) { await this.input.key(device.id, 224); await this.sleep(400); }
    if (before.locked !== false) {
      const w = before.widthPx ?? 1080, h = before.heightPx ?? 1920;
      await this.input.swipe(device.id, { x: Math.round(w / 2), y: Math.round(h * 0.85) }, { x: Math.round(w / 2), y: Math.round(h * 0.3) }, 250);
      await this.sleep(500);
    }
    const after = await this.screen.state(device.id);
    return { deviceId: device.id, awake: after.awake, locked: after.locked };
  }

  async dumpUi(input: { deviceId?: string; all?: boolean; search?: string }): Promise<{ deviceId: string; elements: UiElement[]; total: number }> {
    const device = await shellDevice(this.devices, input.deviceId);
    const elements = await this.ui.dump(device.id);
    const needle = input.search?.toLowerCase();
    const meaningful = elements.filter(e =>
      (input.all || e.text || e.contentDesc || e.clickable || e.resourceId) &&
      (!needle || [e.text, e.contentDesc, e.resourceId].some(v => v.toLowerCase().includes(needle))));
    return { deviceId: device.id, elements: meaningful, total: elements.length };
  }

  async tapElement(input: { deviceId?: string; index?: number; longPress?: boolean } & UiSelector) {
    assertSelector(input);
    const device = await shellDevice(this.devices, input.deviceId);
    const matches = matchElements(await this.ui.dump(device.id), input);
    const element = matches[input.index ?? 0];
    if (!element) throw new NotFoundError(`No element matches ${describeSelector(input)}${matches.length ? ` at index ${input.index}` : ''}`);
    const { x, y } = centerOf(element);
    if (input.longPress) await this.input.swipe(device.id, { x, y }, { x, y }, 800);
    else await this.input.tap(device.id, x, y);
    return { deviceId: device.id, tapped: { x, y }, element, alternatives: matches.length - 1 };
  }

  async waitFor(input: { deviceId?: string; timeoutSeconds?: number; gone?: boolean } & UiSelector) {
    assertSelector(input);
    const device = await shellDevice(this.devices, input.deviceId);
    const deadline = Date.now() + (input.timeoutSeconds ?? 10) * 1000;
    for (let attempt = 1; ; attempt++) {
      const present = matchElements(await this.ui.dump(device.id), input).length > 0;
      if (present !== Boolean(input.gone)) return { deviceId: device.id, satisfied: true, attempts: attempt };
      if (Date.now() >= deadline) throw new NotFoundError(`Timed out waiting for ${describeSelector(input)} to ${input.gone ? 'disappear' : 'appear'}`);
      await this.sleep(700);
    }
  }

  async stayAwake(input: { deviceId?: string; enabled: boolean }) {
    const device = await shellDevice(this.devices, input.deviceId);
    await this.screen.setStayAwake(device.id, input.enabled);
    return { deviceId: device.id, stayAwake: input.enabled };
  }

  async screenTimeout(input: { deviceId?: string; seconds: number }) {
    if (!Number.isInteger(input.seconds) || input.seconds < 10 || input.seconds > 86_400) throw new ValidationError('Timeout must be 10–86400 seconds');
    const device = await shellDevice(this.devices, input.deviceId);
    await this.screen.setScreenTimeout(device.id, input.seconds * 1000);
    return { deviceId: device.id, screenOffTimeoutSeconds: input.seconds };
  }

  async record(input: { deviceId?: string; seconds?: number; output?: string }, now: Date = new Date()) {
    const seconds = input.seconds ?? 15;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 180) throw new ValidationError('Recording length must be 1–180 seconds (Android limit)');
    const device = await shellDevice(this.devices, input.deviceId);
    const output = input.output ?? `screenrecord-${device.id}-${now.toISOString().replace(/[:.]/g, '-')}.mp4`;
    return { deviceId: device.id, seconds, localPath: await this.screen.record(device.id, output, seconds) };
  }

  async reboot(input: { deviceId?: string; target?: RebootTarget; confirm?: boolean }) {
    const target = input.target ?? 'system';
    const device = await shellDevice(this.devices, input.deviceId);
    assertConfirmed(input.confirm, `Rebooting into ${target}`);
    await this.screen.reboot(device.id, target);
    return { deviceId: device.id, target, rebooting: true };
  }
}

function describeSelector(s: UiSelector): string {
  return [s.text && `text "${s.text}"`, s.id && `id "${s.id}"`, s.desc && `description "${s.desc}"`].filter(Boolean).join(' and ');
}

export class LaunchMirror {
  constructor(private readonly devices: DeviceGateway, private readonly mirror: MirrorLauncher) {}

  async execute(input: { deviceId?: string; otg?: boolean; turnScreenOff?: boolean; stayAwake?: boolean; record?: string; noAudio?: boolean; readOnly?: boolean }) {
    // OTG mode drives the phone as a USB keyboard/mouse and works without adb authorisation.
    const deviceId = input.otg ? input.deviceId : (await shellDevice(this.devices, input.deviceId)).id;
    return this.mirror.launch({
      deviceId, otg: input.otg ?? false, turnScreenOff: input.turnScreenOff ?? false, stayAwake: input.stayAwake ?? true,
      record: input.record, noAudio: input.noAudio ?? false, readOnly: input.readOnly ?? false
    });
  }
}

/* ── Automation ──────────────────────────────────────────────────────── */

export interface HealthReport {
  generatedAt: string;
  deviceId: string;
  score: number;
  grade: string;
  sections: Record<string, unknown>;
  errors: Record<string, string>;
  findings: (Finding & { section: string })[];
}

export class BuildHealthReport {
  constructor(private readonly parts: {
    diagnose: Pick<DiagnoseDevice, 'execute'>;
    vitals: Pick<GetVitals, 'execute'>;
    storage: Pick<AnalyzeStorage, 'execute'>;
    network: Pick<GetNetworkStatus, 'execute'>;
    permissions: Pick<AuditPermissions, 'execute'>;
    devices: DeviceGateway;
  }, private readonly clock: () => Date = () => new Date()) {}

  async execute(input: { deviceId?: string }): Promise<HealthReport> {
    const device = await shellDevice(this.parts.devices, input.deviceId);
    const id = { deviceId: device.id };
    const tasks = {
      device: this.parts.diagnose.execute(device.id),
      vitals: this.parts.vitals.execute(id),
      storage: this.parts.storage.execute({ ...id, top: 10 }),
      network: this.parts.network.execute(id),
      permissions: this.parts.permissions.execute({ ...id, top: 10 })
    };
    const sections: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    const groups: { section: string; findings: Finding[] }[] = [];
    // Sections are independent: one failing probe must not hide the others.
    for (const [name, task] of Object.entries(tasks)) {
      try {
        const result = await task as { findings?: Finding[] };
        sections[name] = result;
        if (result.findings) groups.push({ section: name, findings: result.findings });
      } catch (error) {
        errors[name] = error instanceof Error ? error.message : String(error);
      }
    }
    const findings = mergeFindings(...groups);
    return { generatedAt: this.clock().toISOString(), deviceId: device.id, ...healthScore(findings), sections, errors, findings };
  }
}

export class ReadAuditLog {
  constructor(private readonly audit: AuditLog) {}

  async execute(input: { limit?: number }): Promise<{ entries: AuditEntry[] }> {
    return { entries: await this.audit.recent(input.limit ?? 50) };
  }
}
