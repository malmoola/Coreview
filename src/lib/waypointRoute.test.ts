import { describe, expect, it } from 'vitest';
import { roundedPolyline, segmentMidpoints, waypointRoute } from './waypointRoute';

describe('waypointRoute (LT-068)', () => {
  it('a link with no waypoints is a straight line', () => {
    expect(roundedPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe('M0,0L10,0');
  });

  it('routes through a waypoint with a rounded corner', () => {
    const { path } = waypointRoute({ x: 0, y: 0 }, [{ x: 100, y: 0 }], { x: 100, y: 100 }, 10);
    // Bends at the waypoint: an arc (Q) appears, and both legs are present.
    expect(path).toMatch(/Q100,0/);
    expect(path.startsWith('M0,0')).toBe(true);
    expect(path.endsWith('L100,100')).toBe(true);
  });

  it('puts the label at the halfway point along the route', () => {
    const { labelAt } = waypointRoute({ x: 0, y: 0 }, [{ x: 100, y: 0 }], { x: 200, y: 0 }, 10);
    expect(labelAt.x).toBeCloseTo(100, 0);
    expect(labelAt.y).toBeCloseTo(0, 0);
  });

  it('offers a midpoint per segment for adding a bend', () => {
    const mids = segmentMidpoints({ x: 0, y: 0 }, [{ x: 100, y: 0 }], { x: 100, y: 100 });
    expect(mids).toHaveLength(2);
    expect(mids[0]).toEqual({ x: 50, y: 0 });
    expect(mids[1]).toEqual({ x: 100, y: 50 });
  });

  it('does not round a corner past a short segment', () => {
    // A 4px leg cannot take a 10px arc; it must not overshoot into a negative.
    const path = roundedPolyline([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 40 }], 10);
    expect(path).not.toMatch(/-\d/);
  });
});
