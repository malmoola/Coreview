import { useEffect, useMemo, useState } from 'react';
import { DEFAULTS } from '../../theme';

import { useStore } from '../../state/store';
import { uid } from '../../lib/id';
import { newProbe } from '../../lib/probes';
import { DEVICE_LABEL } from '../icons';
import { STATUS_COLOR } from '../edges/LiveEdge';
import { describeRule, linkStatus } from '../../health/evaluate';
import { describeSelection, withTag, withoutTag } from '../../lib/bulkEdit';
import { buildTimeline, shortDuration, totals } from '../../lib/statusHistory';
import { capsFor } from '../../lib/linkStyle';
import { layersOf, toggleOn } from '../../lib/layers';
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

const CAP_OPTIONS: [string, string][] = [
  ['none', 'Nothing'],
  ['arrow', 'Arrow'],
  ['open-arrow', 'Open arrow'],
  ['circle', 'Circle'],
  ['square', 'Square'],
  ['diamond', 'Diamond'],
];

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
    <label className="cv-field">
      <span className="cv-field-label">{label}</span>
      {children}
      {hint && <span className="cv-field-hint">{hint}</span>}
    </label>
  );
}

export function Inspector() {
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const selectedEdgeId = useStore((s) => s.selectedEdgeId);
  const meta = useStore((s) => s.meta);
  const nodes = useStore((s) => s.doc.nodes);

  const many = nodes.filter((n) => n.selected);

  if (!meta) return null;

  return (
    <aside className="cv-inspector" aria-label="Inspector">
      {many.length > 1 ? (
        <MultiInspector ids={many.map((n) => n.id)} />
      ) : selectedNodeId ? (
        <NodeInspector nodeId={selectedNodeId} />
      ) : selectedEdgeId ? (
        <LinkInspector edgeId={selectedEdgeId} />
      ) : (
        <ProjectInspector />
      )}
    </aside>
  );
}

/**
 * Editing a whole selection at once.
 *
 * A crawl puts dozens of devices on the canvas. Retyping a site tag forty
 * times is what makes people give up on a tool, so this exists — but a bulk
 * editor that overwrites what it was not asked about is worse than none.
 * Nothing here changes a field until that field is used, and a value the
 * selection disagrees on says so rather than showing the first one.
 */
