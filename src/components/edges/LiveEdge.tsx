import { memo, useMemo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  type EdgeProps,
} from '@xyflow/react';

import type { HealthStatus, LinkData } from '../../types/domain';
import { STATUS_GLYPH, STATUS_LABEL } from '../../types/domain';
import { useStore } from '../../state/store';
import { describeRule, linkStatus, shouldAnimate } from '../../health/evaluate';

export const STATUS_COLOR: Record<HealthStatus, string> = {
  unknown: '#5b6b7c',
  healthy: '#2fbf6b',
  warning: '#e8a33d',
  down: '#e4564a',
  disabled: '#3d4a58',
  maintenance: '#8b7ff0',
};

/** Dot travel time in seconds. Deliberately not derived from RTT: a constant
 *  speed keeps the animation a status indicator rather than a fake throughput
 *  gauge. Warning is slower purely as a second, non-color cue. */
const SPEED_SECONDS: Partial<Record<HealthStatus, number>> = {
  healthy: 2.2,
  warning: 4.4,
};

function pathFor(type: LinkData['pathType'], p: Parameters<typeof getBezierPath>[0]) {
  switch (type) {
    case 'straight':
      return getStraightPath({
        sourceX: p.sourceX,
        sourceY: p.sourceY,
        targetX: p.targetX,
        targetY: p.targetY,
      });
    case 'step':
      return getSmoothStepPath({ ...p, borderRadius: 0 });
    case 'smoothstep':
      return getSmoothStepPath({ ...p, borderRadius: 12 });
    default:
      return getBezierPath(p);
  }
}

