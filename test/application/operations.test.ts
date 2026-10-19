import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppCatalog, AppManager, DeviceInput, ScreenControl, ShellRunner, UiInspector } from '../../src/application/ports.js';
import { BuildHealthReport, HeadlessControl, ManageApps, ManagePortMappings, RunShellCommand, SetPermission } from '../../src/application/use-cases/index.js';
import type { UiElement } from '../../src/domain/control.js';
import { FakeDeviceGateway } from '../support/fakes.js';

class RecordingShell implements ShellRunner {
  commands: string[] = [];
  async run(_d: string, command: string) { this.commands.push(command); return { exitCode: 0, stdout: 'ok\n', stderr: '', truncated: false, durationMs: 1 }; }
}

test('shell: read-only runs, writes need confirmation, destructive commands never run', async () => {
  const shell = new RecordingShell();
  const run = new RunShellCommand(new FakeDeviceGateway(), shell);
  assert.equal((await run.execute({ command: 'getprop ro.build.version.release' })).assessment.risk, 'read');
  await assert.rejects(run.execute({ command: 'pm clear com.x' }), { code: 'CONFIRMATION_REQUIRED' });
  await run.execute({ command: 'pm clear com.x', confirm: true });
  await assert.rejects(run.execute({ command: 'rm -rf /', confirm: true }), /never runs this/);
  await assert.rejects(run.execute({ command: 'id', asRoot: true }), { code: 'CONFIRMATION_REQUIRED' });
  await assert.rejects(run.execute({ command: 'ls', timeoutSeconds: 9999 }), /Timeout/);
  assert.deepEqual(shell.commands, ['getprop ro.build.version.release', 'pm clear com.x']);
});

class FakeInput implements DeviceInput {
  log: string[] = [];
  async key(_d: string, k: number) { this.log.push(`key ${k}`); }
  async tap(_d: string, x: number, y: number) { this.log.push(`tap ${x},${y}`); }
  async swipe(_d: string, a: { x: number; y: number }, b: { x: number; y: number }) { this.log.push(`swipe ${a.x},${a.y}>${b.x},${b.y}`); }
  async text() { this.log.push('text'); }
}

const screenState = { awake: false, locked: true, widthPx: 1000, heightPx: 2000 };
const screen = (state = screenState): ScreenControl => ({
  state: async () => state, setStayAwake: async () => {}, setScreenTimeout: async () => {}, record: async () => 'x', reboot: async () => {}
});
const ui = (elements: Partial<UiElement>[]): UiInspector => ({
  dump: async () => elements.map((e, index) => ({
    index, text: '', resourceId: '', contentDesc: '', className: '', packageName: '', clickable: true, enabled: true, focused: false,
    checked: false, password: false, bounds: { left: 0, top: 0, right: 100, bottom: 50 }, ...e
  }))
});

test('headless: tap element by text at its centre, refuse off-screen taps, wake never types', async () => {
  const input = new FakeInput();
  const control = new HeadlessControl(new FakeDeviceGateway(), input, ui([{ text: 'OK', bounds: { left: 100, top: 200, right: 300, bottom: 260 } }]), screen(), async () => {});
  const tapped = await control.tapElement({ text: 'ok' });
  assert.deepEqual(tapped.tapped, { x: 200, y: 230 });
  await assert.rejects(control.tapElement({ text: 'Cancel' }), { code: 'NOT_FOUND' });
  await assert.rejects(control.tapElement({}), /--text, --id or --desc/);
  await assert.rejects(control.tap({ x: 1000, y: 10 }), /outside the screen/);

  input.log = [];
  await control.wake({});
  assert.deepEqual(input.log, ['key 224', 'swipe 500,1700>500,600']);
  assert.ok(!input.log.includes('text'));
});

test('headless: waitFor polls until the element shows up or times out', async () => {
  let calls = 0;
  const appearing: UiInspector = { dump: async () => (++calls >= 3 ? (await ui([{ text: 'Done' }]).dump('')) : []) };
  const control = new HeadlessControl(new FakeDeviceGateway(), new FakeInput(), appearing, screen(), async () => {});
  assert.equal((await control.waitFor({ text: 'Done', timeoutSeconds: 5 })).attempts, 3);
  const never = new HeadlessControl(new FakeDeviceGateway(), new FakeInput(), ui([]), screen(), async () => {});
  await assert.rejects(never.waitFor({ text: 'Done', timeoutSeconds: 0 }), /Timed out/);
});

