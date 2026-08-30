import { describe, expect, it } from 'vitest';

import { collapseView, groupIdOf, isCollapsed, nameForGroup } from './collapse';
import type { TopoEdge, TopoNode } from '../state/store';

const device = (id: string, group?: string, over: Record<string, unknown> = {}): TopoNode =>
  ({
    id,
    type: 'device',
    position: { x: 0, y: 0 },
    data: {
      label: id, deviceType: 'access-switch', tags: [], addresses: [],
      locked: false, maintenance: false, showDetails: true,
      ...(group ? { groupId: group } : {}),
      ...over,
    },
  }) as TopoNode;

const link = (id: string, source: string, target: string): TopoEdge =>
  ({ id, source, target, data: {} }) as TopoEdge;

describe('collapseView', () => {
  const nodes = [
    device('a', 'hq', { tags: ['site-hq'] }),
    device('b', 'hq', { tags: ['site-hq'] }),
    device('c'),
  ];
  const edges = [link('inside', 'a', 'b'), link('crossing', 'a', 'c')];

  it('leaves the diagram alone when nothing is folded', () => {
    const view = collapseView(nodes, edges, new Set());
    expect(view.nodes).toBe(nodes);
    expect(view.edges).toBe(edges);
  });

  it('replaces a folded group with one box', () => {
    const view = collapseView(nodes, edges, new Set(['hq']));
    expect(view.nodes).toHaveLength(2);
    expect(view.nodes.map((n) => n.id).sort()).toEqual(['c', 'collapsed:hq']);
  });

  it('drops a link that is now inside the box', () => {
    const view = collapseView(nodes, edges, new Set(['hq']));
    expect(view.edges.map((e) => e.id)).not.toContain('inside');
  });

  it('redraws a link that crosses the boundary', () => {
    const view = collapseView(nodes, edges, new Set(['hq']));
    const crossing = view.edges.find((e) => e.id.includes('crossing'));
    expect(crossing).toBeDefined();
    expect(crossing!.source).toBe('collapsed:hq');
    expect(crossing!.target).toBe('c');
  });

  it('draws one line where several crossed to the same place', () => {
    // Fourteen parallel lines into a folded site says nothing one line does
    // not, and makes the diagram less readable than before it was folded.
    const many = [link('e1', 'a', 'c'), link('e2', 'b', 'c'), link('e3', 'a', 'c')];
    const view = collapseView(nodes, many, new Set(['hq']));
    expect(view.edges).toHaveLength(1);
  });

  it('keeps links between two different folded groups', () => {
    const two = [...nodes, device('d', 'branch'), device('e', 'branch')];
    const across = [link('x', 'a', 'd')];
    const view = collapseView(two, across, new Set(['hq', 'branch']));
    expect(view.edges).toHaveLength(1);
    expect(view.edges[0]!.source).toBe('collapsed:hq');
    expect(view.edges[0]!.target).toBe('collapsed:branch');
  });

  it('puts the box where the site was', () => {
    // Jumping to the origin would rearrange the diagram every time someone
    // folded something.
    const placed = [
      { ...device('a', 'hq'), position: { x: 500, y: 300 } } as TopoNode,
      { ...device('b', 'hq'), position: { x: 700, y: 460 } } as TopoNode,
    ];
    const view = collapseView(placed, [], new Set(['hq']));
    expect(view.nodes[0]!.position).toEqual({ x: 500, y: 300 });
  });

  it('says what is inside it', () => {
    const view = collapseView(nodes, edges, new Set(['hq']));
    const box = view.nodes.find((n) => n.id === 'collapsed:hq')!;
    expect((box.data as { notes?: string }).notes).toContain('a, b');
    expect((box.data as { notes?: string }).notes).toContain('2 objects');
  });

  it('folds nothing for a group id nobody carries any more', () => {
    // The nodes were deleted or ungrouped while it was folded. An empty box
    // drawn for a group with no members would be a ghost nobody can remove.
    const view = collapseView(nodes, edges, new Set(['gone']));
    expect(view.nodes).toHaveLength(3);
    expect(view.nodes.some((n) => n.id.startsWith('collapsed:'))).toBe(false);
  });
});

describe('nameForGroup', () => {
  it('uses a tag every member shares', () => {
    const named = nameForGroup([
      device('a', 'g', { tags: ['site-hq', 'core'] }),
      device('b', 'g', { tags: ['site-hq'] }),
    ]);
    expect(named).toBe('site-hq');
  });

  it('ignores tags the crawler writes about how it found something', () => {
    // "discovered" is on everything a crawl drew and says nothing about
    // where a device is, so it must never end up naming a site.
    const named = nameForGroup([
      device('a', 'g', { tags: ['discovered', 'seen-only'] }),
      device('b', 'g', { tags: ['discovered', 'seen-only'] }),
    ]);
    expect(named).toBe('2 objects');
  });

  it('does not name a site after one machine inside it', () => {
    const named = nameForGroup([device('CORE-SW', 'g'), device('ACC-SW', 'g')]);
    expect(named).toBe('2 objects');
  });
});

describe('collapsed ids', () => {
  it('are recognisable and reversible', () => {
    expect(isCollapsed('collapsed:hq')).toBe(true);
    expect(isCollapsed('n1')).toBe(false);
    expect(groupIdOf('collapsed:hq')).toBe('hq');
  });
});
