import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import type { UseCases } from '../../application/use-cases/index.js';
import { CATALOG, findCommand, type CommandContext, type CommandDefinition } from '../catalog.js';
import { executeCommand, type ExecutionOptions } from '../executor.js';
import { renderCompletion } from './completion.js';
import { saveReport } from './report.js';
import type { HealthReport } from '../../application/use-cases/index.js';
import { errorPayload, exitCodeFor, successPayload, type ErrorPayload } from '../responses.js';
import { startActivity, Ui, type Terminal } from './ui.js';
import { logLine, VIEWS } from './views.js';

export const SECRET_ENV_VAR = 'ANDROIDCTL_BACKUP_SECRET';

export interface CliIo {
  env: Record<string, string | undefined>;
  out(text: string): void;
  err(text: string): void;
  /** Whether stdout is an interactive terminal (human output) or a pipe (JSON). */
  isTTY?: boolean;
  /** Where spinners/progress go (stderr). Omit to disable them. */
  status?: Terminal;
  columns?: number;
  sleep?(ms: number): Promise<void>;
}

/* ── Flag mapping ─────────────────────────────────────────────────────── */

/** Input keys whose CLI flag is not just the kebab-case key. */
const FLAG_ALIASES: Record<string, string> = { deviceId: 'device', confirm: 'yes' };
const COMMAND_ALIASES: Record<string, string[]> = { capabilities: ['info'], ls: ['files', 'ls'], pull: ['files', 'pull'], push: ['files', 'push'] };

const kebab = (key: string) => key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
const flagFor = (key: string) => FLAG_ALIASES[key] ?? kebab(key);

function baseType(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodDefault || current instanceof z.ZodNullable || current instanceof z.ZodEffects) {
    current = current instanceof z.ZodEffects ? current.innerType() : current._def.innerType;
  }
  return current;
}

const GLOBAL_OPTIONS = {
  json: { type: 'boolean' },
  'no-color': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  watch: { type: 'boolean', short: 'w' },
  interval: { type: 'string' },
  follow: { type: 'boolean', short: 'f' }
} as const;

type OptionSpec = { type: 'string' | 'boolean'; short?: string };

function buildOptions(): Record<string, OptionSpec> {
  const options: Record<string, OptionSpec> = { ...GLOBAL_OPTIONS };
  for (const command of CATALOG) {
    for (const [key, schema] of Object.entries(command.input)) {
      options[flagFor(key)] = { type: baseType(schema as z.ZodTypeAny) instanceof z.ZodBoolean ? 'boolean' : 'string' };
    }
  }
  options.device.short = 'd';
  options.yes.short = 'y';
  return options;
}

const OPTIONS = buildOptions();

/* ── Help ─────────────────────────────────────────────────────────────── */

function usage(command: CommandDefinition): string {
  const positional = new Set(command.positional ?? []);
  const parts = Object.entries(command.input).map(([key, schema]) => {
    const flag = flagFor(key);
    const optional = (schema as z.ZodTypeAny).isOptional();
    const boolean = OPTIONS[flag]?.type === 'boolean';
    const text = positional.has(key) ? `<${flag}>` : boolean ? `--${flag}` : `--${flag} <${flag === 'device' ? 'id' : 'value'}>`;
    return optional ? `[${text}]` : text;
  });
  return [command.path.join(' '), ...parts].join(' ');
}

