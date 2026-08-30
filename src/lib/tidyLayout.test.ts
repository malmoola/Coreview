import { describe, expect, it } from 'vitest';

import { tidyLayout } from './tidyLayout';
import type { TopoNode } from '../state/store';

const at = (id: string, x: number, y: number, over: Record<string, unknown> = {}): TopoNode =>
  ({
    id,
    type: 'device',
    position: { x, y },
    data: {
      label: id, deviceType: 'generic', tags: [], addresses: [],
      locked: false, maintenance: false, showDetails: true, ...over,
    },
  }) as TopoNode;

const place = (nodes: TopoNode[], id: string, result: ReturnType<typeof tidyLayout>) =>
  result.moved.get(id) ?? nodes.find((n) => n.id === id)!.position;

describe('tidyLayout', () => {
  it('keeps what was above above, and what was left left', () => {
    // The arrangement is the thing someone spent time on. A layout that
    // solves overlap by rearranging has taken more than it gave.
    const nodes = [at('a', 0, 0), at('b', 30, 5), at('c', 10, 400), at('d', 60, 405)];
    const r = tidyLayout(nodes);
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => place(nodes, id, r));
    expect(a!.y).toBeLessThan(c!.y);
    expect(a!.x).toBeLessThan(b!.x);
    expect(c!.x).toBeLessThan(d!.x);
    expect(r.rows).toBe(2);
  });

  it('opens the gaps to something a label fits in', () => {
    const nodes = [at('a', 0, 0), at('b', 20, 0)];
    const r = tidyLayout(nodes, { columnGap: 240 });
    const [a, b] = ['a', 'b'].map((id) => place(nodes, id, r));
    expect(b!.x - a!.x).toBe(240);
  });

  it('treats nodes at a similar height as one row', () => {
    // Hand-placed nodes are never exactly level, and a strict comparison
    // would make a row of five into five rows of one.
    const nodes = [at('a', 0, 100), at('b', 200, 118), at('c', 400, 92)];
    expect(tidyLayout(nodes).rows).toBe(1);
  });

  it('separates rows that really are apart', () => {
    const nodes = [at('a', 0, 0), at('b', 0, 300), at('c', 0, 600)];
    expect(tidyLayout(nodes).rows).toBe(3);
  });

  it('leaves a locked node where it was put', () => {
    // Locked means someone decided. Tidying is not a reason to overrule that.
    const nodes = [at('a', 0, 0), at('pinned', 900, 900, { locked: true })];
    const r = tidyLayout(nodes);
    expect(r.moved.has('pinned')).toBe(false);
  });

  it('does not walk the diagram across the canvas', () => {
    // The top-left stays put, so pressing tidy does not also mean hunting for
    // where everything went.
    const nodes = [at('a', 500, 400), at('b', 520, 410)];
    const r = tidyLayout(nodes);
    const a = place(nodes, 'a', r);
    expect(a).toEqual({ x: 500, y: 400 });
  });

  it('reports nothing to do when a diagram is already tidy', () => {
    const nodes = [at('a', 0, 0), at('b', 240, 0)];
    expect(tidyLayout(nodes).moved.size).toBe(0);
  });

  it('handles an empty diagram and a diagram of one', () => {
    expect(tidyLayout([]).moved.size).toBe(0);
    expect(tidyLayout([at('only', 5, 5)]).moved.size).toBe(0);
  });
});
