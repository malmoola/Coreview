/**
 * What changed between the diagram and what a crawl just found.
 *
 * Re-running discovery already merges into the diagram. Merging silently is
 * fine when nothing moved and wrong when something did: a switch that has
 * disappeared, a link that now lands on a different port, a device nobody
 * expected — those are the findings, and applying them without saying so
 * turns a change-detection tool back into a drawing tool.
 *
 * Nothing here changes anything. It reports, and the operator decides.
 */
import type { CrawledDevice, Neighbor } from './ipc';
import type { DeviceNodeData, LinkData } from '../types/domain';
import type { TopoEdge, TopoNode } from '../state/store';
import { identity, shortInterface } from './topology';

export interface TopologyChange {
  /** On the diagram, not found by this crawl. */
  missing: { id: string; label: string; address: string }[];
  /** Found by this crawl, not on the diagram. */
  added: { key: string; label: string; address: string }[];
  /** On both, but something the crawl can see is different. */
  changed: { id: string; label: string; was: string; now: string }[];
  /** A link on the diagram that this crawl did not see. */
  linksGone: { id: string; description: string }[];
  /** A link the crawl saw that is not drawn. */
  linksNew: { description: string }[];
}

const addressOf = (n: TopoNode): string => {
  const d = n.data as DeviceNodeData;
  return d.addresses?.find((a) => a.isPrimary)?.address ?? d.addresses?.[0]?.address ?? '';
};

/** Every device a crawl saw, reached or merely reported by a neighbour. */
function seenByCrawl(devices: CrawledDevice[], notVisited: Neighbor[]) {
  const seen = new Map<string, { label: string; address: string; platform: string | null }>();
  for (const d of devices) {
    seen.set(identity(d.hostname, d.address), {
      label: d.hostname || d.address,
      address: d.probeTarget || d.address,
      platform: d.platform,
    });
  }
  const note = (n: Neighbor) => {
    const key = identity(n.shortName || n.deviceId, n.addresses[0]?.ip ?? '');
    if (!seen.has(key)) {
      seen.set(key, {
        label: n.shortName || n.deviceId,
        address: n.addresses[0]?.ip ?? '',
        platform: n.platform,
      });
    }
  };
  for (const d of devices) for (const n of d.neighbors) note(n);
  for (const n of notVisited) note(n);
  return seen;
}

/** A link, written the way both sides can be compared. */
function linkKeyOf(a: string, aIf: string, b: string, bIf: string): string {
  return [`${a}/${shortInterface(aIf)}`, `${b}/${shortInterface(bIf)}`].sort().join('::');
}

export function diffTopology(
  nodes: TopoNode[],
  edges: TopoEdge[],
  crawl: { devices: CrawledDevice[]; notVisited: Neighbor[] },
): TopologyChange {
  const seen = seenByCrawl(crawl.devices, crawl.notVisited);

  const drawn = new Map<string, TopoNode>();
  for (const n of nodes) {
    if (n.type !== 'device') continue;
    drawn.set(identity((n.data as DeviceNodeData).label ?? '', addressOf(n)), n);
  }

  const missing: TopologyChange['missing'] = [];
  const changed: TopologyChange['changed'] = [];
  for (const [key, node] of drawn) {
    const found = seen.get(key);
    const d = node.data as DeviceNodeData;
    if (!found) {
      // Only devices a crawl could plausibly have found. Something drawn by
      // hand with no address was never going to appear, and reporting it as
      // missing every time would train people to ignore the list.
      if (addressOf(node)) missing.push({ id: node.id, label: d.label, address: addressOf(node) });
      continue;
    }
    if (found.address && addressOf(node) && found.address !== addressOf(node)) {
      changed.push({
        id: node.id,
        label: d.label,
        was: addressOf(node),
        now: found.address,
      });
    }
  }

  const added: TopologyChange['added'] = [];
  for (const [key, found] of seen) {
    if (!drawn.has(key)) added.push({ key, label: found.label, address: found.address });
  }

  // Links, by both endpoints and both ports.
  const idOfNode = new Map(nodes.map((n) => [n.id, n]));
  const drawnLinks = new Map<string, TopoEdge>();
  for (const e of edges) {
    const a = idOfNode.get(e.source);
    const b = idOfNode.get(e.target);
    if (!a || !b) continue;
    const data = (e.data ?? {}) as LinkData;
    drawnLinks.set(
      linkKeyOf(
        identity((a.data as DeviceNodeData).label ?? '', addressOf(a)),
        data.sourcePortLabel ?? '',
        identity((b.data as DeviceNodeData).label ?? '', addressOf(b)),
        data.targetPortLabel ?? '',
      ),
      e,
    );
  }

  const crawlLinks = new Map<string, string>();
  for (const d of crawl.devices) {
    const from = identity(d.hostname, d.address);
    for (const n of d.neighbors) {
      const to = identity(n.shortName || n.deviceId, n.addresses[0]?.ip ?? '');
      if (to === from) continue;
      const key = linkKeyOf(from, n.localInterface ?? '', to, n.remoteInterface ?? '');
      crawlLinks.set(
        key,
        `${d.hostname} ${shortInterface(n.localInterface ?? '?')} — ${
          n.shortName || n.deviceId
        } ${shortInterface(n.remoteInterface ?? '?')}`,
      );
    }
  }

  const linksGone: TopologyChange['linksGone'] = [];
  for (const [key, edge] of drawnLinks) {
    if (crawlLinks.has(key)) continue;
    const a = idOfNode.get(edge.source);
    const b = idOfNode.get(edge.target);
    const data = (edge.data ?? {}) as LinkData;
    linksGone.push({
      id: edge.id,
      description: `${(a?.data as DeviceNodeData)?.label ?? '?'} ${
        data.sourcePortLabel || '?'
      } — ${(b?.data as DeviceNodeData)?.label ?? '?'} ${data.targetPortLabel || '?'}`,
    });
  }

  const linksNew = [...crawlLinks.entries()]
    .filter(([key]) => !drawnLinks.has(key))
    .map(([, description]) => ({ description }));

  return { missing, added, changed, linksGone, linksNew };
}

/** Whether anything at all is different. */
export function hasChanges(c: TopologyChange): boolean {
  return (
    c.missing.length + c.added.length + c.changed.length + c.linksGone.length + c.linksNew.length >
    0
  );
}
