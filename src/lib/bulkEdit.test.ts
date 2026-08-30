import { describe, expect, it } from 'vitest';

import { describeSelection, shared, withTag, withoutTag } from './bulkEdit';
import type { TopoNode } from '../state/store';

const device = (id: string, over: Record<string, unknown> = {}): TopoNode =>
  ({
    id,
    type: 'device',
    position: { x: 0, y: 0 },
    data: {
      label: id,
      deviceType: 'access-switch',
      tags: [],
      addresses: [],
      locked: false,
      maintenance: false,
      showDetails: true,
      ...over,
    },
  }) as TopoNode;

const note = (id: string): TopoNode =>
  ({
    id,
    type: 'note',
    position: { x: 0, y: 0 },
    data: { title: id, body: '', variant: 'plain', fontSize: 12, locked: false },
  }) as TopoNode;

describe('shared', () => {
  it('reports a value the whole selection agrees on', () => {
    expect(shared(['a', 'a', 'a'])).toEqual({ kind: 'same', value: 'a' });
  });

  it('reports disagreement rather than picking one', () => {
    expect(shared(['a', 'b'])).toEqual({ kind: 'mixed' });
  });

  it('reports nothing for an empty selection', () => {
    expect(shared([])).toEqual({ kind: 'none' });
  });
});

describe('describeSelection', () => {
  it('separates devices from notes', () => {
    const s = describeSelection([device('a'), note('n1'), device('b')]);
    expect(s.devices).toHaveLength(2);
    expect(s.notes).toHaveLength(1);
  });

  it('reports a device type the selection agrees on', () => {
    const s = describeSelection([device('a'), device('b')]);
    expect(s.deviceType).toEqual({ kind: 'same', value: 'access-switch' });
  });

  it('reports a mixed device type rather than the first one', () => {
    // Showing "access switch" for a selection containing a firewall would
    // make pressing Apply silently turn the firewall into a switch.
    const s = describeSelection([device('a'), device('b', { deviceType: 'firewall' })]);
    expect(s.deviceType).toEqual({ kind: 'mixed' });
  });

  it('separates tags everything carries from tags only some carry', () => {
    const s = describeSelection([
      device('a', { tags: ['site-hq', 'discovered'] }),
      device('b', { tags: ['site-hq'] }),
    ]);
    expect(s.commonTags).toEqual(['site-hq']);
    expect(s.someTags).toEqual(['discovered']);
  });

  it('does not treat a note as a device with no tags', () => {
    // A note in the selection would otherwise drag every common tag out of
    // the list, because it carries none.
    const s = describeSelection([device('a', { tags: ['site-hq'] }), note('n1')]);
    expect(s.commonTags).toEqual(['site-hq']);
  });

  it('reads locked and maintenance across the selection', () => {
    const s = describeSelection([device('a', { locked: true }), device('b', { locked: true })]);
    expect(s.locked).toEqual({ kind: 'same', value: true });
    const mixed = describeSelection([device('a', { locked: true }), device('b')]);
    expect(mixed.locked).toEqual({ kind: 'mixed' });
  });

  it('says nothing about a selection with no devices in it', () => {
    const s = describeSelection([note('n1'), note('n2')]);
    expect(s.deviceType).toEqual({ kind: 'none' });
    expect(s.commonTags).toEqual([]);
  });
});

describe('views in a selection', () => {
  it('reports the views everything shares', () => {
    const s = describeSelection([
      device('a', { layers: ['physical', 'logical'] }),
      device('b', { layers: ['physical'] }),
    ]);
    expect(s.commonLayers).toEqual(['physical']);
    expect(s.someLayers).toEqual(['logical']);
  });

  it('counts an unassigned object as not on the view', () => {
    // An unassigned object is drawn on every view but is not on one, and the
    // bulk control has to mean the literal thing: "all of them are on this"
    // is what decides whether a click adds or removes. Excusing the
    // unassigned ones made a mixed selection report "all", so the click took
    // the view off the one object that had it and put it on nothing.
    const s = describeSelection([device('a', { layers: ['physical'] }), device('b')]);
    expect(s.commonLayers).toEqual([]);
    expect(s.someLayers).toEqual(['physical']);
  });

  it('says nothing when nothing has been assigned', () => {
    const s = describeSelection([device('a'), device('b')]);
    expect(s.commonLayers).toEqual([]);
    expect(s.someLayers).toEqual([]);
  });
});

describe('tags', () => {
  it('adds a tag', () => {
    expect(withTag(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('does not add a tag twice', () => {
    expect(withTag(['a'], 'a')).toEqual(['a']);
  });

  it('ignores blank input rather than adding an empty tag', () => {
    expect(withTag(['a'], '   ')).toEqual(['a']);
  });

  it('trims what it is given', () => {
    expect(withTag([], '  site-hq ')).toEqual(['site-hq']);
  });

  it('removes a tag and leaves the rest in order', () => {
    expect(withoutTag(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  it('removing a tag nothing carries changes nothing', () => {
    expect(withoutTag(['a'], 'z')).toEqual(['a']);
  });
});
