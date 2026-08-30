/**
 * Copying part of a diagram and pasting it back.
 *
 * Two switches and the link between them, repeated for eleven wiring closets,
 * is most of what drawing a real network consists of. Doing it by dragging
 * from the palette and re-typing the port labels eleven times is the work
 * this removes.
 *
 * The links that come with a copy are the ones whose *both* ends were
 * selected. A link with one end outside the selection has nowhere to land on
 * the far side, and quietly attaching it to the original is worse than
 * leaving it out — it produces a diagram nobody drew.
 */
import type { TopoEdge, TopoNode } from '../state/store';

export interface Clipping {
  nodes: TopoNode[];
  edges: TopoEdge[];
}

export function copySelection(nodes: TopoNode[], edges: TopoEdge[]): Clipping {
  const picked = nodes.filter((n) => n.selected);
  const ids = new Set(picked.map((n) => n.id));
  return {
    // Deep-copied, so editing the original after copying does not change what
    // is on the clipboard — which is the sort of thing nobody expects to have
    // to think about.
    nodes: JSON.parse(JSON.stringify(picked)) as TopoNode[],
    edges: JSON.parse(
      JSON.stringify(edges.filter((e) => ids.has(e.source) && ids.has(e.target))),
    ) as TopoEdge[],
  };
}

/**
 * A copy of a clipping with fresh ids, offset so it does not land exactly on
 * top of what it came from.
 *
 * `newId` is passed in rather than imported so this stays testable without a
 * random source.
 */
export function pasteClipping(
  clip: Clipping,
  offset: { x: number; y: number },
  newId: () => string,
): Clipping {
  const remap = new Map<string, string>();
  for (const n of clip.nodes) remap.set(n.id, newId());

  const nodes = clip.nodes.map((n) => {
    const data = { ...(n.data as Record<string, unknown>) };
    // A group id is a reference to the other things in the group. Keeping the
    // original would join the copies to the originals, so every drag of one
    // moved the other.
    if ('groupId' in data) delete data.groupId;
    return {
      ...n,
      id: remap.get(n.id)!,
      position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
      // Selected, so the paste can be moved straight away — which is what
      // anyone does next.
      selected: true,
      data,
    } as TopoNode;
  });

  const edges = clip.edges.map((e) => ({
    ...e,
    id: newId(),
    source: remap.get(e.source)!,
    target: remap.get(e.target)!,
    selected: false,
  })) as TopoEdge[];

  return { nodes, edges };
}
