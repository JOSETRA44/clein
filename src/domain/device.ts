export type TransportName = 'adb' | 'fastboot' | 'mtp';

export type DeviceState =
  | 'device'
  | 'unauthorized'
  | 'offline'
  | 'recovery'
  | 'sideload'
  | 'bootloader'
  | 'fastboot'
  | 'unknown';

export type Capability = 'shell' | 'pull' | 'push' | 'logcat' | 'packages' | 'backup' | 'bootloader_inspect';

export interface Device {
  id: string;
  transport: TransportName;
  state: DeviceState;
  model?: string;
  product?: string;
  capabilities: Capability[];
  limitations: string[];
}

const KNOWN_ADB_STATES: ReadonlySet<string> = new Set(['device', 'unauthorized', 'offline', 'recovery', 'sideload', 'bootloader']);

/** Policy: what each ADB state lets us do, and what the user must be told. */
const ADB_STATE_RULES: Record<DeviceState, { capabilities: Capability[]; limitations: string[] }> = {
  device: { capabilities: ['shell', 'pull', 'push', 'logcat', 'packages', 'backup'], limitations: [] },
  unauthorized: { capabilities: [], limitations: ['Authorize USB debugging on the phone, then reconnect'] },
  offline: { capabilities: [], limitations: ['Device is offline; reconnect the cable or restart the ADB server'] },
  recovery: { capabilities: ['shell'], limitations: ['Recovery mode: only recovery-provided shell commands are available'] },
  sideload: { capabilities: [], limitations: ['Sideload mode only accepts OTA packages'] },
  bootloader: { capabilities: [], limitations: ['Bootloader mode: use fastboot tooling'] },
  fastboot: { capabilities: ['bootloader_inspect'], limitations: ['Flashing and unlocking require explicit confirmation'] },
  unknown: { capabilities: [], limitations: ['Unrecognised device state; no operations are considered safe'] }
};

export function normaliseAdbState(raw: string | undefined): DeviceState {
  return raw && KNOWN_ADB_STATES.has(raw) ? (raw as DeviceState) : 'unknown';
}

export function describeAdbDevice(id: string, state: DeviceState, details: { model?: string; product?: string } = {}): Device {
  const rules = ADB_STATE_RULES[state];
  return { id, transport: 'adb', state, ...details, capabilities: [...rules.capabilities], limitations: [...rules.limitations] };
}

export function describeFastbootDevice(id: string): Device {
  const rules = ADB_STATE_RULES.fastboot;
  return { id, transport: 'fastboot', state: 'fastboot', capabilities: [...rules.capabilities], limitations: [...rules.limitations] };
}

export function hasCapability(device: Device, capability: Capability): boolean {
  return device.capabilities.includes(capability);
}
