import crypto from 'node:crypto';
import { ExternalToolError } from '../../domain/errors.js';
import type { ProcessInfo, ProcessSort, RebootTarget, ScreenState, UiElement } from '../../domain/control.js';
import type { ListeningSocket, NetworkStatus, PingResult, PortMapping } from '../../domain/network.js';
import type { AppPermissions } from '../../domain/permissions.js';
import type {
  AdbHost, AppManager, DeviceInput, MirrorLauncher, NetworkProbe, PermissionProbe, ProcessProbe, ScreenControl, ShellResult, ShellRunner, UiInspector
} from '../../application/ports.js';
import { runInteractive } from '../process/command-runner.js';
import { writeNewFile } from '../storage/local-files.js';
import { AdbShell, splitSections } from './adb-shell.js';
import {
  parseMappings, parseMdnsServices, parseNetworkStatus, parsePermissionDump, parsePing, parseProcNet, parseScreenState,
  parseTopProcesses, parseUiHierarchy
} from './ops-parsers.js';
import { shellQuote } from './shell-quote.js';

const tmpName = (ext: string) => `/data/local/tmp/androidctl-${crypto.randomUUID()}.${ext}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class AdbNetworkProbe implements NetworkProbe {
  constructor(private readonly adb: AdbShell) {}

  async status(deviceId: string): Promise<NetworkStatus> {
    const out = await this.adb.text(deviceId, [
      'echo @@ADDR; ip -o addr show 2>/dev/null',
      "echo @@ROUTE; ip route show table all 2>/dev/null | grep '^default'",
      'echo @@WIFI; cmd wifi status 2>/dev/null',
      'echo @@AIRPLANE; settings get global airplane_mode_on',
      'echo @@PDNS; settings get global private_dns_mode; settings get global private_dns_specifier',
      "echo @@CONN; dumpsys connectivity 2>/dev/null | grep -E 'DnsAddresses|VPN|Transports' | head -40",
      'true'
    ].join('; '));
    return parseNetworkStatus(splitSections(out));
  }

  async ping(deviceId: string, host: string, count: number): Promise<PingResult> {
    const n = Math.max(1, Math.min(20, Math.floor(count)));
    const result = await this.adb.exec(deviceId, `ping -c ${n} -W 3 ${shellQuote(host)}`, (n * 4 + 10) * 1000);
    if (result.code > 1 && !/packets transmitted/.test(result.stdout)) {
      throw new ExternalToolError(`ping failed: ${(result.stderr || result.stdout).trim().split('\n')[0]}`);
    }
    return parsePing(host, result.stdout);
  }

  async listeningSockets(deviceId: string): Promise<ListeningSocket[]> {
    const out = await this.adb.text(deviceId, ['tcp', 'tcp6', 'udp', 'udp6'].map(p => `echo @@${p.toUpperCase()}; cat /proc/net/${p} 2>/dev/null`).join('; ') + '; true');
    const s = splitSections(out);
    return (['tcp', 'tcp6', 'udp', 'udp6'] as const).flatMap(p => parseProcNet(p, s[p.toUpperCase()] ?? ''));
  }

  async setWifi(deviceId: string, enabled: boolean): Promise<void> {
    const state = enabled ? 'enabled' : 'disabled';
    await this.adb.text(deviceId, `cmd wifi set-wifi-enabled ${state} 2>/dev/null || svc wifi ${enabled ? 'enable' : 'disable'}`);
  }
}

export class AdbHostControl implements AdbHost {
  constructor(private readonly adb: AdbShell) {}

  private async message(args: string[], ok: RegExp, extra: { input?: string; timeoutMs?: number } = {}): Promise<string> {
    const result = await this.adb.run(args, extra.timeoutMs ?? 30_000, extra.input !== undefined ? { input: extra.input } : {});
    const text = `${result.stdout}\n${result.stderr}`.trim();
    // `adb connect` exits 0 even when it fails, so the message decides.
    if (!ok.test(text)) throw new ExternalToolError(text.split('\n').find(l => l.trim()) ?? `adb ${args[0]} failed`);
    return text.split('\n')[0];
  }

  pair(endpoint: string, code: string): Promise<string> {
    // The code goes through stdin so it never shows up in the process list.
    return this.message(['pair', endpoint], /Successfully paired/i, { input: `${code}\n` });
  }

  connect(endpoint: string): Promise<string> {
    return this.message(['connect', endpoint], /^(connected to|already connected to)/im);
  }

  disconnect(endpoint?: string): Promise<string> {
    return this.message(endpoint ? ['disconnect', endpoint] : ['disconnect'], /disconnected|no such device/i);
  }

  async enableTcpip(deviceId: string, port: number): Promise<void> {
    await this.message(['-s', deviceId, 'tcpip', String(port)], /restarting in TCP mode/i);
    await sleep(1500);
  }

  async discover() {
    const result = await this.adb.run(['mdns', 'services'], 15_000);
    return parseMdnsServices(result.stdout);
  }

  async listMappings(deviceId: string): Promise<PortMapping[]> {
    const [forward, reverse] = await Promise.all([
      this.adb.run(['forward', '--list']),
      this.adb.run(['-s', deviceId, 'reverse', '--list'])
    ]);
    return [...parseMappings('forward', forward.stdout, deviceId), ...parseMappings('reverse', reverse.stdout, deviceId)];
  }

  async addMapping(m: PortMapping): Promise<void> {
    const args = m.kind === 'forward' ? ['-s', m.deviceId, 'forward', m.host, m.device] : ['-s', m.deviceId, 'reverse', m.device, m.host];
    const result = await this.adb.run(args);
    if (result.code !== 0) throw new ExternalToolError(`adb ${m.kind} failed: ${(result.stderr || result.stdout).trim()}`);
  }

  async removeMapping(deviceId: string, kind: PortMapping['kind'], spec: string): Promise<void> {
    const result = await this.adb.run(['-s', deviceId, kind, '--remove', spec]);
    if (result.code !== 0) throw new ExternalToolError(`adb ${kind} --remove failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

