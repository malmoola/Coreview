import { describe, expect, it } from 'vitest';
import { bezierPath } from './bezierPath';

const base = {
  sourceX: 0, sourceY: 0, targetX: 400, targetY: 200,
  sourcePosition: 'right' as const, targetPosition: 'left' as const,
};

/** The control points out of a "M.. C c1x,c1y c2x,c2y .." path. */
const controls = (d: string) => {
  const n = d.match(/-?\d*\.?\d+/g)!.map(Number);
  return { c1x: n[2]!, c1y: n[3]!, c2x: n[4]!, c2y: n[5]! };
};

describe('bezierPath (LT-072)', () => {
  it('a bigger curvature pushes the control points further out', () => {
    const small = controls(bezierPath({ ...base, curvature: 0.2 })[0]);
    const big = controls(bezierPath({ ...base, curvature: 1.2 })[0]);
    expect(big.c1x).toBeGreaterThan(small.c1x);
    expect(big.c2x).toBeLessThan(small.c2x);
  });

  it('every curvature really produces a different path — the bug it fixes', () => {
    const paths = [0, 0.25, 0.5, 1, 2].map((c) => bezierPath({ ...base, curvature: c })[0]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('leaves each end along the side its handle is on', () => {
    const c = controls(bezierPath({ ...base, curvature: 0.5 })[0]);
    // Source leaves rightwards, target arrives from its left side.
    expect(c.c1x).toBeGreaterThan(base.sourceX);
    expect(c.c1y).toBe(base.sourceY);
    expect(c.c2x).toBeLessThan(base.targetX);
    expect(c.c2y).toBe(base.targetY);
  });

  it('a vertical pair bows along y', () => {
    const [, , ly] = bezierPath({
      sourceX: 0, sourceY: 0, targetX: 0, targetY: 300,
      sourcePosition: 'bottom', targetPosition: 'top', curvature: 0.5,
    });
    expect(ly).toBeGreaterThan(0);
    expect(ly).toBeLessThan(300);
  });

  it('reports the midpoint of the curve for the label', () => {
    const [, lx, ly] = bezierPath({ ...base, curvature: 0.5 });
    expect(lx).toBeGreaterThan(0);
    expect(lx).toBeLessThan(400);
    expect(ly).toBeGreaterThan(0);
    expect(ly).toBeLessThan(200);
  });
});
