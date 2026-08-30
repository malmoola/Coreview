import { describe, expect, it } from 'vitest';

import { diffTopology, hasChanges } from './topologyDiff';
import type { CrawledDevice, Neighbor } from './ipc';
import type { TopoEdge, TopoNode } from '../state/store';

const node = (id: string, label: string, ip: string): TopoNode =>
  ({
    id,
    type: 'device',
    position: { x: 0, y: 0 },
    data: {
      label,
      deviceType: 'generic',
      tags: [],
      addresses: ip ? [{ id: 'a', label: 'Mgmt', address: ip, isPrimary: true }] : [],
      locked: false,
      maintenance: false,
      showDetails: true,
    },
  }) as TopoNode;

const edge = (id: string, source: string, target: string, sp: string, tp: string): TopoEdge =>
  ({
    id,
    source,
    target,
    data: { sourcePortLabel: sp, targetPortLabel: tp, label: '', pathType: 'smoothstep' },
  }) as TopoEdge;

const neighbor = (name: string, local: string, remote: string, ip = ''): Neighbor => ({
  deviceId: name,
  shortName: name,
  addresses: ip ? [{ ip, interface: null, isManagement: true }] : [],
  localInterface: local,
  remoteInterface: remote,
  platform: null,
  capabilities: [],
  version: null,
  class: 'switch',
  discoveredBy: 'cdp',
  chassisId: null,
  vendor: null,
});

const device = (hostname: string, address: string, neighbors: Neighbor[] = []): CrawledDevice =>
  ({
    hostname,
    address,
    addresses: [],
    probeTarget: address,
    class: 'switch',
    platform: null,
    version: null,
    neighbors,
    hops: 0,
    reachedBy: 'ssh',
    attached: [],
  }) as CrawledDevice;

describe('diffTopology', () => {
  it('reports nothing when the crawl agrees with the diagram', () => {
    const nodes = [node('n1', 'CORE-SW', '10.0.0.1'), node('n2', 'ACC-SW', '10.0.0.2')];
    const edges = [edge('e1', 'n1', 'n2', 'Gi1/0/1', 'Gi0/1')];
    const crawl = {
      devices: [
        device('CORE-SW', '10.0.0.1', [neighbor('ACC-SW', 'Gi1/0/1', 'Gi0/1', '10.0.0.2')]),
        device('ACC-SW', '10.0.0.2'),
      ],
      notVisited: [],
    };
    const c = diffTopology(nodes, edges, crawl);
    expect(hasChanges(c)).toBe(false);
  });

  it('notices a device that has gone', () => {
    const nodes = [node('n1', 'CORE-SW', '10.0.0.1'), node('n2', 'OLD-SW', '10.0.0.9')];
    const crawl = { devices: [device('CORE-SW', '10.0.0.1')], notVisited: [] };
    const c = diffTopology(nodes, [], crawl);
    expect(c.missing.map((m) => m.label)).toEqual(['OLD-SW']);
  });

  it('does not call a hand-drawn box missing', () => {
    // Something with no address was never going to be found by a crawl, and
    // reporting it every time would train people to ignore the list.
    const nodes = [node('n1', 'CORE-SW', '10.0.0.1'), node('n2', 'Internet', '')];
    const crawl = { devices: [device('CORE-SW', '10.0.0.1')], notVisited: [] };
    expect(diffTopology(nodes, [], crawl).missing).toEqual([]);
  });

  it('notices a device that has appeared', () => {
    const nodes = [node('n1', 'CORE-SW', '10.0.0.1')];
    const crawl = {
      devices: [device('CORE-SW', '10.0.0.1', [neighbor('NEW-SW', 'Gi1/0/5', 'Gi0/1', '10.0.0.5')])],
      notVisited: [],
    };
    expect(diffTopology(nodes, [], crawl).added.map((a) => a.label)).toEqual(['NEW-SW']);
  });

  it('notices an address that has moved', () => {
    const nodes = [node('n1', 'CORE-SW', '10.0.0.1')];
    const crawl = { devices: [device('CORE-SW', '10.0.0.77')], notVisited: [] };
    const c = diffTopology(nodes, [], crawl);
    expect(c.changed).toEqual([{ id: 'n1', label: 'CORE-SW', was: '10.0.0.1', now: '10.0.0.77' }]);
  });

  it('notices a link that has moved to another port', () => {
    // The devices are both still there; the cable is not where it was. That
    // is the change a maintenance window cares about.
    const nodes = [node('n1', 'CORE-SW', '10.0.0.1'), node('n2', 'ACC-SW', '10.0.0.2')];
    const edges = [edge('e1', 'n1', 'n2', 'Gi1/0/1', 'Gi0/1')];
    const crawl = {
      devices: [
        device('CORE-SW', '10.0.0.1', [neighbor('ACC-SW', 'Gi1/0/9', 'Gi0/1', '10.0.0.2')]),
        device('ACC-SW', '10.0.0.2'),
      ],
      notVisited: [],
    };
    const c = diffTopology(nodes, edges, crawl);
    expect(c.linksGone).toHaveLength(1);
    expect(c.linksNew).toHaveLength(1);
    expect(c.linksNew[0]!.description).toContain('Gi1/0/9');
  });

  it('is not fooled by the two ways an interface is written', () => {
    // CDP says GigabitEthernet0/1 and LLDP says Gi0/1. A diff that called
    // that a change would report the whole network as moved every run.
    const nodes = [node('n1', 'CORE-SW', '10.0.0.1'), node('n2', 'ACC-SW', '10.0.0.2')];
    const edges = [edge('e1', 'n1', 'n2', 'Gi1/0/1', 'Gi0/1')];
    const crawl = {
      devices: [
        device('CORE-SW', '10.0.0.1', [
          neighbor('ACC-SW', 'GigabitEthernet1/0/1', 'GigabitEthernet0/1', '10.0.0.2'),
        ]),
        device('ACC-SW', '10.0.0.2'),
      ],
      notVisited: [],
    };
    expect(hasChanges(diffTopology(nodes, edges, crawl))).toBe(false);
  });

  it('matches a device however its name was reported', () => {
    // sw1, SW1 and SW1.corp.local are one switch.
    const nodes = [node('n1', 'SW1.corp.local', '10.0.0.1')];
    const crawl = { devices: [device('sw1', '10.0.0.1')], notVisited: [] };
    expect(hasChanges(diffTopology(nodes, [], crawl))).toBe(false);
  });

  it('says nothing about an empty diagram meeting an empty crawl', () => {
    expect(hasChanges(diffTopology([], [], { devices: [], notVisited: [] }))).toBe(false);
  });
});
