import { DeviceUnavailableError, NotFoundError, ValidationError } from '../domain/errors.js';
import { hasCapability, type Capability, type Device } from '../domain/device.js';
import type { DeviceGateway } from './ports.js';

/**
 * Resolves the target device. When no id is given and exactly one device is
 * connected it is chosen automatically — the common single-phone dev setup.
 */
export async function findDevice(gateway: DeviceGateway, deviceId: string | undefined): Promise<Device> {
  const devices = await gateway.listDevices();
  if (!deviceId) {
    if (devices.length === 1) return devices[0];
    if (devices.length === 0) throw new NotFoundError('No devices connected. Plug in a phone with USB debugging enabled');
    throw new ValidationError(`Several devices connected (${devices.map(d => d.id).join(', ')}); choose one with --device`);
  }
  const device = devices.find(d => d.id === deviceId);
  if (!device) throw new NotFoundError(`Device not found: ${deviceId}`);
  return device;
}

export async function requireCapability(gateway: DeviceGateway, deviceId: string | undefined, capability: Capability): Promise<Device> {
  const device = await findDevice(gateway, deviceId);
  if (!hasCapability(device, capability)) {
    const reason = device.limitations[0] ?? `state is ${device.state}`;
    throw new DeviceUnavailableError(`Device ${device.id} cannot perform ${capability}: ${reason}`);
  }
  return device;
}
