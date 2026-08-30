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
  chassisId: null,
  vendor: null,
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

describe('one device reported under two names', () => {
  it('folds an SNMP sysName and an LLDP name that share an address', () => {
    // A switch reached over SNMP reports its sysName, which is not always the
    // name it advertises over LLDP. Two names, one address, one device.
    const t = buildTopology(
      {
        devices: [
          device('CORE-SW', '10.0.0.1', [
            neighbor('Laundry-SW', 'Gi1/0/1', 'Port 1', {
              addresses: [{ ip: '10.0.0.2', interface: null, isManagement: true }],
            }),
          ]),
          // The same switch, reached over SNMP, calling itself something else.
          device('USW-Lite-8-PoE', '10.0.0.2', [], { hops: 1, reachedBy: 'snmp' }),
        ],
        notVisited: [],
      },
      'p',
    );
    expect(t.nodes).toHaveLength(2);
    // The reached device wins, because it knows more about itself.
    expect(labels(t)).toEqual(['CORE-SW', 'USW-Lite-8-PoE']);
    // And the link follows the fold rather than dangling.
    expect(t.edges).toHaveLength(1);
    expect(t.danglingLinks).toBe(0);
  });

  it('keeps two devices that merely have no address apart', () => {
    // Folding on a missing address would collapse every unaddressed device
    // into one.
    const t = buildTopology(
      {
        devices: [
          device('SW', '10.0.0.1', [
            neighbor('PHONE-A', 'Gi1/0/5', 'P1', { class: 'phone', addresses: [] }),
            neighbor('PHONE-B', 'Gi1/0/6', 'P1', { class: 'phone', addresses: [] }),
          ]),
        ],
        notVisited: [],
      },
      'p',
    );
    expect(t.nodes).toHaveLength(3);
  });
});

describe('a device whose only name is a MAC', () => {
  it('is drawn as its maker rather than as hex', () => {
    // A chassis id of 7456.3c75.fcae on a switch port tells an operator
    // nothing. "Ubiquiti device" tells them what they are looking at.
    const t = buildTopology(
      {
        devices: [
          device('SW', '10.0.0.1', [
            neighbor('7456.3c75.fcae', 'Gi1/0/7', 'eth0', {
              shortName: '7456.3c75.fcae',
              vendor: 'Ubiquiti',
              class: 'unknown',
            }),
          ]),
        ],
        notVisited: [],
      },
      'p',
    );
    expect(labels(t)).toContain('Ubiquiti device');
  });

  it('still counts two devices from one maker as two devices', () => {
    // The label changes; the identity must not, or a network full of one
    // vendor's kit collapses into a single node.
    const t = buildTopology(
      {
        devices: [
          device('SW', '10.0.0.1', [
            neighbor('7456.3c75.fcae', 'Gi1/0/7', 'eth0', {
              shortName: '7456.3c75.fcae', vendor: 'Ubiquiti', class: 'unknown',
            }),
            neighbor('7456.3c75.ffff', 'Gi1/0/8', 'eth0', {
              shortName: '7456.3c75.ffff', vendor: 'Ubiquiti', class: 'unknown',
            }),
          ]),
        ],
        notVisited: [],
      },
      'p',
    );
    expect(t.nodes).toHaveLength(3);
    expect(t.edges).toHaveLength(2);
  });

  it('leaves a real name alone', () => {
    const t = buildTopology(
      {
        devices: [device('SW', '10.0.0.1', [
          neighbor('ACC-SW1', 'Gi1/0/1', 'Gi0/1', { vendor: 'Cisco Systems' }),
        ])],
        notVisited: [],
      },
      'p',
    );
    expect(labels(t)).toContain('ACC-SW1');
  });
});

describe('re-crawling a diagram that already exists', () => {
  const source = {
    devices: [
      device('CORE-SW', '10.0.0.1', [neighbor('ACC-SW1', 'Gi1/0/1', 'Gi0/1')]),
      device('ACC-SW1', '10.0.0.2', [], { hops: 1 }),
    ],
    notVisited: [],
  };

  it('keeps a device that is already drawn, and the position it was put in', () => {
    // Without this a second crawl draws the whole network again beside the
    // first, which makes discovery something you do once.
    const first = buildTopology(source, 'p');
    const arranged = first.nodes.map((n) => ({ ...n, position: { x: 999, y: 777 } }));

    const second = buildTopology(source, 'p', {
      existingNodes: arranged,
      existingEdges: first.edges,
    });

    expect(second.nodes).toHaveLength(0);
    expect(second.edges).toHaveLength(0);
    expect(second.updated).toHaveLength(2);
    // The ids are the ones already on the diagram, so nothing is replaced.
    expect(second.updated.map((u) => u.id).sort()).toEqual(arranged.map((n) => n.id).sort());
  });

  it('adds only what is new', () => {
    const first = buildTopology(source, 'p');
    const grown = {
      devices: [
        device('CORE-SW', '10.0.0.1', [
          neighbor('ACC-SW1', 'Gi1/0/1', 'Gi0/1'),
          neighbor('ACC-SW2', 'Gi1/0/2', 'Gi0/1'),
        ]),
        device('ACC-SW1', '10.0.0.2', [], { hops: 1 }),
        device('ACC-SW2', '10.0.0.3', [], { hops: 1 }),
      ],
      notVisited: [],
    };

    const second = buildTopology(grown, 'p', {
      existingNodes: first.nodes,
      existingEdges: first.edges,
    });

    expect(labels(second)).toEqual(['ACC-SW2']);
    expect(second.edges).toHaveLength(1);
  });

  it('does not redraw a cable it already drew', () => {
    const first = buildTopology(source, 'p');
    const second = buildTopology(source, 'p', {
      existingNodes: first.nodes,
      existingEdges: first.edges,
    });
    expect(second.edges).toHaveLength(0);
  });

  it('never writes over the label', () => {
    // The crawl writes what it can newly establish. A name somebody corrected
    // by hand is not that.
    const first = buildTopology(source, 'p');
    const second = buildTopology(source, 'p', {
      existingNodes: first.nodes,
      existingEdges: first.edges,
    });
    expect(second.updated.length).toBeGreaterThan(0);
    for (const u of second.updated) expect(u.data.label).toBeUndefined();
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

  it('writes Nexus ports the way NX-OS does', () => {
    // Every Nexus port is an "Ethernet" whatever its speed, and the switch
    // itself calls them Eth1/1.
    expect(shortInterface('Ethernet1/1')).toBe('Eth1/1');
    expect(shortInterface('Ethernet1/49')).toBe('Eth1/49');
    expect(shortInterface('port-channel10')).toBe('Po10');
    expect(shortInterface('mgmt0')).toBe('mgmt0');
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

  it('does not cut a MAC at its first dot', () => {
    // Stripping a domain suffix mangles a Cisco-style MAC: 7456.3c75.fcae
    // becomes 7456, which every device from that vendor shares.
    expect(identity('7456.3c75.fcae', '')).not.toBe(identity('7456.3c75.ffff', ''));
    expect(identity('7456.3c75.fcae', '')).toBe(identity('7456.3C75.FCAE', ''));
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
