import { memo } from 'react';
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
  const probes = useStore((s) => s.doc.probes.filter((p) => p.objectId === id));
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
      className={`lt-node ${isShape ? 'lt-node-shape' : ''} ${selected ? 'is-selected' : ''}`}
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
        lineClassName="lt-resize-line"
        handleClassName="lt-resize-handle"
      />

      <Handle type="target" position={Position.Top} id="t" className="lt-handle" />
      <Handle type="source" position={Position.Right} id="r" className="lt-handle" />
      <Handle type="source" position={Position.Bottom} id="b" className="lt-handle" />
      <Handle type="target" position={Position.Left} id="l" className="lt-handle" />

      {!isText && (
        <span
          className="lt-status-badge"
          style={{ background: color }}
          title={`${STATUS_LABEL[status]}${live?.lastSummary ? ` — ${live.lastSummary}` : ''}`}
        >
          <span aria-hidden>{STATUS_GLYPH[status]}</span>
          <span className="lt-sr">{STATUS_LABEL[status]}</span>
        </span>
      )}

      {d.locked && (
        <span className="lt-lock" title="Locked" aria-label="Locked">
          🔒
        </span>
      )}

      <div className="lt-node-body">
        {!isShape && (
          <div className="lt-node-icon" style={{ color: d.style?.iconColor ?? color }}>
            {d.imageDataUrl ? (
              <img src={d.imageDataUrl} alt="" className="lt-node-image" />
            ) : (
              <Icon />
            )}
          </div>
        )}
        <div className="lt-node-text">
          <div className="lt-node-label">{d.label}</div>
          {d.showDetails && !isText && (
            <div className="lt-node-detail">
              {primaryAddress && <div className="lt-mono">{primaryAddress}</div>}
              <div className="lt-node-status-line" style={{ color }}>
                {STATUS_LABEL[status]}
                {live?.lastRttMs != null && status !== 'down'
                  ? ` · ${live.lastRttMs < 1 ? '<1' : live.lastRttMs.toFixed(0)} ms`
                  : ''}
              </div>
              {d.maintenance && <div className="lt-node-maint">In maintenance</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const DeviceNode = memo(DeviceNodeInner);
