/**
 * A link end anywhere around a device's perimeter, not just top/right/
 * bottom/left (LT-098).
 *
 * An anchor is normalized to the device's own bounding box — `x`/`y` each
 * 0..1 — with exactly one of the two pinned to 0 or 1, which is what keeps
 * it on the perimeter rather than adrift somewhere inside the shape. Being
 * normalized rather than a fixed pixel offset is deliberate: resizing the
 * device recomputes the same relative point instead of leaving the anchor
 * behind or stranding it off the edge.
 *
 * Shared by the live canvas (`LiveEdge.tsx`) and the SVG/PDF export
 * (`diagram.ts`), so a link looks the same place in both.
 */
import { Position } from '@xyflow/react';
import type { Side } from './routeLinks';

export interface Anchor {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The anchor's position in absolute (flow) coordinates. */
export function anchorPoint(box: Box, a: Anchor): { x: number; y: number } {
  return { x: box.x + a.x * box.w, y: box.y + a.y * box.h };
}

/** Which of the 4 fixed sides an anchor is nearest — used only to pick a
 *  curve's tangent direction, the one thing a floating point still borrows
 *  from the fixed-handle model. */
export function nearestSide(a: Anchor): Side {
  const d: Record<Side, number> = { t: a.y, b: 1 - a.y, l: a.x, r: 1 - a.x };
  return (Object.keys(d) as Side[]).reduce((best, side) => (d[side] < d[best] ? side : best));
}

/** `nearestSide`'s result, as the `Position` enum React Flow's own path
 *  helpers expect — the one place this module talks to the library rather
 *  than staying in plain geometry. */
export const SIDE_TO_POSITION: Record<Side, Position> = {
  t: Position.Top,
  b: Position.Bottom,
  l: Position.Left,
  r: Position.Right,
};

/**
 * The point on a box's own perimeter nearest an arbitrary point — how a
 * dragged link end is kept on the shape it left rather than floating free
 * of it. The point is clamped into the box first, then pulled to whichever
 * edge is closest, so a cursor dragged past a corner still lands cleanly on
 * one side or the other rather than at an arbitrary interior point.
 */
export function nearestAnchorOnBox(box: Box, point: { x: number; y: number }): Anchor {
  const cx = Math.min(1, Math.max(0, (point.x - box.x) / box.w));
  const cy = Math.min(1, Math.max(0, (point.y - box.y) / box.h));
  const d = { t: cy, b: 1 - cy, l: cx, r: 1 - cx };
  const side = (Object.keys(d) as Side[]).reduce((best, s) => (d[s] < d[best] ? s : best));
  switch (side) {
    case 't':
      return { x: cx, y: 0 };
    case 'b':
      return { x: cx, y: 1 };
    case 'l':
      return { x: 0, y: cy };
    default:
      return { x: 1, y: cy };
  }
}
