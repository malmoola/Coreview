/**
 * Little hops where one link crosses another.
 *
 * On a meshed diagram lines cross, and two lines meeting at a point look
 * exactly like two lines joined at a point. A hop is the convention every
 * schematic uses to say "these pass, they do not connect", and it is worth
 * more than any amount of routing because the crossings that remain are the
 * ones that cannot be routed away.
 *
 * The work is done on the path strings the edges already produce, so nothing
 * here needs to know how a link was routed or what shape it is.
 */

export interface Point {
  x: number;
  y: number;
}

interface Segment extends Point {
  /** The other end. */
  x2: number;
  y2: number;
}

/**
 * The straight runs of a path.
 *
 * Only `L` segments: a crossing lands on a long horizontal or vertical run
 * essentially always, and the rounded corners a step path uses are 12px of
 * arc that a hop would sit awkwardly on. Curves are skipped rather than
 * approximated, which keeps the geometry exact for the paths it does handle.
 */
export function straightRuns(d: string): Segment[] {
  const out: Segment[] = [];
  // Commands are single letters followed by numbers. Only M, L and Q appear
  // in the paths this app draws.
  const tokens = d.match(/[MLQCA][^MLQCA]*/gi) ?? [];
  let at: Point | null = null;
  for (const token of tokens) {
    const kind = token[0]!.toUpperCase();
    const nums = (token.slice(1).match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);
    if (kind === 'M' && nums.length >= 2) {
      at = { x: nums[0]!, y: nums[1]! };
    } else if (kind === 'L' && nums.length >= 2) {
      const next = { x: nums[0]!, y: nums[1]! };
      if (at) out.push({ x: at.x, y: at.y, x2: next.x, y2: next.y });
      at = next;
    } else if (nums.length >= 2) {
      // Any curve: move the pen to its end without recording a run.
      at = { x: nums[nums.length - 2]!, y: nums[nums.length - 1]! };
    }
  }
  return coalesceCollinear(out);
}

/** Merge consecutive runs that lie on one straight line.
 *
 *  React Flow's smoothstep emits its 20px border offsets as extra waypoints,
 *  so one visually straight segment arrives as two or three collinear runs
 *  (`186.5→206.5→341.5→476.5`, all on the same y). A crossing that lands near
 *  one of those internal joints then falls at a run boundary and the hop is
 *  dropped for being too close to an end — which is why crossings under a
 *  smoothstep link stopped hopping. Coalescing makes each straight line one
 *  run again, so a crossing anywhere along it is comfortably mid-run. */
function coalesceCollinear(runs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const r of runs) {
    if (r.x === r.x2 && r.y === r.y2) continue; // a zero-length joint
    const last = out[out.length - 1];
    if (last) {
      const a = { x: last.x2 - last.x, y: last.y2 - last.y };
      const b = { x: r.x2 - r.x, y: r.y2 - r.y };
      const joined = last.x2 === r.x && last.y2 === r.y;
      const collinear = Math.abs(a.x * b.y - a.y * b.x) < 1e-6 && a.x * b.x + a.y * b.y > 0;
      if (joined && collinear) {
        last.x2 = r.x2;
        last.y2 = r.y2;
        continue;
      }
    }
    out.push({ ...r });
  }
  return out;
}

