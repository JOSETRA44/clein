import { hasCapability, type Device } from '../../domain/device.js';
import { findDevice } from '../device-lookup.js';
import type { DeviceGateway } from '../ports.js';

export class ListDevices {
  constructor(private readonly devices: DeviceGateway) {}

  execute(): Promise<Device[]> {
    return this.devices.listDevices();
  }
}

export class InspectDevice {
  constructor(private readonly devices: DeviceGateway) {}

  async execute(deviceId: string | undefined): Promise<Device> {
    const device = await findDevice(this.devices, deviceId);
    if (!hasCapability(device, 'shell')) return device;
    const model = await this.devices.readProperty(device.id, 'ro.product.model');
    return { ...device, model: model || device.model };
  }
}

/** Read-only properties that are safe to collect and help triage recovery work. */
const DIAGNOSTIC_PROPERTIES = {
  manufacturer: 'ro.product.manufacturer',
  model: 'ro.product.model',
  androidVersion: 'ro.build.version.release',
  sdk: 'ro.build.version.sdk',
  securityPatch: 'ro.build.version.security_patch',
  verifiedBootState: 'ro.boot.verifiedbootstate',
  bootloaderLocked: 'ro.boot.flash.locked',
  encryptionState: 'ro.crypto.state'
} as const;

export type DiagnosticKey = keyof typeof DIAGNOSTIC_PROPERTIES;

export interface DiagnosticReport {
  device: Device;
  properties: Partial<Record<DiagnosticKey, string>>;
  readOnly: true;
}

export class DiagnoseDevice {
  constructor(private readonly devices: DeviceGateway) {}

  async execute(deviceId: string | undefined): Promise<DiagnosticReport> {
    const device = await findDevice(this.devices, deviceId);
    const properties: DiagnosticReport['properties'] = {};
    if (hasCapability(device, 'shell')) {
      for (const [key, name] of Object.entries(DIAGNOSTIC_PROPERTIES) as [DiagnosticKey, string][]) {
        const value = await this.devices.readProperty(device.id, name);
        if (value) properties[key] = value;
      }
    }
    return { device: { ...device, model: properties.model ?? device.model }, properties, readOnly: true };
  }
}
