export type Tone = 'ok' | 'warn' | 'bad' | 'off' | 'info';

/** A short coloured status label. The text always says the status, so colour is never the only signal. */
export function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
