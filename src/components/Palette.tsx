import { useMemo, useState } from 'react';
import { deviceColor } from '../theme';
import { Layers } from './Layers';
import { useStore } from '../state/store';
import { isDesktop } from '../lib/ipc';
import { DEVICE_LABEL, ICONS, PALETTE_GROUPS } from './icons';
import type { DeviceType } from '../types/domain';

export function Palette() {
  const ground = useStore((s) => s.settings.ground);
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

      {/* Above the shapes: which views are on decides what the whole canvas
          is showing, so it should not be at the bottom of a long list of
          icons. */}
      <Layers />

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

      <CustomShapesSection query={q} onDrag={drag} />

      <BundledShapesSection query={q} onDrag={drag} />

      <StencilPacksSection />

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
                    <Icon
                      className="cv-palette-icon"
                      /* The same colour it will be on the canvas, so the
                         palette is a preview rather than a list of grey
                         outlines that turn out different when dropped. */
                      style={{ color: deviceColor(type, 'unknown', ground) }}
                    />
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

/** Shapes captured from a device already on the canvas (LT-104) — kept with
 *  this project, not a shared library, so they drag onto the canvas again
 *  the same way any other shape does. Removing one is a normal undoable
 *  edit, unlike a stencil pack's permanent disk deletion: nothing left this
 *  machine, so there is nothing here a confirm modal needs to guard. */
function CustomShapesSection({
  query,
  onDrag,
}: {
  query: string;
  onDrag: (e: React.DragEvent, payload: string) => void;
}) {
  // Read the possibly-undefined field itself, not `?? []` inline: that
  // fallback would build a new array every time Zustand's snapshot check
  // calls this selector, which it does more than once per render — a
  // reference that never compares equal to itself is exactly what sent the
  // palette into the infinite-update loop this comment now warns about.
  const rawShapes = useStore((s) => s.doc.customShapes);
  const removeShape = useStore((s) => s.removeCustomShape);
  const shapes = rawShapes ?? [];
  const shown = shapes.filter((s) => !query || s.name.toLowerCase().includes(query));
  if (shapes.length === 0) return null;
  return (
    <div className="cv-palette-group">
      <h3>Your shapes</h3>
      <div className="cv-palette-grid">
        {shown.map((shape) => (
          <div key={shape.id} className="cv-palette-item-wrap">
            <button
              type="button"
              className="cv-palette-item"
              draggable
              onDragStart={(e) => onDrag(e, `icon:${shape.id}`)}
              title={`Drag ${shape.name} on to the canvas`}
            >
              <img
                className="cv-palette-icon"
                alt=""
                src={`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(shape.svg)))}`}
              />
              {shape.name}
            </button>
            <button
              type="button"
              className="cv-palette-item-remove"
              title={`Remove ${shape.name} from this project's shapes`}
              aria-label={`Remove ${shape.name}`}
              onClick={() => removeShape(shape.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {shown.length === 0 && <p className="cv-muted cv-palette-note">No shape matches that search.</p>}
    </div>
  );
}

/** The shapes that ship inside the installer (D-022): the converted vendor
 *  stencils, bundled as a resource and always in the palette. Absent in the
 *  browser build, where there is no resource to read. */
function BundledShapesSection({
  query,
  onDrag,
}: {
  query: string;
  onDrag: (e: React.DragEvent, payload: string) => void;
}) {
  const icons = useStore((s) => s.bundledIcons);
  const shown = icons.filter(
    (i) =>
      !query ||
      i.name.toLowerCase().includes(query) ||
      i.id.includes(query) ||
      i.category.toLowerCase().includes(query),
  );
  const grouped = useMemo(() => {
    const by = new Map<string, typeof shown>();
    for (const icon of shown) {
      const list = by.get(icon.category);
      if (list) list.push(icon);
      else by.set(icon.category, [icon]);
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [shown]);
  if (icons.length === 0) return null;
  return (
    <div className="cv-palette-group">
      {/* LT-066: the whole built-in library behind one collapsed header —
          hundreds of shapes across nine categories were taking the panel.
          Open only while searching, and the categories nest one level in. */}
      <details open={Boolean(query)}>
        <summary className="cv-palette-lib">
          Shape library <span className="cv-palette-count">{icons.length}</span>
        </summary>
        {grouped.map(([category, items]) => (
          <details key={category} className="cv-palette-nested" open={Boolean(query)}>
            <summary className="cv-palette-sub">
              {category} <span className="cv-palette-count">{items.length}</span>
            </summary>
            <div className="cv-palette-grid">
              {items.slice(0, 400).map((icon) => (
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
          </details>
        ))}
      </details>
    </div>
  );
}

/** Removing a bundled stencil pack (LT-103) — Cisco today — frees the space
 *  it takes on disk. Permanent: reinstalling the app is what brings it back,
 *  the same trade as LT-100's by-hand removal of the Tripp Lite pack, now a
 *  button instead of something only done in the repo. */
function StencilPacksSection() {
  const packs = useStore((s) => s.stencilPacks);
  const removePack = useStore((s) => s.removeStencilPack);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (packs.length === 0) return null;

  return (
    <div className="cv-palette-group">
      <details className="cv-layers">
        <summary className="cv-palette-sub">
          Built-in stencil packs <span className="cv-palette-count">{packs.length}</span>
        </summary>
        <div className="cv-layers-list">
          {packs.map((p) => (
            <div key={p.name} className="cv-layer">
              <span className="cv-layer-name">{p.name}</span>
              <button
                type="button"
                className="cv-layer-remove"
                title={`Remove the ${p.name} pack — permanent, frees the space it uses`}
                aria-label={`Remove the ${p.name} pack`}
                onClick={() => setConfirming(p.name)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </details>

      {confirming && (
        <div className="cv-modal-backdrop" role="presentation">
          <div className="cv-modal" role="dialog" aria-label="Confirm remove">
            <h2>Remove the “{confirming}” stencil pack?</h2>
            <p>
              Its shapes disappear from the palette, and its files are deleted to free the
              space where the app is installed somewhere it can write. Reinstalling the app is
              the only way to bring it back.
            </p>
            {problem && <p className="cv-warn">{problem}</p>}
            <div className="cv-modal-actions">
              <button type="button" className="cv-btn" onClick={() => setConfirming(null)} disabled={busy}>
                Keep it
              </button>
              <button
                type="button"
                className="cv-btn is-danger"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setProblem(null);
                  void removePack(confirming)
                    .then(() => setConfirming(null))
                    // Swallowing this is what made the button look dead: a
                    // read-only install refuses the delete, the dialog closed,
                    // and nothing appeared to happen. Whatever went wrong, the
                    // person who pressed it is the one who needs to know.
                    .catch((e: unknown) =>
                      setProblem(e instanceof Error ? e.message : String(e)),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                {busy ? 'Removing…' : 'Remove permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** SVGs indexed from a folder the operator chose; loading it is optional now
 *  that a library ships built-in, and nothing is copied into the app. */
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
  const clear = useStore((s) => s.clearIconLibrary);
  const [path, setPath] = useState('');

  const shown = icons.filter(
    (i) =>
      !query ||
      i.name.toLowerCase().includes(query) ||
      i.id.includes(query) ||
      i.category.toLowerCase().includes(query),
  );

  const grouped = useMemo(() => {
    const by = new Map<string, typeof shown>();
    for (const icon of shown) {
      const list = by.get(icon.category);
      if (list) list.push(icon);
      else by.set(icon.category, [icon]);
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [shown]);

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
          </button>{' '}
          <button type="button" className="cv-link" onClick={() => void clear()}>
            clear
          </button>
        </p>
      )}

      {error && <p className="cv-warn cv-palette-note">{error}</p>}

      {/* Grouped, because a real shape library is hundreds of icons and one
          alphabetical list of them is not something anyone finds anything in.
          A group is collapsed until it is opened, so the whole set does not
          have to be scrolled past to reach the built-in shapes. */}
      {grouped.map(([category, items], index) => (
        <details key={category} open={grouped.length === 1 || index === 0 || Boolean(query)}>
          <summary className="cv-palette-sub">
            {category} <span className="cv-palette-count">{items.length}</span>
          </summary>
          <div className="cv-palette-grid">
            {items.slice(0, 400).map((icon) => (
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
        </details>
      ))}

      {dir && shown.length === 0 && (
        <p className="cv-muted cv-palette-note">No icon matches that search.</p>
      )}
    </div>
  );
}