function MultiInspector({ ids }: { ids: string[] }) {
  const nodes = useStore((s) => s.doc.nodes);
  const updateMany = useStore((s) => s.updateManyNodeData);
  const mapMany = useStore((s) => s.mapManyNodeData);
  const [newTag, setNewTag] = useState('');

  const chosen = useMemo(() => {
    const wanted = new Set(ids);
    return nodes.filter((n) => wanted.has(n.id));
  }, [nodes, ids]);
  const sel = useMemo(() => describeSelection(chosen), [chosen]);

  const deviceIds = sel.devices.map((n) => n.id);
  const addTag = () => {
    const tag = newTag.trim();
    if (tag === '') return;
    mapMany(deviceIds, (d) => ({ tags: withTag(d.tags, tag) }), `Tag ${tag}`);
    setNewTag('');
  };

  return (
    <>
      <h2 className="cv-inspector-title">
        {chosen.length} selected
        <span className="cv-inspector-sub">
          {sel.devices.length} device{sel.devices.length === 1 ? '' : 's'}
          {sel.notes.length > 0 && `, ${sel.notes.length} note${sel.notes.length === 1 ? '' : 's'}`}
        </span>
      </h2>

      {sel.devices.length === 0 ? (
        <p className="cv-field-hint">
          Notes have nothing in common to edit together. Select them one at a time.
        </p>
      ) : (
        <>
          <Field
            label="Device type"
            hint={
              sel.deviceType.kind === 'mixed'
                ? 'The selection is mixed — choosing one sets them all'
                : undefined
            }
          >
            <select
              className="cv-input"
              value={sel.deviceType.kind === 'same' ? sel.deviceType.value : ''}
              onChange={(e) =>
                updateMany(
                  deviceIds,
                  { deviceType: e.target.value as DeviceType },
                  'Set device type',
                )
              }
            >
              {sel.deviceType.kind === 'mixed' && (
                <option value="" disabled>
                  Mixed
                </option>
              )}
              {Object.entries(DEVICE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Add a tag" hint="Applied to every selected device that lacks it">
            <div className="cv-row cv-row-tight">
              <input
                className="cv-input"
                value={newTag}
                placeholder="site-hq"
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTag();
                  }
                }}
              />
              <button type="button" className="cv-btn cv-btn-small" onClick={addTag}>
                Add
              </button>
            </div>
          </Field>

          {sel.commonTags.length > 0 && (
            <Field label="Tags on all of them" hint="Click to remove from every selected device">
              <div className="cv-tag-row">
                {sel.commonTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="cv-tag"
                    title={`Remove ${tag} from all ${deviceIds.length}`}
                    onClick={() =>
                      mapMany(deviceIds, (d) => ({ tags: withoutTag(d.tags, tag) }), `Untag ${tag}`)
                    }
                  >
                    {tag} ×
                  </button>
                ))}
              </div>
            </Field>
          )}

          {sel.someTags.length > 0 && (
            <Field
              label="Tags on some of them"
              hint="Left alone. Removing a tag half the selection does not carry is rarely what anyone means"
            >
              <div className="cv-tag-row">
                {sel.someTags.map((tag) => (
                  <span key={tag} className="cv-tag is-partial">
                    {tag}
                  </span>
                ))}
              </div>
            </Field>
          )}

          <BulkLayers ids={chosen.map((n) => n.id)} sel={sel} />

          <div className="cv-checks">
            <TriCheck
              label="Lock position"
              state={sel.locked}
              onSet={(v) => updateMany(deviceIds, { locked: v }, v ? 'Lock' : 'Unlock')}
            />
            <TriCheck
              label="Maintenance — suppress status"
              state={sel.maintenance}
              onSet={(v) => updateMany(deviceIds, { maintenance: v }, 'Set maintenance')}
            />
            <TriCheck
              label="Show address and status on the canvas"
              state={sel.showDetails}
              onSet={(v) => updateMany(deviceIds, { showDetails: v }, 'Set detail')}
            />
          </div>
        </>
      )}
    </>
  );
}

/**
 * Putting a whole selection on a view, or taking it off one.
 *
 * A crawl puts dozens of devices down at once, and the reason to have views at
 * all is to say "these forty are the physical layer". One at a time is the
 * work the bulk editor exists to remove.
 */
