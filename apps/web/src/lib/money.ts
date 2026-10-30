// Money is whole paise everywhere (requirement ASM-3). Nothing here uses floating point for amounts.
export const MAX_AMOUNT_MINOR = 100_000_000_000;

/** "1500.50" or "1,500" → 150050. Null when the text is not a rupee amount with at most two decimals, or is too large. */
export function parseRupees(text: string): number | null {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text.trim().replace(/,/g, ''));
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return minor <= MAX_AMOUNT_MINOR ? minor : null;
}

/** 150050 → "1,500.50" (Indian digit grouping). */
export function formatRupees(minor: number): string {
  const abs = Math.abs(minor);
  const whole = new Intl.NumberFormat('en-IN').format(Math.trunc(abs / 100));
  return `${minor < 0 ? '-' : ''}${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** 150050 → "₹1,500.50". */
export const formatMoney = (minor: number) =>
  `${minor < 0 ? '-' : ''}₹${formatRupees(Math.abs(minor))}`;

/** 150050 → "1500.50", for an input being edited. */
export function minorToInput(minor: number): string {
  return `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}