/** Where two straight runs cross, or null. Touching ends do not count. */
export function crossing(a: Segment, b: Segment): Point | null {
  const r = { x: a.x2 - a.x, y: a.y2 - a.y };
  const s = { x: b.x2 - b.x, y: b.y2 - b.y };
  const denom = r.x * s.y - r.y * s.x;
  // Parallel, including two runs lying along one another. A hop on a line
  // that shares its whole length with another says nothing useful.
  if (Math.abs(denom) < 1e-6) return null;
  const t = ((b.x - a.x) * s.y - (b.y - a.y) * s.x) / denom;
  const u = ((b.x - a.x) * r.y - (b.y - a.y) * r.x) / denom;
  // Strictly inside both, with a margin: a crossing right at an endpoint is
  // two links meeting at a device, which is a join and not a crossing.
  const margin = 0.02;
  if (t <= margin || t >= 1 - margin || u <= margin || u >= 1 - margin) return null;
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

/**
 * Which of two crossing links should hop.
 *
 * Both hopping at the same point draws two arcs through each other, which is
 * worse than no hop at all. The rule is the schematic one: the horizontal run
 * hops over the vertical. Where both runs are at the same angle the id breaks
 * the tie, so the choice is stable — it must not depend on which edge happened
 * to render first, or the hop would flicker between them.
 */
export function shouldHop(mine: Segment, theirs: Segment, myId: string, theirId: string): boolean {
  const myHorizontal = Math.abs(mine.y2 - mine.y) < Math.abs(mine.x2 - mine.x);
  const theirHorizontal = Math.abs(theirs.y2 - theirs.y) < Math.abs(theirs.x2 - theirs.x);
  if (myHorizontal !== theirHorizontal) return myHorizontal;
  return myId < theirId;
}

/**
 * Every point on this path that should carry a hop.
 *
 * `others` is every other path on the diagram, by id.
 */
export function jumpsFor(
  id: string,
  d: string,
  others: Iterable<[string, string]>,
  minGap = 10,
): Point[] {
  const mine = straightRuns(d);
  if (mine.length === 0) return [];
  const points: Point[] = [];
  for (const [otherId, otherD] of others) {
    if (otherId === id) continue;
    for (const theirs of straightRuns(otherD)) {
      for (const run of mine) {
        const at = crossing(run, theirs);
        if (!at) continue;
        if (!shouldHop(run, theirs, id, otherId)) continue;
        // Two links crossing the same run within a hop's width would draw
        // overlapping arcs; one hop reads better than a scallop.
        if (points.some((p) => Math.hypot(p.x - at.x, p.y - at.y) < minGap)) continue;
        points.push(at);
      }
    }
  }
  return points;
}

/**
 * The same path with a little arc at each crossing.
 *
 * Only `L` runs are rewritten, so the rounded corners of a step path and any
 * curve are handed back untouched.
 */
export function withJumps(d: string, jumps: Point[], radius = 5): string {
  if (jumps.length === 0) return d;
  const tokens = d.match(/[MLQCA][^MLQCA]*/gi) ?? [];
  let at: Point | null = null;
  let out = '';
  // Consecutive collinear `L` runs are one straight line for hop purposes —
  // smoothstep splits a straight segment at its border offsets, and a hop
  // near one of those joints was being dropped for sitting at a run's end
  // (the crossings-do-not-hop bug). Buffer a straight run's start and end,
  // and flush it as one span the moment the direction changes.
  let runStart: Point | null = null;
  const flushRun = (end: Point) => {
    if (runStart) out += rewriteRun(runStart, end, jumps, radius);
    else out += `L${end.x},${end.y}`;
    runStart = null;
  };

  for (const token of tokens) {
    const kind = token[0]!.toUpperCase();
    const nums = (token.slice(1).match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);
    if (kind === 'L' && nums.length >= 2 && at) {
      const end = { x: nums[0]!, y: nums[1]! };
      if (end.x === at.x && end.y === at.y) continue; // zero-length joint
      if (runStart) {
        const a = { x: at.x - runStart.x, y: at.y - runStart.y };
        const b = { x: end.x - at.x, y: end.y - at.y };
        const collinear = Math.abs(a.x * b.y - a.y * b.x) < 1e-6 && a.x * b.x + a.y * b.y > 0;
        if (!collinear) flushRun(at);
      }
      if (!runStart) runStart = at;
      at = end;
      continue;
    }
    if (runStart && at) flushRun(at);
    out += token;
    if (nums.length >= 2) at = { x: nums[nums.length - 2]!, y: nums[nums.length - 1]! };
  }
  if (runStart && at) flushRun(at);
  return out;
}

/** One straight run, cut at each hop and stitched back with arcs. */
function rewriteRun(from: Point, to: Point, jumps: Point[], radius: number): string {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length < radius * 3) return `L${to.x},${to.y}`;
  const ux = (to.x - from.x) / length;
  const uy = (to.y - from.y) / length;

  const along = jumps
    .map((j) => ({ j, t: (j.x - from.x) * ux + (j.y - from.y) * uy }))
    // On this run, and far enough from either end that the arc is not cut off.
    .filter(({ j, t }) => {
      if (t <= radius * 1.2 || t >= length - radius * 1.2) return false;
      const px = from.x + ux * t;
      const py = from.y + uy * t;
      return Math.hypot(px - j.x, py - j.y) < 0.6;
    })
    .sort((a, b) => a.t - b.t);

  if (along.length === 0) return `L${to.x},${to.y}`;

  const round = (n: number) => Math.round(n * 100) / 100;
  let out = '';
  for (const { t } of along) {
    const ax = from.x + ux * (t - radius);
    const ay = from.y + uy * (t - radius);
    const bx = from.x + ux * (t + radius);
    const by = from.y + uy * (t + radius);
    // sweep 1 so every hop bows the same way along the line's direction,
    // which is what makes a row of them look deliberate rather than random.
    out += `L${round(ax)},${round(ay)}A${radius},${radius} 0 0 1 ${round(bx)},${round(by)}`;
  }
  return `${out}L${to.x},${to.y}`;
}
