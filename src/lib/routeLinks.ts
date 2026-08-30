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

export type Side = 't' | 'r' | 'b' | 'l';

export interface Handles {
  sourceHandle: Side;
  targetHandle: Side;
}

const OPPOSITE: Record<Side, Side> = { t: 'b', r: 'l', b: 't', l: 'r' };

function centre(n: TopoNode): { x: number; y: number } {
  const w = n.width ?? n.measured?.width ?? 176;
  const h = n.height ?? n.measured?.height ?? 96;
  return { x: n.position.x + w / 2, y: n.position.y + h / 2 };
}

/**
 * The side of each device that faces the other one.
 *
 * All four sides can start a link, so this is a full turn: a device dragged
 * above its neighbour links from the top, one dragged to the left links from
 * the left. Ties go to vertical, because network diagrams are drawn in tiers
 * and a slight horizontal offset between two tiers is still a tier.
 */
export function chooseHandles(source: TopoNode, target: TopoNode): Handles {
  const a = centre(source);
  const b = centre(target);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const sideways = Math.abs(dx) > Math.abs(dy) * 1.2;
  const from: Side = sideways ? (dx > 0 ? 'r' : 'l') : dy > 0 ? 'b' : 't';
  return { sourceHandle: from, targetHandle: OPPOSITE[from] };
}

/**
 * Which lane each link takes, so links leaving the same side do not overlap.
 *
 * Six access switches hanging off the bottom of a core switch all turn at the
 * same distance below it, and the horizontal runs lie exactly on top of one
 * another. The diagram is not wrong, but nobody can follow a single cable
 * through it. Giving each one a different turning distance pulls them apart.
 *
 * A link is in the busiest lane either of its ends asks for, so both ends
 * agree and the run does not kink.
 */
export function assignLanes(edges: TopoEdge[]): Map<string, number> {
  const seen = new Map<string, number>();
  const perEnd = new Map<string, number>();
  for (const e of edges) {
    const ends = [`${e.source}:${e.sourceHandle ?? ''}`, `${e.target}:${e.targetHandle ?? ''}`];
    let lane = 0;
    for (const end of ends) {
      const next = perEnd.get(end) ?? 0;
      perEnd.set(end, next + 1);
      lane = Math.max(lane, next);
    }
    seen.set(e.id, lane);
  }
  return seen;
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
  const sided = edges.map((edge) => {
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

  // Lanes are worked out from the sides the links have just been given, so a
  // link that has swung round joins the queue at its new side.
  const lanes = assignLanes(sided);
  const out = sided.map((edge) => {
    const lane = lanes.get(edge.id) ?? 0;
    if (((edge.data as { lane?: number } | undefined)?.lane ?? 0) === lane) return edge;
    changed = true;
    return { ...edge, data: { ...edge.data, lane } } as TopoEdge;
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
