import { describe, expect, it } from 'vitest';

import type { DeviceType } from '../types/domain';
import { hierarchicalLayout, tiersFor, type HierarchyNode } from './hierarchyLayout';

const node = (id: string, deviceType: DeviceType, over: Partial<HierarchyNode> = {}): HierarchyNode => ({
  id, deviceType, width: 76, height: 76, ...over,
});
const edge = (source: string, target: string) => ({ source, target });

describe('tiersFor', () => {
  it('puts the internet above the edge, and the edge above the core', () => {
    const nodes = [node('net', 'internet'), node('fw', 'firewall'), node('core', 'core-switch'),
      node('acc', 'access-switch')];
    const t = tiersFor(nodes, [edge('net', 'fw'), edge('fw', 'core'), edge('core', 'acc')]);
    expect(t.get('net')).toBeLessThan(t.get('fw')!);
    expect(t.get('fw')).toBeLessThan(t.get('core')!);
    expect(t.get('core')).toBeLessThan(t.get('acc')!);
  });

  it('reads a device the type does not describe from what it plugs into', () => {
    // An imported shape, or anything left `generic`. The cabling is the only
    // thing that says where it belongs.
    const nodes = [node('core', 'core-switch'), node('mystery', 'generic')];
    const t = tiersFor(nodes, [edge('core', 'mystery')]);
    expect(t.get('mystery')).toBeGreaterThan(t.get('core')!);
  });

  it('resolves a chain of devices that none of the types describe', () => {
    const nodes = [node('core', 'core-switch'), node('a', 'generic'), node('b', 'generic')];
    const t = tiersFor(nodes, [edge('core', 'a'), edge('a', 'b')]);
    expect(t.get('a')).toBeGreaterThan(t.get('core')!);
    expect(t.get('b')).toBeGreaterThan(t.get('a')!);
  });

  it('sends an isolated unknown to the bottom rather than into the middle', () => {
    const nodes = [node('net', 'internet'), node('core', 'core-switch'), node('orphan', 'generic')];
    const t = tiersFor(nodes, [edge('net', 'core')]);
    expect(t.get('orphan')).toBeGreaterThan(t.get('core')!);
  });

  it('closes the gap a missing layer would leave', () => {
    // Internet straight to access switches, no firewall and no core. The
    // access switches belong directly under the internet, not four bands down
    // with empty space where the missing kit would have gone.
    const nodes = [node('net', 'internet'), node('a1', 'access-switch'), node('a2', 'access-switch')];
    const t = tiersFor(nodes, [edge('net', 'a1'), edge('net', 'a2')]);
    expect([...new Set(t.values())].sort()).toEqual([0, 1]);
  });
});

describe('hierarchicalLayout', () => {
  const chain = () => ({
    nodes: [node('net', 'internet'), node('fw', 'firewall'), node('core', 'core-switch'),
      node('a1', 'access-switch'), node('a2', 'access-switch')],
    edges: [edge('net', 'fw'), edge('fw', 'core'), edge('core', 'a1'), edge('core', 'a2')],
  });

  it('runs the topology top to bottom, in flow order', () => {
    const { nodes, edges } = chain();
    const { moved } = hierarchicalLayout(nodes, edges);
    const y = (id: string) => moved.get(id)!.y;
    expect(y('net')).toBeLessThan(y('fw'));
    expect(y('fw')).toBeLessThan(y('core'));
    expect(y('core')).toBeLessThan(y('a1'));
    expect(y('a1')).toBe(y('a2'));
  });

  it('leaves no two devices on top of one another', () => {
    const { nodes, edges } = chain();
    const { moved } = hierarchicalLayout(nodes, edges);
    const seen = new Set<string>();
    for (const [, p] of moved) {
      expect(seen.has(`${p.x},${p.y}`)).toBe(false);
      seen.add(`${p.x},${p.y}`);
    }
    // And siblings are a whole node apart, not merely not-identical.
    expect(Math.abs(moved.get('a1')!.x - moved.get('a2')!.x)).toBeGreaterThanOrEqual(76);
  });

  it('centres each tier, so it reads as a tree rather than a left-aligned list', () => {
    const { nodes, edges } = chain();
    const { moved } = hierarchicalLayout(nodes, edges);
    const mid = (ids: string[]) => {
      const xs = ids.map((i) => moved.get(i)!.x + 38);
      return (Math.min(...xs) + Math.max(...xs)) / 2;
    };
    expect(Math.abs(mid(['core']) - mid(['a1', 'a2']))).toBeLessThan(2);
  });

  it('puts a node under the neighbours it is joined to, to keep links from crossing', () => {
    // Two cores, two access switches each. Ordered badly, the links cross.
    const nodes = [
      node('c1', 'core-switch'), node('c2', 'core-switch'),
      node('a1', 'access-switch'), node('a2', 'access-switch'),
      node('b1', 'access-switch'), node('b2', 'access-switch'),
    ];
    // Declared interleaved on purpose, so only the ordering pass can fix it.
    const edges = [edge('c1', 'a1'), edge('c2', 'b1'), edge('c1', 'a2'), edge('c2', 'b2')];
    const { moved } = hierarchicalLayout(nodes, edges);
    const x = (id: string) => moved.get(id)!.x;
    const c1Kids = [x('a1'), x('a2')];
    const c2Kids = [x('b1'), x('b2')];
    // Everything under c1 sits to one side of everything under c2.
    expect(Math.max(...c1Kids)).toBeLessThan(Math.min(...c2Kids));
  });

  it('does not move a locked device, and says how many it left', () => {
    const nodes = [node('net', 'internet'), node('fw', 'firewall', { locked: true })];
    const { moved, locked } = hierarchicalLayout(nodes, [edge('net', 'fw')]);
    expect(locked).toBe(1);
    expect(moved.has('fw')).toBe(false);
    expect(moved.has('net')).toBe(true);
  });

  it('has nothing to arrange for an empty page', () => {
    expect(hierarchicalLayout([], []).moved.size).toBe(0);
  });

  it('still arranges a topology with no links at all', () => {
    const nodes = [node('a', 'core-switch'), node('b', 'access-switch')];
    const { moved } = hierarchicalLayout(nodes, []);
    expect(moved.size).toBe(2);
    expect(moved.get('a')!.y).toBeLessThan(moved.get('b')!.y);
  });
});
