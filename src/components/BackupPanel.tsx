import { useEffect, useMemo, useState } from 'react';

import { useStore } from '../state/store';
import { ipc, isDesktop, type BackupDevice, type BackupEvent, type DiffLine } from '../lib/ipc';
import { CredentialPicker } from './CredentialPicker';

/** `20260828-101530-running-config.txt` reads as a date and a kind. */
function describeCapture(filename: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(.+)\.txt$/.exec(filename);
  if (!m) return filename;
  const [, y, mo, d, h, mi, sec, kind] = m;
  return `${y}-${mo}-${d} ${h}:${mi}:${sec} · ${(kind ?? '').replace('-', ' ')}`;
}

/**
 * Take configuration backups, and look at the ones already taken.
 *
 * Two halves that belong together: capturing is worth little without being able
 * to see what changed, and a pair of timestamped captures makes that nearly
 * free. Devices come from whatever is on the diagram, so the list is the
 * network you have actually drawn rather than a separate inventory to maintain.
 */
export function BackupPanel({
  fromCrawl = [],
  onConsumed,
}: {
  /** Devices handed over from a discovery run. Shown alongside the diagram's
   *  own, because a crawl finds things that are not drawn yet and backing them
   *  up should not require drawing them first. */
  fromCrawl?: { address: string; name: string }[];
  onConsumed?: () => void;
} = {}) {
  const store = useStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [enablePassword, setEnablePassword] = useState('');
  const [secondFactor, setSecondFactor] = useState(false);
  const [port, setPort] = useState(22);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [kinds, setKinds] = useState<('running' | 'startup')[]>(['running']);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [pushMessage, setPushMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ name: string; path: string; bytes: number; unchanged: boolean }[]>([]);
  const [failed, setFailed] = useState<{ name: string; reason: string }[]>([]);

  // Browsing what is already there.
  const [devices, setDevices] = useState<BackupDevice[]>([]);
  const [openDevice, setOpenDevice] = useState<string | null>(null);
  const [captures, setCaptures] = useState<string[]>([]);
  const [compare, setCompare] = useState<[string, string] | null>(null);
  const [diff, setDiff] = useState<DiffLine[] | null>(null);

  /** What can be backed up: the diagram's devices, plus anything a crawl just
   *  handed over. Merged by address so a device that is both does not appear
   *  twice. */
  const targets = useMemo(() => {
    const fromDiagram = store.doc.nodes
      .filter((n) => n.type === 'device')
      .map((n) => {
        const data = n.data as { label?: string; addresses?: { address: string; isPrimary?: boolean }[] };
        const address =
          data.addresses?.find((a) => a.isPrimary)?.address ?? data.addresses?.[0]?.address ?? '';
        return { name: data.label ?? 'device', address };
      })
      .filter((t) => t.address);

    const seen = new Set(fromDiagram.map((t) => t.address));
    return [...fromDiagram, ...fromCrawl.filter((t) => t.address && !seen.has(t.address))];
  }, [store.doc.nodes, fromCrawl]);

  const refreshDevices = () => {
    void ipc
      .listBackupDevices()
      .then(setDevices)
      .catch(() => setDevices([]));
  };

  useEffect(refreshDevices, []);

  // Handed-over devices arrive already chosen — they were picked a moment ago
  // in the other tab, and asking again would be asking twice.
  useEffect(() => {
    if (!fromCrawl.length) return;
    setPicked(new Set(fromCrawl.map((t) => t.address)));
    onConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromCrawl]);

  useEffect(() => {
    let off: (() => void) | undefined;
    void ipc
      .onBackupEvent((e: BackupEvent) => {
        switch (e.kind) {
          case 'started':
            setStatus(`Backing up ${e.devices} device${e.devices === 1 ? '' : 's'}…`);
            break;
          case 'ssh': {
            const detail = e as unknown as { host?: string; message?: string };
            if (detail.message) setPushMessage(detail.message);
            else if (detail.host) setStatus(`Connecting to ${detail.host}…`);
            break;
          }
          case 'saved':
            setPushMessage(null);
            setSaved((prev) => [...prev, e]);
            break;
          case 'failed':
            setFailed((prev) => [...prev, { name: e.name, reason: e.reason }]);
            break;
          case 'finished':
            setRunning(false);
            setPushMessage(null);
            setStatus(
              e.cancelled
                ? `Stopped — ${e.saved} saved, ${e.failed} failed`
                : `${e.saved} saved, ${e.failed} failed`,
            );
            refreshDevices();
            break;
        }
      })
      .then((f) => {
        off = f;
      });
    return () => off?.();
  }, []);

  const start = async () => {
    setProblem(null);
    setSaved([]);
    setFailed([]);
    setRunning(true);
    // The timestamp is chosen once for the run, so every device in one backup
    // shares a filename and a set can be compared as a set.
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const stamp =
      `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
      `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    try {
      await ipc.startBackup(
        {
          targets: targets.filter((t) => picked.has(t.address)),
          kinds,
          secondFactor,
          port,
          credentialId: credentialId ?? undefined,
        },
        { username, password, enablePassword: enablePassword || undefined },
        stamp,
      );
    } catch (err) {
      setRunning(false);
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };

  const openCaptures = (device: string) => {
    setOpenDevice(device);
    setDiff(null);
    setCompare(null);
    void ipc.listDeviceCaptures(device).then(setCaptures).catch(() => setCaptures([]));
  };

  const runDiff = (device: string, before: string, after: string) => {
    setCompare([before, after]);
    void ipc
      .diffCaptures(device, before, after)
      .then(setDiff)
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };

  const toggleKind = (k: 'running' | 'startup') =>
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  if (!isDesktop) {
    return (
      <p className="cv-help cv-discover-empty">
        Backups need the desktop app — a browser cannot open SSH connections or write files.
      </p>
    );
  }

  if (!store.settings.backupFolder) {
    return (
      <p className="cv-help cv-discover-empty">
        Choose a backup folder first, on the Coreview start screen. Configurations are written
        there and nowhere else.
      </p>
    );
  }

  const changed = diff ? diff.filter((l) => l.kind !== 'same').length : 0;

  return (
    <div className="cv-discover">
      <div className="cv-discover-form">
        <CredentialPicker kind="ssh" disabled={running} chosen={credentialId} onChoose={setCredentialId}>
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
        </CredentialPicker>
        <label className="cv-field cv-field-narrow">
          <span>Port</span>
          <input className="cv-input" type="number" value={port} disabled={running}
            onChange={(e) => setPort(Number(e.target.value) || 22)} />
        </label>
      </div>

      <div className="cv-discover-run">
        {running ? (
          <button type="button" className="cv-btn cv-btn-stop" onClick={() => void ipc.cancelBackup()}>
            Stop
          </button>
        ) : (
          <button type="button" className="cv-btn cv-btn-start" onClick={() => void start()}
            disabled={!picked.size || (!credentialId && (!username || !password)) || !kinds.length}>
            Back up {picked.size || 'selected'}
          </button>
        )}
        <label className="cv-check cv-check-inline">
          <input type="checkbox" checked={kinds.includes('running')} disabled={running}
            onChange={() => toggleKind('running')} />
          Running config
        </label>
        <label className="cv-check cv-check-inline">
          <input type="checkbox" checked={kinds.includes('startup')} disabled={running}
            onChange={() => toggleKind('startup')} />
          Startup config
        </label>
        <label className="cv-check cv-check-inline">
          <input type="checkbox" checked={secondFactor} disabled={running}
            onChange={(e) => setSecondFactor(e.target.checked)} />
          Duo — one device at a time
        </label>
      </div>

      {pushMessage && <p className="cv-discover-push" role="status">{pushMessage}</p>}

      <p className="cv-discover-status">
        {problem ? <span className="cv-discover-problem">{problem}</span>
          : status ?? `Saving to ${store.settings.backupFolder}`}
      </p>

      <div className="cv-backup-columns">
        <section>
          <h4 className="cv-backup-head">Devices on the diagram</h4>
          {targets.length === 0 ? (
            <p className="cv-help">
              Nothing to back up — the diagram has no devices with addresses yet. Discover some,
              or add addresses to the nodes you have.
            </p>
          ) : (
            <>
              <div className="cv-discover-actions">
                <button type="button" className="cv-btn cv-btn-small"
                  onClick={() => setPicked(new Set(targets.map((t) => t.address)))}>
                  Select all
                </button>
                <button type="button" className="cv-btn cv-btn-small" onClick={() => setPicked(new Set())}>
                  Select none
                </button>
              </div>
              <table className="cv-table cv-discover-table">
                <thead><tr><th /><th>Device</th><th>Address</th></tr></thead>
                <tbody>
                  {targets.map((t) => (
                    <tr key={t.address}>
                      <td>
                        <input type="checkbox" checked={picked.has(t.address)} aria-label={`Back up ${t.name}`}
                          onChange={() => setPicked((prev) => {
                            const next = new Set(prev);
                            if (next.has(t.address)) next.delete(t.address); else next.add(t.address);
                            return next;
                          })} />
                      </td>
                      <td>{t.name}</td>
                      <td className="cv-mono">{t.address}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>

        <section>
          <h4 className="cv-backup-head">Backups taken</h4>
          {devices.length === 0 ? (
            <p className="cv-help">No backups yet.</p>
          ) : (
            <ul className="cv-backup-list">
              {devices.map((d) => (
                <li key={d.name}>
                  <button type="button" className={openDevice === d.name ? 'is-open' : ''}
                    onClick={() => openCaptures(d.name)}>
                    {d.name} <span className="cv-help">{d.captures} capture{d.captures === 1 ? '' : 's'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {openDevice && captures.length > 0 && (
            <div className="cv-backup-captures">
              <p className="cv-help">
                {captures.length > 1
                  ? 'Pick two captures to see what changed between them.'
                  : 'One capture so far — there is nothing to compare it with yet.'}
              </p>
              <ul>
                {captures.map((c, i) => (
                  <li key={c}>
                    <span className="cv-mono">{describeCapture(c)}</span>
                    {i === 0 && captures[1] !== undefined && (
                      <button type="button" className="cv-btn cv-btn-small"
                        onClick={() => runDiff(openDevice, captures[1] as string, c)}>
                        Compare with previous
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {diff && compare && (
            <div className="cv-diff">
              <p className="cv-help">
                {changed === 0
                  ? 'Identical — nothing changed between these two captures.'
                  : `${changed} line${changed === 1 ? '' : 's'} differ.`}
              </p>
              {changed > 0 && (
                <pre className="cv-diff-body">
                  {diff
                    .filter((l) => l.kind !== 'same')
                    .slice(0, 200)
                    .map((l, i) => (
                      <span key={i} className={l.kind === 'added' ? 'is-added' : 'is-removed'}>
                        {l.kind === 'added' ? '+ ' : '- '}
                        {(l as { value?: string }).value ?? ''}
                        {'\n'}
                      </span>
                    ))}
                </pre>
              )}
            </div>
          )}
        </section>
      </div>

      {(saved.length > 0 || failed.length > 0) && (
        <div className="cv-backup-results">
          {saved.map((s) => (
            <p key={s.path} className="cv-help">
              <span className="cv-reached">Saved</span> {s.name} — {s.bytes.toLocaleString()} bytes
              {s.unchanged && ' (unchanged since the last capture)'}
            </p>
          ))}
          {failed.map((f) => (
            <p key={f.name} className="cv-discover-problem">{f.name} — {f.reason}</p>
          ))}
        </div>
      )}
    </div>
  );
}
