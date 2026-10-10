import { toolPath } from './config.js';
import { run } from './process.js';
import type { Device } from './types.js';

function parseAdbLine(line: string): Device | undefined {
  const [id, state] = line.trim().split(/\s+/);
  if (!id || id === 'List') return undefined;
  const capabilities = state === 'device' ? ['shell', 'pull', 'push', 'logcat', 'packages'] : [];
  return { id, serial: id, transport: 'adb', state: (state as Device['state']) || 'unknown', capabilities, limitations: state === 'unauthorized' ? ['Authorize USB debugging on the phone'] : [] };
}

export async function listDevices(): Promise<Device[]> {
  const adb = await run(toolPath('adb'), ['devices']);
  const adbDevices = adb.stdout.split(/\r?\n/).map(parseAdbLine).filter(Boolean) as Device[];
  const fastboot = await run(toolPath('fastboot'), ['devices']).catch(() => ({ stdout: '', stderr: '', code: -1 }));
  const fastbootDevices = fastboot.stdout.split(/\r?\n/).filter(Boolean).map(line => {
    const id = line.trim().split(/\s+/)[0];
    return { id, serial: id, transport: 'fastboot' as const, state: 'fastboot' as const, capabilities: ['bootloader_inspect'], limitations: ['Flashing and unlocking require explicit confirmation'] };
  });
  return [...adbDevices, ...fastbootDevices];
}

export async function capabilities(deviceId: string) {
  const device = (await listDevices()).find(d => d.id === deviceId);
  if (!device) throw new Error(`Device not found: ${deviceId}`);
  if (device.transport === 'adb' && device.state === 'device') {
    const props = await run(toolPath('adb'), ['-s', deviceId, 'shell', 'getprop', 'ro.product.model']);
    device.model = props.stdout.trim();
  }
  return device;
}
