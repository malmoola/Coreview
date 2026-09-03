import type { LinkData } from '../types/domain';
import { DEFAULTS } from '../theme';

/**
 * What a link looks like unless it has been given a look of its own (LT-079).
 *
 * Only the appearance travels: colour, path type, flow direction, width and
 * line style. A link's ports, its label, its health rule and whether it is in
 * maintenance are facts about the network, not style, and resetting the style
 * must never touch them — losing a port label because someone tidied the
 * colours would be a bad trade.
 *
 * Stored on the document, so the choice travels with the diagram and everyone
 * who opens it draws the same links.
 */
export type LinkStyleDefaults = Pick<
  LinkData,
  'color' | 'pathType' | 'direction' | 'width' | 'lineStyle'
>;

/** What the app draws with when nobody has said otherwise. */
export const BUILT_IN_LINK_STYLE: LinkStyleDefaults = {
  color: DEFAULTS.linkColor,
  pathType: 'smoothstep',
  direction: 'none',
  width: 2,
  lineStyle: 'solid',
};

/** The style a new link is born with, or that "reset" returns one to. */
export function linkStyleDefaults(
  stored: Partial<LinkStyleDefaults> | undefined,
): LinkStyleDefaults {
  return { ...BUILT_IN_LINK_STYLE, ...(stored ?? {}) };
}

/** The five style fields of a link, as they would be saved as the default. */
export function styleOf(data: LinkData): LinkStyleDefaults {
  return {
    color: data.color,
    pathType: data.pathType,
    direction: data.direction,
    width: data.width,
    lineStyle: data.lineStyle ?? 'solid',
  };
}

/**
 * The patch that puts a link back to the default look.
 *
 * A hand-drawn route is part of the look, so it goes: that is what "default
 * path type" means when the link has been bent by hand. Everything else about
 * the link is left exactly as it was.
 */
export function resetToDefault(
  stored: Partial<LinkStyleDefaults> | undefined,
): Partial<LinkData> {
  return {
    ...linkStyleDefaults(stored),
    waypoints: [],
    curvature: undefined,
    startCap: undefined,
    endCap: undefined,
  };
}
