/** A conclusion drawn from measurements, ranked so every UI can sort and colour it the same way. */
export type Severity = 'info' | 'warning' | 'critical';

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  recommendation?: string;
  subject?: string;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

export function worstSeverity(findings: Finding[]): Severity | undefined {
  return sortFindings(findings)[0]?.severity;
}
