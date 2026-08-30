/**
 * Where the page is and how big it is.
 *
 * The page grows to hold whatever is drawn on it — a device dragged past the
 * edge is not sitting on the desk, it is on a bigger sheet. It never shrinks
 * on its own, because a sheet that snaps smaller mid-drag makes the whole
 * layout jump; shrinking is the explicit "Fit page to content" action.
 *
 * This is the one place the rect is computed. The renderer, Fit view, the
 * grid and any export that uses page bounds all call in here — three copies
 * of this arithmetic would disagree within a week.
 */
import type { TopoNode } from '../state/store';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 11 by 8.5 inches at 144 dpi, landscape. The sheet a new project gets. */
export const DEFAULT_PAGE: Rect = { x: 0, y: 0, w: 1584, h: 1224 };

/** How far content sits from the paper's edge. */
export const PAGE_MARGIN = 120;

/** The page resizes in whole major-grid steps, so it does not creep
 *  pixel-by-pixel under a drag. */
const SNAP = 60;

const down = (v: number) => Math.floor(v / SNAP) * SNAP;
const up = (v: number) => Math.ceil(v / SNAP) * SNAP;

/**
 * The smallest page that holds these nodes, with the margin, snapped outward
 * to the major grid, and never smaller than the default sheet.
 *
 * Callers pass the nodes of the *current view* — a device on a hidden view
 * should not be holding the page open.
 */
export function pageForContent(nodes: TopoNode[]): Rect {
  if (nodes.length === 0) return DEFAULT_PAGE;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const w = n.width ?? n.measured?.width ?? 168;
    const h = n.height ?? n.measured?.height ?? 92;
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }
  const x = Math.min(DEFAULT_PAGE.x, down(minX - PAGE_MARGIN));
  const y = Math.min(DEFAULT_PAGE.y, down(minY - PAGE_MARGIN));
  const right = Math.max(DEFAULT_PAGE.x + DEFAULT_PAGE.w, up(maxX + PAGE_MARGIN));
  const bottom = Math.max(DEFAULT_PAGE.y + DEFAULT_PAGE.h, up(maxY + PAGE_MARGIN));
  return { x, y, w: right - x, h: bottom - y };
}

/** The union of two rects — how the page grows without ever shrinking. */
export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/**
 * The page as it should be drawn right now: whatever it has grown to, grown
 * further if the content demands it, and never shrunk here.
 */
export function effectivePage(stored: Rect | undefined, visibleNodes: TopoNode[]): Rect {
  return unionRect(stored ?? DEFAULT_PAGE, pageForContent(visibleNodes));
}

export function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
