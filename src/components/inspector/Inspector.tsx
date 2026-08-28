import { useState, useMemo } from 'react';

import { useStore } from '../../state/store';
import { uid } from '../../lib/id';
import { DEVICE_LABEL } from '../icons';
import { STATUS_COLOR } from '../edges/LiveEdge';
import { describeRule, linkStatus } from '../../health/evaluate';
import type {
  DeviceNodeData,
  DeviceType,
  LinkData,
  LinkHealthRuleType,
  NoteNodeData,
  Probe,
  ProbeKind,
} from '../../types/domain';
import {
  HEALTH_RULE_LABEL,
  PROBE_DEFAULTS,
  STATUS_GLYPH,
  STATUS_LABEL,
} from '../../types/domain';

function newProbe(
  objectKind: 'node' | 'link',
  objectId: string,
  projectId: string,
  target = '',
): Probe {
  return {
    id: uid(),
    projectId,
    objectKind,
    objectId,
    name: objectKind === 'node' ? 'Management' : 'Link check',
    kind: 'icmp',
    target,
    tcpPort: null,
    intervalSeconds: PROBE_DEFAULTS.intervalSeconds,
    timeoutMs: PROBE_DEFAULTS.timeoutMs,
    failureThreshold: PROBE_DEFAULTS.failureThreshold,
    recoveryThreshold: PROBE_DEFAULTS.recoveryThreshold,
    warningLatencyMs: PROBE_DEFAULTS.warningLatencyMs,
    enabled: true,
    maintenance: false,
    isPrimary: true,
  };
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="lt-field">
      <span className="lt-field-label">{label}</span>
      {children}
      {hint && <span className="lt-field-hint">{hint}</span>}
    </label>
  );
}

export function Inspector() {
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const selectedEdgeId = useStore((s) => s.selectedEdgeId);
  const meta = useStore((s) => s.meta);

  if (!meta) return null;

  return (
    <aside className="lt-inspector" aria-label="Inspector">
      {selectedNodeId ? (
        <NodeInspector nodeId={selectedNodeId} />
      ) : selectedEdgeId ? (
        <LinkInspector edgeId={selectedEdgeId} />
      ) : (
        <ProjectInspector />
      )}
    </aside>
  );
}

function ProjectInspector() {
  const meta = useStore((s) => s.meta)!;
  const updateMeta = useStore((s) => s.updateMeta);
  return (
    <>
      <h2 className="lt-inspector-title">Project</h2>
      <Field label="Project name">
        <input
          className="lt-input"
          value={meta.name}
          onChange={(e) => updateMeta({ name: e.target.value })}
        />
      </Field>
      <Field label="Customer or organisation">
        <input
          className="lt-input"
          value={meta.customer}
          onChange={(e) => updateMeta({ customer: e.target.value })}
        />
      </Field>
      <Field label="Site or location">
        <input
          className="lt-input"
          value={meta.site}
          onChange={(e) => updateMeta({ site: e.target.value })}
        />
      </Field>
      <Field label="Change ticket">
        <input
          className="lt-input"
          value={meta.ticket}
          onChange={(e) => updateMeta({ ticket: e.target.value })}
        />
      </Field>
      <Field label="Engineer">
        <input
          className="lt-input"
          value={meta.engineer}
          onChange={(e) => updateMeta({ engineer: e.target.value })}
        />
      </Field>
      <Field label="Description">
        <textarea
          className="lt-input"
          rows={4}
          value={meta.description}
          onChange={(e) => updateMeta({ description: e.target.value })}
        />
      </Field>
      <p className="lt-help">
        Select a node or a link to configure targets and health rules. Checks run from this
        machine only.
      </p>
    </>
  );
}

