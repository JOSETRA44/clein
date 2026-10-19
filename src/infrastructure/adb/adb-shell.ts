import { ExternalToolError } from '../../domain/errors.js';
import { runCommand, streamCommand, type CommandResult, type RunOptions, type StreamingCommand } from '../process/command-runner.js';

const DEFAULT_TIMEOUT_MS = 60_000;

/** Thin, serial-scoped wrapper around the adb binary shared by every adb adapter. */
export class AdbShell {
  constructor(readonly adbPath: string) {}

  run(args: readonly string[], timeoutMs: number | undefined = DEFAULT_TIMEOUT_MS, extra: Omit<RunOptions, 'timeoutMs'> = {}): Promise<CommandResult> {
    return runCommand(this.adbPath, args, { timeoutMs, ...extra });
  }

  /** Runs a device-side script; the result carries the remote exit code (shell protocol v2). */
  exec(deviceId: string, script: string, timeoutMs?: number): Promise<CommandResult> {
    return this.run(['-s', deviceId, 'shell', script], timeoutMs);
  }

  /** Like `exec`, but a non-zero exit becomes an ExternalToolError. */
  async text(deviceId: string, script: string, timeoutMs?: number): Promise<string> {
    const result = await this.exec(deviceId, script, timeoutMs);
    if (result.code !== 0) {
      throw new ExternalToolError(`Device command failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().split('\n')[0] || script}`);
    }
    return result.stdout;
  }

  /** Binary-safe stdout stream. The remote exit code is NOT available through exec-out. */
  binary(deviceId: string, script: string): StreamingCommand {
    return streamCommand(this.adbPath, ['-s', deviceId, 'exec-out', script]);
  }
}

/** Splits `@@NAME` delimited sections produced by multi-command scripts. */
export function splitSections(stdout: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current = '';
  for (const line of stdout.split(/\r?\n/)) {
    const marker = /^@@([A-Z_]+)$/.exec(line.trim());
    if (marker) { current = marker[1]; sections[current] = ''; continue; }
    if (current) sections[current] += `${line}\n`;
  }
  return sections;
}
