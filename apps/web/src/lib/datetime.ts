// The college works in one time zone (requirement ASM-2). Forms show and accept local India time;
// the API receives full ISO-8601 instants with an explicit offset and stores UTC.
export const APP_TIMEZONE = 'Asia/Kolkata';
const OFFSET = '+05:30'; // India has no daylight saving time

/** "2031-03-01T10:00" (from a datetime-local input) → "2031-03-01T10:00:00+05:30". */
export function localInputToIso(value: string): string {
  return `${value}:00${OFFSET}`;
}

/** ISO instant → "2031-03-01T10:00" in India time, for a datetime-local input. */
export function isoToLocalInput(iso: string): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
  return parts.replace(' ', 'T');
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: APP_TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

/** Calendar dates (YYYY-MM-DD) are already local dates; show them readably without time-zone shifts. */
export function formatDate(ymd: string): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', dateStyle: 'medium' }).format(
    new Date(`${ymd}T00:00:00Z`),
  );
}
