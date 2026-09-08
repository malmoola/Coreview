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

/** How small a device may end up on the canvas before it stops being legible. */
const MIN_SIDE = 32;

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

function sideOf(d: ImportedDevice): { w: number; h: number } {
  const w = d.width > 0 ? d.width : ASSUMED_SIDE;
  const h = d.height > 0 ? d.height : ASSUMED_SIDE;
  return { w, h };
}

/**
 * Pixels per inch for this drawing: enough that its smallest device is at
 * least `MIN_SIDE` pixels, never below 1:1 and never beyond `MAX_SCALE`.
 */
export function scaleFor(devices: ImportedDevice[]): number {
  const shortest = devices.reduce((min, d) => {
    const { w, h } = sideOf(d);
    return Math.min(min, w, h);
  }, Infinity);
  if (!Number.isFinite(shortest) || shortest <= 0) return BASE_SCALE;
  return Math.min(MAX_SCALE, Math.max(BASE_SCALE, MIN_SIDE / shortest));
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

  const top = devices.reduce((max, d) => Math.max(max, d.y + sideOf(d).h / 2), -Infinity);
  const left = devices.reduce((min, d) => Math.min(min, d.x - sideOf(d).w / 2), Infinity);

  for (const d of devices) {
    const { w, h } = sideOf(d);
    const width = Math.max(MIN_SIDE, Math.round(w * scale));
    const height = Math.max(MIN_SIDE, Math.round(h * scale));
    out.set(d.id, {
      x: Math.round((d.x - w / 2 - left) * scale),
      y: Math.round((top - d.y - h / 2) * scale),
      width,
      height,
    });
  }
  return out;
}
