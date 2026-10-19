/**
 * Classifies device shell commands before they run. The policy is
 * conservative: anything not recognised as read-only needs confirmation, and
 * a short list of operations that can brick or wipe a device is refused
 * outright, regardless of confirmation.
 */
export type CommandRisk = 'read' | 'write' | 'blocked';

export interface CommandAssessment {
  risk: CommandRisk;
  reasons: string[];
}

const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'wc', 'sort', 'uniq', 'cut', 'tr', 'awk', 'sed', 'echo', 'printf', 'true', 'false',
  'getprop', 'dumpsys', 'ps', 'top', 'df', 'du', 'find', 'stat', 'file', 'id', 'whoami', 'uname', 'uptime', 'date', 'which',
  'ip', 'ifconfig', 'ping', 'ping6', 'netstat', 'ss', 'nproc', 'free', 'env', 'printenv', 'pwd', 'readlink', 'realpath',
  'md5sum', 'sha1sum', 'sha256sum', 'getenforce', 'wm', 'screencap', 'logcat', 'dmesg', 'lsof', 'service', 'test', '['
]);

/** Subcommands that are read-only for multi-purpose tools. */
const READ_ONLY_SUBCOMMANDS: Record<string, RegExp> = {
  pm: /^(list|path|dump|resolve-activity|query-activities|get-\S+)\b/,
  cmd: /^(package\s+(list|resolve-activity|query-\S+)|wifi\s+status|connectivity\s+\S*status|appops\s+get|battery\s+get|stats\s+print\S*)\b/,
  settings: /^(get|list)\b/,
  am: /^(stack\s+list|get-\S+|task\s+list)\b/,
  // Exact: `wm size 720x1600` would change the display.
  wm: /^(size|density)\s*$/,
  appops: /^get\b/,
  dumpsys: /.*/,
  logcat: /^(?!.*\s-c\b)/
};

const BLOCKED: [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)+(-\S+\s+)*\/(\s|$|\*)/, 'Recursive delete of the filesystem root'],
  [/\bdd\b.*\bof=\/dev\/block/, 'Raw write to a block device'],
  [/\bmkfs(\.\w+)?\b|\bmke2fs\b|\bmake_f2fs\b/, 'Formats a partition'],
  [/\bblkdiscard\b|\bsgdisk\b|\bfdisk\b|\bparted\b/, 'Partition table or block discard operation'],
  [/\brecovery\b.*--wipe_data|\bam\s+broadcast\b.*MASTER_CLEAR|\bcmd\s+device_policy\b.*wipe/i, 'Factory reset'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'Fork bomb']
];

/** Splits on shell control operators; quotes are respected well enough for classification. */
function segments(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) { if (c === quote) quote = undefined; current += c; continue; }
    if (c === '"' || c === "'") { quote = c; current += c; continue; }
    if (c === ';' || c === '|' || c === '&' || c === '\n') { parts.push(current); current = ''; continue; }
    current += c;
  }
  parts.push(current);
  return parts.map(p => p.trim()).filter(Boolean);
}

export function assessShellCommand(command: string): CommandAssessment {
  const reasons: string[] = [];
  for (const [pattern, reason] of BLOCKED) if (pattern.test(command)) return { risk: 'blocked', reasons: [reason] };

  // Output redirection or command substitution can write anywhere or hide a second command.
  const unquoted = command.replace(/'[^']*'|"[^"]*"/g, '');
  if (/(^|[^>&0-9])>{1,2}(?!&)\s*(?!\/dev\/null)/.test(unquoted) || /\d>\s*(?!\/dev\/null|&)/.test(unquoted)) reasons.push('Redirects output to a file');
  if (/\$\(|`/.test(unquoted)) reasons.push('Uses command substitution');

  for (const segment of segments(command)) {
    const words = segment.replace(/^(\w+=\S*\s+)+/, '').split(/\s+/);
    const tool = words[0].split('/').pop() ?? '';
    const rest = words.slice(1).join(' ');
    if (tool === 'su') { reasons.push('Runs as root'); continue; }
    const sub = READ_ONLY_SUBCOMMANDS[tool];
    if (sub) { if (!sub.test(rest)) reasons.push(`\`${tool} ${words[1] ?? ''}\` may change device state`); continue; }
    if (!READ_ONLY_COMMANDS.has(tool)) reasons.push(`\`${tool}\` is not on the read-only list`);
    if (tool === 'sed' && /\s-i\b/.test(segment)) reasons.push('`sed -i` edits files in place');
    if (tool === 'find' && /\s-(delete|exec)\b/.test(segment)) reasons.push('`find -delete/-exec` can modify files');
  }
  return { risk: reasons.length ? 'write' : 'read', reasons };
}