export function renderHelp(ui: Ui, filterGroup?: string): string {
  const groups = [...new Set(CATALOG.map(c => c.group))].filter(g => !filterGroup || g.toLowerCase() === filterGroup);
  const lines = [`${ui.paint(['bold', 'cyan'], 'androidctl')} — Android developer toolkit (CLI + MCP)`, '', `${ui.bold('Usage:')} androidctl <command> [options]`];
  for (const group of groups) {
    lines.push('', ui.bold(group));
    for (const c of CATALOG.filter(x => x.group === group)) {
      const tag = c.safety === 'destructive' ? ui.red(' [changes device]') : c.safety === 'write' ? ui.yellow(' [writes]') : '';
      lines.push(`  ${ui.cyan(usage(c))}`, `      ${c.summary}${tag}${c.stream ? ui.dim('  (--follow)') : ''}${c.watchable ? ui.dim('  (--watch)') : ''}`);
    }
  }
  lines.push(
    '', ui.bold('Global options'),
    '  -d, --device <id>   Target device (optional when only one is connected)',
    '  --json              Machine-readable output (default when stdout is not a terminal)',
    '  -w, --watch         Refresh a snapshot command; --interval <seconds> (default 2)',
    '  -f, --follow        Stream live output (logs)',
    '  -y, --yes           Confirm operations that change the device',
    '  --                  Everything after it is positional (e.g. androidctl shell -- ls -la /sdcard)',
    '  --no-color          Disable colours (also NO_COLOR=1)',
    '', `Backup secrets are read from ${SECRET_ENV_VAR}; --secret works but is visible in shell history.`,
    'Exit codes: 0 ok · 1 error · 2 invalid input · 3 not found · 4 device unavailable · 5 integrity · 6 confirmation required · 7 denied by policy'
  );
  return lines.join('\n');
}

function hintFor(error: ErrorPayload['error']): string | undefined {
  switch (error.code) {
    case 'DEVICE_UNAVAILABLE': return 'Unlock the phone, accept the USB debugging prompt, then run `androidctl devices`';
    case 'CONFIRMATION_REQUIRED': return 'Add --yes if you are sure';
    case 'EXTERNAL_TOOL': return 'Run `androidctl doctor` to check the toolchain';
    case 'NOT_FOUND': return /^(Device not found|No devices)/.test(error.message) ? 'Run `androidctl devices` to see what is connected' : undefined;
    default: return undefined;
  }
}

/* ── Input assembly ───────────────────────────────────────────────────── */

type Flags = Record<string, string | boolean | undefined>;

export function resolveSecret(flags: Flags, io: CliIo): string | undefined {
  if (typeof flags.secret === 'string') {
    io.err(`warning: --secret is visible in shell history and the process list; prefer ${SECRET_ENV_VAR}`);
    return flags.secret;
  }
  return io.env[SECRET_ENV_VAR];
}

function buildInput(command: CommandDefinition, flags: Flags, rest: string[], io: CliIo): Record<string, unknown> {
  const keys = Object.keys(command.input);
  const allowed = new Set([...Object.keys(GLOBAL_OPTIONS), ...keys.map(flagFor)]);
  for (const [flag, value] of Object.entries(flags)) {
    if (value !== undefined && !allowed.has(flag)) throw new ValidationError(`--${flag} is not an option of \`${command.path.join(' ')}\``);
  }
  const positional = command.positional ?? [];
  if (command.variadic && positional.length && rest.length > positional.length) {
    rest = [...rest.slice(0, positional.length - 1), rest.slice(positional.length - 1).join(' ')];
  }
  if (rest.length > positional.length) throw new ValidationError(`Unexpected argument: ${rest[positional.length]}`);

  const raw: Record<string, unknown> = {};
  for (const key of keys) {
    const value = key === 'secret' ? resolveSecret(flags, io) : flags[flagFor(key)];
    if (value !== undefined) raw[key] = value;
  }
  positional.forEach((key, i) => {
    if (rest[i] === undefined) return;
    if (raw[key] !== undefined) throw new ValidationError(`${flagFor(key)} given twice`);
    raw[key] = rest[i];
  });

  const parsed = z.object(command.input).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = String(issue.path[0] ?? '');
    const missing = issue.code === 'invalid_type' && issue.received === 'undefined';
    const label = key === 'secret' ? `--secret (or ${SECRET_ENV_VAR})` : `--${flagFor(key)}`;
    throw new ValidationError(missing ? `${label} is required` : `${label}: ${issue.message}`);
  }
  return parsed.data;
}

/* ── Runner ───────────────────────────────────────────────────────────── */

function isFailedVerification(data: unknown): boolean {
  return typeof data === 'object' && data !== null && 'valid' in data && (data as { valid: unknown }).valid === false;
}

