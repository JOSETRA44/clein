import fs from 'node:fs/promises';
import path from 'node:path';
import { ValidationError } from '../../domain/errors.js';
import type { Finding } from '../../domain/findings.js';
import type { HealthReport } from '../../application/use-cases/index.js';
import { formatBytes } from './ui.js';

type Sectioned = Finding & { section: string };

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const get = (obj: unknown, ...keys: string[]): any => keys.reduce((o: any, k) => (o == null ? undefined : o[k]), obj); // eslint-disable-line @typescript-eslint/no-explicit-any

function facts(r: HealthReport): [string, string][] {
  const s = r.sections;
  const vol = get(s, 'storage', 'volume');
  const battery = get(s, 'vitals', 'vitals', 'battery');
  const wifi = get(s, 'network', 'status', 'wifi');
  const props = get(s, 'device', 'properties') ?? {};
  return [
    ['Device', `${r.deviceId}${props.model ? ` · ${props.manufacturer ?? ''} ${props.model}` : ''}`],
    ['Android', props.androidVersion ? `${props.androidVersion} (SDK ${props.sdk}), patch ${props.securityPatch ?? '?'}` : '—'],
    ['Storage', vol ? `${formatBytes(vol.usedBytes)} / ${formatBytes(vol.totalBytes)} used, ${formatBytes(vol.freeBytes)} free` : '—'],
    ['Battery', battery ? `${battery.levelPercent}% · ${battery.status} · ${battery.temperatureC ?? '?'} °C · health ${battery.health}` : '—'],
    ['Wi-Fi', wifi ? (wifi.connected ? `${wifi.ssid ?? 'connected'} · ${wifi.rssiDbm ?? '?'} dBm` : wifi.enabled ? 'on, not connected' : 'off') : '—'],
    ['Apps audited', String(get(s, 'permissions', 'scanned') ?? '—')]
  ];
}

export function renderMarkdown(r: HealthReport): string {
  const rows = (f: Sectioned[]) => f.map(x => `| ${x.severity} | ${x.section} | ${x.subject ?? ''} | ${x.message.replace(/\|/g, '\\|')} | ${(x.recommendation ?? '').replace(/\|/g, '\\|')} |`).join('\n');
  const apps = (get(r.sections, 'storage', 'topApps') ?? []) as { packageName: string; totalBytes: number }[];
  const risky = (get(r.sections, 'permissions', 'apps') ?? []) as { packageName: string; score: number; reasons: string[] }[];
  return [
    `# Device health report — ${r.deviceId}`,
    '',
    `**Score ${r.score}/100 (grade ${r.grade})** · generated ${r.generatedAt}`,
    '',
    ...facts(r).map(([k, v]) => `- **${k}:** ${v}`),
    '',
    '## Findings',
    '',
    r.findings.length ? `| Severity | Area | Subject | Finding | Recommendation |\n|---|---|---|---|---|\n${rows(r.findings)}` : 'No problems found.',
    '',
    '## Largest apps',
    '',
    ...apps.map(a => `- ${a.packageName}: ${formatBytes(a.totalBytes)}`),
    '',
    '## Highest-privilege apps',
    '',
    ...risky.slice(0, 10).map(a => `- ${a.packageName} (score ${a.score})${a.reasons[0] ? ` — ${a.reasons[0]}` : ''}`),
    ...(Object.keys(r.errors).length ? ['', '## Sections that could not be collected', '', ...Object.entries(r.errors).map(([k, v]) => `- ${k}: ${v}`)] : []),
    ''
  ].join('\n');
}

export function renderHtml(r: HealthReport): string {
  const color = r.score >= 75 ? '#1a7f37' : r.score >= 50 ? '#9a6700' : '#cf222e';
  const badge = (sev: string) => `<span class="sev ${sev}">${sev}</span>`;
  const findings = r.findings.map(f => `<tr><td>${badge(f.severity)}</td><td>${esc(f.section)}</td><td>${esc(f.subject)}</td><td>${esc(f.message)}${f.recommendation ? `<div class="rec">→ ${esc(f.recommendation)}</div>` : ''}</td></tr>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Device health report</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--card:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--card:#161b22}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px} h2{font-size:17px;margin:28px 0 8px}
.muted{color:var(--muted)} .score{font-size:40px;font-weight:700;color:${color}}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin-top:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.card b{display:block;font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
table{width:100%;border-collapse:collapse;font-size:14px} td{border-top:1px solid var(--line);padding:8px 6px;vertical-align:top}
.sev{font-size:12px;font-weight:700;padding:2px 8px;border-radius:99px;color:#fff}
.critical{background:#cf222e}.warning{background:#9a6700}.info{background:#0969da}
.rec{color:var(--muted);margin-top:2px} .scroll{overflow-x:auto}
</style></head><body><main>
<h1>Device health report</h1>
<div class="muted">${esc(r.deviceId)} · ${esc(r.generatedAt)}</div>
<div><span class="score">${r.score}</span> <span class="muted">/ 100 · grade ${r.grade}</span></div>
<div class="grid">${facts(r).map(([k, v]) => `<div class="card"><b>${esc(k)}</b>${esc(v)}</div>`).join('')}</div>
<h2>Findings (${r.findings.length})</h2>
<div class="scroll"><table>${findings || '<tr><td>No problems found.</td></tr>'}</table></div>
${Object.keys(r.errors).length ? `<h2>Not collected</h2><ul>${Object.entries(r.errors).map(([k, v]) => `<li><b>${esc(k)}</b>: ${esc(v)}</li>`).join('')}</ul>` : ''}
</main></body></html>`;
}

/** Writes a new .html or .md report; refuses to overwrite. */
export async function saveReport(output: string, report: HealthReport): Promise<string> {
  const target = path.resolve(output);
  const ext = path.extname(target).toLowerCase();
  if (ext !== '.html' && ext !== '.md') throw new ValidationError('Report output must end in .html or .md');
  const content = ext === '.html' ? renderHtml(report) : renderMarkdown(report);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, { encoding: 'utf8', flag: 'wx' }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ValidationError(`Refusing to overwrite existing file: ${target}`);
    throw error;
  });
  return target;
}
