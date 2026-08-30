/** How long ago a timestamp was, in the coarsest unit that still says
 *  something. A probe result from four seconds ago is "4s ago"; one from
 *  yesterday has stopped being live data and says so in hours, because a
 *  hover card during validation never needs finer than that. */
export function timeAgo(thenMs: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 1) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
