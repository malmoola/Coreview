/**
 * The views a document is drawn in.
 *
 * A network is documented more than once: the physical layer says which cable
 * is in which socket, the logical one says which VLAN reaches which building,
 * a third says what the change on Saturday will do. Keeping them as three
 * files means three files that disagree within a fortnight.
 */
import { useState } from 'react';

import { useStore } from '../state/store';
import { layersOf } from '../lib/layers';

export function Layers() {
  const canvas = useStore((s) => s.doc.canvas);
  const setLayer = useStore((s) => s.setLayer);
  const addLayer = useStore((s) => s.addLayer);
  const removeLayer = useStore((s) => s.removeLayer);
  const [adding, setAdding] = useState('');

  const layers = layersOf(canvas.layers);
  const hidden = layers.filter((l) => !l.visible).length;
  // Open once if something is already hidden, then left to the reader. Driving
  // it from state means the panel snaps shut the moment the last hidden view
  // is shown again — usually mid-click, on the panel you are working in.
  const [open] = useState(hidden > 0);

  return (
    <details className="cv-layers" open={open || undefined}>
      <summary className="cv-palette-sub">
        Views <span className="cv-palette-count">{layers.length}</span>
        {hidden > 0 && <span className="cv-layers-hidden">{hidden} hidden</span>}
      </summary>

      <div className="cv-layers-list">
        {layers.map((layer) => (
          <div key={layer.id} className="cv-layer">
            <button
              type="button"
              className={`cv-layer-eye${layer.visible ? '' : ' is-off'}`}
              title={layer.visible ? 'Hide this view' : 'Show this view'}
              aria-label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`}
              onClick={() => setLayer(layer.id, { visible: !layer.visible })}
            >
              {layer.visible ? '◉' : '○'}
            </button>
            <input
              className="cv-layer-name"
              value={layer.name}
              aria-label="View name"
              onChange={(e) => setLayer(layer.id, { name: e.target.value })}
            />
            <button
              type="button"
              className={`cv-layer-lock${layer.locked ? ' is-on' : ''}`}
              title={layer.locked ? 'Let this view be edited' : 'Lock this view'}
              aria-label={layer.locked ? `Unlock ${layer.name}` : `Lock ${layer.name}`}
              onClick={() => setLayer(layer.id, { locked: !layer.locked })}
            >
              {layer.locked ? '🔒' : '🔓'}
            </button>
            <button
              type="button"
              className="cv-layer-remove"
              title="Remove this view. What is on it stays on the diagram."
              aria-label={`Remove ${layer.name}`}
              onClick={() => removeLayer(layer.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="cv-row cv-row-tight cv-layers-add">
        <input
          className="cv-input"
          placeholder="Logical, Change 4821…"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            addLayer(adding);
            setAdding('');
          }}
        />
        <button
          type="button"
          className="cv-btn cv-btn-small"
          onClick={() => {
            addLayer(adding);
            setAdding('');
          }}
        >
          Add
        </button>
      </div>
      <p className="cv-help">
        Anything not put on a view appears on all of them, so a diagram drawn before you
        added one is unchanged.
      </p>
    </details>
  );
}
