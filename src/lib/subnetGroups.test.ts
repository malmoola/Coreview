import { describe, expect, it } from 'vitest';

import { groupBySubnet, subnetOf } from './subnetGroups';
import type { TopoNode } from '../state/store';

const device = (id: string, address: string | null): TopoNode =>
  ({
    id,
    type: 'device',
    position: { x: 0, y: 0 },
    data: {
      label: id,
      deviceType: 'generic',
      tags: [],
      addresses: address ? [{ id: 'a', label: 'Mgmt', address, isPrimary: true }] : [],
      locked: false,
      maintenance: false,
      showDetails: true,
    },
  }) as TopoNode;

describe('subnetOf', () => {
  it('reduces an address to its /24', () => {
    expect(subnetOf('192.168.14.7')).toBe('192.168.14.0/24');
    expect(subnetOf('10.2.80.199')).toBe('10.2.80.0/24');
  });

  it('rejects what is not an address', () => {
    // Number('') is 0, so a trailing dot would otherwise pass.
    expect(subnetOf('10.0.0.')).toBeNull();
    expect(subnetOf('10.0.0')).toBeNull();
    expect(subnetOf('10.0.0.256')).toBeNull();
    expect(subnetOf('example.local')).toBeNull();
    expect(subnetOf('')).toBeNull();
  });
});

describe('groupBySubnet', () => {
  it('puts each network in its own group', () => {
    const g = groupBySubnet([
      device('a', '192.168.14.7'),
      device('b', '192.168.14.9'),
      device('c', '10.2.80.1'),
      device('d', '10.2.80.2'),
    ]);
    expect(g.subnets).toEqual(['10.2.80.0/24', '192.168.14.0/24']);
    expect(g.assignments.get('a')).toBe(g.assignments.get('b'));
    expect(g.assignments.get('c')).toBe(g.assignments.get('d'));
    expect(g.assignments.get('a')).not.toBe(g.assignments.get('c'));
  });

  it('leaves a subnet holding one device alone', () => {
    // A group of one moves exactly as it did before and only makes the
    // diagram harder to reason about.
    const g = groupBySubnet([device('a', '192.168.14.7'), device('b', '10.9.9.9')]);
    expect(g.subnets).toEqual([]);
    expect(g.assignments.size).toBe(0);
    expect(g.ungrouped).toBe(2);
  });

  it('counts what it could not place', () => {
    const g = groupBySubnet([
      device('a', '192.168.14.7'),
      device('b', '192.168.14.8'),
      device('c', null),
      device('d', 'printer.local'),
    ]);
    expect(g.assignments.size).toBe(2);
    expect(g.ungrouped).toBe(2);
  });

  it('ignores notes and other non-devices', () => {
    const note = { id: 'n', type: 'note', position: { x: 0, y: 0 }, data: {} } as unknown as TopoNode;
    const g = groupBySubnet([device('a', '10.0.0.1'), device('b', '10.0.0.2'), note]);
    expect(g.assignments.size).toBe(2);
    expect(g.ungrouped).toBe(0);
  });

  it('handles an empty diagram', () => {
    const g = groupBySubnet([]);
    expect(g.subnets).toEqual([]);
    expect(g.ungrouped).toBe(0);
  });
});
