import { describe, expect, it } from 'vitest';

import { colourForKey, keyFor, keyForData, legendFor } from './tinting';
import type { TopoNode } from '../state/store';

const device = (id: string, over: Record<string, unknown> = {}): TopoNode =>
  ({
    id, type: 'device', position: { x: 0, y: 0 },
    data: {
      label: id, deviceType: 'access-switch', tags: [], addresses: [],
      locked: false, maintenance: false, showDetails: true, ...over,
    },
  }) as TopoNode;

const withAddress = (id: string, ip: string) =>
  device(id, { addresses: [{ id: 'a', label: 'Mgmt', address: ip, isPrimary: true }] });

describe('keyFor', () => {
  it('groups by the /24 a device is on', () => {
    expect(keyFor(withAddress('a', '10.0.14.7'), 'subnet')).toBe('10.0.14.0/24');
  });

  it('says nothing for a device with no address', () => {
    expect(keyFor(device('a'), 'subnet')).toBeNull();
  });

  it('groups by what a device is', () => {
    expect(keyFor(device('a', { deviceType: 'firewall' }), 'role')).toBe('firewall');
  });

  it('groups by the first tag somebody chose', () => {
    // The crawler's own tags say how a device was found, not what it is or
    // where, and would colour the whole diagram one shade.
    const n = device('a', { tags: ['discovered', 'seen-only', 'site-hq', 'core'] });
    expect(keyFor(n, 'tag')).toBe('site-hq');
  });

  it('says nothing when every tag is the crawler own', () => {
    expect(keyFor(device('a', { tags: ['discovered', 'attached'] }), 'tag')).toBeNull();
  });

  it('says nothing at all when colouring by health', () => {
    expect(keyFor(withAddress('a', '10.0.0.1'), 'health')).toBeNull();
  });
});

describe('colourForKey', () => {
  it('gives the same key the same colour every time', () => {
    // Assigned from the key, not from a position in a list — otherwise adding
    // one device repaints every other one and the colours stop meaning
    // anything.
    const first = colourForKey('10.0.14.0/24', 'dark');
    expect(colourForKey('10.0.14.0/24', 'dark')).toBe(first);
  });

  it('gives different keys different colours, mostly', () => {
    const keys = ['10.0.1.0/24', '10.0.2.0/24', '10.0.3.0/24', '192.168.14.0/24'];
    const seen = new Set(keys.map((k) => colourForKey(k, 'dark')));
    expect(seen.size).toBeGreaterThan(2);
  });

  it('has a colour set for each ground', () => {
    expect(colourForKey('a', 'light')).not.toBe(colourForKey('a', 'dark'));
  });
});

describe('legendFor', () => {
  const nodes = [
    withAddress('a', '10.0.1.5'),
    withAddress('b', '10.0.1.9'),
    withAddress('c', '10.0.2.4'),
    device('d'),
  ];

  it('lists every group with how many are in it', () => {
    const legend = legendFor(nodes, 'subnet', 'dark');
    expect(legend.map((l) => [l.key, l.count])).toEqual([
      ['10.0.1.0/24', 2],
      ['10.0.2.0/24', 1],
    ]);
  });

  it('sorts by name so it does not reorder when a device is added', () => {
    const grown = legendFor([...nodes, withAddress('e', '10.0.0.1')], 'subnet', 'dark');
    expect(grown.map((l) => l.key)).toEqual(['10.0.0.0/24', '10.0.1.0/24', '10.0.2.0/24']);
  });

  it('sorts addresses the way a person reads them', () => {
    const many = [withAddress('a', '10.0.10.1'), withAddress('b', '10.0.2.1')];
    expect(legendFor(many, 'subnet', 'dark').map((l) => l.key)).toEqual([
      '10.0.2.0/24',
      '10.0.10.0/24',
    ]);
  });

  it('has nothing to show when colouring by health', () => {
    expect(legendFor(nodes, 'health', 'dark')).toEqual([]);
  });
});

describe('colour by VLAN (LT-027)', () => {
  const dev = (over: Record<string, unknown>) => ({
    label: 'x', deviceType: 'generic', tags: [], addresses: [],
    locked: false, maintenance: false, showDetails: true, ...over,
  }) as never;

  it('groups a device by the VLAN it was learned on', () => {
    expect(keyForData(dev({ vlan: '20' }), 'vlan')).toBe('VLAN 20');
  });

  it('a device with no VLAN is left uncoloured', () => {
    expect(keyForData(dev({}), 'vlan')).toBeNull();
  });
});
