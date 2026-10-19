import test from 'node:test';
import assert from 'node:assert/strict';
import type { UseCases } from '../../src/application/use-cases/index.js';
import { NotFoundError } from '../../src/domain/errors.js';
import { runCli, SECRET_ENV_VAR } from '../../src/presentation/cli/cli.js';

function harness(overrides: Partial<Record<keyof UseCases, (input: unknown) => unknown>> = {}, env: Record<string, string> = {}, isTTY = false) {
  const calls: [string, unknown][] = [];
  const useCases = new Proxy({} as UseCases, {
    get: (_t, name: string) => ({
      execute: (input: unknown) => {
        calls.push([name, input]);
        const override = overrides[name as keyof UseCases];
        return override ? override(input) : Promise.resolve({ ok: name });
      }
    })
  });
  const out: string[] = [];
  const err: string[] = [];
  const run = (...argv: string[]) => runCli(argv, useCases, { env, out: t => out.push(t), err: t => err.push(t), isTTY }, '9.9.9');
  return { run, calls, out, err };
}

test('help and version need no use case', async () => {
  const h = harness();
  assert.equal(await h.run(), 0);
  assert.match(h.out[0], /Usage:/);
  assert.match(h.out[0], /storage analyze/);
  assert.equal(await h.run('--version'), 0);
  assert.equal(h.out[1], '9.9.9');
  assert.equal(await h.run('storage'), 0, 'a bare group prints its help');
  assert.match(h.out[2], /storage trim-caches/);
  assert.doesNotMatch(h.out[2], /backup create/);
  assert.deepEqual(h.calls, []);
});

test('backup create reads the secret from the environment and applies defaults', async () => {
  const h = harness({}, { [SECRET_ENV_VAR]: 'from-the-environment' });
  assert.equal(await h.run('backup', 'create', '--device', 'S1'), 0);
  assert.deepEqual(h.calls, [['createBackup', { deviceId: 'S1', source: '/sdcard', destination: './backups', secret: 'from-the-environment' }]]);
  assert.deepEqual(h.err, []);
  assert.deepEqual(JSON.parse(h.out[0]), { success: true, data: { ok: 'createBackup' } });
});

test('--secret works but warns about exposure', async () => {
  const h = harness();
  assert.equal(await h.run('backup', 'verify', 'm.manifest.json', '--secret', 'flag-secret-value'), 0);
  assert.match(h.err[0], /shell history/);
  assert.deepEqual(h.calls[0], ['verifyBackup', { manifestPath: 'm.manifest.json', secret: 'flag-secret-value' }]);
});

test('positionals, kebab-case flags, -d and --yes map onto use case inputs', async () => {
  const h = harness();
  await h.run('apps', 'info', 'com.example.app', '-d', 'S1');
  await h.run('files', 'push', './a.txt', '/sdcard/a.txt', '--yes');
  await h.run('apps', 'list', '--include-system');
  await h.run('storage', 'analyze', '--top', '3');
  await h.run('capabilities');
  assert.deepEqual(h.calls, [
    ['getAppInfo', { deviceId: 'S1', packageName: 'com.example.app' }],
    ['pushFile', { localPath: './a.txt', path: '/sdcard/a.txt', confirm: true }],
    ['listApps', { includeSystem: true }],
    ['analyzeStorage', { top: 3 }],
    ['inspectDevice', undefined]
  ]);
});

test('invalid input is a validation error (exit 2)', async () => {
  const h = harness();
  assert.equal(await h.run('apps', 'info'), 2);
  assert.match(h.err[0], /--package-name is required/);
  assert.equal(await h.run('devices', '--bogus'), 2);
  assert.equal(await h.run('devices', '--top', '3'), 2, 'flags of other commands are rejected');
  assert.equal(await h.run('storage', 'analyze', '--top', 'many'), 2);
  assert.equal(await h.run('backup', 'create', '--device', 'S1'), 2);
  assert.equal(await h.run('files', 'ls', '/a', '/b'), 2);
  assert.equal(await h.run('teleport'), 2);
  assert.equal(await h.run('devices', '--follow'), 2);
});

test('domain errors map to their exit codes', async () => {
  const h = harness({ getBackupStatus: async () => { throw new NotFoundError('Job not found'); } });
  assert.equal(await h.run('backup', 'status', '3f2b8a52-6c1e-4c33-9a57-0d5b0f3e9b11'), 3);
  assert.deepEqual(JSON.parse(h.err[0]), { success: false, error: { code: 'NOT_FOUND', message: 'Job not found' } });
});

test('a verification that finds problems exits 5', async () => {
  const h = harness({ verifyBackup: async () => ({ valid: false, failures: ['Block 1 failed authentication'] }) }, { [SECRET_ENV_VAR]: 'x'.repeat(12) });
  assert.equal(await h.run('backup', 'verify', '--manifest', 'm.manifest.json'), 5);
});

test('terminal mode renders human views and friendly errors', async () => {
  const h = harness({
    listDevices: async () => [{ id: 'S1', transport: 'adb', state: 'unauthorized', capabilities: [], limitations: ['Authorize USB debugging on the phone'] }],
    trimCaches: async () => { throw Object.assign(new Error('x'), {}); }
  }, { NO_COLOR: '1' }, true);
  assert.equal(await h.run('devices'), 0);
  assert.match(h.out[0], /S1\s+—\s+adb\s+unauthorized\s+Authorize USB debugging/);
  assert.equal(await h.run('storage', 'trim-caches'), 1);
  assert.match(h.err[0], /^✖ x/);
});

test('--follow streams entries as NDJSON when piped', async () => {
  const h = harness({ followLogs: () => (async function* () { yield { level: 'E', tag: 'T' }; yield { level: 'W', tag: 'U' }; })() });
  assert.equal(await h.run('logs', '--follow', '--min-level', 'W'), 0);
  assert.deepEqual(h.out.map(l => JSON.parse(l).tag), ['T', 'U']);
  assert.deepEqual(h.calls[0], ['followLogs', { minLevel: 'W' }]);
});
