/**
 * What a re-crawl found that the diagram does not say.
 *
 * Discovery already merges into an existing diagram, which is right — nobody
 * wants a second copy of the network drawn beside the first. But merging
 * silently is only right when nothing moved. A switch that has disappeared, a
 * link that now lands on a different port, a device nobody expected: those are
 * findings, and folding them in without a word turns change detection back
 * into drawing.
 *
 * This reports. Drawing stays the operator's decision.
 */
import { useMemo } from 'react';
import { useReactFlow } from '@xyflow/react';

import { diffTopology, hasChanges } from '../lib/topologyDiff';
import type { CrawledDevice, Neighbor } from '../lib/ipc';
import { useStore } from '../state/store';

function Group({
  title,
  hint,
  items,
  onShow,
}: {
  title: string;
  hint: string;
  items: { key: string; text: string; nodeId?: string; edgeId?: string }[];
  onShow?: (item: { nodeId?: string; edgeId?: string }) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="cv-change-group">
      <h4>
        {title} <span className="cv-change-count">{items.length}</span>
      </h4>
      <p className="cv-help">{hint}</p>
      <ul>
        {items.map((i) => (
          <li key={i.key}>
            {/* Findable, not just listed. "OLD-SW is gone" is only useful if
                you can see which box on the diagram that is — and a report
                that cannot be acted on is a report nobody reads twice. */}
            {onShow && (i.nodeId || i.edgeId) ? (
              <button type="button" className="cv-change-show" onClick={() => onShow(i)}>
                {i.text}
              </button>
            ) : (
              i.text
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChangeReport({
  result,
}: {
  result: { devices: CrawledDevice[]; notVisited: Neighbor[] };
}) {
  const nodes = useStore((s) => s.doc.nodes);
  const edges = useStore((s) => s.doc.edges);

  const rf = useReactFlow();
  const select = useStore((s) => s.select);

  /** Put the thing this line is about in front of the reader. */
  const show = ({ nodeId, edgeId }: { nodeId?: string; edgeId?: string }) => {
    if (edgeId) {
      select(null, edgeId);
      return;
    }
    if (!nodeId) return;
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    rf.setCenter(
      node.position.x + (node.width ?? node.measured?.width ?? 120) / 2,
      node.position.y + (node.height ?? node.measured?.height ?? 60) / 2,
      // The zoom is left alone: someone reading a list of changes has usually
      // set the view to see the shape of things.
      { duration: 320, zoom: rf.getZoom() },
    );
    select(nodeId, null);
  };

  const change = useMemo(
    () => diffTopology(nodes, edges, { devices: result.devices, notVisited: result.notVisited }),
    [nodes, edges, result],
  );

  // On an empty diagram everything is new, and saying so is noise: the whole
  // point of the first crawl is that none of it is there yet.
  const drawn = nodes.filter((n) => n.type === 'device').length;
  if (drawn === 0) return null;

  if (!hasChanges(change)) {
    return (
      <div className="cv-change">
        <h3>Nothing has changed</h3>
        <p className="cv-help">
          Every device and link on the diagram is still where this crawl found it.
        </p>
      </div>
    );
  }

  return (
    <div className="cv-change">
      <h3>What changed since the diagram was drawn</h3>
      <Group
        title="Gone"
        hint="On the diagram, not found by this crawl. Either it has been removed, or the crawl could not reach it."
        items={change.missing.map((m) => ({
          key: m.id,
          text: `${m.label} (${m.address})`,
          nodeId: m.id,
        }))}
        onShow={show}
      />
      <Group
        title="New"
        hint="Found by this crawl and not on the diagram."
        items={change.added.map((a) => ({
          key: a.key,
          text: a.address ? `${a.label} (${a.address})` : a.label,
        }))}
      />
      <Group
        title="Moved address"
        hint="Same device, different address to the one drawn."
        items={change.changed.map((c) => ({
          key: c.id,
          text: `${c.label}: ${c.was} → ${c.now}`,
          nodeId: c.id,
        }))}
        onShow={show}
      />
      <Group
        title="Links gone"
        hint="Drawn on the diagram, not seen by this crawl."
        items={change.linksGone.map((l) => ({ key: l.id, text: l.description, edgeId: l.id }))}
        onShow={show}
      />
      <Group
        title="Links new"
        hint="Seen by this crawl, not drawn. A link that is both gone and new is a cable that moved port."
        items={change.linksNew.map((l) => ({ key: l.description, text: l.description }))}
      />
    </div>
  );
}
