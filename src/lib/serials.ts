/**
 * A device's serial numbers, which is a list rather than a value (LT-115).
 *
 * A stack is one device with several boxes in it: one hostname, one management
 * address, one node on the diagram, and four switches that can each be RMA'd
 * separately. So the field holds all of them, comma-separated — `FOC1932X0AA,
 * FOC1932X0BB` — which is how a person writes a list, and survives a CSV round
 * trip because the writer quotes any cell containing a comma.
 *
 * Merging matters as much as parsing. The same stack can reach the crawl twice
 * from two different neighbours, each advertising a *different* member's serial
 * in its CDP device id, and each of those is true. Keeping the first and
 * dropping the second would name one switch in a stack of four and look
 * complete while doing it.
 */

/** The separators a person might have typed, since this field is edited by hand. */
const SPLIT = /[,;/]+|\s{2,}/;

/** The serials in a field, normalised: upper case, no blanks, no repeats. */
export function parseSerials(field: string | undefined | null): string[] {
  if (!field) return [];
  const out: string[] = [];
  for (const part of field.split(SPLIT)) {
    const s = part.trim().toUpperCase();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** The field for a list of serials, or undefined for none. */
export function formatSerials(serials: string[]): string | undefined {
  const seen = parseSerials(serials.join(','));
  return seen.length ? seen.join(', ') : undefined;
}

/**
 * Everything both sides know, in the order first seen.
 *
 * Order is the order of discovery rather than sorted, so the member a device
 * reports first — which on a stack is the master — stays first.
 */
export function mergeSerials(
  a: string | undefined | null,
  b: string | undefined | null,
): string | undefined {
  return formatSerials([...parseSerials(a), ...parseSerials(b)]);
}

/** How many boxes this field names. Zero when it names none. */
export function serialCount(field: string | undefined | null): number {
  return parseSerials(field).length;
}
