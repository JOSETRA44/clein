import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { listDevices, capabilities } from './devices.js';
import { createBackup, backupStatus } from './backup.js';

const server = new Server({ name: 'androidctl', version: '0.1.0' }, { capabilities: { tools: {} } });
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: value }, null, 2) }] });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'device_list', description: 'List connected Android devices and detected transports.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'device_capabilities', description: 'Inspect capabilities of one device.', inputSchema: { type: 'object', properties: { deviceId: { type: 'string', minLength: 1 } }, required: ['deviceId'], additionalProperties: false } },
  { name: 'device_diagnose', description: 'Collect safe diagnostic information.', inputSchema: { type: 'object', properties: { deviceId: { type: 'string', minLength: 1 } }, required: ['deviceId'], additionalProperties: false } },
  { name: 'backup_start', description: 'Create an encrypted ADB backup job. Requires an explicit secret.', inputSchema: { type: 'object', properties: { deviceId: { type: 'string' }, source: { type: 'string' }, destination: { type: 'string' }, secret: { type: 'string', minLength: 12 } }, required: ['deviceId', 'source', 'destination', 'secret'], additionalProperties: false } },
  { name: 'backup_status', description: 'Read status of a backup job.', inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'], additionalProperties: false } }
] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const a = request.params.arguments as Record<string, string>;
    switch (request.params.name) {
      case 'device_list': return text(await listDevices());
      case 'device_capabilities': return text(await capabilities(a.deviceId));
      case 'device_diagnose': return text({ device: await capabilities(a.deviceId), safe: true });
      case 'backup_start': return text(await createBackup(a.deviceId, a.source, a.destination, a.secret));
      case 'backup_status': return text(await backupStatus(a.jobId));
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
  } catch (e) { throw new McpError(ErrorCode.InternalError, e instanceof Error ? e.message : String(e)); }
});
await server.connect(new StdioServerTransport());
