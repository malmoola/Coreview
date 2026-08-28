import { memo, useMemo } from 'react';
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';

import { ICONS } from '../icons';
import { STATUS_COLOR } from '../edges/LiveEdge';
import { useStore } from '../../state/store';
import type { DeviceNodeData } from '../../types/domain';
import { STATUS_GLYPH, STATUS_LABEL } from '../../types/domain';

const SHAPE_TYPES = new Set(['rectangle', 'rounded', 'circle', 'diamond', 'cloud', 'text']);

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

  const Icon = ICONS[d.deviceType] ?? ICONS.generic;
  const color = STATUS_COLOR[status];
  const primary = probes.find((p) => p.isPrimary && p.enabled) ?? probes.find((p) => p.enabled);
  const live = primary ? runtime.get(primary.id) : undefined;
  const primaryAddress =
    d.addresses?.find((a) => a.isPrimary)?.address ?? d.addresses?.[0]?.address ?? '';

  const isShape = SHAPE_TYPES.has(d.deviceType);
  const isText = d.deviceType === 'text';

  return (
    <div
      className={`cv-node ${isShape ? 'cv-node-shape' : ''} ${selected ? 'is-selected' : ''}`}
      data-shape={d.deviceType}
      style={{
        borderColor: selected ? '#5eb8ff' : (d.style?.border ?? color),
        background: d.style?.background ?? undefined,
      }}
      title={`${d.label} — ${STATUS_LABEL[status]}`}
    >
      <NodeResizer
        isVisible={Boolean(selected) && !d.locked}
        minWidth={80}
        minHeight={56}
        lineClassName="cv-resize-line"
        handleClassName="cv-resize-handle"
      />

      <Handle type="target" position={Position.Top} id="t" className="cv-handle" />
      <Handle type="source" position={Position.Right} id="r" className="cv-handle" />
      <Handle type="source" position={Position.Bottom} id="b" className="cv-handle" />
      <Handle type="target" position={Position.Left} id="l" className="cv-handle" />

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
          <div className="cv-node-label">{d.label}</div>
          {d.showDetails && !isText && (
            <div className="cv-node-detail">
              {primaryAddress && <div className="cv-mono">{primaryAddress}</div>}
              <div className="cv-node-status-line" style={{ color }}>
                {STATUS_LABEL[status]}
                {live?.lastRttMs != null && status !== 'down'
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
