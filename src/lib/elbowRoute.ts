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

/** The real corners of an orthogonal path.
 *
 *  Command-aware, because counting every number pair was the LT-071 bug: a
 *  smoothstep rounds each corner with a `Q`, whose control point *is* the
 *  corner and whose endpoint lies on the next straight run — read naively,
 *  one corner became three vertices and the link sprouted a chain of grips.
 *  So: `M`/`L` give a vertex, `Q` gives its control point and its endpoint is
 *  dropped, and consecutive collinear points collapse into the straight run
 *  they belong to. A smoothstep between two devices comes back as the three
 *  or four corners a person would point at. */
export function pathVertices(d: string): Pt[] {
  const tokens = d.match(/[MLQCAmlqca][^MLQCAmlqca]*/g) ?? [];
  const raw: Pt[] = [];
  for (const token of tokens) {
    const kind = token[0]!.toUpperCase();
    const n = (token.slice(1).match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);
    if ((kind === 'M' || kind === 'L') && n.length >= 2) {
      raw.push({ x: n[0]!, y: n[1]! });
    } else if (kind === 'Q' && n.length >= 4) {
      // The control point is the corner the curve is rounding.
      raw.push({ x: n[0]!, y: n[1]! });
    } else if (kind === 'C' && n.length >= 6) {
      raw.push({ x: n[4]!, y: n[5]! });
    } else if (n.length >= 2) {
      raw.push({ x: n[n.length - 2]!, y: n[n.length - 1]! });
    }
  }

  // Drop repeats, then collapse points that sit on the run they join.
  const out: Pt[] = [];
  for (const p of raw) {
    const last = out[out.length - 1];
    if (last && Math.hypot(last.x - p.x, last.y - p.y) < 1) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2]!;
      const b = last!;
      const cross = (b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x);
      const forward = (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y) > 0;
      if (Math.abs(cross) < 1 && forward) {
        out[out.length - 1] = p; // b was mid-run, not a corner
        continue;
      }
    }
    out.push(p);
  }
  return out;
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
export function segmentGrips(vertices: Pt[], minLength = 30): { at: Pt; index: number }[] {
  const grips: { at: Pt; index: number }[] = [];
  for (let i = 0; i < vertices.length - 1; i += 1) {
    const a = vertices[i]!;
    const b = vertices[i + 1]!;
    // A run too short to aim at gets no grip — that is what turned a link
    // into a chain of dots (LT-071).
    if (Math.hypot(a.x - b.x, a.y - b.y) < minLength) continue;
    grips.push({ at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, index: i });
  }
  return grips;
}
