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
    // The arrow has to be referenced *and* defined. A reference to a marker
    // that is not in the file draws nothing, and it draws nothing silently.
    const ref = /marker-end="url\(#([^)]+)\)"/.exec(svg);
    expect(ref, 'no marker-end on the link').not.toBeNull();
    expect(svg).toContain(`<marker id="${ref![1]}"`);
  });

  it('paints the arrowhead in the link own colour', () => {
    // Markers used to be shared per status, and a marker in a shared defs
    // cannot see the colour of the path using it — every arrowhead stayed the
    // health colour however the link was painted.
    const painted = {
      ...link,
      data: { ...link.data, colorMode: 'fixed' as const, color: '#b76eff' },
    } as TopoEdge;
    const svg = render([device('n1', 0, 0), device('n2', 400, 0)], [painted]);
    const ref = /marker-end="url\(#([^)]+)\)"/.exec(svg);
    const marker = svg.slice(svg.indexOf(`<marker id="${ref![1]}"`));
    expect(marker.slice(0, 400).toLowerCase()).toContain('#b76eff');
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

describe('the ground the sheet is printed on', () => {
  const nodes = [
    {
      id: 'n1', type: 'device', position: { x: 0, y: 0 }, width: 176, height: 96,
      data: {
        label: 'CORE-SW', deviceType: 'core-switch', tags: [],
        addresses: [{ id: 'a', label: 'Mgmt', address: '10.0.0.1', isPrimary: true }],
        locked: false, maintenance: false, showDetails: true,
      },
    },
  ] as unknown as Parameters<typeof renderDiagramSvg>[0]['nodes'];

  const sheet = (ground?: 'dark' | 'light') =>
    renderDiagramSvg({
      meta, nodes, edges: [], nodeStatus: () => 'healthy', linkStatus: () => 'healthy',
      includeTitleBlock: true, now: new Date(0), ground,
    });

  it('prints on white when the diagram is drawn on white', () => {
    // A diagram prepared for a document used to come out as a black rectangle
    // in the middle of a white page.
    expect(sheet('light')).toContain('fill="#ffffff"');
    expect(sheet('light')).not.toContain('fill="#0a0e13"');
  });

  it('still prints dark when that is what is on screen', () => {
    expect(sheet('dark')).toContain('fill="#0a0e13"');
  });

  it('stays dark for a caller that has not said', () => {
    // Every existing caller and test predates the option.
    expect(sheet()).toContain('fill="#0a0e13"');
  });

  it('uses the colours chosen for that ground, not the other one', () => {
    const light = sheet('light');
    const dark = sheet('dark');
    // Healthy is #0a8a3f on white and #2fbf6b on black.
    expect(light).toContain('#0a8a3f');
    expect(light).not.toContain('#2fbf6b');
    expect(dark).toContain('#2fbf6b');
  });

  it('writes text in ink that reads on the paper', () => {
    expect(sheet('light')).toContain('fill="#0d1722"');
    expect(sheet('dark')).toContain('fill="#e6eef7"');
  });
});

describe('sections in the export', () => {
  const zone = {
    id: 'z1', type: 'device', position: { x: -40, y: -40 }, width: 400, height: 300,
    data: { label: 'DMZ', deviceType: 'zone', tags: [], addresses: [],
      locked: false, maintenance: false, showDetails: true },
  } as unknown as Parameters<typeof renderDiagramSvg>[0]['nodes'][number];

  const dev = {
    id: 'n1', type: 'device', position: { x: 60, y: 60 }, width: 176, height: 96,
    data: { label: 'FW-1', deviceType: 'firewall', tags: [], addresses: [],
      locked: false, maintenance: false, showDetails: true },
  } as unknown as Parameters<typeof renderDiagramSvg>[0]['nodes'][number];

  it('never puts colour alpha in a hex literal', () => {
    // SVG 1.1 has no alpha in a colour, and a renderer that meets an
    // eight-digit hex falls back to black — which drew the section as a solid
    // slab over everything standing in it.
    const svg = renderDiagramSvg({
      meta, nodes: [zone, dev], edges: [], nodeStatus: () => 'unknown',
      linkStatus: () => 'unknown', includeTitleBlock: false, now: new Date(0),
    });
    expect(svg).not.toMatch(/#[0-9a-fA-F]{8}\b/);
    expect(svg).toContain('fill-opacity');
  });

  it('gives a section its name and no health of its own', () => {
    // A section is an area. Nothing probes it, and a badge on it would be
    // reporting on nothing.
    const svg = renderDiagramSvg({
      meta, nodes: [zone], edges: [], nodeStatus: () => 'unknown',
      linkStatus: () => 'unknown', includeTitleBlock: false, now: new Date(0),
    });
    expect(svg).toContain('DMZ');
    expect(svg).not.toContain('Unknown');
  });

  it('draws a section behind what stands in it', () => {
    // Drawn in document order, so a section after its contents covers them
    // and the sheet is a set of empty boxes.
    const svg = renderDiagramSvg({
      meta, nodes: [dev, zone], edges: [], nodeStatus: () => 'unknown',
      linkStatus: () => 'unknown', includeTitleBlock: false, now: new Date(0),
    });
    expect(svg).toContain('DMZ');
    expect(svg).toContain('FW-1');
    expect(svg.indexOf('DMZ')).toBeLessThan(svg.indexOf('FW-1'));
  });
});

describe('putting the diagram on a sheet', () => {
  const nodes = [
    {
      id: 'n1', type: 'device', position: { x: 0, y: 0 }, width: 176, height: 96,
      data: { label: 'CORE-SW', deviceType: 'core-switch', tags: [], addresses: [],
        locked: false, maintenance: false, showDetails: true },
    },
  ] as unknown as Parameters<typeof renderDiagramSvg>[0]['nodes'];

  const render = (page?: { width: number; height: number }) =>
    renderDiagramSvg({
      meta, nodes, edges: [], nodeStatus: () => 'healthy', linkStatus: () => 'healthy',
      includeTitleBlock: false, now: new Date(0), page,
    });

  it('is sized to the diagram when no sheet is asked for', () => {
    // The right default for the screen: nobody wants a screenshot with
    // margins round it.
    const svg = render();
    expect(svg).not.toContain('width="1123"');
  });

  it('takes the sheet dimensions when one is', () => {
    const svg = render({ width: 1123, height: 794 });
    expect(svg).toContain('width="1123"');
    expect(svg).toContain('height="794"');
  });

  it('scales and centres the whole drawing rather than each part', () => {
    // One transform round everything, so nothing inside has to know it is on
    // paper — and the geometry stays exactly what it was.
    const svg = render({ width: 1123, height: 794 });
    expect(svg).toMatch(/<g transform="translate\([\d.]+, [\d.]+\) scale\([\d.]+\)">/);
  });

  it('paints the whole sheet, not just the drawing', () => {
    // Otherwise the diagram sits on a transparent page, which prints as
    // whatever the printer feels like.
    const svg = render({ width: 1123, height: 794 });
    expect(svg).toContain('<rect width="100%" height="100%"');
  });

  it('does not enlarge a small diagram to fill the page', () => {
    const svg = render({ width: 1123, height: 794 });
    const scale = Number(/scale\(([\d.]+)\)/.exec(svg)![1]);
    expect(scale).toBe(1);
  });
});

describe('rendering exactly the on-screen page', () => {
  const nodes = [
    {
      id: 'n1', type: 'device', position: { x: 300, y: 200 }, width: 176, height: 96,
      data: { label: 'CORE-SW', deviceType: 'core-switch', tags: [], addresses: [],
        locked: false, maintenance: false, showDetails: true },
    },
  ] as unknown as Parameters<typeof renderDiagramSvg>[0]['nodes'];

  const sheetRect = { x: 0, y: 0, w: 2340, h: 1224 };
  const render = () =>
    renderDiagramSvg({
      meta, nodes, edges: [], nodeStatus: () => 'healthy', linkStatus: () => 'healthy',
      includeTitleBlock: false, now: new Date(0), sheetRect,
    });

  it('is the sheet, not a shrink-wrap of the content', () => {
    // The page grew on screen; the file is that page, so what you see is
    // what whoever receives the file sees.
    const svg = render();
    expect(svg).toContain('width="2340"');
    expect(svg).toContain('height="1224"');
  });

  it('keeps the device where it sits on the sheet', () => {
    // One node at 300,200 on a sheet anchored at 0,0: shrink-wrapping would
    // slide it to the margin and every export would recompose the layout.
    const svg = render();
    const m = /<g transform="translate\((-?[\d.]+), (-?[\d.]+)\)">/.exec(svg)!;
    expect(Number(m[1])).toBeCloseTo(0);
  });

  it('carries no selection chrome and no minimap', () => {
    const svg = render();
    expect(svg).not.toContain('cv-minimap');
    expect(svg).not.toContain('is-selected');
    expect(svg).not.toContain('cv-guide');
  });
});

describe('multi-sheet tiling clips each sheet (LT-028)', () => {
  const base = {
    meta: { id: 'p', name: 'Net', customer: '', site: '', ticket: '', engineer: '', createdAt: 0, updatedAt: 0, archived: false },
    nodes: [
      { id: 'left', type: 'device', position: { x: 0, y: 0 }, width: 76, height: 76, data: { label: 'LEFT', deviceType: 'router', tags: [], addresses: [], locked: false, maintenance: false, showDetails: true } },
      { id: 'right', type: 'device', position: { x: 1400, y: 0 }, width: 76, height: 76, data: { label: 'RIGHT', deviceType: 'router', tags: [], addresses: [], locked: false, maintenance: false, showDetails: true } },
    ],
    edges: [],
    nodeStatus: () => 'healthy' as const,
    linkStatus: () => 'healthy' as const,
    includeTitleBlock: false,
    now: new Date(0),
  };

  it('a tile carries a clip-path and both sheets render', () => {
    const left = renderDiagramSvg({ ...base, page: { width: 800, height: 600 }, tile: { x: -20, y: -20, w: 728, h: 528 } } as never);
    const right = renderDiagramSvg({ ...base, page: { width: 800, height: 600 }, tile: { x: 708, y: -20, w: 728, h: 528 } } as never);
    expect(left).toContain('clip-path=');
    expect(right).toContain('clip-path=');
    // Both are valid single-sheet SVGs placed on the page.
    expect(left).toContain('<svg');
    expect(right).toContain('<svg');
    // The two tiles use different clip ids (different origins).
    const idOf = (svg) => /clipPath id="([^"]+)"/.exec(svg)[1];
    expect(idOf(left)).not.toBe(idOf(right));
  });
});
