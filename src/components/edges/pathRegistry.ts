/**
 * Where every drawn link puts its path so the others can see it.
 *
 * A hop needs to know about links other than the one drawing it, and an edge
 * component only knows its own geometry. Rather than lifting path computation
 * out of the edge — which would mean duplicating React Flow's own handle
 * measurement — each edge registers what it drew, and reads the register when
 * working out where to hop.
 *
 * Two things keep that from thrashing. What is registered is the plain path,
 * never the hopped one, so an edge redrawing itself with hops cannot set the
 * others recomputing. And subscribers are told after a short quiet period
 * rather than on every change, so dragging a node across a diagram does not
 * recompute every crossing on every frame — the hops settle a moment after
 * the drag instead of chasing it.
 */

/** Above this, hops are not drawn at all.
 *
 *  Crossing detection is every straight run against every other, which is
 *  quadratic. On a diagram of this size the hops have also stopped helping:
 *  the picture is dense enough that the reader is using the highlight-on-hover
 *  instead. */
export const MAX_EDGES_FOR_JUMPS = 160;

const paths = new Map<string, string>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
/** Bumped when the settled set of paths changes, so components can depend on
 *  a primitive rather than on a Map identity. */
let version = 0;

const QUIET_MS = 90;

function scheduleNotify(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    version += 1;
    for (const l of listeners) l();
  }, QUIET_MS);
}

export function registerPath(id: string, d: string): void {
  if (paths.get(id) === d) return;
  paths.set(id, d);
  scheduleNotify();
}

export function forgetPath(id: string): void {
  if (!paths.delete(id)) return;
  scheduleNotify();
}

export function pathVersion(): number {
  return version;
}

export function allPaths(): Map<string, string> {
  return paths;
}

export function subscribePaths(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: the register is module state and would otherwise leak between
 *  cases. */
export function resetPaths(): void {
  paths.clear();
  if (timer) clearTimeout(timer);
  timer = null;
  version = 0;
}
