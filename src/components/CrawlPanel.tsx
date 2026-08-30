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
import { CredentialPicker } from './CredentialPicker';
import { SubnetList } from './SubnetList';
import { reasonWithoutAddress } from '../lib/failures';
import { newProbe } from '../lib/probes';
import { buildTopology } from '../lib/topology';
import { ChangeReport } from './ChangeReport';
import { selectAttached, vendorCounts } from '../lib/attached';
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
/** Classes the crawl logs into by default. */
const INFRASTRUCTURE: DeviceClassName[] = ['router', 'switch', 'firewall', 'wireless-controller'];

/** Everything that can be ticked as somewhere to log in to. Phones, printers
 *  and cameras are on the list because someone may genuinely want to, not
 *  because it is a good idea by default. */
const LOGIN_CHOICES: { value: DeviceClassName; label: string }[] = [
  { value: 'router', label: 'Routers' },
  { value: 'switch', label: 'Switches' },
  { value: 'firewall', label: 'Firewalls' },
  { value: 'wireless-controller', label: 'WLCs' },
  { value: 'access-point', label: 'Access points' },
  { value: 'server', label: 'Servers' },
  { value: 'printer', label: 'Printers' },
  { value: 'camera', label: 'Cameras' },
  { value: 'phone', label: 'Phones' },
  { value: 'endpoint', label: 'Endpoints' },
  { value: 'unknown', label: 'Unclassified' },
];

