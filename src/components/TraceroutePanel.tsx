import { useEffect, useState } from 'react';
import { ipc, type TracerouteHopDto } from '../lib/ipc';
import { changedHops } from '../lib/tracerouteDiff';

/** LT-093: the previous run's hops, per target, for this session only —
 *  not persisted, not a history, just "what did this look like last time"
 *  so the next run against the same target can be compared against it. */
const lastRunByTarget = new Map<string, TracerouteHopDto[]>();

/**
 * LT-090: an on-demand path snapshot for one target — not a scheduled probe,
 * nothing logged. Useful mid-drill when a device is not reaching the backup
 * site and the question is where the traffic is actually going.
 */
export function TraceroutePanel({ target, onClose }: { target: string; onClose: () => void }) {
  const [hops, setHops] = useState<TracerouteHopDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState<Set<number>>(new Set());
  const [hadPreviousRun, setHadPreviousRun] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHops(null);
    setError(null);
    setChanged(new Set());
    ipc
      .traceroute(target)
      .then((r) => {
        if (cancelled) return;
        const previous = lastRunByTarget.get(target) ?? null;
        setHadPreviousRun(previous != null);
        setChanged(changedHops(previous, r.hops));
        lastRunByTarget.set(target, r.hops);
        setHops(r.hops);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  return (
    <div className="cv-help-scrim" onClick={onClose} role="presentation">
      <div
        className="cv-help-card cv-tr-card"
        role="dialog"
        aria-label={`Traceroute to ${target}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cv-help-head">
          <h2>
            Traceroute to <span className="cv-mono">{target}</span>
          </h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {!hops && !error && <p className="cv-field-hint">Tracing the path — this can take a few seconds…</p>}
        {error && <p className="cv-field-hint is-danger">{error}</p>}
        {hops && hops.length === 0 && (
          <p className="cv-field-hint">No hops came back at all.</p>
        )}
        {hops && hops.length > 0 && (
          <>
            <p className="cv-field-hint">
              {!hadPreviousRun
                ? 'First trace to this target this session.'
                : changed.size > 0
                  ? `Path changed at ${changed.size} hop${changed.size === 1 ? '' : 's'} since the last trace — highlighted below.`
                  : 'Same path as the last trace to this target.'}
            </p>
            <table className="cv-tr-table">
              <thead>
                <tr>
                  <th>Hop</th>
                  <th>Router</th>
                  <th>RTT</th>
                </tr>
              </thead>
              <tbody>
                {hops.map((hop) => (
                  <TraceHopRow key={hop.hop} hop={hop} changed={changed.has(hop.hop)} />
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

function TraceHopRow({ hop, changed }: { hop: TracerouteHopDto; changed: boolean }) {
  // Consecutive probes from the same router are grouped onto one line, the
  // way the raw traceroute text does; a router that changes mid-hop (an
  // ECMP path) gets its own line, so a path that changed after a failover
  // is visible at a glance rather than flattened into one cell.
  const groups: { host: string | null; rtts: (number | null)[] }[] = [];
  for (const p of hop.probes) {
    const last = groups[groups.length - 1];
    if (last && last.host === p.host) {
      last.rtts.push(p.rttMs);
    } else {
      groups.push({ host: p.host, rtts: [p.rttMs] });
    }
  }
  return (
    <>
      {groups.map((g, i) => (
        <tr key={i} className={changed ? 'cv-tr-changed' : undefined}>
          {i === 0 && <td rowSpan={groups.length}>{hop.hop}</td>}
          <td className="cv-mono">{g.host ?? '*'}</td>
          <td className="cv-mono">
            {g.rtts.map((r) => (r == null ? '*' : `${r.toFixed(r < 10 ? 1 : 0)} ms`)).join('  ')}
          </td>
        </tr>
      ))}
    </>
  );
}