export class AdbPermissionProbe implements PermissionProbe {
  constructor(private readonly adb: AdbShell) {}

  async all(deviceId: string): Promise<AppPermissions[]> {
    const op = (name: string) => `cmd appops query-op --user 0 ${name} allow 2>/dev/null`;
    const out = await this.adb.text(deviceId, [
      'echo @@A11Y; settings get secure enabled_accessibility_services',
      'echo @@NOTIF; settings get secure enabled_notification_listeners',
      "echo @@ADMIN; dumpsys device_policy 2>/dev/null | grep -E 'ComponentInfo|^ +[A-Za-z0-9_.]+/[A-Za-z0-9_.$]+:'",
      `echo @@OVERLAY; ${op('SYSTEM_ALERT_WINDOW')}`,
      `echo @@INSTALL; ${op('REQUEST_INSTALL_PACKAGES')}`,
      `echo @@USAGE; ${op('GET_USAGE_STATS')}`,
      'echo @@PACKAGES; dumpsys package packages',
      'true'
    ].join('; '), 180_000);
    return parsePermissionDump(splitSections(out));
  }

  async setGranted(deviceId: string, packageName: string, permission: string, granted: boolean): Promise<void> {
    await this.adb.text(deviceId, `pm ${granted ? 'grant' : 'revoke'} --user 0 ${shellQuote(packageName)} ${shellQuote(permission)}`);
  }
}

export class AdbProcessProbe implements ProcessProbe {
  constructor(private readonly adb: AdbShell) {}

  async snapshot(deviceId: string, limit: number, sort: ProcessSort): Promise<ProcessInfo[]> {
    // Columns: 1 PID 2 USER 3 S 4 %CPU 5 %MEM 6 RES 7 NAME
    const column = sort === 'cpu' ? 4 : 6;
    const n = Math.max(1, Math.min(1000, Math.floor(limit)));
    const out = await this.adb.text(deviceId, `top -b -n 1 -o PID,USER,S,%CPU,%MEM,RES,NAME -s ${column} -m ${n} 2>/dev/null`);
    return parseTopProcesses(out);
  }
}

export class AdbAppManager implements AppManager {
  constructor(private readonly adb: AdbShell) {}