function LiveEdgeInner(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected } =
    props;
  const data = (props.data ?? {}) as LinkData;

  const doc = useStore((s) => s.doc);
  const runtime = useStore((s) => s.runtime);
  const sessionRunning = useStore((s) => s.session.state === 'running');
  const reduceMotion = useStore((s) => s.settings.reduceMotion);
  const nodeStatusOf = useStore((s) => s.nodeStatus);

  const edge = doc.edges.find((e) => e.id === id);
  const sourceStatus = edge ? nodeStatusOf(edge.source) : 'unknown';
  const targetStatus = edge ? nodeStatusOf(edge.target) : 'unknown';

  const status = linkStatus({
    link: {
      enabled: data.enabled ?? true,
      maintenance: data.maintenance ?? false,
      healthRule: data.healthRule ?? { type: 'manual' },
    },
    sourceStatus,
    targetStatus,
    linkProbes: doc.probes.filter((p) => p.objectId === id),
    allProbes: doc.probes,
    runtime,
    sessionRunning,
  });

  const [edgePath, labelX, labelY] = useMemo(
    () =>
      pathFor(data.pathType ?? 'smoothstep', {
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition,
        targetPosition,
      }),
    [data.pathType, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition],
  );

  const color = STATUS_COLOR[status];
  const animate = shouldAnimate(status, reduceMotion);
  const duration = SPEED_SECONDS[status] ?? 3;
  const direction = data.direction ?? 'forward';
  const width = data.width ?? 2;

  const dash =
    status === 'down'
      ? '10 6'
      : status === 'disabled'
        ? '2 6'
        : status === 'maintenance'
          ? '12 6'
          : undefined;

  const dotCount = 3;
  const dots: Array<{ key: string; begin: string; reverse: boolean }> = [];
  if (animate) {
    const forward = direction === 'forward' || direction === 'both' || direction === 'none';
    const reverse = direction === 'reverse' || direction === 'both';
    for (let i = 0; i < dotCount; i += 1) {
      const begin = `${((i * duration) / dotCount).toFixed(2)}s`;
      if (forward) dots.push({ key: `f${i}`, begin, reverse: false });
      if (reverse) dots.push({ key: `r${i}`, begin, reverse: true });
    }
  }

  const probesForLink = doc.probes.filter((p) => p.objectId === id);
  const ruleText = describeRule(data.healthRule ?? { type: 'manual' }, [
    ...probesForLink,
    ...doc.probes,
  ]);
  const liveProbe = probesForLink.find((p) => p.enabled);
  const live = liveProbe ? runtime.get(liveProbe.id) : undefined;

  const tooltip = [
    `Health: ${STATUS_LABEL[status]}`,
    `Rule: ${ruleText}`,
    liveProbe ? `Target: ${liveProbe.target}` : null,
    live?.lastSummary ? `Last result: ${live.lastSummary}` : null,
    live?.lastSuccessMs || live?.lastFailureMs
      ? `Last updated: ${new Date(
          Math.max(live.lastSuccessMs ?? 0, live.lastFailureMs ?? 0),
        ).toLocaleTimeString()}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  const markerEnd =
    direction === 'forward' || direction === 'both' ? `url(#lt-arrow-${status})` : undefined;
  const markerStart =
    direction === 'reverse' || direction === 'both' ? `url(#lt-arrow-rev-${status})` : undefined;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: color,
          strokeWidth: selected ? width + 1.5 : width,
          strokeDasharray: dash,
          opacity: status === 'disabled' ? 0.55 : 1,
          filter: selected ? `drop-shadow(0 0 6px ${color})` : undefined,
        }}
        markerEnd={markerEnd}
        markerStart={markerStart}
      />
      {/* Invisible wide path so hovering the thin line is practical. */}
      <path d={edgePath} fill="none" stroke="transparent" strokeWidth={18}>
        <title>{tooltip}</title>
      </path>

      {dots.map((d) => (
        <circle key={d.key} r={3.2} fill={color} opacity={0.95}>
          <animateMotion
            dur={`${duration}s`}
            begin={d.begin}
            repeatCount="indefinite"
            path={edgePath}
            keyPoints={d.reverse ? '1;0' : '0;1'}
            keyTimes="0;1"
            calcMode="linear"
          />
        </circle>
      ))}

      {status === 'down' && (
        <circle cx={labelX} cy={labelY} r={4} fill={STATUS_COLOR.down} opacity={0.9} />
      )}

      <EdgeLabelRenderer>
        {data.sourcePortLabel ? (
          <div
            className="lt-edge-label lt-edge-port"
            style={{
              transform: `translate(-50%, -50%) translate(${sourceX + (targetX - sourceX) * 0.16}px, ${
                sourceY + (targetY - sourceY) * 0.16
              }px)`,
            }}
          >
            {data.sourcePortLabel}
          </div>
        ) : null}

        {data.label ? (
          <div
            className="lt-edge-label lt-edge-center"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              borderColor: color,
            }}
            title={tooltip}
          >
            <span className="lt-edge-glyph" style={{ color }} aria-hidden>
              {STATUS_GLYPH[status]}
            </span>
            {data.label}
          </div>
        ) : null}

        {data.targetPortLabel ? (
          <div
            className="lt-edge-label lt-edge-port"
            style={{
              transform: `translate(-50%, -50%) translate(${targetX + (sourceX - targetX) * 0.16}px, ${
                targetY + (sourceY - targetY) * 0.16
              }px)`,
            }}
          >
            {data.targetPortLabel}
          </div>
        ) : null}
      </EdgeLabelRenderer>
    </>
  );
}

/** Arrow markers, one per status colour, mounted once by the canvas. */
export function EdgeMarkerDefs() {
  const statuses = Object.keys(STATUS_COLOR) as HealthStatus[];
  return (
    <svg style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden>
      <defs>
        {statuses.map((s) => (
          <marker
            key={s}
            id={`lt-arrow-${s}`}
            markerWidth="12"
            markerHeight="12"
            refX="9"
            refY="4"
            orient="auto"
          >
            <path d="M0,0 L8,4 L0,8 z" fill={STATUS_COLOR[s]} />
          </marker>
        ))}
        {statuses.map((s) => (
          <marker
            key={`rev-${s}`}
            id={`lt-arrow-rev-${s}`}
            markerWidth="12"
            markerHeight="12"
            refX="-1"
            refY="4"
            orient="auto"
          >
            <path d="M8,0 L0,4 L8,8 z" fill={STATUS_COLOR[s]} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

export const LiveEdge = memo(LiveEdgeInner);
