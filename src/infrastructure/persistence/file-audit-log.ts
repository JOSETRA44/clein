import fs from 'node:fs/promises';
import path from 'node:path';
import type { AuditEntry, AuditLog } from '../../application/ports.js';

const SECRET_KEYS = /secret|pin|password|code|token/i;

/** Replaces values of secret-looking fields so the log is safe to share when reporting issues. */
export function redact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, SECRET_KEYS.test(k) && v !== undefined ? '[redacted]' : v]));
}

/** Append-only JSON Lines file: one state-changing operation per line. */
export class FileAuditLog implements AuditLog {
  constructor(private readonly file: string) {}

  async record(entry: AuditEntry): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.appendFile(this.file, JSON.stringify({ ...entry, input: redact(entry.input) }) + '\n', 'utf8');
  }

  async recent(limit: number): Promise<AuditEntry[]> {
    const text = await fs.readFile(this.file, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    });
    return text.trim().split('\n').filter(Boolean).slice(-limit).flatMap(line => {
      try { return [JSON.parse(line) as AuditEntry]; } catch { return []; }
    }).reverse();
  }
}
