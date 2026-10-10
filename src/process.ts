import { spawn } from 'node:child_process';
import type { CommandResult } from './types.js';

export function run(command: string, args: string[], timeoutMs = 30_000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timeout executing ${command}`)); }, timeoutMs);
    child.stdout.on('data', b => stdout += b.toString());
    child.stderr.on('data', b => stderr += b.toString());
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? -1 }); });
  });
}
