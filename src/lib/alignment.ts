/**
 * Lining a device up with the ones already on the diagram.
 *
 * Grid snapping puts things on a grid, which is not the same as putting them
 * in line: two devices can both sit on the grid and still be four pixels out
 * from each other, and four pixels out is what a diagram looks untidy for.
 *
 * What people actually do is nudge a box until it lines up with its
 * neighbours. This does that nudge for them, and shows the line it lined up
 * with — the guide matters as much as the snap, because a box that jumps
 * without saying why feels broken rather than helpful.
 */

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Guide {
  orientation: 'vertical' | 'horizontal';
  /** Where the line sits, in diagram coordinates. */
  at: number;
  /** How far it runs, so it reaches both the box and what it lined up with
   *  rather than crossing the whole canvas. */
  from: number;
  to: number;
}

export interface Alignment {
  /** Where the box should sit once it has snapped. */
  x: number;
  y: number;
  guides: Guide[];
}

/** The three lines a box offers on each axis. */
function edgesX(b: Box): { at: number; kind: string }[] {
  return [
    { at: b.x, kind: 'left' },
    { at: b.x + b.w / 2, kind: 'centre' },
    { at: b.x + b.w, kind: 'right' },
  ];
}

function edgesY(b: Box): { at: number; kind: string }[] {
  return [
    { at: b.y, kind: 'top' },
    { at: b.y + b.h / 2, kind: 'middle' },
    { at: b.y + b.h, kind: 'bottom' },
  ];
}

/**
 * Where a dragged box should settle, and what to draw to explain it.
 *
 * `tolerance` is in diagram units and should be divided by the zoom before it
 * gets here: at a quarter zoom, ten screen pixels is forty diagram units, and
 * a snap that grabs from forty units away feels like the box is being taken
 * out of your hands.
 */
export function alignmentFor(dragged: Box, others: Box[], tolerance = 6): Alignment {
  let bestX: { delta: number; at: number; partner: Box } | null = null;
  let bestY: { delta: number; at: number; partner: Box } | null = null;

  for (const other of others) {
    if (other.id === dragged.id) continue;
    for (const mine of edgesX(dragged)) {
      for (const theirs of edgesX(other)) {
        // Only like to like: a box's left edge lines up with another's left
        // edge or with its centre line, not with whichever of its three edges
        // happens to be nearest — that produces a snap nobody can predict.
        if (mine.kind !== theirs.kind) continue;
        const delta = theirs.at - mine.at;
        if (Math.abs(delta) > tolerance) continue;
        if (!bestX || Math.abs(delta) < Math.abs(bestX.delta)) {
          bestX = { delta, at: theirs.at, partner: other };
        }
      }
    }
    for (const mine of edgesY(dragged)) {
      for (const theirs of edgesY(other)) {
        if (mine.kind !== theirs.kind) continue;
        const delta = theirs.at - mine.at;
        if (Math.abs(delta) > tolerance) continue;
        if (!bestY || Math.abs(delta) < Math.abs(bestY.delta)) {
          bestY = { delta, at: theirs.at, partner: other };
        }
      }
    }
  }

  const x = dragged.x + (bestX?.delta ?? 0);
  const y = dragged.y + (bestY?.delta ?? 0);
  const settled: Box = { ...dragged, x, y };

  const guides: Guide[] = [];
  if (bestX) {
    // The guide spans both boxes and no further. A line across the whole
    // canvas says "something is aligned"; this says what with.
    const top = Math.min(settled.y, bestX.partner.y);
    const bottom = Math.max(settled.y + settled.h, bestX.partner.y + bestX.partner.h);
    guides.push({ orientation: 'vertical', at: bestX.at, from: top, to: bottom });
  }
  if (bestY) {
    const left = Math.min(settled.x, bestY.partner.x);
    const right = Math.max(settled.x + settled.w, bestY.partner.x + bestY.partner.w);
    guides.push({ orientation: 'horizontal', at: bestY.at, from: left, to: right });
  }
  return { x, y, guides };
}

/**
 * Even spacing between three or more boxes in a row.
 *
 * Lining up is half of tidy; the other half is the gaps being equal. When the
 * dragged box would sit at the same distance from its neighbour as that
 * neighbour sits from the next one along, it is nudged the last couple of
 * pixels to make it exact.
 */
export function spacingHint(
  dragged: Box,
  others: Box[],
  axis: 'x' | 'y',
  tolerance = 6,
): number | null {
  const size = axis === 'x' ? 'w' : 'h';
  const inLine = others
    .filter((o) => o.id !== dragged.id)
    .filter((o) => {
      // Roughly level on the other axis, or they are not a row at all.
      const otherAxis = axis === 'x' ? 'y' : 'x';
      const otherSize = axis === 'x' ? 'h' : 'w';
      return Math.abs(o[otherAxis] - dragged[otherAxis]) < dragged[otherSize];
    })
    .sort((a, b) => a[axis] - b[axis]);
  if (inLine.length < 2) return null;

  for (let i = 0; i < inLine.length - 1; i += 1) {
    const a = inLine[i]!;
    const b = inLine[i + 1]!;
    const gap = b[axis] - (a[axis] + a[size]);
    if (gap <= 0) continue;
    // Placed after the pair, at the same gap.
    const after = b[axis] + b[size] + gap;
    if (Math.abs(dragged[axis] - after) <= tolerance) return after;
    // Or before them.
    const before = a[axis] - gap - dragged[size];
    if (Math.abs(dragged[axis] - before) <= tolerance) return before;
  }
  return null;
}
