/**
 * Arranging a topology the way a network engineer draws one: the internet at
 * the top, the edge under it, the core under that, and the access layer at the
 * bottom, with the links running downward between them (LT-114).
 *
 * This is the opposite of `tidyLayout`, and both are wanted. Tidy fixes the
 * spacing of a drawing somebody arranged by hand and must not move anything
 * else. This one *does* rearrange: it is for a topology that arrived without
 * an arrangement worth keeping — a crawl, a CSV, a drawing whose author put
 * the boxes wherever there was room — where the question is not "where were
 * these" but "what feeds what".
 *
 * How the tiers are decided, in order:
 *
 * 1. **What the device is.** A firewall sits above a core switch and below the
 *    internet, whatever the cabling says. This is the part a generic graph
 *    layout cannot know and is most of why those produce diagrams nobody
 *    recognises.
 * 2. **What it is plugged into.** A device whose type says nothing — a
 *    `generic`, an imported shape — takes a tier one below the highest thing
 *    it connects to. Applied repeatedly, so a chain of unknowns resolves.
 * 3. **Nothing.** An isolated device with no useful type goes to the bottom
 *    rather than being dropped somewhere arbitrary in the middle.
 *
 * Within a tier, order is settled by the median of each node's neighbours in
 * the tier above — the standard cure for crossings, and cheap. Two sweeps: the
 * first does nearly all the work, and a layout that keeps shuffling is a
 * layout an operator cannot predict.
 */
import type { DeviceType } from '../types/domain';

export interface HierarchyNode {
  id: string;
  deviceType: DeviceType;
  width: number;
  height: number;
  /** A locked node is never moved, and never counted as placed. */
  locked?: boolean;
}

export interface HierarchyEdge {
  source: string;
  target: string;
}

export interface HierarchyOptions {
  /** Space between the left edge of one node and the next in a tier. */
  columnGap?: number;
  /** Space between the top of one tier and the top of the next. */
  rowGap?: number;
  /** Where the top-left of the arrangement goes. */
  originX?: number;
  originY?: number;
}

export interface HierarchyResult {
  moved: Map<string, { x: number; y: number }>;
  /** How many tiers the topology turned out to have. */
  tiers: number;
  /** Nodes left where they were because they are locked. */
  locked: number;
}

/**
 * The tier a device belongs to purely by what it is.
 *
 * Undefined means "the drawing has not said" — a plain shape, a `generic`, an
 * imported icon nobody typed a role onto — and those are placed by what they
 * connect to instead. Deliberately coarse: the point is a readable top-to-
 * bottom flow, not a taxonomy.
 */
export const TIER_OF_TYPE: Partial<Record<DeviceType, number>> = {
  internet: 0,
  cloud: 0,
  'private-cloud': 0,
  site: 0,
  vpn: 1,
  router: 1,
  firewall: 2,
  'core-switch': 3,
  'wireless-controller': 3,
  'distribution-switch': 4,
  'access-switch': 5,
  'access-point': 6,
  server: 6,
  vm: 6,
  storage: 6,
  application: 6,
  database: 6,
  printer: 7,
  camera: 7,
  endpoint: 7,
};

/** The tier every node lands in, by the three rules in the module comment. */
export function tiersFor(nodes: HierarchyNode[], edges: HierarchyEdge[]): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id));
  const neighbours = new Map<string, string[]>();
  for (const n of nodes) neighbours.set(n.id, []);
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    neighbours.get(e.source)?.push(e.target);
    neighbours.get(e.target)?.push(e.source);
  }

  const tier = new Map<string, number>();
  for (const n of nodes) {
    const t = TIER_OF_TYPE[n.deviceType];
    if (t !== undefined) tier.set(n.id, t);
  }

  // Rule 2, repeated until it stops changing anything. Bounded by the node
  // count, so a ring of unknowns cannot spin here.
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const n of nodes) {
      if (tier.has(n.id)) continue;
      const known = (neighbours.get(n.id) ?? [])
        .map((id) => tier.get(id))
        .filter((t): t is number => t !== undefined);
      if (known.length === 0) continue;
      tier.set(n.id, Math.min(...known) + 1);
      changed = true;
    }
    if (!changed) break;
  }

  // Rule 3.
  const deepest = tier.size ? Math.max(...tier.values()) : 0;
  for (const n of nodes) if (!tier.has(n.id)) tier.set(n.id, deepest + 1);

  // Close the gaps, so a topology with no firewalls does not leave an empty
  // band where the firewalls would have been.
  const used = [...new Set(tier.values())].sort((a, b) => a - b);
  const rank = new Map(used.map((t, i) => [t, i]));
  for (const [id, t] of tier) tier.set(id, rank.get(t) ?? 0);
  return tier;
}

