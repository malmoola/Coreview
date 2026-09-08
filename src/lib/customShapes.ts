/**
 * Capturing a device already on the canvas as a reusable shape (LT-104).
 *
 * A device is drawn one of two ways: a built-in glyph, tinted at draw time,
 * or an SVG pulled in from the icon library or an import and inlined once as
 * `imageDataUrl` (so the project still renders without that library
 * present). Either way, what this saves back is the same thing the icon
 * library already understands — raw SVG markup — so a captured shape drops
 * into the same palette drag-and-drop path (`icon:<id>`) an icon-library
 * entry already uses.
 */
import { base64ToUtf8 } from './base64';
import { glyphMarkup } from './glyphSvg';
import type { DeviceNodeData } from '../types/domain';

const SVG_DATA_URL_PREFIX = 'data:image/svg+xml;base64,';

export function svgForDevice(d: DeviceNodeData, autoColor: string): string {
  if (d.imageDataUrl?.startsWith(SVG_DATA_URL_PREFIX)) {
    return base64ToUtf8(d.imageDataUrl.slice(SVG_DATA_URL_PREFIX.length));
  }
  return glyphMarkup(d.deviceType, d.style?.iconColor ?? autoColor);
}
