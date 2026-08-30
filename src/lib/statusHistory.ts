/**
 * What a device's status has been, reconstructed from its transitions.
 *
 * The app records a row every time something changes state, and keeps only the
 * latest reading per probe. That is enough: between two transitions the status
 * did not change, which is the definition of a transition. So a timeline can
 * be rebuilt exactly, without storing a sample every five seconds for every
 * device on a diagram that may hold hundreds.
 *
 * The part worth being careful about is the beginning. A device that has never
 * transitioned is not "healthy for the last hour" — it is healthy since
 * monitoring started and unknown before that, and drawing the first as though
 * it were the second is how a strip ends up reassuring someone about a period
 * nobody was watching.
 */
import type { EventRow, HealthStatus } from '../types/domain';

export interface Span {
  status: HealthStatus;
  fromMs: number;
  toMs: number;
}

export interface TimelineInput {
  events: EventRow[];
  objectId: string;
  /** Start of the window shown. */
  fromMs: number;
  /** End of the window, normally now. */
  toMs: number;
  /** The status right now, for the stretch after the last transition. */
  current: HealthStatus;
  /** When this monitoring session began. Anything earlier is unknown, however
   *  healthy the device looks now. Null means never started. */
  sessionStartedAt: number | null;
}

export function buildTimeline({
  events,
  objectId,
  fromMs,
  toMs,
  current,
  sessionStartedAt,
}: TimelineInput): Span[] {
  if (toMs <= fromMs) return [];

  const mine = events
    .filter((e) => e.objectId === objectId && e.eventType === 'transition')
    .sort((a, b) => a.timestampMs - b.timestampMs);

  // Nothing was being watched before the session began.
  const watchedFrom = sessionStartedAt == null ? toMs : Math.max(fromMs, sessionStartedAt);

  const spans: Span[] = [];
  const push = (status: HealthStatus, from: number, to: number) => {
    if (to <= from) return;
    const last = spans[spans.length - 1];
    // Two neighbouring spans of the same status are one span. Without this a
    // strip grows a hairline for every repeated transition.
    if (last && last.status === status && last.toMs === from) last.toMs = to;
    else spans.push({ status, fromMs: from, toMs: to });
  };

  if (watchedFrom > fromMs) push('unknown', fromMs, Math.min(watchedFrom, toMs));
  if (watchedFrom >= toMs) return spans;

  // What it was at the start of the watched stretch, in order of how good
  // the evidence is: the last transition before then; failing that, what the
  // first transition inside says it came *from*, which is recorded and not a
  // guess; failing that, the status now, because nothing ever changed.
  const before = mine.filter((e) => e.timestampMs <= watchedFrom).pop();
  const firstInside = mine.find((e) => e.timestampMs > watchedFrom && e.timestampMs <= toMs);
  let status: HealthStatus =
    before?.currentStatus ?? firstInside?.previousStatus ?? current;
  let at = watchedFrom;

  for (const e of mine) {
    if (e.timestampMs <= watchedFrom || e.timestampMs > toMs) continue;
    push(status, at, e.timestampMs);
    status = e.currentStatus ?? 'unknown';
    at = e.timestampMs;
  }
  push(status, at, toMs);
  return spans;
}

/** How long each status held, for a plain-language summary under the strip. */
export function totals(spans: Span[]): { status: HealthStatus; ms: number }[] {
  const by = new Map<HealthStatus, number>();
  for (const s of spans) by.set(s.status, (by.get(s.status) ?? 0) + (s.toMs - s.fromMs));
  return [...by.entries()]
    .map(([status, ms]) => ({ status, ms }))
    .sort((a, b) => b.ms - a.ms);
}

/** "4m 12s", "1h 3m" — short enough to sit under a strip. */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}
