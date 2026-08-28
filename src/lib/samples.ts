/**
 * Sample projects. Addresses come from RFC 5737 documentation ranges plus
 * RFC 1918 space and localhost — no real customer names, no production
 * addresses, no credentials.
 *
 * 127.0.0.1 is used for the one node that should reliably come up healthy on
 * any machine, so a new user can see the animation working immediately. The
 * 192.0.2.0/24 targets will not answer, which is what makes the failure path
 * demonstrable without touching anyone's network.
 */
import type { ProjectDocument, TopoEdge, TopoNode } from '../state/store';
import { emptyDocument } from '../state/store';
import { uid } from './id';
import { PROBE_DEFAULTS, type DeviceType, type LinkHealthRuleType, type Probe } from '../types/domain';

interface Spec {
  key: string;
  label: string;
  x: number;
  y: number;
  type: DeviceType;
  address?: string;
  probeName?: string;
}

interface LinkSpec {
  from: string;
  to: string;
  sourcePort?: string;
  targetPort?: string;
  label?: string;
  rule?: LinkHealthRuleType;
}

function build(nodes: Spec[], links: LinkSpec[], noteBody: string): ProjectDocument {
  const doc = emptyDocument();
  const ids = new Map<string, string>();

  for (const s of nodes) {
    const id = uid();
    ids.set(s.key, id);
    const node: TopoNode = {
      id,
      type: 'device',
      position: { x: s.x, y: s.y },
      width: 176,
      height: 96,
      data: {
        label: s.label,
        deviceType: s.type,
        tags: [],
        addresses: s.address
          ? [{ id: uid(), label: s.probeName ?? 'Management', address: s.address, isPrimary: true }]
          : [],
        locked: false,
        maintenance: false,
        showDetails: true,
      },
    };
    doc.nodes.push(node);

    if (s.address) {
      const probe: Probe = {
        id: uid(),
        projectId: '',
        objectKind: 'node',
        objectId: id,
        name: s.probeName ?? 'Management',
        kind: 'icmp',
        target: s.address,
        tcpPort: null,
        ...PROBE_DEFAULTS,
        enabled: true,
        maintenance: false,
        isPrimary: true,
      };
      doc.probes.push(probe);
    }
  }

  for (const l of links) {
    const source = ids.get(l.from);
    const target = ids.get(l.to);
    if (!source || !target) continue;
    const edge: TopoEdge = {
      id: uid(),
      source,
      target,
      sourceHandle: 'b',
      targetHandle: 't',
      type: 'live',
      data: {
        sourcePortLabel: l.sourcePort ?? '',
        targetPortLabel: l.targetPort ?? '',
        label: l.label ?? '',
        pathType: 'smoothstep',
        direction: 'both',
        width: 2,
        color: '#5b6b7c',
        enabled: true,
        maintenance: false,
        healthRule: { type: l.rule ?? 'both-endpoints' },
      },
    };
    doc.edges.push(edge);
  }

  doc.nodes.push({
    id: uid(),
    type: 'note',
    position: { x: 720, y: 40 },
    width: 300,
    height: 210,
    data: {
      title: 'Change note',
      body: noteBody,
      variant: 'change',
      fontSize: 12,
      textColor: '#f2e6c8',
      background: '#2a2313',
      borderColor: '#8a6d1f',
      locked: false,
    },
  });

  return doc;
}

