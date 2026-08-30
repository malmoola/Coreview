/**
 * Layers: more than one drawing in one document.
 *
 * A network is documented more than once. The physical layer says which cable
 * is in which socket; the logical one says which VLAN reaches which building;
 * a third says what the change on Saturday will do. They share every device
 * and almost no links, and keeping them as three files means three files that
 * disagree within a fortnight.
 *
 * So a layer is a property of an object rather than a container of them.
 * Nothing has to move between layers, an object can be on more than one, and
 * an object that has never been assigned is on every layer — which is what
 * makes a document drawn before layers existed still open with everything
 * visible.
 */

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  /** Locked layers draw normally and refuse to be edited, for a background
   *  everything else is drawn on top of. */
  locked: boolean;
}

export const DEFAULT_LAYER: Layer = {
  id: 'base',
  name: 'Base',
  visible: true,
  locked: false,
};

/** What an object says about where it belongs. */
export type LayerRef = string[] | undefined;

/**
 * Whether an object should be drawn.
 *
 * An object with no layers is on all of them. That is the rule that keeps a
 * diagram drawn before any of this existed from disappearing the moment
 * somebody adds a layer to it.
 */
export function isVisible(on: LayerRef, layers: Layer[]): boolean {
  if (!on || on.length === 0) return true;
  const shown = new Set(layers.filter((l) => l.visible).map((l) => l.id));
  // Layers the document no longer has are ignored rather than hiding the
  // object: deleting a layer must not delete what was on it.
  const known = new Set(layers.map((l) => l.id));
  const relevant = on.filter((id) => known.has(id));
  if (relevant.length === 0) return true;
  return relevant.some((id) => shown.has(id));
}

/** Whether an object can be edited: everything it is on must be unlocked. */
export function isEditable(on: LayerRef, layers: Layer[]): boolean {
  if (!on || on.length === 0) return true;
  const locked = new Set(layers.filter((l) => l.locked).map((l) => l.id));
  return !on.some((id) => locked.has(id));
}

/** The layers a document has, with the base one guaranteed. */
export function layersOf(stored: Layer[] | undefined): Layer[] {
  if (!stored || stored.length === 0) return [DEFAULT_LAYER];
  return stored;
}

/** Adds a layer, with a name that is not already taken. */
export function withNewLayer(layers: Layer[], name: string, id: string): Layer[] {
  const taken = new Set(layers.map((l) => l.name.toLowerCase()));
  let candidate = name.trim() || 'Layer';
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${name.trim() || 'Layer'} ${n}`;
    n += 1;
  }
  return [...layers, { id, name: candidate, visible: true, locked: false }];
}

/**
 * Removing a layer.
 *
 * The objects on it are not removed — they fall back to being on every layer,
 * which is where an unassigned object lives. Deleting a view of the network
 * must not delete the network.
 */
export function withoutLayer(layers: Layer[], id: string): Layer[] {
  const left = layers.filter((l) => l.id !== id);
  return left.length === 0 ? [DEFAULT_LAYER] : left;
}

/** Puts an object on a layer, or takes it off. */
export function toggleOn(on: LayerRef, id: string): string[] {
  const current = on ?? [];
  return current.includes(id) ? current.filter((l) => l !== id) : [...current, id];
}
