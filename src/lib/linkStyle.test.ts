import { describe, expect, it } from 'vitest';

import { capPath, capsFor, dashFor } from './linkStyle';

describe('dashFor', () => {
  it('keeps the health meaning when nothing has been chosen', () => {
    // Every diagram drawn before the choice existed must look the same.
    expect(dashFor(undefined, 'down')).toBe('10 6');
    expect(dashFor(undefined, 'healthy')).toBeUndefined();
    expect(dashFor('auto', 'disabled')).toBe('2 6');
  });

  it('lets a chosen style win over the health meaning', () => {
    // A dashed line means a tunnel here, and a healthy tunnel is still a
    // tunnel.
    expect(dashFor('dashed', 'healthy')).toBe('10 6');
    expect(dashFor('solid', 'down')).toBeUndefined();
  });

  it('has a distinct pattern for each style', () => {
    const seen = new Set(
      (['solid', 'dashed', 'dotted', 'dash-dot'] as const).map((s) => String(dashFor(s, 'healthy'))),
    );
    expect(seen.size).toBe(4);
  });
});

describe('capsFor', () => {
  it('follows the flow direction when nothing is chosen', () => {
    expect(capsFor({ direction: 'forward' })).toEqual({ start: 'none', end: 'arrow' });
    expect(capsFor({ direction: 'reverse' })).toEqual({ start: 'arrow', end: 'none' });
    expect(capsFor({ direction: 'both' })).toEqual({ start: 'arrow', end: 'arrow' });
    expect(capsFor({ direction: 'none' })).toEqual({ start: 'none', end: 'none' });
  });

  it('lets an explicit cap win', () => {
    expect(capsFor({ direction: 'forward', endCap: 'circle' }).end).toBe('circle');
    expect(capsFor({ direction: 'none', startCap: 'diamond' }).start).toBe('diamond');
  });

  it('honours an explicit none on a link the direction would have arrowed', () => {
    // Otherwise there is no way to take the arrow off one end of a link that
    // still carries a direction for the animation.
    expect(capsFor({ direction: 'both', endCap: 'none' }).end).toBe('none');
  });

  it('treats a link with no direction at all as forward, as it always did', () => {
    expect(capsFor({})).toEqual({ start: 'none', end: 'arrow' });
  });
});

describe('capPath', () => {
  it('draws nothing for none', () => {
    expect(capPath('none')).toBeNull();
  });

  it('has geometry for every cap that is not none', () => {
    for (const cap of ['arrow', 'open-arrow', 'circle', 'square', 'diamond'] as const) {
      const p = capPath(cap);
      expect(p, cap).not.toBeNull();
      expect(p!.d.length).toBeGreaterThan(6);
    }
  });

  it('leaves the open arrow unfilled, which is what makes it open', () => {
    expect(capPath('open-arrow')!.filled).toBe(false);
    expect(capPath('arrow')!.filled).toBe(true);
  });
});
