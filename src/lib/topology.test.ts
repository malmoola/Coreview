import { describe, expect, it } from 'vitest';

import { buildTopology, identity, shortInterface, CLASS_GLYPH } from './topology';
import type { CrawledDevice, DeviceClassName, Neighbor } from './ipc';
import type { DeviceNodeData, LinkData } from '../types/domain';

const neighbor = (
  name: string,
  local: string | null,
  remote: string | null,
  over: Partial<Neighbor> = {},
): Neighbor => ({
  deviceId: name,
  shortName: name.split('.')[0] ?? name,
  addresses: over.addresses ?? [{ ip: '', interface: null, isManagement: false }],
  localInterface: local,
  remoteInterface: remote,
  platform: null,
  capabilities: [],
  version: null,
  class: 'switch',
  discoveredBy: 'cdp',
  ...over,
});

const device = (
  hostname: string,
  address: string,
  neighbors: Neighbor[],
  over: Partial<CrawledDevice> = {},
): CrawledDevice => ({
  hostname,
  address,
  addresses: [{ ip: address, interface: null, isManagement: true }],
  probeTarget: address,
  class: 'switch',
  platform: null,
  version: null,
  neighbors,
  hops: 0,
  reachedBy: 'ssh',
  ...over,
});

const labels = (t: ReturnType<typeof buildTopology>) =>
  t.nodes.map((n) => (n.data as DeviceNodeData).label).sort();
const ports = (t: ReturnType<typeof buildTopology>) =>
  t.edges.map((e) => {
    const d = e.data as LinkData;
    return `${d.sourcePortLabel}<->${d.targetPortLabel}`;
  });

describe('buildTopology', () => {
  it('links the devices it discovered, with the interface at each end', () => {
    // The whole point: discovery already knows who is plugged into what.
    const t = buildTopology(
      {
        devices: [
          device('CORE-SW', '10.0.0.1', [neighbor('ACC-SW1', 'Gi1/0/1', 'Gi0/1')]),
          device('ACC-SW1', '10.0.0.2', [], { hops: 1 }),
        ],
        notVisited: [],
      },
      'p',
    );
    expect(labels(t)).toEqual(['ACC-SW1', 'CORE-SW']);
    expect(t.edges).toHaveLength(1);
    expect(ports(t)).toEqual(['Gi1/0/1<->Gi0/1']);
    // The name as reported survives on the link, not only its short form.
    expect((t.edges[0]!.data as LinkData).notes).toContain('Gi1/0/1');
  });

  it('collapses a cable reported from both ends into one link', () => {
    // Both switches report the same cable. Drawn twice it looks like a
    // redundant pair that does not exist.
    const t = buildTopology(
      {
        devices: [
          device('CORE-SW', '10.0.0.1', [neighbor('ACC-SW1', 'Gi1/0/1', 'Gi0/1')]),
          device('ACC-SW1', '10.0.0.2', [neighbor('CORE-SW', 'Gi0/1', 'Gi1/0/1')], { hops: 1 }),
        ],
        notVisited: [],
      },
      'p',
    );
    expect(t.edges).toHaveLength(1);
  });

  it('keeps two cables between the same pair as two links', () => {
    // The opposite mistake: keying only on the pair would merge a real
    // dual-homed pair into a single line.
    const t = buildTopology(
      {
        devices: [
          device('CORE-SW', '10.0.0.1', [
            neighbor('ACC-SW1', 'Gi1/0/1', 'Gi0/1'),
            neighbor('ACC-SW1', 'Gi1/0/2', 'Gi0/2'),
          ]),
        ],
        notVisited: [],
      },
      'p',
    );
    expect(t.edges).toHaveLength(2);
    expect(ports(t).sort()).toEqual(['Gi1/0/1<->Gi0/1', 'Gi1/0/2<->Gi0/2']);
  });

  it('folds the same device seen under different names into one node', () => {
    // CDP says SW1.example.com, LLDP says SW1, the prompt says sw1. Three
    // nodes with a third of the links each is not a diagram of anything.
    const t = buildTopology(
      {
        devices: [
          device('CORE-SW', '10.0.0.1', [neighbor('SW1.example.com', 'Gi1/0/1', 'Gi0/1')]),
          device('sw1', '10.0.0.2', [], { hops: 1 }),
        ],
        notVisited: [neighbor('SW1', null, null)],
      },
      'p',
    );
    expect(t.nodes).toHaveLength(2);
  });

  it('places devices that were only seen, never logged into', () => {
    // Phones, printers and endpoints are most of a real diagram and are never
    // logged into.
    const t = buildTopology(
      {
        devices: [
          device('ACC-SW1', '10.0.0.2', [
            neighbor('SEP001122334455', 'Gi1/0/5', 'Port 1', { class: 'phone' }),
            neighbor('HP-LaserJet', 'Gi1/0/6', 'eth0', { class: 'printer' }),
          ]),
        ],
        notVisited: [],
      },
      'p',
    );
    expect(labels(t)).toEqual(['ACC-SW1', 'HP-LaserJet', 'SEP001122334455']);
    expect(t.edges).toHaveLength(2);
  });

  it('gives a phone and a camera their own glyphs', () => {
    // These mapped to 'endpoint-client' and 'camera-iot', which are not device
    // types; both fell through to the generic box.
    const t = buildTopology(
      {
        devices: [
          device('SW', '10.0.0.1', [
            neighbor('PHONE', 'Gi1/0/5', 'P1', { class: 'phone' }),
            neighbor('CAM', 'Gi1/0/6', 'eth0', { class: 'camera' }),
          ]),
        ],
        notVisited: [],
      },
      'p',
    );
    const types = t.nodes.map((n) => (n.data as DeviceNodeData).deviceType);
    expect(types).toContain('endpoint');
    expect(types).toContain('camera');
    expect(types).not.toContain('generic');
  });

  it('leaves out classes that were not asked for, and counts the links that lost an end', () => {
    const t = buildTopology(
      {
        devices: [
          device('SW', '10.0.0.1', [
            neighbor('PHONE', 'Gi1/0/5', 'P1', { class: 'phone' }),
            neighbor('ACC-SW1', 'Gi1/0/1', 'Gi0/1'),
          ]),
        ],
        notVisited: [],
      },
      'p',
      { include: ['switch'] },
    );
    expect(labels(t)).toEqual(['ACC-SW1', 'SW']);
    expect(t.edges).toHaveLength(1);
    expect(t.danglingLinks).toBe(1);
  });

  it('lays devices out by distance from the seed, not in a grid', () => {
    const t = buildTopology(
      {
        devices: [
          device('CORE', '10.0.0.1', [neighbor('A', 'Gi1/0/1', 'Gi0/1')], { hops: 0 }),
          device('A', '10.0.0.2', [neighbor('B', 'Gi0/2', 'Gi0/1')], { hops: 1 }),
          device('B', '10.0.0.3', [], { hops: 2 }),
        ],
        notVisited: [],
      },
      'p',
    );
    const y = (label: string) =>
      t.nodes.find((n) => (n.data as DeviceNodeData).label === label)!.position.y;
    expect(y('CORE')).toBeLessThan(y('A'));
    expect(y('A')).toBeLessThan(y('B'));
  });

  it('never links a device to itself', () => {
    // A device that reports itself as its own neighbour, which happens on
    // stacks and with some LLDP implementations.
    const t = buildTopology(
      { devices: [device('SW', '10.0.0.1', [neighbor('SW', 'Gi1/0/1', 'Gi1/0/2')])], notVisited: [] },
      'p',
    );
    expect(t.edges).toHaveLength(0);
  });

  it('handles a crawl that reached nothing', () => {
    const t = buildTopology({ devices: [], notVisited: [] }, 'p');
    expect(t.nodes).toEqual([]);
    expect(t.edges).toEqual([]);
  });
});

