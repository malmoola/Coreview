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

/** The centre of a box, in absolute coordinates. */
export function centreOf(box: Box): { x: number; y: number } {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/**
 * Where a link leaves a shape when it is pointed at something (LT-107).
 *
 * The point where a ray from the shape's centre towards `toward` crosses its
 * own outline — so a device below and to the left is met at the lower-left,
 * not shoved out of whichever of four handles happens to be closest. This is
 * the whole of "connect at 360": there is no set of points to pick from, only
 * a bearing.
 *
 * `round` picks the outline the shape is actually *drawn* as. A glyph device
 * is a circular icon (its selection ring is a literal `border-radius: 50%`),
 * and against a rectangle a diagonal link would attach at the box's corner —
 * visibly off the artwork, floating in the gap. A card, a note or a drawn
 * rectangle is a box and wants the box.
 *
 * Degenerate input — the two shapes concentric, or a zero-sized box — has no
 * bearing to speak of, so it falls back to the right-hand edge rather than
 * dividing by zero.
 */
export function bearingAnchor(box: Box, toward: { x: number; y: number }, round: boolean): Anchor {
  const c = centreOf(box);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  const hw = box.w / 2;
  const hh = box.h / 2;
  if ((dx === 0 && dy === 0) || hw <= 0 || hh <= 0) return { x: 1, y: 0.5 };

  // How far along the ray the outline sits. An ellipse solves in one step; a
  // rectangle is whichever of the two edge crossings comes first.
  const t = round
    ? 1 / Math.hypot(dx / hw, dy / hh)
    : Math.min(
        dx === 0 ? Infinity : hw / Math.abs(dx),
        dy === 0 ? Infinity : hh / Math.abs(dy),
      );

  // Back to the 0..1 box-relative form every other anchor uses, so a bearing
  // and a hand-dragged point are the same kind of thing downstream.
  return {
    x: (c.x + dx * t - box.x) / box.w,
    y: (c.y + dy * t - box.y) / box.h,
  };
}

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
