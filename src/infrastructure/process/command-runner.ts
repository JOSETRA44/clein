import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ExternalToolError } from '../../domain/errors.js';

export interface RunOptions {
  /** Omit for commands that may legitimately run for a long time. */
  timeoutMs?: number;
  /** Written to stdin, then closed. Keeps secrets (pairing codes) out of argv. */
  input?: string;
  /** Stop collecting (and kill the process) once stdout+stderr exceed this many characters. */
  maxOutput?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  truncated?: boolean;
}

/** Launches an interactive tool (e.g. scrcpy) attached to this terminal and resolves with its exit code. */
export function runInteractive(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: false, shell: false });
    child.on('error', error => reject(launchError(command, error)));
    child.on('close', code => resolve(code ?? -1));
  });
}

function spawnTool(command: string, args: readonly string[]): ChildProcessWithoutNullStreams {
  return spawn(command, args, { windowsHide: true, shell: false });
}

function launchError(command: string, error: NodeJS.ErrnoException): ExternalToolError {
  const hint = error.code === 'ENOENT' ? ' (not found; check the ANDROIDCTL_*_PATH variables or the Android SDK location)' : '';
  return new ExternalToolError(`Cannot run ${command}${hint}: ${error.message}`, { cause: error });
}

export function runCommand(command: string, args: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawnTool(command, args);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      child.kill();
      settle(() => reject(new ExternalToolError(`Timed out after ${options.timeoutMs} ms: ${command} ${args.join(' ')}`)));
    }, options.timeoutMs);

    let truncated = false;
    const collect = (append: (text: string) => void) => (text: string) => {
      if (truncated) return;
      append(text);
      if (options.maxOutput !== undefined && stdout.length + stderr.length > options.maxOutput) {
        truncated = true;
        stdout = stdout.slice(0, options.maxOutput);
        child.kill();
      }
    };
    child.stdout.setEncoding('utf8').on('data', collect(t => { stdout += t; }));
    child.stderr.setEncoding('utf8').on('data', collect(t => { stderr += t; }));
    child.on('error', error => settle(() => reject(launchError(command, error))));
    child.on('close', code => settle(() => resolve({ stdout, stderr, code: code ?? -1, ...(truncated ? { truncated } : {}) })));
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export interface StreamingCommand {
  stdout: AsyncIterable<Uint8Array>;
  /** Resolves with the exit code and captured stderr once the process exits. */
  exit: Promise<{ code: number; stderr: string }>;
}

/**
 * Starts a binary-output command. Stopping iteration early (break/throw)
 * kills the process so a failing consumer never leaves orphans behind.
 */
export function streamCommand(command: string, args: readonly string[]): StreamingCommand {
  const child = spawnTool(command, args);
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (text: string) => { stderr += text; });
  const exit = new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    child.on('error', error => reject(launchError(command, error)));
    child.on('close', code => resolve({ code: code ?? -1, stderr }));
  });
  exit.catch(() => undefined);

  async function* chunks(): AsyncGenerator<Uint8Array> {
    let finished = false;
    try {
      for await (const chunk of child.stdout) yield chunk as Uint8Array;
      finished = true;
      await exit;
    } finally {
      if (!finished) child.kill();
    }
  }
  return { stdout: chunks(), exit };
}
