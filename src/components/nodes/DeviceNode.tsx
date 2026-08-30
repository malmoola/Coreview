import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';

import { ICONS } from '../icons';
import { canvasPalette, statusColors } from '../../theme';
import { useStore } from '../../state/store';
import type { DeviceNodeData } from '../../types/domain';
import { STATUS_GLYPH, STATUS_LABEL } from '../../types/domain';

const SHAPE_TYPES = new Set(['rectangle', 'rounded', 'circle', 'diamond', 'cloud', 'text', 'zone']);

/** Shapes a border and a border-radius cannot draw.
 *
 *  A rectangle, a rounded rectangle, a circle and a diamond are all a box with
 *  the right corners. A cloud is not, and it was quietly falling through to a
 *  plain rectangle — the shape was in the palette and drew a box on the
 *  canvas. These get a stretched outline drawn behind them instead. */
const OUTLINES: Partial<Record<string, string>> = {
  // Drawn in a 200x100 box and stretched to whatever the node is, so a wide
  // cloud looks like a wide cloud rather than a small one in a big box.
  cloud:
    'M46,88 C22,88 8,74 10,58 C12,44 26,36 38,39 C43,17 63,6 84,11 ' +
    'C99,15 109,26 112,39 C126,29 148,32 157,47 C176,46 192,58 189,73 ' +
    'C187,84 174,88 160,88 Z',
};

/**
 * A node label that can be typed on directly.
 *
 * Renaming a device meant selecting it, finding the field in the inspector and
 * typing there — three places for one word. Double-click puts the caret on the
 * label where it is drawn, which is where the eye already is.
 *
 * `nodrag` and `nopan` keep React Flow from treating the caret and the text
 * selection as the start of a drag.
 */
function EditableLabel({
  value,
  className,
  onCommit,
}: {
  value: string;
  className: string;
  onCommit: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    // An empty name would leave an unidentifiable shape on the diagram.
    if (next && next !== value) onCommit(next);
    else setDraft(value);
    setEditing(false);
  };

  if (!editing) {
    return (
      <div
        className={className}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setDraft(value);
          setEditing(true);
        }}
        title="Double-click to rename"
      >
        {value}
      </div>
    );
  }

  return (
    <input
      ref={input}
      className={`${className} cv-inline-edit nodrag nopan`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setDraft(value);
          setEditing(false);
        }
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    />
  );
}

