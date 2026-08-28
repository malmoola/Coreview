import { useState } from 'react';
import { useStore } from '../state/store';
import { isDesktop } from '../lib/ipc';
import { DEVICE_LABEL, ICONS, PALETTE_GROUPS } from './icons';
import type { DeviceType } from '../types/domain';

export function Palette() {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const drag = (e: React.DragEvent, payload: string) => {
    e.dataTransfer.setData('application/coreview', payload);
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <aside className="cv-palette" aria-label="Device palette">
      <input
        className="cv-input cv-palette-search"
        placeholder="Search shapes"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="cv-palette-group">
        <h3>Annotation</h3>
        <div className="cv-palette-grid">
          <button type="button" className="cv-palette-item" draggable onDragStart={(e) => drag(e, 'note')}>
            <span className="cv-palette-glyph">▤</span>
            Note
          </button>
          <button
            type="button"
            className="cv-palette-item"
            draggable
            onDragStart={(e) => drag(e, 'change-note')}
          >
            <span className="cv-palette-glyph">✎</span>
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
          <div className="cv-palette-group" key={group.title}>
            <h3>{group.title}</h3>
            <div className="cv-palette-grid">
              {items.map((type) => {
                const Icon = ICONS[type as DeviceType];
                return (
                  <button
                    key={type}
                    type="button"
                    className="cv-palette-item"
                    draggable
                    onDragStart={(e) => drag(e, type)}
                    title={`Drag ${DEVICE_LABEL[type]} on to the canvas`}
                  >
                    <Icon className="cv-palette-icon" />
                    {DEVICE_LABEL[type]}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <p className="cv-palette-hint">Drag an item on to the canvas to place it.</p>
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
    <div className="cv-palette-group">
      <h3>Icon library</h3>

      {!dir && (
        <div className="cv-palette-note">
          <p className="cv-muted">
            Point Coreview at a folder of SVGs to use your own device icons. Nothing is
            copied into the app.
          </p>
          <input
            className="cv-input"
            placeholder="/path/to/icons"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            spellCheck={false}
          />
          <button
            type="button"
            className="cv-btn"
            disabled={!isDesktop || !path.trim()}
            onClick={() => load(path.trim())}
          >
            {isDesktop ? 'Load folder' : 'Desktop app only'}
          </button>
        </div>
      )}

      {dir && (
        <p className="cv-muted cv-palette-note">
          {icons.length} icons from <span className="cv-mono">{dir}</span>{' '}
          <button type="button" className="cv-link" onClick={() => load(dir)}>
            reload
          </button>
        </p>
      )}

      {error && <p className="cv-warn cv-palette-note">{error}</p>}

      {shown.length > 0 && (
        <div className="cv-palette-grid">
          {shown.slice(0, 400).map((icon) => (
            <button
              key={icon.id}
              type="button"
              className="cv-palette-item"
              draggable
              onDragStart={(e) => onDrag(e, `icon:${icon.id}`)}
              title={`${icon.name} — ${icon.category}`}
            >
              <img
                className="cv-palette-icon"
                alt=""
                src={`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(icon.svg)))}`}
              />
              {icon.name}
            </button>
          ))}
        </div>
      )}

      {dir && shown.length === 0 && (
        <p className="cv-muted cv-palette-note">No icon matches that search.</p>
      )}
    </div>
  );
}
