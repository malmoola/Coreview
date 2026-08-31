/** Elbow (step) link editing (LT-069).
 *
 *  A step link runs in right angles. Lucidchart lets you grab any straight
 *  run and slide it sideways, keeping every corner at 90°; this is the maths
 *  for that, away from React so it can be tested. The corners of the drawn
 *  path are the vertices; dragging a segment moves the two vertices that bound
 *  it along the one axis perpendicular to the segment.
 */
export interface Pt {
  x: number;
  y: number;
}

/** The corner points of an orthogonal path `d` (an "M x,y L ... " polyline),
 *  duplicates and near-duplicates collapsed. */
export function pathVertices(d: string): Pt[] {
  const nums = d.match(/-?\d*\.?\d+(?:e-?\d+)?/g)?.map(Number) ?? [];
  const pts: Pt[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const p = { x: nums[i]!, y: nums[i + 1]! };
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 0.5) pts.push(p);
  }
  return pts;
}

/** Whether a segment between two points is horizontal (true) or vertical. */
function isHorizontal(a: Pt, b: Pt): boolean {
  return Math.abs(a.y - b.y) <= Math.abs(a.x - b.x);
}

/**
 * Move the segment between vertices `i` and `i+1` to where the pointer is,
 * along the one axis that keeps the run straight, and return the new interior
 * vertices (the endpoints are pinned to the devices and are dropped).
 *
 * A horizontal run follows the pointer's y; a vertical run follows its x. The
 * two bounding vertices move together, so their neighbours' corners stay at
 * 90°. The endpoints (index 0 and last) never move — they belong to the
 * devices — so dragging an end segment introduces a new vertex to keep the
 * device stub square.
 */
export function dragSegment(vertices: Pt[], i: number, pointer: Pt): Pt[] {
  const pts = vertices.map((p) => ({ ...p }));
  const a = pts[i]!;
  const b = pts[i + 1]!;
  const horizontal = isHorizontal(a, b);
  const lastIdx = pts.length - 1;

  const moveVertex = (idx: number) => {
    // An endpoint is pinned; split it so the device keeps a square stub and
    // the moved run stays straight.
    if (idx === 0) {
      const v = { ...pts[0]! };
      if (horizontal) v.y = pointer.y;
      else v.x = pointer.x;
      pts.splice(1, 0, v);
      return 1;
    }
    if (idx === lastIdx) {
      const v = { ...pts[lastIdx]! };
      if (horizontal) v.y = pointer.y;
      else v.x = pointer.x;
      pts.splice(lastIdx, 0, v);
      return lastIdx; // the inserted one
    }
    if (horizontal) pts[idx]!.y = pointer.y;
    else pts[idx]!.x = pointer.x;
    return idx;
  };

  // Move the far end first so the near end's index is still valid.
  moveVertex(i + 1);
  moveVertex(i);

  // The interior vertices are the route; the two ends belong to the devices.
  return pts.slice(1, -1);
}

/** The midpoints of the interior segments — where a segment grip sits. Each
 *  carries the vertex index of the segment's start, for `dragSegment`. */
export function segmentGrips(vertices: Pt[]): { at: Pt; index: number }[] {
  const grips: { at: Pt; index: number }[] = [];
  for (let i = 0; i < vertices.length - 1; i += 1) {
    const a = vertices[i]!;
    const b = vertices[i + 1]!;
    // Skip a zero-length run.
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1) continue;
    grips.push({ at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, index: i });
  }
  return grips;
}
