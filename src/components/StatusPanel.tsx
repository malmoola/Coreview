import { useMemo, useState } from 'react';

import { useStore } from '../state/store';
import { DiscoverPanel } from './DiscoverPanel';
import { CrawlPanel } from './CrawlPanel';
import { STATUS_COLOR } from './edges/LiveEdge';
import { linkStatus } from '../health/evaluate';
import type { DeviceNodeData, HealthStatus, LinkData } from '../types/domain';
import { STATUS_GLYPH, STATUS_LABEL } from '../types/domain';

type Row = {
  id: string;
  kind: 'node' | 'link';
  name: string;
  type: string;
  target: string;
  status: HealthStatus;
  detail: string;
  rtt: number | null;
  tags: string[];
};

export function StatusPanel() {
  const open = useStore((s) => s.panelOpen);
  const setOpen = useStore((s) => s.setPanelOpen);
  const doc = useStore((s) => s.doc);
  const runtime = useStore((s) => s.runtime);
  const events = useStore((s) => s.events);
  const session = useStore((s) => s.session);
  const statusMessage = useStore((s) => s.statusMessage);
  const nodeStatusOf = useStore((s) => s.nodeStatus);
  const select = useStore((s) => s.select);

  const [tab, setTab] = useState<'objects' | 'events' | 'discover' | 'crawl'>('objects');
  const [query, setQuery] = useState('');
  const [problemsOnly, setProblemsOnly] = useState(false);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const n of doc.nodes) {
      if (n.type !== 'device') continue;
      const d = n.data as DeviceNodeData;
      const probes = doc.probes.filter((p) => p.objectId === n.id);
      const primary = probes.find((p) => p.isPrimary && p.enabled) ?? probes.find((p) => p.enabled);
      const live = primary ? runtime.get(primary.id) : undefined;
      out.push({
        id: n.id,
        kind: 'node',
        name: d.label,
        type: d.deviceType,
        target: primary?.target ?? '',
        status: nodeStatusOf(n.id),
        detail: live?.lastSummary ?? '',
        rtt: live?.lastRttMs ?? null,
        tags: d.tags ?? [],
      });
    }
    for (const e of doc.edges) {
      const d = e.data as LinkData;
      const nameOf = (id: string) =>
        (doc.nodes.find((n) => n.id === id)?.data as DeviceNodeData | undefined)?.label ?? id;
      const linkProbes = doc.probes.filter((p) => p.objectId === e.id);
      const live = linkProbes[0] ? runtime.get(linkProbes[0].id) : undefined;
      out.push({
        id: e.id,
        kind: 'link',
        name: `${nameOf(e.source)} ↔ ${nameOf(e.target)}`,
        type: d.healthRule?.type ?? 'manual',
        target: linkProbes[0]?.target ?? '',
        status: linkStatus({
          link: { enabled: d.enabled, maintenance: d.maintenance, healthRule: d.healthRule },
          sourceStatus: nodeStatusOf(e.source),
          targetStatus: nodeStatusOf(e.target),
          linkProbes,
          allProbes: doc.probes,
          runtime,
          sessionRunning: session.state === 'running',
        }),
        detail: live?.lastSummary ?? '',
        rtt: live?.lastRttMs ?? null,
        tags: [],
      });
    }
    return out;
  }, [doc, runtime, session.state, nodeStatusOf]);

  const filtered = rows.filter((r) => {
    if (problemsOnly && r.status !== 'down' && r.status !== 'warning') return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      r.name.toLowerCase().includes(q) ||
      r.target.toLowerCase().includes(q) ||
      r.type.toLowerCase().includes(q) ||
      r.status.includes(q) ||
      r.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  const filteredEvents = events.filter((e) => {
    if (problemsOnly && e.currentStatus !== 'down' && e.currentStatus !== 'warning') return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      e.objectName.toLowerCase().includes(q) ||
      (e.target ?? '').toLowerCase().includes(q) ||
      e.message.toLowerCase().includes(q)
    );
  });

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  if (!open) {
    return (
      <div className="cv-panel is-collapsed">
        <button type="button" className="cv-btn" onClick={() => setOpen(true)}>
          Show status and events
        </button>
        <span className="cv-panel-summary">
          {(['healthy', 'warning', 'down', 'unknown'] as HealthStatus[]).map((s) => (
            <span key={s} style={{ color: STATUS_COLOR[s] }}>
              {STATUS_GLYPH[s]} {counts[s] ?? 0}
            </span>
          ))}
        </span>
      </div>
    );
  }

  return (
    <div className={`cv-panel${tab === "crawl" || tab === "discover" ? " is-tall" : ""}`}>
      <div className="cv-panel-head">
        <div className="cv-tabs">
          <button
            type="button"
            className={tab === 'objects' ? 'is-active' : ''}
            onClick={() => setTab('objects')}
          >
            Monitored objects ({rows.length})
          </button>
          <button
            type="button"
            className={tab === 'events' ? 'is-active' : ''}
            onClick={() => setTab('events')}
          >
            Event timeline ({events.length})
          </button>
          <button
            type="button"
            className={tab === 'discover' ? 'is-active' : ''}
            onClick={() => setTab('discover')}
          >
            Ping sweep
          </button>
          <button
            type="button"
            className={tab === 'crawl' ? 'is-active' : ''}
            onClick={() => setTab('crawl')}
          >
            Discover devices
          </button>
        </div>

        {tab !== 'discover' && tab !== 'crawl' && (
          <>
            <input
              className="cv-input cv-panel-search"
              placeholder="Filter by name, IP, type, tag or status"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label className="cv-check cv-check-inline">
              <input
                type="checkbox"
                checked={problemsOnly}
                onChange={(e) => setProblemsOnly(e.target.checked)}
              />
              Warnings and down only
            </label>
          </>
        )}
        <button type="button" className="cv-btn cv-btn-small" onClick={() => setOpen(false)}>
          Hide
        </button>
      </div>

      {statusMessage && <div className="cv-panel-message">{statusMessage}</div>}

      <div className="cv-panel-body">
        {tab === 'discover' ? (
          <DiscoverPanel />
        ) : tab === 'crawl' ? (
          <CrawlPanel />
        ) : tab === 'objects' ? (
          <table className="cv-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Kind</th>
                <th>Name</th>
                <th>Type / rule</th>
                <th>Target</th>
                <th>RTT</th>
                <th>Last result</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  onClick={() =>
                    r.kind === 'node' ? select(r.id, null) : select(null, r.id)
                  }
                >
                  <td>
                    <span className="cv-chip" style={{ background: STATUS_COLOR[r.status] }}>
                      {STATUS_GLYPH[r.status]} {STATUS_LABEL[r.status]}
                    </span>
                  </td>
                  <td>{r.kind}</td>
                  <td>{r.name}</td>
                  <td className="cv-mono">{r.type}</td>
                  <td className="cv-mono">{r.target || '—'}</td>
                  <td className="cv-mono">{r.rtt != null ? `${r.rtt.toFixed(0)} ms` : '—'}</td>
                  <td className="cv-mono cv-ellipsis">{r.detail || '—'}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="cv-help">
                    Nothing matches this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <table className="cv-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Object</th>
                <th>Name</th>
                <th>Transition</th>
                <th>Probe</th>
                <th>Target</th>
                <th>RTT</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {filteredEvents.map((e) => (
                <tr
                  key={e.id}
                  onDoubleClick={() =>
                    void navigator.clipboard.writeText(
                      `${new Date(e.timestampMs).toISOString()} ${e.objectType} ${e.objectName} ${
                        e.previousStatus
                      } → ${e.currentStatus} ${e.target ?? ''} ${e.message}`,
                    )
                  }
                  title="Double-click to copy this event"
                >
                  <td className="cv-mono">{new Date(e.timestampMs).toLocaleTimeString()}</td>
                  <td>{e.objectType}</td>
                  <td>{e.objectName}</td>
                  <td>
                    <span style={{ color: STATUS_COLOR[e.previousStatus ?? 'unknown'] }}>
                      {STATUS_LABEL[e.previousStatus ?? 'unknown']}
                    </span>
                    {' → '}
                    <span style={{ color: STATUS_COLOR[e.currentStatus ?? 'unknown'] }}>
                      {STATUS_LABEL[e.currentStatus ?? 'unknown']}
                    </span>
                  </td>
                  <td className="cv-mono">{e.probeType ?? '—'}</td>
                  <td className="cv-mono">{e.target ?? '—'}</td>
                  <td className="cv-mono">{e.rttMs != null ? `${e.rttMs.toFixed(0)} ms` : '—'}</td>
                  <td className="cv-ellipsis">{e.message}</td>
                </tr>
              ))}
              {filteredEvents.length === 0 && (
                <tr>
                  <td colSpan={8} className="cv-help">
                    No events yet. Events are recorded when a status changes during a validation
                    session.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
