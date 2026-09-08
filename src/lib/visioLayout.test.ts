import { describe, expect, it } from 'vitest';

import type { ImportedDevice } from './ipc';
import { BASE_SCALE, placeDevices, scaleFor } from './visioLayout';

const device = (id: string, over: Partial<ImportedDevice> = {}): ImportedDevice => ({
  id,
  label: id,
  addresses: [],
  deviceType: 'router',
  model: 'Router',
  properties: {},
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  ...over,
});

describe('scaleFor', () => {
  it('leaves a drawing of ordinary icons at one inch to 96 pixels', () => {
    expect(scaleFor([device('a', { width: 0.69, height: 0.34 })])).toBe(BASE_SCALE);
  });

  it('opens a drawing out until its flattest shape is still legible', () => {
    // A rack unit is a fifth of an inch tall. At 96px to the inch it is 18px
    // high and four of them stacked are a pile, whatever size they are drawn.
    const scale = scaleFor([device('a', { width: 2.06, height: 0.185 })]);
    expect(scale).toBeGreaterThan(BASE_SCALE);
    expect(0.185 * scale).toBeGreaterThanOrEqual(32);
  });

  it('does not blow the page up to fit one hairline', () => {
    expect(scaleFor([device('a', { width: 3, height: 0.001 })])).toBe(BASE_SCALE * 3);
  });

  it('falls back to 1:1 for a drawing that states no sizes', () => {
    expect(scaleFor([])).toBe(BASE_SCALE);
  });
});

describe('placeDevices', () => {
  it('places a shape by its centre, not its corner', () => {
    // Visio's pin is the middle of the shape. Treating it as the top-left
    // shifts every device by half its own size.
    const at = placeDevices([device('a', { x: 5, y: 5, width: 1, height: 1 })]).get('a')!;
    expect(at).toEqual({ x: 0, y: 0, width: 96, height: 96 });
  });

  it('flips the Y axis, since Visio measures up and the canvas measures down', () => {
    const out = placeDevices([
      device('top', { x: 1, y: 10, width: 0.5, height: 0.5 }),
      device('bottom', { x: 1, y: 4, width: 0.5, height: 0.5 }),
    ]);
    expect(out.get('top')!.y).toBe(0);
    expect(out.get('bottom')!.y).toBe(6 * BASE_SCALE);
  });

  it('keeps a rack of stacked units stacked rather than piled', () => {
    // Four switches a fifth of an inch apart in the drawing. They must come
    // out one above the other and not on top of each other.
    const rack = [0, 1, 2, 3].map((i) =>
      device(`u${i}`, { x: 16.7, y: 17 - i * 0.185, width: 2.06, height: 0.185 }),
    );
    const out = placeDevices(rack);
    const ys = [0, 1, 2, 3].map((i) => out.get(`u${i}`)!.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    const unit = out.get('u0')!.height;
    for (let i = 1; i < ys.length; i += 1) {
      expect((ys[i] ?? 0) - (ys[i - 1] ?? 0)).toBeGreaterThanOrEqual(unit);
    }
    // And they stay the shape the drawing made them: wide, not square.
    expect(out.get('u0')!.width).toBeGreaterThan(out.get('u0')!.height * 5);
  });

  it('gives a shape with no stated size a sensible one rather than nothing', () => {
    const at = placeDevices([device('a', { x: 2, y: 2 })]).get('a')!;
    expect(at.width).toBe(Math.round(0.6 * BASE_SCALE));
    expect(at.height).toBe(at.width);
  });

  it('starts the drawing at the origin so nothing lands off-canvas', () => {
    const out = placeDevices([
      device('a', { x: 20, y: 20, width: 1, height: 1 }),
      device('b', { x: 24, y: 18, width: 1, height: 1 }),
    ]);
    expect(Math.min(out.get('a')!.x, out.get('b')!.x)).toBe(0);
    expect(Math.min(out.get('a')!.y, out.get('b')!.y)).toBe(0);
  });

  it('has nothing to place for an empty page', () => {
    expect(placeDevices([]).size).toBe(0);
  });
});
