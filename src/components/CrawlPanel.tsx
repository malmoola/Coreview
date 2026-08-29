import { useEffect, useMemo, useRef, useState } from 'react';

import { useStore } from '../state/store';
import {
  ipc,
  isDesktop,
  type CrawlEvent,
  type CrawledDevice,
  type CrawlResult,
  type DeviceClassName,
  type Neighbor,
} from '../lib/ipc';
import { makeDeviceNode } from './Canvas';
import { uid } from '../lib/id';
import type { DeviceNodeData } from '../types/domain';

const CLASS_LABEL: Record<DeviceClassName, string> = {
  router: 'Router',
  switch: 'Switch',
  firewall: 'Firewall',
  'wireless-controller': 'Wireless controller',
  'access-point': 'Access point',
  phone: 'Phone',
  camera: 'Camera',
  printer: 'Printer',
  server: 'Server',
  endpoint: 'Endpoint',
  unknown: 'Unknown',
};

/** The glyphs the canvas already knows, keyed by discovered class. */
const CLASS_GLYPH: Record<DeviceClassName, string> = {
  router: 'router',
  switch: 'core-switch',
  firewall: 'firewall',
  'wireless-controller': 'wireless-controller',
  'access-point': 'access-point',
  phone: 'endpoint-client',
  camera: 'camera-iot',
  printer: 'printer',
  server: 'server',
  endpoint: 'endpoint-client',
  unknown: 'generic',
};

/** Classes the crawl logs into by default. */
const INFRASTRUCTURE: DeviceClassName[] = ['router', 'switch', 'firewall', 'wireless-controller'];

/** One row of the results list: something reached, or something merely seen. */
type Row = {
  key: string;
  name: string;
  address: string;
  probeTarget: string;
  klass: DeviceClassName;
  platform: string | null;
  reached: boolean;
  picked: boolean;
};

/**
 * Discover, then filter, then build — in that order and as three visible steps.
 *
 * A crawl of a real network finds far more than anyone wants to draw. Nothing
 * reaches the canvas until it has passed a filter the user set, and the filter
 * is applied here rather than during the crawl so changing your mind costs a
 * click instead of another walk of the estate.
 */
