import { useState } from 'react';
import { DEVICE_LABEL, ICONS, PALETTE_GROUPS } from './icons';
import type { DeviceType } from '../types/domain';

export function Palette() {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const drag = (e: React.DragEvent, payload: string) => {
    e.dataTransfer.setData('application/livetopo', payload);
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <aside className="lt-palette" aria-label="Device palette">
      <input
        className="lt-input lt-palette-search"
        placeholder="Search shapes"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="lt-palette-group">
        <h3>Annotation</h3>
        <div className="lt-palette-grid">
          <button type="button" className="lt-palette-item" draggable onDragStart={(e) => drag(e, 'note')}>
            <span className="lt-palette-glyph">▤</span>
            Note
          </button>
          <button
            type="button"
            className="lt-palette-item"
            draggable
            onDragStart={(e) => drag(e, 'change-note')}
          >
            <span className="lt-palette-glyph">✎</span>
            Change note
          </button>
        </div>
      </div>

      {PALETTE_GROUPS.map((group) => {
        const items = group.items.filter(
          (t) => !q || DEVICE_LABEL[t].toLowerCase().includes(q) || t.includes(q),
        );
        if (items.length === 0) return null;
        return (
          <div className="lt-palette-group" key={group.title}>
            <h3>{group.title}</h3>
            <div className="lt-palette-grid">
              {items.map((type) => {
                const Icon = ICONS[type as DeviceType];
                return (
                  <button
                    key={type}
                    type="button"
                    className="lt-palette-item"
                    draggable
                    onDragStart={(e) => drag(e, type)}
                    title={`Drag ${DEVICE_LABEL[type]} on to the canvas`}
                  >
                    <Icon className="lt-palette-icon" />
                    {DEVICE_LABEL[type]}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <p className="lt-palette-hint">Drag an item on to the canvas to place it.</p>
    </aside>
  );
}
