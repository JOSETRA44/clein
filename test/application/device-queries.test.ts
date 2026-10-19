import test from 'node:test';
import assert from 'node:assert/strict';
import { DiagnoseDevice, InspectDevice } from '../../src/application/use-cases/index.js';
import { describeAdbDevice, describeFastbootDevice } from '../../src/domain/device.js';
import { FakeDeviceGateway } from '../support/fakes.js';

test('inspect enriches ready devices with their model', async () => {
  const device = await new InspectDevice(new FakeDeviceGateway()).execute('SERIAL1');
  assert.equal(device.model, 'Pixel 8');
});

test('inspect and diagnose never shell into devices without shell access', async () => {
  const gateway = new FakeDeviceGateway([describeFastbootDevice('FB1'), describeAdbDevice('U1', 'unauthorized')]);
  await new InspectDevice(gateway).execute('FB1');
  const report = await new DiagnoseDevice(gateway).execute('U1');
  assert.deepEqual(report.properties, {});
  assert.deepEqual(gateway.propertyReads, []);
});

test('diagnose collects only non-empty properties', async () => {
  const gateway = new FakeDeviceGateway(undefined, { 'ro.product.model': 'Pixel 8', 'ro.build.version.release': '15' });
  const report = await new DiagnoseDevice(gateway).execute('SERIAL1');
  assert.deepEqual(report.properties, { model: 'Pixel 8', androidVersion: '15' });
  assert.equal(report.readOnly, true);
});

test('unknown devices produce NOT_FOUND; a missing id picks the only connected device', async () => {
  await assert.rejects(new InspectDevice(new FakeDeviceGateway()).execute('NOPE'), { code: 'NOT_FOUND' });
  assert.equal((await new DiagnoseDevice(new FakeDeviceGateway()).execute(undefined)).device.id, 'SERIAL1');
});
