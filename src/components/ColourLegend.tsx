/**
 * What the colours mean, when they mean something other than health.
 *
 * Colouring by subnet is only useful if you can tell which colour is which
 * subnet. Without a legend it is a pretty diagram that has stopped saying
 * anything — worse than the plain one it replaced.
 */
import { useMemo } from 'react';

import { useStore } from '../state/store';
import { legendFor, type ColourBy } from '../lib/tinting';

const WHAT: Record<ColourBy, string> = {
  health: 'Health',
  role: 'What it is',
  subnet: 'Subnet',
  tag: 'Tag',
  vlan: 'VLAN',
};

export function ColourLegend() {
  const nodes = useStore((s) => s.doc.nodes);
  const colourBy = useStore((s) => s.doc.canvas.colourBy ?? 'health');
  const ground = useStore((s) => s.settings.ground);
  const setCanvas = useStore((s) => s.setCanvas);

  const items = useMemo(
    () => legendFor(nodes, colourBy, ground),
    [nodes, colourBy, ground],
  );

  if (colourBy === 'health') return null;

  return (
    <div className="cv-legend" aria-label={`Colour by ${WHAT[colourBy]}`}>
      <div className="cv-legend-head">
        <span>{WHAT[colourBy]}</span>
        <button
          type="button"
          className="cv-legend-off"
          title="Go back to colouring by health"
          onClick={() => setCanvas({ colourBy: 'health' })}
        >
          ×
        </button>
      </div>
      {items.length === 0 ? (
        <p className="cv-help">
          Nothing on the diagram has {colourBy === 'subnet' ? 'an address' : 'a tag'} yet.
        </p>
      ) : (
        <div className="cv-legend-items">
          {items.slice(0, 24).map((i) => (
            <span key={i.key} className="cv-legend-item">
              <i style={{ background: i.colour }} />
              <span className="cv-legend-key">{i.key}</span>
              <span className="cv-legend-count">{i.count}</span>
            </span>
          ))}
          {items.length > 24 && (
            <span className="cv-help">and {items.length - 24} more</span>
          )}
        </div>
      )}
    </div>
  );
}
