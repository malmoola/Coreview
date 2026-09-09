import { describe, expect, it } from 'vitest';

import { formatSerials, mergeSerials, parseSerials, serialCount } from './serials';

describe('parseSerials', () => {
  it('reads the list a stack produces', () => {
    expect(parseSerials('FOC1932X0AA, FOC1932X0BB')).toEqual(['FOC1932X0AA', 'FOC1932X0BB']);
  });

  it('accepts the separators a person actually types', () => {
    // The field is edited by hand, and nobody is consistent about this.
    expect(parseSerials('FOC1932X0AA;FOC1932X0BB')).toHaveLength(2);
    expect(parseSerials('FOC1932X0AA / FOC1932X0BB')).toHaveLength(2);
    expect(parseSerials('FOC1932X0AA   FOC1932X0BB')).toHaveLength(2);
  });

  it('normalises case, since the same box can be reported either way', () => {
    expect(parseSerials('foc1932x0aa')).toEqual(['FOC1932X0AA']);
  });

  it('does not repeat a serial reported twice', () => {
    expect(parseSerials('FOC1932X0AA, foc1932x0aa')).toEqual(['FOC1932X0AA']);
  });

  it('has nothing to read in an empty or missing field', () => {
    expect(parseSerials('')).toEqual([]);
    expect(parseSerials(undefined)).toEqual([]);
    expect(parseSerials('  ,  ; ')).toEqual([]);
  });
});

describe('mergeSerials', () => {
  it('keeps what both sides know', () => {
    // The case this exists for: two neighbours each advertise a different
    // member of the same stack, and both are true.
    expect(mergeSerials('FOC1932X0AA', 'FOC1932X0BB')).toBe('FOC1932X0AA, FOC1932X0BB');
  });

  it('keeps the order of discovery, so the master stays first', () => {
    expect(mergeSerials('FOC1932X0AA, FOC1932X0BB', 'FOC1932X0CC')).toBe(
      'FOC1932X0AA, FOC1932X0BB, FOC1932X0CC',
    );
  });

  it('does not duplicate what both sides already agree on', () => {
    expect(mergeSerials('FOC1932X0AA', 'FOC1932X0AA')).toBe('FOC1932X0AA');
  });

  it('takes whichever side has anything', () => {
    expect(mergeSerials(undefined, 'FOC1932X0AA')).toBe('FOC1932X0AA');
    expect(mergeSerials('FOC1932X0AA', null)).toBe('FOC1932X0AA');
    expect(mergeSerials(undefined, undefined)).toBeUndefined();
  });
});

describe('formatSerials and serialCount', () => {
  it('writes the list the way a person would', () => {
    expect(formatSerials(['FOC1932X0AA', 'FOC1932X0BB'])).toBe('FOC1932X0AA, FOC1932X0BB');
    expect(formatSerials([])).toBeUndefined();
  });

  it('counts the boxes, which is what tells a stack from a single switch', () => {
    expect(serialCount('FOC1932X0AA, FOC1932X0BB, FOC1932X0CC')).toBe(3);
    expect(serialCount('FOC1932X0AA')).toBe(1);
    expect(serialCount('')).toBe(0);
  });
});
