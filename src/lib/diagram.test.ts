import { describe, expect, it } from 'vitest';

import { fit, renderDiagramSvg } from './diagram';
import type { TopoEdge, TopoNode } from '../state/store';
import type { HealthStatus, ProjectMeta } from '../types/domain';

const meta: ProjectMeta = {
  id: 'p1', name: 'Branch cutover', customer: 'Acme', site: 'HQ', ticket: 'CHG-1',
  engineer: 'Sam', description: '', createdAt: 0, updatedAt: 0, archived: false,
};

function device(id: string, x: number, y: number, over: Record<string, unknown> = {}): TopoNode {
  return {
    id, type: 'device', position: { x, y }, width: 176, height: 96,
    data: {
      label: `Device ${id}`, deviceType: 'access-switch', tags: [],
      addresses: [{ id: 'a', label: 'Mgmt', address: '10.0.0.1', isPrimary: true }],
      locked: false, maintenance: false, showDetails: true, ...over,
    },
  } as TopoNode;
}

const link: TopoEdge = {
  id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'r', targetHandle: 'l',
  data: {
    sourcePortLabel: 'Gi1/0/1', targetPortLabel: 'Gi0/1', label: 'Uplink',
    pathType: 'smoothstep', direction: 'forward', width: 2, color: '#2fbf6b',
    enabled: true, maintenance: false, healthRule: { type: 'both-endpoints' },
  },
} as TopoEdge;

const render = (
  nodes: TopoNode[],
  edges: TopoEdge[] = [],
  status: HealthStatus = 'healthy',
  nodeStyle: 'glyph' | 'card' = 'card',
) =>
  renderDiagramSvg({
    meta, nodes, edges,
    nodeStatus: () => status,
    linkStatus: () => status,
    includeTitleBlock: true,
    nodeStyle,
    now: new Date(0),
  });

