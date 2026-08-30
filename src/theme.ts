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
  // Lifted from #5b6b7c and #3d4a58, which read as smudges rather than as
  // colours once a diagram had more than a few of them on it.
  unknown: '#7c8fa3',
  healthy: '#2fbf6b',
  warning: '#e8a33d',
  down: '#e4564a',
  disabled: '#55677a',
  maintenance: '#8b7ff0',
};

export const STATUS_COLOR_LIGHT: Record<HealthStatus, string> = {
  // Full strength, not the dark palette dimmed. Each has to read as itself on
  // white at a 1.5px stroke, which is how thin a link actually is — the first
  // attempt used lighter versions of these and every diagram looked faded.
  unknown: '#44576e',
  healthy: '#0a8a3f',
  warning: '#b45c00',
  down: '#c81e1e',
  disabled: '#7d8ea1',
  maintenance: '#5323b8',
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
  grid: '#c8d3de',
  minimapNode: '#7d93ab',
  minimapNote: '#a3b2c2',
  minimapMask: 'rgba(233,239,245,0.8)',
  selection: '#0b5fce',
  labelBackground: 'rgba(255, 255, 255, 0.96)',
  neutralNode: '#3d4e63',
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

/**
 * The colour a device is drawn in when nothing is watching it.
 *
 * Health colour is the right answer for a monitored diagram and the wrong one
 * for a drawing: with no probes every device is "unknown", so a diagram that
 * has not been pointed at anything yet comes out entirely grey. That is the
 * honest reading of the data and a poor picture, and people draw the picture
 * first.
 *
 * So an unmonitored device is drawn by what it is — the way every network
 * diagram has been drawn since before any of them were live — and the moment
 * a probe is attached, health takes the colour back. Nothing is invented: a
 * device with a real status still shows it.
 */
export const DEVICE_TINT_DARK: Record<string, string> = {
  firewall: '#ff7a45',
  router: '#4ea8f0',
  'core-switch': '#38bdf8',
  'distribution-switch': '#22b8cf',
  'access-switch': '#2dd4bf',
  'wireless-controller': '#a78bfa',
  'access-point': '#67e8f9',
  server: '#c084fc',
  vm: '#d8b4fe',
  storage: '#fbbf24',
  database: '#818cf8',
  application: '#f472b6',
  endpoint: '#94a3b8',
  printer: '#a3e635',
  camera: '#fb7185',
  internet: '#60a5fa',
  'private-cloud': '#7dd3fc',
  site: '#facc15',
  vpn: '#f0abfc',
  zone: '#60a5fa',
  generic: '#94a3b8',
};

export const DEVICE_TINT_LIGHT: Record<string, string> = {
  firewall: '#d1440a',
  router: '#0b5fce',
  'core-switch': '#0369a1',
  'distribution-switch': '#0e7490',
  'access-switch': '#0f766e',
  'wireless-controller': '#6d28d9',
  'access-point': '#0891b2',
  server: '#7e22ce',
  vm: '#9333ea',
  storage: '#a16207',
  database: '#4338ca',
  application: '#be1a68',
  endpoint: '#475569',
  printer: '#4d7c0f',
  camera: '#be123c',
  internet: '#1d4ed8',
  'private-cloud': '#0284c7',
  site: '#a16207',
  vpn: '#a21caf',
  zone: '#0b5fce',
  generic: '#475569',
};

/**
 * What colour to draw a device in.
 *
 * A real status always wins — that is the whole point of the app. 'unknown'
 * is the only status that gives way, because it means nobody is watching
 * rather than that something is wrong.
 */
export function deviceColor(
  deviceType: string,
  status: HealthStatus,
  ground: Ground,
): string {
  if (status !== 'unknown') return statusColors(ground)[status];
  const tints = ground === 'light' ? DEVICE_TINT_LIGHT : DEVICE_TINT_DARK;
  return tints[deviceType] ?? statusColors(ground).unknown;
}

/** What a note looks like when nobody has chosen colours for it.
 *
 *  Stored colours are a decision and are left alone. An uncoloured note has
 *  made no decision, so it follows the ground — otherwise a diagram drawn on
 *  black and then switched to white for a document carries dark blocks
 *  through the middle of the page. */
export interface NotePalette {
  text: string;
  background: string;
  border: string;
}

export const NOTE_DARK: Record<'plain' | 'change', NotePalette> = {
  plain: { text: '#d8e2ec', background: '#141c26', border: '#25313f' },
  change: { text: '#f2e6c8', background: '#2a2313', border: '#8a6d1f' },
};

export const NOTE_LIGHT: Record<'plain' | 'change', NotePalette> = {
  plain: { text: '#16212e', background: '#ffffff', border: '#c3ceda' },
  change: { text: '#4a3506', background: '#fff8e3', border: '#d3a83c' },
};

export function notePalette(variant: 'plain' | 'change', ground: Ground): NotePalette {
  return (ground === 'light' ? NOTE_LIGHT : NOTE_DARK)[variant] ?? NOTE_LIGHT.plain;
}
