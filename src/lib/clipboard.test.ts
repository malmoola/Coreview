import { describe, expect, it } from 'vitest';

import { copySelection, pasteClipping } from './clipboard';
import type { TopoEdge, TopoNode } from '../state/store';

const node = (id: string, selected = false, over: Record<string, unknown> = {}): TopoNode =>
  ({
    id, type: 'device', position: { x: 10, y: 20 }, selected,
    data: {
      label: id, deviceType: 'access-switch', tags: [], addresses: [],
      locked: false, maintenance: false, showDetails: true, ...over,
    },
  }) as TopoNode;

const edge = (id: string, source: string, target: string): TopoEdge =>
  ({ id, source, target, data: { sourcePortLabel: 'Gi0/1' } }) as TopoEdge;

let n = 0;
const ids = () => `new${(n += 1)}`;

describe('copySelection', () => {
  it('takes what is selected and nothing else', () => {
    const copied = copySelection([node('a', true), node('b')], []);
    expect(copied.nodes.map((x) => x.id)).toEqual(['a']);
  });

  it('brings the links whose both ends came too', () => {
    const nodes = [node('a', true), node('b', true), node('c')];
    const edges = [edge('inside', 'a', 'b'), edge('dangling', 'b', 'c')];
    const copied = copySelection(nodes, edges);
    expect(copied.edges.map((e) => e.id)).toEqual(['inside']);
  });

  it('is a copy, not a view of the original', () => {
    // Editing the original after copying must not change what is on the
    // clipboard — nobody expects to have to think about that.
    const original = node('a', true);
    const copied = copySelection([original], []);
    (original.data as { label: string }).label = 'changed';
    expect((copied.nodes[0]!.data as { label: string }).label).toBe('a');
  });
});

describe('pasteClipping', () => {
  beforeEachReset();

  it('gives everything a new id', () => {
    const clip = copySelection([node('a', true), node('b', true)], [edge('e', 'a', 'b')]);
    const pasted = pasteClipping(clip, { x: 30, y: 30 }, ids);
    expect(pasted.nodes.map((x) => x.id)).not.toContain('a');
    expect(pasted.edges[0]!.id).not.toBe('e');
  });

  it('reconnects the links to the copies, not to the originals', () => {
    const clip = copySelection([node('a', true), node('b', true)], [edge('e', 'a', 'b')]);
    const pasted = pasteClipping(clip, { x: 30, y: 30 }, ids);
    const newIds = pasted.nodes.map((x) => x.id);
    expect(newIds).toContain(pasted.edges[0]!.source);
    expect(newIds).toContain(pasted.edges[0]!.target);
  });

  it('offsets it so it does not land exactly on what it came from', () => {
    const clip = copySelection([node('a', true)], []);
    const pasted = pasteClipping(clip, { x: 40, y: 40 }, ids);
    expect(pasted.nodes[0]!.position).toEqual({ x: 50, y: 60 });
  });

  it('selects the paste, so it can be moved straight away', () => {
    const clip = copySelection([node('a', true)], []);
    expect(pasteClipping(clip, { x: 0, y: 0 }, ids).nodes[0]!.selected).toBe(true);
  });

  it('does not join the copy to the group the original was in', () => {
    // Keeping the group id would tie the copies to the originals, so dragging
    // one moved the other.
    const clip = copySelection([node('a', true, { groupId: 'g1' })], []);
    const pasted = pasteClipping(clip, { x: 0, y: 0 }, ids);
    expect((pasted.nodes[0]!.data as { groupId?: string }).groupId).toBeUndefined();
  });

  it('keeps everything else about a device', () => {
    const clip = copySelection([node('a', true, { layers: ['logical'], tags: ['site-hq'] })], []);
    const pasted = pasteClipping(clip, { x: 0, y: 0 }, ids);
    const d = pasted.nodes[0]!.data as { layers?: string[]; tags?: string[] };
    expect(d.layers).toEqual(['logical']);
    expect(d.tags).toEqual(['site-hq']);
  });

  it('pastes nothing from an empty clipboard', () => {
    const pasted = pasteClipping({ nodes: [], edges: [] }, { x: 10, y: 10 }, ids);
    expect(pasted.nodes).toEqual([]);
    expect(pasted.edges).toEqual([]);
  });
});

function beforeEachReset() {
  n = 0;
}
