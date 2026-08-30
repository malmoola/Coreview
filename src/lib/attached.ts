/**
 * Choosing which silent devices belong on the diagram.
 *
 * A switch knows about everything plugged into it, and on a flat /24 that can
 * be two hundred things. Drawing all of them buries the topology the diagram
 * exists to show, so nothing is drawn unless it is asked for.
 *
 * The filter is deliberately about what someone is looking for — a vendor, a
 * subnet, a particular port — rather than a count. "Show me the Axis cameras"
 * is a question about a network; "show me the first fifty" is not.
 */
import type { AttachedDevice, CrawledDevice } from './ipc';
import { subnetOf } from './subnetGroups';

export interface AttachedFilter {
  /** Substring of the maker's name, case-insensitive. Empty matches any. */
  vendor?: string;
  /** Only devices whose address is in this /24. Empty matches any. */
  subnet?: string;
  /** Substring of the port name, case-insensitive. Empty matches any. */
  port?: string;
  /** Skip anything on a port carrying more than this many addresses. A port
   *  with twenty leads to another switch, and what is behind it belongs to
   *  that switch's diagram rather than this one. */
  maxPerPort?: number;
  /** Only devices whose address is known. Something with no address can be
   *  drawn but never checked. */
  addressedOnly?: boolean;
}

/** One silent device, and which switch port it hangs off. */
export interface AttachedOn {
  device: AttachedDevice;
  /** Hostname of the switch that learned it. */
  host: string;
}

/** Everything the crawl saw attached, before any filtering. */
export function allAttached(devices: CrawledDevice[]): AttachedOn[] {
  return devices.flatMap((d) => (d.attached ?? []).map((a) => ({ device: a, host: d.hostname })));
}

/**
 * What someone typed, as a /24 to compare against.
 *
 * People write a subnet three ways — "192.168.14.0/24", "192.168.14.0" and
 * just "192.168.14" — and `subnetOf` only understands the middle one, because
 * a prefix length is not an octet.
 */
function asSubnet(query: string): string | null {
  const bare = query.trim().split('/')[0]?.trim() ?? '';
  if (!bare) return null;
  const octets = bare.split('.').filter((p) => p !== '');
  if (octets.length === 3) return subnetOf(`${octets.join('.')}.0`);
  if (octets.length === 4) return subnetOf(bare);
  return null;
}

/** Whether one device answers the question being asked. */
export function matchesFilter(a: AttachedDevice, filter: AttachedFilter): boolean {
  const { vendor, subnet, port, maxPerPort, addressedOnly } = filter;

  if (vendor?.trim()) {
    const want = vendor.trim().toLowerCase();
    if (!(a.vendor ?? '').toLowerCase().includes(want)) return false;
  }
  if (subnet?.trim()) {
    const want = asSubnet(subnet);
    if (!want) return false;
    if (!a.address || subnetOf(a.address) !== want) return false;
  }
  if (port?.trim()) {
    if (!a.port.toLowerCase().includes(port.trim().toLowerCase())) return false;
  }
  if (maxPerPort !== undefined && a.portPopulation > maxPerPort) return false;
  if (addressedOnly && !a.address) return false;
  return true;
}

/**
 * The devices to draw, deduplicated by MAC.
 *
 * A MAC can be learned by more than one switch — through an uplink, or while
 * a device moves — and drawing it once per sighting would put the same
 * printer on the diagram three times. The first sighting wins, which is the
 * switch nearest the seed.
 */
export function selectAttached(
  devices: CrawledDevice[],
  filter: AttachedFilter,
): AttachedOn[] {
  const seen = new Set<string>();
  const out: AttachedOn[] = [];
  for (const entry of allAttached(devices)) {
    if (!matchesFilter(entry.device, filter)) continue;
    if (seen.has(entry.device.mac)) continue;
    seen.add(entry.device.mac);
    out.push(entry);
  }
  return out;
}

/** Every maker seen, with how many of each, for offering as choices. */
export function vendorCounts(devices: CrawledDevice[]): { vendor: string; count: number }[] {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const { device } of allAttached(devices)) {
    if (seen.has(device.mac)) continue;
    seen.add(device.mac);
    const name = device.vendor ?? 'Unknown maker';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([vendor, count]) => ({ vendor, count }))
    // Commonest first: the thing someone wants is usually the thing there is
    // a lot of.
    .sort((a, b) => b.count - a.count || a.vendor.localeCompare(b.vendor));
}
