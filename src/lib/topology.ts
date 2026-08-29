/**
 * Turning a crawl into a drawn topology.
 *
 * Discovery already knows who is plugged into what: every reached device
 * reports its neighbours with the port at each end. The interface used to
 * throw that away and lay the devices out in a grid with no links, which is a
 * list of devices arranged in rows, not a diagram. This builds the diagram —
 * nodes joined by the adjacencies that were discovered, each link labelled
 * with the interface at both ends.
 *
 * Pure, so the identity, de-duplication and layout rules can be tested without
 * a network or a browser.
 */
import type { CrawledDevice, DeviceClassName, Neighbor } from './ipc';
import type { TopoEdge, TopoNode } from '../state/store';
import type { DeviceNodeData, DeviceType, LinkData } from '../types/domain';
import { uid } from './id';

/** The glyph each discovered class is drawn with. */
export const CLASS_GLYPH: Record<DeviceClassName, DeviceType> = {
  router: 'router',
  switch: 'core-switch',
  firewall: 'firewall',
  'wireless-controller': 'wireless-controller',
  'access-point': 'access-point',
  // These two were 'endpoint-client' and 'camera-iot', which are not device
  // types. They passed a cast and fell back to the generic box, so every phone
  // and camera on a discovered diagram was drawn as an anonymous rectangle.
  phone: 'endpoint',
  camera: 'camera',
  printer: 'printer',
  server: 'server',
  endpoint: 'endpoint',
  unknown: 'generic',
};


/**
 * The short form of an interface name, as a diagram writes it.
 *
 * CDP reports `GigabitEthernet0/1` and LLDP reports `Gi0/1` for the same port,
 * so a diagram built from both is inconsistent as well as cramped — five long
 * names leaving one switch overlap each other whatever else is done about
 * spacing. The full name is kept on the link's notes, not thrown away.
 */
export function shortInterface(name: string): string {
  const trimmed = name.trim();
  // Longest first: TenGigabitEthernet must not match the Ethernet rule.
  const forms: [RegExp, string][] = [
    [/^TwentyFiveGigE/i, 'Twe'],
    [/^TenGigabitEthernet/i, 'Te'],
    [/^HundredGigE/i, 'Hu'],
    [/^FortyGigabitEthernet/i, 'Fo'],
    [/^GigabitEthernet/i, 'Gi'],
    [/^FastEthernet/i, 'Fa'],
    [/^Port-channel/i, 'Po'],
    [/^TenGigE/i, 'Te'],
    [/^Ethernet/i, 'Et'],
    [/^Vlan/i, 'Vl'],
    [/^Loopback/i, 'Lo'],
  ];
  for (const [pattern, prefix] of forms) {
    if (pattern.test(trimmed)) return trimmed.replace(pattern, prefix);
  }
  return trimmed;
}

export interface TopologySource {
  /** Devices that were logged into. These carry the adjacencies. */
  devices: CrawledDevice[];
  /** Seen as a neighbour but never visited — phones, printers, endpoints. */
  notVisited: Neighbor[];
}

export interface TopologyOptions {
  /** Classes to place. Empty or omitted means everything discovered. */
  include?: DeviceClassName[];
  /** Top-left of the block to lay out in. */
  origin?: { x: number; y: number };
  /** Only reached devices get a probe by default: a crawl of a large flat
   *  network can see hundreds of endpoints, and monitoring all of them is a
   *  decision rather than a side effect of drawing them. */
  probeReachedOnly?: boolean;
}

export interface BuiltTopology {
  nodes: TopoNode[];
  edges: TopoEdge[];
  /** Adjacencies dropped because one end was filtered out. */
  danglingLinks: number;
}

/**
 * The identity two sightings of the same device have to agree on.
 *
 * CDP reports a device as `SW1.example.com`, LLDP as `SW1`, and the device's
 * own prompt as `sw1`. Without folding those together the same switch appears
 * three times with a third of its links each.
 */
export function identity(name: string, address: string): string {
  const short = name.trim().split('.')[0]?.toLowerCase() ?? '';
  // A name that is really a serial or an empty string is no identity at all;
  // the address is the better key then.
  return short && short !== 'unknown' ? `n:${short}` : `a:${address.trim()}`;
}

interface Entry {
  key: string;
  name: string;
  address: string;
  klass: DeviceClassName;
  platform: string | null;
  reached: boolean;
  depth: number;
}

/** One end of a discovered link. */
interface LinkEnd {
  key: string;
  iface: string;
}

function linkKey(a: LinkEnd, b: LinkEnd): string {
  // Sorted, so the same cable reported from both ends collapses to one link.
  // The interface is part of the key: two switches joined by two cables are
  // two links, and dropping the interface would silently merge them.
  const ends = [`${a.key}/${a.iface}`, `${b.key}/${b.iface}`].sort();
  return ends.join('::');
}

