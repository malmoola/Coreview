import { describe, expect, it } from 'vitest';
import { changedHops } from './tracerouteDiff';
import type { TracerouteHopDto } from './ipc';

const hop = (n: number, hosts: (string | null)[]): TracerouteHopDto => ({
  hop: n,
  probes: hosts.map((host) => ({ host, rttMs: host ? 10 : null })),
});

describe('changedHops', () => {
  it('is empty with no previous run', () => {
    expect(changedHops(null, [hop(1, ['a']), hop(2, ['b'])])).toEqual(new Set());
  });

  it('is empty when every hop answers from the same routers', () => {
    const previous = [hop(1, ['a']), hop(2, ['b', 'b', 'c'])];
    const current = [hop(1, ['a']), hop(2, ['c', 'b', 'b'])];
    expect(changedHops(previous, current)).toEqual(new Set());
  });

  it('flags a hop whose router changed', () => {
    const previous = [hop(1, ['a']), hop(2, ['b'])];
    const current = [hop(1, ['a']), hop(2, ['x'])];
    expect(changedHops(previous, current)).toEqual(new Set([2]));
  });

  it('flags a hop that started answering', () => {
    const previous = [hop(1, ['a']), hop(2, [null, null, null])];
    const current = [hop(1, ['a']), hop(2, ['b', 'b', 'b'])];
    expect(changedHops(previous, current)).toEqual(new Set([2]));
  });

  it('flags a hop that stopped answering', () => {
    const previous = [hop(1, ['a']), hop(2, ['b'])];
    const current = [hop(1, ['a']), hop(2, [null, null, null])];
    expect(changedHops(previous, current)).toEqual(new Set([2]));
  });

  it('flags a new hop with no prior counterpart', () => {
    const previous = [hop(1, ['a'])];
    const current = [hop(1, ['a']), hop(2, ['new'])];
    expect(changedHops(previous, current)).toEqual(new Set([2]));
  });

  it('is order-independent for which router answered which probe', () => {
    const previous = [hop(1, ['a', 'b', 'a'])];
    const current = [hop(1, ['b', 'a', 'a'])];
    expect(changedHops(previous, current)).toEqual(new Set());
  });
});
