import { ValidationError } from './errors.js';
import { sortFindings, type Finding, type Severity } from './findings.js';

/* ── Processes ───────────────────────────────────────────────────────── */

export interface ProcessInfo {
  pid: number;
  user: string;
  state?: string;
  cpuPercent: number;
  memPercent?: number;
  residentBytes: number;
  name: string;
}

export type ProcessSort = 'cpu' | 'mem';

export function sortProcesses(processes: ProcessInfo[], by: ProcessSort): ProcessInfo[] {
  return [...processes].sort((a, b) => by === 'cpu' ? b.cpuPercent - a.cpuPercent || b.residentBytes - a.residentBytes : b.residentBytes - a.residentBytes);
}

/* ── Screen and input ────────────────────────────────────────────────── */

export interface ScreenState {
  awake: boolean | undefined;
  locked: boolean | undefined;
  widthPx?: number;
  heightPx?: number;
  densityDpi?: number;
  screenOffTimeoutMs?: number;
  stayAwakeWhilePlugged?: boolean;
}

/** Friendly names for `input keyevent`. */
export const KEYCODES: Record<string, number> = {
  home: 3, back: 4, call: 5, endcall: 6, up: 19, down: 20, left: 21, right: 22, center: 23, 'volume-up': 24, 'volume-down': 25,
  power: 26, camera: 27, tab: 61, space: 62, enter: 66, delete: 67, menu: 82, search: 84, 'play-pause': 85, mute: 164,
  'app-switch': 187, wakeup: 224, sleep: 223, escape: 111, 'move-home': 122, 'move-end': 123, 'notifications': 83
};

export function resolveKeycode(key: string): number {
  const named = KEYCODES[key.toLowerCase()];
  if (named !== undefined) return named;
  if (/^\d{1,3}$/.test(key)) return Number(key);
  if (/^KEYCODE_[A-Z0-9_]+$/.test(key)) throw new ValidationError(`Use a friendly key name or numeric code (got ${key}); known: ${Object.keys(KEYCODES).join(', ')}`);
  throw new ValidationError(`Unknown key: ${key}. Known: ${Object.keys(KEYCODES).join(', ')}`);
}

export function assertCoordinate(value: number, max: number | undefined, axis: string): void {
  if (!Number.isInteger(value) || value < 0 || (max !== undefined && value >= max)) {
    throw new ValidationError(`${axis}=${value} is outside the screen${max ? ` (0–${max - 1})` : ''}`);
  }
}

/** `input text` treats spaces and shell metacharacters specially; this is the subset it can type reliably. */
export function assertTypeableText(text: string): void {
  if (!text) throw new ValidationError('Text is empty');
  if (text.length > 1000) throw new ValidationError('Text is longer than 1000 characters');
  if (/[\0\r\n]/.test(text)) throw new ValidationError('Text must be a single line; send `key enter` separately');
  if (/[^\x20-\x7E]/.test(text)) throw new ValidationError('`input text` only types printable ASCII');
}

/* ── UI hierarchy (uiautomator) ──────────────────────────────────────── */

export interface UiElement {
  index: number;
  text: string;
  resourceId: string;
  contentDesc: string;
  className: string;
  packageName: string;
  clickable: boolean;
  enabled: boolean;
  focused: boolean;
  checked: boolean;
  password: boolean;
  bounds: { left: number; top: number; right: number; bottom: number };
}

export interface UiSelector {
  text?: string;
  id?: string;
  desc?: string;
  /** Substring match instead of exact (case-insensitive). */
  contains?: boolean;
}

export function centerOf(element: UiElement): { x: number; y: number } {
  return { x: Math.round((element.bounds.left + element.bounds.right) / 2), y: Math.round((element.bounds.top + element.bounds.bottom) / 2) };
}

export function assertSelector(selector: UiSelector): void {
  if (!selector.text && !selector.id && !selector.desc) throw new ValidationError('Give --text, --id or --desc to select an element');
}

export function matchElements(elements: UiElement[], selector: UiSelector): UiElement[] {
  const eq = (value: string, wanted: string | undefined) =>
    wanted === undefined || (selector.contains ? value.toLowerCase().includes(wanted.toLowerCase()) : value.toLowerCase() === wanted.toLowerCase());
  const idMatches = (value: string) => selector.id === undefined || value === selector.id || value.endsWith(`:id/${selector.id}`);
  const matches = elements.filter(e => eq(e.text, selector.text) && eq(e.contentDesc, selector.desc) && idMatches(e.resourceId));
  // Prefer elements a user could actually tap, then the smallest (most specific) one.
  const area = (e: UiElement) => (e.bounds.right - e.bounds.left) * (e.bounds.bottom - e.bounds.top);
  return matches.sort((a, b) => Number(b.clickable && b.enabled) - Number(a.clickable && a.enabled) || area(a) - area(b));
}

/* ── Power ───────────────────────────────────────────────────────────── */

export type RebootTarget = 'system' | 'recovery' | 'bootloader' | 'sideload';

/* ── Health report ───────────────────────────────────────────────────── */

const PENALTY: Record<Severity, number> = { critical: 25, warning: 8, info: 0 };

/** 100 = nothing to report. Each critical costs 25 points, each warning 8. */
export function healthScore(findings: Finding[]): { score: number; grade: 'A' | 'B' | 'C' | 'D' | 'F' } {
  const score = Math.max(0, 100 - findings.reduce((n, f) => n + PENALTY[f.severity], 0));
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
  return { score, grade };
}

export function mergeFindings(...groups: { section: string; findings: Finding[] }[]): (Finding & { section: string })[] {
  return sortFindings(groups.flatMap(g => g.findings.map(f => ({ ...f, section: g.section })))) as (Finding & { section: string })[];
}