  async install(deviceId: string, apkPaths: string[], options: { replace: boolean; grantAll: boolean; downgrade: boolean }): Promise<string> {
    const flags = [options.replace ? '-r' : '', options.grantAll ? '-g' : '', options.downgrade ? '-d' : ''].filter(Boolean);
    const verb = apkPaths.length > 1 ? 'install-multiple' : 'install';
    const result = await this.adb.run(['-s', deviceId, verb, ...flags, ...apkPaths], 600_000);
    const text = `${result.stdout}\n${result.stderr}`;
    if (!/^Success/m.test(text)) throw new ExternalToolError(`Install failed: ${/Failure \[[^\]]+\]/.exec(text)?.[0] ?? text.trim().split('\n').pop()}`);
    return 'Success';
  }

  async uninstall(deviceId: string, packageName: string, options: { keepData: boolean; userOnly: boolean }): Promise<void> {
    const flags = [options.keepData ? '-k' : '', options.userOnly ? '--user 0' : ''].filter(Boolean).join(' ');
    await this.expectSuccess(deviceId, `pm uninstall ${flags} ${shellQuote(packageName)}`);
  }

  async restore(deviceId: string, packageName: string): Promise<void> {
    await this.expectSuccess(deviceId, `cmd package install-existing --user 0 ${shellQuote(packageName)}`, /installed for user|Success/i);
  }

  async launch(deviceId: string, packageName: string): Promise<void> {
    const out = await this.adb.exec(deviceId, `monkey -p ${shellQuote(packageName)} -c android.intent.category.LAUNCHER 1`);
    if (!/Events injected: 1/.test(out.stdout)) throw new ExternalToolError(`Cannot launch ${packageName}: it has no launcher activity`);
  }

  async forceStop(deviceId: string, packageName: string): Promise<void> {
    await this.adb.text(deviceId, `am force-stop ${shellQuote(packageName)}`);
  }

  async clearData(deviceId: string, packageName: string): Promise<void> {
    await this.expectSuccess(deviceId, `pm clear --user 0 ${shellQuote(packageName)}`);
  }

  private async expectSuccess(deviceId: string, script: string, ok = /^Success/m): Promise<void> {
    const result = await this.adb.exec(deviceId, script);
    const text = `${result.stdout}\n${result.stderr}`.trim();
    if (!ok.test(text)) throw new ExternalToolError(text.split('\n')[0] || `Command failed: ${script}`);
  }
}

export class AdbShellRunner implements ShellRunner {
  constructor(private readonly adb: AdbShell) {}

  async run(deviceId: string, command: string, options: { timeoutMs: number; maxOutputBytes: number; asRoot: boolean }): Promise<ShellResult> {
    const script = options.asRoot ? `su -c ${shellQuote(command)}` : command;
    const started = Date.now();
    const result = await this.adb.run(['-s', deviceId, 'shell', script], options.timeoutMs, { maxOutput: options.maxOutputBytes });
    return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated ?? false, durationMs: Date.now() - started };
  }
}

/** `input text` needs spaces as %s; everything else is protected by shell quoting. */
export function encodeInputText(text: string): string {
  return shellQuote(text.replace(/%/g, '\\%').replace(/ /g, '%s'));
}

export class AdbDeviceInput implements DeviceInput {
  constructor(private readonly adb: AdbShell) {}

  async key(deviceId: string, keycode: number, longPress = false): Promise<void> {
    await this.adb.text(deviceId, `input keyevent ${longPress ? '--longpress ' : ''}${keycode}`);
  }

  async tap(deviceId: string, x: number, y: number): Promise<void> {
    await this.adb.text(deviceId, `input tap ${x} ${y}`);
  }

  async swipe(deviceId: string, from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number): Promise<void> {
    await this.adb.text(deviceId, `input swipe ${from.x} ${from.y} ${to.x} ${to.y} ${Math.round(durationMs)}`);
  }

  async text(deviceId: string, text: string): Promise<void> {
    // Errors are reported without the text: it may be a PIN or password.
    const result = await this.adb.exec(deviceId, `input text ${encodeInputText(text)}`);
    if (result.code !== 0) throw new ExternalToolError('Typing text failed (is a text field focused?)');
  }
}

