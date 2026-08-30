import { describe, expect, it } from 'vitest';

import { matchesFilter, selectAttached, vendorCounts } from './attached';
import type { AttachedDevice, CrawledDevice } from './ipc';

const thing = (over: Partial<AttachedDevice> = {}): AttachedDevice => ({
  mac: '7456' + Math.random().toString(16).slice(2, 10),
  port: 'Gi0/7',
  address: '192.168.14.129',
  vendor: 'Ubiquiti',
  hostname: null,
  class: null,
  portPopulation: 1,
  ...over,
});

const host = (name: string, attached: AttachedDevice[]): CrawledDevice =>
  ({
    hostname: name,
    address: '10.0.0.1',
    addresses: [],
    probeTarget: '10.0.0.1',
    class: 'switch',
    platform: null,
    version: null,
    neighbors: [],
    hops: 0,
    reachedBy: 'ssh',
    attached,
  }) as CrawledDevice;

describe('matchesFilter', () => {
  it('matches everything when nothing is asked for', () => {
    expect(matchesFilter(thing(), {})).toBe(true);
  });

  it('finds a maker by part of its name', () => {
    // "Show me the Axis cameras" is a question about a network.
    expect(matchesFilter(thing({ vendor: 'Axis Communications' }), { vendor: 'axis' })).toBe(true);
    expect(matchesFilter(thing({ vendor: 'Ubiquiti' }), { vendor: 'axis' })).toBe(false);
    expect(matchesFilter(thing({ vendor: null }), { vendor: 'axis' })).toBe(false);
  });

  it('confines to a subnet, written either way', () => {
    const d = thing({ address: '192.168.14.129' });
    expect(matchesFilter(d, { subnet: '192.168.14.0/24' })).toBe(true);
    expect(matchesFilter(d, { subnet: '192.168.14' })).toBe(true);
    expect(matchesFilter(d, { subnet: '192.168.14.0' })).toBe(true);
    // A prefix length is not an octet, which is what broke this first.
    expect(matchesFilter(d, { subnet: '192.168.14.0/24' })).toBe(true);
    expect(matchesFilter(d, { subnet: 'nonsense' })).toBe(false);
    expect(matchesFilter(d, { subnet: '10.2.80.0/24' })).toBe(false);
  });

  it('excludes an unaddressed device from a subnet question', () => {
    // Something with no address is not in the subnet, and cannot be assumed
    // into it.
    expect(matchesFilter(thing({ address: null }), { subnet: '192.168.14.0/24' })).toBe(false);
  });

  it('matches a port by part of its name', () => {
    expect(matchesFilter(thing({ port: 'Gi1/0/12' }), { port: 'Gi1/0/1' })).toBe(true);
    expect(matchesFilter(thing({ port: 'Gi0/7' }), { port: 'Gi1/0' })).toBe(false);
  });

  it('skips what is behind an uplink', () => {
    // A port carrying twenty addresses leads to another switch, and what is
    // behind it belongs to that switch's diagram.
    expect(matchesFilter(thing({ portPopulation: 20 }), { maxPerPort: 4 })).toBe(false);
    expect(matchesFilter(thing({ portPopulation: 2 }), { maxPerPort: 4 })).toBe(true);
  });

  it('can insist on an address', () => {
    // Something with no address can be drawn but never checked.
    expect(matchesFilter(thing({ address: null }), { addressedOnly: true })).toBe(false);
    expect(matchesFilter(thing({ address: '10.0.0.5' }), { addressedOnly: true })).toBe(true);
  });
});

describe('selectAttached', () => {
  it('draws a device once even when two switches saw it', () => {
    // A MAC is learned through uplinks too, and the same printer three times
    // is not a diagram of anything.
    const shared = thing({ mac: 'aabbccddeeff' });
    const out = selectAttached([host('SW1', [shared]), host('SW2', [{ ...shared }])], {});
    expect(out).toHaveLength(1);
    // The first sighting wins, which is the switch nearest the seed.
    expect(out[0]!.host).toBe('SW1');
  });

  it('applies the filter across every switch', () => {
    const out = selectAttached(
      [
        host('SW1', [thing({ mac: 'a1', vendor: 'Axis Communications' })]),
        host('SW2', [thing({ mac: 'b2', vendor: 'Ubiquiti' })]),
      ],
      { vendor: 'axis' },
    );
    expect(out.map((o) => o.device.mac)).toEqual(['a1']);
  });

  it('returns nothing when nothing was attached', () => {
    expect(selectAttached([host('SW1', [])], {})).toEqual([]);
  });
});

describe('vendorCounts', () => {
  it('offers the commonest makers first', () => {
    // What someone wants is usually the thing there is a lot of.
    const counts = vendorCounts([
      host('SW1', [
        thing({ mac: 'a', vendor: 'Ubiquiti' }),
        thing({ mac: 'b', vendor: 'Ubiquiti' }),
        thing({ mac: 'c', vendor: 'Axis Communications' }),
        thing({ mac: 'd', vendor: null }),
      ]),
    ]);
    expect(counts[0]).toEqual({ vendor: 'Ubiquiti', count: 2 });
    expect(counts.map((c) => c.vendor)).toContain('Unknown maker');
  });

  it('counts a device once however many switches saw it', () => {
    const shared = thing({ mac: 'same', vendor: 'Ubiquiti' });
    const counts = vendorCounts([host('SW1', [shared]), host('SW2', [{ ...shared }])]);
    expect(counts).toEqual([{ vendor: 'Ubiquiti', count: 1 }]);
  });
});
