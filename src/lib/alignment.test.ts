import { describe, expect, it } from 'vitest';

import { alignmentFor, spacingHint, type Box } from './alignment';

const box = (id: string, x: number, y: number, w = 100, h = 60): Box => ({ id, x, y, w, h });

describe('alignmentFor', () => {
  it('leaves a box alone when nothing is near', () => {
    const a = alignmentFor(box('a', 0, 0), [box('b', 500, 500)]);
    expect(a).toEqual({ x: 0, y: 0, guides: [] });
  });

  it('snaps a left edge into line with another left edge', () => {
    const a = alignmentFor(box('a', 203, 300), [box('b', 200, 0)]);
    expect(a.x).toBe(200);
    expect(a.y).toBe(300);
  });

  it('snaps centres to centres', () => {
    // Two devices of different widths that look centred should be centred.
    const wide = box('b', 100, 0, 200, 60); // centre at 200
    const a = alignmentFor(box('a', 152, 300, 100, 60), [wide]); // centre at 202
    expect(a.x).toBe(150);
  });

  it('does not line a left edge up with a right edge', () => {
    // Snapping whichever edge happens to be nearest produces a jump nobody
    // can predict. Only like to like.
    const a = alignmentFor(box('a', 302, 300), [box('b', 200, 0, 100, 60)]);
    expect(a.x).toBe(302);
  });

  it('takes the nearest of several candidates', () => {
    const a = alignmentFor(box('a', 204, 300), [box('b', 200, 0), box('c', 205, 100)]);
    expect(a.x).toBe(205);
  });

  it('snaps both axes at once', () => {
    const a = alignmentFor(box('a', 203, 402), [box('b', 200, 0), box('c', 900, 400)]);
    expect(a).toMatchObject({ x: 200, y: 400 });
    expect(a.guides).toHaveLength(2);
  });

  it('draws a guide that reaches both boxes and no further', () => {
    // A line across the whole canvas says something is aligned; this says
    // what it is aligned with.
    const a = alignmentFor(box('a', 203, 300), [box('b', 200, 0)]);
    const guide = a.guides.find((g) => g.orientation === 'vertical');
    expect(guide).toBeDefined();
    expect(guide!.at).toBe(200);
    expect(guide!.from).toBe(0);
    expect(guide!.to).toBe(360);
  });

  it('never lines a box up with itself', () => {
    const self = box('a', 200, 300);
    expect(alignmentFor(self, [self]).guides).toEqual([]);
  });

  it('respects the tolerance it is given', () => {
    // At a quarter zoom, ten screen pixels is forty diagram units; a snap
    // that grabs from that far feels like the box is being taken away.
    expect(alignmentFor(box('a', 210, 300), [box('b', 200, 0)], 6).x).toBe(210);
    expect(alignmentFor(box('a', 210, 300), [box('b', 200, 0)], 12).x).toBe(200);
  });
});

describe('spacingHint', () => {
  it('suggests the gap that matches the one already there', () => {
    // Two boxes 100 apart at 0 and 200 (width 100). The next one belongs at
    // 400, and a drag that lands at 397 should be pulled to it.
    const hint = spacingHint(box('c', 397, 0), [box('a', 0, 0), box('b', 200, 0)], 'x');
    expect(hint).toBe(400);
  });

  it('works before a row as well as after it', () => {
    const hint = spacingHint(box('c', -197, 0), [box('a', 0, 0), box('b', 200, 0)], 'x');
    expect(hint).toBe(-200);
  });

  it('says nothing when there is no row to match', () => {
    expect(spacingHint(box('c', 397, 0), [box('a', 0, 0)], 'x')).toBeNull();
  });

  it('ignores boxes that are not on the same row', () => {
    // Two devices in a different tier are not a spacing pattern for this one.
    expect(spacingHint(box('c', 397, 0), [box('a', 0, 900), box('b', 200, 900)], 'x')).toBeNull();
  });

  it('says nothing when the drag is nowhere near the rhythm', () => {
    expect(spacingHint(box('c', 340, 0), [box('a', 0, 0), box('b', 200, 0)], 'x')).toBeNull();
  });
});
