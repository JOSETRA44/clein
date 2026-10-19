import test from 'node:test';
import assert from 'node:assert/strict';
import type { FileBrowser, LogSource, StorageProbe } from '../../src/application/ports.js';
import { AnalyzeStorage, FollowLogs, ListApps, ListFiles, PullFile, ReadLogs, TrimCaches } from '../../src/application/use-cases/index.js';
import { describeAdbDevice } from '../../src/domain/device.js';
import type { LogEntry, RemoteFileEntry } from '../../src/domain/inspection.js';
import { FakeDeviceGateway } from '../support/fakes.js';

const volume = (free: number) => ({ mount: '/data', totalBytes: 1000, usedBytes: 1000 - free, freeBytes: free });

class FakeStorage implements StorageProbe {
  trims: number[] = [];
  free = 10;
  async snapshot() {
    return { volume: volume(this.free), apps: [
      { packageName: 'a.small', codeBytes: 1, dataBytes: 9, cacheBytes: 0, totalBytes: 10 },
      { packageName: 'b.huge', codeBytes: 10, dataBytes: 700, cacheBytes: 0, totalBytes: 710 }
    ] };
  }
  async largest() { return []; }
  async trimCaches(_id: string, bytes: number) { this.trims.push(bytes); this.free = 60; }
}

test('device is auto-selected when exactly one is connected, and ambiguity is rejected', async () => {
  const report = await new AnalyzeStorage(new FakeDeviceGateway(), new FakeStorage()).execute({ top: 1 });
  assert.equal(report.deviceId, 'SERIAL1');
  assert.deepEqual(report.topApps.map(a => a.packageName), ['b.huge']);
  assert.equal(report.appCount, 2);
  assert.deepEqual(report.findings.map(f => f.code), ['STORAGE_FULL', 'DOMINANT_APP']);

  const two = new FakeDeviceGateway([describeAdbDevice('A', 'device'), describeAdbDevice('B', 'device')]);
  await assert.rejects(new AnalyzeStorage(two, new FakeStorage()).execute({}), /Several devices connected \(A, B\)/);
  await assert.rejects(new AnalyzeStorage(new FakeDeviceGateway([]), new FakeStorage()).execute({}), { code: 'NOT_FOUND' });
});

test('trim-caches refuses without confirmation and reports freed space', async () => {
  const storage = new FakeStorage();
  const trim = new TrimCaches(new FakeDeviceGateway(), storage);
  await assert.rejects(trim.execute({}), { code: 'CONFIRMATION_REQUIRED' });
  assert.deepEqual(storage.trims, []);
  const result = await trim.execute({ confirm: true });
  assert.equal(result.freedBytes, 50);
  assert.deepEqual(storage.trims, [1000]);
});

test('apps hide system packages unless asked and support search', async () => {
  const catalog = {
    list: async () => [
      { packageName: 'com.zeta', kind: 'user' as const },
      { packageName: 'android', kind: 'system' as const },
      { packageName: 'com.alpha', kind: 'user' as const }
    ],
    details: async () => undefined
  };
  const list = new ListApps(new FakeDeviceGateway(), catalog);
  assert.deepEqual((await list.execute({})).apps.map(a => a.packageName), ['com.alpha', 'com.zeta']);
  assert.equal((await list.execute({ includeSystem: true })).apps.length, 3);
  assert.deepEqual((await list.execute({ search: 'ZE' })).apps.map(a => a.packageName), ['com.zeta']);
});

const entry = (path: string, type: RemoteFileEntry['type'], sizeBytes = 0): RemoteFileEntry =>
  ({ path, name: path.split('/').pop()!, type, sizeBytes, modifiedAt: '', mode: '' });

class FakeFiles implements FileBrowser {
  constructor(private readonly entries: Record<string, RemoteFileEntry>, private readonly children: RemoteFileEntry[] = []) {}
  async stat(_d: string, p: string) { return this.entries[p]; }
  async list() { return [...this.children]; }
  async download(_d: string, _p: string, local: string, onProgress?: (p: { doneBytes: number }) => void) { onProgress?.({ doneBytes: 5 }); return `/abs/${local}`; }
  async upload() {}
}

test('files ls lists directories first, then by name', async () => {
  const files = new FakeFiles({ '/sdcard': entry('/sdcard', 'directory') }, [entry('/sdcard/b.txt', 'file'), entry('/sdcard/Zdir', 'directory'), entry('/sdcard/a.txt', 'file')]);
  const result = await new ListFiles(new FakeDeviceGateway(), files).execute({});
  assert.deepEqual(result.entries.map(e => e.name), ['Zdir', 'a.txt', 'b.txt']);
  await assert.rejects(new ListFiles(new FakeDeviceGateway(), files).execute({ path: '/nope' }), { code: 'NOT_FOUND' });
});

test('pull reports progress against the remote size and rejects directories', async () => {
  const files = new FakeFiles({ '/sdcard/v.mp4': entry('/sdcard/v.mp4', 'file', 10), '/sdcard/DCIM': entry('/sdcard/DCIM', 'directory') });
  const progress: unknown[] = [];
  const result = await new PullFile(new FakeDeviceGateway(), files).execute({ path: '/sdcard/v.mp4', output: 'v.mp4' }, p => progress.push(p));
  assert.equal(result.localPath, '/abs/v.mp4');
  assert.deepEqual(progress, [{ doneBytes: 5, totalBytes: 10 }]);
  await assert.rejects(new PullFile(new FakeDeviceGateway(), files).execute({ path: '/sdcard/DCIM', output: 'x' }), /backup create/);
});

const log = (level: LogEntry['level'], tag: string, message = 'm'): LogEntry => ({ time: '', pid: 1, tid: 1, level, tag, message });

test('logs are filtered after reading, over-reading when a filter is set', async () => {
  const requested: number[] = [];
  const source: LogSource = {
    recent: async (_d, n) => { requested.push(n); return [log('I', 'A'), log('E', 'B'), log('E', 'A')]; },
    follow: async function* () { yield log('D', 'A'); yield log('E', 'A'); }
  };
  const read = new ReadLogs(new FakeDeviceGateway(), source);
  assert.deepEqual((await read.execute({ lines: 1, minLevel: 'E' })).entries.map(e => e.tag), ['A']);
  assert.deepEqual(requested, [5000]);
  await read.execute({ lines: 50 });
  assert.equal(requested[1], 50);

  const followed: string[] = [];
  for await (const e of new FollowLogs(new FakeDeviceGateway(), source).execute({ minLevel: 'W' })) followed.push(e.level);
  assert.deepEqual(followed, ['E']);
});
