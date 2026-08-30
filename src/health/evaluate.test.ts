import { describe, expect, it } from 'vitest';
import { linkStatus, nodeStatus, shouldAnimate, worst } from './evaluate';
import type { HealthStatus, Probe, ProbeRuntime } from '../types/domain';

function probe(over: Partial<Probe> = {}): Probe {
  return {
    id: 'pr1',
    projectId: 'proj',
    objectKind: 'node',
    objectId: 'n1',
    name: 'Primary',
    kind: 'icmp',
    target: '10.10.10.1',
    intervalSeconds: 5,
    timeoutMs: 1000,
    failureThreshold: 3,
    recoveryThreshold: 1,
    warningLatencyMs: 100,
    enabled: true,
    maintenance: false,
    isPrimary: true,
    ...over,
  };
}

function runtime(entries: Array<[string, HealthStatus]>): Map<string, ProbeRuntime> {
  return new Map(
    entries.map(([id, status]) => [
      id,
      {
        probeId: id,
        status,
        lastRttMs: null,
        lastSuccessMs: null,
        lastFailureMs: null,
        lastSummary: null,
        consecutiveFailures: 0,
        failureThreshold: 3,
      },
    ]),
  );
}

function ctx(over: Partial<Parameters<typeof linkStatus>[0]> = {}) {
  return {
    link: { enabled: true, maintenance: false, healthRule: { type: 'manual' as const } },
    sourceStatus: 'unknown' as HealthStatus,
    targetStatus: 'unknown' as HealthStatus,
    linkProbes: [],
    allProbes: [],
    runtime: new Map<string, ProbeRuntime>(),
    sessionRunning: true,
    ...over,
  };
}

describe('nodeStatus', () => {
  it('is unknown with no probes rather than assuming health', () => {
    expect(nodeStatus([], new Map())).toBe('unknown');
  });

  it('is disabled when every probe is disabled', () => {
    expect(nodeStatus([probe({ enabled: false })], new Map())).toBe('disabled');
  });

  it('follows the primary probe', () => {
    const probes = [
      probe({ id: 'a', isPrimary: false }),
      probe({ id: 'b', isPrimary: true }),
    ];
    const rt = runtime([
      ['a', 'down'],
      ['b', 'healthy'],
    ]);
    expect(nodeStatus(probes, rt)).toBe('healthy');
  });

  it('falls back to the first enabled probe when none is primary', () => {
    const probes = [probe({ id: 'a', isPrimary: false })];
    expect(nodeStatus(probes, runtime([['a', 'warning']]))).toBe('warning');
  });

  it('maintenance on the node overrides everything', () => {
    expect(nodeStatus([probe({ id: 'a' })], runtime([['a', 'down']]), true)).toBe('maintenance');
  });
});