function BulkLayers({
  ids,
  sel,
}: {
  ids: string[];
  sel: { commonLayers: string[]; someLayers: string[] };
}) {
  const canvas = useStore((s) => s.doc.canvas);
  const mapMany = useStore((s) => s.mapManyNodeData);
  const layers = layersOf(canvas.layers);
  if (layers.length < 2) return null;

  return (
    <Field
      label="Appears on"
      hint="Click to put the whole selection on a view, or take it off one"
    >
      <div className="cv-tag-row">
        {layers.map((layer) => {
          const all = sel.commonLayers.includes(layer.id);
          const some = sel.someLayers.includes(layer.id);
          return (
            <button
              key={layer.id}
              type="button"
              className={`cv-tag${all ? '' : ' is-partial'}`}
              title={
                all
                  ? `Take the selection off ${layer.name}`
                  : `Put the selection on ${layer.name}`
              }
              onClick={() =>
                mapMany(
                  ids,
                  (d) => ({
                    // Everything on it comes off; anything else goes on. A
                    // half-assigned selection is made uniform rather than
                    // toggled item by item, which would leave it half-assigned
                    // the other way round.
                    layers: all
                      ? withoutLayer_(d.layers, layer.id)
                      : withLayer_(d.layers, layer.id),
                  }),
                  all ? `Off ${layer.name}` : `On ${layer.name}`,
                )
              }
            >
              {layer.name}
              {some && !all ? ' ·' : ''}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

const withLayer_ = (on: string[] | undefined, id: string): string[] =>
  (on ?? []).includes(id) ? (on ?? []) : [...(on ?? []), id];
const withoutLayer_ = (on: string[] | undefined, id: string): string[] =>
  (on ?? []).filter((l) => l !== id);

/** A checkbox with a third state for "the selection disagrees".
 *
 *  An indeterminate box that clears on the first click would turn every locked
 *  device in a mixed selection loose without saying so. The first click always
 *  turns the setting on; unticking then turns it off. */
function TriCheck({
  label,
  state,
  onSet,
}: {
  label: string;
  state: { kind: 'same'; value: boolean } | { kind: 'mixed' } | { kind: 'none' };
  onSet: (value: boolean) => void;
}) {
  const checked = state.kind === 'same' && state.value;
  return (
    <label className="cv-check">
      <input
        type="checkbox"
        checked={checked}
        ref={(el) => {
          if (el) el.indeterminate = state.kind === 'mixed';
        }}
        onChange={(e) => onSet(state.kind === 'mixed' ? true : e.target.checked)}
      />
      {label}
      {state.kind === 'mixed' && <span className="cv-field-hint"> — mixed</span>}
    </label>
  );
}

const WINDOWS: { label: string; ms: number }[] = [
  { label: '15m', ms: 15 * 60_000 },
  { label: '1h', ms: 60 * 60_000 },
  { label: '6h', ms: 6 * 60 * 60_000 },
];

/**
 * What this device's status has been, as a strip.
 *
 * A single dot says what a device is doing now. It cannot say whether it has
 * been solid all afternoon or has dropped out four times, and that difference
 * is usually the whole question. The strip is built from recorded transitions,
 * so the periods nobody was watching are drawn as unknown rather than filled
 * in with whatever the device happens to be doing at the moment.
 */
function StatusStrip({ nodeId }: { nodeId: string }) {
  const events = useStore((s) => s.events);
  const session = useStore((s) => s.session);
  const status = useStore((s) => s.nodeStatus(nodeId));
  const [windowMs, setWindowMs] = useState(WINDOWS[1]!.ms);
  // A single clock for the whole render, so the spans and the axis agree.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const spans = useMemo(
    () =>
      buildTimeline({
        events,
        objectId: nodeId,
        fromMs: now - windowMs,
        toMs: now,
        current: status,
        sessionStartedAt: session.startedAt,
      }),
    [events, nodeId, now, windowMs, status, session.startedAt],
  );

  const summary = useMemo(() => totals(spans), [spans]);
  const span = Math.max(1, windowMs);

  return (
    <div className="cv-history">
      <div className="cv-history-head">
        <span className="cv-field-label">Recent status</span>
        <div className="cv-history-windows">
          {WINDOWS.map((w) => (
            <button
              key={w.label}
              type="button"
              className={w.ms === windowMs ? 'is-at' : ''}
              onClick={() => setWindowMs(w.ms)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <div
        className="cv-history-strip"
        role="img"
        aria-label={summary
          .map((t) => `${STATUS_LABEL[t.status]} ${shortDuration(t.ms)}`)
          .join(', ')}
      >
        {spans.map((s) => (
          <span
            key={`${s.fromMs}-${s.status}`}
            style={{
              width: `${((s.toMs - s.fromMs) / span) * 100}%`,
              background: STATUS_COLOR[s.status],
            }}
            title={`${STATUS_LABEL[s.status]} — ${shortDuration(s.toMs - s.fromMs)}`}
          />
        ))}
      </div>

      <div className="cv-history-legend">
        {summary.length === 0 ? (
          <span className="cv-field-hint">Nothing recorded yet.</span>
        ) : (
          summary.map((t) => (
            <span key={t.status} className="cv-history-key">
              <i style={{ background: STATUS_COLOR[t.status] }} />
              {STATUS_LABEL[t.status]} {shortDuration(t.ms)}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Which views an object appears on.
 *
 * Nothing ticked means every view, which is what an object that has never
 * been assigned is — and is why a diagram drawn before views existed still
 * shows everything.
 */
function LayerPicker({
  on,
  onChange,
}: {
  on: string[] | undefined;
  onChange: (next: string[]) => void;
}) {
  const canvas = useStore((s) => s.doc.canvas);
  const layers = layersOf(canvas.layers);
  if (layers.length < 2) return null;
  return (
    <Field
      label="Appears on"
      hint={!on || on.length === 0 ? 'Every view' : `${on.length} of ${layers.length} views`}
    >
      <div className="cv-tag-row">
        {layers.map((layer) => {
          const picked = Boolean(on?.includes(layer.id));
          return (
            <button
              key={layer.id}
              type="button"
              className={`cv-tag${picked ? '' : ' is-partial'}`}
              onClick={() => onChange(toggleOn(on, layer.id))}
              title={picked ? `Take off ${layer.name}` : `Put on ${layer.name}`}
            >
              {layer.name}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

function ProjectInspector() {
  const meta = useStore((s) => s.meta)!;
  const updateMeta = useStore((s) => s.updateMeta);
  return (
    <>
      <h2 className="cv-inspector-title">Project</h2>
      <Field label="Project name">
        <input
          className="cv-input"
          value={meta.name}
          onChange={(e) => updateMeta({ name: e.target.value })}
        />
      </Field>
      <Field label="Customer or organisation">
        <input
          className="cv-input"
          value={meta.customer}
          onChange={(e) => updateMeta({ customer: e.target.value })}
        />
      </Field>
      <Field label="Site or location">
        <input
          className="cv-input"
          value={meta.site}
          onChange={(e) => updateMeta({ site: e.target.value })}
        />
      </Field>
      <Field label="Change ticket">
        <input
          className="cv-input"
          value={meta.ticket}
          onChange={(e) => updateMeta({ ticket: e.target.value })}
        />
      </Field>
      <Field label="Engineer">
        <input
          className="cv-input"
          value={meta.engineer}
          onChange={(e) => updateMeta({ engineer: e.target.value })}
        />
      </Field>
      <Field label="Description">
        <textarea
          className="cv-input"
          rows={4}
          value={meta.description}
          onChange={(e) => updateMeta({ description: e.target.value })}
        />
      </Field>
      <ProjectCheckTiming />

      <p className="cv-help">
        Select a node or a link to configure targets and health rules. Checks run from this
        machine only.
      </p>
    </>
  );
}

/**
 * The timing policy for every check in the project.
 *
 * "Tell me within fifteen seconds" is one decision, and setting it per probe
 * across ninety devices is not a decision, it is data entry. The two numbers
 * that decide it are here, together, with what they add up to spelled out —
 * an interval and a threshold multiply, and people read them separately.
 */
function ProjectCheckTiming() {
  const probes = useStore((s) => s.doc.probes);
  const setProbeTiming = useStore((s) => s.setProbeTiming);
  const setStatusMessage = useStore((s) => s.setStatusMessage);

  // The policy in force, when every probe agrees on one.
  const interval = probes.length ? probes[0]!.intervalSeconds : PROBE_DEFAULTS.intervalSeconds;
  const threshold = probes.length ? probes[0]!.failureThreshold : PROBE_DEFAULTS.failureThreshold;
  const mixed =
    probes.length > 1 &&
    probes.some((p) => p.intervalSeconds !== interval || p.failureThreshold !== threshold);

  const [everySeconds, setEverySeconds] = useState(interval);
  const [misses, setMisses] = useState(threshold);

  const apply = () => {
    const changed = setProbeTiming(everySeconds, misses);
    setStatusMessage(
      changed === 0
        ? 'Nothing to change — this project has no checks yet.'
        : `Every check now runs every ${everySeconds}s and needs ${misses} missed before a device is called down.`,
    );
  };

  return (
    <div className="cv-timing">
      <span className="cv-subnets-label">Checks</span>
      <div className="cv-timing-row">
        <label className="cv-field cv-field-narrow">
          <span>Every</span>
          <input className="cv-input" type="number" min={1} max={3600} value={everySeconds}
            onChange={(e) => setEverySeconds(Number(e.target.value) || 1)} />
        </label>
        <label className="cv-field cv-field-narrow">
          <span>Missed before down</span>
          <input className="cv-input" type="number" min={1} max={60} value={misses}
            onChange={(e) => setMisses(Number(e.target.value) || 1)} />
        </label>
      </div>
      <p className="cv-help">
        A device that stops answering is called down after about{' '}
        <strong>{everySeconds * misses} seconds</strong>. Missed checks show on the diagram
        straight away, before that.
        {mixed && ' These checks do not all agree today; applying this will make them.'}
      </p>
      <button type="button" className="cv-btn cv-btn-small" onClick={apply}
        disabled={probes.length === 0}>
        Apply to all {probes.length} check{probes.length === 1 ? '' : 's'}
      </button>
    </div>
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
        <h2 className="cv-inspector-title">Note</h2>
        <Field label="Title">
          <input
            className="cv-input"
            value={d.title ?? ''}
            onChange={(e) => update(nodeId, { title: e.target.value })}
          />
        </Field>
        <Field label="Body" hint="Supports # headings, - bullets, - [ ] checkboxes, **bold**, `code`">
          <textarea
            className="cv-input cv-mono"
            rows={10}
            value={d.body}
            onChange={(e) => update(nodeId, { body: e.target.value })}
          />
        </Field>
        <div className="cv-row">
          <Field label="Font size">
            <input
              className="cv-input"
              type="number"
              min={9}
              max={40}
              value={d.fontSize}
              onChange={(e) => update(nodeId, { fontSize: Number(e.target.value) })}
            />
          </Field>
          <Field label="Style">
            <select
              className="cv-input"
              value={d.variant}
              onChange={(e) => update(nodeId, { variant: e.target.value as NoteNodeData['variant'] })}
            >
              <option value="plain">Plain note</option>
              <option value="change">Change note</option>
            </select>
          </Field>
        </div>
        <div className="cv-row">
          <Field label="Text">
            <input
              className="cv-color"
              type="color"
              value={d.textColor}
              onChange={(e) => update(nodeId, { textColor: e.target.value })}
            />
          </Field>
          <Field label="Background">
            <input
              className="cv-color"
              type="color"
              value={d.background}
              onChange={(e) => update(nodeId, { background: e.target.value })}
            />
          </Field>
          <Field label="Border">
            <input
              className="cv-color"
              type="color"
              value={d.borderColor}
              onChange={(e) => update(nodeId, { borderColor: e.target.value })}
            />
          </Field>
        </div>
        <label className="cv-check">
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
      <h2 className="cv-inspector-title">
        Node
        <span className="cv-chip" style={{ background: STATUS_COLOR[status] }}>
          {STATUS_GLYPH[status]} {STATUS_LABEL[status]}
        </span>
      </h2>

      <Field label="Display name">
        <input
          className="cv-input"
          value={d.label}
          onChange={(e) => update(nodeId, { label: e.target.value })}
        />
      </Field>
      <div className="cv-row">
        <Field label="Device type">
          <select
            className="cv-input"
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
            className="cv-input"
            value={d.role ?? ''}
            onChange={(e) => update(nodeId, { role: e.target.value })}
          />
        </Field>
      </div>
      <div className="cv-row">
        <Field label="Vendor">
          <input
            className="cv-input"
            value={d.vendor ?? ''}
            onChange={(e) => update(nodeId, { vendor: e.target.value })}
          />
        </Field>
        <Field label="Model">
          <input
            className="cv-input"
            value={d.model ?? ''}
            onChange={(e) => update(nodeId, { model: e.target.value })}
          />
        </Field>
      </div>
      <div className="cv-row">
        <Field label="Hostname">
          <input
            className="cv-input"
            value={d.hostname ?? ''}
            onChange={(e) => update(nodeId, { hostname: e.target.value })}
          />
        </Field>
        <Field label="Rack / room">
          <input
            className="cv-input"
            value={d.rack ?? ''}
            onChange={(e) => update(nodeId, { rack: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Tags" hint="Comma separated">
        <input
          className="cv-input"
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
          className="cv-input"
          rows={3}
          value={d.notes ?? ''}
          onChange={(e) => update(nodeId, { notes: e.target.value })}
        />
      </Field>

      <div className="cv-checks">
        <label className="cv-check">
          <input
            type="checkbox"
            checked={d.showDetails}
            onChange={(e) => update(nodeId, { showDetails: e.target.checked })}
          />
          Show address and status on the canvas
        </label>
        <label className="cv-check">
          <input
            type="checkbox"
            checked={d.locked}
            onChange={(e) => update(nodeId, { locked: e.target.checked })}
          />
          Lock position
        </label>
        <label className="cv-check">
          <input
            type="checkbox"
            checked={d.maintenance}
            onChange={(e) => update(nodeId, { maintenance: e.target.checked })}
          />
          Maintenance — suppress status
        </label>
      </div>

      <LayerPicker
        on={d.layers}
        onChange={(layers) => update(nodeId, { layers })}
      />
      <StatusStrip nodeId={nodeId} />
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
    <section className="cv-section">
      <h3>
        Addresses
        <button
          type="button"
          className="cv-btn cv-btn-small"
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
        <p className="cv-help">No addresses yet. Add one, then create a probe that uses it.</p>
      )}
      {addresses.map((a, i) => (
        <div className="cv-addr" key={a.id}>
          <input
            className="cv-input cv-addr-label"
            value={a.label}
            placeholder="Label"
            onChange={(e) => {
              const next = [...addresses];
              next[i] = { ...a, label: e.target.value };
              set(next);
            }}
          />
          <input
            className="cv-input cv-mono"
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
            className={`cv-btn cv-btn-small ${a.isPrimary ? 'is-active' : ''}`}
            title="Mark as the primary address"
            onClick={() => set(addresses.map((x, j) => ({ ...x, isPrimary: j === i })))}
          >
            Primary
          </button>
          <button
            type="button"
            className="cv-btn cv-btn-small is-danger"
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
    <section className="cv-section">
      <h3>
        Probes
        <button
          type="button"
          className="cv-btn cv-btn-small"
          onClick={() => upsert(newProbe(objectKind, objectId, meta.id, suggestedTarget))}
        >
          Add probe
        </button>
      </h3>
      {probes.length === 0 && (
        <p className="cv-help">
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
    <div className="cv-probe">
      <div className="cv-probe-head">
        <button type="button" className="cv-probe-toggle" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'}
        </button>
        <input
          className="cv-input cv-probe-name"
          value={probe.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
        {runtime && (
          <span className="cv-chip" style={{ background: STATUS_COLOR[runtime.status] }}>
            {STATUS_GLYPH[runtime.status]} {STATUS_LABEL[runtime.status]}
          </span>
        )}
        <button type="button" className="cv-btn cv-btn-small is-danger" onClick={onRemove}>
          Remove
        </button>
      </div>

      {open && (
        <div className="cv-probe-body">
          <div className="cv-row">
            <Field label="Type">
              <select
                className="cv-input"
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
                className="cv-input cv-mono"
                value={probe.target}
                placeholder="10.10.10.1"
                onChange={(e) => patch({ target: e.target.value })}
              />
            </Field>
            {probe.kind === 'tcp' && (
              <Field label="Port">
                <input
                  className="cv-input"
                  type="number"
                  min={1}
                  max={65535}
                  value={probe.tcpPort ?? 443}
                  onChange={(e) => patch({ tcpPort: Number(e.target.value) })}
                />
              </Field>
            )}
          </div>

          <div className="cv-row">
            <Field label="Interval (s)">
              <input
                className="cv-input"
                type="number"
                min={1}
                value={probe.intervalSeconds}
                onChange={(e) => patch({ intervalSeconds: Number(e.target.value) })}
              />
            </Field>
            <Field label="Timeout (ms)">
              <input
                className="cv-input"
                type="number"
                min={100}
                step={100}
                value={probe.timeoutMs}
                onChange={(e) => patch({ timeoutMs: Number(e.target.value) })}
              />
            </Field>
            <Field label="Warn above (ms)">
              <input
                className="cv-input"
                type="number"
                min={1}
                value={probe.warningLatencyMs ?? ''}
                onChange={(e) =>
                  patch({ warningLatencyMs: e.target.value ? Number(e.target.value) : null })
                }
              />
            </Field>
          </div>

          <div className="cv-row">
            <Field label="Fail after" hint="consecutive failures">
              <input
                className="cv-input"
                type="number"
                min={1}
                value={probe.failureThreshold}
                onChange={(e) => patch({ failureThreshold: Number(e.target.value) })}
              />
            </Field>
            <Field label="Recover after" hint="consecutive successes">
              <input
                className="cv-input"
                type="number"
                min={1}
                value={probe.recoveryThreshold}
                onChange={(e) => patch({ recoveryThreshold: Number(e.target.value) })}
              />
            </Field>
          </div>

          <div className="cv-checks">
            <label className="cv-check">
              <input
                type="checkbox"
                checked={probe.enabled}
                onChange={(e) => patch({ enabled: e.target.checked })}
              />
              Enabled
            </label>
            <label className="cv-check">
              <input
                type="checkbox"
                checked={probe.isPrimary}
                onChange={(e) => patch({ isPrimary: e.target.checked })}
              />
              Primary probe for this object
            </label>
            <label className="cv-check">
              <input
                type="checkbox"
                checked={probe.maintenance}
                onChange={(e) => patch({ maintenance: e.target.checked })}
              />
              Maintenance
            </label>
          </div>

          <div className="cv-probe-actions">
            <button
              type="button"
              className="cv-btn"
              onClick={runTest}
              disabled={testing || !probe.target}
              title="Runs this check once. It does not start ongoing monitoring."
            >
              {testing ? 'Testing…' : 'Test now'}
            </button>
            {result && <span className="cv-probe-result cv-mono">{result}</span>}
          </div>

          {runtime?.lastSummary && (
            <p className="cv-help cv-mono">
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
      <h2 className="cv-inspector-title">
        Link
        <span className="cv-chip" style={{ background: STATUS_COLOR[status] }}>
          {STATUS_GLYPH[status]} {STATUS_LABEL[status]}
        </span>
      </h2>
      <p className="cv-help">
        {nameOf(edge.source)} → {nameOf(edge.target)}
        <br />
        Driven by: {describeRule(rule, [...doc.probes])}
      </p>

      <div className="cv-row">
        <Field label="Source port label" hint="e.g. port3">
          <input
            className="cv-input cv-mono"
            value={d.sourcePortLabel}
            onChange={(e) => update(edgeId, { sourcePortLabel: e.target.value })}
          />
        </Field>
        <Field label="Target port label" hint="e.g. Te1/0/48">
          <input
            className="cv-input cv-mono"
            value={d.targetPortLabel}
            onChange={(e) => update(edgeId, { targetPortLabel: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Centre label" hint="e.g. 10 Gb LACP — VLANs 10,20,30">
        <input
          className="cv-input"
          value={d.label}
          onChange={(e) => update(edgeId, { label: e.target.value })}
        />
      </Field>

      <div className="cv-row">
        <Field label="Path">
          <select
            className="cv-input"
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
            className="cv-input"
            value={d.direction}
            onChange={(e) => update(edgeId, { direction: e.target.value as LinkData['direction'] })}
          >
            <option value="forward">Source → target</option>
            <option value="reverse">Target → source</option>
            <option value="both">Bidirectional</option>
            <option value="none">No direction</option>
          </select>
        </Field>
      </div>

      <section className="cv-section">
        <h3>Health rule</h3>
        <Field
          label="What determines this link's state"
          hint="This is a rule you choose. Coreview does not trace the physical path."
        >
          <select
            className="cv-input"
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
              className="cv-input"
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
              className="cv-input"
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

      <div className="cv-checks">
        <label className="cv-check">
          <input
            type="checkbox"
            checked={d.enabled}
            onChange={(e) => update(edgeId, { enabled: e.target.checked })}
          />
          Link enabled
        </label>
        <label className="cv-check">
          <input
            type="checkbox"
            checked={d.maintenance}
            onChange={(e) => update(edgeId, { maintenance: e.target.checked })}
          />
          Maintenance — suppress status
        </label>
      </div>

      <Field
        label="What this line is"
        hint={
          d.kind === 'leader'
            ? 'A leader carries no health and is not counted'
            : 'A cable, with health and direction'
        }
      >
        <select
          className="cv-input"
          value={d.kind ?? 'link'}
          onChange={(e) => update(edgeId, { kind: e.target.value as LinkData['kind'] })}
        >
          <option value="link">A link between devices</option>
          <option value="leader">A leader, pointing at something</option>
        </select>
      </Field>

      <div className="cv-row">
        <Field label="Line style" hint="Auto follows health">
          <select
            className="cv-input"
            value={d.lineStyle ?? 'auto'}
            onChange={(e) => update(edgeId, { lineStyle: e.target.value as LinkData['lineStyle'] })}
          >
            <option value="auto">Auto — follows health</option>
            <option value="solid">Solid</option>
            <option value="dashed">Dashed</option>
            <option value="dotted">Dotted</option>
            <option value="dash-dot">Dash-dot</option>
          </select>
        </Field>
        <Field label="Thickness">
          <select
            className="cv-input"
            value={String(d.width ?? 2)}
            onChange={(e) => update(edgeId, { width: Number(e.target.value) })}
          >
            {[1, 1.5, 2, 3, 4, 6].map((w) => (
              <option key={w} value={w}>
                {w}px
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="cv-row">
        <Field label="Start end">
          <select
            className="cv-input"
            value={d.startCap ?? capsFor(d).start}
            onChange={(e) => update(edgeId, { startCap: e.target.value as LinkData['startCap'] })}
          >
            {CAP_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Finish end">
          <select
            className="cv-input"
            value={d.endCap ?? capsFor(d).end}
            onChange={(e) => update(edgeId, { endCap: e.target.value as LinkData['endCap'] })}
          >
            {CAP_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="cv-row">
        <Field label="Line colour">
          <select
            className="cv-input"
            value={d.colorMode ?? 'status'}
            onChange={(e) =>
              update(edgeId, { colorMode: e.target.value as LinkData['colorMode'] })
            }
          >
            <option value="status">Follow health</option>
            <option value="fixed">A colour of its own</option>
          </select>
        </Field>
        {d.colorMode === 'fixed' && (
          <Field label="Colour" hint="The dots and arrows still show health">
            <input
              className="cv-color"
              type="color"
              value={d.color || DEFAULTS.accent}
              onChange={(e) => update(edgeId, { color: e.target.value })}
            />
          </Field>
        )}
      </div>

      <div className="cv-checks">
        <label className="cv-check">
          <input
            type="checkbox"
            checked={Boolean(d.pinnedSides)}
            onChange={(e) => update(edgeId, { pinnedSides: e.target.checked })}
          />
          Hold this link to the sides it is on now
        </label>
        <span className="cv-field-hint">
          Links normally swing round to face wherever their devices have been moved. Hold one when
          you have deliberately drawn it the long way round.
        </span>
      </div>

      <LayerPicker on={d.layers as string[] | undefined} onChange={(layers) => update(edgeId, { layers })} />

      <Field label="Notes">
        <textarea
          className="cv-input"
          rows={3}
          value={d.notes ?? ''}
          onChange={(e) => update(edgeId, { notes: e.target.value })}
        />
      </Field>

      {rule.type === 'dedicated-probe' && <ProbeList objectKind="link" objectId={edgeId} />}
    </>
  );
}
