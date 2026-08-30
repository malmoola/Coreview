import { describe, expect, it } from 'vitest';

import { assignLanes, chooseHandles, routeForView, routeLinks } from './routeLinks';
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

  it('goes up for a device above', () => {
    // Every side can start a link now, so this is a full turn rather than a
    // choice between two legal pairs.
    expect(chooseHandles(at('a', 0, 300), at('b', 0, 0))).toEqual({
      sourceHandle: 't',
      targetHandle: 'b',
    });
  });

  it('goes left for a device to the left', () => {
    expect(chooseHandles(at('a', 400, 0), at('b', 0, 0))).toEqual({
      sourceHandle: 'l',
      targetHandle: 'r',
    });
  });

  it('faces each of the four ways round', () => {
    const middle = at('a', 500, 500);
    const sides = [
      [at('b', 500, 0), 't'],
      [at('b', 1200, 500), 'r'],
      [at('b', 500, 1200), 'b'],
      [at('b', 0, 500), 'l'],
    ] as const;
    for (const [other, side] of sides) {
      const h = chooseHandles(middle, other);
      expect(h.sourceHandle).toBe(side);
      // And the far end faces back, so the two ends always look at each other.
      expect(h.targetHandle).toBe({ t: 'b', r: 'l', b: 't', l: 'r' }[side]);
    }
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

describe('routeForView', () => {
  const pinned = (id: string, source: string, target: string): TopoEdge =>
    ({
      id, source, target, sourceHandle: 'b', targetHandle: 't',
      data: { pinnedSides: true },
    }) as TopoEdge;

  it('swings a link round when a device moves to the side', () => {
    // The whole point: drag the lower device out to the right and the link
    // should leave the right of the upper one, not still dive off its bottom.
    const below = [at('a', 0, 0), at('b', 0, 400)];
    const beside = [at('a', 0, 0), at('b', 700, 0)];
    const edges = [link('e', 'a', 'b', 'b', 't')];

    expect(routeForView(below, edges)[0]!.sourceHandle).toBe('b');
    expect(routeForView(beside, edges)[0]!.sourceHandle).toBe('r');
    expect(routeForView(beside, edges)[0]!.targetHandle).toBe('l');
  });

  it('swings back when the device is moved back', () => {
    const edges = [link('e', 'a', 'b', 'r', 'l')];
    const below = [at('a', 0, 0), at('b', 0, 400)];
    expect(routeForView(below, edges)[0]!.sourceHandle).toBe('b');
  });

  it('leaves a held link exactly where it was drawn', () => {
    // Someone drew this the long way round on purpose.
    const beside = [at('a', 0, 0), at('b', 700, 0)];
    const routed = routeForView(beside, [pinned('e', 'a', 'b')]);
    expect(routed[0]!.sourceHandle).toBe('b');
    expect(routed[0]!.targetHandle).toBe('t');
  });

  it('hands back the same array when nothing needs moving', () => {
    // Rendering gives React Flow a new edge list on every unrelated render
    // otherwise, which makes it redraw every link for no reason.
    const nodes = [at('a', 0, 0), at('b', 0, 400)];
    const edges = [link('e', 'a', 'b', 'b', 't')];
    expect(routeForView(nodes, edges)).toBe(edges);
  });

  it('does not change the edges it was given', () => {
    // It is a view. Writing through to the document during a drag would fill
    // the undo history with one entry per frame.
    const beside = [at('a', 0, 0), at('b', 700, 0)];
    const edges = [link('e', 'a', 'b', 'b', 't')];
    routeForView(beside, edges);
    expect(edges[0]!.sourceHandle).toBe('b');
  });

  it('leaves a link alone when one end is not on the diagram', () => {
    const routed = routeForView([at('a', 0, 0)], [link('e', 'a', 'missing', 'b', 't')]);
    expect(routed[0]!.sourceHandle).toBe('b');
  });
});

describe('assignLanes', () => {
  it('gives links off the same side different lanes', () => {
    const edges = [
      link('e1', 'core', 'a', 'b', 't'),
      link('e2', 'core', 'b', 'b', 't'),
      link('e3', 'core', 'c', 'b', 't'),
    ];
    const lanes = assignLanes(edges);
    expect([lanes.get('e1'), lanes.get('e2'), lanes.get('e3')]).toEqual([0, 1, 2]);
  });

  it('leaves a link on its own in the first lane', () => {
    // A diagram with no crowding has to look exactly as it did.
    const lanes = assignLanes([link('e1', 'a', 'b', 'b', 't')]);
    expect(lanes.get('e1')).toBe(0);
  });

  it('counts both ends, so a busy far end also spreads', () => {
    // Three links arriving at the top of one server from three switches
    // would otherwise all turn at the same distance above it.
    const edges = [
      link('e1', 'a', 'srv', 'b', 't'),
      link('e2', 'b', 'srv', 'b', 't'),
      link('e3', 'c', 'srv', 'b', 't'),
    ];
    const lanes = assignLanes(edges);
    expect([lanes.get('e1'), lanes.get('e2'), lanes.get('e3')]).toEqual([0, 1, 2]);
  });

  it('treats different sides of one device as different queues', () => {
    const edges = [link('e1', 'core', 'a', 'b', 't'), link('e2', 'core', 'b', 'r', 'l')];
    const lanes = assignLanes(edges);
    expect(lanes.get('e1')).toBe(0);
    expect(lanes.get('e2')).toBe(0);
  });

  it('puts the lane on the edge the canvas draws', () => {
    const nodes = [at('core', 500, 0), at('a', 300, 500), at('b', 700, 500)];
    const edges = [link('e1', 'core', 'a'), link('e2', 'core', 'b')];
    const routed = routeForView(nodes, edges);
    // The first lane is the default, so it is left unset rather than written
    // to every edge on a diagram that has no crowding at all.
    expect((routed[0]!.data as { lane?: number }).lane ?? 0).toBe(0);
    expect((routed[1]!.data as { lane?: number }).lane).toBe(1);
  });
});
