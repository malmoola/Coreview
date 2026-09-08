import { describe, expect, it } from 'vitest';

import { anchorPoint, nearestAnchorOnBox, nearestSide } from './floatingAnchor';

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
