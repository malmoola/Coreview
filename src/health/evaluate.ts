import type {
  HealthStatus,
  LinkData,
  LinkHealthRule,
  Probe,
  ProbeRuntime,
} from '../types/domain';

/**
 * Aggregate a node's probes into one node status.
 *
 * The primary enabled probe wins. If no probe is marked primary, the first
 * enabled probe is used. A node with no enabled probes is `unknown`, not
 * `healthy` — Coreview never reports health it has not observed.
 */
export function nodeStatus(
  probes: Probe[],
  runtime: Map<string, ProbeRuntime>,
  maintenance = false,
): HealthStatus {
  if (maintenance) return 'maintenance';

  const usable = probes.filter((p) => p.kind !== 'manual');
  if (usable.length === 0) return 'unknown';

  const enabled = usable.filter((p) => p.enabled);
  if (enabled.length === 0) return 'disabled';

  const primary = enabled.find((p) => p.isPrimary) ?? enabled[0];
  if (!primary) return 'unknown';
  if (primary.maintenance) return 'maintenance';

  return runtime.get(primary.id)?.status ?? 'unknown';
}

/** Worst-of comparison used by the both-endpoints rule and the dashboard. */
const SEVERITY: Record<HealthStatus, number> = {
  healthy: 0,
  unknown: 1,
  disabled: 2,
  maintenance: 3,
  warning: 4,
  down: 5,
};

export function worst(a: HealthStatus, b: HealthStatus): HealthStatus {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

export interface LinkContext {
  link: Pick<LinkData, 'enabled' | 'maintenance' | 'healthRule' | 'kind'>;
  sourceStatus: HealthStatus;
  targetStatus: HealthStatus;
  /** Probes belonging to this link (dedicated-probe rule). */
  linkProbes: Probe[];
  /** All probes in the project, for the named-node-probe rule. */
  allProbes: Probe[];
  runtime: Map<string, ProbeRuntime>;
  /** False when validation is stopped: live status is not evidence. */
  sessionRunning: boolean;
}

/**
 * Resolve a link's displayed status from its configured rule.
 *
 * This is a rule the operator chose, not path tracing. Nothing here infers
 * that traffic actually crosses the drawn line.
 */
export function linkStatus(ctx: LinkContext): HealthStatus {
  const { link } = ctx;
  // A leader points a note at the thing it is about. It is an annotation, not
  // a cable: reporting a health for it would put a made-up green line in the
  // counts and a made-up outage in the timeline.
  if (link.kind === 'leader') return 'disabled';
  if (!link.enabled) return 'disabled';
  if (link.maintenance) return 'maintenance';

  const rule: LinkHealthRule = link.healthRule ?? { type: 'manual' };

  if (rule.type === 'manual') {
    return rule.manualStatus ?? 'unknown';
  }

  // Every other rule depends on live probe data.
  if (!ctx.sessionRunning) return 'unknown';

  switch (rule.type) {
    case 'follow-source':
      return ctx.sourceStatus;
    case 'follow-target':
      return ctx.targetStatus;
    case 'both-endpoints': {
      const a = ctx.sourceStatus;
      const b = ctx.targetStatus;
      if (a === 'down' || b === 'down') return 'down';
      if (a === 'maintenance' || b === 'maintenance') return 'maintenance';
      if (a === 'unknown' || b === 'unknown') return 'unknown';
      if (a === 'disabled' || b === 'disabled') return 'disabled';
      if (a === 'warning' || b === 'warning') return 'warning';
      return 'healthy';
    }
    case 'dedicated-probe': {
      const probe = ctx.linkProbes.find((p) => p.enabled && p.kind !== 'manual');
      if (!probe) return 'unknown';
      if (probe.maintenance) return 'maintenance';
      return ctx.runtime.get(probe.id)?.status ?? 'unknown';
    }
    case 'named-node-probe': {
      if (!rule.probeId) return 'unknown';
      const probe = ctx.allProbes.find((p) => p.id === rule.probeId);
      if (!probe) return 'unknown';
      if (!probe.enabled) return 'disabled';
      if (probe.maintenance) return 'maintenance';
      return ctx.runtime.get(probe.id)?.status ?? 'unknown';
    }
    default:
      return 'unknown';
  }
}

/** Only healthy and warning links animate. */
export function shouldAnimate(status: HealthStatus, reduceMotion: boolean): boolean {
  if (reduceMotion) return false;
  return status === 'healthy' || status === 'warning';
}

/** Human-readable description of what is driving a link's state. */
export function describeRule(rule: LinkHealthRule, probes: Probe[]): string {
  switch (rule.type) {
    case 'manual':
      return 'Manual status — not monitored';
    case 'follow-source':
      return 'Follows source node status';
    case 'follow-target':
      return 'Follows target node status';
    case 'both-endpoints':
      return 'Both endpoint nodes must be healthy';
    case 'dedicated-probe': {
      const p = probes.find((x) => x.enabled);
      return p ? `Dedicated ${p.kind.toUpperCase()} probe` : 'Dedicated probe (none configured)';
    }
    case 'named-node-probe': {
      const p = probes.find((x) => x.id === rule.probeId);
      return p ? `Node probe "${p.name}"` : 'Named node probe (not found)';
    }
    default:
      return 'Unknown rule';
  }
}
