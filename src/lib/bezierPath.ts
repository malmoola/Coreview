/** A cubic bezier link whose bow the operator can actually change (LT-072).
 *
 *  React Flow's `getBezierPath` accepts a `curvature` option and, in the
 *  version this app pins, ignores it — every value produces the identical
 *  path, which is why the curve handle appeared to do nothing. So the curve
 *  is computed here instead: each end leaves along the side its handle is on,
 *  and `curvature` is how far the control point travels along that direction
 *  as a fraction of the span. 0.5 reproduces what React Flow drew, so a
 *  diagram made before this looks the same until someone drags the handle.
 */
export type Side = 'left' | 'right' | 'top' | 'bottom';

export interface BezierInput {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition?: Side;
  targetPosition?: Side;
  curvature?: number;
}

/** The unit vector pointing out of a node from the given side. */
function outward(side: Side | undefined, fallbackX: number, fallbackY: number): { x: number; y: number } {
  switch (side) {
    case 'left': return { x: -1, y: 0 };
    case 'right': return { x: 1, y: 0 };
    case 'top': return { x: 0, y: -1 };
    case 'bottom': return { x: 0, y: 1 };
    default:
      // No side given: leave along the dominant axis of the span.
      return Math.abs(fallbackX) >= Math.abs(fallbackY)
        ? { x: Math.sign(fallbackX) || 1, y: 0 }
        : { x: 0, y: Math.sign(fallbackY) || 1 };
  }
}

/** `[path, labelX, labelY]`, the shape React Flow's own helpers return. */
export function bezierPath(input: BezierInput): [string, number, number] {
  const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty } = input;
  const c = input.curvature ?? 0.5;
  const dx = tx - sx;
  const dy = ty - sy;
  const s = outward(input.sourcePosition, dx, dy);
  const t = outward(input.targetPosition, -dx, -dy);
  // Each control point reaches along its own end's axis, scaled by the span
  // measured on that axis — not the diagonal. On the diagonal the two reaches
  // overshoot each other and the curve doubles back on itself; on the axis,
  // curvature 0.5 puts both controls on the midline, which is exactly the
  // curve React Flow drew before, so nothing already on a diagram moves.
  const axis = (v: { x: number; y: number }) =>
    Math.max(1, Math.abs(v.x) > 0 ? Math.abs(dx) : Math.abs(dy));
  const c1 = { x: sx + s.x * axis(s) * c, y: sy + s.y * axis(s) * c };
  const c2 = { x: tx + t.x * axis(t) * c, y: ty + t.y * axis(t) * c };
  const round = (n: number) => Math.round(n * 100) / 100;
  const path =
    `M${round(sx)},${round(sy)} C${round(c1.x)},${round(c1.y)} ${round(c2.x)},${round(c2.y)} ${round(tx)},${round(ty)}`;
  // The point at t=0.5 on the cubic, which is where a centre label belongs.
  const mid = (a: number, b: number, d: number, e: number) => (a + 3 * b + 3 * d + e) / 8;
  return [path, round(mid(sx, c1.x, c2.x, tx)), round(mid(sy, c1.y, c2.y, ty))];
}
