import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ArchiveOutcome, DeviceArchiveSource, DeviceGateway, JobRepository } from '../../src/application/ports.js';
import { describeAdbDevice, type Device } from '../../src/domain/device.js';
import type { Job } from '../../src/domain/job.js';

export class FakeDeviceGateway implements DeviceGateway {
  readonly propertyReads: string[] = [];

  constructor(
    public devices: Device[] = [describeAdbDevice('SERIAL1', 'device')],
    public properties: Record<string, string> = { 'ro.product.model': 'Pixel 8' },
    public existingPaths: string[] = ['/sdcard', '/sdcard/DCIM']
  ) {}

  async listDevices(): Promise<Device[]> { return this.devices.map(d => ({ ...d })); }
  async readProperty(_deviceId: string, name: string): Promise<string> { this.propertyReads.push(name); return this.properties[name] ?? ''; }
  async pathExists(_deviceId: string, devicePath: string): Promise<boolean> { return this.existingPaths.includes(devicePath); }
}

export class FakeArchiveSource implements DeviceArchiveSource {
  constructor(public chunks: Uint8Array[], public outcome: ArchiveOutcome = { exitCode: 0, diagnostics: [] }) {}

  async estimateSize() { return this.chunks.reduce((n, c) => n + c.length, 0); }

  async open() {
    const chunks = this.chunks;
    return {
      chunks: (async function* () { yield* chunks; })(),
      outcome: async () => this.outcome
    };
  }
}

export class InMemoryJobRepository implements JobRepository {
  readonly history: Job[] = [];
  async save(job: Job): Promise<void> { this.history.push(job); }
  async find(id: string): Promise<Job | undefined> { return [...this.history].reverse().find(j => j.id === id); }
}

export function fixedClock(iso = '2026-01-01T00:00:00.000Z') {
  return { now: () => new Date(iso) };
}

export function sequentialIds(prefix = '00000000-0000-4000-8000-') {
  let n = 0;
  return { next: () => `${prefix}${String(++n).padStart(12, '0')}` };
}

export async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'androidctl-test-'));
}
