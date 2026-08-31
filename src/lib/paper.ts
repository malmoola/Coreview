/**
 * Fitting a diagram onto paper.
 *
 * An export sized to its own contents is the right default — nobody wants a
 * screenshot with margins — but it is the wrong thing to drop into a document.
 * A page has a size, and a diagram that arrives at 2,431 by 870 pixels gets
 * scaled by whoever pastes it, badly, once per document.
 *
 * Sizes are in CSS pixels at 96 dpi, which is what an SVG width means and what
 * a browser prints at.
 */

export interface PaperSize {
  id: string;
  name: string;
  /** Portrait dimensions, in CSS pixels at 96 dpi. */
  width: number;
  height: number;
}

const mm = (v: number) => Math.round((v / 25.4) * 96);
const inch = (v: number) => Math.round(v * 96);

export const PAPERS: PaperSize[] = [
  { id: 'fit', name: 'Fit the diagram', width: 0, height: 0 },
  { id: 'a4', name: 'A4', width: mm(210), height: mm(297) },
  { id: 'a3', name: 'A3', width: mm(297), height: mm(420) },
  { id: 'letter', name: 'Letter', width: inch(8.5), height: inch(11) },
  { id: 'tabloid', name: 'Tabloid', width: inch(11), height: inch(17) },
];

export type Orientation = 'portrait' | 'landscape';

export function paperById(id: string | undefined): PaperSize {
  return PAPERS.find((p) => p.id === id) ?? PAPERS[0]!;
}

/** The sheet's dimensions once the orientation is applied. */
export function sheetSize(paper: PaperSize, orientation: Orientation): { w: number; h: number } {
  if (paper.width === 0) return { w: 0, h: 0 };
  return orientation === 'landscape'
    ? { w: paper.height, h: paper.width }
    : { w: paper.width, h: paper.height };
}

export interface Placement {
  /** Sheet dimensions. */
  width: number;
  height: number;
  /** What the content is multiplied by. */
  scale: number;
  /** Where the content's top-left goes on the sheet. */
  x: number;
  y: number;
}

/**
 * Where a drawing of this size sits on this sheet.
 *
 * Never enlarged. A small diagram blown up to fill A3 is a diagram with
 * enormous text and four devices on it; the point of choosing a page size is
 * that the page is a known size, not that the drawing must fill it.
 */
export function fitOnSheet(
  content: { width: number; height: number },
  sheet: { w: number; h: number },
  margin = 36,
): Placement | null {
  if (sheet.w === 0 || sheet.h === 0) return null;
  const usableW = Math.max(1, sheet.w - margin * 2);
  const usableH = Math.max(1, sheet.h - margin * 2);
  const scale = Math.min(1, usableW / content.width, usableH / content.height);
  return {
    width: sheet.w,
    height: sheet.h,
    scale,
    x: (sheet.w - content.width * scale) / 2,
    y: (sheet.h - content.height * scale) / 2,
  };
}

/**
 * How many sheets a drawing covers at its own size.
 *
 * For the case the fit does not serve: a rack elevation or a campus map that
 * is meant to be printed across several pages and taped together, rather than
 * shrunk until the port labels cannot be read.
 */
export function sheetsFor(
  content: { width: number; height: number },
  sheet: { w: number; h: number },
  margin = 36,
): { across: number; down: number; total: number } {
  if (sheet.w === 0 || sheet.h === 0) return { across: 1, down: 1, total: 1 };
  const usableW = Math.max(1, sheet.w - margin * 2);
  const usableH = Math.max(1, sheet.h - margin * 2);
  const across = Math.max(1, Math.ceil(content.width / usableW));
  const down = Math.max(1, Math.ceil(content.height / usableH));
  return { across, down, total: across * down };
}

/** The diagram-space rectangle each sheet covers, at full size (LT-028).
 *  Row-major from the top-left. The paper's printable area (sheet minus
 *  margins) sets the tile size, so a tile prints at 1:1. */
export function tileRects(
  content: { x: number; y: number; width: number; height: number },
  sheet: { w: number; h: number },
  margin = 36,
): { x: number; y: number; w: number; h: number; row: number; col: number }[] {
  if (sheet.w === 0 || sheet.h === 0) {
    return [{ x: content.x, y: content.y, w: content.width, h: content.height, row: 0, col: 0 }];
  }
  const usableW = Math.max(1, sheet.w - margin * 2);
  const usableH = Math.max(1, sheet.h - margin * 2);
  const across = Math.max(1, Math.ceil(content.width / usableW));
  const down = Math.max(1, Math.ceil(content.height / usableH));
  const tiles: { x: number; y: number; w: number; h: number; row: number; col: number }[] = [];
  for (let row = 0; row < down; row += 1) {
    for (let col = 0; col < across; col += 1) {
      tiles.push({
        x: content.x + col * usableW,
        y: content.y + row * usableH,
        w: usableW,
        h: usableH,
        row,
        col,
      });
    }
  }
  return tiles;
}

/** "A4 landscape", or "the diagram's own size". */
export function describePage(paper: PaperSize, orientation: Orientation): string {
  if (paper.width === 0) return 'sized to the diagram';
  return `${paper.name} ${orientation}`;
}
