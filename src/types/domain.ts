export type HealthStatus =
  | 'unknown'
  | 'healthy'
  | 'warning'
  | 'down'
  | 'disabled'
  | 'maintenance';

export type ProbeKind = 'icmp' | 'tcp' | 'dns' | 'manual';

export type ObjectKind = 'node' | 'link';

export type DeviceType =
  | 'generic'
  | 'firewall'
  | 'router'
  | 'core-switch'
  | 'distribution-switch'
  | 'access-switch'
  | 'wireless-controller'
  | 'access-point'
  | 'server'
  | 'vm'
  | 'storage'
  | 'endpoint'
  | 'printer'
  | 'camera'
  | 'internet'
  | 'private-cloud'
  | 'site'
  | 'vpn'
  | 'application'
  | 'database'
  | 'custom-image'
  | 'rectangle'
  | 'rounded'
  | 'circle'
  | 'diamond'
  | 'zone'
  | 'callout'
  | 'cloud'
  | 'text';

export interface NodeAddress {
  id: string;
  /** Friendly label, e.g. "Management", "Loopback0", "WAN1". */
  label: string;
  address: string;
  isPrimary: boolean;
}

export interface Probe {
  id: string;
  projectId: string;
  objectKind: ObjectKind;
  objectId: string;
  name: string;
  kind: ProbeKind;
  target: string;
  tcpPort?: number | null;
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  warningLatencyMs?: number | null;
  enabled: boolean;
  maintenance: boolean;
  isPrimary: boolean;
  notes?: string;
}

export const PROBE_DEFAULTS = {
  intervalSeconds: 5,
  timeoutMs: 1000,
  failureThreshold: 3,
  recoveryThreshold: 1,
  warningLatencyMs: 100,
} as const;

export interface DeviceNodeData extends Record<string, unknown> {
  /** Which views this device appears on. Unset means every view — an object
   *  that has never been assigned belongs to all of them. */
  layers?: string[];
  label: string;
  deviceType: DeviceType;
  hostname?: string;
  vendor?: string;
  model?: string;
  role?: string;
  site?: string;
  rack?: string;
  notes?: string;
  tags: string[];
  addresses: NodeAddress[];
  locked: boolean;
  /** Suppresses status reporting for a planned outage. */
  maintenance: boolean;
  showDetails: boolean;
  imageDataUrl?: string;
  /** Objects sharing a groupId move together. Nothing is drawn for a group:
   *  it exists in behaviour only, so a device and the notes explaining it stay
   *  a unit without a box around them. */
  groupId?: string;
  /** Id of an icon from the local library. imageDataUrl carries the inlined
   *  copy so an exported project still renders on a machine without the
   *  library folder. */
  iconRef?: string;
  style?: {
    background?: string;
    border?: string;
    iconColor?: string;
  };
}

export interface NoteNodeData extends Record<string, unknown> {
  /** Which views this note appears on. Unset means every view. */
  layers?: string[];
  title?: string;
  body: string;
  /** Change-note styling for pre-check / rollback / risk annotations. */
  variant: 'plain' | 'change';
  fontSize: number;
  /** Left unset means "follow the ground". A colour here is a decision and is
   *  kept whichever ground the diagram is being drawn on. */
  textColor?: string;
  background?: string;
  borderColor?: string;
  locked: boolean;
  /** See DeviceNodeData.groupId. */
  groupId?: string;
}

export type LinkPathType = 'straight' | 'step' | 'smoothstep' | 'bezier';
export type LinkDirection = 'none' | 'forward' | 'reverse' | 'both';

/** What sits at the end of a line. */
export type LinkCap = 'none' | 'arrow' | 'open-arrow' | 'circle' | 'square' | 'diamond';

/** How the line itself is drawn. 'auto' keeps the health meaning — a link that
 *  is down is dashed and one that is disabled is dotted — which is right until
 *  someone needs a dashed line to mean a tunnel instead. */