export class AdbUiInspector implements UiInspector {
  constructor(private readonly adb: AdbShell) {}

  async dump(deviceId: string): Promise<UiElement[]> {
    const file = tmpName('xml');
    // uiautomator fails while the screen animates ("could not get idle state"); retry briefly.
    for (let attempt = 1; ; attempt++) {
      const result = await this.adb.exec(deviceId, `uiautomator dump ${file} >/dev/null 2>&1 && cat ${file}; rm -f ${file}`, 45_000);
      if (result.stdout.includes('<hierarchy')) return parseUiHierarchy(result.stdout);
      if (attempt >= 3) throw new ExternalToolError('uiautomator could not dump the UI (secure screen, or the device is busy)');
      await sleep(800);
    }
  }
}

export class AdbScreenControl implements ScreenControl {
  constructor(private readonly adb: AdbShell) {}

  async state(deviceId: string): Promise<ScreenState> {
    const out = await this.adb.text(deviceId, [
      "echo @@POWER; dumpsys power | grep -E 'mWakefulness='",
      "echo @@WINDOW; dumpsys window 2>/dev/null | grep -E 'mShowingLockscreen|isKeyguardShowing|mKeyguardShowing|KeyguardShowing=|mDreamingLockscreen' | head -5",
      'echo @@WM; wm size; wm density',
      'echo @@SETTINGS; settings get system screen_off_timeout; settings get global stay_on_while_plugged_in',
      'true'
    ].join('; '));
    return parseScreenState(splitSections(out));
  }

  async setStayAwake(deviceId: string, enabled: boolean): Promise<void> {
    await this.adb.text(deviceId, `svc power stayon ${enabled ? 'true' : 'false'}`);
  }

  async setScreenTimeout(deviceId: string, ms: number): Promise<void> {
    await this.adb.text(deviceId, `settings put system screen_off_timeout ${Math.floor(ms)}`);
  }

  async record(deviceId: string, localPath: string, seconds: number): Promise<string> {
    const remote = tmpName('mp4');
    try {
      await this.adb.text(deviceId, `screenrecord --time-limit ${seconds} ${remote}`, (seconds + 20) * 1000);
      const stream = this.adb.binary(deviceId, `cat ${remote}`);
      return (await writeNewFile(localPath, stream.stdout, {
        finish: bytes => { if (bytes === 0) throw new ExternalToolError('screenrecord produced an empty file'); }
      })).path;
    } finally {
      await this.adb.exec(deviceId, `rm -f ${remote}`).catch(() => undefined);
    }
  }

  async reboot(deviceId: string, target: RebootTarget): Promise<void> {
    const result = await this.adb.run(['-s', deviceId, 'reboot', ...(target === 'system' ? [] : [target])], 30_000);
    if (result.code !== 0) throw new ExternalToolError(`adb reboot failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

export class ScrcpyLauncher implements MirrorLauncher {
  constructor(private readonly scrcpyPath: string, private readonly adbPath: string) {}

  async launch(o: Parameters<MirrorLauncher['launch']>[0]): Promise<{ command: string; exitCode: number }> {
    const args = [
      ...(o.deviceId ? ['--serial', o.deviceId] : []),
      ...(o.otg ? ['--otg'] : []),
      ...(o.turnScreenOff && !o.otg ? ['--turn-screen-off'] : []),
      ...(o.stayAwake && !o.otg ? ['--stay-awake'] : []),
      ...(o.noAudio ? ['--no-audio'] : []),
      ...(o.readOnly ? ['--no-control'] : []),
      ...(o.record ? [`--record=${o.record}`] : [])
    ];
    process.env.ADB ??= this.adbPath;
    try {
      return { command: [this.scrcpyPath, ...args].join(' '), exitCode: await runInteractive(this.scrcpyPath, args) };
    } catch (error) {
      throw new ExternalToolError(`scrcpy is not installed or not on PATH. Install it with \`winget install --exact Genymobile.scrcpy\` or set ANDROIDCTL_SCRCPY_PATH`, { cause: error });
    }
  }
}
