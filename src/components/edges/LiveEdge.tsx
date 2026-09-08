import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  useReactFlow,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  Position,
  type EdgeProps,
} from '@xyflow/react';

import type { DeviceNodeData, HealthStatus, LinkData } from '../../types/domain';
import { STATUS_GLYPH, STATUS_LABEL } from '../../types/domain';
import { useStore } from '../../state/store';
import { describeRule, shouldAnimate } from '../../health/evaluate';
import { STATUS_COLOR_DARK, readableOn, statusColors } from '../../theme';
import { capPath, capsFor, dashFor } from '../../lib/linkStyle';
import { jumpsFor, withJumps } from '../../lib/lineJumps';
import { segmentMidpoints, waypointRoute } from '../../lib/waypointRoute';
import { activePage } from '../../lib/pages';
import { bezierPath, type Side } from '../../lib/bezierPath';
import { anchorPoint, nearestAnchorOnBox, nearestSide, SIDE_TO_POSITION } from '../../lib/floatingAnchor';
import { dragSegment, pathVertices, segmentGrips } from '../../lib/elbowRoute';
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

/** A point at a fraction along the drawn path, or null where SVG geometry
 *  is unavailable (jsdom) — callers fall back to the straight chord. */
function pointAt(edgePath: string, at: number): { x: number; y: number } | null {
  try {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', edgePath);
    const len = p.getTotalLength();
    if (!len || !Number.isFinite(len)) return null;
    const pt = p.getPointAtLength(len * Math.min(1, Math.max(0, at)));
    return { x: pt.x, y: pt.y };
  } catch {
    return null;
  }
}

/** The fraction along the path nearest to a point — how a dragged label is
 *  kept on its link (LT-051): the cursor roams, the label takes the closest
 *  spot on the line. Sampled, then refined once around the best sample.
 *  Exported for the canvas, which uses it to place a double-clicked text
 *  (LT-052) at the spot that was clicked. */
export function nearestFractionOnPath(edgePath: string, x: number, y: number): number | null {
  try {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', edgePath);
    const len = p.getTotalLength();
    if (!len || !Number.isFinite(len)) return null;
    let best = 0;
    let bestD = Infinity;
    const probe = (t: number) => {
      const pt = p.getPointAtLength(len * t);
      const d = (pt.x - x) ** 2 + (pt.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    };
    for (let i = 0; i <= 80; i += 1) probe(i / 80);
    for (let i = -9; i <= 9; i += 1) probe(best + i / 800);
    return Math.min(0.97, Math.max(0.03, best));
  } catch {
    return null;
  }
}

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
  curvature?: number,
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
      // LT-072: our own cubic, because React Flow's getBezierPath ignores the
      // `curvature` option in this version — every value drew the identical
      // path, which is why the curve handle appeared to do nothing.
      return bezierPath({
        sourceX: p.sourceX,
        sourceY: p.sourceY,
        targetX: p.targetX,
        targetY: p.targetY,
        sourcePosition: p.sourcePosition as Side | undefined,
        targetPosition: p.targetPosition as Side | undefined,
        curvature,
      });
  }
}