export type LinkLineStyle = 'auto' | 'solid' | 'dashed' | 'dotted' | 'dash-dot';

export type LinkHealthRuleType =
  | 'manual'
  | 'follow-source'
  | 'follow-target'
  | 'both-endpoints'
  | 'dedicated-probe'
  | 'named-node-probe';

export interface LinkHealthRule {
  type: LinkHealthRuleType;
  /** For 'named-node-probe'. */
  nodeId?: string;
  probeId?: string;
  /** For 'manual'. */
  manualStatus?: HealthStatus;
}

export interface LinkData extends Record<string, unknown> {
  /** What this line is. A 'leader' points a note at the thing it is about; it
   *  is an annotation, not a cable, so it carries no health, is not counted,
   *  and does not hop over the links it crosses. */
  kind?: 'link' | 'leader';
  sourcePortLabel: string;
  targetPortLabel: string;
  label: string;
  pathType: LinkPathType;
  direction: LinkDirection;
  width: number;
  color: string;
  enabled: boolean;
  maintenance: boolean;
  notes?: string;
  healthRule: LinkHealthRule;
  lineStyle?: LinkLineStyle;
  /** Overrides what `direction` would put at each end. Left unset, an arrow
   *  follows the flow direction as it always has. */
  startCap?: LinkCap;
  endCap?: LinkCap;
  /** Which lane this link takes out of a crowded side, worked out on every
   *  render and never saved. Several links leaving the same side of the same
   *  device would otherwise run along one another and be impossible to
   *  follow. */
  lane?: number;
  /** Where the line's colour comes from. 'status' is the default and paints
   *  the whole link by health. 'fixed' paints the line with `color` — for
   *  marking a fibre run or a carrier circuit — while everything that carries
   *  liveness stays status-coloured, so the link is still a live link. */
  colorMode?: 'status' | 'fixed';
  /** Keep this link on the sides it is drawn on, instead of letting it swing
   *  round as the devices move. Off by default: a link that stays attached to
   *  the bottom of a device after that device has been moved above its
   *  neighbour is drawn wrong, and nobody wants to correct that by hand. */
  pinnedSides?: boolean;
}

export interface ProjectMeta {
  id: string;
  name: string;
  customer: string;
  site: string;
  ticket: string;
  engineer: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

export interface EventRow {
  id: string;
  projectId: string;
  sessionId: string | null;
  timestampMs: number;
  objectType: ObjectKind;
  objectId: string;
  objectName: string;
  eventType: 'transition' | 'session' | 'test';
  previousStatus: HealthStatus | null;
  currentStatus: HealthStatus | null;
  probeType: ProbeKind | null;
  target: string | null;
  rttMs: number | null;
  message: string;
}

export interface ProbeRuntime {
  probeId: string;
  status: HealthStatus;
  lastRttMs: number | null;
  lastSuccessMs: number | null;
  lastFailureMs: number | null;
  lastSummary: string | null;
  consecutiveFailures: number;
  failureThreshold: number;
}

export type SessionState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export const STATUS_LABEL: Record<HealthStatus, string> = {
  unknown: 'Unknown',
  healthy: 'Healthy',
  warning: 'Warning',
  down: 'Down',
  disabled: 'Disabled',
  maintenance: 'Maintenance',
};

/** Status is never carried by color alone; each has a glyph too. */
export const STATUS_GLYPH: Record<HealthStatus, string> = {
  unknown: '?',
  healthy: '✓',
  warning: '!',
  down: '✕',
  disabled: '–',
  maintenance: '⚙',
};

export const HEALTH_RULE_LABEL: Record<LinkHealthRuleType, string> = {
  manual: 'Manual — no monitoring',
  'follow-source': 'Follow source node status',
  'follow-target': 'Follow target node status',
  'both-endpoints': 'Both endpoint nodes must be healthy',
  'dedicated-probe': 'Dedicated probe target',
  'named-node-probe': 'Follow a named probe on a node',
};
