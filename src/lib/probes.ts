import type { Probe } from '../types/domain';
import { PROBE_DEFAULTS } from '../types/domain';
import { uid } from './id';

/**
 * A new ICMP probe with the app's default thresholds.
 *
 * Shared rather than local to the inspector because discovery creates probes
 * too. A sweep that just proved twenty addresses answer ping, and then drew
 * them as twenty objects nothing ever checks, is the wrong end of the
 * workflow: the point of finding a device is to watch it.
 */
export function newProbe(
  objectKind: 'node' | 'link',
  objectId: string,
  projectId: string,
  target = '',
  name = objectKind === 'node' ? 'Management' : 'Link check',
): Probe {
  return {
    id: uid(),
    projectId,
    objectKind,
    objectId,
    name,
    kind: 'icmp',
    target,
    tcpPort: null,
    intervalSeconds: PROBE_DEFAULTS.intervalSeconds,
    timeoutMs: PROBE_DEFAULTS.timeoutMs,
    failureThreshold: PROBE_DEFAULTS.failureThreshold,
    recoveryThreshold: PROBE_DEFAULTS.recoveryThreshold,
    warningLatencyMs: PROBE_DEFAULTS.warningLatencyMs,
    enabled: true,
    maintenance: false,
    isPrimary: true,
  };
}