function LiveEdgeInner(props: EdgeProps) {
  const {
    id,
    source,
    target,
    sourceX: rawSourceX,
    sourceY: rawSourceY,
    targetX: rawTargetX,
    targetY: rawTargetY,
    sourcePosition: rawSourcePosition,
    targetPosition: rawTargetPosition,
    selected,
  } = props;
  const data = (props.data ?? {}) as LinkData;
  // Live while the curve handle is dragged (LT-072); the store learns the
  // final value on release.
  const [curveDrag, setCurveDrag] = useState<number | null>(null);

  const doc = useStore((s) => s.doc);
  const runtime = useStore((s) => s.runtime);
  const reduceMotion = useStore((s) => s.settings.reduceMotion);
  const linkStatusOf = useStore((s) => s.linkStatus);

  // A floating anchor (LT-098) overrides where this end leaves its device —
  // anywhere around its bounding box, not one of the 4 fixed handles React
  // Flow measured for us. Shadowing the plain names here, rather than
  // threading a differently-named point through the rest of the component,
  // is what keeps every line below — path, port labels, the corner drag —
  // unaware anything about the source of these numbers ever changed.
  const pageNodes = activePage(doc).nodes;
  const floatingEnd = (
    nodeId: string,
    a: LinkData['sourceAnchor'],
    fx: number,
    fy: number,
    fPos: Position | undefined,
  ) => {
    if (!a) return { x: fx, y: fy, position: fPos };
    const n = pageNodes.find((node) => node.id === nodeId);
    if (!n) return { x: fx, y: fy, position: fPos };
    const box = {
      x: n.position.x,
      y: n.position.y,
      w: n.width ?? n.measured?.width ?? 176,
      h: n.height ?? n.measured?.height ?? 96,
    };
    const p = anchorPoint(box, a);
    return { x: p.x, y: p.y, position: SIDE_TO_POSITION[nearestSide(a)] };
  };
  const sourceEnd = floatingEnd(source, data.sourceAnchor, rawSourceX, rawSourceY, rawSourcePosition);
  const targetEnd = floatingEnd(target, data.targetAnchor, rawTargetX, rawTargetY, rawTargetPosition);
  // While an end is actively being dragged (see dragAnchorEnd below), it
  // follows the cursor exactly rather than jumping to its nearest perimeter
  // point on every frame — that snap happens once, on release, which is what
  // makes the drag itself feel like it is going somewhere rather than
  // fighting the shape it is leaving.
  const [anchorDrag, setAnchorDrag] = useState<{ which: 'source' | 'target'; x: number; y: number } | null>(
    null,
  );
  const sourceX = anchorDrag?.which === 'source' ? anchorDrag.x : sourceEnd.x;
  const sourceY = anchorDrag?.which === 'source' ? anchorDrag.y : sourceEnd.y;
  const targetX = anchorDrag?.which === 'target' ? anchorDrag.x : targetEnd.x;
  const targetY = anchorDrag?.which === 'target' ? anchorDrag.y : targetEnd.y;
  const sourcePosition = sourceEnd.position;
  const targetPosition = targetEnd.position;

  // Through the store rather than calling the evaluator here, so the diagram
  // export resolves link status the same way the canvas does.
  const status = linkStatusOf(id);

  const wps = useMemo(() => data.waypoints ?? [], [data.waypoints]);
  const [edgePath, labelX, labelY] = useMemo(() => {
    if (wps.length > 0) {
      const { path, labelAt } = waypointRoute({ x: sourceX, y: sourceY }, wps, { x: targetX, y: targetY });
      return [path, labelAt.x, labelAt.y] as [string, number, number];
    }
    return pathFor(data.pathType ?? 'smoothstep', {
      sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
    }, data.lane ?? 0, curveDrag ?? data.curvature);
  }, [data.pathType, data.lane, data.curvature, curveDrag, wps, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition]);

  const ground = useStore((s) => s.settings.ground);
  // A leader points a note at what it is about. It is an annotation, not a
  // cable: nothing travels along it, it carries no health, and it does not
  // hop over the links it crosses.
  const isLeader = data.kind === 'leader';
  const jumpsEnabled = useStore((s) => activePage(s.doc).canvas.lineJumps ?? true);
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

  // LT-051/052: the centre label and any flat text slide along the link and
  // never leave it. While a drag is live the fraction is local state; the
  // store learns it once on release, as one undoable edit.
  const rf = useReactFlow();
  const [dragAt, setDragAt] = useState<{ key: string; at: number } | null>(null);
  const dragRef = useRef<{ key: string; at: number } | null>(null);
  const [editingText, setEditingText] = useState<string | null>(null);
  const beginLabelDrag = useCallback(
    (key: string, startAt: number) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);
      dragRef.current = { key, at: startAt };
      setDragAt(dragRef.current);
      const move = (ev: PointerEvent) => {
        const flow = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
        const at = nearestFractionOnPath(edgePath, flow.x, flow.y);
        if (at !== null) {
          dragRef.current = { key, at };
          setDragAt(dragRef.current);
        }
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        const final = dragRef.current;
        dragRef.current = null;
        setDragAt(null);
        if (!final) return;
        const store = useStore.getState();
        store.commit();
        if (final.key === 'label') {
          store.updateEdgeData(id, { labelAt: final.at });
        } else if (final.key === 'sourcePort') {
          store.updateEdgeData(id, { sourcePortAt: final.at });
        } else if (final.key === 'targetPort') {
          store.updateEdgeData(id, { targetPortAt: final.at });
        } else {
          store.updateEdgeData(id, {
            texts: (data.texts ?? []).map((t) =>
              t.id === final.key ? { ...t, at: final.at } : t,
            ),
          });
        }
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    },
    [edgePath, id, rf, data.texts],
  );
  // LT-068: Lucidchart-style routing handles. A selected link shows a filled
  // square at each waypoint (drag to move, double-click to remove) and a
  // hollow circle at each segment midpoint (drag to bend a new one in). The
  // drag runs on window listeners so a handle re-rendering mid-drag does not
  // drop it, and stops propagation so React Flow starts no selection.
  const [wpDrag, setWpDrag] = useState<{ points: { x: number; y: number }[] } | null>(null);
  const wpDragRef = useRef<{ points: { x: number; y: number }[] } | null>(null);
  wpDragRef.current = wpDrag;
  const dragWaypoint = (startPoints: { x: number; y: number }[], index: number) =>
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      let points = startPoints.map((p) => ({ ...p }));
      setWpDrag({ points });
      const move = (ev: PointerEvent) => {
        const f = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
        points = points.map((p, i) => (i === index ? { x: f.x, y: f.y } : p));
        setWpDrag({ points });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setWpDrag(null);
        const store = useStore.getState();
        store.commit();
        store.updateEdgeData(id, { waypoints: points });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };

  // LT-098: dragging either end of the link off its device's own bounding
  // box anywhere around it, rather than snapping between the 4 fixed sides.
  // A ref alongside the state a plain closure over `anchorDrag` would go
  // stale on — `up` runs long after the render that created it.
  const anchorDragRef = useRef(anchorDrag);
  anchorDragRef.current = anchorDrag;
  const dragAnchorEnd = (which: 'source' | 'target') => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const f = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      setAnchorDrag({ which, x: f.x, y: f.y });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const final = anchorDragRef.current;
      setAnchorDrag(null);
      if (!final) return;
      const nodeId = which === 'source' ? source : target;
      const n = pageNodes.find((node) => node.id === nodeId);
      if (!n) return;
      const box = {
        x: n.position.x,
        y: n.position.y,
        w: n.width ?? n.measured?.width ?? 176,
        h: n.height ?? n.measured?.height ?? 96,
      };
      const a = nearestAnchorOnBox(box, { x: final.x, y: final.y });
      const store = useStore.getState();
      store.commit();
      store.updateEdgeData(
        id,
        which === 'source' ? { sourceAnchor: a, pinnedSides: true } : { targetAnchor: a, pinnedSides: true },
      );
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // LT-069: a step link's segment grip. Dragging slides the run orthogonally
  // (dragSegment keeps every corner at 90°); a press-and-hold that never moves
  // resets the whole line to automatic.
  const pathKind = data.pathType ?? 'smoothstep';
  const isElbow = pathKind === 'step' || pathKind === 'smoothstep';
  const isBezier = pathKind === 'bezier';
  // LT-072: dragging the curve handle away from the straight line between the
  // ends bows the curve; React Flow's curvature is that bow as a fraction of
  // the span, so the pointer's perpendicular distance maps straight onto it.
  const dragCurve = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const chord = Math.hypot(targetX - sourceX, targetY - sourceY) || 1;
    const midX = (sourceX + targetX) / 2;
    const midY = (sourceY + targetY) / 2;
    const ux = (targetX - sourceX) / chord;
    const uy = (targetY - sourceY) / chord;
    let latest: number | null = null;
    const move = (ev: PointerEvent) => {
      const f = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      // Distance from the chord, perpendicular.
      const perp = Math.abs((f.x - midX) * -uy + (f.y - midY) * ux);
      latest = Math.min(3, Math.max(0, (perp / chord) * 2.4));
      setCurveDrag(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setCurveDrag(null);
      if (latest !== null) {
        const store = useStore.getState();
        store.commit();
        store.updateEdgeData(id, { curvature: Math.round(latest * 100) / 100 });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const dragElbow = (vertices: { x: number; y: number }[], index: number) =>
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      let moved = false;
      const hold = window.setTimeout(() => {
        if (moved) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const store = useStore.getState();
        store.commit();
        store.updateEdgeData(id, { waypoints: [] }); // press-and-hold resets
      }, 550);
      const move = (ev: PointerEvent) => {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
        moved = true;
        window.clearTimeout(hold);
        const f = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
        setWpDrag({ points: dragSegment(vertices, index, f) });
      };
      const up = () => {
        window.clearTimeout(hold);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const final = wpDragRef.current;
        setWpDrag(null);
        if (moved && final) {
          const store = useStore.getState();
          store.commit();
          store.updateEdgeData(id, { waypoints: final.points });
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };

  const commitText = useCallback(
    (textId: string, value: string) => {
      const store = useStore.getState();
      const trimmed = value.trim();
      store.commit();
      store.updateEdgeData(id, {
        texts: trimmed
          ? (data.texts ?? []).map((t) => (t.id === textId ? { ...t, text: trimmed } : t))
          : (data.texts ?? []).filter((t) => t.id !== textId),
      });
      setEditingText(null);
    },
    [id, data.texts],
  );
  const labelFraction = dragAt?.key === 'label' ? dragAt.at : (data.labelAt ?? 0.5);
  const labelPoint =
    labelFraction === 0.5 && dragAt?.key !== 'label'
      ? null // untouched links keep React Flow's own midpoint
      : pointAt(edgePath, labelFraction);
  // LT-097: a port label is draggable the same way the centre label is.
  // Unset keeps portAnchors' fixed-distance-from-each-end placement (the
  // parallel-cable stacking fix, LT-050/055) — only a link someone has
  // actually dragged switches to a stored fraction along the path.
  const sourcePortFraction = dragAt?.key === 'sourcePort' ? dragAt.at : data.sourcePortAt;
  const sourcePortPoint = sourcePortFraction === undefined ? null : pointAt(edgePath, sourcePortFraction);
  const sourcePortAnchorX = anchors ? anchors.s.x : sourceX + (targetX - sourceX) * PORT_LABEL_AT;
  const sourcePortAnchorY = anchors ? anchors.s.y : sourceY + (targetY - sourceY) * PORT_LABEL_AT;
  const targetPortFraction = dragAt?.key === 'targetPort' ? dragAt.at : data.targetPortAt;
  const targetPortPoint = targetPortFraction === undefined ? null : pointAt(edgePath, targetPortFraction);
  const targetPortAnchorX = anchors ? anchors.t.x : targetX + (sourceX - targetX) * PORT_LABEL_AT;
  const targetPortAnchorY = anchors ? anchors.t.y : targetY + (sourceY - targetY) * PORT_LABEL_AT;
  const livePath = wpDrag
    ? waypointRoute({ x: sourceX, y: sourceY }, wpDrag.points, { x: targetX, y: targetY }).path
    : edgePath;
  const drawnPath = useMemo(() => {
    if (wps.length > 0 || wpDrag) return livePath;
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
  }, [id, edgePath, livePath, wps.length, wpDrag, jumpsEnabled, isLeader, version, data.width]);

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

  // LT-067: the physical ports at each end, which is the first thing a
  // network engineer wants off a link — what plugs into what. A port-channel
  // lists its members from the discovery note; a plain link shows A's port
  // and B's.
  const nameOf = (nodeId: string) =>
    (activePage(doc).nodes.find((n) => n.id === nodeId)?.data as DeviceNodeData | undefined)?.label ?? nodeId;
  const sp = data.sourcePortLabel?.trim();
  const tp = data.targetPortLabel?.trim();
  const bundleMembers = /(\d+) bundled ports: ([^\n]+)/.exec(data.notes ?? '');
  const portLine =
    sp || tp
      ? bundleMembers
        ? `Port-channel: ${nameOf(source)} ${sp || '?'} \u2194 ${nameOf(target)} ${tp || '?'} (${bundleMembers[2]})`
        : `Ports: ${nameOf(source)} ${sp || '?'} \u2194 ${nameOf(target)} ${tp || '?'}`
      : null;

  const tooltip = [
    portLine,
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
            className="cv-edge-label cv-edge-port nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${
                sourcePortPoint ? sourcePortPoint.x : sourcePortAnchorX
              }px, ${sourcePortPoint ? sourcePortPoint.y : sourcePortAnchorY}px)`,
            }}
            onPointerDown={beginLabelDrag(
              'sourcePort',
              sourcePortFraction ?? nearestFractionOnPath(edgePath, sourcePortAnchorX, sourcePortAnchorY) ?? 0.1,
            )}
          >
            {data.sourcePortLabel}
          </div>
        ) : null}

        {data.label ? (
          <div
            className="cv-edge-label cv-edge-center"
            style={{
              transform: `translate(-50%, -50%) translate(${labelPoint ? labelPoint.x : labelX}px, ${
                labelPoint ? labelPoint.y : labelY
              }px)`,
              borderColor: color,
            }}
            title={tooltip}
            onPointerDown={beginLabelDrag('label', labelFraction)}
          >
            <span className="cv-edge-glyph" style={{ color }} aria-hidden>
              {STATUS_GLYPH[status]}
            </span>
            {data.label}
          </div>
        ) : null}

        {(data.texts ?? []).map((t) => {
          const at = dragAt?.key === t.id ? dragAt.at : t.at;
          const pt = pointAt(edgePath, at) ?? {
            x: sourceX + (targetX - sourceX) * at,
            y: sourceY + (targetY - sourceY) * at,
          };
          const editing = editingText === t.id || t.text === '';
          return (
            <div
              key={t.id}
              className="cv-edge-flat nodrag nopan"
              style={{ transform: `translate(-50%, -50%) translate(${pt.x}px, ${pt.y}px)` }}
              onPointerDown={editing ? undefined : beginLabelDrag(t.id, at)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditingText(t.id);
              }}
            >
              {editing ? (
                <input
                  autoFocus
                  defaultValue={t.text}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') commitText(t.id, (e.target as HTMLInputElement).value);
                    if (e.key === 'Escape') commitText(t.id, t.text);
                  }}
                  onBlur={(e) => commitText(t.id, e.target.value)}
                />
              ) : (
                t.text
              )}
            </div>
          );
        })}

        {/* LT-069: a step link edits by segment grips that slide orthogonally;
            LT-068: a straight or curved link edits by free vertex/midpoint
            handles. One or the other, never both. */}
        {selected && isElbow &&
          segmentGrips(pathVertices(livePath)).map((g) => (
            <div
              key={`grip-${g.index}`}
              className="cv-edge-grip nodrag nopan"
              title="Drag to move this segment · press and hold to reset"
              style={{ transform: `translate(-50%, -50%) translate(${g.at.x}px, ${g.at.y}px)` }}
              onPointerDown={dragElbow(pathVertices(livePath), g.index)}
            />
          ))}
        {selected && isBezier && (
          <div
            className="cv-edge-curve nodrag nopan"
            title="Drag to change how far the link curves"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onPointerDown={dragCurve}
            onDoubleClick={(e) => {
              e.stopPropagation();
              const store = useStore.getState();
              store.commit();
              store.updateEdgeData(id, { curvature: undefined });
            }}
          />
        )}
        {selected && !isElbow && !isBezier &&
          (wpDrag?.points ?? wps).map((w, i) => (
            <div
              key={`wp-${i}`}
              className="cv-edge-waypoint nodrag nopan"
              style={{ transform: `translate(-50%, -50%) translate(${w.x}px, ${w.y}px)` }}
              onPointerDown={dragWaypoint(wpDrag?.points ?? wps, i)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                const store = useStore.getState();
                store.commit();
                store.updateEdgeData(id, { waypoints: (wpDrag?.points ?? wps).filter((_, j) => j !== i) });
              }}
            />
          ))}
        {selected && !isElbow && !isBezier &&
          segmentMidpoints({ x: sourceX, y: sourceY }, wpDrag?.points ?? wps, { x: targetX, y: targetY }).map((m, i) => (
            <div
              key={`mid-${i}`}
              className="cv-edge-addpoint nodrag nopan"
              style={{ transform: `translate(-50%, -50%) translate(${m.x}px, ${m.y}px)` }}
              onPointerDown={(e) => {
                const base = wpDrag?.points ?? wps;
                const inserted = [...base];
                inserted.splice(i, 0, { x: m.x, y: m.y });
                dragWaypoint(inserted, i)(e);
              }}
            />
          ))}

        {/* LT-098: drag either end anywhere around its own device's
            perimeter. Double-click puts that one end back on automatic —
            the other end's own anchor, if it has one, is untouched. */}
        {selected && (
          <>
            <div
              className="cv-edge-endpoint nodrag nopan"
              title="Drag to attach this end anywhere around the shape"
              style={{ transform: `translate(-50%, -50%) translate(${sourceX}px, ${sourceY}px)` }}
              onPointerDown={dragAnchorEnd('source')}
              onDoubleClick={(e) => {
                e.stopPropagation();
                const store = useStore.getState();
                store.commit();
                store.updateEdgeData(id, {
                  sourceAnchor: undefined,
                  pinnedSides: data.targetAnchor ? true : undefined,
                });
              }}
            />
            <div
              className="cv-edge-endpoint nodrag nopan"
              title="Drag to attach this end anywhere around the shape"
              style={{ transform: `translate(-50%, -50%) translate(${targetX}px, ${targetY}px)` }}
              onPointerDown={dragAnchorEnd('target')}
              onDoubleClick={(e) => {
                e.stopPropagation();
                const store = useStore.getState();
                store.commit();
                store.updateEdgeData(id, {
                  targetAnchor: undefined,
                  pinnedSides: data.sourceAnchor ? true : undefined,
                });
              }}
            />
          </>
        )}

        {data.targetPortLabel ? (
          <div
            className="cv-edge-label cv-edge-port nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${
                targetPortPoint ? targetPortPoint.x : targetPortAnchorX
              }px, ${targetPortPoint ? targetPortPoint.y : targetPortAnchorY}px)`,
            }}
            onPointerDown={beginLabelDrag(
              'targetPort',
              targetPortFraction ?? nearestFractionOnPath(edgePath, targetPortAnchorX, targetPortAnchorY) ?? 0.9,
            )}
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
