import { describe, expect, it } from 'vitest';
import { migrateDocument } from './migrate';


const baseDoc = { nodes: [], edges: [], probes: [], canvas: {} } as never as import('../state/store').ProjectDocument;
const node = (over: Record<string, unknown>) => ({
  id: 'n', type: 'device', position: { x: 100, y: 100 }, width: 168, height: 92,
  data: { label: 'Dev', deviceType: 'router', tags: [], addresses: [], locked: false, maintenance: false, showDetails: true },
  ...over,
}) as never;

describe('migrateDocument (LT-065)', () => {
  it('squares an old 168x92 device glyph and keeps its centre', () => {
    const doc = { ...baseDoc, nodes: [node({})] };
    const { doc: out, changed } = migrateDocument(doc);
    expect(changed).toBe(1);
    const n = out.nodes[0]!;
    expect(n.width).toBe(76);
    expect(n.height).toBe(76);
    // Old centre was (184, 146); new top-left keeps it.
    expect(n.position.x + 38).toBeCloseTo(184, 0);
    expect(n.position.y + 38).toBeCloseTo(146, 0);
  });

  it('leaves a shape node alone', () => {
    const doc = { ...baseDoc, nodes: [node({ data: { label: 'Box', deviceType: 'rectangle', tags: [], addresses: [], locked: false, maintenance: false, showDetails: true } })] };
    expect(migrateDocument(doc).changed).toBe(0);
  });

  it('leaves an already-square glyph alone (idempotent)', () => {
    const doc = { ...baseDoc, nodes: [node({ width: 76, height: 76 })] };
    expect(migrateDocument(doc).changed).toBe(0);
    // And running it twice does nothing more.
    const once = migrateDocument({ ...baseDoc, nodes: [node({})] }).doc;
    expect(migrateDocument(once).changed).toBe(0);
  });
});
