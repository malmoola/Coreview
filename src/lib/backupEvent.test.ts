import { describe, expect, it } from 'vitest';
import { normaliseBackupEvent } from './backupEvent';

describe('normaliseBackupEvent (LT-073)', () => {
  it('flattens the adjacently tagged shape the backend sends', () => {
    const e = normaliseBackupEvent({
      kind: 'saved',
      value: { name: 'SW1', address: '10.0.0.1', path: '/b/SW1.cfg', bytes: 4096, unchanged: false },
    })!;
    expect(e.kind).toBe('saved');
    // The fields the panel reads, present and of the right type — this is the
    // exact failure: bytes was undefined and .toLocaleString() threw.
    expect((e as { bytes: number }).bytes).toBe(4096);
    expect((e as { name: string }).name).toBe('SW1');
    expect((e as { path: string }).path).toBe('/b/SW1.cfg');
  });

  it('flattens started and finished too', () => {
    expect((normaliseBackupEvent({ kind: 'started', value: { devices: 3 } }) as { devices: number }).devices).toBe(3);
    const fin = normaliseBackupEvent({ kind: 'finished', value: { saved: 2, failed: 1, cancelled: false } })!;
    expect((fin as { saved: number }).saved).toBe(2);
    expect((fin as { failed: number }).failed).toBe(1);
  });

  it('leaves an already-flat event alone', () => {
    const e = normaliseBackupEvent({ kind: 'failed', name: 'SW2', reason: 'timeout' })!;
    expect((e as { reason: string }).reason).toBe('timeout');
  });

  it('refuses rubbish rather than passing it on', () => {
    expect(normaliseBackupEvent(null)).toBeNull();
    expect(normaliseBackupEvent({ nope: 1 })).toBeNull();
  });
});
