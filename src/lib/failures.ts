/**
 * A crawl failure carries the address as its own field, and the reason is a
 * Rust error whose Display names the host so a log line reads on its own —
 * `192.168.14.112 rejected the credentials`. Rendering both produces
 * "192.168.14.112 — 192.168.14.112 rejected the credentials".
 *
 * Strip the address only where the reason starts with it, so what is left is
 * still a whole sentence. A reason that mentions the host mid-string
 * ("could not reach 192.168.14.9:22: connection refused") is left alone: it is
 * mildly redundant, and cutting a value out of the middle of a message is how
 * you end up rendering ":22: connection refused".
 */
export function reasonWithoutAddress(address: string, reason: string): string {
  if (!address || !reason.startsWith(address)) return reason;
  // The address has to end where it says it does: a bare prefix test turns
  // "192.168.14.11 rejected ..." into "1 rejected ..." when the address is
  // 192.168.14.1.
  const next = reason.charAt(address.length);
  if (next !== ' ') return reason;
  const rest = reason.slice(address.length).trimStart();
  // Only when a sentence remains. "192.168.14.9" alone would strip to nothing.
  return rest.length > 0 ? rest : reason;
}
