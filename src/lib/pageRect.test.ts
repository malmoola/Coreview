import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PAGE, effectivePage, pageForContent, sameRect, unionRect,
} from './pageRect';
import type { TopoNode } from '../state/store';

const at = (id: string, x: number, y: number, w = 168, h = 92): TopoNode =>
  ({ id, type: 'device', position: { x, y }, width: w, height: h,
     data: { label: id, deviceType: 'generic', tags: [], addresses: [],
       locked: false, maintenance: false, showDetails: true } }) as TopoNode;

describe('pageForContent', () => {
  it('is the default sheet for an empty diagram', () => {
    expect(pageForContent([])).toEqual(DEFAULT_PAGE);
  });

  it('is never smaller than the default sheet', () => {
    // Four devices in the middle do not deserve a postage stamp.
    expect(pageForContent([at('a', 400, 400)])).toEqual(DEFAULT_PAGE);
  });

  it('gives content near an edge its margin, even inside the default sheet', () => {
    // The margin is the rule: a device 100px from the top has less than the
    // 120px it is owed, so the sheet grows a step upward.
    const r = pageForContent([at('a', 400, 100)]);
    expect(r.y).toBe(-60);
  });

  it('grows to hold a device past the right edge, margin included', () => {
    const r = pageForContent([at('a', 2000, 400)]);
    // 2000+168+120 = 2288, snapped up to 2340.
    expect(r.x).toBe(0);
    expect(r.w).toBe(2340);
    expect(r.h).toBe(DEFAULT_PAGE.h);
  });

  it('grows leftward and upward for content at negative coordinates', () => {
    const r = pageForContent([at('a', -500, -300)]);
    // -500-120 = -620, snapped down to -660; -300-120=-420 -> -420 (already a
    // multiple of 60).
    expect(r.x).toBe(-660);
    expect(r.y).toBe(-420);
    expect(r.x + r.w).toBe(DEFAULT_PAGE.w);
  });

  it('snaps outward in whole grid steps, not pixel by pixel', () => {
    const a = pageForContent([at('a', 1584 - 168 + 1, 400)]);
    const b = pageForContent([at('a', 1584 - 168 + 30, 400)]);
    // Two positions inside the same step give the same page.
    expect(a.w % 60).toBe(0);
    expect(a.w).toBe(b.w);
  });
});

describe('effectivePage', () => {
  it('never shrinks on its own', () => {
    // The page grew to hold something; deleting that something must not snap
    // the sheet smaller — that is the explicit fit-to-content action.
    const grown = { x: 0, y: 0, w: 3000, h: 1224 };
    expect(effectivePage(grown, [at('a', 400, 400)])).toEqual(grown);
  });

  it('grows past what was stored when content demands it', () => {
    const grown = { x: 0, y: 0, w: 3000, h: 1224 };
    const r = effectivePage(grown, [at('a', 400, 2000)]);
    expect(r.w).toBe(3000);
    expect(r.h).toBeGreaterThan(2000);
  });

  it('starts from the default when nothing is stored', () => {
    expect(effectivePage(undefined, [])).toEqual(DEFAULT_PAGE);
  });
});

describe('unionRect and sameRect', () => {
  it('unions across mixed origins', () => {
    expect(unionRect({ x: -60, y: 0, w: 100, h: 100 }, { x: 0, y: -60, w: 200, h: 100 }))
      .toEqual({ x: -60, y: -60, w: 260, h: 160 });
  });

  it('compares by value', () => {
    expect(sameRect(DEFAULT_PAGE, { ...DEFAULT_PAGE })).toBe(true);
    expect(sameRect(DEFAULT_PAGE, { ...DEFAULT_PAGE, w: 1 })).toBe(false);
  });
});
