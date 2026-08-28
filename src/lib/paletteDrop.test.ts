import { describe, expect, it } from 'vitest';

import { nodeForDrop, svgToDataUrl, type DropDeps } from './paletteDrop';
import type { DeviceNodeData, NoteNodeData } from '../types/domain';
import type { TopoNode } from '../state/store';

const deviceNode = (type: string, x: number, y: number): TopoNode =>
  ({
    id: `dev-${type}`,
    type: 'device',
    position: { x, y },
    data: {
      label: type,
      deviceType: type,
      addresses: [],
      tags: [],
      locked: false,
      maintenance: false,
      showDetails: true,
    } as unknown as DeviceNodeData,
  }) as unknown as TopoNode;

const noteNode = (x: number, y: number, variant: NoteNodeData['variant'] = 'plain'): TopoNode =>
  ({
    id: `note-${variant}`,
    type: 'note',
    position: { x, y },
    data: { variant } as unknown as NoteNodeData,
  }) as unknown as TopoNode;

const deps = (icons: DropDeps['iconLibrary'] = []): DropDeps => ({
  makeDeviceNode: deviceNode as DropDeps['makeDeviceNode'],
  makeNote: noteNode as DropDeps['makeNote'],
  iconLibrary: icons,
});

/** Decodes the base64 payload of a data: URL back to the original string. */
const decode = (url: string): string => {
  const b64 = url.split(',')[1] ?? '';
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

const LIBRARY = [
  { id: 'asr-9000', name: 'ASR 9000', category: 'Routing WAN', svg: '<svg><path d="M0 0"/></svg>' },
  { id: 'accents', name: 'Accénts ✓', category: 'Custom', svg: '<svg><text>café ✓</text></svg>' },
];

describe('nodeForDrop', () => {
  it('creates a plain note', () => {
    const n = nodeForDrop('note', 10, 20, deps());
    expect(n?.type).toBe('note');
    expect((n?.data as NoteNodeData).variant).toBe('plain');
  });

  it('creates a change note', () => {
    const n = nodeForDrop('change-note', 0, 0, deps());
    expect((n?.data as NoteNodeData).variant).toBe('change');
  });

  it('creates a built-in device for a bare type', () => {
    const n = nodeForDrop('firewall', 5, 6, deps());
    expect(n?.type).toBe('device');
    expect((n?.data as DeviceNodeData).deviceType).toBe('firewall');
    expect(n?.position).toEqual({ x: 5, y: 6 });
  });

  it('creates a library icon node with both a reference and an inlined copy', () => {
    const n = nodeForDrop('icon:asr-9000', 40, 50, deps(LIBRARY));
    const data = n?.data as DeviceNodeData;
    expect(data.iconRef).toBe('asr-9000');
    // The label comes from the library, not the slug.
    expect(data.label).toBe('ASR 9000');
    // The inlined copy is what makes an export render without the library.
    expect(data.imageDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(decode(data.imageDataUrl as string)).toContain('<path');
  });

  it('keeps the reference when the icon is not currently loaded', () => {
    // A project built against a library folder that is not mounted right now
    // should still record which icon it wanted.
    const n = nodeForDrop('icon:not-loaded', 0, 0, deps(LIBRARY));
    const data = n?.data as DeviceNodeData;
    expect(data.iconRef).toBe('not-loaded');
    expect(data.label).toBe('not-loaded');
    expect(data.imageDataUrl).toBeUndefined();
  });

  it('ignores an empty payload and a bare icon: prefix', () => {
    expect(nodeForDrop('', 0, 0, deps())).toBeNull();
    expect(nodeForDrop('   ', 0, 0, deps())).toBeNull();
    expect(nodeForDrop('icon:', 0, 0, deps(LIBRARY))).toBeNull();
  });
});

describe('svgToDataUrl', () => {
  it('round-trips ASCII', () => {
    const url = svgToDataUrl('<svg><path d="M0 0"/></svg>');
    expect(decode(url)).toBe('<svg><path d="M0 0"/></svg>');
  });

  it('handles non-ASCII, which plain btoa cannot', () => {
    // btoa('café') throws InvalidCharacterError; encoding to UTF-8 first is the
    // reason this helper exists rather than calling btoa directly.
    const svg = '<svg><text>café ✓</text></svg>';
    const url = svgToDataUrl(svg);
    expect(decode(url)).toBe(svg);
  });

  it('does not throw on an icon with accented characters from the library', () => {
    expect(() => svgToDataUrl(LIBRARY[1]!.svg)).not.toThrow();
  });
});
