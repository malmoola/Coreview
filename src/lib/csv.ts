import type { EventRow, HealthStatus, LinkHealthRuleType, ProbeKind } from '../types/domain';

/** RFC4180-ish quoting. A leading =,+,-,@ is prefixed with ' so spreadsheet
 *  software does not evaluate imported device names as formulas. */
export function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function eventsToCsv(events: EventRow[]): string {
  const header = [
    'timestamp',
    'object_type',
    'object_name',
    'previous_status',
    'current_status',
    'probe_type',
    'target',
    'rtt_ms',
    'details',
  ];
  const rows = events.map((e) => [
    new Date(e.timestampMs).toISOString(),
    e.objectType,
    e.objectName,
    e.previousStatus ?? '',
    e.currentStatus ?? '',
    e.probeType ?? '',
    e.target ?? '',
    e.rttMs ?? '',
    e.message,
  ]);
  return toCsv([header, ...rows]);
}

/** Minimal CSV reader: handles quoted fields, embedded commas and CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export interface NodeCsvRow {
  name: string;
  type: string;
  address: string;
  probeType: ProbeKind;
  port?: number;
  notes?: string;
  tags: string[];
}

export interface LinkCsvRow {
  source: string;
  target: string;
  sourcePort: string;
  targetPort: string;
  label: string;
  healthRule: LinkHealthRuleType;
}

function indexHeader(header: string[]): Map<string, number> {
  const m = new Map<string, number>();
  header.forEach((h, i) => m.set(h.trim().toLowerCase().replace(/[\s_-]/g, ''), i));
  return m;
}

export function parseNodeCsv(text: string): { rows: NodeCsvRow[]; errors: string[] } {
  const grid = parseCsv(text);
  const errors: string[] = [];
  const rows: NodeCsvRow[] = [];
  const header = grid[0];
  if (!header) return { rows, errors: ['The file is empty.'] };
  const h = indexHeader(header);
  const get = (r: string[], key: string) => {
    const i = h.get(key);
    return i == null ? '' : (r[i] ?? '').trim();
  };
  grid.slice(1).forEach((r, i) => {
    const name = get(r, 'name');
    if (!name) {
      errors.push(`Row ${i + 2}: missing name; skipped.`);
      return;
    }
    const kind = (get(r, 'probetype') || 'icmp').toLowerCase();
    rows.push({
      name,
      type: get(r, 'type') || 'generic',
      address: get(r, 'ip') || get(r, 'iphostname') || get(r, 'address') || get(r, 'hostname'),
      probeType: (['icmp', 'tcp', 'dns', 'manual'].includes(kind) ? kind : 'icmp') as ProbeKind,
      port: Number(get(r, 'port')) || undefined,
      notes: get(r, 'notes'),
      tags: get(r, 'tags')
        .split(/[;|]/)
        .map((t) => t.trim())
        .filter(Boolean),
    });
  });
  return { rows, errors };
}

export function parseLinkCsv(text: string): { rows: LinkCsvRow[]; errors: string[] } {
  const grid = parseCsv(text);
  const errors: string[] = [];
  const rows: LinkCsvRow[] = [];
  const header = grid[0];
  if (!header) return { rows, errors: ['The file is empty.'] };
  const h = indexHeader(header);
  const get = (r: string[], key: string) => {
    const i = h.get(key);
    return i == null ? '' : (r[i] ?? '').trim();
  };
  const valid: LinkHealthRuleType[] = [
    'manual',
    'follow-source',
    'follow-target',
    'both-endpoints',
    'dedicated-probe',
    'named-node-probe',
  ];
  grid.slice(1).forEach((r, i) => {
    const source = get(r, 'sourcename') || get(r, 'source');
    const target = get(r, 'targetname') || get(r, 'target');
    if (!source || !target) {
      errors.push(`Row ${i + 2}: source and target are both required; skipped.`);
      return;
    }
    const ruleRaw = (get(r, 'healthrule') || 'both-endpoints') as LinkHealthRuleType;
    rows.push({
      source,
      target,
      sourcePort: get(r, 'sourceport'),
      targetPort: get(r, 'targetport'),
      label: get(r, 'linklabel') || get(r, 'label'),
      healthRule: valid.includes(ruleRaw) ? ruleRaw : 'both-endpoints',
    });
  });
  return { rows, errors };
}

export const STATUS_ORDER: HealthStatus[] = [
  'healthy',
  'warning',
  'down',
  'unknown',
  'maintenance',
  'disabled',
];
