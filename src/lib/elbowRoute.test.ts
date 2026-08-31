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