export function CrawlPanel() {
  const store = useStore();
  const [seed, setSeed] = useState('');
  const [subnets, setSubnets] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [enablePassword, setEnablePassword] = useState('');
  const [secondFactor, setSecondFactor] = useState(false);
  const [port, setPort] = useState(22);
  const [maxHops, setMaxHops] = useState(4);
  const [preference, setPreference] = useState<'loopback' | 'management' | 'first'>('loopback');

  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [pushMessage, setPushMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  // Written only by the final result, never by the event stream. The two
  // arrive on separate channels with no ordering between them, so letting both
  // write produced a list that disagreed with its own count.
  const [failures, setFailures] = useState<{ address: string; reason: string }[]>([]);
  // Live count while the crawl runs, so failures are visible before it ends.
  const [liveFailed, setLiveFailed] = useState(0);

  // Filter, applied after the crawl.
  const [classes, setClasses] = useState<DeviceClassName[]>([]);
  const [search, setSearch] = useState('');

  const seenKeys = useRef<Set<string>>(new Set());

  useEffect(() => {
    let offEvent: (() => void) | undefined;
    let offResult: (() => void) | undefined;

    void ipc
      .onCrawlEvent((e: CrawlEvent) => {
        switch (e.kind) {
          case 'started':
            setStatus(`Walking the network from ${e.seed}…`);
            break;
          case 'ssh': {
            const detail = e as unknown as { host?: string; message?: string };
            if (detail.message) {
              // A push is pending. The one status that has to shout: without
              // it, waiting for Duo looks exactly like a hang.
              setPushMessage(detail.message);
            } else if (detail.host) {
              setStatus(`Connecting to ${detail.host}…`);
            }
            break;
          }
          case 'reached':
            setPushMessage(null);
            setStatus(`Reached ${e.hostname} (${e.address})`);
            break;
          case 'failed':
            setLiveFailed((n) => n + 1);
            setStatus(`${e.address} could not be reached — ${e.reason}`);
            break;
          case 'finished':
            setRunning(false);
            setPushMessage(null);
            setStatus(
              e.cancelled
                ? `Stopped — reached ${e.reached}, ${e.failed} failed`
                : `Reached ${e.reached} device${e.reached === 1 ? '' : 's'}, ${e.failed} failed`,
            );
            break;
        }
      })
      .then((f) => {
        offEvent = f;
      });

    void ipc
      .onCrawlResult((r: CrawlResult) => {
        const next: Row[] = [];
        const add = (row: Row) => {
          if (seenKeys.current.has(row.key)) return;
          seenKeys.current.add(row.key);
          next.push(row);
        };
        r.devices.forEach((d: CrawledDevice) =>
          add({
            key: d.hostname,
            name: d.hostname,
            address: d.address,
            probeTarget: d.probeTarget,
            klass: d.class,
            platform: d.platform,
            reached: true,
            picked: true,
          }),
        );
        r.notVisited.forEach((n: Neighbor) =>
          add({
            key: n.shortName,
            name: n.shortName,
            address: n.addresses[0]?.ip ?? '',
            probeTarget: n.addresses[0]?.ip ?? '',
            klass: n.class,
            platform: n.platform,
            reached: false,
            // Only what we logged into is ticked to begin with. Everything
            // else is a claim from a neighbour, not something confirmed.
            picked: false,
          }),
        );
        setRows((prev) => [...prev, ...next]);
        setFailures(r.failures);
      })
      .then((f) => {
        offResult = f;
      });

    return () => {
      offEvent?.();
      offResult?.();
    };
  }, []);

  const start = async () => {
    setProblem(null);
    setRows([]);
    setFailures([]);
    setLiveFailed(0);
    setPushMessage(null);
    seenKeys.current = new Set();
    setRunning(true);
    try {
      await ipc.startCrawl(
        {
          seed: seed.trim(),
          subnets: subnets.split(',').map((s) => s.trim()).filter(Boolean),
          crawlClasses: INFRASTRUCTURE,
          maxHops,
          maxDevices: 500,
          secondFactor,
          addressPreference: preference,
          port,
        },
        { username, password, enablePassword: enablePassword || undefined },
      );
    } catch (err) {
      setRunning(false);
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };

  const counts = useMemo(() => {
    const by = new Map<DeviceClassName, number>();
    rows.forEach((r) => by.set(r.klass, (by.get(r.klass) ?? 0) + 1));
    return [...by.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (classes.length && !classes.includes(r.klass)) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.address.includes(q) ||
        (r.platform ?? '').toLowerCase().includes(q)
      );
    });
  }, [rows, classes, search]);

  const picked = visible.filter((r) => r.picked);

  const toggleClass = (c: DeviceClassName) =>
    setClasses((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  const toggleRow = (key: string) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, picked: !r.picked } : r)));
  const setAllVisible = (picked: boolean) => {
    const keys = new Set(visible.map((v) => v.key));
    setRows((prev) => prev.map((r) => (keys.has(r.key) ? { ...r, picked } : r)));
  };

  /** Builds the diagram from what survived the filter. */
  const build = () => {
    if (!picked.length) return;
    const bottom = store.doc.nodes.reduce((m, n) => Math.max(m, n.position.y + 120), 0);
    const originY = bottom + 80;

    picked.forEach((r, i) => {
      const node = makeDeviceNode(
        CLASS_GLYPH[r.klass] as never,
        80 + (i % 6) * 230,
        originY + Math.floor(i / 6) * 140,
      );
      const data = node.data as DeviceNodeData;
      data.label = r.name;
      if (r.probeTarget) {
        data.addresses = [
          { id: uid(), label: 'Discovered', address: r.probeTarget, isPrimary: true },
        ];
      }
      store.addNode(node);
    });
    store.setStatusMessage(`Added ${picked.length} discovered device${picked.length === 1 ? '' : 's'}`);
    setAllVisible(false);
  };

  if (!isDesktop) {
    return (
      <p className="cv-help cv-discover-empty">
        Discovery needs the desktop app — a browser cannot open SSH connections.
      </p>
    );
  }

  return (
    <div className="cv-discover">
      <div className="cv-discover-form">
        <label className="cv-field">
          <span>Seed device</span>
          <input className="cv-input" value={seed} spellCheck={false} disabled={running}
            placeholder="10.1.1.1" onChange={(e) => setSeed(e.target.value)} />
        </label>
        <label className="cv-field">
          <span>Stay inside these subnets</span>
          <input className="cv-input" value={subnets} spellCheck={false} disabled={running}
            placeholder="10.1.0.0/16, 10.2.0.0/16" onChange={(e) => setSubnets(e.target.value)} />
        </label>
        <label className="cv-field cv-field-narrow">
          <span>Username</span>
          <input className="cv-input" value={username} autoComplete="off" disabled={running}
            onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="cv-field cv-field-narrow">
          <span>Password</span>
          <input className="cv-input" type="password" value={password} autoComplete="off"
            disabled={running} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="cv-field cv-field-narrow">
          <span>Enable</span>
          <input className="cv-input" type="password" value={enablePassword} autoComplete="off"
            disabled={running} onChange={(e) => setEnablePassword(e.target.value)} />
        </label>
        <label className="cv-field cv-field-narrow">
          <span>Hops</span>
          <select className="cv-input" value={maxHops} disabled={running}
            onChange={(e) => setMaxHops(Number(e.target.value))}>
            {[1, 2, 3, 4, 6, 8].map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
        </label>
        <label className="cv-field cv-field-narrow">
          <span>Probe address</span>
          <select className="cv-input" value={preference} disabled={running}
            onChange={(e) => setPreference(e.target.value as typeof preference)}>
            <option value="loopback">Loopback</option>
            <option value="management">Management</option>
            <option value="first">First found</option>
          </select>
        </label>
        <label className="cv-field cv-field-narrow">
          <span>Port</span>
          <input className="cv-input" type="number" value={port} disabled={running}
            onChange={(e) => setPort(Number(e.target.value) || 22)} />
        </label>

      </div>

      <div className="cv-discover-run">
        {running ? (
          <button type="button" className="cv-btn cv-btn-stop" onClick={() => void ipc.cancelCrawl()}>
            Stop
          </button>
        ) : (
          <button type="button" className="cv-btn cv-btn-start" onClick={() => void start()}
            disabled={!seed.trim() || !username || !password}>
            Discover
          </button>
        )}
        <label className="cv-check cv-check-inline">
          <input type="checkbox" checked={secondFactor} disabled={running}
            onChange={(e) => setSecondFactor(e.target.checked)} />
          These devices use Duo or another push factor — log in one at a time
        </label>
      </div>

      {pushMessage && (
        <p className="cv-discover-push" role="status">
          {pushMessage}
        </p>
      )}

      <p className="cv-discover-status">
        {problem ? <span className="cv-discover-problem">{problem}</span>
          : status ?? 'Credentials are used for this run only and are never saved.'}
      </p>

      {rows.length > 0 && (
        <>
          <div className="cv-discover-filter">
            <span className="cv-filter-label">Show</span>
            {counts.map(([c, n]) => (
              <button key={c} type="button"
                className={`cv-chip ${classes.includes(c) ? 'is-on' : ''}`}
                onClick={() => toggleClass(c)}>
                {CLASS_LABEL[c]} <b>{n}</b>
              </button>
            ))}
            <input className="cv-input cv-filter-search" placeholder="Name, address or platform"
              value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>

          <div className="cv-discover-actions">
            <button type="button" className="cv-btn cv-btn-small" onClick={() => setAllVisible(true)}>
              Select all
            </button>
            <button type="button" className="cv-btn cv-btn-small" onClick={() => setAllVisible(false)}>
              Select none
            </button>
            <button type="button" className="cv-btn cv-btn-small cv-btn-start"
              onClick={build} disabled={!picked.length}>
              Add {picked.length} to diagram
            </button>
            <span className="cv-help">
              {visible.length} of {rows.length} shown
              {failures.length > 0 && ` · ${failures.length} could not be reached`}
            </span>
          </div>

          <table className="cv-table cv-discover-table">
            <thead>
              <tr>
                <th />
                <th>Device</th>
                <th>Kind</th>
                <th>Probe address</th>
                <th>Platform</th>
                <th>How</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.key}>
                  <td>
                    <input type="checkbox" checked={r.picked} aria-label={`Include ${r.name}`}
                      onChange={() => toggleRow(r.key)} />
                  </td>
                  <td>{r.name}</td>
                  <td>{CLASS_LABEL[r.klass]}</td>
                  <td className="cv-mono">{r.probeTarget || '—'}</td>
                  <td>{r.platform ?? '—'}</td>
                  <td className={r.reached ? 'cv-reached' : 'cv-seen'}>
                    {r.reached ? 'Logged in' : 'Seen by a neighbour'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {running && liveFailed > 0 && (
        <p className="cv-help cv-discover-live-failed">
          {liveFailed} device{liveFailed === 1 ? '' : 's'} could not be reached so far
        </p>
      )}

      {!running && failures.length > 0 && (
        <details className="cv-discover-failures">
          <summary>{failures.length} device{failures.length === 1 ? '' : 's'} could not be reached</summary>
          <ul>
            {failures.map((f) => (
              <li key={f.address}>
                <code>{f.address}</code> — {f.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
