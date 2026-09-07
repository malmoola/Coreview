import type { ProjectDocument, ProjectPage, TopoEdge, TopoNode } from '../state/store';
import type { DeviceNodeData } from '../types/domain';
import { uid } from './id';
import { DEFAULT_PAGE_CANVAS, newPage } from './pages';

/** Shapes that are boxes by definition and keep card proportions; everything
 *  else that is a device draws as a glyph, whose bounds are square since
 *  LT-053 so the selection ring and resize corners sit on the drawn symbol. */
const BOXY = new Set(['rectangle', 'rounded', 'circle', 'diamond', 'cloud', 'text', 'zone', 'callout']);

/** The square a device glyph is drawn at when placed today. */
const GLYPH = 76;

/** The shape a document was saved in before LT-094 introduced pages: one
 *  flat canvas, read here only on the way through `toPagesShape`. */
interface LegacyDocument {
  nodes?: TopoNode[];
  edges?: TopoEdge[];
  canvas?: ProjectPage['canvas'];
  probes?: ProjectDocument['probes'];
}

/**
 * Wraps a document saved before LT-094 into a single page named "Page 1" —
 * everything that was on it stays exactly where it was, just inside the new
 * shape. A no-op (beyond filling in a missing/stale activePageId) on a
 * document that already has pages, so this is safe to run unconditionally.
 */
function toPagesShape(raw: unknown): { doc: ProjectDocument; wrapped: boolean } {
  const r = (raw ?? {}) as Partial<ProjectDocument> & LegacyDocument;
  if (Array.isArray(r.pages) && r.pages.length > 0) {
    const activePageId =
      typeof r.activePageId === 'string' && r.pages.some((p) => p.id === r.activePageId)
        ? r.activePageId
        : r.pages[0]!.id;
    return { doc: { pages: r.pages, activePageId, probes: r.probes ?? [] }, wrapped: false };
  }
  const page: ProjectPage = {
    ...newPage('Page 1', uid()),
    nodes: r.nodes ?? [],
    edges: r.edges ?? [],
    canvas: r.canvas ?? { ...DEFAULT_PAGE_CANVAS },
  };
  return {
    doc: { pages: [page], activePageId: page.id, probes: r.probes ?? [] },
    wrapped: true,
  };
}

/**
 * Bring a document up to date on open.
 *
 * Two steps, in order: first LT-094's page wrapping (above), then LT-065's
 * device-glyph squaring, which now runs across every page rather than one
 * flat node list. Both are idempotent, so opening an already-migrated
 * document changes nothing.
 */
export function migrateDocument(raw: unknown): { doc: ProjectDocument; changed: number } {
  const { doc: wrappedDoc, wrapped } = toPagesShape(raw);
  let changed = wrapped ? 1 : 0;

  const pages = wrappedDoc.pages.map((page): ProjectPage => {
    const nodes = page.nodes.map((n): TopoNode => {
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
    return { ...page, nodes };
  });

  return { doc: { ...wrappedDoc, pages }, changed };
}
