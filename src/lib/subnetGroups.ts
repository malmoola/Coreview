/**
 * Bucketing devices by the network they sit on.
 *
 * A discovered diagram of a real estate is a lot of boxes, and the thing an
 * engineer wants to do with it first is push each site into its own corner.
 * Grouping by subnet makes that one drag per site instead of one per device.
 *
 * /24 because it is what a site or a VLAN almost always is, and because a
 * boundary someone has to configure before they can tidy a diagram is a
 * boundary they will not use.
 */
import type { DeviceNodeData } from '../types/domain';
import type { TopoNode } from '../state/store';

/** The /24 an address belongs to, as a label. */
export function subnetOf(address: string): string | null {
  const parts = address.trim().split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  // A trailing empty part passes Number('') === 0, which would make "10.0.0."
  // a valid address.
  if (parts.some((p) => p.trim() === '')) return null;
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

/** The primary address a node is drawn with. */
export function addressOf(node: TopoNode): string | null {
  if (node.type !== 'device') return null;
  const d = node.data as DeviceNodeData;
  return d.addresses?.find((a) => a.isPrimary)?.address ?? d.addresses?.[0]?.address ?? null;
}

export interface SubnetGrouping {
  /** Node id to the subnet it belongs to. */
  assignments: Map<string, string>;
  /** Subnets with more than one device in them, in address order. */
  subnets: string[];
  /** Devices with no address, or an address that is not IPv4. */
  ungrouped: number;
}

/**
 * Which nodes belong together.
 *
 * A subnet holding one device is left alone: a group of one moves exactly as
 * it did before and only makes the diagram harder to reason about.
 */
export function groupBySubnet(nodes: TopoNode[]): SubnetGrouping {
  const buckets = new Map<string, string[]>();
  let ungrouped = 0;

  for (const n of nodes) {
    if (n.type !== 'device') continue;
    const subnet = subnetOf(addressOf(n) ?? '');
    if (!subnet) {
      ungrouped += 1;
      continue;
    }
    const bucket = buckets.get(subnet) ?? [];
    bucket.push(n.id);
    buckets.set(subnet, bucket);
  }

  const assignments = new Map<string, string>();
  const subnets: string[] = [];
  for (const [subnet, ids] of [...buckets.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], undefined, { numeric: true }),
  )) {
    if (ids.length < 2) {
      ungrouped += ids.length;
      continue;
    }
    subnets.push(subnet);
    for (const id of ids) assignments.set(id, subnet);
  }

  return { assignments, subnets, ungrouped };
}
