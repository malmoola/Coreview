import { describe, expect, it } from 'vitest';
import { formatTime, isLocalFormat, zoneLabel } from './timeFormat';

// 2026-08-31T14:30:07Z
const t = Date.UTC(2026, 7, 31, 14, 30, 7);

describe('formatTime (LT-076)', () => {
  it('writes a Zulu DTG', () => {
    expect(formatTime(t, 'dtg-zulu')).toBe('311430:07Z AUG 26');
  });

  it('writes a local DTG marked L, not pretending to be Zulu', () => {
    const s = formatTime(t, 'dtg-local');
    expect(s).toContain('L ');
    expect(s).not.toContain('Z ');
  });

  it('writes a plain 24-hour clock with the date', () => {
    const s = formatTime(t, 'local-24');
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('writes a 12-hour clock with AM or PM', () => {
    const s = formatTime(t, 'local-12');
    expect(s).toMatch(/(AM|PM)$/);
    expect(s).not.toMatch(/ 0\d:/); // no zero-padded 12-hour hour
  });

  it('drops seconds when they are not wanted', () => {
    expect(formatTime(t, 'dtg-zulu', false)).toBe('311430Z AUG 26');
    expect(formatTime(t, 'local-24', false)).toMatch(/\d{2}:\d{2}$/);
  });

  it('says so plainly when there is no time', () => {
    expect(formatTime(Number.NaN, 'local-24')).toBe('—');
  });

  it('knows which formats follow the machine and which do not', () => {
    expect(isLocalFormat('dtg-zulu')).toBe(false);
    expect(isLocalFormat('dtg-local')).toBe(true);
    expect(isLocalFormat('local-24')).toBe(true);
  });
});

describe('zoneLabel', () => {
  it('always names an offset, so no one has to guess the zone', () => {
    expect(zoneLabel(t)).toMatch(/UTC[+\u2212]\d{2}:\d{2}/);
  });
});