/** One row of the results list: something reached, or something merely seen. */
type Row = {
  key: string;
  name: string;
  address: string;
  probeTarget: string;
  klass: DeviceClassName;
  platform: string | null;
  reached: boolean;
  /** How the device answered, so the table never overstates what is known. */
  via: 'ssh' | 'snmp' | 'reported' | null;
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
export function CrawlPanel({
  onBackup,
}: {
  /** Hands devices to the Backups tab, which owns the credentials and the
   *  folder. Duplicating the backup form here would mean two places to keep
   *  right. */
  onBackup: (targets: { address: string; name: string }[]) => void;
}) {
  const store = useStore();
  const [seed, setSeed] = useState('');
  const [subnets, setSubnets] = useState<string[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [enablePassword, setEnablePassword] = useState('');
  const [secondFactor, setSecondFactor] = useState(false);
  const [port, setPort] = useState(22);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [maxHops, setMaxHops] = useState(4);
  const [preference, setPreference] = useState<'loopback' | 'management' | 'first'>('loopback');
  // SNMP is optional and only used where SSH is refused, so it lives behind a
  // disclosure rather than adding six more fields to the main row.
  const [snmpOpen, setSnmpOpen] = useState(false);
  const [snmpVersion, setSnmpVersion] = useState<'v2c' | 'v3'>('v2c');
  const [community, setCommunity] = useState('');
  const [snmpUser, setSnmpUser] = useState('');
  const [snmpAuth, setSnmpAuth] = useState('sha');
  const [snmpAuthPass, setSnmpAuthPass] = useState('');
  const [snmpPriv, setSnmpPriv] = useState('aes 256');
  const [snmpPrivPass, setSnmpPrivPass] = useState('');

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

  // Chosen before the run: the classes the crawl is allowed to log into.
  // Everything discovered is drawn either way — this only decides what gets a
  // connection attempt, which is what sets off intrusion alerts.
  const [loginClasses, setLoginClasses] = useState<DeviceClassName[]>(INFRASTRUCTURE);
  const [transport, setTransport] = useState<'ssh' | 'telnet' | 'sshThenTelnet'>('ssh');
  // Silent devices — the ones that announce nothing — are drawn only when
  // asked for. A flat /24 can hold two hundred, and drawing them all buries
  // the topology the diagram exists to show.
  const [showAttached, setShowAttached] = useState(false);
  const [attachedVendor, setAttachedVendor] = useState('');
  const [attachedSubnet, setAttachedSubnet] = useState('');
  const [attachedPort, setAttachedPort] = useState('');
  const [singlePortOnly, setSinglePortOnly] = useState(true);
  // A second login, tried only where the first is rejected.
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupUsername, setBackupUsername] = useState('');
  const [backupPassword, setBackupPassword] = useState('');
  const [backupEnable, setBackupEnable] = useState('');
  const [result, setResult] = useState<{ devices: CrawledDevice[]; notVisited: Neighbor[] } | null>(
    null,
  );

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
            setStatus(
              `${e.address} could not be reached — ${reasonWithoutAddress(e.address, e.reason)}`,
            );
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
            via: d.reachedBy,
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
            via: null,
            // Only what we logged into is ticked to begin with. Everything
            // else is a claim from a neighbour, not something confirmed.
            picked: false,
          }),
        );
        setRows((prev) => [...prev, ...next]);
        setFailures(r.failures);
        // The adjacencies live here and nowhere else. Flattening to rows threw
        // away who is plugged into what, which is why the built diagram used
        // to be a grid of unconnected boxes.
        setResult({ devices: r.devices, notVisited: r.notVisited });
      })
      .then((f) => {
        offResult = f;
      });

    return () => {
      offEvent?.();
      offResult?.();
    };
  }, []);

  /** Only sends SNMP credentials when they are complete enough to work. */
  const snmpForRun = () => {
    if (!snmpOpen) return undefined;
    if (snmpVersion === 'v2c') {
      return community.trim() ? { version: 'v2c' as const, community: community.trim() } : undefined;
    }
    if (!snmpUser.trim() || !snmpAuthPass) return undefined;
    return {
      version: 'v3' as const,
      username: snmpUser.trim(),
      authProtocol: snmpAuth,
      authPassword: snmpAuthPass,
      privacy: snmpPriv || undefined,
      privacyPassword: snmpPrivPass,
    };
  };

  const start = async () => {
    setProblem(null);
    setRows([]);
    setFailures([]);
    setLiveFailed(0);
    setPushMessage(null);
    seenKeys.current = new Set();
    setResult(null);
    setRunning(true);
    try {
      await ipc.startCrawl(
        {
          seed: seed.trim(),
          subnets,
          crawlClasses: loginClasses,
          maxHops,
          maxDevices: 500,
          secondFactor,
          addressPreference: preference,
          port,
          transport,
          snmp: snmpForRun(),
          credentialId: credentialId ?? undefined,
        },
        { username, password, enablePassword: enablePassword || undefined },
        backupUsername.trim()
          ? [
              {
                username: backupUsername.trim(),
                password: backupPassword,
                enablePassword: backupEnable || undefined,
              },
            ]
          : undefined,
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

  /** Only what was logged into can be backed up: a device seen by a neighbour
   *  has not proved it will accept a session, and one found over SNMP has
   *  proved it will not. */
  const backupable = picked.filter((r) => r.via === 'ssh');

  const backUp = () => {
    if (!backupable.length) return;
    store.setStatusMessage(
      `Sending ${backupable.length} device${backupable.length === 1 ? '' : 's'} to the Backups tab`,
    );
    onBackup(backupable.map((r) => ({ address: r.probeTarget || r.address, name: r.name })));
  };

  const toggleClass = (c: DeviceClassName) =>
    setClasses((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  const toggleRow = (key: string) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, picked: !r.picked } : r)));
  const setAllVisible = (picked: boolean) => {
    const keys = new Set(visible.map((v) => v.key));
    setRows((prev) => prev.map((r) => (keys.has(r.key) ? { ...r, picked } : r)));
  };

  /**
   * Builds the diagram from the crawl.
   *
   * Not from the rows: those are a flattened list and know nothing about who
   * is plugged into what. The result carries every device's neighbours with
   * the port at each end, which is what makes this a diagram rather than a
   * grid of boxes.
   */
  const attachedFilter = useMemo(
    () => ({
      vendor: attachedVendor,
      subnet: attachedSubnet,
      port: attachedPort,
      // A port carrying several addresses leads to another switch, and what
      // is behind it belongs to that switch rather than this one.
      maxPerPort: singlePortOnly ? 1 : undefined,
    }),
    [attachedVendor, attachedSubnet, attachedPort, singlePortOnly],
  );
  const chosenAttached = useMemo(
    () => (result ? selectAttached(result.devices, attachedFilter) : []),
    [result, attachedFilter],
  );
  const makers = useMemo(() => (result ? vendorCounts(result.devices) : []), [result]);
  const attachedTotal = useMemo(
    () => (result ? selectAttached(result.devices, {}).length : 0),
    [result],
  );

  const build = () => {
    if (!result || !store.meta) return;
    const keep = new Set(picked.map((r) => r.key.toLowerCase()));
    const bottom = store.doc.nodes.reduce((m, n) => Math.max(m, n.position.y + 120), 0);

    const topo = buildTopology(result, store.meta.id, {
      origin: { x: 80, y: bottom + 80 },
      attached: showAttached ? chosenAttached : [],
      // A second crawl updates the diagram rather than drawing another copy
      // of the network beside it, so re-running discovery is something you can
      // do weekly instead of once.
      existingNodes: store.doc.nodes,
      existingEdges: store.doc.edges,
    });

    // The ticks in the table decide what is placed. Matching on the drawn
    // label keeps that honest without the builder having to know about rows.
    const wanted = (n: (typeof topo.nodes)[number]) =>
      keep.size === 0 || keep.has(String((n.data as DeviceNodeData).label).toLowerCase());
    const placed = topo.nodes.filter(wanted);
    const placedIds = new Set(placed.map((n) => n.id));

    for (const node of placed) {
      store.addNode(node);
      const address = (node.data as DeviceNodeData).addresses?.[0]?.address;
      const reached = (node.data as DeviceNodeData).tags?.includes('discovered');
      // Only what was logged into is monitored. A crawl of a flat network can
      // see hundreds of endpoints, and probing all of them is a decision, not
      // a side effect of drawing them.
      if (address && reached) {
        store.upsertProbe(newProbe('node', node.id, store.meta.id, address, 'Discovered'));
      }
    }
    let links = 0;
    for (const edge of topo.edges) {
      if (!placedIds.has(edge.source) || !placedIds.has(edge.target)) continue;
      store.addEdge(edge);
      links += 1;
    }

    for (const u of topo.updated) store.updateNodeData(u.id, u.data);

    const parts = [
      `Added ${placed.length} device${placed.length === 1 ? '' : 's'} and ${links} link${
        links === 1 ? '' : 's'
      }.`,
    ];
    if (topo.updated.length) {
      parts.push(
        `Updated ${topo.updated.length} already on the diagram, keeping ${
          topo.updated.length === 1 ? 'its position' : 'their positions'
        }.`,
      );
    }
    if (topo.danglingLinks) parts.push(`${topo.danglingLinks} link ends were not on the diagram.`);
    store.setStatusMessage(parts.join(' '));
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

      <SubnetList label="Stay inside these subnets" subnets={subnets} onChange={setSubnets}
        disabled={running} placeholder="10.1.0.0/16" />

      {/* Telnet is never chosen for anyone. It puts every credential and every
          byte of output on the wire in clear text, which is not a flaw in the
          implementation — it is what the protocol is — so the run has to ask
          for it and the form says what it costs. */}
      <label className="cv-field cv-field-narrow cv-transport">
        <span>Reach devices over</span>
        <select
          className="cv-input"
          value={transport}
          disabled={running}
          onChange={(e) => setTransport(e.target.value as typeof transport)}
        >
          <option value="ssh">SSH only</option>
          <option value="sshThenTelnet">SSH, then telnet if nothing answers</option>
          <option value="telnet">Telnet only</option>
        </select>
      </label>
      {transport !== 'ssh' && (
        <p className="cv-help cv-transport-warning">
          Telnet sends the username, the password and everything the device replies in clear
          text, readable by anything on the path. Coreview will not fall back to it after a
          password is <em>rejected</em> — the account exists and the credentials are wrong, and
          sending them again unprotected would be worse than failing.
        </p>
      )}

      {/* Two logins, because one estate rarely has one. Sites migrate between
          TACACS realms and appliances keep a local account of their own. */}
      <details
        className="cv-backup-creds"
        open={backupOpen}
        onToggle={(e) => setBackupOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>Second login, if the first is refused</summary>
        <div className="cv-discover-form">
          <label className="cv-field cv-field-narrow">
            <span>Username</span>
            <input className="cv-input" value={backupUsername} autoComplete="off" disabled={running}
              onChange={(e) => setBackupUsername(e.target.value)} />
          </label>
          <label className="cv-field cv-field-narrow">
            <span>Password</span>
            <input className="cv-input" type="password" value={backupPassword} autoComplete="off"
              disabled={running} onChange={(e) => setBackupPassword(e.target.value)} />
          </label>
          <label className="cv-field cv-field-narrow">
            <span>Enable</span>
            <input className="cv-input" type="password" value={backupEnable} autoComplete="off"
              disabled={running} onChange={(e) => setBackupEnable(e.target.value)} />
          </label>
        </div>
        <span className="cv-help">
          Used only where the first login is rejected. A timeout or a refused connection is not
          retried — a second password will not help, and on a locking account policy it would do
          harm.
        </span>
      </details>

      {/* Chosen before the run, because a connection attempt to a phone or a
          camera is what sets off an intrusion alert, and by then it has
          happened. Everything discovered is drawn either way — this decides
          only what gets logged into. */}
      <div className="cv-login-classes">
        <span className="cv-subnets-label">Log in to</span>
        <div className="cv-class-chips">
          {LOGIN_CHOICES.map(({ value, label }) => {
            const on = loginClasses.includes(value);
            return (
              <button
                key={value}
                type="button"
                className={`cv-chip${on ? ' is-on' : ''}`}
                disabled={running}
                aria-pressed={on}
                onClick={() =>
                  setLoginClasses((prev) =>
                    prev.includes(value) ? prev.filter((c) => c !== value) : [...prev, value],
                  )
                }
              >
                {label}
              </button>
            );
          })}
        </div>
        <span className="cv-help">
          Everything found is drawn, including whatever is not ticked here. Unticking something
          means Coreview will not try to log in to it — nothing more.
        </span>
      </div>

      <div className="cv-discover-run">
        {running ? (
          <button type="button" className="cv-btn cv-btn-stop" onClick={() => void ipc.cancelCrawl()}>
            Stop
          </button>
        ) : (
          <button type="button" className="cv-btn cv-btn-start" onClick={() => void start()}
            disabled={!seed.trim() || (!credentialId && (!username || !password))}>
            Discover
          </button>
        )}
        <label className="cv-check cv-check-inline">
          <input type="checkbox" checked={secondFactor} disabled={running}
            onChange={(e) => setSecondFactor(e.target.checked)} />
          These devices use Duo or another push factor — log in one at a time
        </label>
      </div>

      <details className="cv-snmp" open={snmpOpen}
        onToggle={(e) => setSnmpOpen((e.target as HTMLDetailsElement).open)}>
        <summary>Also try SNMP for devices that refuse SSH</summary>
        <div className="cv-discover-form">
          <label className="cv-field cv-field-narrow">
            <span>Version</span>
            <select className="cv-input" value={snmpVersion} disabled={running}
              onChange={(e) => setSnmpVersion(e.target.value as 'v2c' | 'v3')}>
              <option value="v2c">v2c</option>
              <option value="v3">v3</option>
            </select>
          </label>
          {snmpVersion === 'v2c' ? (
            <label className="cv-field">
              <span>Community (read-only)</span>
              <input className="cv-input" type="password" value={community} autoComplete="off"
                disabled={running} onChange={(e) => setCommunity(e.target.value)} />
            </label>
          ) : (
            <>
              <label className="cv-field cv-field-narrow">
                <span>User</span>
                <input className="cv-input" value={snmpUser} autoComplete="off" disabled={running}
                  onChange={(e) => setSnmpUser(e.target.value)} />
              </label>
              <label className="cv-field cv-field-narrow">
                <span>Auth</span>
                <select className="cv-input" value={snmpAuth} disabled={running}
                  onChange={(e) => setSnmpAuth(e.target.value)}>
                  <option value="sha">sha</option>
                  <option value="md5">md5</option>
                  <option value="sha256">sha256</option>
                  <option value="sha512">sha512</option>
                </select>
              </label>
              <label className="cv-field cv-field-narrow">
                <span>Auth password</span>
                <input className="cv-input" type="password" value={snmpAuthPass} autoComplete="off"
                  disabled={running} onChange={(e) => setSnmpAuthPass(e.target.value)} />
              </label>
              <label className="cv-field cv-field-narrow">
                <span>Privacy</span>
                <select className="cv-input" value={snmpPriv} disabled={running}
                  onChange={(e) => setSnmpPriv(e.target.value)}>
                  <option value="">none</option>
                  <option value="aes">aes</option>
                  <option value="aes 192">aes 192</option>
                  <option value="aes 256">aes 256</option>
                  <option value="des">des</option>
                </select>
              </label>
              <label className="cv-field cv-field-narrow">
                <span>Privacy password</span>
                <input className="cv-input" type="password" value={snmpPrivPass} autoComplete="off"
                  disabled={running} onChange={(e) => setSnmpPrivPass(e.target.value)} />
              </label>
            </>
          )}
        </div>
        <p className="cv-help">
          Used only where SSH is refused. A device that answers is named and classified, but
          cannot report its neighbours, so it appears without links.
        </p>
      </details>

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

          {result && <ChangeReport result={result} />}

          <div className="cv-discover-actions">
            <button type="button" className="cv-btn cv-btn-small" onClick={() => setAllVisible(true)}>
              Select all
            </button>
            <button type="button" className="cv-btn cv-btn-small" onClick={() => setAllVisible(false)}>
              Select none
            </button>
            <button type="button" className="cv-btn cv-btn-small cv-btn-start"
              onClick={build} disabled={!picked.length}>
              Add {picked.length}
              {showAttached && chosenAttached.length > 0 ? ` + ${chosenAttached.length}` : ''} to diagram
            </button>
            <button type="button" className="cv-btn cv-btn-small" onClick={backUp}
              disabled={!backupable.length}
              title={
                backupable.length < picked.length
                  ? 'Only devices Coreview logged into can be backed up'
                  : undefined
              }>
              Back up {backupable.length}
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
                    {r.via === 'ssh'
                      ? 'Logged in'
                      : r.via === 'snmp'
                        ? 'SNMP only'
                        : r.via === 'reported'
                          ? 'Described by its controller'
                          : 'Seen by a neighbour'}
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

      {result && attachedTotal > 0 && (
        <details className="cv-attached" open={showAttached}
          onToggle={(e) => setShowAttached((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>
            {attachedTotal} more {attachedTotal === 1 ? 'device was' : 'devices were'} seen on
            switch ports without announcing anything
          </summary>

          <p className="cv-help">
            These speak no discovery protocol — printers, cameras, workstations. A switch knows
            they are there because it learned their address on a port. Nothing here is drawn
            unless you ask: a flat network can hold hundreds, and all of them at once would bury
            the topology.
          </p>

          <div className="cv-discover-form">
            <label className="cv-field cv-field-narrow">
              <span>Made by</span>
              <input className="cv-input" list="cv-makers" value={attachedVendor}
                placeholder="any" onChange={(e) => setAttachedVendor(e.target.value)} />
              <datalist id="cv-makers">
                {makers.map((m) => (
                  <option key={m.vendor} value={m.vendor}>{`${m.vendor} (${m.count})`}</option>
                ))}
              </datalist>
            </label>
            <label className="cv-field cv-field-narrow">
              <span>In subnet</span>
              <input className="cv-input" value={attachedSubnet} placeholder="any"
                onChange={(e) => setAttachedSubnet(e.target.value)} />
            </label>
            <label className="cv-field cv-field-narrow">
              <span>On port</span>
              <input className="cv-input" value={attachedPort} placeholder="any"
                onChange={(e) => setAttachedPort(e.target.value)} />
            </label>
          </div>

          <label className="cv-check cv-check-inline">
            <input type="checkbox" checked={singlePortOnly}
              onChange={(e) => setSinglePortOnly(e.target.checked)} />
            Only ports with one device on them
          </label>
          <p className="cv-help">
            A port carrying several addresses leads to another switch, and what is behind it
            belongs on that switch's part of the diagram rather than hanging off this one.
          </p>

          <p className="cv-help">
            <strong>{chosenAttached.length}</strong> of {attachedTotal} match. They will be added
            with the devices ticked above, each hanging off the port it was learned on.
          </p>
        </details>
      )}

      {!running && failures.length > 0 && (
        <details className="cv-discover-failures">
          <summary>{failures.length} device{failures.length === 1 ? '' : 's'} could not be reached</summary>
          <ul>
            {failures.map((f) => (
              <li key={f.address}>
                <code>{f.address}</code> — {reasonWithoutAddress(f.address, f.reason)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
