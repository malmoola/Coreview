import { useState } from 'react';
import { useStore } from '../state/store';
import { isDesktop } from '../lib/ipc';
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

      <IconLibrarySection query={q} onDrag={drag} />

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

/** SVGs indexed from a folder the operator chose. The artwork never ships with
 *  the app; this only reads what is already on their disk. */
function IconLibrarySection({
  query,
  onDrag,
}: {
  query: string;
  onDrag: (e: React.DragEvent, payload: string) => void;
}) {
  const icons = useStore((s) => s.iconLibrary);
  const dir = useStore((s) => s.iconLibraryDir);
  const error = useStore((s) => s.iconLibraryError);
  const load = useStore((s) => s.loadIconLibrary);
  const [path, setPath] = useState('');

  const shown = icons.filter(
    (i) =>
      !query ||
      i.name.toLowerCase().includes(query) ||
      i.id.includes(query) ||
      i.category.toLowerCase().includes(query),
  );

  return (
    <div className="lt-palette-group">
      <h3>Icon library</h3>

      {!dir && (
        <div className="lt-palette-note">
          <p className="lt-muted">
            Point LiveTopo at a folder of SVGs to use your own device icons. Nothing is
            copied into the app.
          </p>
          <input
            className="lt-input"
            placeholder="/path/to/icons"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            spellCheck={false}
          />
          <button
            type="button"
            className="lt-btn"
            disabled={!isDesktop || !path.trim()}
            onClick={() => load(path.trim())}
          >
            {isDesktop ? 'Load folder' : 'Desktop app only'}
          </button>
        </div>
      )}

      {dir && (
        <p className="lt-muted lt-palette-note">
          {icons.length} icons from <span className="lt-mono">{dir}</span>{' '}
          <button type="button" className="lt-link" onClick={() => load(dir)}>
            reload
          </button>
        </p>
      )}

      {error && <p className="lt-warn lt-palette-note">{error}</p>}

      {shown.length > 0 && (
        <div className="lt-palette-grid">
          {shown.slice(0, 400).map((icon) => (
            <button
              key={icon.id}
              type="button"
              className="lt-palette-item"
              draggable
              onDragStart={(e) => onDrag(e, `icon:${icon.id}`)}
              title={`${icon.name} — ${icon.category}`}
            >
              <img
                className="lt-palette-icon"
                alt=""
                src={`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(icon.svg)))}`}
              />
              {icon.name}
            </button>
          ))}
        </div>
      )}

      {dir && shown.length === 0 && (
        <p className="lt-muted lt-palette-note">No icon matches that search.</p>
      )}
    </div>
  );
}