function NodeInspector({ nodeId }: { nodeId: string }) {
  const node = useStore((s) => s.doc.nodes.find((n) => n.id === nodeId));
  const update = useStore((s) => s.updateNodeData);
  const status = useStore((s) => s.nodeStatus(nodeId));

  if (!node) return null;

  if (node.type === 'note') {
    const d = node.data as NoteNodeData;
    return (
      <>
        <h2 className="lt-inspector-title">Note</h2>
        <Field label="Title">
          <input
            className="lt-input"
            value={d.title ?? ''}
            onChange={(e) => update(nodeId, { title: e.target.value })}
          />
        </Field>
        <Field label="Body" hint="Supports # headings, - bullets, - [ ] checkboxes, **bold**, `code`">
          <textarea
            className="lt-input lt-mono"
            rows={10}
            value={d.body}
            onChange={(e) => update(nodeId, { body: e.target.value })}
          />
        </Field>
        <div className="lt-row">
          <Field label="Font size">
            <input
              className="lt-input"
              type="number"
              min={9}
              max={40}
              value={d.fontSize}
              onChange={(e) => update(nodeId, { fontSize: Number(e.target.value) })}
            />
          </Field>
          <Field label="Style">
            <select
              className="lt-input"
              value={d.variant}
              onChange={(e) => update(nodeId, { variant: e.target.value as NoteNodeData['variant'] })}
            >
              <option value="plain">Plain note</option>
              <option value="change">Change note</option>
            </select>
          </Field>
        </div>
        <div className="lt-row">
          <Field label="Text">
            <input
              className="lt-color"
              type="color"
              value={d.textColor}
              onChange={(e) => update(nodeId, { textColor: e.target.value })}
            />
          </Field>
          <Field label="Background">
            <input
              className="lt-color"
              type="color"
              value={d.background}
              onChange={(e) => update(nodeId, { background: e.target.value })}
            />
          </Field>
          <Field label="Border">
            <input
              className="lt-color"
              type="color"
              value={d.borderColor}
              onChange={(e) => update(nodeId, { borderColor: e.target.value })}
            />
          </Field>
        </div>
        <label className="lt-check">
          <input
            type="checkbox"
            checked={d.locked}
            onChange={(e) => update(nodeId, { locked: e.target.checked })}
          />
          Lock this note
        </label>
      </>
    );
  }

  const d = node.data as DeviceNodeData;

  return (
    <>
      <h2 className="lt-inspector-title">
        Node
        <span className="lt-chip" style={{ background: STATUS_COLOR[status] }}>
          {STATUS_GLYPH[status]} {STATUS_LABEL[status]}
        </span>
      </h2>

      <Field label="Display name">
        <input
          className="lt-input"
          value={d.label}
          onChange={(e) => update(nodeId, { label: e.target.value })}
        />
      </Field>
      <div className="lt-row">
        <Field label="Device type">
          <select
            className="lt-input"
            value={d.deviceType}
            onChange={(e) => update(nodeId, { deviceType: e.target.value as DeviceType })}
          >
            {Object.entries(DEVICE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Role">
          <input
            className="lt-input"
            value={d.role ?? ''}
            onChange={(e) => update(nodeId, { role: e.target.value })}
          />
        </Field>
      </div>
      <div className="lt-row">
        <Field label="Vendor">
          <input
            className="lt-input"
            value={d.vendor ?? ''}
            onChange={(e) => update(nodeId, { vendor: e.target.value })}
          />
        </Field>
        <Field label="Model">
          <input
            className="lt-input"
            value={d.model ?? ''}
            onChange={(e) => update(nodeId, { model: e.target.value })}
          />
        </Field>
      </div>
      <div className="lt-row">
        <Field label="Hostname">
          <input
            className="lt-input"
            value={d.hostname ?? ''}
            onChange={(e) => update(nodeId, { hostname: e.target.value })}
          />
        </Field>
        <Field label="Rack / room">
          <input
            className="lt-input"
            value={d.rack ?? ''}
            onChange={(e) => update(nodeId, { rack: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Tags" hint="Comma separated">
        <input
          className="lt-input"
          value={d.tags.join(', ')}
          onChange={(e) =>
            update(nodeId, {
              tags: e.target.value
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
            })
          }
        />
      </Field>
      <Field label="Notes">
        <textarea
          className="lt-input"
          rows={3}
          value={d.notes ?? ''}
          onChange={(e) => update(nodeId, { notes: e.target.value })}
        />
      </Field>

      <div className="lt-checks">
        <label className="lt-check">
          <input
            type="checkbox"
            checked={d.showDetails}
            onChange={(e) => update(nodeId, { showDetails: e.target.checked })}
          />
          Show address and status on the canvas
        </label>
        <label className="lt-check">
          <input
            type="checkbox"
            checked={d.locked}
            onChange={(e) => update(nodeId, { locked: e.target.checked })}
          />
          Lock position
        </label>
        <label className="lt-check">
          <input
            type="checkbox"
            checked={d.maintenance}
            onChange={(e) => update(nodeId, { maintenance: e.target.checked })}
          />
          Maintenance — suppress status
        </label>
      </div>

      <AddressList nodeId={nodeId} />
      <ProbeList objectKind="node" objectId={nodeId} />
    </>
  );
}

function AddressList({ nodeId }: { nodeId: string }) {
  const node = useStore((s) => s.doc.nodes.find((n) => n.id === nodeId));
  const update = useStore((s) => s.updateNodeData);
  const d = node?.data as DeviceNodeData | undefined;
  if (!d) return null;
  const addresses = d.addresses ?? [];

  const set = (next: DeviceNodeData['addresses']) => update(nodeId, { addresses: next });

  return (
    <section className="lt-section">
      <h3>
        Addresses
        <button
          type="button"
          className="lt-btn lt-btn-small"
          onClick={() =>
            set([
              ...addresses,
              { id: uid(), label: 'Management', address: '', isPrimary: addresses.length === 0 },
            ])
          }
        >
          Add address
        </button>
      </h3>
      {addresses.length === 0 && (
        <p className="lt-help">No addresses yet. Add one, then create a probe that uses it.</p>
      )}
      {addresses.map((a, i) => (
        <div className="lt-addr" key={a.id}>
          <input
            className="lt-input lt-addr-label"
            value={a.label}
            placeholder="Label"
            onChange={(e) => {
              const next = [...addresses];
              next[i] = { ...a, label: e.target.value };
              set(next);
            }}
          />
          <input
            className="lt-input lt-mono"
            value={a.address}
            placeholder="10.10.10.1 or fw.example.net"
            onChange={(e) => {
              const next = [...addresses];
              next[i] = { ...a, address: e.target.value };
              set(next);
            }}
          />
          <button
            type="button"
            className={`lt-btn lt-btn-small ${a.isPrimary ? 'is-active' : ''}`}
            title="Mark as the primary address"
            onClick={() => set(addresses.map((x, j) => ({ ...x, isPrimary: j === i })))}
          >
            Primary
          </button>
          <button
            type="button"
            className="lt-btn lt-btn-small is-danger"
            onClick={() => set(addresses.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
    </section>
  );
}

function ProbeList({ objectKind, objectId }: { objectKind: 'node' | 'link'; objectId: string }) {
  const meta = useStore((s) => s.meta)!;
  // See DeviceNode: filtering inside the selector allocates a new array per
  // read and loops forever under useSyncExternalStore.
  const allProbes = useStore((s) => s.doc.probes);
  const probes = useMemo(
    () => allProbes.filter((p) => p.objectId === objectId),
    [allProbes, objectId],
  );
  const upsert = useStore((s) => s.upsertProbe);
  const remove = useStore((s) => s.removeProbe);

  // Start a new node probe on the address the node already carries. Leaving it
  // blank means "Add probe" produces something that checks nothing, which
  // reads as the app being broken rather than as a field left to fill in.
  const nodes = useStore((s) => s.doc.nodes);
  const suggestedTarget = useMemo(() => {
    if (objectKind !== 'node') return '';
    const data = nodes.find((n) => n.id === objectId)?.data as DeviceNodeData | undefined;
    const addrs = data?.addresses ?? [];
    return (addrs.find((a) => a.isPrimary) ?? addrs[0])?.address ?? '';
  }, [nodes, objectId, objectKind]);

  return (
    <section className="lt-section">
      <h3>
        Probes
        <button
          type="button"
          className="lt-btn lt-btn-small"
          onClick={() => upsert(newProbe(objectKind, objectId, meta.id, suggestedTarget))}
        >
          Add probe
        </button>
      </h3>
      {probes.length === 0 && (
        <p className="lt-help">
          No probes configured. Nothing here is checked until you add one and start validation.
        </p>
      )}
      {probes.map((p) => (
        <ProbeEditor key={p.id} probe={p} onChange={upsert} onRemove={() => remove(p.id)} />
      ))}
    </section>
  );
}

function ProbeEditor({
  probe,
  onChange,
  onRemove,
}: {
  probe: Probe;
  onChange: (p: Probe) => void;
  onRemove: () => void;
}) {
  const runtime = useStore((s) => s.runtime.get(probe.id));
  const testNow = useStore((s) => s.testNow);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  const patch = (over: Partial<Probe>) => onChange({ ...probe, ...over });

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await testNow(probe);
      setResult(`${r.outcome === 'success' ? 'OK' : 'Failed'} — ${r.summary}`);
    } catch (err) {
      setResult(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="lt-probe">
      <div className="lt-probe-head">
        <button type="button" className="lt-probe-toggle" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'}
        </button>
        <input
          className="lt-input lt-probe-name"
          value={probe.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
        {runtime && (
          <span className="lt-chip" style={{ background: STATUS_COLOR[runtime.status] }}>
            {STATUS_GLYPH[runtime.status]} {STATUS_LABEL[runtime.status]}
          </span>
        )}
        <button type="button" className="lt-btn lt-btn-small is-danger" onClick={onRemove}>
          Remove
        </button>
      </div>

      {open && (
        <div className="lt-probe-body">
          <div className="lt-row">
            <Field label="Type">
              <select
                className="lt-input"
                value={probe.kind}
                onChange={(e) => patch({ kind: e.target.value as ProbeKind })}
              >
                <option value="icmp">ICMP ping</option>
                <option value="tcp">TCP port connect</option>
                <option value="dns">DNS resolution</option>
                <option value="manual">Manual / disabled</option>
              </select>
            </Field>
            <Field label="Target">
              <input
                className="lt-input lt-mono"
                value={probe.target}
                placeholder="10.10.10.1"
                onChange={(e) => patch({ target: e.target.value })}
              />
            </Field>
            {probe.kind === 'tcp' && (
              <Field label="Port">
                <input
                  className="lt-input"
                  type="number"
                  min={1}
                  max={65535}
                  value={probe.tcpPort ?? 443}
                  onChange={(e) => patch({ tcpPort: Number(e.target.value) })}
                />
              </Field>
            )}
          </div>

          <div className="lt-row">
            <Field label="Interval (s)">
              <input
                className="lt-input"
                type="number"
                min={1}
                value={probe.intervalSeconds}
                onChange={(e) => patch({ intervalSeconds: Number(e.target.value) })}
              />
            </Field>
            <Field label="Timeout (ms)">
              <input
                className="lt-input"
                type="number"
                min={100}
                step={100}
                value={probe.timeoutMs}
                onChange={(e) => patch({ timeoutMs: Number(e.target.value) })}
              />
            </Field>
            <Field label="Warn above (ms)">
              <input
                className="lt-input"
                type="number"
                min={1}
                value={probe.warningLatencyMs ?? ''}
                onChange={(e) =>
                  patch({ warningLatencyMs: e.target.value ? Number(e.target.value) : null })
                }
              />
            </Field>
          </div>

          <div className="lt-row">
            <Field label="Fail after" hint="consecutive failures">
              <input
                className="lt-input"
                type="number"
                min={1}
                value={probe.failureThreshold}
                onChange={(e) => patch({ failureThreshold: Number(e.target.value) })}
              />
            </Field>
            <Field label="Recover after" hint="consecutive successes">
              <input
                className="lt-input"
                type="number"
                min={1}
                value={probe.recoveryThreshold}
                onChange={(e) => patch({ recoveryThreshold: Number(e.target.value) })}
              />
            </Field>
          </div>

          <div className="lt-checks">
            <label className="lt-check">
              <input
                type="checkbox"
                checked={probe.enabled}
                onChange={(e) => patch({ enabled: e.target.checked })}
              />
              Enabled
            </label>
            <label className="lt-check">
              <input
                type="checkbox"
                checked={probe.isPrimary}
                onChange={(e) => patch({ isPrimary: e.target.checked })}
              />
              Primary probe for this object
            </label>
            <label className="lt-check">
              <input
                type="checkbox"
                checked={probe.maintenance}
                onChange={(e) => patch({ maintenance: e.target.checked })}
              />
              Maintenance
            </label>
          </div>

          <div className="lt-probe-actions">
            <button
              type="button"
              className="lt-btn"
              onClick={runTest}
              disabled={testing || !probe.target}
              title="Runs this check once. It does not start ongoing monitoring."
            >
              {testing ? 'Testing…' : 'Test now'}
            </button>
            {result && <span className="lt-probe-result lt-mono">{result}</span>}
          </div>

          {runtime?.lastSummary && (
            <p className="lt-help lt-mono">
              Live: {runtime.lastSummary}
              {runtime.consecutiveFailures > 0 &&
                ` · ${runtime.consecutiveFailures} of ${runtime.failureThreshold} failures`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function LinkInspector({ edgeId }: { edgeId: string }) {
  const edge = useStore((s) => s.doc.edges.find((e) => e.id === edgeId));
  const doc = useStore((s) => s.doc);
  const runtime = useStore((s) => s.runtime);
  const sessionRunning = useStore((s) => s.session.state === 'running');
  const nodeStatusOf = useStore((s) => s.nodeStatus);
  const update = useStore((s) => s.updateEdgeData);

  if (!edge) return null;
  const d = edge.data as LinkData;
  const rule = d.healthRule ?? { type: 'manual' as LinkHealthRuleType };

  const status = linkStatus({
    link: { enabled: d.enabled, maintenance: d.maintenance, healthRule: rule },
    sourceStatus: nodeStatusOf(edge.source),
    targetStatus: nodeStatusOf(edge.target),
    linkProbes: doc.probes.filter((p) => p.objectId === edgeId),
    allProbes: doc.probes,
    runtime,
    sessionRunning,
  });

  const nodeProbes = doc.probes.filter((p) => p.objectKind === 'node');
  const nameOf = (id: string) =>
    (doc.nodes.find((n) => n.id === id)?.data as DeviceNodeData | undefined)?.label ?? id;

  return (
    <>
      <h2 className="lt-inspector-title">
        Link
        <span className="lt-chip" style={{ background: STATUS_COLOR[status] }}>
          {STATUS_GLYPH[status]} {STATUS_LABEL[status]}
        </span>
      </h2>
      <p className="lt-help">
        {nameOf(edge.source)} → {nameOf(edge.target)}
        <br />
        Driven by: {describeRule(rule, [...doc.probes])}
      </p>

      <div className="lt-row">
        <Field label="Source port label" hint="e.g. port3">
          <input
            className="lt-input lt-mono"
            value={d.sourcePortLabel}
            onChange={(e) => update(edgeId, { sourcePortLabel: e.target.value })}
          />
        </Field>
        <Field label="Target port label" hint="e.g. Te1/0/48">
          <input
            className="lt-input lt-mono"
            value={d.targetPortLabel}
            onChange={(e) => update(edgeId, { targetPortLabel: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Centre label" hint="e.g. 10 Gb LACP — VLANs 10,20,30">
        <input
          className="lt-input"
          value={d.label}
          onChange={(e) => update(edgeId, { label: e.target.value })}
        />
      </Field>

      <div className="lt-row">
        <Field label="Path">
          <select
            className="lt-input"
            value={d.pathType}
            onChange={(e) => update(edgeId, { pathType: e.target.value as LinkData['pathType'] })}
          >
            <option value="smoothstep">Smooth step</option>
            <option value="step">Step</option>
            <option value="bezier">Bezier</option>
            <option value="straight">Straight</option>
          </select>
        </Field>
        <Field label="Flow direction">
          <select
            className="lt-input"
            value={d.direction}
            onChange={(e) => update(edgeId, { direction: e.target.value as LinkData['direction'] })}
          >
            <option value="forward">Source → target</option>
            <option value="reverse">Target → source</option>
            <option value="both">Bidirectional</option>
            <option value="none">No direction</option>
          </select>
        </Field>
        <Field label="Width">
          <input
            className="lt-input"
            type="number"
            min={1}
            max={10}
            value={d.width}
            onChange={(e) => update(edgeId, { width: Number(e.target.value) })}
          />
        </Field>
      </div>

      <section className="lt-section">
        <h3>Health rule</h3>
        <Field
          label="What determines this link's state"
          hint="This is a rule you choose. LiveTopo does not trace the physical path."
        >
          <select
            className="lt-input"
            value={rule.type}
            onChange={(e) =>
              update(edgeId, {
                healthRule: { ...rule, type: e.target.value as LinkHealthRuleType },
              })
            }
          >
            {Object.entries(HEALTH_RULE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>

        {rule.type === 'manual' && (
          <Field label="Manual status">
            <select
              className="lt-input"
              value={rule.manualStatus ?? 'unknown'}
              onChange={(e) =>
                update(edgeId, {
                  healthRule: {
                    ...rule,
                    manualStatus: e.target.value as LinkData['healthRule']['manualStatus'],
                  },
                })
              }
            >
              {Object.entries(STATUS_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
        )}

        {rule.type === 'named-node-probe' && (
          <Field label="Probe">
            <select
              className="lt-input"
              value={rule.probeId ?? ''}
              onChange={(e) =>
                update(edgeId, { healthRule: { ...rule, probeId: e.target.value } })
              }
            >
              <option value="">Select a probe</option>
              {nodeProbes.map((p) => (
                <option key={p.id} value={p.id}>
                  {nameOf(p.objectId)} — {p.name} ({p.target})
                </option>
              ))}
            </select>
          </Field>
        )}
      </section>

      <div className="lt-checks">
        <label className="lt-check">
          <input
            type="checkbox"
            checked={d.enabled}
            onChange={(e) => update(edgeId, { enabled: e.target.checked })}
          />
          Link enabled
        </label>
        <label className="lt-check">
          <input
            type="checkbox"
            checked={d.maintenance}
            onChange={(e) => update(edgeId, { maintenance: e.target.checked })}
          />
          Maintenance — suppress status
        </label>
      </div>

      <Field label="Notes">
        <textarea
          className="lt-input"
          rows={3}
          value={d.notes ?? ''}
          onChange={(e) => update(edgeId, { notes: e.target.value })}
        />
      </Field>

      {rule.type === 'dedicated-probe' && <ProbeList objectKind="link" objectId={edgeId} />}
    </>
  );
}
