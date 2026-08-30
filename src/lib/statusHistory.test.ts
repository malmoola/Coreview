import { describe, expect, it } from 'vitest';

import { buildTimeline, shortDuration, totals } from './statusHistory';
import type { EventRow, HealthStatus } from '../types/domain';

const T = 1_700_000_000_000;
const M = 60_000;

const transition = (
  atMs: number,
  to: HealthStatus,
  from: HealthStatus | null = null,
  objectId = 'n1',
): EventRow =>
  ({
    id: `${atMs}`,
    projectId: 'p',
    sessionId: 's',
    timestampMs: atMs,
    objectType: 'node',
    objectId,
    objectName: objectId,
    eventType: 'transition',
    previousStatus: from,
    currentStatus: to,
    probeType: 'icmp',
    target: '10.0.0.1',
  }) as EventRow;

const base = {
  objectId: 'n1',
  fromMs: T,
  toMs: T + 10 * M,
  current: 'healthy' as HealthStatus,
  sessionStartedAt: T,
};

describe('buildTimeline', () => {
  it('covers the whole window with one span when nothing changed', () => {
    const spans = buildTimeline({ ...base, events: [] });
    expect(spans).toEqual([{ status: 'healthy', fromMs: T, toMs: T + 10 * M }]);
  });

  it('splits at a transition', () => {
    const spans = buildTimeline({
      ...base,
      current: 'down',
      events: [transition(T + 4 * M, 'down', 'healthy')],
    });
    expect(spans).toEqual([
      { status: 'healthy', fromMs: T, toMs: T + 4 * M },
      { status: 'down', fromMs: T + 4 * M, toMs: T + 10 * M },
    ]);
  });

  it('does not claim to know what happened before monitoring started', () => {
    // The whole reason this is careful: a device healthy for the last two
    // minutes must not be drawn as healthy for the last hour.
    const spans = buildTimeline({ ...base, events: [], sessionStartedAt: T + 8 * M });
    expect(spans).toEqual([
      { status: 'unknown', fromMs: T, toMs: T + 8 * M },
      { status: 'healthy', fromMs: T + 8 * M, toMs: T + 10 * M },
    ]);
  });

  it('says unknown before the first transition when there is nothing earlier', () => {
    // Something transitioned to down at minute 4. What it was before that is
    // not recorded, and guessing "healthy" would invent an outage boundary.
    const spans = buildTimeline({
      ...base,
      current: 'down',
      sessionStartedAt: null,
      events: [transition(T + 4 * M, 'down', 'healthy')],
    });
    expect(spans).toEqual([{ status: 'unknown', fromMs: T, toMs: T + 10 * M }]);
  });

  it('carries forward the last transition before the window', () => {
    const spans = buildTimeline({
      ...base,
      current: 'down',
      sessionStartedAt: T - 60 * M,
      events: [transition(T - 30 * M, 'down', 'healthy')],
    });
    expect(spans).toEqual([{ status: 'down', fromMs: T, toMs: T + 10 * M }]);
  });

  it('ignores transitions belonging to another device', () => {
    const spans = buildTimeline({
      ...base,
      events: [transition(T + 5 * M, 'down', 'healthy', 'n2')],
    });
    expect(spans).toEqual([{ status: 'healthy', fromMs: T, toMs: T + 10 * M }]);
  });

  it('ignores anything that is not a transition', () => {
    const session = { ...transition(T + 5 * M, 'down'), eventType: 'session' } as EventRow;
    expect(buildTimeline({ ...base, events: [session] })).toEqual([
      { status: 'healthy', fromMs: T, toMs: T + 10 * M },
    ]);
  });

  it('merges neighbouring spans of the same status', () => {
    // Flapping between two probes on one device can record the same status
    // twice in a row; a hairline per repeat makes the strip unreadable.
    const spans = buildTimeline({
      ...base,
      events: [transition(T + 2 * M, 'healthy'), transition(T + 4 * M, 'healthy')],
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]).toEqual({ status: 'healthy', fromMs: T, toMs: T + 10 * M });
  });

  it('takes transitions in time order however they arrived', () => {
    const spans = buildTimeline({
      ...base,
      current: 'healthy',
      events: [transition(T + 6 * M, 'healthy', 'down'), transition(T + 3 * M, 'down', 'healthy')],
    });
    expect(spans.map((s) => s.status)).toEqual(['healthy', 'down', 'healthy']);
  });

  it('returns nothing for a window with no width', () => {
    expect(buildTimeline({ ...base, toMs: T, events: [] })).toEqual([]);
  });
});

describe('totals', () => {
  it('adds up the time in each status', () => {
    const spans = buildTimeline({
      ...base,
      current: 'down',
      events: [transition(T + 7 * M, 'down', 'healthy')],
    });
    expect(totals(spans)).toEqual([
      { status: 'healthy', ms: 7 * M },
      { status: 'down', ms: 3 * M },
    ]);
  });
});

describe('shortDuration', () => {
  it('reads the way someone would say it', () => {
    expect(shortDuration(45_000)).toBe('45s');
    expect(shortDuration(4 * M)).toBe('4m');
    expect(shortDuration(4 * M + 12_000)).toBe('4m 12s');
    expect(shortDuration(63 * M)).toBe('1h 3m');
    expect(shortDuration(120 * M)).toBe('2h');
  });
});
