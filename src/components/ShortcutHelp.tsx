/**
 * What the keyboard does. Opened with "?", because a shortcut nobody can
 * discover is a shortcut nobody has.
 */
const GROUPS: [string, [string, string][]][] = [
  ['Getting around', [
    ['Space + drag', 'Move the whole diagram'],
    ['F', 'Fit the sheet in the window'],
    ['Ctrl+F', 'Find a device'],
    ['?', 'This list'],
  ]],
  ['Selecting', [
    ['Drag on empty canvas', 'Select what the box covers'],
    ['Ctrl+click', 'Add or remove one device'],
    ['Ctrl+A', 'Select everything'],
    ['Esc', 'Select nothing'],
  ]],
  ['Editing', [
    ['Arrows', 'Nudge the selection a pixel'],
    ['Shift+arrows', 'Nudge a grid step'],
    ['Alt while dragging', 'Refuse the snap'],
    ['Ctrl+D', 'Duplicate, one grid step over'],
    ['Ctrl+C / Ctrl+V', 'Copy and paste'],
    ['Delete', 'Remove the selection'],
    ['Ctrl+Z / Ctrl+Y', 'Undo and redo'],
  ]],
  ['Arranging', [
    ['Ctrl+Alt+L / C / R', 'Line up left edges, centres, right edges'],
    ['Ctrl+Alt+T / M / B', 'Line up tops, middles, bottoms'],
    ['Ctrl+Alt+H / V', 'Even the gaps, across or down'],
  ]],
  ['Writing', [
    ['Double-click a name', 'Rename it in place'],
    ['Double-click empty canvas', 'Write text there'],
  ]],
];

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="cv-help-scrim" onClick={onClose} role="presentation">
      <div
        className="cv-help-card"
        role="dialog"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cv-help-head">
          <h2>Keyboard</h2>
          <button type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="cv-help-cols">
          {GROUPS.map(([title, rows]) => (
            <section key={title}>
              <h3>{title}</h3>
              {rows.map(([keys, what]) => (
                <div key={keys} className="cv-help-row">
                  <kbd>{keys}</kbd>
                  <span>{what}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
