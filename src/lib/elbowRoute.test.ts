import { describe, expect, it } from 'vitest';
import { dragSegment, pathVertices, segmentGrips } from './elbowRoute';

describe('elbowRoute (LT-069)', () => {
  it('reads the corner vertices of a step path', () => {
    const v = pathVertices('M0,0 L50,0 L50,100 L100,100');
    expect(v).toEqual([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 100 }, { x: 100, y: 100 }]);
  });

  it('offers a grip per interior segment', () => {
    const v = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 100 }, { x: 100, y: 100 }];
    const g = segmentGrips(v);
    expect(g).toHaveLength(3);
    expect(g[0]!.at).toEqual({ x: 25, y: 0 });
    expect(g[1]!.at).toEqual({ x: 50, y: 50 });
  });

  it('slides a vertical middle segment along x, keeping corners square', () => {
    const v = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 100 }, { x: 100, y: 100 }];
    // Segment index 1 is the vertical run at x=50; drag it to x=70.
    const wp = dragSegment(v, 1, { x: 70, y: 55 });
    expect(wp).toEqual([{ x: 70, y: 0 }, { x: 70, y: 100 }]);
  });

  it('slides a horizontal segment along y', () => {
    const v = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 100 }, { x: 100, y: 100 }];
    // Segment 0 is horizontal at y=0; drag to y=-30. Index 0 is an endpoint,
    // so a vertex is inserted to keep the device stub square.
    const wp = dragSegment(v, 0, { x: 25, y: -30 });
    // The run from the device now leaves at y=-30, with the corner preserved.
    expect(wp.some((p) => p.y === -30)).toBe(true);
  });
});

describe('a smoothstep link gets a handful of grips, not dozens (LT-071)', () => {
  // Verbatim from the browser: React Flow rounds each corner with a Q, and
  // splits straight runs at its border offsets.
  const SMOOTHSTEP =
    'M186.5 138L206.5 138L 329.5,138Q 341.5,138 341.5,150L 341.5,326Q 341.5,338 353.5,338L476.5 338L496.5 338';

  it('reads only the real corners', () => {
    const v = pathVertices(SMOOTHSTEP);
    expect(v.length).toBeLessThanOrEqual(4);
    expect(v[0]).toEqual({ x: 186.5, y: 138 });
    expect(v[v.length - 1]).toEqual({ x: 496.5, y: 338 });
  });

  it('offers at most a few grips', () => {
    const grips = segmentGrips(pathVertices(SMOOTHSTEP));
    expect(grips.length).toBeGreaterThan(0);
    expect(grips.length).toBeLessThanOrEqual(3);
  });

  it('skips runs too short to grab', () => {
    const v = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 200 }];
    expect(segmentGrips(v)).toHaveLength(1);
  });
});