test('system apps are uninstalled for user 0 only and report how to restore', async () => {
  const calls: unknown[] = [];
  const manager: AppManager = {
    install: async () => 'Success', uninstall: async (_d, p, o) => { calls.push([p, o]); }, restore: async () => {},
    launch: async () => {}, forceStop: async () => {}, clearData: async () => {}
  };
  const catalog: AppCatalog = { list: async () => [], details: async (_d, p) => ({ packageName: p, kind: p.startsWith('com.android') ? 'system' : 'user', permissions: [] }) };
  const apps = new ManageApps(new FakeDeviceGateway(), manager, catalog);
  await assert.rejects(apps.uninstall({ packageName: 'com.android.bloat' }), { code: 'CONFIRMATION_REQUIRED' });
  const result = await apps.uninstall({ packageName: 'com.android.bloat', confirm: true });
  assert.equal(result.restoreWith, 'androidctl apps restore com.android.bloat');
  await apps.uninstall({ packageName: 'org.user.app', confirm: true, keepData: true });
  assert.deepEqual(calls, [['com.android.bloat', { keepData: false, userOnly: true }], ['org.user.app', { keepData: true, userOnly: false }]]);
  await assert.rejects(apps.clearData({ packageName: 'org.user.app' }), /irreversible/);
  await assert.rejects(apps.install({ apks: ['notes.txt'] }), /Not an APK/);
});

test('permissions need confirmation and accept short names', async () => {
  const set: unknown[] = [];
  const perms = new SetPermission(new FakeDeviceGateway(), { all: async () => [], setGranted: async (...a) => { set.push(a.slice(1)); } });
  await assert.rejects(perms.execute({ packageName: 'com.x.y', permission: 'CAMERA', grant: false }), { code: 'CONFIRMATION_REQUIRED' });
  await perms.execute({ packageName: 'com.x.y', permission: 'camera', grant: false, confirm: true });
  assert.deepEqual(set, [['com.x.y', 'android.permission.CAMERA', false]]);
});

test('port mappings accept bare port numbers', async () => {
  const added: unknown[] = [];
  const ports = new ManagePortMappings(new FakeDeviceGateway(), {
    addMapping: async m => { added.push(m); }, listMappings: async () => [], removeMapping: async () => {},
    pair: async () => '', connect: async () => '', disconnect: async () => '', enableTcpip: async () => {}, discover: async () => []
  });
  await ports.add({ kind: 'reverse', host: '3000' });
  assert.deepEqual(added, [{ kind: 'reverse', deviceId: 'SERIAL1', host: 'tcp:3000', device: 'tcp:3000' }]);
  await assert.rejects(ports.add({ kind: 'forward', host: 'tcp:1;reboot' }), /Invalid socket spec/);
});

test('health report survives a failing section and scores the rest', async () => {
  const report = await new BuildHealthReport({
    devices: new FakeDeviceGateway(),
    diagnose: { execute: async () => ({ device: {} as never, properties: {}, readOnly: true }) },
    vitals: { execute: async () => ({ deviceId: 'SERIAL1', vitals: { sampledAt: '' }, findings: [{ severity: 'warning', code: 'W', message: 'warm' }] }) },
    storage: { execute: async () => ({ findings: [{ severity: 'critical', code: 'C', message: 'full' }] }) as never },
    network: { execute: async () => { throw new Error('wifi probe failed'); } },
    permissions: { execute: async () => ({ deviceId: 'SERIAL1', apps: [], scanned: 0, findings: [] }) }
  }, () => new Date('2026-10-17T00:00:00Z')).execute({});
  assert.equal(report.score, 67);
  assert.deepEqual(report.findings.map(f => [f.section, f.code]), [['storage', 'C'], ['vitals', 'W']]);
  assert.deepEqual(report.errors, { network: 'wifi probe failed' });
});
