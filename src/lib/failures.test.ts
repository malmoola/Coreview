import { describe, expect, it } from 'vitest';

import { reasonWithoutAddress } from './failures';

describe('reasonWithoutAddress', () => {
  it('drops an address the reason repeats at the front', () => {
    expect(reasonWithoutAddress('192.168.14.112', '192.168.14.112 rejected the credentials')).toBe(
      'rejected the credentials',
    );
  });

  it('leaves a reason that names the host mid-sentence alone', () => {
    // Cutting the value out of the middle would leave ":22: connection refused".
    const reason = 'could not reach 192.168.14.9:22: connection refused';
    expect(reasonWithoutAddress('192.168.14.9', reason)).toBe(reason);
  });

  it('does not strip a host that is only a prefix of a longer one', () => {
    // Without a boundary check this returns "1 rejected the credentials".
    const reason = '192.168.14.11 rejected the credentials';
    expect(reasonWithoutAddress('192.168.14.1', reason)).toBe(reason);
  });

  it('keeps the reason when nothing would be left', () => {
    expect(reasonWithoutAddress('10.0.0.1', '10.0.0.1')).toBe('10.0.0.1');
  });

  it('is a no-op without an address', () => {
    expect(reasonWithoutAddress('', 'timed out')).toBe('timed out');
  });
});
