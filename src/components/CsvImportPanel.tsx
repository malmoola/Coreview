import { useState } from 'react';

import { useStore, type TopoEdge } from '../state/store';
import { ipc, isDesktop } from '../lib/ipc';
import { parseLinkCsv, parseNodeCsv, type LinkCsvRow, type NodeCsvRow } from '../lib/csv';
import { makeDeviceNode } from './Canvas';
import { newProbe } from '../lib/probes';
import { uid } from '../lib/id';
import { DEVICE_LABEL } from './icons';
import type { DeviceNodeData, DeviceType, LinkData } from '../types/domain';

type Parsed =
  | { kind: 'nodes'; rows: NodeCsvRow[]; errors: string[] }
  | { kind: 'links'; rows: LinkCsvRow[]; errors: string[] };

/** Matches a CSV `type` column to a device glyph, by label or by id. */
function deviceType(raw: string): DeviceType {
  const want = raw.trim().toLowerCase().replace(/[\s_]/g, '-');
  const ids = Object.keys(DEVICE_LABEL) as DeviceType[];
  return (
    ids.find((id) => id === want) ??
    ids.find((id) => DEVICE_LABEL[id].toLowerCase() === raw.trim().toLowerCase()) ??
    'generic'
  );
}

/**
 * Building a diagram from a spreadsheet.
 *
 * Most people arrive with an inventory before they arrive with a network they
 * can crawl — a rack list, an IPAM export, a handover document. This reads
 * one, so the first diagram does not have to be drawn device by device.
 *
 * Nodes and links are separate files because they are separate shapes, and one
 * file with both would mean guessing which columns belong to which. Which of
 * the two a file holds is worked out from its header rather than asked, since
 * the header already says.
 */
