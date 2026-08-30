import { memo } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';

import { useStore } from '../../state/store';
import { canvasPalette } from '../../theme';
import type { NoteNodeData } from '../../types/domain';

/** Very small Markdown subset: headings, bullets, checkboxes, bold, code. */
function renderBody(body: string) {
  return body.split('\n').map((line, i) => {
    const key = `${i}-${line.slice(0, 12)}`;
    if (line.startsWith('## ')) return <h4 key={key}>{line.slice(3)}</h4>;
    if (line.startsWith('# ')) return <h3 key={key}>{line.slice(2)}</h3>;
    const check = /^- \[( |x|X)\] (.*)$/.exec(line);
    if (check) {
      return (
        <label key={key} className="cv-note-check">
          <input type="checkbox" checked={check[1] !== ' '} readOnly tabIndex={-1} />
          <span>{inline(check[2] ?? '')}</span>
        </label>
      );
    }
    if (line.startsWith('- ')) return <li key={key}>{inline(line.slice(2))}</li>;
    if (line.trim() === '') return <br key={key} />;
    return <p key={key}>{inline(line)}</p>;
  });
}

function inline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
    return <span key={i}>{p}</span>;
  });
}

function NoteNodeInner({ data, selected }: NodeProps) {
  const d = data as NoteNodeData;
  const reduceMotion = useStore((s) => s.settings.reduceMotion);
  const ground = useStore((s) => s.settings.ground);
  return (
    <div
      className={`cv-note ${d.variant === 'change' ? 'is-change' : ''} ${selected ? 'is-selected' : ''}`}
      style={{
        background: d.background,
        color: d.textColor,
        borderColor: selected ? canvasPalette(ground).selection : d.borderColor,
        fontSize: d.fontSize,
        transition: reduceMotion ? 'none' : undefined,
      }}
    >
      <NodeResizer
        isVisible={Boolean(selected) && !d.locked}
        minWidth={140}
        minHeight={80}
        lineClassName="cv-resize-line"
        handleClassName="cv-resize-handle"
      />
      {d.locked && <span className="cv-lock" title="Locked">🔒</span>}
      {d.title && <div className="cv-note-title">{d.title}</div>}
      <div className="cv-note-body">{renderBody(d.body)}</div>
    </div>
  );
}

export const NoteNode = memo(NoteNodeInner);
