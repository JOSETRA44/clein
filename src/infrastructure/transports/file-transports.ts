import { ExternalToolError } from '../../domain/errors.js';
import type { FileTransport } from '../../application/ports.js';
import { runCommand, type CommandResult } from '../process/command-runner.js';
import { shellQuote } from '../adb/shell-quote.js';

function ensureOk(result: CommandResult, action: string): CommandResult {
  if (result.code !== 0) throw new ExternalToolError(`${action} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  return result;
}

export class AdbFileTransport implements FileTransport {
  constructor(private readonly adbPath: string) {}

  async list(deviceId: string, devicePath: string): Promise<string> {
    const result = await runCommand(this.adbPath, ['-s', deviceId, 'shell', `ls -la -- ${shellQuote(devicePath)}`], { timeoutMs: 30_000 });
    return ensureOk(result, `ls ${devicePath}`).stdout;
  }

  async pull(deviceId: string, devicePath: string, localPath: string): Promise<void> {
    ensureOk(await runCommand(this.adbPath, ['-s', deviceId, 'pull', devicePath, localPath]), `pull ${devicePath}`);
  }

  async push(deviceId: string, localPath: string, devicePath: string): Promise<void> {
    ensureOk(await runCommand(this.adbPath, ['-s', deviceId, 'push', localPath, devicePath]), `push ${localPath}`);
  }
}

/** Placeholder until Windows Portable Devices integration exists. */
export class MtpFileTransport implements FileTransport {
  private unavailable(): never {
    throw new ExternalToolError('MTP adapter requires Windows Portable Device integration; not available in this build');
  }
  async list(): Promise<string> { this.unavailable(); }
  async pull(): Promise<void> { this.unavailable(); }
  async push(): Promise<void> { this.unavailable(); }
}

export function startScrcpy(scrcpyPath: string, deviceId: string, args: string[] = []): Promise<CommandResult> {
  return runCommand(scrcpyPath, ['-s', deviceId, ...args]);
}
