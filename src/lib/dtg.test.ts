import { describe, expect, it } from 'vitest';
import { dtg, spanOf } from './dtg';

describe('dtg (LT-074)', () => {
  // 2026-08-31T14:30:07Z
  const t = Date.UTC(2026, 7, 31, 14, 30, 7);

  it('renders a Zulu date-time group', () => {
    expect(dtg(t)).toBe('311430Z AUG 26');
  });

  it('carries seconds when a state can change inside a minute', () => {
    expect(dtg(t, { seconds: true })).toBe('311430:07Z AUG 26');
  });

  it('pads a single-digit day and hour', () => {
    expect(dtg(Date.UTC(2026, 0, 3, 4, 5, 0))).toBe('030405Z JAN 26');
  });

  it('marks the local zone with L rather than pretending it is Zulu', () => {
    expect(dtg(t, { local: true }).endsWith('26')).toBe(true);
    expect(dtg(t, { local: true })).toContain('L ');
  });

  it('says so plainly when there is no time', () => {
    expect(dtg(Number.NaN)).toBe('—');
  });
});

describe('spanOf', () => {
  it('reads in the units the operator uses', () => {
    expect(spanOf(0, 7_000)).toBe('7s');
    expect(spanOf(0, 13_000)).toBe('13s');
    expect(spanOf(0, 60_000)).toBe('1m');
    expect(spanOf(0, 3_580_000)).toBe('59m 40s');
    expect(spanOf(0, 3_600_000)).toBe('1h');
    expect(spanOf(0, 5_400_000)).toBe('1h 30m');
  });
});
