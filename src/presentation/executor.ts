import { PolicyDeniedError } from '../domain/errors.js';
import type { AuditLog } from '../application/ports.js';
import type { CommandContext, CommandDefinition } from './catalog.js';

export type Policy = 'read-only' | 'standard';

export interface ExecutionOptions {
  policy: Policy;
  audit?: AuditLog;
  channel: 'cli' | 'mcp';
  now?: () => Date;
}

/**
 * The single gate every operation passes through, for CLI and MCP alike:
 * policy check first, then the use case, then an audit entry for anything
 * that is not read-only (including denials and failures).
 */
export async function executeCommand(command: CommandDefinition, ctx: CommandContext, input: Record<string, unknown>, options: ExecutionOptions): Promise<unknown> {
  const now = options.now ?? (() => new Date());
  const record = async (outcome: 'ok' | 'error' | 'denied', error?: unknown) => {
    if (command.safety === 'read' || !options.audit) return;
    await options.audit.record({
      at: now().toISOString(),
      operation: command.id,
      safety: command.safety,
      ...(typeof input.deviceId === 'string' ? { deviceId: input.deviceId } : {}),
      input,
      outcome,
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
      channel: options.channel
    }).catch(() => undefined); // auditing must never break the operation itself
  };

  if (options.policy === 'read-only' && command.safety !== 'read') {
    const error = new PolicyDeniedError(`${command.id} is disabled: ANDROIDCTL_POLICY=read-only only allows read operations`);
    await record('denied', error);
    throw error;
  }
  try {
    const result = await command.run(ctx, input as never);
    await record('ok');
    return result;
  } catch (error) {
    await record(isConfirmationRequest(error) ? 'denied' : 'error', error);
    throw error;
  }
}

function isConfirmationRequest(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'CONFIRMATION_REQUIRED';
}
