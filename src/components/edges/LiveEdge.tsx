import { memo, useEffect, useMemo, useSyncExternalStore } from 'react';
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
import { describeRule, shouldAnimate } from '../../health/evaluate';
import { STATUS_COLOR_DARK, readableOn, statusColors } from '../../theme';
import { capPath, capsFor, dashFor } from '../../lib/linkStyle';
import { jumpsFor, withJumps } from '../../lib/lineJumps';
import {
  MAX_EDGES_FOR_JUMPS,
  allPaths,
  forgetPath,
  pathVersion,
  registerPath,
  subscribePaths,
} from './pathRegistry';

/** Kept as a named export because the diagram exporter and several panels
 *  import it. The canvas uses the ground-aware set instead. */
export const STATUS_COLOR = STATUS_COLOR_DARK;

/**
 * How far along a link its port labels sit, as a fraction from each end.
 *
 * It was 0.16, which is fine for a single link and unreadable for a switch
 * with five: every link leaves the same handle, so at a sixth of the way along
 * they had not diverged yet and all five labels landed on the same spot. A
 * third of the way along is past the fan-out, where the links have separated
 * by roughly the spacing between the devices they run to.
 */
const PORT_LABEL_AT = 0.32;

/** Where along the drawn path the two port labels sit.
 *
 *  They used to sit on the straight chord between the handles, a third of
 *  the way along. Two parallel cables between one pair share that chord, so
 *  their chips stacked — the lab showed two links both reading "Gi1/0/11"
 *  with the 1/0/12 pair hidden exactly underneath (LT-055) — and a third of
 *  the way along is the middle of the room, not the port (LT-050). On the
 *  drawn path the lanes have separated, and a fixed distance from each end
 *  keeps the chip beside its own device at any link length. */
function portAnchors(id: string, edgePath: string): { s: DOMPoint; t: DOMPoint } | null {
  try {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', edgePath);
    const len = p.getTotalLength();
    if (!len || !Number.isFinite(len)) return null;
    // Parallel cables out of one handle share their first stretch of path, so
    // a fixed distance stacks their chips exactly — which is how "Gi1/0/12"
    // hid under "Gi1/0/11". Edges sharing this edge's start point are ranked
    // by id, and each rank slides one chip-length further along the trunk.
    const head = (d: string) => d.slice(0, d.indexOf('L') > 0 ? d.indexOf('L') : 24);
    const mine = head(edgePath);
    let rank = 0;
    for (const [otherId, otherPath] of allPaths()) {
      if (otherId !== id && head(otherPath) === mine && otherId < id) rank += 1;
    }
    // A full chip-length per rank, or neighbouring chips still overlap.
    const near = (end: number) =>
      Math.min(46 + rank * 66, len * (0.4 - 0.08 * Math.min(rank, 3))) * end;
    return {
      s: p.getPointAtLength(near(1)),
      t: p.getPointAtLength(len - near(1)),
    };
  } catch {
    // jsdom has no SVG geometry; the chord fallback below still renders.
    return null;
  }
}

/** Dot travel time in seconds. Deliberately not derived from RTT: a constant
 *  speed keeps the animation a status indicator rather than a fake throughput
 *  gauge. Warning is slower purely as a second, non-color cue. */
const SPEED_SECONDS: Partial<Record<HealthStatus, number>> = {
  healthy: 2.2,
  warning: 4.4,
};

/** Where along the gap a link makes its turn.
 *
 *  Six links off the same side of a switch all turn at the halfway point and
 *  their long runs lie exactly on top of one another; the diagram is not wrong
 *  but no single cable can be followed through it. Moving the turn shifts the
 *  whole run, which pulls them apart.
 *
 *  Lanes alternate either side of the middle with a growing step, so the first
 *  link is exactly where it always was and a diagram with no crowding looks
 *  untouched. Clamped well short of the ends, where a run would end up tucked
 *  against a device instead of between two. */
function laneStep(lane: number): number {
  if (lane <= 0) return 0.5;
  const magnitude = 0.075 * Math.ceil(lane / 2);
  const shifted = 0.5 + (lane % 2 === 1 ? -magnitude : magnitude);
  return Math.min(0.82, Math.max(0.18, shifted));
}

