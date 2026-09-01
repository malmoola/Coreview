import { dtg } from './dtg';

/**
 * How a timestamp is written (LT-076).
 *
 * DTG is what a network or military operator reads at a glance and what goes
 * in a change record — but it is not universal, and someone who has never
 * used one sees a wall of digits. So the same instant can be written four
 * ways, and the choice is remembered for the machine rather than stored in
 * the document: two people looking at the same diagram may want different
 * clocks, and neither is wrong.
 */
export type TimeFormat = 'dtg-zulu' | 'dtg-local' | 'local-24' | 'local-12';

export const TIME_FORMATS: { value: TimeFormat; label: string }[] = [
  { value: 'dtg-zulu', label: 'DTG (Zulu)' },
  { value: 'dtg-local', label: 'DTG (local)' },
  { value: 'local-24', label: '24-hour clock' },
  { value: 'local-12', label: '12-hour clock' },
];

const pad = (n: number) => String(n).padStart(2, '0');

/** The machine's own zone, said the way a person would: "CDT (UTC−05:00)". */
export function zoneLabel(at: number = Date.now()): string {
  let name = '';
  try {
    // The short zone name the platform knows — CDT, GMT+3, and so on.
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(
      new Date(at),
    );
    name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    name = '';
  }
  // The offset, which is unambiguous even where the abbreviation is not.
  const mins = -new Date(at).getTimezoneOffset();
  const sign = mins < 0 ? '\u2212' : '+';
  const abs = Math.abs(mins);
  const offset = `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return name && !name.startsWith('GMT') ? `${name} (${offset})` : offset;
}

/**
 * One instant, written the chosen way. `seconds` matters wherever a device
 * can drop and recover inside a minute.
 */
export function formatTime(ms: number, format: TimeFormat, seconds = true): string {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  switch (format) {
    case 'dtg-zulu':
      return dtg(ms, { seconds });
    case 'dtg-local':
      return dtg(ms, { seconds, local: true });
    case 'local-24':
      return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}` +
        (seconds ? `:${pad(d.getSeconds())}` : '')
      );
    case 'local-12': {
      const h24 = d.getHours();
      const h = h24 % 12 === 0 ? 12 : h24 % 12;
      const suffix = h24 < 12 ? 'AM' : 'PM';
      return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${h}:${pad(d.getMinutes())}` +
        (seconds ? `:${pad(d.getSeconds())}` : '') +
        ` ${suffix}`
      );
    }
  }
}

/** Is this format in the machine's own zone rather than Zulu? */
export function isLocalFormat(format: TimeFormat): boolean {
  return format !== 'dtg-zulu';
}
