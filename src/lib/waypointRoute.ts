/** A link routed by hand through waypoints (LT-068).
 *
 *  Any diagram tool lets you grab a link and bend it. When a link carries
 *  waypoints, it stops auto-routing and runs source → waypoints → target as a
 *  polyline with rounded corners, so a hand-drawn route reads as deliberate
 *  rather than jagged. The maths is here, away from React, so it can be tested.
 */
export interface Pt {
  x: number;
  y: number;
}

/** The SVG path for a run through `points` (which already includes the two
 *  endpoints), with each interior corner rounded to `radius`. */
export function roundedPolyline(points: Pt[], radius = 10): string {
  if (points.length < 2) return '';
  if (points.length === 2) {
    return `M${points[0]!.x},${points[0]!.y}L${points[1]!.x},${points[1]!.y}`;
  }
  let d = `M${points[0]!.x},${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const next = points[i + 1]!;
    // How far back from the corner each arc starts, capped so a short segment
    // never rounds past its own midpoint.
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 0.5) {
      d += `L${cur.x},${cur.y}`;
      continue;
    }
    const inUx = (cur.x - prev.x) / inLen;
    const inUy = (cur.y - prev.y) / inLen;
    const outUx = (next.x - cur.x) / outLen;
    const outUy = (next.y - cur.y) / outLen;
    const a = { x: cur.x - inUx * r, y: cur.y - inUy * r };
    const b = { x: cur.x + outUx * r, y: cur.y + outUy * r };
    const round = (n: number) => Math.round(n * 100) / 100;
    d += `L${round(a.x)},${round(a.y)}Q${round(cur.x)},${round(cur.y)} ${round(b.x)},${round(b.y)}`;
  }
  const last = points[points.length - 1]!;
  d += `L${last.x},${last.y}`;
  return d;
}

/** The full hand route: the two endpoints with the waypoints between them,
 *  plus the point to hang the centre label at (the middle of the polyline by
 *  length). */
export function waypointRoute(
  source: Pt,
  waypoints: Pt[],
  target: Pt,
  radius = 10,
): { path: string; labelAt: Pt } {
  const pts = [source, ...waypoints, target];
  const path = roundedPolyline(pts, radius);
  // Label at the halfway point measured along the straight polyline.
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) total += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  let acc = 0;
  let labelAt = pts[0]!;
  for (let i = 1; i < pts.length; i += 1) {
    const seg = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    if (acc + seg >= total / 2) {
      const t = seg === 0 ? 0 : (total / 2 - acc) / seg;
      labelAt = { x: pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * t, y: pts[i - 1]!.y + (pts[i]!.y - pts[i - 1]!.y) * t };
      break;
    }
    acc += seg;
  }
  return { path, labelAt };
}

/** The midpoints of each segment — where a "grab here to add a bend" handle
 *  sits (LT-068). */
export function segmentMidpoints(source: Pt, waypoints: Pt[], target: Pt): Pt[] {
  const pts = [source, ...waypoints, target];
  const mids: Pt[] = [];
  for (let i = 1; i < pts.length; i += 1) {
    mids.push({ x: (pts[i - 1]!.x + pts[i]!.x) / 2, y: (pts[i - 1]!.y + pts[i]!.y) / 2 });
  }
  return mids;
}
