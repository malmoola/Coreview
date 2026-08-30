/**
 * Which side of a device a link leaves from.
 *
 * Everything a crawl draws currently leaves the bottom and arrives at the top,
 * which is right for a core switch above an access switch and wrong for two
 * devices side by side — that link dives below both and climbs back up,
 * crossing whatever sits between them.
 *
 * A node offers source handles on its right and bottom only, and target
 * handles on its top and left. That asymmetry is deliberate: it makes dragging
 * a new link predictable, because the place you start is always a source. It
 * also means there are exactly two legal pairs, and routing is the job of
 * picking the better one rather than the ideal one.
 */
import type { TopoEdge, TopoNode } from '../state/store';

export interface Handles {
  sourceHandle: 'r' | 'b';
  targetHandle: 'l' | 't';
}

const HORIZONTAL: Handles = { sourceHandle: 'r', targetHandle: 'l' };
const VERTICAL: Handles = { sourceHandle: 'b', targetHandle: 't' };

function centre(n: TopoNode): { x: number; y: number } {
  const w = n.width ?? n.measured?.width ?? 176;
  const h = n.height ?? n.measured?.height ?? 96;
  return { x: n.position.x + w / 2, y: n.position.y + h / 2 };
}

/**
 * The better of the two legal handle pairs for a link between these nodes.
 *
 * Sideways only when the target really is to the side *and* to the right: a
 * target to the left has no legal sideways route, because the source cannot
 * emit from its left. Ties go to vertical, because network diagrams are drawn
 * in tiers and a slight horizontal offset between two tiers is still a tier.
 */
export function chooseHandles(source: TopoNode, target: TopoNode): Handles {
  const a = centre(source);
  const b = centre(target);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.2) return HORIZONTAL;
  return VERTICAL;
}

/**
 * The edges as they should be drawn right now.
 *
 * Called on every render, so a link swings round to the nearer side while a
 * device is being dragged rather than staying attached to the side it was
 * drawn on. That is the difference between a diagram that stays right as it
 * is rearranged and one that has to be tidied up afterwards.
 *
 * This is a view. The stored handles are left alone, so a link that is pinned
 * still has somewhere to go back to, and nothing is written to the document
 * while someone drags a node around.
 */
export function routeForView(nodes: TopoNode[], edges: TopoEdge[]): TopoEdge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let changed = false;
  const out = edges.map((edge) => {
    if ((edge.data as { pinnedSides?: boolean } | undefined)?.pinnedSides) return edge;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) return edge;
    const want = chooseHandles(source, target);
    if (edge.sourceHandle === want.sourceHandle && edge.targetHandle === want.targetHandle) {
      return edge;
    }
    changed = true;
    return { ...edge, ...want };
  });
  // The same array when nothing moved, so React Flow is not handed a new
  // list of edges on every unrelated render.
  return changed ? out : edges;
}

/**
 * Re-routes every link whose ends have moved, leaving the rest alone.
 *
 * Returns only what changed, so nothing is written for a diagram that is
 * already routed well and an undo step is not created for no reason.
 */
export function routeLinks(
  nodes: TopoNode[],
  edges: TopoEdge[],
): { id: string; sourceHandle: string; targetHandle: string }[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const changed: { id: string; sourceHandle: string; targetHandle: string }[] = [];
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    const want = chooseHandles(source, target);
    if (edge.sourceHandle === want.sourceHandle && edge.targetHandle === want.targetHandle) {
      continue;
    }
    changed.push({ id: edge.id, ...want });
  }
  return changed;
}
