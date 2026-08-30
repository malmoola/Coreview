/**
 * The two grounds a diagram gets drawn on.
 *
 * The dark ground is the working one — an operator watching a network at 2am
 * does not want a white screen. But a diagram that has to go into a document,
 * onto a projector, or in front of someone in daylight needs a white one, and
 * a colour chosen to glow on near-black is the wrong colour on white: amber
 * at #e8a33d is legible on #0a0e13 and washes out completely on #ffffff.
 *
 * So each status has two colours, not one, and the light values are darkened
 * and saturated until they hold their own against white rather than being the
 * same hue turned down.
 */
import type { HealthStatus } from './types/domain';

export type Ground = 'dark' | 'light';

export const STATUS_COLOR_DARK: Record<HealthStatus, string> = {
  unknown: '#5b6b7c',
  healthy: '#2fbf6b',
  warning: '#e8a33d',
  down: '#e4564a',
  disabled: '#3d4a58',
  maintenance: '#8b7ff0',
};

export const STATUS_COLOR_LIGHT: Record<HealthStatus, string> = {
  // Darker and more saturated. On white, the dark palette's green reads as a
  // pale mint and its amber all but disappears.
  unknown: '#5a6b7d',
  healthy: '#128a45',
  warning: '#a5620a',
  down: '#c02a1d',
  disabled: '#94a3b1',
  maintenance: '#5b46c9',
};

export function statusColors(ground: Ground): Record<HealthStatus, string> {
  return ground === 'light' ? STATUS_COLOR_LIGHT : STATUS_COLOR_DARK;
}

/** Colours for everything on the canvas that is not a status. */
export interface CanvasPalette {
  /** The dotted grid behind the diagram. */
  grid: string;
  minimapNode: string;
  minimapNote: string;
  minimapMask: string;
  /** The ring drawn round a selected node. */
  selection: string;
  /** Behind a port or centre label, so the line does not show through it. */
  labelBackground: string;
  /** A device with no status of its own. */
  neutralNode: string;
}

export const CANVAS_DARK: CanvasPalette = {
  grid: '#1d2733',
  minimapNode: '#48607a',
  minimapNote: '#37475a',
  minimapMask: 'rgba(8,12,17,0.75)',
  selection: '#5eb8ff',
  labelBackground: 'rgba(10, 14, 19, 0.92)',
  neutralNode: '#8fa2b5',
};

export const CANVAS_LIGHT: CanvasPalette = {
  grid: '#d3dae2',
  minimapNode: '#93a7bd',
  minimapNote: '#b3bfcd',
  minimapMask: 'rgba(226,232,239,0.78)',
  selection: '#1668c4',
  labelBackground: 'rgba(255, 255, 255, 0.94)',
  neutralNode: '#4a5a6b',
};

export function canvasPalette(ground: Ground): CanvasPalette {
  return ground === 'light' ? CANVAS_LIGHT : CANVAS_DARK;
}

/**
 * Whether a colour someone chose is readable on the ground it will be drawn
 * on, and something that is if it is not.
 *
 * A link painted "a colour of its own" keeps that colour when the ground is
 * flipped, and a pale yellow chosen to stand out on black is invisible on
 * white. Rather than overriding the choice — which would lose it — it is
 * darkened only as far as it needs to be to be seen.
 */
export function readableOn(hex: string, ground: Ground): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const target = ground === 'light' ? 0.62 : 0.22;
  const l = luminance(rgb);
  if (ground === 'light' ? l <= target : l >= target) return hex;
  const factor = ground === 'light' ? 0.55 : 1.9;
  const shifted = rgb.map((c) =>
    Math.max(0, Math.min(255, Math.round(ground === 'light' ? c * factor : c * factor + 26))),
  ) as [number, number, number];
  return `#${shifted.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Perceived brightness, 0 to 1. Not WCAG relative luminance — this only has
 *  to rank colours against one another, and the cheap weighting agrees with
 *  the eye closely enough for that. */
function luminance([r, g, b]: [number, number, number]): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
