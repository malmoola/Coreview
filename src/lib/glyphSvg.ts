/**
 * A built-in device glyph, tinted, as standalone SVG markup.
 *
 * Shared by the diagram export (`diagram.ts`, which positions and sizes it
 * inline in a page) and LT-104's "save this shape back to the library"
 * (which wants the glyph on its own, the same shape an `IconLibEntry`
 * already is).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { ICONS } from '../components/icons';
import type { DeviceType } from '../types/domain';

export function glyphMarkup(type: DeviceType, color: string): string {
  const Icon = ICONS[type] ?? ICONS.generic;
  const raw = renderToStaticMarkup(Icon({}));
  return raw.replaceAll('currentColor', color);
}