describe('renderDiagramSvg', () => {
  it('draws every node, not just what a DOM scrape would find', () => {
    // The bug this replaced: React Flow lays nodes out as HTML divs, so
    // serialising its viewport produced a file with edges and no devices.
    const svg = render([device('n1', 0, 0), device('n2', 400, 0)], [link]);
    expect(svg).toContain('Device n1');
    expect(svg).toContain('Device n2');
    expect(svg).not.toContain('<div');
  });

  it('draws the link, its ports and its label', () => {
    const svg = render([device('n1', 0, 0), device('n2', 400, 0)], [link]);
    expect(svg).toContain('Gi1/0/1');
    expect(svg).toContain('Gi0/1');
    expect(svg).toContain('Uplink');
    expect(svg).toContain('marker-end="url(#cv-arrow-healthy)"');
  });

  it('draws the device glyph as real paths', () => {
    const svg = render([device('n1', 0, 0)]);
    // The icons are authored with stroke="currentColor", which no standalone
    // renderer resolves — they have to be tinted on the way out.
    expect(svg).not.toContain('currentColor');
    expect(svg).toContain('<path');
  });

  it('carries status as a glyph as well as a colour', () => {
    const down = render([device('n1', 0, 0)], [], 'down');
    expect(down).toContain('✕');
    expect(down).toContain('#e4564a');
    expect(down).toContain('Down');
  });

  it('sizes the canvas to the content, including nodes far off screen', () => {
    // A node at x=4000 is off screen at any zoom; the export still has to hold it.
    const svg = render([device('n1', 0, 0), device('n2', 4000, 2000)]);
    const [, w, h] = /width="(\d+)" height="(\d+)"/.exec(svg)!.map(Number);
    expect(w).toBeGreaterThan(4000);
    expect(h).toBeGreaterThan(2000);
  });

  it('shifts negative coordinates into view', () => {
    // React Flow allows negative positions; a viewBox starting at 0 would clip them.
    const svg = render([device('n1', -900, -500), device('n2', 0, 0)]);
    expect(svg).toContain('translate(948, 634)');
  });

  it('escapes text that would otherwise break the document', () => {
    const svg = render([device('n1', 0, 0, { label: 'Core & <edge> "A"' })]);
    expect(svg).toContain('Core &amp; &lt;edge&gt;');
    expect(svg).not.toContain('<edge>');
  });

  it('keeps port labels clear of the link label on a short link', () => {
    // Two devices stacked with a small gap: placing the port label a fraction
    // along the line put it under the link label, which is drawn after and
    // opaque, so the port name vanished from the export.
    const short: TopoEdge = {
      ...link, sourceHandle: 'b', targetHandle: 't',
      data: { ...link.data, label: 'Primary ISP' },
    } as TopoEdge;
    const svg = render([device('n1', 0, 0), device('n2', 0, 150)], [short]);
    const port = /<rect x="([\d.-]+)" y="([\d.-]+)"[^>]*stroke="#2a3644"/.exec(svg)!;
    const centre = /<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="18"/.exec(svg)!;
    const boxesOverlap =
      Math.abs(Number(port[1]) - Number(centre[1])) < 40 &&
      Math.abs(Number(port[2]) - Number(centre[2])) < 16;
    expect(boxesOverlap).toBe(false);
    expect(svg).toContain('Gi1/0/1');
  });

  it('renders a note node with its own colours', () => {
    const note = {
      id: 'x', type: 'note', position: { x: 0, y: 0 }, width: 200, height: 120,
      data: {
        title: 'Rollback', body: '- [ ] Restore config\n- [x] Confirm', variant: 'change',
        fontSize: 12, textColor: '#f0e6d2', background: '#2a1f10', borderColor: '#8a6a2a',
        locked: false,
      },
    } as unknown as TopoNode;
    const svg = render([note]);
    expect(svg).toContain('Rollback');
    expect(svg).toContain('Restore config');
    expect(svg).toContain('#2a1f10');
  });

  it('produces a parsable document with no unclosed tags', () => {
    const svg = render([device('n1', 0, 0), device('n2', 400, 100)], [link]);
    const opens = (svg.match(/<g[ >]/g) ?? []).length;
    const closes = (svg.match(/<\/g>/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('still produces a document with nothing drawn', () => {
    const svg = render([]);
    expect(svg).toContain('Branch cutover');
    expect(svg).toContain('</svg>');
  });
});

describe('the glyph presentation', () => {
  it('draws no box, but still the glyph, the name and the status', () => {
    // The canvas draws these as a symbol with its name beneath and no border.
    // An export that kept the card would be a different diagram.
    const svg = render([device('n1', 0, 0)], [], 'healthy', 'glyph');
    expect(svg).toContain('Device n1');
    expect(svg).toContain('10.0.0.1');
    expect(svg).toContain('Healthy');
    expect(svg).toContain('<path');
    // No node body box. Counting <rect> would not show this — the chassis
    // glyph is drawn from rects too — so look for the box at the node's own
    // geometry, which is what the card draws and the glyph does not.
    expect(svg).not.toMatch(/<rect x="0" y="0" width="176" height="96"/);
  });

  it('still draws the annotation shapes as shapes', () => {
    // A rectangle drawn as a glyph is not a rectangle.
    const svg = render([device('s1', 0, 0, { deviceType: 'rectangle' })], [], 'healthy', 'glyph');
    expect(svg).toMatch(/<rect[^>]*rx="8"/);
  });

  it('keeps the card presentation available', () => {
    const svg = render([device('n1', 0, 0)], [], 'healthy', 'card');
    expect(svg).toMatch(/<rect x="0" y="0" width="176" height="96"/);
  });
});

describe('fit', () => {
  it('leaves text that fits alone', () => {
    expect(fit('core-sw-01', 200, 12)).toBe('core-sw-01');
  });

  it('truncates text that would run past the node', () => {
    const out = fit('a-very-long-hostname-that-will-not-fit', 60, 12);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThan(12);
  });
});