function pathFor(
  type: LinkData['pathType'],
  p: Parameters<typeof getBezierPath>[0],
  lane = 0,
) {
  switch (type) {
    case 'straight':
      return getStraightPath({
        sourceX: p.sourceX,
        sourceY: p.sourceY,
        targetX: p.targetX,
        targetY: p.targetY,
      });
    case 'step':
      return getSmoothStepPath({ ...p, borderRadius: 0, stepPosition: laneStep(lane) });
    case 'smoothstep':
      return getSmoothStepPath({ ...p, borderRadius: 12, stepPosition: laneStep(lane) });
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
  const reduceMotion = useStore((s) => s.settings.reduceMotion);
  const linkStatusOf = useStore((s) => s.linkStatus);

  // Through the store rather than calling the evaluator here, so the diagram
  // export resolves link status the same way the canvas does.
  const status = linkStatusOf(id);

  const [edgePath, labelX, labelY] = useMemo(
    () =>
      pathFor(data.pathType ?? 'smoothstep', {
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition,
        targetPosition,
      }, data.lane ?? 0),
    [
      data.pathType,
      data.lane,
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
    ],
  );

  const ground = useStore((s) => s.settings.ground);
  // A leader points a note at what it is about. It is an annotation, not a
  // cable: nothing travels along it, it carries no health, and it does not
  // hop over the links it crosses.
  const isLeader = data.kind === 'leader';
  const jumpsEnabled = useStore((s) => s.doc.canvas.lineJumps ?? true);
  const color = statusColors(ground)[status];
  // The line can be given a colour of its own — a fibre run, a carrier
  // circuit, a VLAN — without the link ceasing to be a live one. Everything
  // that reports health keeps the status colour: the travelling dots, the
  // halo, the arrowheads and the dash pattern. Only the line itself changes,
  // so a red link that is up still reads as up.
  // A colour someone picked to stand out on black is invisible on white, so
  // it is darkened just enough to be seen rather than overridden, which would
  // lose the choice entirely.
  const lineColor = isLeader
    ? 'var(--text-faint)'
    : data.colorMode === 'fixed' && data.color
      ? readableOn(data.color, ground)
      : color;
  // A leader carries nothing, so nothing travels along it.
  const animate = !isLeader && shouldAnimate(status, reduceMotion);
  const duration = SPEED_SECONDS[status] ?? 3;
  const direction = data.direction ?? 'forward';
  const width = data.width ?? 2;

  // Register the plain path and read the others', so a crossing can be found.
  // What is registered is never the hopped path, or an edge redrawing itself
  // with hops would set every other edge recomputing.
  const version = useSyncExternalStore(subscribePaths, pathVersion, pathVersion);
  useEffect(() => {
    registerPath(id, edgePath);
  }, [id, edgePath]);
  useEffect(() => () => forgetPath(id), [id]);

  // Re-ranked when the registry settles, or a chip keeps a stale rank after
  // its parallel neighbour appears.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const anchors = useMemo(() => portAnchors(id, edgePath), [id, edgePath, version]);
  const drawnPath = useMemo(() => {
    // A leader is an annotation. Hopping it over the cables it crosses would
    // say it is one of them.
    if (!jumpsEnabled || isLeader) return edgePath;
    const others = allPaths();
    if (others.size > MAX_EDGES_FOR_JUMPS) return edgePath;
    void version;
    // Sized to the line. A 5px hop on a 6px cable is a wobble; the arc has
    // to clear the line it is hopping to read as a hop at all.
    const radius = Math.max(5, (data.width ?? 2) * 2.6);
    return withJumps(edgePath, jumpsFor(id, edgePath, others, radius * 2), radius);
  }, [id, edgePath, jumpsEnabled, isLeader, version, data.width]);

  const dash = isLeader ? (data.lineStyle === 'solid' ? undefined : '4 4') : dashFor(data.lineStyle, status);
  const caps = isLeader
    ? { start: data.startCap ?? 'none', end: data.endCap ?? 'none' }
    : capsFor(data);

  const dotCount = 3;
  /** Each dot gets one trailing companion: smaller, dimmer and slightly behind.
   *  Reads as a comet without the cost of a real particle system. */
  const TRAIL = [
    { r: 3.2, opacity: 0.95, lag: 0 },
    { r: 2.0, opacity: 0.4, lag: 0.1 },
  ];
  const dots: Array<{ key: string; begin: string; reverse: boolean; r: number; opacity: number }> =
    [];
  if (animate) {
    const forward = direction === 'forward' || direction === 'both' || direction === 'none';
    const reverse = direction === 'reverse' || direction === 'both';
    for (let i = 0; i < dotCount; i += 1) {
      const base = (i * duration) / dotCount;
      for (const t of TRAIL) {
        // A negative begin starts the animation mid-cycle, which places the
        // trailing dot behind the leader without a second path.
        const begin = `${(base - t.lag * duration).toFixed(2)}s`;
        // The reverse stream is deliberately thinner and dimmer so a
        // bidirectional link reads as two distinguishable streams rather than
        // one crowded one.
        if (forward) dots.push({ key: `f${i}-${t.r}`, begin, reverse: false, r: t.r, opacity: t.opacity });
        if (reverse)
          dots.push({
            key: `r${i}-${t.r}`,
            begin,
            reverse: true,
            r: t.r * 0.72,
            opacity: t.opacity * 0.75,
          });
      }
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

  // Markers are defined per link rather than once per status, because a link
  // can now carry a colour of its own and a shape of its own at each end.
  // A marker in a shared <defs> cannot see the colour of the path using it.
  const startShape = capPath(caps.start);
  const endShape = capPath(caps.end);
  const markerEnd = endShape ? `url(#cv-cap-${id}-end)` : undefined;
  const markerStart = startShape ? `url(#cv-cap-${id}-start)` : undefined;

  const capMarker = (which: 'start' | 'end', shape: { d: string; filled: boolean }) => (
    <marker
      id={`cv-cap-${id}-${which}`}
      markerWidth="12"
      markerHeight="12"
      refX={which === 'end' ? 8 : 0}
      refY="4"
      orient={which === 'end' ? 'auto' : 'auto-start-reverse'}
      markerUnits="strokeWidth"
    >
      <path
        d={shape.d}
        fill={shape.filled ? lineColor : 'none'}
        stroke={lineColor}
        strokeWidth={shape.filled ? 0 : 1.4}
      />
    </marker>
  );

  return (
    <>
      {(startShape || endShape) && (
        <defs>
          {startShape && capMarker('start', startShape)}
          {endShape && capMarker('end', endShape)}
        </defs>
      )}
      {/* Halo. A wider, translucent copy of the line reads as a glow without an
          SVG filter — a per-edge drop-shadow is the expensive way to do this. */}
      {animate && (
        <path
          d={drawnPath}
          fill="none"
          stroke={color}
          strokeWidth={width + 6}
          strokeLinecap="round"
          opacity={0.13}
          className="cv-edge-halo"
        />
      )}

      {/* A flowing dash crawl under the dots was tried here and cut: it cost
          ~2.5 fps of the 60 fps budget at 30 animated edges, because SMIL on
          stroke-dashoffset animates an attribute on the main thread, unlike
          animateMotion which the compositor handles. The dots already carry
          direction, so it bought very little. */}

      <BaseEdge
        id={id}
        path={drawnPath}
        style={{
          stroke: lineColor,
          strokeWidth: isLeader ? 1 : selected ? width + 1.5 : width,
          strokeDasharray: dash,
          opacity: isLeader ? 0.85 : status === 'disabled' ? 0.55 : 1,
          filter: selected ? `drop-shadow(0 0 6px ${lineColor})` : undefined,
          // Colour changes ease rather than snapping, so a status flip reads as
          // a transition instead of a jump cut.
          transition: 'stroke 350ms ease, stroke-width 150ms ease',
        }}
        markerEnd={markerEnd}
        markerStart={markerStart}
      />
      {/* Invisible wide path so hovering the thin line is practical. */}
      <path d={drawnPath} fill="none" stroke="transparent" strokeWidth={18}>
        <title>{tooltip}</title>
      </path>

      {dots.map((d) => (
        <circle key={d.key} r={d.r} fill={color} opacity={d.opacity}>
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
            className="cv-edge-label cv-edge-port"
            style={{
              transform: `translate(-50%, -50%) translate(${
                anchors ? anchors.s.x : sourceX + (targetX - sourceX) * PORT_LABEL_AT
              }px, ${anchors ? anchors.s.y : sourceY + (targetY - sourceY) * PORT_LABEL_AT}px)`,
            }}
          >
            {data.sourcePortLabel}
          </div>
        ) : null}

        {data.label ? (
          <div
            className="cv-edge-label cv-edge-center"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              borderColor: color,
            }}
            title={tooltip}
          >
            <span className="cv-edge-glyph" style={{ color }} aria-hidden>
              {STATUS_GLYPH[status]}
            </span>
            {data.label}
          </div>
        ) : null}

        {data.targetPortLabel ? (
          <div
            className="cv-edge-label cv-edge-port"
            style={{
              transform: `translate(-50%, -50%) translate(${
                anchors ? anchors.t.x : targetX + (sourceX - targetX) * PORT_LABEL_AT
              }px, ${anchors ? anchors.t.y : targetY + (sourceY - targetY) * PORT_LABEL_AT}px)`,
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
            id={`cv-arrow-${s}`}
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
            id={`cv-arrow-rev-${s}`}
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