export const SAMPLES: Array<{
  name: string;
  description: string;
  build: () => ProjectDocument;
}> = [
  {
    name: 'Sample — Branch office validation',
    description:
      'Internet, ISP gateway, edge firewall, core, access, wireless controller and APs, plus an application server.',
    build: () =>
      build(
        [
          { key: 'net', label: 'Internet', x: 320, y: 0, type: 'internet' },
          { key: 'isp', label: 'ISP gateway', x: 320, y: 120, type: 'router', address: '192.0.2.1', probeName: 'WAN1' },
          { key: 'fw', label: 'Edge firewall', x: 320, y: 250, type: 'firewall', address: '127.0.0.1', probeName: 'Management' },
          { key: 'core', label: 'Core switch', x: 320, y: 380, type: 'core-switch', address: '192.0.2.10' },
          { key: 'acc', label: 'Access switch 1', x: 120, y: 510, type: 'access-switch', address: '192.0.2.11' },
          { key: 'wlc', label: 'Wireless controller', x: 520, y: 510, type: 'wireless-controller', address: '192.0.2.20' },
          { key: 'ap1', label: 'Wireless AP 1', x: 400, y: 640, type: 'access-point', address: '192.0.2.21' },
          { key: 'ap2', label: 'Wireless AP 2', x: 620, y: 640, type: 'access-point', address: '192.0.2.22' },
          { key: 'app', label: 'Application server', x: 120, y: 640, type: 'server', address: '192.0.2.50' },
        ],
        [
          { from: 'net', to: 'isp', targetPort: 'WAN1', rule: 'follow-target' },
          { from: 'isp', to: 'fw', sourcePort: 'ge-0/0/0', targetPort: 'port1', label: 'Primary ISP' },
          { from: 'fw', to: 'core', sourcePort: 'port3 / Po10', targetPort: 'Te1/0/48 / Po10', label: '10 Gb LACP — VLANs 10,20,30' },
          { from: 'core', to: 'acc', sourcePort: 'Gi1/0/1', targetPort: 'Gi1/0/48', label: 'Trunk VLAN 10,20' },
          { from: 'core', to: 'wlc', sourcePort: 'Gi1/0/2', targetPort: 'port1', label: 'Mgmt VLAN 20' },
          { from: 'wlc', to: 'ap1', label: 'CAPWAP' },
          { from: 'wlc', to: 'ap2', label: 'CAPWAP' },
          { from: 'acc', to: 'app', sourcePort: 'Gi1/0/10', label: 'Access VLAN 30' },
        ],
        '## Pre-check\n- [ ] Baseline ping to all management IPs\n- [ ] Config backup taken\n\n## Implementation\n- [ ] Cut ISP to new circuit\n\n## Validation\n- [ ] All nodes green for 5 minutes\n\n## Rollback\n- [ ] Restore previous WAN config',
      ),
  },
  {
    name: 'Sample — Campus wireless',
    description: 'Firewall to core to distribution to PoE access switches and APs, plus a controller.',
    build: () =>
      build(
        [
          { key: 'fw', label: 'Campus firewall', x: 320, y: 0, type: 'firewall', address: '127.0.0.1' },
          { key: 'core', label: 'Core', x: 320, y: 130, type: 'core-switch', address: '198.51.100.1' },
          { key: 'dist', label: 'Distribution', x: 320, y: 260, type: 'distribution-switch', address: '198.51.100.2' },
          { key: 'a1', label: 'Access A', x: 140, y: 390, type: 'access-switch', address: '198.51.100.11' },
          { key: 'a2', label: 'Access B', x: 340, y: 390, type: 'access-switch', address: '198.51.100.12' },
          { key: 'wlc', label: 'Wireless controller', x: 560, y: 390, type: 'wireless-controller', address: '198.51.100.20' },
          { key: 'ap1', label: 'AP 1st floor', x: 80, y: 520, type: 'access-point', address: '198.51.100.31' },
          { key: 'ap2', label: 'AP 2nd floor', x: 280, y: 520, type: 'access-point', address: '198.51.100.32' },
        ],
        [
          { from: 'fw', to: 'core', sourcePort: 'port2', targetPort: 'Te1/1/1', label: 'Uplink' },
          { from: 'core', to: 'dist', sourcePort: 'Te1/1/1', targetPort: 'Te1/1/2', label: '10 Gb' },
          { from: 'dist', to: 'a1', sourcePort: 'Gi1/0/47', targetPort: 'Gi1/0/48', label: 'Trunk VLAN 20,30,40' },
          { from: 'dist', to: 'a2', sourcePort: 'Gi1/0/46', targetPort: 'Gi1/0/48', label: 'Trunk VLAN 20,30,40' },
          { from: 'dist', to: 'wlc', sourcePort: 'Gi1/0/45', targetPort: 'port1', label: 'Mgmt' },
          { from: 'a1', to: 'ap1', sourcePort: 'Gi1/0/5', label: 'PoE+' },
          { from: 'a2', to: 'ap2', sourcePort: 'Gi1/0/5', label: 'PoE+' },
        ],
        '## Wireless cutover\n- [ ] Controller reachable\n- [ ] APs joined\n- [ ] Client test on each SSID',
      ),
  },
  {
    name: 'Sample — Data centre and hybrid',
    description: 'ISP, edge router, firewall HA, core pair, hypervisors, application VIP, VPN to branch and SaaS.',
    build: () =>
      build(
        [
          { key: 'isp', label: 'ISP', x: 320, y: 0, type: 'internet' },
          { key: 'edge', label: 'Edge router', x: 320, y: 120, type: 'router', address: '203.0.113.1' },
          { key: 'fw', label: 'Firewall HA group', x: 320, y: 250, type: 'firewall', address: '127.0.0.1' },
          { key: 'core', label: 'Core pair', x: 320, y: 380, type: 'core-switch', address: '203.0.113.10' },
          { key: 'esx', label: 'Hypervisor hosts', x: 140, y: 510, type: 'vm', address: '203.0.113.20' },
          { key: 'vip', label: 'Application VIP', x: 140, y: 640, type: 'application', address: '203.0.113.30' },
          { key: 'vpn', label: 'VPN to branch', x: 540, y: 510, type: 'vpn', address: '203.0.113.40' },
          { key: 'saas', label: 'SaaS / cloud', x: 540, y: 640, type: 'private-cloud', address: '203.0.113.50' },
        ],
        [
          { from: 'isp', to: 'edge', targetPort: 'Gi0/0/0', rule: 'follow-target' },
          { from: 'edge', to: 'fw', sourcePort: 'Gi0/0/1', targetPort: 'port1', label: 'Transit' },
          { from: 'fw', to: 'core', sourcePort: 'port5 / Po1', targetPort: 'Po1', label: '2x10 Gb LACP' },
          { from: 'core', to: 'esx', sourcePort: 'Te1/0/1', targetPort: 'vmnic0', label: 'VLAN 100' },
          { from: 'esx', to: 'vip', label: 'Service', rule: 'follow-target' },
          { from: 'fw', to: 'vpn', sourcePort: 'tunnel1', label: 'IPsec VPN', rule: 'follow-target' },
          { from: 'fw', to: 'saas', label: 'Internet egress', rule: 'follow-target' },
        ],
        '## Migration window\n- [ ] Firewall HA failover tested\n- [ ] VIP responds\n- [ ] Branch VPN re-established',
      ),
  },
];
