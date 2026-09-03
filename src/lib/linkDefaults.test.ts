import { describe, expect, it } from 'vitest';
import { BUILT_IN_LINK_STYLE, linkStyleDefaults, resetToDefault, styleOf } from './linkDefaults';
import type { LinkData } from '../types/domain';

const link = (over: Partial<LinkData> = {}): LinkData => ({
  sourcePortLabel: 'Gi1/0/11',
  targetPortLabel: 'Gi1/0/12',
  label: 'Uplink',
  pathType: 'bezier',
  direction: 'forward',
  width: 4,
  color: '#ff0000',
  enabled: true,
  maintenance: true,
  lineStyle: 'dashed',
  healthRule: { type: 'both-endpoints' },
  notes: 'Discovered: Po1',
  ...over,
});

describe('linkDefaults (LT-079)', () => {
  it('falls back to the built-in look when nothing has been chosen', () => {
    expect(linkStyleDefaults(undefined)).toEqual(BUILT_IN_LINK_STYLE);
  });

  it('lets a chosen default override only what it names', () => {
    const d = linkStyleDefaults({ color: '#00ff00', pathType: 'straight' });
    expect(d.color).toBe('#00ff00');
    expect(d.pathType).toBe('straight');
    expect(d.width).toBe(BUILT_IN_LINK_STYLE.width);
    expect(d.direction).toBe(BUILT_IN_LINK_STYLE.direction);
  });

  it("reads a link's own look, and nothing else about it", () => {
    expect(styleOf(link())).toEqual({
      color: '#ff0000', pathType: 'bezier', direction: 'forward', width: 4, lineStyle: 'dashed',
    });
  });

  it('resetting restores the look and clears a hand-drawn route', () => {
    const patch = resetToDefault({ color: '#0b5fce', direction: 'forward' });
    expect(patch.color).toBe('#0b5fce');
    expect(patch.direction).toBe('forward');
    expect(patch.pathType).toBe('smoothstep');
    expect(patch.waypoints).toEqual([]);
    expect(patch.curvature).toBeUndefined();
  });

  it('resetting never touches ports, label, health or maintenance', () => {
    const patch = resetToDefault(undefined);
    for (const field of ['sourcePortLabel', 'targetPortLabel', 'label', 'healthRule', 'maintenance', 'enabled', 'notes']) {
      expect(field in patch).toBe(false);
    }
  });
});
