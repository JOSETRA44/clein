import { stripVTControlCharacters, styleText } from 'node:util';
import type { Severity } from '../../domain/findings.js';

type Style = Parameters<typeof styleText>[0];

export interface Terminal {
  write(text: string): void;
  isTTY: boolean;
  columns: number;
}

/** Colour and layout helpers. Colour is disabled for pipes, NO_COLOR and --no-color. */
export class Ui {
  constructor(readonly color: boolean, readonly width = 100) {}

  paint(style: Style, text: string): string {
    return this.color ? styleText(style, text, { validateStream: false }) : text;
  }

  bold = (t: string) => this.paint('bold', t);
  dim = (t: string) => this.paint('dim', t);
  red = (t: string) => this.paint('red', t);
  green = (t: string) => this.paint('green', t);
  yellow = (t: string) => this.paint('yellow', t);
  cyan = (t: string) => this.paint('cyan', t);
  magenta = (t: string) => this.paint('magenta', t);

  heading(text: string): string {
    return `\n${this.paint(['bold', 'cyan'], text)}`;
  }

  severity(severity: Severity): string {
    switch (severity) {
      case 'critical': return this.paint(['bold', 'red'], '✖ CRITICAL');
      case 'warning': return this.paint(['bold', 'yellow'], '▲ WARNING ');
      default: return this.paint(['bold', 'blue'], '● INFO    ');
    }
  }

  /**
   * Horizontal meter. Colour turns yellow/red at `thresholds`; with `invert`
   * (higher is better, e.g. battery or progress) the scale is reversed.
   */
  meter(ratio: number, width = 24, invert = false, thresholds: [number, number] = [0.75, 0.9]): string {
    const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
    const filled = Math.round(r * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const level = invert ? 1 - r : r;
    const style: Style = level >= thresholds[1] ? 'red' : level >= thresholds[0] ? 'yellow' : 'green';
    return this.paint(style, bar);
  }

  /** ANSI-aware table: columns are padded on visible width. */
  table(headers: string[], rows: string[][], align: ('left' | 'right')[] = []): string {
    const visible = (s: string) => stripVTControlCharacters(s).length;
    const widths = headers.map((h, i) => Math.max(visible(h), ...rows.map(r => visible(r[i] ?? ''))));
    const pad = (cell: string, i: number) => {
      const gap = ' '.repeat(Math.max(0, widths[i] - visible(cell)));
      return align[i] === 'right' ? gap + cell : cell + gap;
    };
    const line = (cells: string[]) => '  ' + cells.map(pad).join('  ').trimEnd();
    return [line(headers.map(h => this.dim(h))), ...rows.map(line)].join('\n');
  }

  keyValues(pairs: [string, string | undefined][]): string {
    const shown = pairs.filter((p): p is [string, string] => p[1] !== undefined && p[1] !== '');
    const width = Math.max(0, ...shown.map(([k]) => k.length));
    return shown.map(([k, v]) => `  ${this.dim(k.padEnd(width))}  ${v}`).join('\n');
  }
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function formatAge(iso: string | undefined, now = Date.now()): string | undefined {
  if (!iso) return undefined;
  return `${formatDuration((now - Date.parse(iso)) / 1000)} ago`;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface Activity {
  progress(doneBytes: number, totalBytes?: number): void;
  stop(): void;
}

/**
 * Spinner that turns into a progress bar once byte counts arrive. Renders to
 * stderr only when it is a TTY, so piped stdout stays machine-readable.
 */
export function startActivity(label: string, term: Terminal, ui: Ui, clock: () => number = Date.now): Activity {
  if (!term.isTTY) return { progress() {}, stop() {} };
  const started = clock();
  let frame = 0;
  let done: number | undefined;
  let total: number | undefined;

  const render = () => {
    const spinner = ui.cyan(FRAMES[frame++ % FRAMES.length]);
    let line = `${spinner} ${label}`;
    if (done !== undefined) {
      const elapsed = Math.max(0.001, (clock() - started) / 1000);
      const speed = done / elapsed;
      if (total && total > 0) {
        const ratio = Math.min(1, done / total);
        const eta = speed > 0 && done < total ? `  ETA ${formatDuration((total - done) / speed)}` : '';
        line += `  ${ui.meter(ratio, 28, true)} ${(ratio * 100).toFixed(0).padStart(3)}%  ${formatBytes(done)} / ${formatBytes(total)}  ${ui.dim(`${formatBytes(speed)}/s${eta}`)}`;
      } else {
        line += `  ${formatBytes(done)}  ${ui.dim(`${formatBytes(speed)}/s`)}`;
      }
    }
    term.write(`\r\x1b[2K${line.slice(0, term.columns * 3)}`);
  };
  const timer = setInterval(render, 100);
  timer.unref?.();
  render();
  return {
    progress(d, t) { done = d; total = t ?? total; },
    stop() { clearInterval(timer); term.write('\r\x1b[2K'); }
  };
}
