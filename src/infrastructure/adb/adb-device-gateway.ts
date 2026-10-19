import { describeAdbDevice, describeFastbootDevice, normaliseAdbState, type Device } from '../../domain/device.js';
import { ExternalToolError, ValidationError } from '../../domain/errors.js';
import type { DeviceGateway } from '../../application/ports.js';
import { runCommand } from '../process/command-runner.js';
import { shellQuote } from './shell-quote.js';

const QUERY_TIMEOUT_MS = 30_000;
const PROPERTY_NAME = /^[A-Za-z0-9_.-]+$/;

/** Parses `adb devices -l`, e.g. `R58M123 device usb:1-1 product:a50 model:SM_A505F device:a50`. */
export function parseAdbDevices(stdout: string): Device[] {
  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('List of devices') && !line.startsWith('*'))
    .map(line => {
      const [id, state, ...rest] = line.split(/\s+/);
      const details = Object.fromEntries(rest.filter(t => t.includes(':')).map(t => [t.slice(0, t.indexOf(':')), t.slice(t.indexOf(':') + 1)]));
      return describeAdbDevice(id, normaliseAdbState(state), {
        ...(details.model ? { model: details.model.replace(/_/g, ' ') } : {}),
        ...(details.product ? { product: details.product } : {})
      });
    });
}

/** Parses `fastboot devices`, e.g. `R58M123\tfastboot`. */
export function parseFastbootDevices(stdout: string): Device[] {
  return stdout
    .split(/\r?\n/)
    .map(line => line.trim().split(/\s+/)[0])
    .filter((id): id is string => Boolean(id))
    .map(describeFastbootDevice);
}

export class AdbDeviceGateway implements DeviceGateway {
  constructor(private readonly adbPath: string, private readonly fastbootPath: string) {}

  async listDevices(): Promise<Device[]> {
    const adb = await runCommand(this.adbPath, ['devices', '-l'], { timeoutMs: QUERY_TIMEOUT_MS });
    if (adb.code !== 0) throw new ExternalToolError(`adb devices failed: ${adb.stderr.trim() || `exit ${adb.code}`}`);
    // fastboot is optional: a missing binary or failure simply means no bootloader devices are listed.
    const fastboot = await runCommand(this.fastbootPath, ['devices'], { timeoutMs: QUERY_TIMEOUT_MS }).catch(() => undefined);
    return [...parseAdbDevices(adb.stdout), ...(fastboot?.code === 0 ? parseFastbootDevices(fastboot.stdout) : [])];
  }

  async readProperty(deviceId: string, name: string): Promise<string> {
    if (!PROPERTY_NAME.test(name)) throw new ValidationError(`Invalid property name: ${name}`);
    const result = await runCommand(this.adbPath, ['-s', deviceId, 'shell', 'getprop', name], { timeoutMs: QUERY_TIMEOUT_MS });
    if (result.code !== 0) throw new ExternalToolError(`getprop ${name} failed on ${deviceId}: ${result.stderr.trim()}`);
    return result.stdout.trim();
  }

  async pathExists(deviceId: string, devicePath: string): Promise<boolean> {
    const result = await runCommand(this.adbPath, ['-s', deviceId, 'shell', `test -e ${shellQuote(devicePath)}`], { timeoutMs: QUERY_TIMEOUT_MS });
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new ExternalToolError(`Cannot check ${devicePath} on ${deviceId}: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
}
