import { describe, expect, it } from 'vitest';

import { BUILT_IN_LINK_STYLE } from './linkDefaults';
import { importedAddresses, importedLinkData } from './visioImportModel';

const link = (over: Partial<Parameters<typeof importedLinkData>[1]> = {}) =>
  importedLinkData(BUILT_IN_LINK_STYLE, { sourcePort: '', targetPort: '', color: '', ...over });

describe('importedLinkData', () => {
  it('draws an imported link as a curve, whatever the diagram default is', () => {
    // A drawing puts devices where it put them, not on a grid, and a
    // right-angled route between two of those takes a long way round.
    expect(BUILT_IN_LINK_STYLE.pathType).toBe('smoothstep');
    expect(link().pathType).toBe('bezier');
  });

  it('writes the port pair along the line as well as at the two ends', () => {
    const l = link({ sourcePort: 'Gi0/1', targetPort: 'Eth1/4' });
    expect(l.sourcePortLabel).toBe('Gi0/1');
    expect(l.targetPortLabel).toBe('Eth1/4');
    expect(l.label).toBe('Gi0/1 <> Eth1/4');
  });

  it('writes the one port it knows, rather than half a pair', () => {
    expect(link({ sourcePort: 'Gi0/1' }).label).toBe('Gi0/1');
    expect(link({ targetPort: 'Eth1/4' }).label).toBe('Eth1/4');
    expect(link().label).toBe('');
  });

  it('keeps a colour the drawing stated, and pins it so status does not repaint it', () => {
    const l = link({ color: '#ea700d' });
    expect(l.color).toBe('#ea700d');
    expect(l.colorMode).toBe('fixed');
  });

  it('leaves a link the drawing did not colour to follow the diagram', () => {
    const l = link();
    expect(l.color).toBe(BUILT_IN_LINK_STYLE.color);
    expect(l.colorMode).toBeUndefined();
  });

  it('arrives live, off maintenance, and judged by both its ends', () => {
    const l = link();
    expect(l.enabled).toBe(true);
    expect(l.maintenance).toBe(false);
    expect(l.healthRule).toEqual({ type: 'both-endpoints' });
  });
});

describe('importedAddresses', () => {
  it('makes the first address the primary one, which is what a check aims at', () => {
    const out = importedAddresses(['192.0.2.10', '198.51.100.5']);
    expect(out.map((a) => a.address)).toEqual(['192.0.2.10', '198.51.100.5']);
    expect(out[0]?.isPrimary).toBe(true);
    expect(out[1]?.isPrimary).toBe(false);
  });

  it('keeps every address a caption carried rather than only the first', () => {
    // The rest used to be flattened into the notes as text, which is where an
    // address goes to be forgotten.
    expect(importedAddresses(['192.0.2.1', '192.0.2.2', '192.0.2.3'])).toHaveLength(3);
  });

  it('names them so they can be told apart in the inspector', () => {
    const out = importedAddresses(['192.0.2.10', '198.51.100.5']);
    expect(out.map((a) => a.label)).toEqual(['Management', 'Address 2']);
  });

  it('has nothing to add for a device the drawing never addressed', () => {
    expect(importedAddresses([])).toEqual([]);
  });
});
