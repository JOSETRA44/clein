#!/usr/bin/env node
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../infrastructure/config.js';
import { startHttpServer } from '../presentation/mcp/http.js';
import { createMcpServer } from '../presentation/mcp/server.js';
import { appVersion, buildAuditLog, buildUseCases } from './container.js';

const { values } = parseArgs({
  options: {
    http: { type: 'boolean' },
    port: { type: 'string', default: '8765' },
    host: { type: 'string', default: '127.0.0.1' },
    'read-only': { type: 'boolean' }
  }
});

const config = loadConfig();
const useCases = buildUseCases(config);
const execution = { policy: values['read-only'] ? 'read-only' as const : config.policy, audit: buildAuditLog(config) };
const create = () => createMcpServer(useCases, appVersion, { execution });

if (values.http) {
  const host = values.host;
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    console.error('androidctl-mcp only listens on loopback (127.0.0.1, ::1, localhost)');
    process.exit(2);
  }
  const port = Number(values.port);
  const token = process.env.ANDROIDCTL_MCP_TOKEN || crypto.randomBytes(24).toString('base64url');
  await startHttpServer({ port, host, token, createServer: create, log: line => console.error(line) });
  console.error(`androidctl MCP listening on http://${host === '::1' ? '[::1]' : host}:${port}/mcp (policy: ${execution.policy})`);
  if (!process.env.ANDROIDCTL_MCP_TOKEN) console.error(`Bearer token (set ANDROIDCTL_MCP_TOKEN to choose your own): ${token}`);
} else {
  await create().connect(new StdioServerTransport());
}
