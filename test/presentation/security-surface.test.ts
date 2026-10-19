import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AuditEntry, AuditLog } from '../../src/application/ports.js';
import type { HealthReport, UseCases } from '../../src/application/use-cases/index.js';
import { CATALOG } from '../../src/presentation/catalog.js';
import { renderCompletion } from '../../src/presentation/cli/completion.js';
import { renderHtml, renderMarkdown } from '../../src/presentation/cli/report.js';
import { runCli } from '../../src/presentation/cli/cli.js';
import { executeCommand } from '../../src/presentation/executor.js';
import { startHttpServer } from '../../src/presentation/mcp/http.js';
import { createMcpServer } from '../../src/presentation/mcp/server.js';

const echo = new Proxy({} as UseCases, {
  get: (_t, name: string) => new Proxy({}, { get: (_x, method: string) => async (input: unknown) => ({ name, method, input }) })
});

class MemoryAudit implements AuditLog {
  entries: AuditEntry[] = [];
  async record(e: AuditEntry) { this.entries.push(e); }
  async recent() { return this.entries; }
}

const command = (id: string) => CATALOG.find(c => c.id === id)!;

test('executor: read-only policy refuses writes, and every non-read call is audited', async () => {
  const audit = new MemoryAudit();
  await executeCommand(command('storage_analyze'), { useCases: echo }, {}, { policy: 'read-only', audit, channel: 'mcp' });
  await assert.rejects(executeCommand(command('apps_uninstall'), { useCases: echo }, { packageName: 'a.b' }, { policy: 'read-only', audit, channel: 'mcp' }), { code: 'POLICY_DENIED' });
  await executeCommand(command('backup_start'), { useCases: echo }, { secret: 'super-secret-value' }, { policy: 'standard', audit, channel: 'cli' });
  assert.deepEqual(audit.entries.map(e => [e.operation, e.outcome, e.channel]), [['apps_uninstall', 'denied', 'mcp'], ['backup_start', 'ok', 'cli']]);
});

async function mcpClient(policy: 'read-only' | 'standard') {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(echo, '1.0.0', { execution: { policy } }).connect(b);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(a);
  return client;
}

test('MCP read-only mode only advertises read tools; prompts and resources are listed', async () => {
  const ro = await mcpClient('read-only');
  const { tools } = await ro.listTools();
  assert.ok(tools.length > 10);
  assert.ok(tools.every(t => t.annotations?.readOnlyHint === true));
  const prompts = (await ro.listPrompts()).prompts.map(p => p.name).sort();
  assert.deepEqual(prompts, ['broken_screen_rescue', 'security_audit', 'storage_cleanup']);
  const resources = (await ro.listResources()).resources.map(r => r.uri).sort();
  assert.deepEqual(resources, ['androidctl://audit', 'androidctl://devices']);
  const prompt = await ro.getPrompt({ name: 'broken_screen_rescue', arguments: { deviceId: 'S1' } });
  assert.match((prompt.messages[0].content as { text: string }).text, /unlock it myself/);
  await ro.close();

  const full = await mcpClient('standard');
  const names = (await full.listTools()).tools.map(t => t.name);
  assert.ok(names.includes('shell_exec') && names.includes('ui_tap'));
  assert.ok(!names.includes('mirror'), 'interactive scrcpy is CLI only');
  await full.close();
});

test('HTTP transport: loopback only, token, Host and Origin checks', async () => {
  const server = await startHttpServer({ port: 0, host: '127.0.0.1', token: 'tok-123', createServer: () => createMcpServer(echo, '1.0.0') });
  const port = (server.address() as { port: number }).port;
  // Port 0 picks a random port, so allowed hosts were computed for 0; restart on the real port.
  server.close();
  const real = await startHttpServer({ port, host: '127.0.0.1', token: 'tok-123', createServer: () => createMcpServer(echo, '1.0.0') });
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
  const post = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST', body: JSON.stringify(init),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }
  });
  try {
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post({ authorization: 'Bearer tok-123', origin: 'https://evil.example' })).status, 403);
    const ok = await post({ authorization: 'Bearer tok-123', origin: `http://localhost:${port}` });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /androidctl/);
  } finally {
    real.close();
  }
});

test('CLI: shell joins words, prints raw output and returns the remote exit code', async () => {
  const out: string[] = [];
  const useCases = { ...echo, shell: { execute: async (i: { command: string }) => ({ stdout: `ran: ${i.command}\n`, stderr: '', exitCode: 3, truncated: false }) } } as unknown as UseCases;
  const code = await runCli(['shell', '--', 'ls', '-la', '/sdcard'], useCases, { env: { NO_COLOR: '1' }, out: t => out.push(t), err: () => {}, isTTY: true }, '1');
  assert.equal(code, 3);
  assert.deepEqual(out, ['ran: ls -la /sdcard']);
});

test('CLI honours the read-only policy too', async () => {
  const err: string[] = [];
  const code = await runCli(['reboot', '--yes'], echo, { env: {}, out: () => {}, err: t => err.push(t) }, '1', { policy: 'read-only' });
  assert.equal(code, 7);
  assert.match(err[0], /POLICY_DENIED/);
});

test('completion scripts are generated from the catalog', () => {
  const ps = renderCompletion('powershell');
  assert.match(ps, /'storage' = @\('analyze', 'largest', 'trim-caches'\)/);
  assert.match(ps, /Register-ArgumentCompleter/);
  assert.match(renderCompletion('bash'), /ui\) COMPREPLY=\(\$\(compgen -W "dump tap wait"/);
  assert.throws(() => renderCompletion('fish'), /Unsupported shell/);
});

test('report renderers escape untrusted device strings', () => {
  const report: HealthReport = {
    generatedAt: '2026-10-17T00:00:00Z', deviceId: 'S1', score: 50, grade: 'D', errors: {},
    sections: { storage: { volume: { usedBytes: 9, totalBytes: 10, freeBytes: 1 }, topApps: [] } },
    findings: [{ section: 'network', severity: 'warning', code: 'X', subject: '<script>alert(1)</script>', message: 'a | b' }]
  };
  const html = renderHtml(report);
  assert.ok(!html.includes('<script>alert'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(renderMarkdown(report), /a \\\| b/);
});
