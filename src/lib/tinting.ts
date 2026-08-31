/**
 * Colouring a diagram by something other than health.
 *
 * Health is what the app is for and is the right default. It is not the only
 * question anyone asks of a diagram. "Which of these are on the management
 * VLAN", "which building is this in", "which of these did we touch on
 * Saturday" — those are answered by colour on a network diagram and cannot be
 * answered by a general drawing tool at all, because it does not know what an
 * address is.
 *
 * The colours are assigned from the key itself rather than from the order
 * things happen to be in, so the same subnet is the same colour every time the
 * project is opened, and adding a device does not repaint the diagram.
 */
import type { TopoNode } from '../state/store';
import type { DeviceNodeData } from '../types/domain';
import { GROUP_WHEEL_DARK, GROUP_WHEEL_LIGHT, type Ground } from '../theme';
import { subnetOf } from './subnetGroups';

export type ColourBy = 'health' | 'role' | 'subnet' | 'tag' | 'vlan';


/** What a device is being grouped by, or null when it has no answer.
 *
 *  Takes the node's data rather than the node, because a node component
 *  already has its own data as a prop. Looking the node back up in the store
 *  made every device search the whole diagram on every change — quadratic in
 *  the number of devices, on a canvas whose whole job is to hold a lot of
 *  them. */
export function keyForData(d: DeviceNodeData, by: ColourBy): string | null {
  switch (by) {
    case 'role':
      return d.deviceType ?? null;
    case 'subnet': {
      const address =
        d.addresses?.find((a) => a.isPrimary)?.address ?? d.addresses?.[0]?.address ?? '';
      return address ? subnetOf(address) : null;
    }
    case 'vlan':
      // The access VLAN a switch learned this device on. A device with none
      // — a switch that trunks many, or one found over a discovery protocol
      // — is left uncoloured rather than lumped into one shade.
      return d.vlan ? `VLAN ${d.vlan}` : null;
    case 'tag': {
      // The first tag the crawler did not write. Those say how a device was
      // found, not what it is or where, and would colour the whole diagram
      // one shade.
      const own = (d.tags ?? []).filter(
        (t) => !['discovered', 'seen-only', 'attached'].includes(t),
      );
      return own[0] ?? null;
    }
    default:
      return null;
  }
}

export function keyFor(node: TopoNode, by: ColourBy): string | null {
  if (node.type !== 'device') return null;
  return keyForData(node.data as DeviceNodeData, by);
}

/** A small, stable hash. The same key gives the same colour every session. */
function hash(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * The colour for a key.
 *
 * Assigned from the key rather than from where it happens to sit in a list, so
 * adding one device does not repaint every other one — which would make the
 * colours meaningless as a memory aid.
 */
export function colourForKey(key: string, ground: Ground): string {
  const wheel = ground === 'light' ? GROUP_WHEEL_LIGHT : GROUP_WHEEL_DARK;
  return wheel[hash(key) % wheel.length]!;
}

/**
 * Every key on the diagram, in a stable order, with its colour — for a legend.
 *
 * Sorted by name rather than by appearance, because a legend that reorders
 * itself when a device is added is a legend nobody trusts.
 */
export function legendFor(
  nodes: TopoNode[],
  by: ColourBy,
  ground: Ground,
): { key: string; colour: string; count: number }[] {
  if (by === 'health') return [];
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const key = keyFor(n, by);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([key, count]) => ({ key, colour: colourForKey(key, ground), count }));
}
