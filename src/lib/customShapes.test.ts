import { describe, expect, it } from 'vitest';

import { svgForDevice } from './customShapes';
import { svgToDataUrl } from './paletteDrop';
import type { DeviceNodeData } from '../types/domain';

const device = (over: Partial<DeviceNodeData> = {}): DeviceNodeData =>
  ({
    label: 'x',
    deviceType: 'router',
    addresses: [],
    tags: [],
    locked: false,
    maintenance: false,
    showDetails: true,
    ...over,
  }) as DeviceNodeData;

describe('svgForDevice', () => {
  it('captures a built-in glyph tinted with the automatic colour', () => {
    const svg = svgForDevice(device(), '#336699');
    expect(svg).toContain('#336699');
    expect(svg).not.toContain('currentColor');
  });

  it('prefers a colour override over the automatic colour', () => {
    const svg = svgForDevice(device({ style: { iconColor: '#ff0000' } }), '#336699');
    expect(svg).toContain('#ff0000');
    expect(svg).not.toContain('#336699');
  });

  it('captures an inlined library icon as its original raw markup, not the glyph', () => {
    const original = '<svg><path d="M1 2"/></svg>';
    const svg = svgForDevice(device({ imageDataUrl: svgToDataUrl(original) }), '#336699');
    expect(svg).toBe(original);
  });
});