export function buildTopology(
  src: TopologySource,
  projectId: string,
  opts: TopologyOptions = {},
): BuiltTopology {
  const include = opts.include?.length ? new Set(opts.include) : null;
  const origin = opts.origin ?? { x: 80, y: 80 };

  const entries = new Map<string, Entry>();
  const note = (e: Entry) => {
    const seen = entries.get(e.key);
    // A reached device knows more about itself than a neighbour's report of
    // it, so it wins; otherwise keep the first sighting and fill in blanks.
    if (!seen) entries.set(e.key, e);
    else if (e.reached && !seen.reached) entries.set(e.key, { ...e, depth: Math.min(e.depth, seen.depth) });
    else {
      if (!seen.address && e.address) seen.address = e.address;
      if (seen.klass === 'unknown' && e.klass !== 'unknown') seen.klass = e.klass;
      if (!seen.platform && e.platform) seen.platform = e.platform;
      seen.depth = Math.min(seen.depth, e.depth);
    }
  };

  for (const d of src.devices) {
    note({
      key: identity(d.hostname, d.address),
      name: d.hostname || d.address,
      address: d.probeTarget || d.address,
      klass: d.class,
      platform: d.platform,
      reached: true,
      depth: d.hops,
    });
  }

  // Neighbours, from the devices that reported them and from the leftovers.
  const fromNeighbor = (n: Neighbor, depth: number): Entry => ({
    key: identity(n.shortName || n.deviceId, n.addresses[0]?.ip ?? ''),
    name: n.shortName || n.deviceId,
    address: n.addresses[0]?.ip ?? '',
    klass: n.class,
    platform: n.platform,
    reached: false,
    depth,
  });
  for (const d of src.devices) for (const n of d.neighbors) note(fromNeighbor(n, d.hops + 1));
  for (const n of src.notVisited) note(fromNeighbor(n, 1));

  // Links, before filtering, so a dropped endpoint can be counted.
  const links = new Map<string, { a: LinkEnd; b: LinkEnd }>();
  for (const d of src.devices) {
    const from = identity(d.hostname, d.address);
    for (const n of d.neighbors) {
      const to = identity(n.shortName || n.deviceId, n.addresses[0]?.ip ?? '');
      if (to === from) continue;
      const end: { a: LinkEnd; b: LinkEnd } = {
        a: { key: from, iface: n.localInterface ?? '' },
        b: { key: to, iface: n.remoteInterface ?? '' },
      };
      links.set(linkKey(end.a, end.b), end);
    }
  }

  const placed = [...entries.values()].filter((e) => !include || include.has(e.klass));
  const placedKeys = new Set(placed.map((e) => e.key));

  // Layered by how far each device is from the seed, which is the shape a
  // network actually has. The old grid said nothing about the topology.
  const byDepth = new Map<number, Entry[]>();
  for (const e of placed) {
    const row = byDepth.get(e.depth) ?? [];
    row.push(e);
    byDepth.set(e.depth, row);
  }
  const widest = Math.max(1, ...[...byDepth.values()].map((r) => r.length));
  const COL = 240;
  const ROW = 210;

  const nodeFor = new Map<string, string>();
  const nodes: TopoNode[] = [];
  for (const [depth, row] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    row.sort((a, b) => a.name.localeCompare(b.name));
    // Each row centred against the widest, so the diagram reads as a tree
    // rather than everything crammed to the left.
    const indent = ((widest - row.length) * COL) / 2;
    row.forEach((e, i) => {
      const id = uid();
      nodeFor.set(e.key, id);
      const data: DeviceNodeData = {
        label: e.name,
        deviceType: CLASS_GLYPH[e.klass] ?? 'generic',
        tags: [e.reached ? 'discovered' : 'seen-only'],
        addresses: e.address
          ? [{ id: uid(), label: 'Discovered', address: e.address, isPrimary: true }]
          : [],
        locked: false,
        maintenance: false,
        showDetails: true,
        ...(e.platform ? { model: e.platform } : {}),
      };
      nodes.push({
        id,
        type: 'device',
        position: { x: origin.x + indent + i * COL, y: origin.y + depth * ROW },
        width: 176,
        height: 96,
        data,
      } as TopoNode);
    });
  }

  const edges: TopoEdge[] = [];
  let danglingLinks = 0;
  for (const { a, b } of links.values()) {
    const source = nodeFor.get(a.key);
    const target = nodeFor.get(b.key);
    if (!source || !target) {
      // One end was filtered off the diagram. Counted rather than dropped
      // silently, so the interface can say the picture is incomplete.
      if (!placedKeys.has(a.key) || !placedKeys.has(b.key)) danglingLinks += 1;
      continue;
    }
    const full = [a.iface, b.iface].filter(Boolean).join(' \u2194 ');
    const data: LinkData = {
      sourcePortLabel: shortInterface(a.iface),
      targetPortLabel: shortInterface(b.iface),
      label: '',
      notes: full ? `Discovered: ${full}` : undefined,
      pathType: 'smoothstep',
      direction: 'none',
      width: 2,
      color: '#5b6b7c',
      enabled: true,
      maintenance: false,
      healthRule: { type: 'both-endpoints' },
    };
    edges.push({
      id: uid(),
      source,
      target,
      sourceHandle: 'b',
      targetHandle: 't',
      type: 'live',
      data,
    } as TopoEdge);
  }

  void projectId;
  return { nodes, edges, danglingLinks };
}
