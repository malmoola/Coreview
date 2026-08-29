import { describe, expect, it } from 'vitest';

import { newProbe } from './probes';
import { PROBE_DEFAULTS } from '../types/domain';

describe('newProbe', () => {
  it('is enabled and primary, so a discovered device is actually watched', () => {
    // A sweep proves an address answers ICMP; adding it to the diagram with a
    // disabled probe would leave the object grey forever.
    const p = newProbe('node', 'n1', 'proj', '192.168.14.7', 'Discovered');
    expect(p.enabled).toBe(true);
    expect(p.isPrimary).toBe(true);
    expect(p.kind).toBe('icmp');
    expect(p.target).toBe('192.168.14.7');
    expect(p.name).toBe('Discovered');
    expect(p.objectKind).toBe('node');
    expect(p.objectId).toBe('n1');
    expect(p.projectId).toBe('proj');
  });

  it('carries the app defaults rather than its own numbers', () => {
    const p = newProbe('node', 'n1', 'proj', '10.0.0.1');
    expect(p.intervalSeconds).toBe(PROBE_DEFAULTS.intervalSeconds);
    expect(p.timeoutMs).toBe(PROBE_DEFAULTS.timeoutMs);
    expect(p.failureThreshold).toBe(PROBE_DEFAULTS.failureThreshold);
    expect(p.recoveryThreshold).toBe(PROBE_DEFAULTS.recoveryThreshold);
    expect(p.warningLatencyMs).toBe(PROBE_DEFAULTS.warningLatencyMs);
  });

  it('names a link probe differently from a node probe', () => {
    expect(newProbe('node', 'n', 'p').name).toBe('Management');
    expect(newProbe('link', 'e', 'p').name).toBe('Link check');
  });

  it('gives every probe its own id', () => {
    expect(newProbe('node', 'n', 'p').id).not.toBe(newProbe('node', 'n', 'p').id);
  });
});
