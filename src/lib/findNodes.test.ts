import { describe, expect, it } from 'vitest';

import { findNodes } from './findNodes';
import type { TopoNode } from '../state/store';

const device = (id: string, label: string, over: Record<string, unknown> = {}): TopoNode =>
  ({
    id,
    type: 'device',
    position: { x: 0, y: 0 },
    data: {
      label,
      deviceType: 'generic',
      tags: [],
      addresses: [],
      locked: false,
      maintenance: false,
      showDetails: true,
      ...over,
    },
  }) as TopoNode;

const withAddress = (id: string, label: string, ip: string) =>
  device(id, label, { addresses: [{ id: 'a', label: 'Mgmt', address: ip, isPrimary: true }] });

describe('findNodes', () => {
  it('finds a device by part of its name', () => {
    const nodes = [device('1', 'CORE-SW-01'), device('2', 'ACC-SW-14')];
    expect(findNodes(nodes, 'core').map((m) => m.id)).toEqual(['1']);
  });

  it('finds one by address, which is often what is in someone’s head', () => {
    const nodes = [withAddress('1', 'CORE-SW-01', '192.168.14.7')];
    const hits = findNodes(nodes, '14.7');
    expect(hits[0]!.id).toBe('1');
    expect(hits[0]!.matchedOn).toBe('address');
  });

  it('puts an exact name first', () => {
    // Typing a full hostname means that device, not the six that contain it.
    const nodes = [device('1', 'SW-1-EXTRA'), device('2', 'SW-1'), device('3', 'OLD-SW-1-B')];
    expect(findNodes(nodes, 'sw-1')[0]!.id).toBe('2');
  });

  it('prefers a prefix over a match buried in the middle', () => {
    const nodes = [device('1', 'OLD-CORE-SW'), device('2', 'CORE-SW-02')];
    expect(findNodes(nodes, 'core')[0]!.id).toBe('2');
  });

  it('matches a model or a tag when the name says nothing', () => {
    const nodes = [
      device('1', 'Unnamed', { model: 'WS-C2960CX-8PC-L' }),
      device('2', 'Other', { tags: ['site-b', 'edge'] }),
    ];
    expect(findNodes(nodes, '2960')[0]!.matchedOn).toBe('model');
    expect(findNodes(nodes, 'site-b')[0]!.matchedOn).toBe('tag');
  });

  it('searches notes, and says which line matched', () => {
    const note = {
      id: 'n',
      type: 'note',
      position: { x: 0, y: 0 },
      data: { title: 'Rollback', body: 'step one\nrestore the core config\nstep three' },
    } as unknown as TopoNode;
    const hit = findNodes([note], 'restore')[0]!;
    expect(hit.matchedOn).toBe('note');
    expect(hit.detail).toBe('restore the core config');
  });

  it('returns nothing for an empty query rather than everything', () => {
    // A search box that shows the whole diagram the moment it is focused is
    // noise, not a result.
    expect(findNodes([device('1', 'CORE-SW')], '')).toEqual([]);
    expect(findNodes([device('1', 'CORE-SW')], '   ')).toEqual([]);
  });

  it('ignores case', () => {
    expect(findNodes([device('1', 'Core-SW')], 'CORE')).toHaveLength(1);
  });

  it('caps how many it returns', () => {
    const many = Array.from({ length: 50 }, (_, i) => device(String(i), `SW-${i}`));
    expect(findNodes(many, 'sw', 5)).toHaveLength(5);
  });
});
