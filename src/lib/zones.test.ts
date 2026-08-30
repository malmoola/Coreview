import { describe, expect, it } from 'vitest';

import { contentsOf, isZone, zoneDeltas } from './zones';
import type { TopoNode } from '../state/store';

const node = (id: string, x: number, y: number, over: Record<string, unknown> = {}): TopoNode =>
  ({
    id,
    type: 'device',
    position: { x, y },
    width: 100,
    height: 60,
    data: {
      label: id, deviceType: 'generic', tags: [], addresses: [],
      locked: false, maintenance: false, showDetails: true, ...over,
    },
  }) as TopoNode;

const zone = (id: string, x: number, y: number, w = 400, h = 300): TopoNode =>
  ({
    ...node(id, x, y, { deviceType: 'zone' }),
    width: w,
    height: h,
  }) as TopoNode;

describe('isZone', () => {
  it('knows a section from a device', () => {
    expect(isZone(zone('z', 0, 0))).toBe(true);
    expect(isZone(node('n', 0, 0))).toBe(false);
    expect(isZone(undefined)).toBe(false);
  });
});

describe('contentsOf', () => {
  it('holds what is standing in it', () => {
    const z = zone('z', 0, 0);
    const inside = node('a', 100, 100);
    const outside = node('b', 900, 900);
    expect(contentsOf(z, [z, inside, outside]).map((n) => n.id)).toEqual(['a']);
  });

  it('goes by the middle of a device, not its whole outline', () => {
    // A device half over the border belongs to the side most of it is on.
    // Requiring full containment means one touching the edge silently stops
    // moving with the section it visibly sits in.
    const z = zone('z', 0, 0, 400, 300);
    const straddling = node('a', 360, 100); // 100 wide, so its middle is at 410
    const mostlyIn = node('b', 340, 100); // middle at 390
    expect(contentsOf(z, [z, straddling, mostlyIn]).map((n) => n.id)).toEqual(['b']);
  });

  it('never holds itself', () => {
    const z = zone('z', 0, 0);
    expect(contentsOf(z, [z])).toEqual([]);
  });

  it('holds a smaller section and what is in it', () => {
    const outer = zone('outer', 0, 0, 800, 600);
    const inner = zone('inner', 100, 100, 200, 150);
    const device = node('d', 130, 130);
    expect(contentsOf(outer, [outer, inner, device]).map((n) => n.id).sort()).toEqual([
      'd',
      'inner',
    ]);
  });
});

describe('zoneDeltas', () => {
  it('moves what a section holds by the same amount', () => {
    const z = zone('z', 0, 0);
    const a = node('a', 100, 100);
    const d = zoneDeltas([{ id: 'z', dx: 40, dy: -20 }], [z, a]);
    expect(d.get('a')).toEqual({ dx: 40, dy: -20 });
  });

  it('leaves a locked device where it is', () => {
    const z = zone('z', 0, 0);
    const a = node('a', 100, 100, { locked: true });
    expect(zoneDeltas([{ id: 'z', dx: 40, dy: 0 }], [z, a]).size).toBe(0);
  });

  it('does nothing when a plain device is dragged', () => {
    const z = zone('z', 0, 0);
    const a = node('a', 100, 100);
    expect(zoneDeltas([{ id: 'a', dx: 40, dy: 0 }], [z, a]).size).toBe(0);
  });

  it('moves a device held by two sections only once', () => {
    // Both sections were dragged together. Adding both deltas would send the
    // device twice as far as either section went.
    const outer = zone('outer', 0, 0, 800, 600);
    const inner = zone('inner', 50, 50, 400, 300);
    const a = node('a', 100, 100);
    const d = zoneDeltas(
      [
        { id: 'outer', dx: 30, dy: 0 },
        { id: 'inner', dx: 30, dy: 0 },
      ],
      [outer, inner, a],
    );
    expect(d.get('a')).toEqual({ dx: 30, dy: 0 });
  });

  it('ignores a drag that went nowhere', () => {
    const z = zone('z', 0, 0);
    const a = node('a', 100, 100);
    expect(zoneDeltas([{ id: 'z', dx: 0, dy: 0 }], [z, a]).size).toBe(0);
  });
});
