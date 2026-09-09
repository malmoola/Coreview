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
  it('never draws a drawing smaller than one inch to 96 pixels', () => {
    expect(scaleFor([device('a', { width: 2, height: 2 })])).toBe(BASE_SCALE);
  });

  it('opens a drawing out until its smallest device is legible', () => {
    const scale = scaleFor([device('a', { width: 0.2, height: 0.2 })]);
    expect(scale).toBeGreaterThan(BASE_SCALE);
    expect(0.2 * scale).toBeGreaterThanOrEqual(48);
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

  it('keeps a rack of stacked units stacked, and clear of one another', () => {
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
  });

  it('draws every device square, because a glyph is square', () => {
    // Taking the drawing's own proportions gave a rack unit an eleven-to-one
    // node: an enormous flat ellipse for a selection ring, no grabbable length
    // on its links, and a silent resize on the next open when the document
    // migration squared it again.
    const out = placeDevices([
      device('rack', { x: 0, y: 0, width: 2.06, height: 0.185 }),
      device('icon', { x: 5, y: 0 }),
    ]);
    for (const [, p] of out) expect(p.width).toBe(p.height);
  });

  it('still draws a bigger shape bigger', () => {
    // What was worth keeping from the drawing's sizes: a cloud is drawn
    // larger than an access switch, and should arrive larger.
    const out = placeDevices([
      device('cloud', { x: 0, y: 0, width: 1.24, height: 0.72 }),
      device('switch', { x: 4, y: 0, width: 0.69, height: 0.34 }),
    ]);
    expect(out.get('cloud')!.width).toBeGreaterThan(out.get('switch')!.width);
  });

  it('gives a shape with no stated size a sensible one rather than nothing', () => {
    const at = placeDevices([device('a', { x: 2, y: 2 })]).get('a')!;
    expect(at.width).toBe(Math.round(0.6 * BASE_SCALE));
    expect(at.height).toBe(at.width);
  });

  it('never draws a device too small to use or large enough to dwarf the page', () => {
    const out = placeDevices([
      device('tiny', { x: 0, y: 0, width: 0.02, height: 0.02 }),
      device('huge', { x: 9, y: 0, width: 40, height: 40 }),
    ]);
    expect(out.get('tiny')!.width).toBeGreaterThanOrEqual(48);
    expect(out.get('huge')!.width).toBeLessThanOrEqual(140);
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
