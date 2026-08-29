import { useEffect, useMemo, useRef, useState } from 'react';

import { useStore } from '../state/store';
import { ipc, isDesktop, type SweepEvent } from '../lib/ipc';
import { makeDeviceNode } from './Canvas';
import { SubnetList } from './SubnetList';
import type { DeviceNodeData } from '../types/domain';
import { uid } from '../lib/id';

type Hit = { ip: string; rttMs: number | null; picked: boolean };

/**
 * Find what is actually on a subnet, then choose what to draw.
 *
 * Results stream in as hosts answer rather than arriving as one list at the
 * end: a /24 takes the better part of a minute, and a blank panel for that long
 * reads as a hang. Nothing reaches the canvas until the user picks it — a sweep
 * of a busy subnet finds printers and laptops nobody wants on a diagram.
 */
export function DiscoverPanel() {
  const store = useStore();
  const [subnets, setSubnets] = useState<string[]>(['192.168.1.0/24']);
  const [timeoutMs, setTimeoutMs] = useState(1000);
  const [concurrency, setConcurrency] = useState(64);
  const [problem, setProblem] = useState<string | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  // Results arrive on an event, so the handler needs the latest setter without
  // being torn down and rebuilt on every hit.
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    let un: (() => void) | undefined;
    void ipc
      .onSweepEvent((e: SweepEvent) => {
        if (e.kind === 'started') {
          setProgress({ done: 0, total: e.total });
        } else if (e.kind === 'alive') {
          // The backend can repeat nothing, but a restarted sweep can, and a
          // duplicate row is worse than a missed one.
          if (seen.current.has(e.ip)) return;
          seen.current.add(e.ip);
          setHits((prev) => [...prev, { ip: e.ip, rttMs: e.rttMs, picked: true }]);
        } else if (e.kind === 'progress') {
          setProgress({ done: e.done, total: e.total });
        } else if (e.kind === 'finished') {
          setRunning(false);
          setSummary(
            e.cancelled
              ? `Stopped after ${e.scanned} addresses — ${e.alive} answered`
              : `${e.alive} of ${e.scanned} addresses answered`,
          );
        }
      })
      .then((f) => {
        un = f;
      });
    return () => un?.();
  }, []);

  const start = async () => {
    setHits([]);
    setSummary(null);
    seen.current = new Set();
    setRunning(true);
    try {
      await ipc.startSweep(subnets, { timeoutMs, concurrency });
    } catch (err) {
      setRunning(false);
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };

  const stop = () => void ipc.cancelSweep();

  const picked = useMemo(() => hits.filter((h) => h.picked), [hits]);

  /** Drops the ticked addresses onto the canvas as generic devices, laid out
   *  in a grid clear of whatever is already there. */
  const addPicked = () => {
    if (!picked.length) return;
    const existing = store.doc.nodes;
    const bottom = existing.reduce((m, n) => Math.max(m, n.position.y + 120), 0);
    // Placed below whatever is already drawn, so a sweep never lands on top
    // of an existing diagram.
    const origin = { x: 80, y: bottom + 80 };

    picked.forEach((h, i) => {
      const node = makeDeviceNode('generic', origin.x + (i % 6) * 220, origin.y + Math.floor(i / 6) * 130);
      const data = node.data as DeviceNodeData;
      data.label = h.ip;
      data.addresses = [{ id: uid(), label: 'Discovered', address: h.ip, isPrimary: true }];
      store.addNode(node);
    });
    store.setStatusMessage(
      `Added ${picked.length} ${picked.length === 1 ? 'device' : 'devices'}`,
    );
    setHits((prev) => prev.map((h) => ({ ...h, picked: false })));
  };

  const toggle = (ip: string) =>
    setHits((prev) => prev.map((h) => (h.ip === ip ? { ...h, picked: !h.picked } : h)));
  const setAll = (picked: boolean) => setHits((prev) => prev.map((h) => ({ ...h, picked })));

  if (!isDesktop) {
    return (
      <p className="cv-help cv-discover-empty">
        Discovery needs the desktop app — a browser cannot send ICMP. Run Coreview itself to sweep
        a subnet.
      </p>
    );
  }

  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="cv-discover">
      <SubnetList label="Subnets" subnets={subnets} onChange={setSubnets}
        disabled={running} showCounts />

      <div className="cv-discover-form">
        <label className="cv-field cv-field-narrow">
          <span>Timeout</span>
          <select
            className="cv-input"
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(Number(e.target.value))}
            disabled={running}
          >
            <option value={500}>0.5 s</option>
            <option value={1000}>1 s</option>
            <option value={2000}>2 s</option>
            <option value={4000}>4 s</option>
          </select>
        </label>
        <label className="cv-field cv-field-narrow">
          <span>At once</span>
          <select
            className="cv-input"
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
            disabled={running}
          >
            <option value={16}>16</option>
            <option value={64}>64</option>
            <option value={128}>128</option>
            <option value={256}>256</option>
          </select>
        </label>
        {running ? (
          <button type="button" className="cv-btn cv-btn-stop" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="button" className="cv-btn cv-btn-start" onClick={() => void start()}
            disabled={!subnets.length}>
            Sweep
          </button>
        )}

        {hits.length > 0 && (
          <span className="cv-discover-actions">
            <button type="button" className="cv-btn cv-btn-small" onClick={() => setAll(true)}>
              Select all
            </button>
            <button type="button" className="cv-btn cv-btn-small" onClick={() => setAll(false)}>
              Select none
            </button>
            <button
              type="button"
              className="cv-btn cv-btn-small cv-btn-start"
              onClick={addPicked}
              disabled={!picked.length}
            >
              Add {picked.length} to diagram
            </button>
          </span>
        )}
      </div>

      <p className="cv-discover-status">
        {problem ? (
          <span className="cv-discover-problem">{problem}</span>
        ) : running && progress ? (
          <>
            Scanning {progress.done} of {progress.total} · {pct}% · {hits.length} found
          </>
        ) : summary ? (
          summary
        ) : subnets.length ? (
          'Only addresses that answer ICMP appear — a device with ping disabled stays invisible.'
        ) : (
          'Enter a subnet in CIDR notation.'
        )}
      </p>

      {running && (
        <div className="cv-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="cv-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      )}

      {hits.length > 0 && (
        <>
          <table className="cv-table cv-discover-table">
            <thead>
              <tr>
                <th />
                <th>Address</th>
                <th>Round trip</th>
              </tr>
            </thead>
            <tbody>
              {hits.map((h) => (
                <tr key={h.ip}>
                  <td>
                    <input
                      type="checkbox"
                      checked={h.picked}
                      onChange={() => toggle(h.ip)}
                      aria-label={`Include ${h.ip}`}
                    />
                  </td>
                  <td className="cv-mono">{h.ip}</td>
                  <td className="cv-mono">{h.rttMs === null ? '—' : `${h.rttMs.toFixed(h.rttMs < 1 ? 2 : 1)} ms`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
