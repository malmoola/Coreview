import { useEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Where it can actually be drawn. A menu opened near the bottom of the
  // window used to run off the edge, and the items past the edge were simply
  // unreachable — which is worst for the longest menus, the ones most likely
  // to have the item being looked for.
  const [at, setAt] = useState({ x, y });

  useEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const margin = 8;
    // Lifted rather than flipped: a menu that jumps above the pointer puts a
    // different item under the cursor than the one that was there a moment
    // ago, which is how people click the wrong thing.
    const nextY = Math.max(margin, Math.min(y, window.innerHeight - box.height - margin));
    const nextX = Math.max(margin, Math.min(x, window.innerWidth - box.width - margin));
    if (nextX !== at.x || nextY !== at.y) setAt({ x: nextX, y: nextY });
  }, [x, y, at.x, at.y]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    ref.current?.querySelector('button')?.focus();
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  return (
    <div className="cv-menu" style={{ left: at.x, top: at.y }} ref={ref} role="menu">
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger ? 'is-danger' : ''}
          disabled={item.disabled}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
