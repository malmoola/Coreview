/**
 * Drawing the topology as an SVG, from the document model.
 *
 * The obvious implementation — serialise the live `.react-flow__viewport` —
 * produces a file that opens blank. React Flow lays nodes out as absolutely
 * positioned HTML `<div>`s inside that viewport; the only real SVG in there is
 * the edge layer. Wrapping HTML in an `<svg>` element and saving it yields a
 * document whose node markup no renderer will draw, and the failure is silent:
 * the file is valid SVG, the edges and title block appear, and every device is
 * missing.
 *
 * So the diagram is drawn here instead, from nodes, edges and statuses. That
 * costs a second implementation of the node's appearance, and buys three
 * things: the export works, it does not depend on what is currently mounted or
 * scrolled into view, and it is a pure function that can be tested without a
 * browser.
 */
import { getBezierPath, getSmoothStepPath, getStraightPath, Position } from '@xyflow/react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ICONS } from '../components/icons';
import { STATUS_COLOR } from '../components/edges/LiveEdge';
import type { TopoEdge, TopoNode } from '../state/store';
import type {
  DeviceNodeData,
  HealthStatus,
  LinkData,
  NoteNodeData,
  ProjectMeta,
} from '../types/domain';
import { STATUS_GLYPH, STATUS_LABEL } from '../types/domain';

/** Default node box, matching what the palette and samples create. */
const NODE_W = 176;
const NODE_H = 96;
const PAD = 48;
const HEADER_H = 86;
const SHAPE_TYPES = new Set(['rectangle', 'rounded', 'circle', 'diamond', 'cloud', 'text']);

