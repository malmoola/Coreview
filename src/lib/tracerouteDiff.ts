import type { TracerouteHopDto } from './ipc';

/**
 * Which hop numbers answered from a different set of routers than the
 * previous run against the same target (LT-093) — proof a path actually
 * moved after a failover, rather than reading two hop lists side by side
 * by eye. `null` previous (no earlier run this session) changes nothing.
 *
 * A hop counts as changed whenever its set of routers differs at all: a
 * new router, a lost one, or a hop that used to time out now answering
 * (or vice versa) are all real differences worth a look, not just a
 * router-for-router swap.
 */
export function changedHops(
  previous: TracerouteHopDto[] | null,
  current: TracerouteHopDto[],
): Set<number> {
  const changed = new Set<number>();
  if (!previous) return changed;
  const prevByHop = new Map(previous.map((h) => [h.hop, hostSet(h)]));
  for (const hop of current) {
    const prevHosts = prevByHop.get(hop.hop);
    if (!prevHosts || !sameSet(prevHosts, hostSet(hop))) {
      changed.add(hop.hop);
    }
  }
  return changed;
}

function hostSet(hop: TracerouteHopDto): Set<string> {
  return new Set(hop.probes.map((p) => p.host).filter((h): h is string => h != null));
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}
