import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { UseCases } from '../../src/application/use-cases/index.js';
import { CATALOG } from '../../src/presentation/catalog.js';
import { VIEWS } from '../../src/presentation/cli/views.js';
import { createMcpServer } from '../../src/presentation/mcp/server.js';

const fakeUseCases = new Proxy({} as UseCases, { get: (_t, name: string) => ({ execute: async (input: unknown) => ({ name, input }) }) });

async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(fakeUseCases, '1.0.0').connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  return client;
}

test('catalog ids and CLI paths are unique, and every command has a human view', () => {
  assert.equal(new Set(CATALOG.map(c => c.id)).size, CATALOG.length);
  assert.equal(new Set(CATALOG.map(c => c.path.join(' '))).size, CATALOG.length);
  assert.deepEqual(CATALOG.filter(c => !VIEWS[c.id]).map(c => c.id), []);
});

test('positional keys exist in the input schema', () => {
  for (const c of CATALOG) for (const key of c.positional ?? []) assert.ok(key in c.input, `${c.id}.${key}`);
});

test('MCP exposes exactly the catalog, with safety annotations', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), CATALOG.filter(c => !c.cliOnly).map(c => c.id).sort());
  const trim = tools.find(t => t.name === 'storage_trim_caches')!;
  assert.equal(trim.annotations?.destructiveHint, true);
  assert.ok('confirm' in (trim.inputSchema.properties ?? {}));
  assert.equal(tools.find(t => t.name === 'storage_analyze')!.annotations?.readOnlyHint, true);
  await client.close();
});

test('MCP calls reach the use case and invalid input is rejected', async () => {
  const client = await connect();
  const ok = await client.callTool({ name: 'app_info', arguments: { packageName: 'com.example.app' } });
  assert.deepEqual(JSON.parse((ok.content as { text: string }[])[0].text).data, { name: 'getAppInfo', input: { packageName: 'com.example.app' } });
  const bad = await client.callTool({ name: 'backup_verify', arguments: { manifest: 'x', secret: 'short' } }).catch((e: Error) => ({ isError: true, message: e.message }));
  assert.equal(bad.isError, true);
  await client.close();
});