function DeviceNodeInner({ id, data, selected }: NodeProps) {
  const d = data as DeviceNodeData;
  const status = useStore((s) => s.nodeStatus(id));
  // s.doc.probes is a stable reference; filtering *inside* the selector would
  // return a fresh array on every store read, and useSyncExternalStore compares
  // with Object.is — that is an infinite render loop.
  const allProbes = useStore((s) => s.doc.probes);
  const probes = useMemo(
    () => allProbes.filter((p) => p.objectId === id),
    [allProbes, id],
  );
  const runtime = useStore((s) => s.runtime);
  const nodeStyle = useStore((s) => s.doc.canvas.nodeStyle ?? 'glyph');
  const ground = useStore((s) => s.settings.ground);
  const rename = useStore((s) => s.updateNodeData);

  const Icon = ICONS[d.deviceType] ?? ICONS.generic;
  const color = statusColors(ground)[status];
  const primary = probes.find((p) => p.isPrimary && p.enabled) ?? probes.find((p) => p.enabled);
  const live = primary ? runtime.get(primary.id) : undefined;
  const address =
    d.addresses?.find((a) => a.isPrimary)?.address ?? d.addresses?.[0]?.address ?? '';
  // A device with no name of its own is labelled with its address, and showing
  // that address again underneath is the same string twice.
  const primaryAddress = address === d.label ? '' : address;

  // A device that has stopped answering but has not yet failed enough times
  // to be called down. It is still drawn as healthy, because that is what the
  // rule says — but drawn as *confirmed* healthy it is a claim the app cannot
  // stand behind, and for the fifteen seconds the default thresholds take, a
  // device someone has just unplugged looks perfectly fine.
  const missed = live && live.consecutiveFailures > 0 ? live.consecutiveFailures : 0;
  const failing = missed > 0 && status !== 'down' && status !== 'disabled';
  const missedLabel = failing ? `${missed} of ${live?.failureThreshold ?? '?'} missed` : null;

  const isShape = SHAPE_TYPES.has(d.deviceType);
  const isText = d.deviceType === 'text';
  // The annotation shapes are boxes by definition — a rectangle drawn as a
  // glyph is not a rectangle — so they keep the drawn form either way.
  const glyph = nodeStyle === 'glyph' && !isShape && !isText;

  if (glyph) {
    return (
      <div
        className={`cv-glyph-node ${selected ? 'is-selected' : ''}`}
        title={`${d.label} — ${STATUS_LABEL[status]}`}
      >
        <NodeResizer
          isVisible={Boolean(selected) && !d.locked}
          minWidth={72}
          minHeight={72}
          lineClassName="cv-resize-line"
          handleClassName="cv-resize-handle"
        />
        <Handle type="source" position={Position.Top} id="t" className="cv-handle" />
        <Handle type="source" position={Position.Right} id="r" className="cv-handle" />
        <Handle type="source" position={Position.Bottom} id="b" className="cv-handle" />
        <Handle type="source" position={Position.Left} id="l" className="cv-handle" />

        <div
          className={`cv-glyph-art${failing ? ' is-failing' : ''}`}
          style={{ color: d.style?.iconColor ?? color }}
        >
          {d.imageDataUrl ? <img src={d.imageDataUrl} alt="" /> : <Icon />}
          <span
            key={status}
            className="cv-glyph-badge cv-status-pulse"
            style={{ background: color }}
            title={`${STATUS_LABEL[status]}${live?.lastSummary ? ` — ${live.lastSummary}` : ''}`}
          >
            <span aria-hidden>{STATUS_GLYPH[status]}</span>
            <span className="cv-sr">{STATUS_LABEL[status]}</span>
          </span>
          {d.locked && <span className="cv-glyph-lock" title="Locked" aria-label="Locked">🔒</span>}
        </div>

        {/* Text sits under the glyph and is allowed to be wider than it, so
            adding an address moves nothing and resizes nothing. */}
        <div className="cv-glyph-text">
          <EditableLabel
            className="cv-glyph-label"
            value={d.label}
            onCommit={(label) => rename(id, { label })}
          />
          {d.showDetails && (
            <>
              {primaryAddress && <div className="cv-glyph-addr">{primaryAddress}</div>}
              <div className="cv-glyph-status" style={{ color: failing ? '#e8a33d' : color }}>
                {STATUS_LABEL[status]}
                {missedLabel
                  ? ` · ${missedLabel}`
                  : live?.lastRttMs != null && status !== 'down'
                    ? ` · ${live.lastRttMs < 1 ? '<1' : live.lastRttMs.toFixed(0)} ms`
                    : ''}
              </div>
              {d.maintenance && <div className="cv-node-maint">In maintenance</div>}
            </>
          )}
        </div>
      </div>
    );
  }

  const isZone = d.deviceType === 'zone';
  const outline = OUTLINES[d.deviceType];
  const strokeColor = selected ? canvasPalette(ground).selection : (d.style?.border ?? color);

  return (
    <div
      className={`cv-node ${isShape ? 'cv-node-shape' : ''} ${isZone ? 'cv-zone' : ''} ${
        selected ? 'is-selected' : ''
      }`}
      data-shape={d.deviceType}
      style={{
        // A shape with its own outline must not also draw the box's border,
        // and an inline colour would beat the stylesheet rule that hides it.
        borderColor: outline || isText ? 'transparent' : strokeColor,
        background: outline ? 'transparent' : (d.style?.background ?? undefined),
      }}
      title={`${d.label} — ${STATUS_LABEL[status]}`}
    >
      {outline && (
        <svg
          className="cv-node-outline"
          viewBox="0 0 200 100"
          preserveAspectRatio="none"
          aria-hidden
        >
          <path
            d={outline}
            fill={d.style?.background ?? 'none'}
            stroke={strokeColor}
            strokeWidth={selected ? 3 : 2}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      <NodeResizer
        isVisible={Boolean(selected) && !d.locked}
        minWidth={80}
        minHeight={56}
        lineClassName="cv-resize-line"
        handleClassName="cv-resize-handle"
      />

      <Handle type="source" position={Position.Top} id="t" className="cv-handle" />
      <Handle type="source" position={Position.Right} id="r" className="cv-handle" />
      <Handle type="source" position={Position.Bottom} id="b" className="cv-handle" />
      <Handle type="source" position={Position.Left} id="l" className="cv-handle" />

      {!isText && (
        <span
          // Re-keying on status remounts the badge, which retriggers the CSS
          // pulse below. A state change gets a brief, cheap acknowledgement.
          key={status}
          className="cv-status-badge cv-status-pulse"
          style={{ background: color }}
          title={`${STATUS_LABEL[status]}${live?.lastSummary ? ` — ${live.lastSummary}` : ''}`}
        >
          <span aria-hidden>{STATUS_GLYPH[status]}</span>
          <span className="cv-sr">{STATUS_LABEL[status]}</span>
        </span>
      )}

      {d.locked && (
        <span className="cv-lock" title="Locked" aria-label="Locked">
          🔒
        </span>
      )}

      <div className="cv-node-body">
        {!isShape && (
          <div className="cv-node-icon" style={{ color: d.style?.iconColor ?? color }}>
            {d.imageDataUrl ? (
              <img src={d.imageDataUrl} alt="" className="cv-node-image" />
            ) : (
              <Icon />
            )}
          </div>
        )}
        <div className="cv-node-text">
          <EditableLabel
            className="cv-node-label"
            value={d.label}
            onCommit={(label) => rename(id, { label })}
          />
          {d.showDetails && !isText && (
            <div className="cv-node-detail">
              {primaryAddress && <div className="cv-mono">{primaryAddress}</div>}
              <div className="cv-node-status-line" style={{ color: failing ? '#e8a33d' : color }}>
                {STATUS_LABEL[status]}
                {missedLabel
                  ? ` · ${missedLabel}`
                  : live?.lastRttMs != null && status !== 'down'
                    ? ` · ${live.lastRttMs < 1 ? '<1' : live.lastRttMs.toFixed(0)} ms`
                    : ''}
              </div>
              {d.maintenance && <div className="cv-node-maint">In maintenance</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const DeviceNode = memo(DeviceNodeInner);
