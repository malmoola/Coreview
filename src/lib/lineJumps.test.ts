import { describe, expect, it } from 'vitest';

import { crossing, jumpsFor, shouldHop, straightRuns, withJumps } from './lineJumps';

describe('straightRuns', () => {
  it('reads the straight parts of a path', () => {
    const runs = straightRuns('M0,0L100,0L100,80');
    expect(runs).toEqual([
      { x: 0, y: 0, x2: 100, y2: 0 },
      { x: 100, y: 0, x2: 100, y2: 80 },
    ]);
  });

  it('steps over a rounded corner without treating it as a run', () => {
    // A step path is L, then a 12px arc, then L. A hop sitting on that arc
    // would look like a mistake.
    const runs = straightRuns('M0,0L88,0Q100,0 100,12L100,80');
    expect(runs).toHaveLength(2);
    expect(runs[1]).toEqual({ x: 100, y: 12, x2: 100, y2: 80 });
  });

  it('has nothing to say about a pure curve', () => {
    expect(straightRuns('M0,0C20,0 80,60 100,60')).toEqual([]);
  });

  it('handles a path with nothing in it', () => {
    expect(straightRuns('')).toEqual([]);
  });
});

describe('crossing', () => {
  const h = { x: 0, y: 50, x2: 100, y2: 50 };
  const v = { x: 50, y: 0, x2: 50, y2: 100 };

  it('finds where two runs cross', () => {
    expect(crossing(h, v)).toEqual({ x: 50, y: 50 });
  });

  it('says nothing about runs that miss', () => {
    expect(crossing(h, { x: 200, y: 0, x2: 200, y2: 100 })).toBeNull();
  });

  it('says nothing about parallel runs', () => {
    // Two links running along one another need separating, not hopping.
    expect(crossing(h, { x: 0, y: 60, x2: 100, y2: 60 })).toBeNull();
    expect(crossing(h, { x: 0, y: 50, x2: 100, y2: 50 })).toBeNull();
  });

  it('does not treat links meeting at a device as a crossing', () => {
    // Two links arriving at the same handle share an endpoint. A hop there
    // would say they pass, when in fact they both stop.
    expect(crossing(h, { x: 0, y: 50, x2: 0, y2: 200 })).toBeNull();
    expect(crossing(h, { x: 100, y: 50, x2: 100, y2: 200 })).toBeNull();
  });
});

describe('shouldHop', () => {
  const h = { x: 0, y: 50, x2: 100, y2: 50 };
  const v = { x: 50, y: 0, x2: 50, y2: 100 };

  it('lets the horizontal run hop the vertical one', () => {
    expect(shouldHop(h, v, 'a', 'b')).toBe(true);
    expect(shouldHop(v, h, 'b', 'a')).toBe(false);
  });

  it('picks the same one whichever way round it is asked', () => {
    // Both hopping draws two arcs through each other, which is worse than no
    // hop at all — and it must not depend on which edge rendered first.
    const both = shouldHop(h, v, 'a', 'b') && shouldHop(v, h, 'b', 'a');
    expect(both).toBe(false);
    const diagonalA = { x: 0, y: 0, x2: 100, y2: 100 };
    const diagonalB = { x: 0, y: 100, x2: 100, y2: 0 };
    expect(shouldHop(diagonalA, diagonalB, 'a', 'b')).toBe(true);
    expect(shouldHop(diagonalB, diagonalA, 'b', 'a')).toBe(false);
  });
});

describe('jumpsFor', () => {
  const across = 'M0,50L200,50';
  const down = 'M100,0L100,120';

  it('finds a crossing against another link', () => {
    expect(jumpsFor('a', across, [['b', down]])).toEqual([{ x: 100, y: 50 }]);
  });

  it('gives the hop to only one of the pair', () => {
    expect(jumpsFor('b', down, [['a', across]])).toEqual([]);
  });

  it('ignores itself', () => {
    expect(jumpsFor('a', across, [['a', across]])).toEqual([]);
  });

  it('draws one hop where two links cross at almost the same place', () => {
    // A scallop of overlapping arcs reads worse than a single hop.
    const alsoDown = 'M104,0L104,120';
    expect(jumpsFor('a', across, [['b', down], ['c', alsoDown]])).toHaveLength(1);
  });

  it('draws a hop for each crossing that is properly apart', () => {
    const farDown = 'M160,0L160,120';
    expect(jumpsFor('a', across, [['b', down], ['c', farDown]])).toHaveLength(2);
  });

  it('has nothing to do on a diagram with one link', () => {
    expect(jumpsFor('a', across, [])).toEqual([]);
  });
});

describe('withJumps', () => {
  it('leaves a path alone when nothing crosses it', () => {
    expect(withJumps('M0,50L200,50', [])).toBe('M0,50L200,50');
  });

  it('cuts the run and stitches it back with an arc', () => {
    const out = withJumps('M0,50L200,50', [{ x: 100, y: 50 }], 5);
    expect(out).toContain('A5,5');
    // The run still starts and ends where it did.
    expect(out.startsWith('M0,50')).toBe(true);
    expect(out.endsWith('L200,50')).toBe(true);
  });

  it('leaves the rounded corners of a step path untouched', () => {
    const d = 'M0,50L88,50Q100,50 100,62L100,200';
    const out = withJumps(d, [{ x: 50, y: 50 }], 5);
    expect(out).toContain('Q100,50 100,62');
  });

  it("does not hop within a hop width of either end", () => {
    // Half an arc hanging off the end of a line reads as a kink.
    const out = withJumps('M0,50L200,50', [{ x: 3, y: 50 }], 5);
    expect(out).toBe('M0,50L200,50');
  });

  it('ignores a point that is not on the run', () => {
    const out = withJumps('M0,50L200,50', [{ x: 100, y: 90 }], 5);
    expect(out).toBe('M0,50L200,50');
  });

  it('leaves a run too short to carry an arc alone', () => {
    const out = withJumps('M0,50L12,50', [{ x: 6, y: 50 }], 5);
    expect(out).toBe('M0,50L12,50');
  });

  it('puts several hops on one run in order', () => {
    const out = withJumps('M0,50L300,50', [{ x: 200, y: 50 }, { x: 100, y: 50 }], 5);
    const first = out.indexOf('L95');
    const second = out.indexOf('L195');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });
});

describe('crossings under a smoothstep link still hop (LT-064)', () => {
  // The exact paths React Flow drew for a horizontal link crossed by a
  // vertical one — the horizontal is split at its border offsets into
  // collinear runs, and the crossing at x=338 lands 3.5px from the 341.5
  // joint. It used to be dropped for sitting at a run's end.
  const h = 'M186.5 138L206.5,138L341.5,138L341.5,138L476.5,138';
  const v = 'M338 46.5L338 66.5L338 151.5L338 151.5L338 236.5L338 300';

  it('finds the crossing and renders an arc for it', () => {
    const jumps = jumpsFor('h', h, [['v', v]]);
    expect(jumps).toHaveLength(1);
    const out = withJumps(h, jumps, 5);
    expect(out).toMatch(/A5,5 /);
  });

  it('a straight line with no crossing is returned untouched', () => {
    expect(withJumps(h, [], 5)).toBe(h);
    expect(withJumps(h, jumpsFor('h', h, []), 5)).toBe(h);
  });
});
