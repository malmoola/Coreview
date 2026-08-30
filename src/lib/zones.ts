/**
 * Sections on a diagram: a labelled area that holds the devices inside it.
 *
 * Grouping by selection already exists and is the right tool for "these three
 * things belong together". It is the wrong tool for "everything in this half
 * of the picture is the DMZ", because that membership is not a list somebody
 * maintains — it is wherever the boxes happen to be. A section is drawn, it
 * says what it is, and anything standing in it moves with it.
 *
 * Membership is therefore geometric and recomputed, never stored. Nothing has
 * to be re-assigned when a device is dragged into a section, and a device
 * dragged out is simply out.
 */
import type { TopoNode } from '../state/store';

export const ZONE_TYPE = 'zone';

export function isZone(node: TopoNode | undefined): boolean {
  return (
    node?.type === 'device' &&
    (node.data as { deviceType?: string }).deviceType === ZONE_TYPE
  );
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxOf(node: TopoNode): Box {
  return {
    x: node.position.x,
    y: node.position.y,
    w: node.width ?? node.measured?.width ?? 320,
    h: node.height ?? node.measured?.height ?? 220,
  };
}

/** Whether a node's middle stands inside a box.
 *
 *  The middle rather than the whole outline: a device half over the edge of a
 *  section belongs to whichever side most of it is on, and requiring full
 *  containment means a device touching the border silently stops moving with
 *  the section it visibly sits in. */
function centreInside(node: TopoNode, box: Box): boolean {
  const b = boxOf(node);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h;
}

/**
 * What a section currently holds.
 *
 * A section inside another section is held by the outer one, and so is
 * everything in it — that is what makes "Site A" containing "DMZ" work. A
 * section never holds itself.
 */
export function contentsOf(zone: TopoNode, nodes: TopoNode[]): TopoNode[] {
  const box = boxOf(zone);
  return nodes.filter((n) => n.id !== zone.id && centreInside(n, box));
}

/**
 * How much each node should move when sections are dragged.
 *
 * Returned as a map rather than applied here so the caller can skip nodes
 * React Flow has already moved — dragging a selection emits a change per node,
 * and moving those again would send anything both selected and inside a
 * section twice as far.
 */
export function zoneDeltas(
  moved: { id: string; dx: number; dy: number }[],
  before: TopoNode[],
): Map<string, { dx: number; dy: number }> {
  const out = new Map<string, { dx: number; dy: number }>();
  for (const m of moved) {
    if (m.dx === 0 && m.dy === 0) continue;
    const zone = before.find((n) => n.id === m.id);
    if (!zone || !isZone(zone)) continue;
    for (const held of contentsOf(zone, before)) {
      if ((held.data as { locked?: boolean }).locked) continue;
      // A node inside two sections that both moved follows the first; adding
      // both deltas would send it twice as far as either.
      if (!out.has(held.id)) out.set(held.id, { dx: m.dx, dy: m.dy });
    }
  }
  return out;
}
