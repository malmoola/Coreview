/**
 * How a link is drawn, beyond its health.
 *
 * A network diagram uses line style to mean things the app cannot infer: a
 * dashed line is a tunnel, a dotted one is a planned circuit, a hollow circle
 * at one end is a demarcation point. None of that is health, and a tool that
 * reserves every line property for its own use is a monitor rather than a
 * diagramming tool.
 *
 * So health keeps the colour and the travelling dots, and everything else is
 * the operator's — with 'auto' left as the default so a diagram that has never
 * been touched still reads the way it always did.
 */
import type { HealthStatus, LinkCap, LinkLineStyle } from '../types/domain';

/** The dash pattern for a line, or undefined for solid. */
export function dashFor(style: LinkLineStyle | undefined, status: HealthStatus): string | undefined {
  switch (style ?? 'auto') {
    case 'solid':
      return undefined;
    case 'dashed':
      return '10 6';
    case 'dotted':
      return '2 5';
    case 'dash-dot':
      return '12 5 2 5';
    default:
      // The health meaning, which is what this did before the choice existed.
      return status === 'down'
        ? '10 6'
        : status === 'disabled'
          ? '2 6'
          : status === 'maintenance'
            ? '12 6'
            : undefined;
  }
}

/**
 * What to draw at each end.
 *
 * `direction` came first and every existing diagram uses it, so it still
 * decides when nothing more specific has been chosen. An explicit cap wins,
 * including an explicit 'none' on a link whose direction says otherwise.
 */
export function capsFor(data: {
  direction?: string;
  startCap?: LinkCap;
  endCap?: LinkCap;
}): { start: LinkCap; end: LinkCap } {
  const direction = data.direction ?? 'forward';
  const fromDirection = {
    start: direction === 'reverse' || direction === 'both' ? 'arrow' : 'none',
    end: direction === 'forward' || direction === 'both' ? 'arrow' : 'none',
  } as { start: LinkCap; end: LinkCap };
  return {
    start: data.startCap ?? fromDirection.start,
    end: data.endCap ?? fromDirection.end,
  };
}

/** The marker geometry for a cap, in a 12x12 box with the tip at the right. */
export function capPath(cap: LinkCap): { d: string; filled: boolean } | null {
  switch (cap) {
    case 'arrow':
      return { d: 'M0,0 L8,4 L0,8 z', filled: true };
    case 'open-arrow':
      return { d: 'M0,0 L8,4 L0,8', filled: false };
    case 'circle':
      return { d: 'M1,4 a3,3 0 1,0 6,0 a3,3 0 1,0 -6,0', filled: true };
    case 'square':
      return { d: 'M1,1 L7,1 L7,7 L1,7 z', filled: true };
    case 'diamond':
      return { d: 'M0,4 L4,1 L8,4 L4,7 z', filled: true };
    default:
      return null;
  }
}
