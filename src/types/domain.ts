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
  style?: {
    background?: string;
    border?: string;
    iconColor?: string;
  };
}

export interface NoteNodeData extends Record<string, unknown> {
  title?: string;
  body: string;
  /** Change-note styling for pre-check / rollback / risk annotations. */
  variant: 'plain' | 'change';
  fontSize: number;
  textColor: string;
  background: string;
  borderColor: string;
  locked: boolean;
}

export type LinkPathType = 'straight' | 'step' | 'smoothstep' | 'bezier';
export type LinkDirection = 'none' | 'forward' | 'reverse' | 'both';

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