export interface DiagramInput {
  meta: ProjectMeta;
  nodes: TopoNode[];
  edges: TopoEdge[];
  /** Status per node id. Resolved by the caller so this stays pure. */
  nodeStatus: (id: string) => HealthStatus;
  /** Status per edge id. */
  linkStatus: (id: string) => HealthStatus;
  includeTitleBlock: boolean;
  /** Mirrors the canvas setting, so the file matches the screen. */
  nodeStyle?: 'glyph' | 'card';
  /** Injected so the output is deterministic in tests. */
  now?: Date;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

/**
 * Cuts text to what fits in `width` pixels.
 *
 * SVG `<text>` neither wraps nor ellipsizes, so a long hostname would run
 * across the neighbouring device. Measuring properly needs a canvas and a
 * loaded font; the average advance of the UI face at these sizes is close
 * enough to 0.55em that a character count gets the same result without either.
 */
export function fit(text: string, width: number, fontSize: number): string {
  const max = Math.max(1, Math.floor(width / (fontSize * 0.55)));
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function sizeOf(n: TopoNode): { w: number; h: number } {
  const m = n as { width?: number; height?: number; measured?: { width?: number; height?: number } };
  return {
    w: m.width ?? m.measured?.width ?? NODE_W,
    h: m.height ?? m.measured?.height ?? NODE_H,
  };
}

/** Where a handle sits on a node, and which way an edge leaves it. */
function anchor(n: TopoNode, handle: string | null | undefined, fallback: Position) {
  const { w, h } = sizeOf(n);
  const { x, y } = n.position;
  const side =
    handle === 't' ? Position.Top
    : handle === 'b' ? Position.Bottom
    : handle === 'l' ? Position.Left
    : handle === 'r' ? Position.Right
    : fallback;
  switch (side) {
    case Position.Top: return { x: x + w / 2, y, side };
    case Position.Bottom: return { x: x + w / 2, y: y + h, side };
    case Position.Left: return { x, y: y + h / 2, side };
    default: return { x: x + w, y: y + h / 2, side };
  }
}

function pathFor(type: LinkData['pathType'], p: Parameters<typeof getBezierPath>[0]) {
  switch (type) {
    case 'straight':
      return getStraightPath({ sourceX: p.sourceX, sourceY: p.sourceY, targetX: p.targetX, targetY: p.targetY });
    case 'step':
      return getSmoothStepPath({ ...p, borderRadius: 0 });
    case 'smoothstep':
      return getSmoothStepPath({ ...p, borderRadius: 12 });
    default:
      return getBezierPath(p);
  }
}

/** The device glyph, as markup, tinted and placed. */
function iconMarkup(type: DeviceNodeData['deviceType'], color: string, x: number, y: number, size: number): string {
  const Icon = ICONS[type] ?? ICONS.generic;
  const raw = renderToStaticMarkup(Icon({}));
  // The glyphs are authored on a 24x24 grid with stroke="currentColor"; a
  // nested <svg> scales one without touching its paths.
  return raw
    .replace('<svg ', `<svg x="${x}" y="${y}" width="${size}" height="${size}" `)
    .replaceAll('currentColor', color);
}

function nodeMarkup(n: TopoNode, status: HealthStatus, nodeStyle: 'glyph' | 'card'): string {
  const { w, h } = sizeOf(n);
  const { x, y } = n.position;

  if (n.type === 'note') {
    const d = n.data as NoteNodeData;
    const fs = d.fontSize || 12;
    const lines = [d.title ? `**${d.title}**` : null, ...d.body.split('\n')]
      .filter((l): l is string => l !== null)
      .slice(0, Math.max(1, Math.floor((h - 18) / (fs * 1.5))));
    const body = lines
      .map((line, i) => {
        const bold = line.startsWith('**') || line.startsWith('#');
        const text = line.replace(/^#{1,2}\s*/, '').replace(/\*\*/g, '').replace(/^- \[[ xX]\] /, '☐ ').replace(/^- /, '• ');
        return `<text x="${x + 11}" y="${y + 18 + i * fs * 1.5}" fill="${esc(d.textColor)}" font-size="${fs}"${bold ? ' font-weight="700"' : ''}>${esc(fit(text, w - 22, fs))}</text>`;
      })
      .join('');
    return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${esc(d.background)}" stroke="${esc(d.borderColor)}" stroke-width="1.5"/>${body}</g>`;
  }

  const d = n.data as DeviceNodeData;
  const color = STATUS_COLOR[status];
  const border = d.style?.border ?? color;
  const bg = d.style?.background ?? '#111823';
  const isShape = SHAPE_TYPES.has(d.deviceType);
  const isText = d.deviceType === 'text';
  const primary =
    d.addresses?.find((a) => a.isPrimary)?.address ?? d.addresses?.[0]?.address ?? '';

  // The glyph presentation: symbol on top, name beneath, no box. Mirrors
  // DeviceNode so the exported diagram is the one on screen.
  if (nodeStyle === 'glyph' && !isShape && !isText) {
    const size = 46;
    const cx = x + w / 2;
    const iconY = y + 4;
    const parts: string[] = [
      d.imageDataUrl
        ? `<image x="${cx - size / 2}" y="${iconY}" width="${size}" height="${size}" href="${esc(d.imageDataUrl)}" preserveAspectRatio="xMidYMid meet"/>`
        : iconMarkup(d.deviceType, d.style?.iconColor ?? color, cx - size / 2, iconY, size),
      `<g><circle cx="${cx + size / 2 - 2}" cy="${iconY + 4}" r="7.5" fill="${color}" stroke="#0a0e13" stroke-width="2"/>` +
        `<text x="${cx + size / 2 - 2}" y="${iconY + 7.5}" text-anchor="middle" fill="#07110c" font-size="9" font-weight="700">${esc(STATUS_GLYPH[status])}</text></g>`,
    ];

    let ty = iconY + size + 14;
    // Text may be wider than the node box, exactly as on screen.
    const textW = Math.max(w, 170);
    parts.push(
      `<text x="${cx}" y="${ty}" text-anchor="middle" fill="#e6eef7" font-size="12" font-weight="600">${esc(fit(d.label, textW, 12))}</text>`,
    );
    if (d.showDetails) {
      if (primary) {
        ty += 13;
        parts.push(
          `<text x="${cx}" y="${ty}" text-anchor="middle" fill="#8ea2b5" font-size="10" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${esc(fit(primary, textW, 10))}</text>`,
        );
      }
      ty += 13;
      parts.push(
        `<text x="${cx}" y="${ty}" text-anchor="middle" fill="${color}" font-size="10" font-weight="600">${esc(STATUS_LABEL[status])}</text>`,
      );
      if (d.maintenance) {
        ty += 13;
        parts.push(
          `<text x="${cx}" y="${ty}" text-anchor="middle" fill="#8b7ff0" font-size="10">In maintenance</text>`,
        );
      }
    }
    return `<g>${parts.join('')}</g>`;
  }

  let box: string;
  if (d.deviceType === 'circle') {
    box = `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${esc(bg)}" stroke="${esc(border)}" stroke-width="1.5"/>`;
  } else if (d.deviceType === 'diamond') {
    const pts = `${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`;
    box = `<polygon points="${pts}" fill="${esc(bg)}" stroke="${esc(border)}" stroke-width="1.5"/>`;
  } else if (isText) {
    box = '';
  } else {
    const rx = d.deviceType === 'rounded' ? 16 : 8;
    box = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${esc(bg)}" stroke="${esc(border)}" stroke-width="1.5"/>`;
  }

  // Layout mirrors the node component: glyph on the left, text beside it,
  // centred when there is no glyph to sit next to.
  const iconSize = 30;
  const showIcon = !isShape;
  const textX = showIcon ? x + 10 + iconSize + 9 : x + w / 2;
  const anchorAttr = showIcon ? '' : ' text-anchor="middle"';
  const detail = d.showDetails && !isText;
  const primaryAddress = primary;
  const textW = showIcon ? w - (10 + iconSize + 9) - 10 : w - 16;

  // Vertical centring of the whole text block, so a node without details is
  // not top-heavy the way a fixed baseline would make it.
  const rows = 1 + (detail ? (primaryAddress ? 1 : 0) + 1 + (d.maintenance ? 1 : 0) : 0);
  const blockH = 12 + (rows - 1) * 14;
  let ty = y + h / 2 - blockH / 2 + 11;

  const parts: string[] = [box];
  if (showIcon) {
    parts.push(
      d.imageDataUrl
        ? `<image x="${x + 10}" y="${y + h / 2 - iconSize / 2}" width="${iconSize}" height="${iconSize}" href="${esc(d.imageDataUrl)}" preserveAspectRatio="xMidYMid meet"/>`
        : iconMarkup(d.deviceType, d.style?.iconColor ?? color, x + 10, y + h / 2 - iconSize / 2, iconSize),
    );
  }
  parts.push(
    `<text x="${textX}" y="${ty}"${anchorAttr} fill="#e6eef7" font-size="12" font-weight="600">${esc(fit(d.label, textW, 12))}</text>`,
  );
  if (detail) {
    if (primaryAddress) {
      ty += 14;
      parts.push(
        `<text x="${textX}" y="${ty}"${anchorAttr} fill="#8ea2b5" font-size="10" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${esc(fit(primaryAddress, textW, 10))}</text>`,
      );
    }
    ty += 14;
    parts.push(
      `<text x="${textX}" y="${ty}"${anchorAttr} fill="${color}" font-size="10" font-weight="600">${esc(STATUS_LABEL[status])}</text>`,
    );
    if (d.maintenance) {
      ty += 14;
      parts.push(
        `<text x="${textX}" y="${ty}"${anchorAttr} fill="#8b7ff0" font-size="10">In maintenance</text>`,
      );
    }
  }

  if (!isText) {
    // Status is never carried by colour alone; the badge repeats it as a glyph.
    parts.push(
      `<g><circle cx="${x + w}" cy="${y}" r="8.5" fill="${color}" stroke="#0a0e13" stroke-width="2"/>` +
        `<text x="${x + w}" y="${y + 3.5}" text-anchor="middle" fill="#07110c" font-size="10" font-weight="700">${esc(STATUS_GLYPH[status])}</text></g>`,
    );
  }

  return `<g>${parts.join('')}</g>`;
}

function edgeMarkup(e: TopoEdge, nodes: Map<string, TopoNode>, status: HealthStatus): string {
  const s = nodes.get(e.source);
  const t = nodes.get(e.target);
  if (!s || !t) return '';

  const data = (e.data ?? {}) as LinkData;
  // Without explicit handles React Flow uses right-to-left; matching that keeps
  // the export's routing the same as the screen's.
  const a = anchor(s, e.sourceHandle, Position.Right);
  const b = anchor(t, e.targetHandle, Position.Left);
  const [path, labelX, labelY] = pathFor(data.pathType ?? 'smoothstep', {
    sourceX: a.x, sourceY: a.y, targetX: b.x, targetY: b.y,
    sourcePosition: a.side, targetPosition: b.side,
  });

  const color = STATUS_COLOR[status];
  const width = data.width ?? 2;
  const dash =
    status === 'down' ? '10 6'
    : status === 'disabled' ? '2 6'
    : status === 'maintenance' ? '12 6'
    : null;
  const direction = data.direction ?? 'forward';
  const arrowEnd = direction === 'forward' || direction === 'both' ? ` marker-end="url(#cv-arrow-${status})"` : '';
  const arrowStart = direction === 'reverse' || direction === 'both' ? ` marker-start="url(#cv-arrow-rev-${status})"` : '';

  const parts = [
    `<path d="${path}" fill="none" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}${status === 'disabled' ? ' opacity="0.55"' : ''}${arrowEnd}${arrowStart}/>`,
  ];

  // The centre label's box is worked out first because the port labels are
  // placed around it.
  const centreText = data.label ? `${STATUS_GLYPH[status]} ${data.label}` : null;
  const centreW = centreText ? centreText.length * 6.2 + 12 : 0;

  // Port labels sit *beside* the line rather than on it. Placing them a
  // fraction along the line is what the canvas does, and it works there
  // because the labels are small HTML that the browser paints last. Here a
  // short link — two stacked switches a few pixels apart — puts the port label
  // under the link label, which is drawn after and opaque, so the port name
  // disappears from the export. Offsetting perpendicular is also how ports are
  // labelled on a drawn diagram: beside the line, near their interface.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;

  const portLabel = (text: string, from: { x: number; y: number }, toward: { x: number; y: number }) => {
    const w = text.length * 5.6 + 10;
    // Along the line: clear of the node border, never past the midpoint, so
    // the two ends' labels cannot cross over each other.
    const along = Math.min(26, len * 0.35);
    const ux = (toward.x - from.x) / len;
    const uy = (toward.y - from.y) / len;
    let off = w / 2 + 5;
    // On a short link the centre label reaches this far out too. Rather than
    // shift every label on every diagram, step aside only where it is needed.
    const nearCentre =
      centreText != null &&
      Math.abs(from.x + ux * along - labelX) < centreW / 2 + w / 2 &&
      Math.abs(from.y + uy * along - labelY) < 17;
    if (nearCentre) off = centreW / 2 + w / 2 + 6;
    const px = from.x + ux * along + -uy * off;
    const py = from.y + uy * along + ux * off;
    return `<g><rect x="${px - w / 2}" y="${py - 8}" width="${w}" height="15" rx="3" fill="#0a0e13" stroke="#2a3644"/>` +
      `<text x="${px}" y="${py + 3}" text-anchor="middle" fill="#8ea2b5" font-size="10" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${esc(text)}</text></g>`;
  };
  if (data.sourcePortLabel) parts.push(portLabel(data.sourcePortLabel, a, b));
  if (data.targetPortLabel) parts.push(portLabel(data.targetPortLabel, b, a));

  if (centreText) {
    parts.push(
      `<g><rect x="${labelX - centreW / 2}" y="${labelY - 9}" width="${centreW}" height="18" rx="4" fill="#111823" stroke="${color}"/>` +
        `<text x="${labelX}" y="${labelY + 4}" text-anchor="middle" fill="#e6eef7" font-size="11">${esc(centreText)}</text></g>`,
    );
  }
  return `<g>${parts.join('')}</g>`;
}

function markerDefs(): string {
  return (Object.keys(STATUS_COLOR) as HealthStatus[])
    .map((s) => {
      const c = STATUS_COLOR[s];
      return (
        `<marker id="cv-arrow-${s}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
        `<path d="M0 0 L10 5 L0 10 z" fill="${c}"/></marker>` +
        `<marker id="cv-arrow-rev-${s}" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
        `<path d="M10 0 L0 5 L10 10 z" fill="${c}"/></marker>`
      );
    })
    .join('');
}

function legend(width: number): string {
  const items: HealthStatus[] = ['healthy', 'warning', 'down', 'unknown', 'maintenance'];
  return items
    .map((s, i) => {
      const x = width - 520 + i * 104;
      return `<g><circle cx="${x}" cy="46" r="5" fill="${STATUS_COLOR[s]}"/><text x="${x + 12}" y="50" fill="#c3d2e0" font-size="11">${STATUS_LABEL[s]}</text></g>`;
    })
    .join('');
}

/** The whole diagram as a standalone SVG document. */
export function renderDiagramSvg(input: DiagramInput): string {
  const { meta, nodes, edges, includeTitleBlock } = input;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Bounds come from the model, so the export holds every object rather than
  // whatever happened to be scrolled into view.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const { w, h } = sizeOf(n);
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }
  if (!nodes.length) { minX = 0; minY = 0; maxX = 800; maxY = 600; }

  const contentW = Math.max(560, Math.round(maxX - minX) + PAD * 2);
  const contentH = Math.max(360, Math.round(maxY - minY) + PAD * 2);
  const headerH = includeTitleBlock ? HEADER_H : 0;
  const totalH = contentH + headerH;

  const subtitle = [meta.customer, meta.site, meta.ticket, meta.engineer].filter(Boolean).join('  ·  ');
  const header = includeTitleBlock
    ? `<g font-family="ui-sans-serif, Segoe UI, sans-serif">
    <rect x="0" y="0" width="${contentW}" height="${HEADER_H}" fill="#0e141b"/>
    <text x="18" y="30" fill="#e6eef7" font-size="18" font-weight="600">${esc(meta.name)}</text>
    <text x="18" y="52" fill="#8ea2b5" font-size="12">${esc(subtitle)}</text>
    <text x="18" y="72" fill="#8ea2b5" font-size="11">Exported ${esc(
      (input.now ?? new Date()).toLocaleString(),
    )} · Status reflects checks run from the exporting machine</text>
    ${legend(contentW)}
  </g>`
    : '';

  // Edges first, so a line never covers the device it lands on.
  const body =
    edges.map((e) => edgeMarkup(e, byId, input.linkStatus(e.id))).join('') +
    nodes.map((n) => nodeMarkup(n, input.nodeStatus(n.id), input.nodeStyle ?? 'glyph')).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${contentW}" height="${totalH}" viewBox="0 0 ${contentW} ${totalH}" font-family="ui-sans-serif, Segoe UI, Roboto, sans-serif">
  <defs>${markerDefs()}</defs>
  <rect width="100%" height="100%" fill="#0a0e13"/>
  ${header}
  <g transform="translate(${PAD - minX}, ${headerH + PAD - minY})">${body}</g>
</svg>`;
}
