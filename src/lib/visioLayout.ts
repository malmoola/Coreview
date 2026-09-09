/**
 * Putting a Visio drawing's geometry onto the canvas (LT-110).
 *
 * The first import placed every device at `x * 96, y * 96` as a 76x76 node,
 * and the operator's verdict was that it did not look like his drawing. Three
 * separate reasons, all fixed here:
 *
 * - **Visio's pin is the shape's centre**, not its top-left. Placing a node's
 *   corner there shifts everything by half a node, and a shape two inches wide
 *   by a fifth of an inch tall — a rack unit — by far more than that.
 * - **Shapes are not all one size.** A `N9K-C93180YC-EX Front` is a wide, flat
 *   rack unit and a router icon is roughly square. Drawing both as the same
 *   square is most of why a rack of stacked switches came out as a pile.
 * - **96 pixels to the inch is too small a scale for a rack.** Four switches
 *   stacked at 0.185in apart are 18px apart at that scale, so they overlap
 *   whatever size they are drawn. The scale is chosen from the drawing itself
 *   instead: enough that its smallest device is still legible.
 *
 * Nothing here rearranges anything. The drawing's own arrangement is the
 * point; this only changes the units it is expressed in.
 */
import type { ImportedDevice } from './ipc';

/** Pixels per inch at which a Visio drawing is a 1:1 screen drawing. */
export const BASE_SCALE = 96;

/** How small a device may end up on the canvas before it stops being legible,
 *  and how large before it dwarfs the diagram. */
const MIN_SIDE = 48;
const MAX_SIDE = 140;

/** Clear space to leave between two devices that would otherwise overlap.
 *  Enough that the link between them has a length worth clicking on. */
const GAP = 24;

/** What a shape is assumed to be when the drawing states no size of its own:
 *  roughly what Visio's own network-equipment icons measure. */
const ASSUMED_SIDE = 0.6;

/** How far the scale may be pushed. A drawing containing one hairline shape
 *  should not blow the whole page up to fit it. */
const MAX_SCALE = BASE_SCALE * 3;

