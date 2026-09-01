/**
 * Date-time group (LT-074).
 *
 * A network engineer reads a log in DTG — `311430Z AUG 26` — not in "13
 * seconds ago". Durations say how long something lasted; a DTG says when it
 * happened, which is what goes in a change record or an incident bridge.
 *
 * Zulu by default because that is what a DTG means: the zone letter is part
 * of the format, and a log that mixes local zones is a log nobody can
 * correlate. `local: true` renders the machine's own zone with `L`.
 */
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const pad = (n: number) => String(n).padStart(2, '0');

export interface DtgOptions {
  /** Render in the machine's own zone (suffix `L`) rather than Zulu. */
  local?: boolean;
  /** Include seconds. A ping goes down and comes back inside one minute, so
   *  the timeline needs them; a change record does not. */
  seconds?: boolean;
}

/** `311430Z AUG 26`, or `311430:07Z AUG 26` with seconds. */
export function dtg(ms: number, options: DtgOptions = {}): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const local = options.local ?? false;
  const day = local ? d.getDate() : d.getUTCDate();
  const hour = local ? d.getHours() : d.getUTCHours();
  const minute = local ? d.getMinutes() : d.getUTCMinutes();
  const second = local ? d.getSeconds() : d.getUTCSeconds();
  const month = MONTHS[local ? d.getMonth() : d.getUTCMonth()]!;
  const year = (local ? d.getFullYear() : d.getUTCFullYear()) % 100;
  const zone = local ? 'L' : 'Z';
  const time = options.seconds
    ? `${pad(day)}${pad(hour)}${pad(minute)}:${pad(second)}`
    : `${pad(day)}${pad(hour)}${pad(minute)}`;
  return `${time}${zone} ${month} ${pad(year)}`;
}

/** How long a state lasted, said the way an operator says it. */
export function spanOf(fromMs: number, toMs: number): string {
  const s = Math.max(0, Math.round((toMs - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}
