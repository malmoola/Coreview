/**
 * Pages (LT-094): more than one independent drawing in one project.
 *
 * A tab strip along the bottom of the canvas, the way Lucidchart does it —
 * each tab is a completely separate canvas, not a filter over a shared one
 * (that is what Views/Layers already does). Modelled on that panel's own
 * interaction vocabulary — an inline-editable name, a small remove
 * affordance, an add row — just laid out sideways instead of stacked.
 */
import { useState } from 'react';

import { useStore } from '../state/store';
import { ContextMenu, type MenuItem } from './ContextMenu';

export function PageTabs() {
  const doc = useStore((s) => s.doc);
  const addPage = useStore((s) => s.addPage);
  const removePage = useStore((s) => s.removePage);
  const renamePage = useStore((s) => s.renamePage);
  const duplicatePage = useStore((s) => s.duplicatePage);
  const reorderPages = useStore((s) => s.reorderPages);
  const setActivePage = useStore((s) => s.setActivePage);

  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  const menuItems = (id: string): MenuItem[] => [
    { label: 'Duplicate', onSelect: () => duplicatePage(id) },
    {
      label: 'Delete',
      danger: true,
      disabled: doc.pages.length <= 1,
      onSelect: () => removePage(id),
    },
  ];

  return (
    <div className="cv-page-tabs" role="tablist" aria-label="Pages">
      {doc.pages.map((p, i) => (
        <div
          key={p.id}
          className={`cv-page-tab${p.id === doc.activePageId ? ' is-active' : ''}`}
          role="tab"
          aria-selected={p.id === doc.activePageId}
          draggable
          onDragStart={() => setDragFrom(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (dragFrom !== null && dragFrom !== i) reorderPages(dragFrom, i);
            setDragFrom(null);
          }}
          onClick={() => setActivePage(p.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, id: p.id });
          }}
        >
          <input
            className="cv-page-tab-name"
            value={p.name}
            // Deliberately not stopped: a click here should also switch to
            // this tab, the same as clicking anywhere else on it — that is
            // what a browser's own tab strip does, and there is nothing
            // switching pages would break here.
            onFocus={() => setActivePage(p.id)}
            onChange={(e) => renamePage(p.id, e.target.value)}
            // A blank name is refused by the store; this puts it back to
            // what it was rather than leaving an empty box on screen.
            onBlur={(e) => {
              if (!e.target.value.trim()) e.target.value = p.name;
            }}
          />
        </div>
      ))}
      <button
        type="button"
        className="cv-page-tab-add"
        title="Add a page"
        aria-label="Add a page"
        onClick={() => addPage('Page')}
      >
        +
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.id)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
