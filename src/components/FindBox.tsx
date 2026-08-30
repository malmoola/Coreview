/**
 * Find a device on a diagram too big to scan by eye.
 *
 * A crawl of a real estate produces hundreds of nodes. Once that has happened,
 * the question stops being "what is here" and becomes "where is this one" —
 * and panning around looking for a label is not an answer.
 *
 * Searching moves the view and selects; it never changes the diagram.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';

import { findNodes, type Match } from '../lib/findNodes';
import { useStore } from '../state/store';

const WHERE: Record<Match['matchedOn'], string> = {
  name: 'name',
  address: 'address',
  model: 'model',
  tag: 'tag',
  note: 'note',
};

export function FindBox({ onClose }: { onClose: () => void }) {
  const rf = useReactFlow();
  const nodes = useStore((s) => s.doc.nodes);
  const select = useStore((s) => s.select);
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => findNodes(nodes, query), [nodes, query]);

  useEffect(() => inputRef.current?.focus(), []);
  // A new search starts at the top; keeping the old index would land the
  // operator on whatever happened to be third in an unrelated list.
  useEffect(() => setAt(0), [query]);

  const jump = (index: number) => {
    const match = matches[index];
    if (!match) return;
    const node = nodes.find((n) => n.id === match.id);
    if (!node) return;
    // The node's own centre, not its corner: a wide card jumped to by corner
    // sits off to one side and reads as the wrong device being highlighted.
    const x = node.position.x + (node.width ?? node.measured?.width ?? 120) / 2;
    const y = node.position.y + (node.height ?? node.measured?.height ?? 60) / 2;
    // Zoom is left alone deliberately. Someone who has zoomed out to see the
    // shape of a site does not want a search to throw them back in.
    rf.setCenter(x, y, { duration: 320, zoom: rf.getZoom() });
    select(match.id, null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(at + 1, matches.length - 1);
      setAt(next);
      jump(next);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.max(at - 1, 0);
      setAt(next);
      jump(next);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      jump(at);
      // Enter means "that one" — the box has done its job and the diagram
      // should not stay covered by it.
      if (matches.length > 0) onClose();
    }
  };

  return (
    <div className="cv-find" role="search">
      <input
        ref={inputRef}
        type="text"
        className="cv-find-input"
        placeholder="Find a device by name, address, model, tag or note"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Find a device"
      />
      {query.trim() !== '' && (
        <div className="cv-find-results" role="listbox">
          {matches.length === 0 ? (
            <div className="cv-find-empty">Nothing matches “{query.trim()}”.</div>
          ) : (
            matches.map((m, i) => (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={i === at}
                className={i === at ? 'is-at' : ''}
                onClick={() => {
                  setAt(i);
                  jump(i);
                  onClose();
                }}
              >
                <span className="cv-find-label">{m.label}</span>
                <span className="cv-find-where">
                  {m.matchedOn === 'name' ? m.detail : `${WHERE[m.matchedOn]}: ${m.detail}`}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
