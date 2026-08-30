/**
 * Folding a site down to one box.
 *
 * A crawled estate is a lot of boxes. Once each site is grouped, the next
 * thing anyone wants is to stop looking at the inside of the sites they are
 * not working on — not to delete them, not to move them off-screen, but to
 * see "Branch office, 14 devices" with the links that leave it still drawn.
 *
 * Nothing here changes the document. Collapsing is a view, computed on the way
 * to the canvas, so expanding restores exactly what was there and a collapsed
 * diagram saved and reopened has lost nothing.
 */
import type { TopoEdge, TopoNode } from '../state/store';
import type { DeviceNodeData } from '../types/domain';

export const COLLAPSED_PREFIX = 'collapsed:';

function groupOf(node: TopoNode): string | undefined {
  return (node.data as { groupId?: string }).groupId;
}

function labelOf(node: TopoNode): string {
  const d = node.data as Partial<DeviceNodeData> & { title?: string };
  return d.label ?? d.title ?? '';
}

/** A name for the folded box, taken from what is inside it. */
export function nameForGroup(members: TopoNode[]): string {
  // A tag every member shares is the closest thing to a site name that the
  // diagram actually knows. Falling back to a device name would put one
  // machine's name on a box holding fourteen.
  const tagSets = members
    .filter((n) => n.type === 'device')
    .map((n) => new Set((n.data as DeviceNodeData).tags ?? []));
  if (tagSets.length > 0) {
    const shared = [...(tagSets[0] ?? [])]
      .filter((t) => tagSets.every((s) => s.has(t)))
      // These are written by the crawler about how a device was found, not
      // about where it is, so they never name a site.
      .filter((t) => t !== 'discovered' && t !== 'seen-only' && t !== 'attached')
      .sort();
    if (shared[0]) return shared[0];
  }
  return `${members.length} objects`;
}

export interface CollapsedView {
  nodes: TopoNode[];
  edges: TopoEdge[];
}

/**
 * The diagram as it should be drawn, with the named groups folded.
 *
 * Links wholly inside a folded group disappear with it. Links crossing the
 * boundary are redrawn to the box, and several links to the same place become
 * one — fourteen parallel lines into a folded site says nothing that one line
 * does not.
 */
export function collapseView(
  nodes: TopoNode[],
  edges: TopoEdge[],
  collapsed: Set<string>,
): CollapsedView {
  if (collapsed.size === 0) return { nodes, edges };

  const members = new Map<string, TopoNode[]>();
  for (const n of nodes) {
    const g = groupOf(n);
    if (g && collapsed.has(g)) {
      const list = members.get(g);
      if (list) list.push(n);
      else members.set(g, [n]);
    }
  }
  // A group id nobody carries any more — the nodes were deleted or ungrouped
  // while it was folded. Nothing to fold, and no empty box drawn for it.
  if (members.size === 0) return { nodes, edges };

  const standIn = new Map<string, string>();
  const outNodes: TopoNode[] = nodes.filter((n) => {
    const g = groupOf(n);
    return !g || !members.has(g);
  });

  for (const [group, inside] of members) {
    const id = `${COLLAPSED_PREFIX}${group}`;
    for (const n of inside) standIn.set(n.id, id);
    // Top-left of what it replaces, so the box lands where the site was
    // rather than jumping to a corner.
    const x = Math.min(...inside.map((n) => n.position.x));
    const y = Math.min(...inside.map((n) => n.position.y));
    const devices = inside.filter((n) => n.type === 'device').length;
    outNodes.push({
      id,
      type: 'device',
      position: { x, y },
      width: 200,
      height: 96,
      data: {
        label: nameForGroup(inside),
        deviceType: 'site',
        tags: [],
        addresses: [],
        locked: false,
        maintenance: false,
        showDetails: true,
        notes:
          `${inside.length} object${inside.length === 1 ? '' : 's'} folded in` +
          (devices === inside.length ? '' : `, ${devices} of them devices`) +
          `. Contains: ${inside.map(labelOf).filter(Boolean).join(', ')}`,
      } as DeviceNodeData,
    } as TopoNode);
  }

  const seen = new Set<string>();
  const outEdges: TopoEdge[] = [];
  for (const e of edges) {
    const source = standIn.get(e.source) ?? e.source;
    const target = standIn.get(e.target) ?? e.target;
    // Both ends folded into the same box: the link is inside it now.
    if (source === target) continue;
    if (source === e.source && target === e.target) {
      outEdges.push(e);
      continue;
    }
    const key = `${source}->${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    outEdges.push({ ...e, id: `${COLLAPSED_PREFIX}${e.id}`, source, target });
  }

  return { nodes: outNodes, edges: outEdges };
}

/** Whether an id belongs to a folded box rather than a real object. */
export function isCollapsed(id: string): boolean {
  return id.startsWith(COLLAPSED_PREFIX);
}

/** The group a folded box stands for. */
export function groupIdOf(collapsedNodeId: string): string {
  return collapsedNodeId.slice(COLLAPSED_PREFIX.length);
}
