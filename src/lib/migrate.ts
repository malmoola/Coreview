import type { ProjectDocument, TopoNode } from '../state/store';
import type { DeviceNodeData } from '../types/domain';

/** Shapes that are boxes by definition and keep card proportions; everything
 *  else that is a device draws as a glyph, whose bounds are square since
 *  LT-053 so the selection ring and resize corners sit on the drawn symbol. */
const BOXY = new Set(['rectangle', 'rounded', 'circle', 'diamond', 'cloud', 'text', 'zone', 'callout']);

/** The square a device glyph is drawn at when placed today. */
const GLYPH = 76;

/**
 * Bring a document up to date on open (LT-065).
 *
 * A device drawn before LT-053 was saved as a 168x92 box with a small glyph
 * floating in it. The renderer now treats a device's bounds as the glyph, so
 * an old node shows a wide ellipse of a selection ring with its corners out
 * in the air. This squares those nodes — and only those: a shape keeps its
 * dimensions, a node the operator resized keeps its size if it is already
 * roughly square, and positions never move.
 *
 * Idempotent, so opening an already-migrated document changes nothing.
 */
export function migrateDocument(doc: ProjectDocument): { doc: ProjectDocument; changed: number } {
  let changed = 0;
  const nodes = doc.nodes.map((n): TopoNode => {
    if (n.type !== 'device') return n;
    const d = n.data as DeviceNodeData;
    if (BOXY.has(d.deviceType)) return n;
    const w = n.width ?? 0;
    const h = n.height ?? 0;
    // The tell of an un-migrated glyph: the old default box, or any node
    // wider than it is tall by more than a little. A deliberately-resized
    // square glyph (already w≈h) is left alone.
    const isOldBox = (w === 168 && h === 92) || (w > 0 && h > 0 && Math.abs(w - h) > 12);
    if (!isOldBox) return n;
    changed += 1;
    // Keep the centre so the device does not appear to jump.
    const cx = n.position.x + w / 2;
    const cy = n.position.y + h / 2;
    return {
      ...n,
      width: GLYPH,
      height: GLYPH,
      position: { x: cx - GLYPH / 2, y: cy - GLYPH / 2 },
    } as TopoNode;
  });
  return { doc: { ...doc, nodes }, changed };
}
