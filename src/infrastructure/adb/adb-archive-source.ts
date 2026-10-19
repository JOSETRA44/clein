import crypto from 'node:crypto';
import { ExternalToolError } from '../../domain/errors.js';
import type { ArchiveOutcome, ArchiveStream, DeviceArchiveSource } from '../../application/ports.js';
import { runCommand, streamCommand } from '../process/command-runner.js';
import { shellQuote, splitDevicePath } from './shell-quote.js';

const DEVICE_TMP = '/data/local/tmp';

/**
 * Streams `tar` from the device through `adb exec-out`.
 *
 * `exec-out` is the only binary-safe channel (`adb shell` mangles bytes), but
 * it discards the remote exit code and stderr. The archiver therefore writes
 * both to scratch files on the device, collected with `adb shell` afterwards.
 */
export class AdbArchiveSource implements DeviceArchiveSource {
  constructor(private readonly adbPath: string) {}

  async open(deviceId: string, devicePath: string): Promise<ArchiveStream> {
    const { parent, name } = splitDevicePath(devicePath);
    const scratch = `${DEVICE_TMP}/androidctl-${crypto.randomUUID()}`;
    const status = shellQuote(`${scratch}.status`);
    const errors = shellQuote(`${scratch}.err`);
    const script = `tar -cf - -C ${shellQuote(parent)} ${shellQuote(name)} 2>${errors}; echo $? >${status}`;
    const command = streamCommand(this.adbPath, ['-s', deviceId, 'exec-out', script]);

    let outcome: Promise<ArchiveOutcome> | undefined;
    return {
      chunks: command.stdout,
      outcome: () => (outcome ??= this.collectOutcome(deviceId, command.exit, status, errors))
    };
  }

  async estimateSize(deviceId: string, devicePath: string): Promise<number | undefined> {
    // Trailing slash follows symlinked dirs such as /sdcard; the fallback covers plain files.
    const dir = shellQuote(devicePath.endsWith('/') ? devicePath : `${devicePath}/`);
    const script = `du -sk ${dir} 2>/dev/null || du -sk ${shellQuote(devicePath)} 2>/dev/null`;
    const result = await runCommand(this.adbPath, ['-s', deviceId, 'shell', script], { timeoutMs: 120_000 });
    const kb = Number.parseInt(result.stdout.trim().split(/\s+/)[0] ?? '', 10);
    return Number.isFinite(kb) ? kb * 1024 : undefined;
  }

  private async collectOutcome(deviceId: string, exit: Promise<{ code: number; stderr: string }>, status: string, errors: string): Promise<ArchiveOutcome> {
    const transport = await exit;
    if (transport.code !== 0) {
      throw new ExternalToolError(`adb exec-out failed on ${deviceId}: ${transport.stderr.trim() || `exit ${transport.code}`}`);
    }
    const report = await runCommand(
      this.adbPath,
      ['-s', deviceId, 'shell', `cat ${status} 2>/dev/null; echo ---; cat ${errors} 2>/dev/null; rm -f ${status} ${errors}`],
      { timeoutMs: 30_000 }
    );
    return parseArchiverReport(report.stdout);
  }
}

/** Parses `<exit status>\n---\n<stderr lines>` as produced by the report command. */
export function parseArchiverReport(stdout: string): ArchiveOutcome {
  const lines = stdout.split(/\r?\n/);
  const separator = lines.indexOf('---');
  const statusText = separator < 0 ? '' : lines.slice(0, separator).join('').trim();
  const diagnostics = (separator < 0 ? lines : lines.slice(separator + 1)).map(l => l.trim()).filter(Boolean);
  if (!/^\d+$/.test(statusText)) return { exitCode: -1, diagnostics: ['Archiver exit status unavailable', ...diagnostics] };
  return { exitCode: Number(statusText), diagnostics };
}
