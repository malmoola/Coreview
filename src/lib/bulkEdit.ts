/**
 * Editing many objects at once.
 *
 * A crawl of a real network drops dozens of devices on the canvas in one go.
 * Correcting a device type or adding a site tag one node at a time is the kind
 * of work that makes people stop using the tool and go back to Visio.
 *
 * The rule throughout: show what they have in common, and change only what is
 * asked. A field the selection disagrees on reads "mixed" and is left alone
 * until someone sets it — a blank box that silently blanks forty notes is the
 * worst thing a bulk editor can do.
 */
import type { DeviceNodeData, DeviceType } from '../types/domain';
import type { TopoNode } from '../state/store';

export type Shared<T> = { kind: 'same'; value: T } | { kind: 'mixed' } | { kind: 'none' };

/** What a set of nodes agrees on, for one field. */
export function shared<T>(values: T[]): Shared<T> {
  if (values.length === 0) return { kind: 'none' };
  const first = values[0]!;
  return values.every((v) => v === first) ? { kind: 'same', value: first } : { kind: 'mixed' };
}

export interface Selection {
  /** Only device nodes: a note has no device type and no tags. */
  devices: TopoNode[];
  notes: TopoNode[];
  deviceType: Shared<DeviceType>;
  locked: Shared<boolean>;
  maintenance: Shared<boolean>;
  showDetails: Shared<boolean>;
  /** Tags every selected device carries. Tags only some carry are not here:
   *  offering to remove a tag that half the selection lacks is confusing. */
  commonTags: string[];
  /** Tags carried by at least one but not all. Shown so it is obvious the
   *  selection is not uniform, and never removed by accident. */
  someTags: string[];
  /** Views every selected object appears on, and views only some appear on.
   *  Same rule as tags: only what they agree on can be taken away. */
  commonLayers: string[];
  someLayers: string[];
}

export function describeSelection(nodes: TopoNode[]): Selection {
  const devices = nodes.filter((n) => n.type === 'device');
  const notes = nodes.filter((n) => n.type === 'note');
  const data = devices.map((n) => n.data as DeviceNodeData);

  const tagSets = data.map((d) => new Set(d.tags ?? []));
  const every = new Set<string>();
  const some = new Set<string>();
  for (const set of tagSets) {
    for (const tag of set) {
      if (tagSets.every((s) => s.has(tag))) every.add(tag);
      else some.add(tag);
    }
  }

  // Counted over everything selected, including objects with no views at all.
  //
  // An unassigned object is *drawn* on every view, but it is not *on* one, and
  // a bulk control has to mean the literal thing: "all of them are on this"
  // decides whether a click adds or removes. Excusing the unassigned ones made
  // a mixed selection report "all", so the click took the view off the one
  // object that had it and put it on nothing.
  const layerSets = [...devices, ...notes].map(
    (n) => (n.data as { layers?: string[] }).layers ?? [],
  );
  const everyLayer = new Set<string>();
  const someLayer = new Set<string>();
  for (const set of layerSets) {
    for (const id of set) {
      if (layerSets.every((s) => s.includes(id))) everyLayer.add(id);
      else someLayer.add(id);
    }
  }

  return {
    devices,
    notes,
    commonLayers: [...everyLayer].sort(),
    someLayers: [...someLayer].sort(),
    deviceType: shared(data.map((d) => d.deviceType)),
    locked: shared(data.map((d) => !!d.locked)),
    maintenance: shared(data.map((d) => !!d.maintenance)),
    showDetails: shared(data.map((d) => !!d.showDetails)),
    commonTags: [...every].sort(),
    someTags: [...some].sort(),
  };
}

/** Adds a tag to nodes that do not already carry it. */
export function withTag(tags: string[] | undefined, tag: string): string[] {
  const clean = tag.trim();
  const current = tags ?? [];
  if (clean === '' || current.includes(clean)) return current;
  return [...current, clean];
}

/** Removes a tag, leaving the rest in the order they were in. */
export function withoutTag(tags: string[] | undefined, tag: string): string[] {
  return (tags ?? []).filter((t) => t !== tag);
}