export interface PlacedDevice {
  /** Top-left corner, in canvas pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The side of the square a device is drawn at, in inches.
 *
 * Square, not the drawing's own box, and this was got wrong first time. A
 * device is drawn as a glyph — a symbol with its name beneath — and a glyph's
 * bounds are square by decision (LT-053), so that its selection ring and its
 * resize corners sit on the drawn symbol. `migrateDocument` enforces that on
 * every load.
 *
 * Taking the drawing's box instead gave a rack unit an eleven-to-one node.
 * Its selection ring is a circle, so it drew as an enormous flat ellipse
 * around a tiny icon; a link between two of them had no grabbable length; and
 * on the next open the migration squared it and moved it, so the diagram
 * changed shape after being closed. Three complaints, one cause.
 *
 * The geometric mean keeps what was worth keeping — a cloud still arrives
 * bigger than an access switch, because it is drawn bigger — without letting
 * an extreme proportion through.
 */
function sideOf(d: ImportedDevice): number {
  const w = d.width > 0 ? d.width : ASSUMED_SIDE;
  const h = d.height > 0 ? d.height : ASSUMED_SIDE;
  return Math.sqrt(w * h);
}

/**
 * Pixels per inch for this drawing: enough that its smallest device is at
 * least `MIN_SIDE` pixels, never below 1:1 and never beyond `MAX_SCALE`.
 */
export function scaleFor(devices: ImportedDevice[]): number {
  const smallest = devices.reduce((min, d) => Math.min(min, sideOf(d)), Infinity);
  if (!Number.isFinite(smallest) || smallest <= 0) return BASE_SCALE;
  return Math.min(MAX_SCALE, Math.max(BASE_SCALE, MIN_SIDE / smallest));
}

/**
 * Pushes apart devices whose squares overlap, and nothing else.
 *
 * Necessary, and not something a scale can fix: scaling moves the gap and the
 * size together, so two shapes that overlap at one scale overlap at every
 * scale. A rack unit is drawn a fifth of an inch tall and two inches wide, and
 * four of them are stacked a fifth of an inch apart — as squares they must
 * overlap, whatever the drawing is enlarged to.
 *
 * So the drawing's arrangement is kept except where it cannot be: a pair that
 * would collide is separated along whichever axis they are already closest to
 * clearing, which for a rack is the one it is stacked along. Bounded passes
 * and a fixed order, because a layout that lands somewhere different each time
 * is worse than one that is slightly off.
 */
function separate(placed: Map<string, PlacedDevice>): void {
  // Ordered as the drawing has them, top to bottom then left to right, and
  // only the later of a colliding pair ever moves. That is what keeps a stack
  // in its original order: pushing both apart symmetrically let the third unit
  // overtake the second across passes, and a rack that comes back shuffled is
  // worse than one that is slightly spread.
  // Ordered as the drawing has them, top to bottom then left to right. Each
  // device is settled against the ones already settled and never moves again,
  // so the order the drawing put them in is the order they come out in.
  // Pushing both of a colliding pair apart, or re-sorting between passes, let
  // a unit overtake its neighbour — and a rack that comes back shuffled is
  // worse than one that is slightly spread.
  const ids = [...placed.keys()].sort((l, r) => {
    const a = placed.get(l)!;
    const b = placed.get(r)!;
    return a.y - b.y || a.x - b.x || l.localeCompare(r);
  });

  // Clear means the boxes do not meet on one axis or the other. `GAP` is the
  // space left when one has to be moved, not an amount of overlap to tolerate.
  const clear = (a: PlacedDevice, b: PlacedDevice) =>
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) <= 0 ||
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) <= 0;

  for (let i = 1; i < ids.length; i += 1) {
    const b = placed.get(ids[i]!)!;
    // Against everything already settled, repeatedly: moving clear of one can
    // put it on top of another.
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const hit = ids
        .slice(0, i)
        .map((id) => placed.get(id)!)
        .find((a) => !clear(a, b));
      if (!hit) break;
      const overlapX = Math.min(hit.x + hit.width, b.x + b.width) - Math.max(hit.x, b.x);
      const overlapY = Math.min(hit.y + hit.height, b.y + b.height) - Math.max(hit.y, b.y);
      // Along whichever axis has less to undo — for a rack, the one it is
      // stacked along.
      if (overlapY <= overlapX) b.y = hit.y + hit.height + GAP;
      else if (b.x >= hit.x) b.x = hit.x + hit.width + GAP;
      else b.x = hit.x - b.width - GAP;
    }
  }
}

/**
 * Where every device goes, in canvas pixels.
 *
 * Visio measures in inches from the bottom-left of the page; the canvas
 * measures in pixels from the top-left, so the Y axis flips. The flip is taken
 * about the top edge of the topmost shape rather than its centre, or a tall
 * shape at the top of the drawing would hang off the canvas.
 */
export function placeDevices(devices: ImportedDevice[]): Map<string, PlacedDevice> {
  const out = new Map<string, PlacedDevice>();
  if (devices.length === 0) return out;
  const scale = scaleFor(devices);

  const top = devices.reduce((max, d) => Math.max(max, d.y + sideOf(d) / 2), -Infinity);
  const left = devices.reduce((min, d) => Math.min(min, d.x - sideOf(d) / 2), Infinity);

  for (const d of devices) {
    const inches = sideOf(d);
    // Square, and within the range a glyph stays usable at.
    const side = Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(inches * scale)));
    out.set(d.id, {
      // The centre is what the drawing states, so the arrangement survives
      // even though the box no longer has the drawing's proportions.
      x: Math.round((d.x - left) * scale - side / 2),
      y: Math.round((top - d.y) * scale - side / 2),
      width: side,
      height: side,
    });
  }
  separate(out);
  // Re-anchored afterwards, since separating can push a device above or left
  // of where the drawing started.
  const minX = Math.min(...[...out.values()].map((p) => p.x));
  const minY = Math.min(...[...out.values()].map((p) => p.y));
  for (const p of out.values()) {
    p.x -= minX;
    p.y -= minY;
  }
  return out;
}
