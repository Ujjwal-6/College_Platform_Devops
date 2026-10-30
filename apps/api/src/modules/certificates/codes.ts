import { randomBytes } from 'node:crypto';

// Letters and digits without I, L, O and U, so a code read aloud or copied by hand is hard to get wrong.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 16; // 16 x 5 bits = 80 bits: enough that valid codes cannot be found by trying

/** A new verification code such as `7K2M-QX9D-4HT8-WB3N`. 256 is a multiple of 32, so every character is equally likely. */
export function generateVerificationCode(): string {
  const chars = Array.from(randomBytes(LENGTH), (b) => ALPHABET[b & 31]!).join('');
  return chars.match(/.{4}/g)!.join('-');
}

/** Accepts what a person might type (lower case, spaces, no dashes, I/L/O for 1/1/0); null if it cannot be a code. */
export function normalizeVerificationCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (code.length !== LENGTH) return null;
  for (const ch of code) if (!ALPHABET.includes(ch)) return null;
  return code.match(/.{4}/g)!.join('-');
}
