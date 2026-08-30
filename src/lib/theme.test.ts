import { describe, expect, it } from 'vitest';

import {
  CANVAS_DARK,
  CANVAS_LIGHT,
  STATUS_COLOR_DARK,
  STATUS_COLOR_LIGHT,
  canvasPalette,
  readableOn,
  statusColors,
} from '../theme';
import type { HealthStatus } from '../types/domain';

const contrast = (hex: string, ground: 'dark' | 'light') => {
  const n = parseInt(hex.slice(1), 16);
  const l = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return ground === 'light' ? 1 - l : l;
};

describe('status colours', () => {
  const statuses: HealthStatus[] = [
    'unknown', 'healthy', 'warning', 'down', 'disabled', 'maintenance',
  ];

  it('has a colour for every status on both grounds', () => {
    for (const s of statuses) {
      expect(STATUS_COLOR_DARK[s]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(STATUS_COLOR_LIGHT[s]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('darkens every meaningful status for the light ground', () => {
    // The point of the exercise. A colour picked to glow on near-black washes
    // out on white; using the same one on both is how a diagram ends up
    // unreadable in a document.
    for (const s of ['healthy', 'warning', 'down', 'maintenance'] as HealthStatus[]) {
      expect(STATUS_COLOR_LIGHT[s]).not.toBe(STATUS_COLOR_DARK[s]);
      expect(contrast(STATUS_COLOR_LIGHT[s]!, 'light')).toBeGreaterThan(0.45);
    }
  });

  it('keeps every status legible on the ground it is for', () => {
    for (const s of ['healthy', 'warning', 'down'] as HealthStatus[]) {
      expect(contrast(STATUS_COLOR_DARK[s]!, 'dark')).toBeGreaterThan(0.35);
      expect(contrast(STATUS_COLOR_LIGHT[s]!, 'light')).toBeGreaterThan(0.45);
    }
  });

  it('keeps the statuses distinguishable from one another', () => {
    // Darkening each colour independently can walk two of them into the same
    // place, and a diagram where warning and down look alike is worse than
    // one that is merely pale.
    const seen = new Set(Object.values(STATUS_COLOR_LIGHT));
    expect(seen.size).toBe(Object.keys(STATUS_COLOR_LIGHT).length);
  });

  it('hands back the right set for each ground', () => {
    expect(statusColors('dark')).toBe(STATUS_COLOR_DARK);
    expect(statusColors('light')).toBe(STATUS_COLOR_LIGHT);
    expect(canvasPalette('light')).toBe(CANVAS_LIGHT);
    expect(canvasPalette('dark')).toBe(CANVAS_DARK);
  });
});

describe('readableOn', () => {
  it('leaves a colour alone when it already reads', () => {
    expect(readableOn('#123456', 'light')).toBe('#123456');
    expect(readableOn('#e8e8e8', 'dark')).toBe('#e8e8e8');
  });

  it('darkens a pale colour for a white ground', () => {
    // Someone picks a bright yellow to stand out on black, then switches the
    // ground. Overriding their choice would lose it; darkening keeps it.
    const out = readableOn('#ffe066', 'light');
    expect(out).not.toBe('#ffe066');
    expect(contrast(out, 'light')).toBeGreaterThan(0.3);
  });

  it('lightens a very dark colour for a black ground', () => {
    const out = readableOn('#101418', 'dark');
    expect(out).not.toBe('#101418');
    expect(contrast(out, 'dark')).toBeGreaterThan(0.15);
  });

  it('is unchanged by being applied twice', () => {
    // The ground can be flipped back and forth all day; a colour must not
    // creep darker each time.
    const once = readableOn('#ffe066', 'light');
    expect(readableOn(once, 'light')).toBe(once);
  });

  it('leaves something that is not a colour alone', () => {
    expect(readableOn('var(--accent)', 'light')).toBe('var(--accent)');
    expect(readableOn('', 'dark')).toBe('');
  });
});