/** Median of a list, or undefined for an empty one. */
function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/**
 * Where every device goes.
 *
 * Locked nodes keep their positions and are reported rather than moved; they
 * still take part in deciding tiers, because what they are plugged into is
 * still true.
 */
export function hierarchicalLayout(
  nodes: HierarchyNode[],
  edges: HierarchyEdge[],
  options: HierarchyOptions = {},
): HierarchyResult {
  const columnGap = options.columnGap ?? 200;
  const rowGap = options.rowGap ?? 170;
  const originX = options.originX ?? 0;
  const originY = options.originY ?? 0;

  const moved = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return { moved, tiers: 0, locked: 0 };

  const tier = tiersFor(nodes, edges);
  const byTier = new Map<number, HierarchyNode[]>();
  for (const n of nodes) {
    const t = tier.get(n.id) ?? 0;
    const row = byTier.get(t);
    if (row) row.push(n);
    else byTier.set(t, [n]);
  }
  const tiers = [...byTier.keys()].sort((a, b) => a - b);

  // Order within each tier: start from whatever order the nodes came in, then
  // pull each one towards the middle of its neighbours in the tier above.
  const above = new Map<string, string[]>();
  for (const e of edges) {
    const ts = tier.get(e.source);
    const tt = tier.get(e.target);
    if (ts === undefined || tt === undefined) continue;
    if (ts < tt) above.set(e.target, [...(above.get(e.target) ?? []), e.source]);
    else if (tt < ts) above.set(e.source, [...(above.get(e.source) ?? []), e.target]);
  }

  const indexOf = new Map<string, number>();
  const reindex = () => {
    for (const t of tiers) {
      (byTier.get(t) ?? []).forEach((n, i) => indexOf.set(n.id, i));
    }
  };
  reindex();
  for (let sweep = 0; sweep < 2; sweep += 1) {
    for (const t of tiers) {
      const row = byTier.get(t);
      if (!row || row.length < 2) continue;
      const key = new Map<string, number>();
      row.forEach((n, i) => {
        const parents = (above.get(n.id) ?? [])
          .map((p) => indexOf.get(p))
          .filter((v): v is number => v !== undefined);
        // A node with nothing above it keeps its place rather than being
        // swept to one end.
        key.set(n.id, median(parents) ?? i);
      });
      row.sort((a, b) => (key.get(a.id) ?? 0) - (key.get(b.id) ?? 0));
      reindex();
    }
  }

  // Place. Each tier is centred on the widest one, so the shape reads as a
  // tree rather than as a left-aligned list.
  const widthOf = (row: HierarchyNode[]) =>
    row.reduce((w, n, i) => w + (i ? columnGap : 0) + n.width, 0);
  const widest = Math.max(...tiers.map((t) => widthOf(byTier.get(t) ?? [])));

  let locked = 0;
  let y = originY;
  for (const t of tiers) {
    const row = byTier.get(t) ?? [];
    const tall = row.reduce((h, n) => Math.max(h, n.height), 0);
    let x = originX + (widest - widthOf(row)) / 2;
    for (const n of row) {
      if (n.locked) locked += 1;
      else moved.set(n.id, { x: Math.round(x), y: Math.round(y + (tall - n.height) / 2) });
      x += n.width + columnGap;
    }
    y += tall + rowGap;
  }
  return { moved, tiers: tiers.length, locked };
}
