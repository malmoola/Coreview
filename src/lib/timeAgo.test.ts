import { describe, expect, it } from 'vitest';
import { timeAgo } from './timeAgo';

describe('timeAgo', () => {
  const now = 1_000_000_000;
  it('calls the current instant just now', () => {
    expect(timeAgo(now, now)).toBe('just now');
    expect(timeAgo(now - 400, now)).toBe('just now');
  });
  it('speaks seconds under a minute', () => {
    expect(timeAgo(now - 4_000, now)).toBe('4s ago');
    expect(timeAgo(now - 59_400, now)).toBe('59s ago');
  });
  it('speaks minutes under an hour', () => {
    expect(timeAgo(now - 60_000, now)).toBe('1m ago');
    expect(timeAgo(now - 59 * 60_000, now)).toBe('59m ago');
  });
  it('speaks hours beyond that', () => {
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h ago');
  });
  it('never reports the future', () => {
    // A clock that skews backwards must not print "-3s ago".
    expect(timeAgo(now + 3_000, now)).toBe('just now');
  });
});
