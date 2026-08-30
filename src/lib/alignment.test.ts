import { describe, expect, it } from 'vitest';

import { alignTo, alignmentFor, distribute, spacingHint, type Box } from './alignment';

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

describe('alignTo', () => {
  it('lines boxes up on their left edges, at the leftmost', () => {
    // Not the average: aligning left means "put them where the left one is".
    const moved = alignTo([box('a', 100, 0), box('b', 140, 100), box('c', 180, 200)], 'left');
    expect([...moved.values()].map((p) => p.x)).toEqual([100, 100]);
    expect(moved.has('a')).toBe(false);
  });

  it('lines them up on their right edges', () => {
    const moved = alignTo([box('a', 0, 0, 100), box('b', 40, 100, 200)], 'right');
    // b ends at 240, so a must end there too.
    expect(moved.get('a')).toEqual({ x: 140, y: 0 });
  });

  it('centres on the middle of the whole span, allowing for width', () => {
    const moved = alignTo([box('a', 0, 0, 100), box('b', 200, 100, 200)], 'centre');
    // Span 0..400, centre 200.
    expect(moved.get('a')).toEqual({ x: 150, y: 0 });
    expect(moved.get('b')).toEqual({ x: 100, y: 100 });
  });

  it('does the same the other way up', () => {
    const moved = alignTo([box('a', 0, 100), box('b', 0, 40)], 'top');
    expect(moved.get('a')).toEqual({ x: 0, y: 40 });
  });

  it('reports only what actually moves', () => {
    // No undo step for a command that did nothing.
    expect(alignTo([box('a', 0, 0), box('b', 0, 100)], 'left').size).toBe(0);
  });

  it('has nothing to do with fewer than two', () => {
    expect(alignTo([box('a', 5, 5)], 'left').size).toBe(0);
  });
});

describe('distribute', () => {
  it('evens the gaps and leaves the ends alone', () => {
    // 100 wide each, from 0 to 500: span 600, occupied 300, so gaps of 150.
    const moved = distribute(
      [box('a', 0, 0), box('b', 130, 0), box('c', 500, 0)],
      'x',
    );
    expect(moved.get('b')).toEqual({ x: 250, y: 0 });
    expect(moved.has('a')).toBe(false);
    expect(moved.has('c')).toBe(false);
  });

  it('measures gaps rather than centres, so a wide box is not crowded', () => {
    const moved = distribute(
      [box('a', 0, 0, 100), box('b', 200, 0, 300), box('c', 900, 0, 100)],
      'x',
    );
    // Span 0..1000, occupied 500, two gaps of 250 each.
    expect(moved.get('b')).toEqual({ x: 350, y: 0 });
  });

  it('works down the page as well as across', () => {
    const moved = distribute([box('a', 0, 0), box('b', 0, 50), box('c', 0, 400)], 'y');
    expect(moved.get('b')!.y).toBeGreaterThan(100);
  });

  it('takes them in the order they sit, not the order they were given', () => {
    const moved = distribute([box('c', 500, 0), box('a', 0, 0), box('b', 130, 0)], 'x');
    expect(moved.get('b')).toEqual({ x: 250, y: 0 });
  });

  it('needs three to have anything to say', () => {
    expect(distribute([box('a', 0, 0), box('b', 400, 0)], 'x').size).toBe(0);
  });
});
