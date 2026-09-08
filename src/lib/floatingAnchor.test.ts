import { describe, expect, it } from 'vitest';

import {
  anchorPoint,
  bearingAnchor,
  centreOf,
  nearestAnchorOnBox,
  nearestSide,
} from './floatingAnchor';

const box = { x: 100, y: 200, w: 80, h: 40 };

describe('anchorPoint', () => {
  it('places the top-left corner at the box origin', () => {
    expect(anchorPoint(box, { x: 0, y: 0 })).toEqual({ x: 100, y: 200 });
  });

  it('places the bottom-right corner at the box extent', () => {
    expect(anchorPoint(box, { x: 1, y: 1 })).toEqual({ x: 180, y: 240 });
  });

  it('places the middle of the right edge halfway down', () => {
    expect(anchorPoint(box, { x: 1, y: 0.5 })).toEqual({ x: 180, y: 220 });
  });
});

describe('bearingAnchor (LT-107)', () => {
  // A square, so a 45° bearing is unambiguous between the two outlines.
  const sq = { x: 0, y: 0, w: 100, h: 100 };

  it('meets a shape on the side the other device is actually on', () => {
    expect(bearingAnchor(sq, { x: 500, y: 50 }, false)).toEqual({ x: 1, y: 0.5 });
    expect(bearingAnchor(sq, { x: -500, y: 50 }, false)).toEqual({ x: 0, y: 0.5 });
    expect(bearingAnchor(sq, { x: 50, y: -500 }, false)).toEqual({ x: 0.5, y: 0 });
    expect(bearingAnchor(sq, { x: 50, y: 500 }, false)).toEqual({ x: 0.5, y: 1 });
  });

  it('answers a diagonal with a diagonal, which four fixed handles cannot', () => {
    // Down and to the left — the case reproduced from the Core switch, where
    // the old behaviour left sideways out of the fixed left handle.
    const a = bearingAnchor(sq, { x: -500, y: 500 }, false);
    expect(a.x).toBeLessThan(0.5);
    expect(a.y).toBeGreaterThan(0.5);
    // Measured from the box's own centre (50,50), so exactly 45° down-left is
    // (-450, 550) — and only that meets the corner.
    expect(bearingAnchor(sq, { x: -450, y: 550 }, false)).toEqual({ x: 0, y: 1 });
  });

  it('keeps a round glyph on its circle rather than out at the box corner', () => {
    const box = bearingAnchor(sq, { x: 500, y: 500 }, false);
    const round = bearingAnchor(sq, { x: 500, y: 500 }, true);
    // The rectangle sends a 45° link to the corner; the ellipse keeps it on
    // the drawn circle, which is nearer the centre in both axes.
    expect(box).toEqual({ x: 1, y: 1 });
    expect(round.x).toBeCloseTo(0.5 + Math.SQRT1_2 / 2, 6);
    expect(round.y).toBeCloseTo(0.5 + Math.SQRT1_2 / 2, 6);
    expect(round.x).toBeLessThan(box.x);
  });

  it('follows the bearing round the shape as the other end moves', () => {
    // The point is not chosen once and kept — it is a function of where the
    // far end is, which is the whole of "anywhere I move the link it moves".
    const seen = [
      bearingAnchor(sq, { x: 500, y: 50 }, true),
      bearingAnchor(sq, { x: 400, y: 300 }, true),
      bearingAnchor(sq, { x: 50, y: 500 }, true),
    ];
    const ys = seen.map((a) => a.y);
    expect(ys[0]!).toBeLessThan(ys[1]!);
    expect(ys[1]!).toBeLessThan(ys[2]!);
  });

  it('lands on the outline it was given, not somewhere inside it', () => {
    for (const toward of [
      { x: 900, y: 20 },
      { x: -40, y: 700 },
      { x: 12, y: -300 },
    ]) {
      const r = bearingAnchor(sq, toward, true);
      // On the unit ellipse: the normalised radius is 1 from the centre.
      expect(Math.hypot((r.x - 0.5) * 2, (r.y - 0.5) * 2)).toBeCloseTo(1, 6);
    }
  });

  it('does not divide by zero on concentric shapes or a zero-sized box', () => {
    expect(bearingAnchor(sq, centreOf(sq), true)).toEqual({ x: 1, y: 0.5 });
    expect(bearingAnchor({ x: 0, y: 0, w: 0, h: 0 }, { x: 9, y: 9 }, true)).toEqual({ x: 1, y: 0.5 });
  });

  it('handles a non-square box without distorting the bearing', () => {
    // Wide box, target straight down: still the bottom middle.
    const wide = { x: 0, y: 0, w: 200, h: 40 };
    expect(bearingAnchor(wide, { x: 100, y: 900 }, false)).toEqual({ x: 0.5, y: 1 });
  });
});

describe('nearestSide', () => {
  it('picks top for a point pinned to y=0', () => {
    expect(nearestSide({ x: 0.5, y: 0 })).toBe('t');
  });
  it('picks bottom for a point pinned to y=1', () => {
    expect(nearestSide({ x: 0.5, y: 1 })).toBe('b');
  });
  it('picks left for a point pinned to x=0', () => {
    expect(nearestSide({ x: 0, y: 0.5 })).toBe('l');
  });
  it('picks right for a point pinned to x=1', () => {
    expect(nearestSide({ x: 1, y: 0.5 })).toBe('r');
  });
});

describe('nearestAnchorOnBox', () => {
  it('projects a point above the box onto its top edge', () => {
    expect(nearestAnchorOnBox(box, { x: 140, y: 150 })).toEqual({ x: 0.5, y: 0 });
  });

  it('projects a point to the right of the box onto its right edge', () => {
    expect(nearestAnchorOnBox(box, { x: 300, y: 220 })).toEqual({ x: 1, y: 0.5 });
  });

  it('projects a point inside the box onto its nearest edge, not the middle', () => {
    // Closer to the left edge (40px away) than the top (30px) or bottom (10px) —
    // wait, pick a point unambiguously closest to one edge.
    const p = { x: 105, y: 220 }; // 5px from left, 20px from top/bottom
    expect(nearestAnchorOnBox(box, p)).toEqual({ x: 0, y: 0.5 });
  });

  it('clamps a point beyond a corner to that corner', () => {
    expect(nearestAnchorOnBox(box, { x: 300, y: 500 })).toEqual({ x: 1, y: 1 });
  });

  it('round-trips through anchorPoint back to a point on the box', () => {
    const a = nearestAnchorOnBox(box, { x: 140, y: 150 });
    const p = anchorPoint(box, a);
    expect(p.y).toBe(box.y);
  });
});
