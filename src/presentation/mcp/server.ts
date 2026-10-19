import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { UseCases } from '../../application/use-cases/index.js';
import { CATALOG, type Safety } from '../catalog.js';
import { executeCommand, type ExecutionOptions } from '../executor.js';
import { errorPayload, successPayload } from '../responses.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/**
 * Failures are returned as tool results with `isError` (not protocol errors),
 * so the calling model can read the error code and adapt.
 */
async function respond(action: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(successPayload(await action()), null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify(errorPayload(error), null, 2) }], isError: true };
  }
}

const ANNOTATIONS: Record<Safety, { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: false }> = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
};

/** Guided workflows exposed as MCP prompts. They describe tool order and the safety rules to follow. */
const PROMPTS: Record<string, { title: string; description: string; body: (deviceId?: string) => string }> = {
  storage_cleanup: {
    title: 'Free up storage',
    description: 'Find what fills the device and propose safe ways to reclaim space',
    body: d => `Help me free storage on ${d ? `device ${d}` : 'my Android device'}.
1. Call storage_analyze and explain the volume usage, categories and findings in plain language.
2. Call storage_largest on /sdcard to find large shared files (videos, leftover exports, APKs).
3. Propose concrete actions ordered by space reclaimed. For apps whose private data dominates, recommend the app's own storage manager (the finding includes where it is).
Never delete files, clear app data or uninstall anything without my explicit approval for that specific item.`
  },
  broken_screen_rescue: {
    title: 'Operate a device with a broken screen',
    description: 'Inspect and operate a device whose display does not work, using the UI tree',
    body: d => `My phone's screen is broken${d ? ` (device ${d})` : ''}. Help me operate it.
1. Call device_list and screen_status. If USB debugging is not authorised, explain that adb cannot be used and suggest scrcpy OTG mode or a USB-C display adapter; do not suggest ways around the lock screen.
2. Use screen_wake, then ui_dump to read what is on screen, and ui_tap / input_key to navigate. Describe each screen to me before acting.
3. If a secure lock (PIN, pattern, fingerprint) is shown, stop and tell me to unlock it myself.
4. Once unlocked, offer to back up my data with backup_start (I will provide the destination and secret).`
  },
  security_audit: {
    title: 'Security review',
    description: 'Review high-privilege apps, network exposure and platform security state',
    body: d => `Review the security of ${d ? `device ${d}` : 'my Android device'}.
1. device_diagnose: report Android version, security patch age, verified boot and bootloader state.
2. perms_audit: list the highest-risk apps and explain each reason. Highlight apps I may not recognise.
3. net_status: report apps listening on the network, VPN and private DNS.
Summarise the top risks with recommended actions. Do not revoke permissions or uninstall apps unless I approve each one.`
  }
};

export interface McpOptions {
  execution?: Omit<ExecutionOptions, 'channel'>;
}

/** Every catalog entry becomes a tool, so MCP and CLI always expose the same capabilities. */
export function createMcpServer(useCases: UseCases, version: string, options: McpOptions = {}): McpServer {
  const execution: ExecutionOptions = { policy: 'standard', ...options.execution, channel: 'mcp' };
  const server = new McpServer({ name: 'androidctl', version }, {
    instructions: 'Android device toolkit. Start with device_list or health_report. Read-only tools are safe to call freely. ' +
      'Tools that change the device require confirm: true — ask the user first. Errors carry error.code; act on it instead of retrying blindly.' +
      (execution.policy === 'read-only' ? ' This server runs in read-only mode: write tools are refused.' : '')
  });

  for (const command of CATALOG.filter(c => !c.cliOnly)) {
    if (execution.policy === 'read-only' && command.safety !== 'read') continue;
    server.registerTool(command.id, {
      title: command.summary,
      description: command.description ?? command.summary,
      inputSchema: command.input,
      annotations: ANNOTATIONS[command.safety]
    }, (args: Record<string, unknown>) => respond(() => executeCommand(command, { useCases }, args, execution)));
  }

  const json = (uri: string, data: unknown) => ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] });
  server.registerResource('devices', 'androidctl://devices', { title: 'Connected devices', mimeType: 'application/json' },
    async uri => json(uri.href, await useCases.listDevices.execute()));
  server.registerResource('audit-log', 'androidctl://audit', { title: 'Recent state-changing operations', mimeType: 'application/json' },
    async uri => json(uri.href, await useCases.auditLog.execute({ limit: 100 })));
  server.registerResource('device-report', new ResourceTemplate('androidctl://device/{deviceId}/report', { list: undefined }),
    { title: 'Device health report', mimeType: 'application/json' },
    async (uri, vars) => json(uri.href, await useCases.healthReport.execute({ deviceId: String(vars.deviceId) })));

  for (const [name, prompt] of Object.entries(PROMPTS)) {
    server.registerPrompt(name, {
      title: prompt.title,
      description: prompt.description,
      argsSchema: { deviceId: z.string().optional().describe('Device id (optional with one device)') }
    }, ({ deviceId }) => ({ messages: [{ role: 'user', content: { type: 'text', text: prompt.body(deviceId) } }] }));
  }
  return server;
}
