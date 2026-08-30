import { describe, expect, it } from 'vitest';

import { chooseHandles, routeLinks } from './routeLinks';
import type { TopoEdge, TopoNode } from '../state/store';

const at = (id: string, x: number, y: number): TopoNode =>
  ({
    id,
    type: 'device',
    position: { x, y },
    width: 176,
    height: 96,
    data: {
      label: id, deviceType: 'generic', tags: [], addresses: [],
      locked: false, maintenance: false, showDetails: true,
    },
  }) as TopoNode;

const link = (id: string, source: string, target: string, sh?: string, th?: string): TopoEdge =>
  ({ id, source, target, sourceHandle: sh, targetHandle: th, data: {} }) as TopoEdge;

describe('chooseHandles', () => {
  it('goes down for a device below', () => {
    expect(chooseHandles(at('a', 0, 0), at('b', 0, 300))).toEqual({
      sourceHandle: 'b',
      targetHandle: 't',
    });
  });

  it('goes sideways for a device beside it', () => {
    // The whole point: two switches in a row should not have a link that
    // dives below both of them and climbs back up.
    expect(chooseHandles(at('a', 0, 0), at('b', 400, 0))).toEqual({
      sourceHandle: 'r',
      targetHandle: 'l',
    });
  });

  it('goes down for a device above, because there is no upward source', () => {
    // A node emits from its right and its bottom only. Bottom-to-top is the
    // legal pair here and the router says so rather than inventing a handle.
    expect(chooseHandles(at('a', 0, 300), at('b', 0, 0))).toEqual({
      sourceHandle: 'b',
      targetHandle: 't',
    });
  });

  it('goes down for a device to the left, for the same reason', () => {
    // Sideways would have to leave the source's left, which is a target.
    expect(chooseHandles(at('a', 400, 0), at('b', 0, 0))).toEqual({
      sourceHandle: 'b',
      targetHandle: 't',
    });
  });

  it('treats a slight sideways offset between tiers as still a tier', () => {
    // Core above access, shifted a little. Diagrams are drawn in rows, and
    // routing this sideways would break the shape of every crawled diagram.
    expect(chooseHandles(at('a', 0, 0), at('b', 120, 300))).toEqual({
      sourceHandle: 'b',
      targetHandle: 't',
    });
  });

  it('routes from the middle of a node, not its corner', () => {
    // Two nodes at the same y are level even though a wide one starts first.
    const wide = { ...at('a', 0, 0), width: 400 } as TopoNode;
    expect(chooseHandles(wide, at('b', 800, 20))).toEqual({
      sourceHandle: 'r',
      targetHandle: 'l',
    });
  });
});

describe('routeLinks', () => {
  it('reports only the links that need moving', () => {
    const nodes = [at('a', 0, 0), at('b', 400, 0), at('c', 0, 300)];
    const edges = [
      link('side', 'a', 'b', 'b', 't'), // wrong: they are side by side
      link('down', 'a', 'c', 'b', 't'), // already right
    ];
    const changed = routeLinks(nodes, edges);
    expect(changed).toEqual([{ id: 'side', sourceHandle: 'r', targetHandle: 'l' }]);
  });

  it('reports nothing for a diagram already routed well', () => {
    const nodes = [at('a', 0, 0), at('b', 0, 300)];
    expect(routeLinks(nodes, [link('e', 'a', 'b', 'b', 't')])).toEqual([]);
  });

  it('ignores a link whose ends are not on the diagram', () => {
    expect(routeLinks([at('a', 0, 0)], [link('e', 'a', 'missing')])).toEqual([]);
  });

  it('routes a link that has no handles set at all', () => {
    const nodes = [at('a', 0, 0), at('b', 400, 0)];
    expect(routeLinks(nodes, [link('e', 'a', 'b')])).toEqual([
      { id: 'e', sourceHandle: 'r', targetHandle: 'l' },
    ]);
  });
});
