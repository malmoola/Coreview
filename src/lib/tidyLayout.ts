/**
 * Respreading a crowded diagram without rearranging it.
 *
 * A diagram gets tight for ordinary reasons: it was drawn when nodes were
 * smaller, or imported from somewhere with different spacing, and now labels
 * sit on top of links. The fix people reach for is a force-directed layout,
 * which solves the overlap and destroys the arrangement — the thing they
 * spent an hour on.
 *
 * This keeps the arrangement and fixes only the spacing. Whatever was above
 * stays above, whatever was left stays left; the gaps become even and large
 * enough for what is drawn in them. It is predictable, which matters more
 * than optimal: an operator has to be able to press it without bracing.
 */
import type { TopoNode } from '../state/store';

export interface TidyOptions {
  /** Horizontal gap between the left edges of neighbours in a row. */
  columnGap?: number;
  /** Vertical gap between the top edges of one row and the next. */
  rowGap?: number;
  /** Vertical distance within which two nodes count as the same row. */
  rowTolerance?: number;
}

export interface TidyResult {
  /** Node id to its new position. Only nodes that moved are present. */
  moved: Map<string, { x: number; y: number }>;
  rows: number;
}

const DEFAULTS = { columnGap: 240, rowGap: 210, rowTolerance: 70 };

/**
 * Groups nodes into rows by vertical proximity, then evens out each row.
 *
 * Rows come from what is already there rather than from a grid imposed on
 * top: a diagram drawn as three tiers should come back as three tiers, not as
 * whatever a fixed row height happens to produce.
 */
export function tidyLayout(nodes: TopoNode[], options: TidyOptions = {}): TidyResult {
  const { columnGap, rowGap, rowTolerance } = { ...DEFAULTS, ...options };
  // Locked nodes are where someone put them on purpose.
  const movable = nodes.filter((n) => !(n.data as { locked?: boolean })?.locked);
  if (movable.length === 0) return { moved: new Map(), rows: 0 };

  const byY = [...movable].sort((a, b) => a.position.y - b.position.y);
  const rows: TopoNode[][] = [];
  let current: TopoNode[] = [byY[0]!];
  let anchor = byY[0]!.position.y;

  for (const node of byY.slice(1)) {
    if (node.position.y - anchor <= rowTolerance) {
      current.push(node);
    } else {
      rows.push(current);
      current = [node];
      anchor = node.position.y;
    }
  }
  rows.push(current);

  // The top-left of the whole thing stays put, so a tidy does not also move
  // the diagram somewhere else on the canvas.
  const originX = Math.min(...movable.map((n) => n.position.x));
  const originY = Math.min(...movable.map((n) => n.position.y));

  const moved = new Map<string, { x: number; y: number }>();
  rows.forEach((row, rowIndex) => {
    // Widest row centred; the others centred against it, which is what makes
    // a tree read as a tree.
    const widest = Math.max(...rows.map((r) => r.length));
    const indent = ((widest - row.length) * columnGap) / 2;
    [...row]
      .sort((a, b) => a.position.x - b.position.x)
      .forEach((node, i) => {
        const x = Math.round(originX + indent + i * columnGap);
        const y = Math.round(originY + rowIndex * rowGap);
        if (node.position.x !== x || node.position.y !== y) {
          moved.set(node.id, { x, y });
        }
      });
  });

  return { moved, rows: rows.length };
}
