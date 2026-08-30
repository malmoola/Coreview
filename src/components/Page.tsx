/**
 * The sheet the diagram is drawn on.
 *
 * A white viewport is a flat field with objects floating in it and no edge
 * anywhere; Visio and Lucidchart paint a neutral desk and float a real page on
 * it, and that contrast is what makes the white look white.
 *
 * Drawn in flow coordinates through React Flow's viewport portal rather than
 * as a node in the document. A node would have to be kept out of the
 * monitored-objects table, out of exports, out of the save payload, out of
 * select-all, out of the crawl merge and out of every count — six places to
 * remember and one to forget. Nothing here is in `doc.nodes`, so there is
 * nothing to filter.
 */
import { ViewportPortal } from '@xyflow/react';

import { useStore } from '../state/store';

/** 11 by 8.5 inches at 144 dpi. Landscape, because a network diagram is. */
export const PAGE_WIDTH = 1584;
export const PAGE_HEIGHT = 1224;

/** Where the grid lines fall, in diagram units. */
const MINOR = 12;
const MAJOR = 60;

export function Page() {
  // Defaulted on: a document saved before the page existed has no value here,
  // and reading that as "off" leaves a blank sheet with no grid on it.
  const gridEnabled = useStore((s) => s.doc.canvas.gridEnabled ?? true);
  const pageEnabled = useStore((s) => s.doc.canvas.page ?? true);

  if (!pageEnabled) return null;

  return (
    <ViewportPortal>
      <div
        className="cv-page"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: PAGE_WIDTH,
          height: PAGE_HEIGHT,
        }}
      >
        {/* The grid lives inside the page, so it stops at the paper's edge
            instead of tiling the whole desk. A grid that runs off into the
            distance is the thing that makes a viewport look infinite and a
            page look like nothing in particular. */}
        {gridEnabled && (
          <svg className="cv-page-grid" width="100%" height="100%" aria-hidden>
            <defs>
              <pattern id="cv-grid-minor" width={MINOR} height={MINOR} patternUnits="userSpaceOnUse">
                <path
                  d={`M ${MINOR} 0 L 0 0 0 ${MINOR}`}
                  fill="none"
                  stroke="var(--grid-minor)"
                  strokeWidth="1"
                />
              </pattern>
              <pattern id="cv-grid-major" width={MAJOR} height={MAJOR} patternUnits="userSpaceOnUse">
                <rect width={MAJOR} height={MAJOR} fill="url(#cv-grid-minor)" />
                <path
                  d={`M ${MAJOR} 0 L 0 0 0 ${MAJOR}`}
                  fill="none"
                  stroke="var(--grid-major)"
                  strokeWidth="1"
                />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#cv-grid-major)" />
          </svg>
        )}
      </div>
    </ViewportPortal>
  );
}