describe('shortInterface', () => {
  it('writes interfaces the way a diagram does', () => {
    expect(shortInterface('GigabitEthernet0/1')).toBe('Gi0/1');
    expect(shortInterface('TenGigabitEthernet1/0/48')).toBe('Te1/0/48');
    expect(shortInterface('FastEthernet0/24')).toBe('Fa0/24');
    expect(shortInterface('Port-channel10')).toBe('Po10');
    expect(shortInterface('Vlan100')).toBe('Vl100');
  });

  it('does not shorten TenGigabitEthernet to Etn', () => {
    // The Ethernet rule matches inside the longer name if tried first.
    expect(shortInterface('TenGigabitEthernet1/1')).toBe('Te1/1');
  });

  it('leaves alone what it does not recognise', () => {
    // Non-Cisco ports, and forms that are already short.
    expect(shortInterface('Gi0/1')).toBe('Gi0/1');
    expect(shortInterface('Port 4')).toBe('Port 4');
    expect(shortInterface('eth1')).toBe('eth1');
    expect(shortInterface('7456.3c75.fcae')).toBe('7456.3c75.fcae');
  });
});

describe('identity', () => {
  it('ignores the domain and the case', () => {
    expect(identity('SW1.example.com', '')).toBe(identity('sw1', ''));
  });

  it('falls back to the address when there is no usable name', () => {
    expect(identity('', '10.0.0.9')).toBe('a:10.0.0.9');
    expect(identity('unknown', '10.0.0.9')).toBe('a:10.0.0.9');
  });
});

describe('CLASS_GLYPH', () => {
  it('maps every class to a real device type', () => {
    const classes: DeviceClassName[] = [
      'router', 'switch', 'firewall', 'wireless-controller', 'access-point',
      'phone', 'camera', 'printer', 'server', 'endpoint', 'unknown',
    ];
    for (const c of classes) expect(CLASS_GLYPH[c]).toBeTruthy();
  });
});
