import type { ProjectMeta } from '../types/domain';
import { DEFAULTS } from '../theme';
import type { EventRow, HealthStatus } from '../types/domain';
import { STATUS_LABEL } from '../types/domain';
import { bytesToBase64, utf8ToBase64 } from './base64';
import { isDesktop } from './ipc';

/** Joins a folder and a filename with whichever separator the folder uses. */
export function joinPath(folder: string, filename: string): string {
  const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return folder.endsWith(sep) ? `${folder}${filename}` : `${folder}${sep}${filename}`;
}

/**
 * Writes an export where the user asks for it.
 *
 * In the desktop app this opens the native save dialog and hands the chosen
 * path to the backend. The `<a download>` trick it replaces looked like it
 * worked, but it writes to the *process* working directory: fine when the
 * binary is launched from a terminal, and wrong when it is launched from a
 * desktop menu, where the working directory is `/` and the write fails with
 * nothing shown to the user.
 *
 * In a plain browser there is no backend and no dialog, so the anchor stays —
 * the browser's own download handling is the right behaviour there.
 *
 * Returns the path written, or null if the user cancelled.
 */
export async function saveExport(
  filename: string,
  content: string | Uint8Array,
  mime: string,
  /** When set, the file is written straight here and no dialog appears.
   *  Backups never use this folder, and this never touches theirs. */
  folder?: string | null,
): Promise<string | null> {
  if (!isDesktop) {
    const blob = new Blob([content as BlobPart], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    return filename;
  }

  const [{ save }, { invoke }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/api/core'),
  ]);
  let path: string | null;
  if (folder) {
    // A chosen export folder is a standing answer to "where should this go",
    // so asking again every time would just be a dialog to dismiss.
    path = joinPath(folder, filename);
  } else {
    const ext = filename.slice(filename.lastIndexOf('.') + 1);
    path = await save({ defaultPath: filename, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  }
  if (!path) return null;

  const contentsB64 =
    typeof content === 'string' ? utf8ToBase64(content) : bytesToBase64(content);
  await invoke('save_export', { path, contentsB64 });
  return path;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}

/** Rasterise the SVG in a canvas. Returns a PNG data URL. */
export async function svgToPng(svg: string): Promise<string> {
  const img = new Image();
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('The diagram could not be rasterised.'));
    img.src = url;
  });
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = img.width * scale;
  canvas.height = img.height * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas rendering is unavailable.');
  ctx.fillStyle = DEFAULTS.exportPaper;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

export interface ReportInput {
  meta: ProjectMeta;
  events: EventRow[];
  counts: Record<HealthStatus, number>;
  nodeCount: number;
  linkCount: number;
  sessionStart: number | null;
  sessionEnd: number | null;
}

export function buildMarkdownReport(r: ReportInput): string {
  const line = (k: string, v: string) => `| ${k} | ${v} |`;
  const transitions = r.events
    .filter((e) => e.eventType === 'transition')
    .slice()
    .sort((a, b) => a.timestampMs - b.timestampMs);

  return `# Validation report — ${r.meta.name}

| Field | Value |
| --- | --- |
${line('Customer', r.meta.customer || '—')}
${line('Site', r.meta.site || '—')}
${line('Change ticket', r.meta.ticket || '—')}
${line('Engineer', r.meta.engineer || '—')}
${line('Report generated', new Date().toLocaleString())}
${line('Session started', r.sessionStart ? new Date(r.sessionStart).toLocaleString() : 'not recorded')}
${line('Session ended', r.sessionEnd ? new Date(r.sessionEnd).toLocaleString() : 'still running or not recorded')}

## Objects

- Nodes: ${r.nodeCount}
- Links: ${r.linkCount}

## Status summary at export

| Status | Count |
| --- | --- |
${Object.entries(r.counts)
  .map(([k, v]) => `| ${STATUS_LABEL[k as HealthStatus]} | ${v} |`)
  .join('\n')}

## State transitions (${transitions.length})

| Time | Object | Change | Probe | Target | RTT | Details |
| --- | --- | --- | --- | --- | --- | --- |
${
  transitions.length === 0
    ? '| — | — | — | — | — | — | No transitions recorded |'
    : transitions
        .map(
          (e) =>
            `| ${new Date(e.timestampMs).toLocaleTimeString()} | ${e.objectType} ${e.objectName} | ${
              e.previousStatus ?? '?'
            } → ${e.currentStatus ?? '?'} | ${e.probeType ?? '—'} | ${e.target ?? '—'} | ${
              e.rttMs != null ? `${e.rttMs.toFixed(0)} ms` : '—'
            } | ${e.message.replace(/\|/g, '\\|')} |`,
        )
        .join('\n')
}

---

**How to read this report.** Every result above was produced by a check run from
the machine where Coreview was running. A healthy result proves that
host could reach the configured target with the configured method at that
moment. It does not prove that every drawn link in the path is healthy, and it
does not prove end-to-end application traffic. Link states follow the health
rule chosen for each link, shown in the project file.
`;
}