/** Runs one CLI invocation and returns the process exit code. */
export async function runCli(argv: string[], useCases: UseCases, io: CliIo, version: string, execution: Omit<ExecutionOptions, 'channel'> = { policy: 'standard' }): Promise<number> {
  const exec = (command: CommandDefinition, ctx: CommandContext, input: Record<string, unknown>) => executeCommand(command, ctx, input, { ...execution, channel: 'cli' });
  const colorAllowed = !io.env.NO_COLOR && !argv.includes('--no-color') && (io.isTTY === true || Boolean(io.env.FORCE_COLOR));
  const ui = new Ui(colorAllowed, io.columns ?? 100);
  let json = argv.includes('--json') || io.isTTY !== true;

  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    const flags = values as Flags;
    json = flags.json === true || io.isTTY !== true;
    if (flags.version) { io.out(version); return 0; }
    if (positionals[0] === 'completion') { io.out(renderCompletion(positionals[1] ?? 'powershell')); return 0; }

    const words = COMMAND_ALIASES[positionals[0]] ? [...COMMAND_ALIASES[positionals[0]], ...positionals.slice(1)] : positionals;
    const match = findCommand(words);
    if (flags.help || positionals.length === 0 || (!match && CATALOG.some(c => c.path[0] === words[0]) && words.length === 1)) {
      io.out(renderHelp(ui, match ? undefined : CATALOG.find(c => c.path[0] === words[0])?.group.toLowerCase()));
      return 0;
    }
    if (!match) throw new ValidationError(`Unknown command: ${positionals.join(' ')}. Run androidctl --help`);

    const { command } = match;
    const input = buildInput(command, flags, match.rest, io);

    if (flags.follow) {
      if (!command.stream) throw new ValidationError(`\`${command.path.join(' ')}\` does not support --follow`);
      for await (const item of command.stream({ useCases }, input)) {
        io.out(json ? JSON.stringify(item) : logLine(item as never, ui));
      }
      return 0;
    }

    if (flags.watch) {
      if (!command.watchable) throw new ValidationError(`\`${command.path.join(' ')}\` does not support --watch`);
      const seconds = Number(flags.interval ?? 2);
      if (!Number.isFinite(seconds) || seconds < 0.5) throw new ValidationError('--interval must be at least 0.5 seconds');
      const sleep = io.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
      for (;;) {
        const data = await exec(command, { useCases }, input);
        if (json) io.out(JSON.stringify(successPayload(data)));
        else io.out(`\x1b[2J\x1b[H${render(command, data, ui)}\n\n${ui.dim(`Refreshing every ${seconds}s · Ctrl+C to stop`)}`);
        await sleep(seconds * 1000);
      }
    }

    const activity = !json && io.status ? startActivity(command.summary, io.status, ui) : undefined;
    let data: unknown;
    try {
      data = await exec(command, { useCases, onProgress: p => activity?.progress(p.doneBytes, p.totalBytes) }, input);
    } finally {
      activity?.stop();
    }
    if (command.id === 'health_report' && typeof input.output === 'string') {
      const saved = await saveReport(input.output, data as HealthReport);
      if (!json) io.err(ui.green('✔ ') + 'Report saved to ' + ui.bold(saved));
    }
    if (command.id === 'shell_exec' && !json) {
      // Behave like a shell: raw output and the remote exit code.
      const r = data as { stdout: string; stderr: string; exitCode: number; truncated: boolean };
      if (r.stdout) io.out(r.stdout.replace(/\r?\n$/, ''));
      if (r.stderr) io.err(r.stderr.replace(/\r?\n$/, ''));
      if (r.truncated) io.err(ui.yellow('▲ output truncated'));
      return r.exitCode;
    }
    io.out(json ? JSON.stringify(successPayload(data), null, 2) : render(command, data, ui));
    return isFailedVerification(data) ? 5 : 0;
  } catch (error) {
    const isArgError = typeof (error as { code?: unknown })?.code === 'string' && String((error as { code: string }).code).startsWith('ERR_PARSE_ARGS');
    const payload = errorPayload(isArgError ? new ValidationError((error as Error).message) : error);
    if (json) io.err(JSON.stringify(payload, null, 2));
    else {
      const hint = hintFor(payload.error);
      io.err(`${ui.paint(['bold', 'red'], '✖')} ${payload.error.message}${hint ? `\n  ${ui.dim('→ ' + hint)}` : ''}`);
    }
    return exitCodeFor(payload);
  }
}

function render(command: CommandDefinition, data: unknown, ui: Ui): string {
  const view = VIEWS[command.id];
  return view ? view(data, ui) : JSON.stringify(data, null, 2);
}
