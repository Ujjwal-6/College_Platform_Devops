/**
 * CSV (RFC 4180: comma separated, CRLF line ends, fields with a comma, quote or line break wrapped in
 * quotes with inner quotes doubled).
 *
 * Spreadsheets run text that starts with = + - @ (or a tab or carriage return) as a formula. A title
 * or name someone typed could therefore make a downloaded file do something when opened, so such
 * text is prefixed with an apostrophe. Numbers are never changed: a negative amount stays "-5.00".
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export type CsvCell = string | number | null | undefined;

export function csvCell(value: CsvCell, kind: 'text' | 'number' = 'text'): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (kind === 'text' && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** `kinds[i]` says whether column i is text (guarded) or a number (left alone). Headers are fixed words. */
export function toCsv(header: string[], kinds: ('text' | 'number')[], rows: CsvCell[][]): string {
  const lines = [header.join(',')];
  for (const row of rows)
    lines.push(row.map((cell, i) => csvCell(cell, kinds[i] ?? 'text')).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** Whole paise as rupees with two decimals ("1500.50"), using integer arithmetic only. */
export function formatMinor(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