describe('linkStatus', () => {
  it('a disabled link is disabled regardless of endpoints', () => {
    expect(
      linkStatus(
        ctx({
          link: { enabled: false, maintenance: false, healthRule: { type: 'both-endpoints' } },
          sourceStatus: 'healthy',
          targetStatus: 'healthy',
        }),
      ),
    ).toBe('disabled');
  });

  it('a manual link never derives status from probes', () => {
    expect(
      linkStatus(
        ctx({
          link: {
            enabled: true,
            maintenance: false,
            healthRule: { type: 'manual', manualStatus: 'healthy' },
          },
          sourceStatus: 'down',
        }),
      ),
    ).toBe('healthy');
  });

  it('reports unknown when validation is stopped', () => {
    expect(
      linkStatus(
        ctx({
          link: { enabled: true, maintenance: false, healthRule: { type: 'follow-source' } },
          sourceStatus: 'healthy',
          sessionRunning: false,
        }),
      ),
    ).toBe('unknown');
  });

  it('follow-source and follow-target read the right endpoint', () => {
    const base = { sourceStatus: 'healthy' as HealthStatus, targetStatus: 'down' as HealthStatus };
    expect(
      linkStatus(
        ctx({
          ...base,
          link: { enabled: true, maintenance: false, healthRule: { type: 'follow-source' } },
        }),
      ),
    ).toBe('healthy');
    expect(
      linkStatus(
        ctx({
          ...base,
          link: { enabled: true, maintenance: false, healthRule: { type: 'follow-target' } },
        }),
      ),
    ).toBe('down');
  });

  /** Test case 11. */
  it('both-endpoints is down when either endpoint is down', () => {
    const rule = { type: 'both-endpoints' as const };
    const link = { enabled: true, maintenance: false, healthRule: rule };
    expect(linkStatus(ctx({ link, sourceStatus: 'healthy', targetStatus: 'healthy' }))).toBe('healthy');
    expect(linkStatus(ctx({ link, sourceStatus: 'down', targetStatus: 'healthy' }))).toBe('down');
    expect(linkStatus(ctx({ link, sourceStatus: 'healthy', targetStatus: 'down' }))).toBe('down');
    expect(linkStatus(ctx({ link, sourceStatus: 'warning', targetStatus: 'healthy' }))).toBe('warning');
    expect(linkStatus(ctx({ link, sourceStatus: 'warning', targetStatus: 'down' }))).toBe('down');
    expect(linkStatus(ctx({ link, sourceStatus: 'unknown', targetStatus: 'healthy' }))).toBe('unknown');
    expect(linkStatus(ctx({ link, sourceStatus: 'maintenance', targetStatus: 'healthy' }))).toBe(
      'maintenance',
    );
  });

  it('a dedicated probe drives the link independently of its endpoints', () => {
    const p = probe({ id: 'lp1', objectKind: 'link', objectId: 'l1' });
    expect(
      linkStatus(
        ctx({
          link: { enabled: true, maintenance: false, healthRule: { type: 'dedicated-probe' } },
          sourceStatus: 'down',
          targetStatus: 'down',
          linkProbes: [p],
          runtime: runtime([['lp1', 'healthy']]),
        }),
      ),
    ).toBe('healthy');
  });

  it('a dedicated rule with no configured probe is unknown, not healthy', () => {
    expect(
      linkStatus(
        ctx({
          link: { enabled: true, maintenance: false, healthRule: { type: 'dedicated-probe' } },
        }),
      ),
    ).toBe('unknown');
  });

  it('a named node probe is followed by id', () => {
    const p = probe({ id: 'np9', name: 'Loopback0' });
    expect(
      linkStatus(
        ctx({
          link: {
            enabled: true,
            maintenance: false,
            healthRule: { type: 'named-node-probe', nodeId: 'n1', probeId: 'np9' },
          },
          allProbes: [p],
          runtime: runtime([['np9', 'warning']]),
        }),
      ),
    ).toBe('warning');
  });

  it('a named probe that no longer exists is unknown', () => {
    expect(
      linkStatus(
        ctx({
          link: {
            enabled: true,
            maintenance: false,
            healthRule: { type: 'named-node-probe', probeId: 'gone' },
          },
        }),
      ),
    ).toBe('unknown');
  });
});

describe('animation gating', () => {
  it('only healthy and warning move', () => {
    expect(shouldAnimate('healthy', false)).toBe(true);
    expect(shouldAnimate('warning', false)).toBe(true);
    expect(shouldAnimate('down', false)).toBe(false);
    expect(shouldAnimate('unknown', false)).toBe(false);
    expect(shouldAnimate('disabled', false)).toBe(false);
    expect(shouldAnimate('maintenance', false)).toBe(false);
  });

  it('reduce motion stops everything', () => {
    expect(shouldAnimate('healthy', true)).toBe(false);
  });
});

describe('worst', () => {
  it('ranks down above warning above healthy', () => {
    expect(worst('healthy', 'warning')).toBe('warning');
    expect(worst('warning', 'down')).toBe('down');
    expect(worst('healthy', 'healthy')).toBe('healthy');
  });
});

describe('a leader is not a cable', () => {
  it('carries no health of its own', () => {
    // A leader points a note at the thing it is about. Reporting a health for
    // it would put a made-up green line in the counts and a made-up outage in
    // the timeline.
    expect(
      linkStatus({
        link: { enabled: true, maintenance: false, kind: 'leader', healthRule: { type: 'manual', manualStatus: 'healthy' } },
        sourceStatus: 'healthy',
        targetStatus: 'healthy',
        linkProbes: [],
        allProbes: [],
        runtime: new Map(),
        sessionRunning: true,
      }),
    ).toBe('disabled');
  });

  it('stays out of the way even when both ends are down', () => {
    expect(
      linkStatus({
        link: { enabled: true, maintenance: false, kind: 'leader', healthRule: { type: 'both-endpoints' } },
        sourceStatus: 'down',
        targetStatus: 'down',
        linkProbes: [],
        allProbes: [],
        runtime: new Map(),
        sessionRunning: true,
      }),
    ).toBe('disabled');
  });

  it('leaves an ordinary link alone', () => {
    expect(
      linkStatus({
        link: { enabled: true, maintenance: false, healthRule: { type: 'manual', manualStatus: 'healthy' } },
        sourceStatus: 'healthy',
        targetStatus: 'healthy',
        linkProbes: [],
        allProbes: [],
        runtime: new Map(),
        sessionRunning: true,
      }),
    ).toBe('healthy');
  });
});