export function CsvImportPanel() {
  const store = useStore();
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const read = async () => {
    setProblem(null);
    setDone(null);
    try {
      const path = await ipc.pickCsvFile();
      if (!path) return;
      const text = await ipc.readImport(path);
      const header = (text.split(/\r?\n/)[0] ?? '').toLowerCase();
      // The header says which shape this is; asking would be asking about
      // something already written down.
      const looksLikeLinks = /(^|,)\s*"?source/.test(header) && /target/.test(header);
      setSource(path);
      setParsed(
        looksLikeLinks
          ? { kind: 'links', ...parseLinkCsv(text) }
          : { kind: 'nodes', ...parseNodeCsv(text) },
      );
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  };

  const addNodes = (rows: NodeCsvRow[]) => {
    const bottom = store.doc.nodes.reduce((m, n) => Math.max(m, n.position.y + 120), 0);
    rows.forEach((r, i) => {
      const node = makeDeviceNode(deviceType(r.type), 80 + (i % 6) * 230, bottom + 80 + Math.floor(i / 6) * 140);
      const d = node.data as DeviceNodeData;
      d.label = r.name;
      d.tags = r.tags;
      if (r.notes) d.notes = r.notes;
      if (r.address) {
        d.addresses = [{ id: uid(), label: 'Imported', address: r.address, isPrimary: true }];
      }
      store.addNode(node);
      // An address in the sheet is there to be watched; a row without one is a
      // box on the diagram and nothing more, so it gets no probe.
      if (r.address && store.meta) {
        const probe = newProbe('node', node.id, store.meta.id, r.address, 'Imported');
        probe.kind = r.probeType;
        if (r.probeType === 'tcp') probe.tcpPort = r.port ?? 443;
        store.upsertProbe(probe);
      }
    });
    setDone(`Added ${rows.length} device${rows.length === 1 ? '' : 's'}.`);
  };

  const addLinks = (rows: LinkCsvRow[]) => {
    // Names, because a spreadsheet has no way to know the ids this app
    // generates. Matched case-insensitively: a sheet and a diagram rarely
    // agree on capitalisation.
    const byName = new Map(
      store.doc.nodes
        .filter((n) => n.type === 'device')
        .map((n) => [String((n.data as DeviceNodeData).label).trim().toLowerCase(), n.id]),
    );
    let added = 0;
    const missing: string[] = [];
    for (const r of rows) {
      const s = byName.get(r.source.trim().toLowerCase());
      const t = byName.get(r.target.trim().toLowerCase());
      if (!s || !t) {
        missing.push(!s ? r.source : r.target);
        continue;
      }
      const data: LinkData = {
        sourcePortLabel: r.sourcePort,
        targetPortLabel: r.targetPort,
        label: r.label,
        pathType: 'smoothstep',
        direction: 'forward',
        width: 2,
        color: '#5b6b7c',
        enabled: true,
        maintenance: false,
        healthRule: { type: r.healthRule },
      };
      store.addEdge({
        id: uid(),
        source: s,
        target: t,
        sourceHandle: 'b',
        targetHandle: 't',
        type: 'live',
        data,
      } as TopoEdge);
      added += 1;
    }
    const unmatched = [...new Set(missing)];
    setDone(
      `Added ${added} link${added === 1 ? '' : 's'}.` +
        (unmatched.length
          ? ` ${unmatched.length} skipped — no device on the diagram called ${unmatched
              .slice(0, 3)
              .map((n) => `"${n}"`)
              .join(', ')}${unmatched.length > 3 ? '…' : ''}.`
          : ''),
    );
  };

  const apply = () => {
    if (!parsed) return;
    setDone(null);
    if (parsed.kind === 'nodes') addNodes(parsed.rows);
    else addLinks(parsed.rows);
    setParsed(null);
    setSource(null);
  };

  if (!isDesktop) {
    return (
      <p className="cv-help cv-discover-empty">
        Reading a file needs the desktop app.
      </p>
    );
  }

  return (
    <div className="cv-discover">
      <div className="cv-discover-form">
        <button type="button" className="cv-btn cv-btn-start" onClick={() => void read()}>
          Choose a CSV
        </button>
        <span className="cv-help">
          A device list needs a <code>name</code> column; <code>type</code>, <code>ip</code>,
          <code> probe type</code>, <code>port</code>, <code>tags</code> and <code>notes</code> are
          used when present. A link list needs <code>source</code> and <code>target</code>, matched
          against the names already on the diagram.
        </span>
      </div>

      {problem && <p className="cv-discover-problem">{problem}</p>}
      {done && <p className="cv-help">{done}</p>}

      {parsed && (
        <>
          <p className="cv-help">
            {source} — {parsed.rows.length} {parsed.kind === 'nodes' ? 'device' : 'link'}
            {parsed.rows.length === 1 ? '' : 's'} read
            {parsed.errors.length > 0 && `, ${parsed.errors.length} row skipped`}
          </p>

          {parsed.errors.length > 0 && (
            <details className="cv-discover-failures">
              <summary>
                {parsed.errors.length} row{parsed.errors.length === 1 ? '' : 's'} could not be read
              </summary>
              <ul>
                {parsed.errors.slice(0, 20).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </details>
          )}

          {parsed.rows.length > 0 && (
            <>
              <div className="cv-discover-actions">
                <button type="button" className="cv-btn cv-btn-start" onClick={apply}>
                  Add {parsed.rows.length} to diagram
                </button>
                <button
                  type="button"
                  className="cv-btn"
                  onClick={() => {
                    setParsed(null);
                    setSource(null);
                  }}
                >
                  Cancel
                </button>
              </div>

              <table className="cv-table cv-discover-table">
                <thead>
                  {parsed.kind === 'nodes' ? (
                    <tr>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Address</th>
                      <th>Check</th>
                      <th>Tags</th>
                    </tr>
                  ) : (
                    <tr>
                      <th>Source</th>
                      <th>Target</th>
                      <th>Ports</th>
                      <th>Label</th>
                      <th>Health rule</th>
                    </tr>
                  )}
                </thead>
                <tbody>
                  {parsed.kind === 'nodes'
                    ? parsed.rows.slice(0, 200).map((r, i) => (
                        <tr key={`${r.name}-${i}`}>
                          <td>{r.name}</td>
                          <td>{DEVICE_LABEL[deviceType(r.type)]}</td>
                          <td className="cv-mono">{r.address || '—'}</td>
                          <td>
                            {r.address
                              ? `${r.probeType}${r.probeType === 'tcp' ? `:${r.port ?? 443}` : ''}`
                              : 'none'}
                          </td>
                          <td>{r.tags.join(', ') || '—'}</td>
                        </tr>
                      ))
                    : parsed.rows.slice(0, 200).map((r, i) => (
                        <tr key={`${r.source}-${r.target}-${i}`}>
                          <td>{r.source}</td>
                          <td>{r.target}</td>
                          <td className="cv-mono">
                            {r.sourcePort || '—'} / {r.targetPort || '—'}
                          </td>
                          <td>{r.label || '—'}</td>
                          <td>{r.healthRule}</td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  );
}
