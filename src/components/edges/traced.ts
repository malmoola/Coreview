/**
 * Which link the pointer is on, so the rest can fade behind it.
 *
 * Tracing one link used to be pure CSS: `.react-flow__edges:has(.react-flow__
 * edge:hover)` faded every link, and `:hover` un-faded the one under the
 * pointer. That worked while the thing the pointer landed on was the line
 * itself.
 *
 * It is not any more. The band that makes a link clickable near its devices
 * (LT-112) has to sit above the node layer to do its job, which puts it in a
 * different part of the tree from the line it belongs to — so the line is
 * never `:hover`, and no selector can join the two back up. One shared value
 * does what the selector no longer can.
 *
 * Deliberately not in the app store: this changes on every pointer move across
 * a diagram, and putting it there would put a hover into the undo history and
 * into every save.
 */

let traced: string | null = null;
const listeners = new Set<() => void>();

/** Marks the link under the pointer, or clears it with `null`. */
export function setTraced(id: string | null): void {
  if (traced === id) return;
  traced = id;
  for (const l of listeners) l();
}

export function tracedEdge(): string | null {
  return traced;
}

export function subscribeTraced(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
